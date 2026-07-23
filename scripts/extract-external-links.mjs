#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load as loadHtml } from "cheerio";

const DEFAULT_OUTPUT_FILE = "external-links-urls.txt";

function printUsage() {
  console.log(`Usage:
  node scripts/extract-external-links.mjs <folder> [--out <file>] [--json]

Examples:
  node scripts/extract-external-links.mjs "C:\\Patreon Downloads"
  node scripts/extract-external-links.mjs /downloads --out /downloads/external-links-urls.txt
  aria2c -i external-links-urls.txt -d /downloads/external-files

The input folder can be either the main patreon-dl-gui output folder or the
folder where you saved *_external-links.html exports.`);
}

function parseArgs(argv) {
  const args = {
    folder: "",
    outFile: "",
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--out" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a file path`);
      }
      args.outFile = value;
      i += 1;
    } else if (!args.folder) {
      args.folder = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function isExternalLinksReport(filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  return (
    fileName === "_external-links.html" ||
    fileName.endsWith("_external-links.html")
  );
}

function extractDownloadLinks(html, sourceFile) {
  const $ = loadHtml(html);
  const links = [];

  $(".post ul.links li.link a[href], .post li.link a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) {
      return;
    }
    try {
      const url = new URL(href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return;
      }
      links.push({
        url: url.href,
        text: $(el).text().trim(),
        sourceFile
      });
    } catch {
      // Ignore malformed or relative links.
    }
  });

  return links;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.folder) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const root = path.resolve(args.folder);
  const outFile = path.resolve(args.outFile || DEFAULT_OUTPUT_FILE);
  const seen = new Set();
  const links = [];
  let reportCount = 0;

  for await (const filePath of walk(root)) {
    if (!isExternalLinksReport(filePath)) {
      continue;
    }
    reportCount += 1;
    const html = await readFile(filePath, "utf8");
    for (const link of extractDownloadLinks(html, filePath)) {
      if (seen.has(link.url)) {
        continue;
      }
      seen.add(link.url);
      links.push(link);
    }
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    `${links.map((link) => link.url).join("\n")}${links.length ? "\n" : ""}`,
    "utf8"
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          inputFolder: root,
          outputFile: outFile,
          reportsScanned: reportCount,
          linksWritten: links.length,
          links
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Scanned ${reportCount} external-links report(s).`);
  console.log(`Wrote ${links.length} unique URL(s) to ${outFile}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
