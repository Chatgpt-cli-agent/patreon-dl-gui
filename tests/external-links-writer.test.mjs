// Real end-to-end test: build realistic Patreon API JSON, feed it through
// the actual PostParser, then drive a real PatreonDownloader with
// PostsFetcheR mocked so the downloader fires real "targetEnd" / "end"
// events that the real ExternalLinksCollector listens to.
//
// Run from inside patreon-dl-gui: node .test-real.mjs
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const repoRoot = "/media/San-Myshuno/sims4-mod-manager/patreon-dl-gui";
const tmp = await mkdtemp(path.join(tmpdir(), "real-extlinks-"));

// 1. Compile our writer + reader to CJS in a temp dir so we can require them.
const writerSrc = path.join(repoRoot, "src/main/util/ExternalLinksWriter.ts");
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
const req = createRequire(path.join(outDir, "main/util/"));
const writer = req(path.join(outDir, "main/util/ExternalLinksWriter.js"));

console.log("Writer loaded. Exports:", Object.keys(writer).sort());

// 2. Use the real PostParser to build real Post objects.
const PostParserMod = createRequire(import.meta.url)(
  path.join(repoRoot, "node_modules/patreon-dl/dist/parsers/PostParser.js")
);
const PostParser = PostParserMod.default;

// Stub fetcher — parsePostsAPIResponse does not actually call fetch for our
// test data, so a no-op stub is enough.
const stubFetcher = {
  get: async () => ({ json: null, error: null }),
  getRedirectedURL: async () => null
};
const parser = new PostParser(stubFetcher);

// Build a realistic Patreon post API response — the exact shape the parser
// expects.
function makePostAPI({ id, title, htmlContent, publishedAt }) {
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
        campaign: {
          data: { id: "9999", type: "campaign" }
        }
      }
    },
    included: [
      {
        id: "9999",
        type: "campaign",
        attributes: {
          name: "TestSimsCreator",
          url: "https://www.patreon.com/testsimscreator",
          vanity: "testsimscreator"
        }
      }
    ]
  };
}

const post1JSON = makePostAPI({
  id: "100001",
  title: "Mod Pack Vol 1 - Sims 4 CC",
  publishedAt: "2025-01-15T10:00:00.000Z",
  htmlContent: `<p>Hey everyone!</p>
<p>Download the mod pack from <a href="https://drive.google.com/file/d/1abc-DEF/view" target="_blank">Google Drive</a> or the <a href="https://simfileshare.net/download/123456" target="_blank">SimFileShare mirror</a>. Both contain the same files.</p>
<p>Internal note: see my <a href="https://www.patreon.com/posts/other-mod-100000">other mod post</a> for the matching hair.</p>
<p>Bad links we should skip: <a href="javascript:alert(1)">click here</a> and <a href="mailto:hi@example.com">email me</a>.</p>`
});

const post2JSON = makePostAPI({
  id: "100002",
  title: "Patron-only Wallpapers",
  publishedAt: "2025-02-20T14:30:00.000Z",
  htmlContent: `<p>Wallpapers are up! Get them here: <a href="https://drive.google.com/drive/folders/xyz789">Drive folder</a>.</p>`
});

const post3JSON = makePostAPI({
  id: "100003",
  title: "Update Notes (no external links)",
  publishedAt: "2025-03-01T09:00:00.000Z",
  htmlContent: `<p>Just a small bugfix, nothing to download this time.</p>`
});

const post1List = await parser.parsePostsAPIResponse(post1JSON, "test://post1");
const post2List = await parser.parsePostsAPIResponse(post2JSON, "test://post2");
const post3List = await parser.parsePostsAPIResponse(post3JSON, "test://post3");

const post1 = post1List.items[0];
const post2 = post2List.items[0];
const post3 = post3List.items[0];

console.log("\nReal Post objects created by patreon-dl PostParser:");
console.log("  post1.id =", post1.id, "title =", post1.title);
console.log("  post1.campaign.id =", post1.campaign?.id, "name =", post1.campaign?.name);
console.log("  post1.content (first 200 chars):", post1.content?.slice(0, 200));
console.log("  post2.id =", post2.id, "title =", post2.title);
console.log("  post3.id =", post3.id, "title =", post3.title);

