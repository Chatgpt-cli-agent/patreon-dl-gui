import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import extractZip from "extract-zip";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar"]);
const EXTRACTION_MARKER = ".patreon-dl-extracted.json";
const activeExtractions = new Map<string, Promise<ArchiveExtractionEntry>>();

export interface ArchiveExtractionEntry {
  archivePath: string;
  destinationPath: string | null;
  status: "extracted" | "alreadyExtracted" | "error";
  error: string | null;
}

export interface ArchiveExtractionResult {
  rootDir: string;
  extracted: ArchiveExtractionEntry[];
  alreadyExtracted: ArchiveExtractionEntry[];
  errors: ArchiveExtractionEntry[];
}

interface ExtractionMarker {
  archivePath: string;
  size: number;
  mtimeMs: number;
}

function getErrorString(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function walkArchives(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const archives: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (
        entry.isFile() &&
        ARCHIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        archives.push(entryPath);
      }
    }
  }
  return archives.sort();
}

function markerMatches(destinationPath: string, marker: ExtractionMarker) {
  const markerPath = path.join(destinationPath, EXTRACTION_MARKER);
  try {
    const stored = JSON.parse(
      fs.readFileSync(markerPath, "utf-8")
    ) as Partial<ExtractionMarker>;
    return (
      stored.archivePath === marker.archivePath &&
      stored.size === marker.size &&
      stored.mtimeMs === marker.mtimeMs
    );
  } catch {
    return false;
  }
}

function findDestination(archivePath: string, marker: ExtractionMarker) {
  const parsed = path.parse(archivePath);
  const basePath = path.join(parsed.dir, parsed.name);
  for (let index = 0; index < 1000; index++) {
    const candidate = index === 0 ? basePath : `${basePath} (${index})`;
    if (!fs.existsSync(candidate)) {
      return { destinationPath: candidate, alreadyExtracted: false };
    }
    if (fs.statSync(candidate).isDirectory() && markerMatches(candidate, marker)) {
      return { destinationPath: candidate, alreadyExtracted: true };
    }
  }
  throw new Error(`Could not choose an extraction folder for ${archivePath}`);
}

function assertSafeExtractedTree(rootDir: string) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Archive contains an unsupported symbolic link: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

async function extractRar(archivePath: string, destinationPath: string) {
  try {
    await execFileAsync(
      "7z",
      ["x", "-y", `-o${destinationPath}`, archivePath],
      { maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (sevenZipError: unknown) {
    try {
      await execFileAsync(
        "unrar",
        ["x", "-o+", archivePath, `${destinationPath}${path.sep}`],
        { maxBuffer: 10 * 1024 * 1024 }
      );
    } catch (unrarError: unknown) {
      throw new Error(
        `RAR extraction failed. 7z: ${getErrorString(sevenZipError)}; unrar: ${getErrorString(unrarError)}`
      );
    }
  }
}

async function extractOne(archivePath: string): Promise<ArchiveExtractionEntry> {
  const resolvedArchivePath = path.resolve(archivePath);
  const existing = activeExtractions.get(resolvedArchivePath);
  if (existing) {
    return existing;
  }

  const extraction = (async (): Promise<ArchiveExtractionEntry> => {
    let tempDir: string | null = null;
    try {
      const stat = fs.statSync(resolvedArchivePath);
      const marker: ExtractionMarker = {
        archivePath: resolvedArchivePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
      const { destinationPath, alreadyExtracted } = findDestination(
        resolvedArchivePath,
        marker
      );
      if (alreadyExtracted) {
        return {
          archivePath: resolvedArchivePath,
          destinationPath,
          status: "alreadyExtracted",
          error: null
        };
      }

      tempDir = await fs.promises.mkdtemp(
        path.join(path.dirname(resolvedArchivePath), ".patreon-extract-")
      );
      const extension = path.extname(resolvedArchivePath).toLowerCase();
      if (extension === ".zip") {
        await extractZip(resolvedArchivePath, { dir: tempDir });
      } else if (extension === ".rar") {
        await extractRar(resolvedArchivePath, tempDir);
      } else {
        throw new Error(`Unsupported archive type: ${extension}`);
      }

      assertSafeExtractedTree(tempDir);
      await fs.promises.writeFile(
        path.join(tempDir, EXTRACTION_MARKER),
        JSON.stringify(marker, null, 2),
        "utf-8"
      );
      await fs.promises.rename(tempDir, destinationPath);
      tempDir = null;
      return {
        archivePath: resolvedArchivePath,
        destinationPath,
        status: "extracted",
        error: null
      };
    } catch (error: unknown) {
      return {
        archivePath: resolvedArchivePath,
        destinationPath: null,
        status: "error",
        error: getErrorString(error)
      };
    } finally {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
  })();

  activeExtractions.set(resolvedArchivePath, extraction);
  try {
    return await extraction;
  } finally {
    activeExtractions.delete(resolvedArchivePath);
  }
}

export function extractDownloadedArchive(
  archivePath: string
): Promise<ArchiveExtractionEntry> {
  return extractOne(archivePath);
}

export async function extractDownloadedArchives(
  rootDir: string
): Promise<ArchiveExtractionResult> {
  const resolvedRoot = path.resolve(rootDir);
  const entries = await Promise.all(walkArchives(resolvedRoot).map(extractOne));
  return {
    rootDir: resolvedRoot,
    extracted: entries.filter((entry) => entry.status === "extracted"),
    alreadyExtracted: entries.filter(
      (entry) => entry.status === "alreadyExtracted"
    ),
    errors: entries.filter((entry) => entry.status === "error")
  };
}
