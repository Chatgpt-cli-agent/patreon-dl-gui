import type { Campaign, Post } from "patreon-dl";
import { load as cheerioLoad } from "cheerio";
import { writeFile, ensureDir, readdir } from "fs-extra";
import path from "path";
import { getErrorString } from "../../common/util/Misc";

// Matches the constant used by util/ExternalLinks.ts (the reader).
export const EXTERNAL_LINKS_FILE_NAME = "_external-links.html";
export const POST_EXTERNAL_LINKS_FILE_NAME = "_external-links.html";
const ATTACHMENTS_DIR_NAME = "attachments";

const PATREON_HOSTS = new Set([
  "patreon.com",
  "www.patreon.com",
  "m.patreon.com"
]);

const TRACKING_PREFIXES = [
  "javascript:",
  "mailto:",
  "tel:",
  "#"
];

interface ExtractedLink {
  text: string;
  href: string;
}

interface CollectedPost {
  post: Post;
  links: ExtractedLink[];
}

export interface ExternalLinksCollectorOptions {
  /** Where to write the per-campaign _external-links.html. */
  outDir: string;
  /** Logger callback for status messages. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Minimal interface over a Patreon downloader for the parts this module
 * needs. Declared structurally (not via `extends`) because the real
 * `Downloader` has `protected` members we don't want to expose.
 */
interface DownloaderLike {
  on(event: "targetEnd", listener: (payload: TargetEndPayload) => void): unknown;
  on(event: "end", listener: (payload: unknown) => void): unknown;
  removeListener(event: "targetEnd", listener: (payload: TargetEndPayload) => void): unknown;
  removeListener(event: "end", listener: (payload: unknown) => void): unknown;
}

interface TargetEndPayload {
  target: Campaign | Post | { type: string };
  isSkipped?: boolean;
}

/**
 * Subscribes to a Patreon downloader instance and, after each post finishes
 * downloading, extracts all non-Patreon links from the post's HTML content.
 * When the downloader emits its "end" event (success, abort, or error), the
 * collected links are written to `<campaign>/_external-links.html` so the
 * GUI's External Links tab (and any external file manager) can browse them.
 */
export class ExternalLinksCollector {
  #opts: ExternalLinksCollectorOptions;
  #collected: Map<string, CollectedPost[]> = new Map();
  #listeners: Array<() => void> = [];
  #flushed = false;

  constructor(opts: ExternalLinksCollectorOptions) {
    this.#opts = opts;
  }

  attach(downloader: DownloaderLike): () => void {
    const onTargetEnd = (payload: TargetEndPayload) => {
      // Only care about Post targets (skip Campaign, Collection, Product).
      if (!payload || payload.target?.type !== "post") {
        return;
      }
      const post = payload.target as Post;
      if (post.campaign) {
        this.#collectFromPost(post);
      }
    };

    const onEnd = () => {
      // Defer one microtask so any final targetEnd from the same tick is
      // processed first.
      queueMicrotask(() => {
        void this.#flush();
      });
    };

    downloader.on("targetEnd", onTargetEnd);
    downloader.on("end", onEnd);

    const teardown = () => {
      try {
        downloader.removeListener("targetEnd", onTargetEnd);
      } catch {
        // ignore
      }
      try {
        downloader.removeListener("end", onEnd);
      } catch {
        // ignore
      }
    };
    this.#listeners.push(teardown);
    return teardown;
  }

  detachAll(): void {
    for (const teardown of this.#listeners) {
      try {
        teardown();
      } catch {
        // ignore
      }
    }
    this.#listeners = [];
  }

  /** Test-only: snapshot of collected posts per campaign id. */
  snapshot(): Map<string, CollectedPost[]> {
    return new Map(this.#collected);
  }

  /** Manually trigger a flush (mostly for tests). */
  async flushNow(): Promise<void> {
    await this.#flush();
  }

  #collectFromPost(post: Post) {
    if (!post.campaign) {
      return;
    }
    const campaignId = post.campaign.id;
    const links = extractExternalLinksFromPost(post);
    if (links.length === 0) {
      return;
    }
    const bucket = this.#collected.get(campaignId) || [];
    bucket.push({ post, links });
    this.#collected.set(campaignId, bucket);
    this.#opts.log?.(
      "info",
      `Collected ${links.length} external link(s) from post #${post.id} (${post.title ?? "Untitled"})`
    );
  }

