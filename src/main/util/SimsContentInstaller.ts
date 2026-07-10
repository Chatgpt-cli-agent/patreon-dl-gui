import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import extractZip from "extract-zip";
import { promisify } from "util";
import { pathToFileURL } from "url";
import { APP_DATA_PATH } from "../../common/Constants";

const STEAM_SIMS4_APP_ID = "1222670";
const execFileAsync = promisify(execFile);
const DIRECT_MOD_EXTENSIONS = new Set([".package", ".ts4script"]);
const TRAY_EXTENSIONS = new Set([
  ".blueprint",
  ".bpi",
  ".hhi",
  ".householdbinary",
  ".sgi",
  ".trayitem"
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const SKIP_DIRS = new Set([".git", ".patreon-dl", "node_modules"]);

export type SimsContentKind = "mods" | "tray";

export interface SimsInstallSettings {
  modsDir: string;
  trayDir: string;
  libraryDir: string;
}

export interface SimsContentCandidate {
  sourcePath: string;
  sourceKey: string;
  relativePath: string;
  fileName: string;
  kind: SimsContentKind;
  fromArchive: boolean;
  archivePath: string | null;
  installSubdir: string;
  size: number;
  mtimeMs: number;
}

export interface SimsScanResult {
  sourceRoot: string;
  settings: SimsInstallSettings;
  directFiles: number;
  archives: number;
  candidates: SimsContentCandidate[];
  errors: string[];
}

export interface SimsInstalledFile {
  sourceKey: string;
  sourcePath: string;
  sourceMtimeMs: number;
  sourceSize: number;
  destinationPath: string;
  kind: SimsContentKind;
  fromArchive: boolean;
  archivePath: string | null;
  installedAt: string;
}

export interface SimsInstallResult extends SimsScanResult {
  installed: SimsInstalledFile[];
  skipped: SimsInstalledFile[];
  errors: string[];
}

export interface SimsLibraryItem extends SimsInstalledFile {
  id: string;
  fileName: string;
  displayName: string;
  creatorName: string;
  postTitle: string;
  postId: string | null;
  postUrl: string | null;
  postRoot: string | null;
  thumbnailPath: string | null;
  thumbnailUrl: string | null;
  installed: boolean;
  missing: boolean;
}

interface SimsInstallDatabase {
  installedFiles: SimsInstalledFile[];
}

function getDefaultModsCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(
      home,
      ".steam",
      "debian-installation",
      "steamapps",
      "compatdata",
      STEAM_SIMS4_APP_ID,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      "Electronic Arts",
      "The Sims 4",
      "Mods"
    ),
    path.join(
      home,
      ".local",
      "share",
      "Steam",
      "steamapps",
      "compatdata",
      STEAM_SIMS4_APP_ID,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      "Electronic Arts",
      "The Sims 4",
      "Mods"
    ),
    path.join(
      home,
      ".steam",
      "steam",
      "steamapps",
      "compatdata",
      STEAM_SIMS4_APP_ID,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      "Electronic Arts",
      "The Sims 4",
      "Mods"
    ),
    path.join(home, "Documents", "Electronic Arts", "The Sims 4", "Mods")
  ];
}

