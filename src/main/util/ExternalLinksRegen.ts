import type { Campaign, Post } from "patreon-dl";
import DatabaseCtor from "better-sqlite3";
import { readdir, stat } from "fs/promises";
import path from "path";
import { getErrorString } from "../../common/util/Misc";
import {
  EXTERNAL_LINKS_FILE_NAME,
  extractExternalLinksFromPost,
  renderExternalLinksHTML
} from "./ExternalLinksWriter";

const DEFAULT_CAMPAIGN_DIR_NAME_FORMAT = "{creator.name}";

interface DBInstanceLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

export interface RegenerateOptions {
  outDir: string;
  /** Format string used by the downloader for campaign dir names. The
   *  default matches the app default. Currently unused — dir
   *  matching is done by scanning for existing on-disk campaign dirs
   *  that contain a `posts/` subdir. Kept for future use. */
  campaignDirNameFormat?: string;
  /** Optional logger callback. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface RegenerateResult {
  campaignsScanned: number;
  postsScanned: number;
  filesWritten: number;
  filesSkipped: number;
  errors: string[];
}

interface CampaignWithPosts {
  campaign: Campaign;
  posts: Post[];
}

/**
 * Walk an existing patreon-dl download directory (i.e. a directory that
 * was previously used as the outDir for a download) and regenerate the
 * per-creator `_external-links.html` files by reading posts out of the
 * embedded SQLite database at `<outDir>/.patreon-dl/db.sqlite`.
 *
 * No network calls. No re-downloading. Pure read-from-disk + write-to-disk.
 *
 * Used by the GUI's "Scan existing downloads" button so users who finished
 * downloads before this feature shipped can still get their clickable
 * external-links page without re-running the downloader.
 */
export async function regenerateExternalLinksFromDB(
  opts: RegenerateOptions
): Promise<RegenerateResult> {
  const { outDir } = opts;
  const result: RegenerateResult = {
    campaignsScanned: 0,
    postsScanned: 0,
    filesWritten: 0,
    filesSkipped: 0,
    errors: []
  };

  if (!outDir) {
    opts.log?.("warn", "No output directory configured");
    return result;
  }

  // Open the patreon-dl database directly with better-sqlite3. We do NOT
  // go through patreon-dl's DB class because the package's "exports" field
  // does not permit importing its internal subpaths, and we don't need
  // any of its other mixins — only the content + campaign tables.
  // better-sqlite3 is declared as an external in vite.main.config.ts so
  // it stays as a native require at runtime.
  const dbPath = path.resolve(outDir, ".patreon-dl", "db.sqlite");
  try {
    await stat(dbPath);
  } catch {
    opts.log?.(
      "warn",
      `No patreon-dl database found at ${dbPath} — nothing to scan`
    );
    return result;
  }

  let db: DBInstanceLike | null = null;
  try {
    db = new DatabaseCtor(dbPath);
    const groups = readCampaignsWithPosts(db);
    opts.log?.(
      "info",
      `Found ${groups.length} campaign(s) in ${dbPath}`
    );

    const existingDirsByCampaignId = await mapExistingCampaignDirs(
      outDir,
      groups.map((g) => g.campaign)
    );

    for (const group of groups) {
      result.campaignsScanned++;
      result.postsScanned += group.posts.length;
      const collected: Array<{ post: Post; links: ReturnType<typeof extractExternalLinksFromPost> }> = [];
      for (const post of group.posts) {
        const links = extractExternalLinksFromPost(post);
        if (links.length > 0) {
          collected.push({ post, links });
        }
      }
      if (collected.length === 0) {
        result.filesSkipped++;
        opts.log?.(
          "info",
          `Campaign ${group.campaign.name || group.campaign.id}: no external links in any post, skipping`
        );
        continue;
      }
      const targetDir =
        existingDirsByCampaignId.get(group.campaign.id) ||
        path.resolve(outDir, sanitizeDirName(group.campaign));
      const targetFile = path.join(targetDir, EXTERNAL_LINKS_FILE_NAME);
      try {
        const html = renderExternalLinksHTML(group.campaign, collected);
        const { writeFile, ensureDir } = await import("fs-extra");
        await ensureDir(targetDir);
        await writeFile(targetFile, html, "utf-8");
        result.filesWritten++;
        opts.log?.(
          "info",
          `Wrote ${collected.length} post(s) of external links to ${targetFile}`
        );
      } catch (error: unknown) {
        result.errors.push(
          `Failed to write ${targetFile}: ${getErrorString(error)}`
        );
        opts.log?.(
          "error",
          `Failed to write ${targetFile}: ${getErrorString(error)}`
        );
      }
    }
  } catch (error: unknown) {
    const msg = getErrorString(error);
    result.errors.push(msg);
    opts.log?.("error", `Regeneration failed: ${msg}`);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  return result;
}

function sanitizeDirName(campaign: Campaign): string {
  // Best-effort mirror of the app's creator-folder format, used only as a
  // fallback when no matching on-disk dir is found.
  const name = campaign.name || `campaign-${campaign.id}`;
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

/**
 * Read all campaigns from the patreon-dl DB along with their posts.
 * Posts are returned in chronological order (oldest first).
 */
function readCampaignsWithPosts(
  db: DBInstanceLike
): CampaignWithPosts[] {
  const campaignRows = db
    .prepare(
      `SELECT campaign_id, details FROM campaign ORDER BY campaign_name COLLATE NOCASE`
    )
    .all() as Array<{ campaign_id: string; details: string }>;

  const postStmt = db.prepare(
    `SELECT content_id, details FROM content
       WHERE content_type = 'post' AND campaign_id = ?
       ORDER BY COALESCE(published_at, 0) ASC`
  );

  const groups: CampaignWithPosts[] = [];
  for (const row of campaignRows) {
    let campaign: Campaign;
    try {
      campaign = JSON.parse(row.details) as Campaign;
    } catch {
      continue;
    }
    if (!campaign || !campaign.id) {
      continue;
    }
    const postRows = postStmt.all(row.campaign_id) as Array<{
      content_id: string;
      details: string;
    }>;
    const posts: Post[] = [];
    for (const pr of postRows) {
      try {
        const parsed = JSON.parse(pr.details) as Post;
        if (parsed && parsed.id) {
          // Ensure the post has its campaign reference set so the writer
          // can group by it. The saved details usually already includes
          // it, but be defensive.
          if (!parsed.campaign) {
            parsed.campaign = campaign;
          }
          posts.push(parsed);
        }
      } catch {
        // Skip malformed post rows.
      }
    }
    if (posts.length > 0) {
      groups.push({ campaign, posts });
    }
  }
  return groups;
}

/**
 * For each campaign, find an existing on-disk directory under outDir that
 * looks like a patreon-dl campaign folder (contains a `posts/` subdir).
 * The matched dir is whichever name the user actually used at download
 * time, so writing back into it stays consistent.
 */
async function mapExistingCampaignDirs(
  outDir: string,
  campaigns: Campaign[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (campaigns.length === 0) {
    return map;
  }
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    const dirents = await readdir(outDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, isDirectory: () => true }));
  } catch {
    return map;
  }

  // For each dir, see if it contains a "posts" subdirectory (= a real
  // patreon-dl campaign dir).
  const candidates: string[] = [];
  for (const e of entries) {
    try {
      const sub = await stat(path.join(outDir, e.name, "posts"));
      if (sub.isDirectory()) {
        candidates.push(e.name);
      }
    } catch {
      // not a campaign dir
    }
  }
  if (candidates.length === 0) {
    return map;
  }

  // Try to find the existing _external-links.html inside each candidate,
  // because we can read its <h1>campaign name</h1> to match against the
  // campaign record. Failing that, fall back to a normalized name match.
  for (const c of candidates) {
    const linksFile = path.join(outDir, c, EXTERNAL_LINKS_FILE_NAME);
    let matched: Campaign | null = null;
    try {
      const { readFile } = await import("fs/promises");
      const html = await readFile(linksFile, "utf-8");
      const match = html.match(/<h1>([^<]+)<\/h1>/);
      if (match) {
        const headerName = match[1].trim();
        matched =
          campaigns.find(
            (cm) => (cm.name || "").trim() === headerName
          ) || null;
      }
    } catch {
      // no existing links file
    }
    if (!matched) {
      // Fall back to sanitized-name match.
      const sanitized = (name: string) =>
        name.replace(/[\\/:*?"<>|]/g, "_").trim();
      matched =
        campaigns.find((cm) => sanitized(cm.name || "") === c) || null;
    }
    if (matched) {
      map.set(matched.id, path.join(outDir, c));
    }
  }
  return map;
}

// Re-export the format constant for callers that want to display it.
export { DEFAULT_CAMPAIGN_DIR_NAME_FORMAT };
