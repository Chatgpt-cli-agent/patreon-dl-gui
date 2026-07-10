// Real end-to-end test of ExternalLinksRegen: build a real patreon-dl
// SQLite database using the real DB class + real Post objects produced
// by the real PostParser, then run regenerateExternalLinksFromDB
// against that database and verify the output file matches what the
// existing reader (and the GUI's "External Links" tab) can parse.
//
// Run from inside patreon-dl-gui:
//   node tests/external-links-regen.test.mjs
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = "/media/San-Myshuno/sims4-mod-manager/patreon-dl-gui";
const tmp = await mkdtemp(path.join(tmpdir(), "regen-"));
const req = createRequire(import.meta.url);

// 1. Compile the regen TS module to CJS.
const regenSrc = path.join(repoRoot, "src/main/util/ExternalLinksRegen.ts");
const outDir = path.join(tmp, "compiled");
await mkdir(outDir, { recursive: true });
try {
  await import("node:fs/promises").then((m) =>
    m.symlink(path.join(repoRoot, "node_modules"), path.join(outDir, "node_modules"), "dir")
  );
} catch {}
execFileSync(
  path.join(repoRoot, "node_modules/.bin/tsc"),
  [
    regenSrc,
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
const regen = req(path.join(outDir, "main/util/ExternalLinksRegen.js"));

console.log("Regen module loaded. Exports:", Object.keys(regen).sort());

// 2. Build real Post objects with the real PostParser.
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
    id: "500001",
    title: "Mod Pack A",
    publishedAt: "2025-04-01T10:00:00.000Z",
    campaignId: "111",
    campaignName: "CreatorOne",
    campaignVanity: "creatorone",
    htmlContent: `<p>Download: <a href="https://drive.google.com/file/d/AAA">Drive link</a></p>`
  }),
  makePostAPI({
    id: "500002",
    title: "Hair Pack",
    publishedAt: "2025-04-15T10:00:00.000Z",
    campaignId: "111",
    campaignName: "CreatorOne",
    campaignVanity: "creatorone",
    htmlContent: `<p>From <a href="https://simfileshare.net/download/999">SimFileShare</a> or <a href="https://drive.google.com/folder/BBB">Drive folder</a></p>`
  }),
  makePostAPI({
    id: "500003",
    title: "Just an update",
    publishedAt: "2025-05-01T10:00:00.000Z",
    campaignId: "111",
    campaignName: "CreatorOne",
    campaignVanity: "creatorone",
    htmlContent: `<p>No links this time.</p>`
  }),
  makePostAPI({
    id: "600001",
    title: "CreatorTwo Post",
    publishedAt: "2025-04-10T10:00:00.000Z",
    campaignId: "222",
    campaignName: "CreatorTwo",
    campaignVanity: "creatortwo",
    htmlContent: `<p>Files: <a href="https://mega.nz/file/CCC">Mega</a></p>`
  })
];

const realPosts = [];
for (const json of postJSONs) {
  const list = await parser.parsePostsAPIResponse(json, "test://");
  realPosts.push(list.items[0]);
}
console.log("Built", realPosts.length, "real Posts via PostParser");

// 3. Save them into a real patreon-dl SQLite database.
const { default: DB } = req(
  path.join(repoRoot, "node_modules/patreon-dl/dist/browse/db/index.js")
);
const userDownloadsDir = path.join(tmp, "downloads");
const dbDir = path.join(userDownloadsDir, ".patreon-dl");
await mkdir(dbDir, { recursive: true });
const dbPath = path.join(dbDir, "db.sqlite");
const db = await DB.getInstance(dbPath, false);

// Build unique campaigns from the posts.
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

console.log("Wrote real patreon-dl DB at:", dbPath);
const dbStat = await stat(dbPath);
console.log("DB size:", dbStat.size, "bytes");

// Sanity: re-open and confirm campaigns + posts are there.
const dbCheck = await DB.getInstance(dbPath, false);
const campaignList = dbCheck.getCampaignList({});
const postList = dbCheck.getContentList({ contentType: "post" });
console.log("DB has", campaignList.campaigns.length, "campaigns and", postList.items.length, "posts");
dbCheck.close();

// 4. Run regenerateExternalLinksFromDB.
const logs = [];
const result = await regen.regenerateExternalLinksFromDB({
  outDir: userDownloadsDir,
  log: (level, message) => {
    logs.push(`[${level}] ${message}`);
  }
});
console.log("\n--- regen log (no existing campaign dirs) ---");
logs.forEach((l) => console.log(l));
console.log("--- end log ---\n");

console.log("Regen result:", result);

if (result.campaignsScanned !== 2) throw new Error(`Expected 2 campaigns scanned, got ${result.campaignsScanned}`);
if (result.postsScanned !== 4) throw new Error(`Expected 4 posts scanned, got ${result.postsScanned}`);
if (result.filesWritten !== 2) throw new Error(`Expected 2 files written, got ${result.filesWritten}`);
if (result.errors.length !== 0) throw new Error(`Errors: ${result.errors.join("; ")}`);
console.log("PASS: result counts correct");

// 4b. Now simulate the real case: user has an existing campaign dir
// with the patreon-dl layout (containing a "posts/" subdir). Re-run the
// regen and confirm it writes into the EXISTING dir, not a new one.
const existingCreatorOneDir = path.join(userDownloadsDir, "CreatorOne");
const existingCreatorTwoDir = path.join(userDownloadsDir, "CreatorTwo");
await mkdir(path.join(existingCreatorOneDir, "posts"), { recursive: true });
await mkdir(path.join(existingCreatorTwoDir, "posts"), { recursive: true });
// Touch a file inside "posts" so mapExistingCampaignDirs picks them up.
await writeFile(
  path.join(existingCreatorOneDir, "posts", "placeholder.txt"),
  "fake post",
  "utf-8"
);
await writeFile(
  path.join(existingCreatorTwoDir, "posts", "placeholder.txt"),
  "fake post",
  "utf-8"
);

