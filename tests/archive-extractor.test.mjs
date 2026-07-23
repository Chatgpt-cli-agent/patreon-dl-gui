import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const tempRoot = await mkdtemp(path.join(tmpdir(), "archive-extractor-"));
const compiledRoot = path.join(tempRoot, "compiled");
const fixtureRoot = path.join(
  tempRoot,
  "PatreonDownloads",
  "Test Creator",
  "posts",
  "Test Post - 123",
  "attachments"
);

try {
  await mkdir(compiledRoot, { recursive: true });
  await symlink(
    path.join(repoRoot, "node_modules"),
    path.join(compiledRoot, "node_modules"),
    "dir"
  );
  execFileSync(
    path.join(repoRoot, "node_modules/.bin/tsc"),
    [
      path.join(repoRoot, "src/main/util/ArchiveExtractor.ts"),
      "--target", "ES2022",
      "--module", "commonjs",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--strict",
      "--skipLibCheck",
      "--outDir", compiledRoot
    ],
    { stdio: "inherit" }
  );

  await mkdir(path.join(fixtureRoot, "zip-source", "nested"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "zip-source", "nested", "example.package"),
    "test package contents",
    "utf-8"
  );
  const zipPath = path.join(fixtureRoot, "Creator Pack.zip");
  execFileSync(
    "zip",
    ["-qr", zipPath, "nested"],
    { cwd: path.join(fixtureRoot, "zip-source") }
  );
  await rm(path.join(fixtureRoot, "zip-source"), { recursive: true });

  const require = createRequire(import.meta.url);
  const { extractDownloadedArchives } = require(
    path.join(compiledRoot, "ArchiveExtractor.js")
  );

  const first = await extractDownloadedArchives(path.join(tempRoot, "PatreonDownloads"));
  assert.equal(first.extracted.length, 1);
  assert.equal(first.errors.length, 0);
  assert.ok(existsSync(zipPath), "the original ZIP must remain untouched");
  const extractedPath = path.join(fixtureRoot, "Creator Pack", "nested", "example.package");
  assert.equal(await readFile(extractedPath, "utf-8"), "test package contents");

  const second = await extractDownloadedArchives(path.join(tempRoot, "PatreonDownloads"));
  assert.equal(second.extracted.length, 0);
  assert.equal(second.alreadyExtracted.length, 1);
  assert.equal(second.errors.length, 0);
  assert.ok(!existsSync(path.join(fixtureRoot, "Creator Pack (1)")));

  const existingFolder = path.join(fixtureRoot, "Keep Mine");
  await mkdir(existingFolder);
  await writeFile(path.join(existingFolder, "personal.txt"), "do not overwrite");
  await mkdir(path.join(fixtureRoot, "second-source"));
  await writeFile(path.join(fixtureRoot, "second-source", "new.package"), "new file");
  const conflictingZip = path.join(fixtureRoot, "Keep Mine.zip");
  execFileSync("zip", ["-q", conflictingZip, "new.package"], {
    cwd: path.join(fixtureRoot, "second-source")
  });
  await rm(path.join(fixtureRoot, "second-source"), { recursive: true });

  const conflict = await extractDownloadedArchives(path.join(tempRoot, "PatreonDownloads"));
  assert.equal(conflict.extracted.length, 1);
  assert.equal(await readFile(path.join(existingFolder, "personal.txt"), "utf-8"), "do not overwrite");
  assert.ok(existsSync(path.join(fixtureRoot, "Keep Mine (1)", "new.package")));
  assert.ok(existsSync(conflictingZip));

  console.log("PASS: archives extract beside originals, preserve existing folders, and rerun safely");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