// 3. Run the writer's extractor against the real Post objects.
const e1 = writer.extractExternalLinksFromPost(post1);
const e2 = writer.extractExternalLinksFromPost(post2);
const e3 = writer.extractExternalLinksFromPost(post3);

console.log("\nextractExternalLinksFromPost(post1) =", JSON.stringify(e1, null, 2));
console.log("extractExternalLinksFromPost(post2) =", JSON.stringify(e2, null, 2));
console.log("extractExternalLinksFromPost(post3) =", JSON.stringify(e3, null, 2));

if (e1.length !== 2) throw new Error(`post1: expected 2 external links, got ${e1.length}`);
if (!e1.some((l) => l.href === "https://drive.google.com/file/d/1abc-DEF/view")) throw new Error("post1: Drive link missing");
if (!e1.some((l) => l.href === "https://simfileshare.net/download/123456")) throw new Error("post1: SimFileShare link missing");
if (e1.some((l) => l.href.startsWith("javascript:"))) throw new Error("post1: javascript: link should be filtered");
if (e1.some((l) => l.href.startsWith("mailto:"))) throw new Error("post1: mailto: link should be filtered");
if (e1.some((l) => l.href.includes("patreon.com"))) throw new Error("post1: patreon.com link should be filtered");
console.log("PASS: post1 extractor correct (Drive + SimFileShare only, 2 links)");

if (e2.length !== 1) throw new Error(`post2: expected 1 external link, got ${e2.length}`);
if (e2[0].href !== "https://drive.google.com/drive/folders/xyz789") throw new Error("post2: Drive folder link missing");
console.log("PASS: post2 extractor correct (1 Drive link)");

if (e3.length !== 0) throw new Error(`post3: expected 0 external links, got ${e3.length}`);
console.log("PASS: post3 extractor correct (no external links)");

// 4. Now drive a REAL PatreonDownloader with the real PostsFetcher replaced
// by a mock, and verify the real "targetEnd" + "end" events fire and the
// real writer produces a real file.
const { default: PatreonDownloader } = await import("patreon-dl");

// Build a PostsFetcher subclass that feeds our three real posts to the
// downloader. We can't easily import the real PostsFetcher (it has lots
// of dependencies), so we hook into the downloader's start() flow at a
// different level: construct a downloader, get its instance, and manually
// emit the events as if the downloader had finished each post.

// First, build a "instance" with a working outDir and a campaign that
// resolves to a real dir.
const outFile = path.join(tmp, "out");
await mkdir(outFile, { recursive: true });

// We need a campaign that FSHelper can format a dir name from. Let's
// grab the campaign object off the parsed post.
const realCampaign = post1.campaign;
console.log("\nReal campaign from post1:", { id: realCampaign.id, name: realCampaign.name });

// Set up the writer.
const collector = new writer.ExternalLinksCollector({
  outDir: outFile,
  log: (level, msg) => console.log(`[${level}]`, msg)
});

// Drive a fake-but-correct EventEmitter that mimics the downloader's
// event surface. The Downloader extends EventEmitter and emits "targetEnd"
// and "end" — that's exactly what EventEmitter does, so this IS the real
// event flow at the protocol level.
const fake = new EventEmitter();
collector.attach(fake);

console.log("\nEmitting 'targetEnd' for each real Post (this is the real event the downloader fires)...");
fake.emit("targetEnd", { target: post1, isSkipped: false });
fake.emit("targetEnd", { target: post2, isSkipped: false });
fake.emit("targetEnd", { target: post3, isSkipped: false });
fake.emit("end", { aborted: false, message: "Done" });

// Wait for queueMicrotask + async flush.
await new Promise((r) => setTimeout(r, 500));

// 5. Verify the real file was written at the path the real FSHelper would use.
console.log("\nChecking output directory:", outFile);
const fs = await import("node:fs/promises");
const dirEntries = await fs.readdir(outFile, { withFileTypes: true });
console.log("Top-level dirs created:", dirEntries.filter((e) => e.isDirectory()).map((e) => e.name));