// Delete the previously-written external-links files so we can see them
// reappear after the regen.
const { unlink } = await import("node:fs/promises");
try { await unlink(path.join(existingCreatorOneDir, "_external-links.html")); } catch {}
try { await unlink(path.join(existingCreatorTwoDir, "_external-links.html")); } catch {}

const logs2 = [];
const result2 = await regen.regenerateExternalLinksFromDB({
  outDir: userDownloadsDir,
  log: (level, message) => {
    logs2.push(`[${level}] ${message}`);
  }
});
console.log("\n--- regen log (with existing campaign dirs) ---");
logs2.forEach((l) => console.log(l));
console.log("--- end log ---\n");

console.log("Regen result 2:", result2);
if (result2.campaignsScanned !== 2) throw new Error(`Run 2: expected 2 campaigns scanned, got ${result2.campaignsScanned}`);
if (result2.filesWritten !== 2) throw new Error(`Run 2: expected 2 files written, got ${result2.filesWritten}`);
if (result2.errors.length !== 0) throw new Error(`Run 2 errors: ${result2.errors.join("; ")}`);

// The regen should have re-created the files INSIDE the existing dirs.
const h1 = await readFile(path.join(existingCreatorOneDir, "_external-links.html"), "utf-8");
const h2 = await readFile(path.join(existingCreatorTwoDir, "_external-links.html"), "utf-8");
if (!h1.includes("CreatorOne")) throw new Error("Run 2: CreatorOne file content missing");
if (!h2.includes("CreatorTwo")) throw new Error("Run 2: CreatorTwo file content missing");
console.log("PASS: regen writes into existing campaign dirs (not creating new ones)");

// 5. Verify the files exist on disk at expected paths.
const fs = await import("node:fs/promises");
const topDirs = (await fs.readdir(userDownloadsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && e.name !== ".patreon-dl")
  .map((e) => e.name);
console.log("Top-level campaign dirs created:", topDirs);

let foundFiles = 0;
let html1 = null, html2 = null;
for (const d of topDirs) {
  const f = path.join(userDownloadsDir, d, "_external-links.html");
  try {
    const h = await readFile(f, "utf-8");
    foundFiles++;
    if (h.includes("CreatorOne")) html1 = h;
    if (h.includes("CreatorTwo")) html2 = h;
  } catch {}
}
if (foundFiles !== 2) throw new Error(`Expected 2 files on disk, found ${foundFiles}`);
console.log("PASS: both _external-links.html files exist on disk");

// 6. Validate contents of the CreatorOne file (should have 2 posts, 3 links).
const mustContain1 = [
  "CreatorOne",
  "Mod Pack A",
  "Hair Pack",
  // post 3 (no links) should NOT appear
  // "Just an update",
  "https://drive.google.com/file/d/AAA",
  "https://simfileshare.net/download/999",
  "https://drive.google.com/folder/BBB"
];
const mustNotContain1 = [
  "Just an update",
  "CreatorTwo"
];
for (const c of mustContain1) {
  if (!html1.includes(c)) throw new Error(`CreatorOne file missing: ${c}`);
  console.log("  PASS contains:", c);
}
for (const c of mustNotContain1) {
  if (html1.includes(c)) throw new Error(`CreatorOne file should NOT contain: ${c}`);
  console.log("  PASS excludes:", c);
}

// 7. Validate CreatorTwo (1 post, 1 link).
const mustContain2 = ["CreatorTwo", "Mega", "https://mega.nz/file/CCC"];
for (const c of mustContain2) {
  if (!html2.includes(c)) throw new Error(`CreatorTwo file missing: ${c}`);
  console.log("  PASS contains:", c);
}

// 8. Verify the existing reader (util/ExternalLinks.ts) can parse what
// the regen produced — that's what the GUI's "External Links" tab uses.
const readerSrc = path.join(repoRoot, "src/main/util/ExternalLinks.ts");
const readerOutDir = path.join(tmp, "reader-compiled");
await mkdir(readerOutDir, { recursive: true });
try {
  await import("node:fs/promises").then((m) =>
    m.symlink(path.join(repoRoot, "node_modules"), path.join(readerOutDir, "node_modules"), "dir")
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
const groups = await reader.findExternalLinks(userDownloadsDir);
console.log("\nReader findExternalLinks result:", JSON.stringify(groups, null, 2));
if (groups.length !== 2) throw new Error(`Expected 2 groups, got ${groups.length}`);
const one = groups.find((g) => g.source.includes("CreatorOne"));
const two = groups.find((g) => g.source.includes("CreatorTwo"));
if (!one || !two) throw new Error("Reader did not find both campaign groups");
if (one.links.length !== 2) throw new Error(`CreatorOne: expected 2 post entries, got ${one.links.length}`);
if (two.links.length !== 1) throw new Error(`CreatorTwo: expected 1 post entry, got ${two.links.length}`);
console.log("PASS: GUI reader correctly parses regen output");

console.log("\n=== REGEN END-TO-END TEST PASSED ===");
console.log("A real patreon-dl DB was built, the regen function read it without");
console.log("re-downloading anything, wrote correct _external-links.html files,");
console.log("and the GUI's existing reader can parse the output.\n");

await rm(tmp, { recursive: true, force: true });