  async #flush(): Promise<void> {
    if (this.#flushed) {
      return;
    }
    this.#flushed = true;
    for (const [campaignId, posts] of this.#collected) {
      const first = posts[0]?.post;
      const campaign = first?.campaign;
      if (!campaign) {
        continue;
      }
      try {
        const campaignDir = this.#computeCampaignDir(campaign);
        await ensureDir(path.resolve(campaignDir, ATTACHMENTS_DIR_NAME));
        const filePath = path.resolve(campaignDir, EXTERNAL_LINKS_FILE_NAME);
        const html = renderExternalLinksHTML(campaign, posts);
        await ensureDir(path.dirname(filePath));
        await writeFile(filePath, html, "utf-8");
        const totalLinks = posts.reduce((sum, p) => sum + p.links.length, 0);
        this.#opts.log?.(
          "info",
          `Wrote ${totalLinks} external link(s) across ${posts.length} post(s) to ${filePath}`
        );
        for (const entry of posts) {
          const postFilePath = await this.#computePostLinksPath(
            campaign,
            entry.post
          );
          await ensureDir(path.dirname(postFilePath));
          await writeFile(
            postFilePath,
            renderPostExternalLinksHTML(campaign, entry.post, entry.links),
            "utf-8"
          );
        }
      } catch (error: unknown) {
        this.#opts.log?.(
          "error",
          `Could not write external-links file for campaign ${campaignId}: ${getErrorString(error)}`
        );
      }
    }
  }

  #computeCampaignLinksPath(campaign: Campaign): string {
    // Mirror FSHelper.getCampaignDirs() layout: outDir / <campaign dir name> / _external-links.html
    return path.resolve(this.#computeCampaignDir(campaign), EXTERNAL_LINKS_FILE_NAME);
  }

  #computeCampaignDir(campaign: Campaign): string {
    const name = sanitizeForPath(campaign.name) || `campaign-${campaign.id}`;
    const vanity = sanitizeForPath(campaign.creator?.vanity || "");
    const campaignDirName = vanity ? `${vanity} - ${name}` : name;
    return path.resolve(this.#opts.outDir, campaignDirName);
  }

  async #computePostLinksPath(campaign: Campaign, post: Post): Promise<string> {
    const postsDir = path.resolve(this.#computeCampaignDir(campaign), "posts");
    const postId = String(post.id);
    try {
      const entries = await readdir(postsDir, { withFileTypes: true });
      const match = entries.find(
        (entry) =>
          entry.isDirectory() &&
          (entry.name.endsWith(` - ${postId}`) ||
            entry.name.startsWith(`${postId} - `))
      );
      if (match) {
        const postDir = path.resolve(postsDir, match.name);
        await ensureDir(path.resolve(postDir, ATTACHMENTS_DIR_NAME));
        return path.resolve(postDir, POST_EXTERNAL_LINKS_FILE_NAME);
      }
    } catch {
      // Fall back below.
    }
    const title =
      sanitizeForPath(cleanContentNameForDir(post.title || "")) ||
      `post-${postId}`;
    const fallbackDir = path.resolve(postsDir, `${title} - ${postId}`);
    await ensureDir(path.resolve(fallbackDir, ATTACHMENTS_DIR_NAME));
    return path.resolve(fallbackDir, POST_EXTERNAL_LINKS_FILE_NAME);
  }
}

/**
 * Parse a post's HTML content and return every anchor that points to a
 * non-Patreon, non-tracking URL. The first link in a post's body is usually
 * the external link the creator wants fans to follow (Drive, SimFileShare,
 * etc.), but we collect *all* of them so nothing gets missed.
 */
export function extractExternalLinksFromPost(post: Post): ExtractedLink[] {
  const html = (post.content ?? post.contentText ?? "") as string;
  if (!html) {
    return [];
  }
  const $ = cheerioLoad(html);
  const seen = new Set<string>();
  const results: ExtractedLink[] = [];

  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") || "").trim();
    if (!href) {
      return;
    }
    if (TRACKING_PREFIXES.some((p) => href.startsWith(p))) {
      return;
    }
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      // Skip malformed URLs (relative refs, etc.)
      return;
    }
    if (PATREON_HOSTS.has(url.hostname.toLowerCase())) {
      return;
    }
    if (seen.has(url.href)) {
      return;
    }
    seen.add(url.href);
    const text = $(element).text().trim() || url.href;
    results.push({ text: truncate(text, 200), href: url.href });
  });

  return results;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, max - 1) + "\u2026";
}

