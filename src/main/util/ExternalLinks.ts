// This file used to contain a reader for `_external-links.html` files
// inside an outDir. The new flow is user-driven (see ExternalLinksExporter)
// and does not write files into the outDir by default, so the reader is
// no longer needed by the app. It is kept here as a thin re-export so
// external code (and tests) that import it still get a working
// `findExternalLinks` function.
import { readdir, readFile } from "fs/promises";
import path from "path";
import * as cheerio from "cheerio";
import { getErrorString } from "../../common/util/Misc";

const EXTERNAL_LINKS_FILE_NAME = "_external-links.html";

interface LegacyExternalLink {
  title: string;
  url: string;
}

interface LegacyExternalLinkGroup {
  source: string;
  links: LegacyExternalLink[];
}

export async function findExternalLinks(
  outDir: string
): Promise<LegacyExternalLinkGroup[]> {
  if (!outDir) {
    return [];
  }
  const groups: LegacyExternalLinkGroup[] = [];
  try {
    const entries = await readdir(outDir, {
      withFileTypes: true,
      recursive: true
    });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.toLowerCase() === EXTERNAL_LINKS_FILE_NAME
      ) {
        const filePath = path.join(entry.parentPath, entry.name);
        const links = await parseExternalLinksFile(filePath);
        if (links.length > 0) {
          groups.push({
            source: path.relative(outDir, filePath),
            links
          });
        }
      }
    }
  } catch (error: unknown) {
    console.error(
      `Could not scan external links in "${outDir}": ${getErrorString(error)}`
    );
  }
  return groups.sort((a, b) => a.source.localeCompare(b.source));
}

async function parseExternalLinksFile(
  filePath: string
): Promise<LegacyExternalLink[]> {
  try {
    const html = await readFile(filePath, "utf-8");
    const $ = cheerio.load(html);
    const links: LegacyExternalLink[] = [];
    $(".post").each((_, element) => {
      const post = $(element);
      const title = post.find(".title").first().text().trim();
      const url = post.find("a").first().attr("href");
      if (url) {
        links.push({
          title: title || "Untitled",
          url
        });
      }
    });
    return links;
  } catch (error: unknown) {
    console.error(
      `Could not parse external links file "${filePath}": ${getErrorString(error)}`
    );
    return [];
  }
}
