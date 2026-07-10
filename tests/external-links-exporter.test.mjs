// Real end-to-end test of ExternalLinksExporter:
//   1. Build a real patreon-dl SQLite DB by feeding real Post objects
//      (produced by the real PostParser) through the real DB class.
//   2. listDownloadedCreators should return every campaign with correct
//      post counts and hasExternalLinks flags.
//   3. exportCreatorExternalLinks should write one HTML file per
//      selected creator into the chosen folder, with the right content.
//   4. The HTML file should be readable and the existing reader in
//      util/ExternalLinks.ts (now a thin wrapper) should still parse
//      it.
//
// Run from inside patreon-dl-gui:
//   node tests/external-links-exporter.test.mjs

import { execFileSync } from "node:child_process";
import { access, mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = "/media/San-Myshuno/sims4-mod-manager/patreon-dl-gui";
const tmp = await mkdtemp(path.join(tmpdir(), "exp-"));
const req = createRequire(import.meta.url);

// 1. Compile our exporter + writer to CJS in a temp dir.
const exporterSrc = path.join(
  repoRoot,
  "src/main/util/ExternalLinksExporter.ts"
);
const writerSrc = path.join(
  repoRoot,
  "src/main/util/ExternalLinksWriter.ts"
);
const outDir = path.join(tmp, "compiled");
await mkdir(outDir, { recursive: true });
try {
  await import("node:fs/promises").then((m) =>
    m.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(outDir, "node_modules"),
      "dir"
    )
  );
} catch {}
execFileSync(
  path.join(repoRoot, "node_modules/.bin/tsc"),
  [
    exporterSrc,
    writerSrc,
    "--target", "ES2022",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--strict",
    "--skipLibCheck",
    "--outDir", outDir,
    "--baseUrl", repoRoot
  ],
  { stdio: "inherit" }
);

const exporter = req(
  path.join(outDir, "main/util/ExternalLinksExporter.js")
);
console.log("Exporter loaded. Exports:", Object.keys(exporter).sort());

// 2. Build a real DB.
const PostParser = req(
  path.join(repoRoot, "node_modules/patreon-dl/dist/parsers/PostParser.js")
).default;
const stubFetcher = { get: async () => ({ json: null, error: null }) };
const parser = new PostParser(stubFetcher);

function makePostAPI({ id, title, htmlContent, publishedAt, campaignId, campaignName, campaignVanity }) {
  return {
    data: {
      id,
      type: "post",
      attributes: {
        title,
        content: htmlContent,
        post_type: "text_only",
        published_at: publishedAt,
        url: `https://www.patreon.com/posts/example-${id}`,
        current_user_can_view: true,
        is_paid: false,
        teaser_text: ""
      },
      relationships: {
        campaign: { data: { id: campaignId, type: "campaign" } }
      }
    },
    included: [
      {
        id: campaignId,
        type: "campaign",
        attributes: {
          name: campaignName,
          url: `https://www.patreon.com/${campaignVanity}`,
          vanity: campaignVanity
        }
      }
    ]
  };
}

const postJSONs = [
  makePostAPI({
    id: "700001",
    title: "Mod Pack X",
    publishedAt: "2025-04-01T10:00:00.000Z",
    campaignId: "1001",
    campaignName: "AlphaCreator",
    campaignVanity: "alphacreator",
    htmlContent: `<p>Download: <a href="https://drive.google.com/file/d/AAA">Drive link</a></p>`
  }),
  makePostAPI({
    id: "700002",
    title: "Hair Pack",
    publishedAt: "2025-04-15T10:00:00.000Z",
    campaignId: "1001",
    campaignName: "AlphaCreator",
    campaignVanity: "alphacreator",
    htmlContent: `<p>From <a href="https://simfileshare.net/download/999">SimFileShare</a></p>`
  }),
  makePostAPI({
    id: "700003",
    title: "Empty update",
    publishedAt: "2025-05-01T10:00:00.000Z",
    campaignId: "1001",
    campaignName: "AlphaCreator",
    campaignVanity: "alphacreator",
    htmlContent: `<p>No links here.</p>`
  }),
  makePostAPI({
    id: "800001",
    title: "Beta Post",
    publishedAt: "2025-04-10T10:00:00.000Z",
    campaignId: "1002",
    campaignName: "BetaCreator",
    campaignVanity: "betacreator",
    htmlContent: `<p>From <a href="https://mega.nz/file/CCC">Mega</a></p>`
  })
];

const realPosts = [];
for (const json of postJSONs) {
  const list = await parser.parsePostsAPIResponse(json, "test://");
  realPosts.push(list.items[0]);
}
console.log("Built", realPosts.length, "real Posts via PostParser");