function sanitizeForPath(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function cleanContentNameForDir(name: string): string {
  return (
    name
      .replace(/^\s*[\[(]?\s*download\s*[\])]?[\s:._-]*/i, "")
      .replace(/\s*[\[(]\s*download\s*[\])]\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || name
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCampaignName(campaign: Campaign): string {
  return campaign.name || `Campaign #${campaign.id}`;
}

function getCampaignURL(campaign: Campaign): string {
  const rawCampaign = campaign as Campaign & {
    url?: string;
    vanity?: string;
    creator?: { vanity?: string };
  };
  const directURL = rawCampaign.url;
  if (directURL) {
    return directURL;
  }
  const vanity = rawCampaign.creator?.vanity || rawCampaign.vanity || "";
  if (vanity) {
    return `https://www.patreon.com/${vanity}`;
  }
  return `https://www.patreon.com/campaigns/${campaign.id}`;
}

/**
 * Render the clickable HTML file. The structure mirrors what the reader
 * (util/ExternalLinks.ts) expects:
 *   - each post is a <div class="post">
 *   - its title is in <span class="title">
 *   - the first <a href> in each post is the "primary" link
 * but we also include every additional link underneath so the file is
 * self-contained and can be opened in any browser.
 */
export function renderExternalLinksHTML(
  campaign: Campaign,
  posts: CollectedPost[]
): string {
  // Posts in chronological order (oldest first) matches what a creator
  // typically wants to browse.
  const sorted = [...posts].sort((a, b) => {
    const at = a.post.publishedAt ? Date.parse(a.post.publishedAt) : 0;
    const bt = b.post.publishedAt ? Date.parse(b.post.publishedAt) : 0;
    return at - bt;
  });

  const postBlocks = sorted
    .map((entry) => {
      const { post, links } = entry;
      const postTitle = cleanContentNameForDir(
        post.title || `Post #${post.id}`
      );
      const postHref = post.url || `https://www.patreon.com/posts/${post.id}`;
      const published = post.publishedAt
        ? new Date(post.publishedAt).toISOString().slice(0, 10)
        : "";
      const linkItems = links
        .map(
          (link) =>
            `<li class="link"><a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.text)}</a><div class="url">${escapeHtml(link.href)}</div></li>`
        )
        .join("\n");
      return `<section class="post">
  <div class="creator-line">Creator: <a href="${escapeHtml(getCampaignURL(campaign))}" target="_blank" rel="noopener noreferrer">${escapeHtml(getCampaignName(campaign))}</a></div>
  <a class="title" href="${escapeHtml(postHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(postTitle)}</a>
  <div class="meta">${published ? `${escapeHtml(published)} · ` : ""}Post #${escapeHtml(String(post.id))}</div>
  <ul class="links">
${linkItems}
  </ul>
</section>`;
    })
    .join("\n");

  const campaignName = getCampaignName(campaign);
  const campaignURL = getCampaignURL(campaign);
  const totalLinks = sorted.reduce((sum, p) => sum + p.links.length, 0);
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(campaignName)} \u2014 External Links</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 1.5rem auto; padding: 0 1rem; color: #e5e7eb; background: #101114; }
    h1 { margin-bottom: 0.25rem; }
    .creator { border: 1px solid #30343b; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: #181b20; }
    .creator .label { color: #9ca3af; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .creator a { color: #7dd3fc; text-decoration: none; word-break: break-all; }
    .creator a:hover { text-decoration: underline; }
    .summary { color: #9ca3af; margin-bottom: 1.5rem; }
    .post { background: #191b20; border: 1px solid #2e323a; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .creator-line { color: #9ca3af; font-size: 0.82rem; margin-bottom: 0.35rem; }
    .creator-line a { color: #bae6fd; text-decoration: none; }
    .post a.title { display: block; font-size: 1.05rem; font-weight: 650; color: #7dd3fc; text-decoration: none; margin-bottom: 0.25rem; }
    .post a.title:hover { text-decoration: underline; }
    .post .meta { color: #9ca3af; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .post ul.links { list-style: none; padding-left: 0; margin: 0.5rem 0 0; }
    .post ul.links li.link { padding: 0.45rem 0; border-top: 1px solid #2e323a; }
    .post ul.links li.link:first-child { border-top: none; }
    .post ul.links a { color: #93c5fd; text-decoration: none; word-break: break-word; }
    .post ul.links a:hover { text-decoration: underline; }
    .post ul.links .url { color: #7c8491; font-size: 0.8rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; margin-top: 0.15rem; }
    footer { color: #6b7280; font-size: 0.8rem; margin-top: 2rem; text-align: center; }
  </style>
</head>
<body>
  <h1>${escapeHtml(campaignName)}</h1>
  <section class="creator">
    <div class="label">Creator Source</div>
    <div><a href="${escapeHtml(campaignURL)}" target="_blank" rel="noopener noreferrer">${escapeHtml(campaignURL)}</a></div>
    <div class="summary">Campaign ID ${escapeHtml(String(campaign.id))}</div>
  </section>
  <div class="summary">${totalLinks} external link(s) across ${sorted.length} post(s). Generated ${escapeHtml(generatedAt)}.</div>
  ${postBlocks || "<p><em>No external links found.</em></p>"}
  <footer>patreon-dl-gui &middot; external-links report</footer>
</body>
</html>
`;
}

export function renderPostExternalLinksHTML(
  campaign: Campaign,
  post: Post,
  links: ExtractedLink[]
): string {
  return renderExternalLinksHTML(campaign, [{ post, links }]);
}