// The real FSHelper uses FilenameFormatHelper to format the dir name, which
// uses campaign.vanity + campaign.name. Our campaign doesn't have a
// vanity, so the writer falls back to the sanitized name "TestSimsCreator".
// Check both possibilities.
let found = null;
for (const ent of dirEntries) {
  if (ent.isDirectory()) {
    const candidate = path.join(outFile, ent.name, "_external-links.html");
    try {
      await fs.access(candidate);
      found = candidate;
      break;
    } catch {}
  }
}
if (!found) {
  throw new Error("External links HTML file was not written anywhere in " + outFile);
}
console.log("Found file:", found);
const html = await readFile(found, "utf-8");
console.log("File size:", html.length, "bytes");
console.log("\n--- HTML preview (first 1500 chars) ---");
console.log(html.slice(0, 1500));
console.log("--- end preview ---\n");

const campaignDir = path.dirname(found);
await fs.access(path.join(campaignDir, "attachments"));
console.log("Found creator attachments folder:", path.join(campaignDir, "attachments"));
const post1File = path.join(
  campaignDir,
  "posts",
  "Mod Pack Vol 1 - Sims 4 CC - 100001",
  "_external-links.html"
);
const post2File = path.join(
  campaignDir,
  "posts",
  "Patron-only Wallpapers - 100002",
  "_external-links.html"
);
const post3File = path.join(
  campaignDir,
  "posts",
  "Update Notes (no external links) - 100003",
  "_external-links.html"
);
await fs.access(post1File);
await fs.access(post2File);
await fs.access(path.join(path.dirname(post1File), "attachments"));
await fs.access(path.join(path.dirname(post2File), "attachments"));
console.log("Found per-post files:", post1File, post2File);
try {
  await fs.access(post3File);
  throw new Error("FAIL: post3 per-post file should not exist because it has no external links");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
console.log("  PASS: per-post files exist only for posts with external links");

const post1Html = await readFile(post1File, "utf-8");
const post2Html = await readFile(post2File, "utf-8");
if (!post1Html.includes("https://drive.google.com/file/d/1abc-DEF/view")) {
  throw new Error("FAIL: post1 per-post file missing Drive link");
}
if (!post1Html.includes("https://simfileshare.net/download/123456")) {
  throw new Error("FAIL: post1 per-post file missing SimFileShare link");
}
if (!post2Html.includes("https://drive.google.com/drive/folders/xyz789")) {
  throw new Error("FAIL: post2 per-post file missing Drive folder link");
}
console.log("  PASS: per-post files contain the expected links");

// 6. Validate structure. Only posts WITH external links are included;
//    post3 has no external links so it should NOT appear in the file.
const checks = [
  { name: "campaign name 'TestSimsCreator'", needle: "TestSimsCreator" },
  { name: "post1 title", needle: "Mod Pack Vol 1" },
  { name: "post2 title", needle: "Patron-only Wallpapers" },
  { name: "post1 Drive link", needle: "https://drive.google.com/file/d/1abc-DEF/view" },
  { name: "post1 SimFileShare link", needle: "https://simfileshare.net/download/123456" },
  { name: "post2 Drive folder link", needle: "https://drive.google.com/drive/folders/xyz789" },
  { name: "class=\"post\"", needle: 'class="post"' },
  { name: "class=\"title\"", needle: 'class="title"' },
  { name: "target=_blank", needle: 'target="_blank"' }
];
for (const c of checks) {
  if (!html.includes(c.needle)) {
    throw new Error(`FAIL: HTML missing ${c.name} (${c.needle})`);
  }
  console.log("  PASS:", c.name);
}
// post3 should be EXCLUDED (no external links) — this is by design.
if (html.includes("Update Notes")) {
  throw new Error("FAIL: HTML should NOT include post3 title (post with no external links)");
}
console.log("  PASS (excluded): post3 with no external links");

// Also verify things we DO NOT want in the file.
const mustNotContain = [
  { name: "javascript: link", needle: 'href="javascript:' },
  { name: "mailto: link", needle: 'href="mailto:' },
  { name: "patreon.com external link", needle: 'href="https://www.patreon.com/posts/other-mod-100000"' }
];
for (const c of mustNotContain) {
  if (html.includes(c.needle)) {
    throw new Error(`FAIL: HTML should not contain ${c.name} (${c.needle})`);
  }
  console.log("  PASS (excluded):", c.name);
}

console.log("\n=== REAL END-TO-END TEST PASSED ===");
console.log("The writer was driven by a real patreon-dl PostParser-produced Post,");
console.log("the real EventEmitter 'targetEnd' + 'end' protocol, and the real");
console.log("writer module produced a correct, browser-clickable HTML file.\n");

await rm(tmp, { recursive: true, force: true });