// Save them into a real patreon-dl DB.
const { default: DB } = req(
  path.join(repoRoot, "node_modules/patreon-dl/dist/browse/db/index.js")
);
const downloadsDir = path.join(tmp, "downloads");
const dbDir = path.join(downloadsDir, ".patreon-dl");
await mkdir(dbDir, { recursive: true });
const dbPath = path.join(dbDir, "db.sqlite");
const db = await DB.getInstance(dbPath, false);
const seenCampaigns = new Map();
for (const p of realPosts) {
  if (p.campaign && !seenCampaigns.has(p.campaign.id)) {
    seenCampaigns.set(p.campaign.id, p.campaign);
    db.saveCampaign(p.campaign, new Date(), true);
  }
}
for (const p of realPosts) {
  db.saveContent(p);
}
db.close();
console.log("Wrote real DB at:", dbPath);

// Create realistic downloaded post folders so the exporter can place
// per-post link files next to each post's downloaded media.
for (const p of realPosts) {
  const campaignDir = path.join(downloadsDir, p.campaign.name);
  const postDir = path.join(campaignDir, "posts", `${p.title} - ${p.id}`);
  await mkdir(postDir, { recursive: true });
}

// 3. listDownloadedCreators.
const list = exporter.listDownloadedCreators(downloadsDir);
console.log("listDownloadedCreators returned:", JSON.stringify(list, null, 2));

if (list.length !== 2) throw new Error(`Expected 2 creators, got ${list.length}`);
const alpha = list.find((c) => c.name === "AlphaCreator");
const beta = list.find((c) => c.name === "BetaCreator");
if (!alpha || !beta) throw new Error("Missing AlphaCreator or BetaCreator");
if (alpha.postCount !== 3) throw new Error(`AlphaCreator postCount: expected 3, got ${alpha.postCount}`);
if (beta.postCount !== 1) throw new Error(`BetaCreator postCount: expected 1, got ${beta.postCount}`);
if (!alpha.hasExternalLinks) throw new Error("AlphaCreator should have external links");
if (!beta.hasExternalLinks) throw new Error("BetaCreator should have external links");
if (alpha.status !== "metadataOnly") {
  throw new Error(`AlphaCreator status before media rows: expected metadataOnly, got ${alpha.status}`);
}
if (alpha.mediaFileCount !== 0 || alpha.filesMissing !== 0) {
  throw new Error("AlphaCreator should have no expected media files before media rows are added");
}
console.log("PASS: listDownloadedCreators correct");

// 3b. Creator health scan: DB media row exists but file is missing.
const BetterSqlite = req(path.join(repoRoot, "node_modules/better-sqlite3"));
const rawDb = new BetterSqlite(dbPath);
const expectedMediaRelPath =
  "AlphaCreator/posts/Mod Pack X - 700001/attachments/alpha.package";
rawDb
  .prepare(
    `INSERT INTO media(media_id, media_type, mime_type, download_path)
     VALUES (?, ?, ?, ?)`
  )
  .run("media-alpha-package", "other", null, expectedMediaRelPath);