function detectModsDir(): string {
  for (const candidate of getDefaultModsCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return getDefaultModsCandidates()[0];
}

export function getSimsInstallSettings(): SimsInstallSettings {
  const modsDir = detectModsDir();
  return {
    modsDir,
    trayDir: path.join(path.dirname(modsDir), "Tray"),
    libraryDir: path.join(modsDir, "PatreonLibrary")
  };
}

function getDatabasePath() {
  return path.join(APP_DATA_PATH, "SimsInstallLibrary.json");
}

function loadDatabase(): SimsInstallDatabase {
  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) {
    return { installedFiles: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf-8")) as Partial<SimsInstallDatabase>;
    return {
      installedFiles: Array.isArray(parsed.installedFiles) ?
        parsed.installedFiles
      : []
    };
  } catch {
    return { installedFiles: [] };
  }
}

function saveDatabase(db: SimsInstallDatabase) {
  fs.mkdirSync(APP_DATA_PATH, { recursive: true });
  fs.writeFileSync(getDatabasePath(), JSON.stringify(db, null, 2));
}

function cleanCreatorName(folderName: string | null) {
  if (!folderName) {
    return "Unknown creator";
  }
  const parts = folderName.split(" - ").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || folderName;
}

function parsePostFolder(postFolder: string | null) {
  if (!postFolder) {
    return {
      postTitle: "Unknown post",
      postId: null as string | null,
      postUrl: null as string | null
    };
  }
  const match = postFolder.match(/^(.*?)(?:\s+-\s+(\d+))?$/);
  const postTitle = (match?.[1] || postFolder).trim() || postFolder;
  const postId = match?.[2] || null;
  return {
    postTitle,
    postId,
    postUrl: postId ? `https://www.patreon.com/posts/${postId}` : null
  };
}

function getPostContext(sourcePath: string) {
  const marker = `${path.sep}posts${path.sep}`;
  const markerIndex = sourcePath.indexOf(marker);
  if (markerIndex < 0) {
    return {
      creatorName: "Unknown creator",
      postTitle: "Unknown post",
      postId: null,
      postUrl: null,
      postRoot: null
    };
  }

  const creatorRoot = sourcePath.slice(0, markerIndex);
  const afterMarker = sourcePath.slice(markerIndex + marker.length);
  const postFolder = afterMarker.split(path.sep)[0] || null;
  const postInfo = parsePostFolder(postFolder);
  return {
    creatorName: cleanCreatorName(path.basename(creatorRoot)),
    ...postInfo,
    postRoot: postFolder ? path.join(creatorRoot, "posts", postFolder) : null
  };
}

function walkFilesLimited(root: string, maxDepth: number) {
  const files: string[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: entryPath, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function findPostThumbnail(postRoot: string | null) {
  if (!postRoot) {
    return null;
  }
  const images = walkFilesLimited(postRoot, 3)
    .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map((file) => {
      const lower = file.toLowerCase();
      const priority =
        lower.includes("preview") || lower.includes("thumb") ? 3
        : lower.includes("image") || lower.includes("media") ? 2
        : 1;
      return {
        file,
        priority,
        size: fs.statSync(file).size
      };
    })
    .sort((a, b) => b.priority - a.priority || b.size - a.size);
  return images[0]?.file || null;
}

export function listSimsLibrary(): SimsLibraryItem[] {
  const db = loadDatabase();
  return db.installedFiles
    .map((file) => {
      const context = getPostContext(file.sourcePath);
      const thumbnailPath = findPostThumbnail(context.postRoot);
      const installed = fs.existsSync(file.destinationPath);
      return {
        ...file,
        id: file.sourceKey,
        fileName: path.basename(file.destinationPath || file.sourcePath),
        displayName: path.basename(file.destinationPath || file.sourcePath, path.extname(file.destinationPath || file.sourcePath)),
        ...context,
        thumbnailPath,
        thumbnailUrl: thumbnailPath ? pathToFileURL(thumbnailPath).href : null,
        installed,
        missing: !installed
      };
    })
    .sort((a, b) => {
      const dateCompare = Date.parse(b.installedAt) - Date.parse(a.installedAt);
      return dateCompare || a.creatorName.localeCompare(b.creatorName) || a.displayName.localeCompare(b.displayName);
    });
}

function isPathInside(childPath: string, rootPath: string) {
  const relative = path.relative(rootPath, childPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSubdir(subdir: string) {
  return subdir
    .split(path.sep)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
}

function ensureUniquePath(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const parsed = path.parse(filePath);
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not create unique destination for ${filePath}`);
}

function getCandidateKind(filePath: string): SimsContentKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (DIRECT_MOD_EXTENSIONS.has(ext)) {
    return "mods";
  }
  if (TRAY_EXTENSIONS.has(ext)) {
    return "tray";
  }
  return null;
}

function walkFiles(root: string) {
  const files: string[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(entryPath);
        }
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function createCandidate(args: {
  filePath: string;
  sourceRoot: string;
  sourceKey: string;
  relativePath: string;
  fromArchive: boolean;
  archivePath: string | null;
  installSubdir: string;
}): SimsContentCandidate | null {
  const kind = getCandidateKind(args.filePath);
  if (!kind) {
    return null;
  }
  const stat = fs.statSync(args.filePath);
  return {
    sourcePath: args.filePath,
    sourceKey: args.sourceKey,
    relativePath: args.relativePath,
    fileName: path.basename(args.filePath),
    kind,
    fromArchive: args.fromArchive,
    archivePath: args.archivePath,
    installSubdir: normalizeSubdir(args.installSubdir),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function getArchiveInstallSubdir(sourceRoot: string, archivePath: string, internalPath: string) {
  const archiveRelative = path.relative(sourceRoot, archivePath);
  const archiveDir = path.dirname(archiveRelative);
  const archiveName = path.basename(archivePath, path.extname(archivePath));
  const internalDir = path.dirname(internalPath);
  return path.join(archiveDir === "." ? "" : archiveDir, archiveName, internalDir === "." ? "" : internalDir);
}

async function extractArchive(archivePath: string, destinationRoot: string) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".zip") {
    await extractZip(archivePath, { dir: destinationRoot });
    return;
  }

  if (ext === ".7z") {
    await execFileAsync("7z", ["x", "-y", `-o${destinationRoot}`, archivePath], {
      maxBuffer: 1024 * 1024 * 20
    });
    return;
  }

  if (ext === ".rar") {
    try {
      await execFileAsync("7z", ["x", "-y", `-o${destinationRoot}`, archivePath], {
        maxBuffer: 1024 * 1024 * 20
      });
      return;
    } catch {
      await execFileAsync("unrar", ["x", "-o+", archivePath, destinationRoot], {
        maxBuffer: 1024 * 1024 * 20
      });
      return;
    }
  }

  throw new Error(`Unsupported archive type: ${ext}`);
}

export async function scanSimsContent(sourceRoot: string): Promise<SimsScanResult> {
  const resolvedRoot = path.resolve(sourceRoot);
  const settings = getSimsInstallSettings();
  const files = walkFiles(resolvedRoot);
  const candidates: SimsContentCandidate[] = [];
  const errors: string[] = [];
  const archives = files.filter((file) => ARCHIVE_EXTENSIONS.has(path.extname(file).toLowerCase()));

  for (const filePath of files) {
    if (ARCHIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      continue;
    }
    const relativePath = path.relative(resolvedRoot, filePath);
    const candidate = createCandidate({
      filePath,
      sourceRoot: resolvedRoot,
      sourceKey: filePath,
      relativePath,
      fromArchive: false,
      archivePath: null,
      installSubdir: path.dirname(relativePath)
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  for (const archivePath of archives) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patreon-sims-"));
    try {
      await extractArchive(archivePath, tempRoot);
      for (const extractedPath of walkFiles(tempRoot)) {
        const internalPath = path.relative(tempRoot, extractedPath);
        const candidate = createCandidate({
          filePath: extractedPath,
          sourceRoot: resolvedRoot,
          sourceKey: `${archivePath}::${internalPath}`,
          relativePath: `${path.relative(resolvedRoot, archivePath)}::${internalPath}`,
          fromArchive: true,
          archivePath,
          installSubdir: getArchiveInstallSubdir(resolvedRoot, archivePath, internalPath)
        });
        if (candidate) {
          candidates.push(candidate);
        }
      }
    } catch (error: unknown) {
      errors.push(
        `${path.relative(resolvedRoot, archivePath)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    sourceRoot: resolvedRoot,
    settings,
    directFiles: candidates.filter((candidate) => !candidate.fromArchive).length,
    archives: archives.length,
    candidates,
    errors
  };
}

function getDestinationPath(candidate: SimsContentCandidate, settings: SimsInstallSettings) {
  if (candidate.kind === "tray") {
    return path.join(settings.trayDir, candidate.fileName);
  }
  return path.join(settings.libraryDir, candidate.installSubdir, candidate.fileName);
}

export async function installSimsContent(sourceRoot: string): Promise<SimsInstallResult> {
  const resolvedRoot = path.resolve(sourceRoot);
  const settings = getSimsInstallSettings();
  const files = walkFiles(resolvedRoot);
  const archives = files.filter((file) => ARCHIVE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const candidates: SimsContentCandidate[] = [];
  const db = loadDatabase();
  const installedBySource = new Map(db.installedFiles.map((file) => [file.sourceKey, file]));
  const installed: SimsInstalledFile[] = [];
  const skipped: SimsInstalledFile[] = [];
  const errors: string[] = [];

  fs.mkdirSync(settings.libraryDir, { recursive: true });
  fs.mkdirSync(settings.trayDir, { recursive: true });

  const installCandidate = (candidate: SimsContentCandidate) => {
    try {
      const existing = installedBySource.get(candidate.sourceKey);
      if (
        existing &&
        existing.sourceMtimeMs === candidate.mtimeMs &&
        existing.sourceSize === candidate.size &&
        fs.existsSync(existing.destinationPath)
      ) {
        skipped.push(existing);
        return;
      }

      const baseDestinationPath = getDestinationPath(candidate, settings);
      if (candidate.kind === "mods" && !isPathInside(baseDestinationPath, settings.libraryDir)) {
        throw new Error(`Unsafe Mods destination: ${baseDestinationPath}`);
      }
      if (candidate.kind === "tray" && !isPathInside(baseDestinationPath, settings.trayDir)) {
        throw new Error(`Unsafe Tray destination: ${baseDestinationPath}`);
      }

      fs.mkdirSync(path.dirname(baseDestinationPath), { recursive: true });
      const destinationPath =
        existing?.destinationPath && fs.existsSync(existing.destinationPath) ?
          existing.destinationPath
        : ensureUniquePath(baseDestinationPath);
      fs.copyFileSync(candidate.sourcePath, destinationPath);

      const installedFile: SimsInstalledFile = {
        sourceKey: candidate.sourceKey,
        sourcePath:
          candidate.fromArchive && candidate.archivePath ?
            candidate.archivePath
          : candidate.sourcePath,
        sourceMtimeMs: candidate.mtimeMs,
        sourceSize: candidate.size,
        destinationPath,
        kind: candidate.kind,
        fromArchive: candidate.fromArchive,
        archivePath: candidate.archivePath,
        installedAt: new Date().toISOString()
      };
      installedBySource.set(candidate.sourceKey, installedFile);
      installed.push(installedFile);
    } catch (error: unknown) {
      errors.push(
        `${candidate.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  for (const filePath of files) {
    if (ARCHIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      continue;
    }
    const relativePath = path.relative(resolvedRoot, filePath);
    const candidate = createCandidate({
      filePath,
      sourceRoot: resolvedRoot,
      sourceKey: filePath,
      relativePath,
      fromArchive: false,
      archivePath: null,
      installSubdir: path.dirname(relativePath)
    });
    if (candidate) {
      candidates.push(candidate);
      installCandidate(candidate);
    }
  }

  for (const archivePath of archives) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "patreon-sims-"));
    try {
      await extractArchive(archivePath, tempRoot);
      for (const extractedPath of walkFiles(tempRoot)) {
        const internalPath = path.relative(tempRoot, extractedPath);
        const candidate = createCandidate({
          filePath: extractedPath,
          sourceRoot: resolvedRoot,
          sourceKey: `${archivePath}::${internalPath}`,
          relativePath: `${path.relative(resolvedRoot, archivePath)}::${internalPath}`,
          fromArchive: true,
          archivePath,
          installSubdir: getArchiveInstallSubdir(resolvedRoot, archivePath, internalPath)
        });
        if (candidate) {
          candidates.push(candidate);
          installCandidate(candidate);
        }
      }
    } catch (error: unknown) {
      errors.push(
        `${path.relative(resolvedRoot, archivePath)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  db.installedFiles = [...installedBySource.values()];
  saveDatabase(db);

  return {
    sourceRoot: resolvedRoot,
    settings,
    directFiles: candidates.filter((candidate) => !candidate.fromArchive).length,
    archives: archives.length,
    candidates,
    installed,
    skipped,
    errors
  };
}