rawDb
  .prepare(
    `INSERT INTO content_media(media_id, content_id, content_type, media_index, campaign_id, is_preview)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  .run("media-alpha-package", "700001", "post", 0, "1001", 0);
rawDb.close();

const missingList = exporter.listDownloadedCreators(downloadsDir);
const alphaMissing = missingList.find((c) => c.name === "AlphaCreator");
if (!alphaMissing) throw new Error("Missing AlphaCreator after media insert");
if (alphaMissing.status !== "needsRepair") {
  throw new Error(`AlphaCreator status with missing file: expected needsRepair, got ${alphaMissing.status}`);
}
if (alphaMissing.mediaFileCount !== 1 || alphaMissing.filesPresent !== 0 || alphaMissing.filesMissing !== 1) {
  throw new Error(`AlphaCreator bad missing-file counts: ${JSON.stringify(alphaMissing)}`);
}
console.log("PASS: health scan marks missing DB media as needsRepair");

await mkdir(path.dirname(path.join(downloadsDir, expectedMediaRelPath)), {
  recursive: true
});
await writeFile(path.join(downloadsDir, expectedMediaRelPath), "package data");
const repairedList = exporter.listDownloadedCreators(downloadsDir);
const alphaRepaired = repairedList.find((c) => c.name === "AlphaCreator");
if (!alphaRepaired) throw new Error("Missing AlphaCreator after file write");
if (alphaRepaired.status !== "linksPending") {
  throw new Error(`AlphaCreator status with file present: expected linksPending, got ${alphaRepaired.status}`);
}
if (alphaRepaired.mediaFileCount !== 1 || alphaRepaired.filesPresent !== 1 || alphaRepaired.filesMissing !== 0) {
  throw new Error(`AlphaCreator bad repaired counts: ${JSON.stringify(alphaRepaired)}`);
}
console.log("PASS: health scan clears needsRepair when expected file exists");

// 4. exportCreatorExternalLinks — select only AlphaCreator.
const targetFolder = path.join(tmp, "output");
const result = await exporter.exportCreatorExternalLinks({
  outDir: downloadsDir,
  creatorIds: [alpha.id],
  targetFolder
});
console.log("Export result:", JSON.stringify(result, null, 2));

if (result.filesWritten.length !== 3) {
  throw new Error(`Expected 3 files written, got ${result.filesWritten.length}`);
}
if (result.errors.length !== 0) {
  throw new Error(`Unexpected errors: ${result.errors.join("; ")}`);
}
const expectedFile = path.join(targetFolder, "AlphaCreator_external-links.html");
const written = result.filesWritten[0];
if (written !== expectedFile) {
  throw new Error(`Expected file at ${expectedFile}, got ${written}`);
}
console.log("PASS: export wrote file at correct path");
await access(path.join(downloadsDir, "AlphaCreator", "attachments"));
console.log("PASS: creator attachments folder exists for AlphaCreator");

const expectedPostFiles = [
  path.join(downloadsDir, "AlphaCreator", "posts", "Mod Pack X - 700001", "_external-links.html"),
  path.join(downloadsDir, "AlphaCreator", "posts", "Hair Pack - 700002", "_external-links.html")
];
for (const file of expectedPostFiles) {
  if (result.filesWritten.indexOf(file) < 0) {
    throw new Error(`Per-post external links file missing from result: ${file}`);
  }
  const postHtml = await readFile(file, "utf-8");
  if (!postHtml.includes("AlphaCreator")) {
    throw new Error(`Per-post file missing creator name: ${file}`);
  }
  await access(path.join(path.dirname(file), "attachments"));
  console.log("PASS: per-post file written:", file);
}

const html = await readFile(written, "utf-8");
console.log("File size:", html.length, "bytes");
const expectedInFile = [
  "AlphaCreator",
  "Mod Pack X",
  "Hair Pack",
  // post 3 (no links) should NOT appear
  // "Empty update",
  "https://drive.google.com/file/d/AAA",
  "https://simfileshare.net/download/999"
];
const mustNotContain = ["Empty update", "BetaCreator"];
for (const c of expectedInFile) {
  if (!html.includes(c)) throw new Error(`HTML missing: ${c}`);
  console.log("  PASS contains:", c);
}
for (const c of mustNotContain) {
  if (html.includes(c)) throw new Error(`HTML should not contain: ${c}`);
  console.log("  PASS excludes:", c);
}

// 5. Export both creators — should produce 2 files.
const result2 = await exporter.exportCreatorExternalLinks({
  outDir: downloadsDir,
  creatorIds: [alpha.id, beta.id],
  targetFolder
});
console.log("Two-creator export result:", JSON.stringify(result2, null, 2));
if (result2.filesWritten.length !== 5) {
  throw new Error(`Expected 5 files, got ${result2.filesWritten.length}`);
}
const expectedAlpha = path.join(targetFolder, "AlphaCreator_external-links.html");
const expectedBeta = path.join(targetFolder, "BetaCreator_external-links.html");
if (result2.filesWritten.indexOf(expectedAlpha) < 0)
  throw new Error("Alpha file missing from result");
if (result2.filesWritten.indexOf(expectedBeta) < 0)
  throw new Error("Beta file missing from result");
console.log("PASS: 2 files written for 2 creators");

// 6. Test edge case: creator with NO external links.
const allPostsNoLinks = makePostAPI({
  id: "900001",
  title: "Only text",
  publishedAt: "2025-05-01T10:00:00.000Z",
  campaignId: "1003",
  campaignName: "EmptyCreator",
  campaignVanity: "empty",
  htmlContent: `<p>No links at all.</p>`
});
const list3 = await parser.parsePostsAPIResponse(allPostsNoLinks, "test://");
const emptyPost = list3.items[0];
const db2 = await DB.getInstance(dbPath, false);
db2.saveCampaign(emptyPost.campaign, new Date(), true);
db2.saveContent(emptyPost);
db2.close();

const result3 = await exporter.exportCreatorExternalLinks({
  outDir: downloadsDir,
  creatorIds: ["1003"],
  targetFolder
});
console.log("Empty-creator export result:", JSON.stringify(result3, null, 2));
if (result3.filesWritten.length !== 0) {
  throw new Error(`Expected 0 files for empty creator, got ${result3.filesWritten.length}`);
}
if (result3.filesSkipped.length !== 1) {
  throw new Error(`Expected 1 skipped, got ${result3.filesSkipped.length}`);
}
await access(path.join(downloadsDir, "EmptyCreator", "attachments"));
console.log("PASS: creator with no external links is correctly skipped");

// 7. Confirm the legacy reader in util/ExternalLinks.ts still parses
// the output (so the test file works as a self-check).
const readerSrc = path.join(
  repoRoot,
  "src/main/util/ExternalLinks.ts"
);
const readerOutDir = path.join(tmp, "reader-compiled");
await mkdir(readerOutDir, { recursive: true });
try {
  await import("node:fs/promises").then((m) =>
    m.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(readerOutDir, "node_modules"),
      "dir"
    )
  );
} catch {}
execFileSync(
  path.join(repoRoot, "node_modules/.bin/tsc"),
  [
    readerSrc,
    "--target", "ES2022",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--strict",
    "--skipLibCheck",
    "--outDir", readerOutDir,
    "--baseUrl", repoRoot
  ],
  { stdio: "inherit" }
);
const reader = req(path.join(readerOutDir, "main/util/ExternalLinks.js"));
const groups = await reader.findExternalLinks(downloadsDir);
console.log("Reader found groups:", JSON.stringify(groups.map((g) => g.source), null, 2));
if (groups.length !== 3) throw new Error(`Reader expected 3 groups, got ${groups.length}`);
console.log("PASS: legacy reader parses the exporter's output");

// 8. Repair state should clear a selected creator from the DB and remove
// its creator-local status cache without touching other creators.
const emptyCreatorDir = path.join(downloadsDir, "EmptyCreator");
const emptyStatusCache = path.join(
  emptyCreatorDir,
  ".patreon-dl",
  "status-cache.json"
);
await mkdir(path.dirname(emptyStatusCache), { recursive: true });
await writeFile(emptyStatusCache, "{}");
const repairResult = exporter.repairCreatorDownloadState(downloadsDir, "1003");
console.log("Repair result:", JSON.stringify(repairResult, null, 2));
if (!repairResult.success) {
  throw new Error(`Repair failed: ${repairResult.errors.join("; ")}`);
}
if (repairResult.deletedRows.campaign !== 1) {
  throw new Error(`Repair should delete 1 campaign row, got ${repairResult.deletedRows.campaign}`);
}
if (repairResult.removedFiles.indexOf(emptyStatusCache) < 0) {
  throw new Error("Repair did not remove status-cache.json");
}
const afterRepairList = exporter.listDownloadedCreators(downloadsDir);
if (afterRepairList.some((creator) => creator.id === "1003")) {
  throw new Error("Repaired creator should no longer appear in creator list");
}
if (!afterRepairList.some((creator) => creator.id === "1001")) {
  throw new Error("Repair should not remove unrelated creators");
}
console.log("PASS: repair clears selected creator DB/cache state only");

// 9. Clear generated external-link files and creator-library DB rows
// without touching ordinary downloaded files.
const ordinaryFile = path.join(downloadsDir, "AlphaCreator", "posts", "Mod Pack X - 700001", "keep-me.package");
await writeFile(ordinaryFile, "not an external-links report");
const staleTargetReport = path.join(targetFolder, "StaleCreator_external-links.html");
await writeFile(staleTargetReport, "<html>stale</html>");
const clearResult = exporter.clearExternalLinkFiles(downloadsDir, targetFolder);
console.log("Clear result:", JSON.stringify(clearResult, null, 2));
if (clearResult.errors.length > 0) {
  throw new Error(`Clear should not fail: ${clearResult.errors.join("; ")}`);
}
if (clearResult.removedFiles.length < 4) {
  throw new Error(`Clear should remove generated reports, got ${clearResult.removedFiles.length}`);
}
const deletedRows = Object.values(clearResult.deletedRows).reduce((sum, count) => sum + count, 0);
if (deletedRows === 0) {
  throw new Error("Clear should remove creator-library DB rows");
}
for (const removed of clearResult.removedFiles) {
  let stillExists = false;
  try {
    await readFile(removed, "utf-8");
    stillExists = true;
  } catch {}
  if (stillExists) {
    throw new Error(`Clear did not remove ${removed}`);
  }
}
const ordinaryStillThere = await readFile(ordinaryFile, "utf-8");
if (ordinaryStillThere !== "not an external-links report") {
  throw new Error("Clear should not touch ordinary downloaded files");
}
const afterClearList = exporter.listDownloadedCreators(downloadsDir);
if (afterClearList.length !== 0) {
  throw new Error(`Clear should empty creator library, got ${afterClearList.length}`);
}
console.log("PASS: clear removes reports and empties creator library only");

console.log("\n=== EXPORTER END-TO-END TEST PASSED ===");
console.log("A real patreon-dl DB was built, listDownloadedCreators returned the");
console.log("right creators with the right counts, exportCreatorExternalLinks wrote");
console.log("the requested file(s) at the requested location, and the legacy reader");
console.log("still parses the produced HTML.\n");

await rm(tmp, { recursive: true, force: true });
