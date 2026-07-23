// User-driven external-links exporter: reads the patreon-dl SQLite
// database at <outDir>/.patreon-dl/db.sqlite, lets the caller pick which
// creators to include, and writes one HTML file per selected creator
// into a folder the caller picks.
//
// No automatic writes during a download run — this module is only
// invoked when the user clicks "Create external-links file(s)" in the
// External Links tab.

import DatabaseCtor from "better-sqlite3";
import { writeFile, ensureDir } from "fs-extra";
import path from "path";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import type { Campaign, Post } from "patreon-dl";
import { getErrorString } from "../../common/util/Misc";
import {
  POST_EXTERNAL_LINKS_FILE_NAME,
  extractExternalLinksFromPost,
  renderExternalLinksHTML,
  renderPostExternalLinksHTML
} from "./ExternalLinksWriter";

const ATTACHMENTS_DIR_NAME = "attachments";

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getAllowedRemovalRoots(outDir: string, targetFolder?: string | null): string[] {
  const candidates = [outDir, targetFolder].filter(
    (value): value is string => Boolean(value && String(value).trim())
  );
  const normalizedRoots = candidates.map((candidate) => path.resolve(candidate));
  return [...new Set(normalizedRoots)];
}

function resolveManagedRemovalPath(filePath: string, allowedRoots: string[]): string | null {
  const resolvedPath = path.resolve(filePath);
  const insideAllowedRoot = allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));
  if (!insideAllowedRoot) {
    return null;
  }

  if (!existsSync(resolvedPath)) {
    return null;
  }

  return allowedRoots.some((root) => isPathWithinRoot(path.resolve(resolvedPath), root))
    ? resolvedPath
    : null;
}

interface DBInstanceLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
}

export interface DownloadedCreator {
  id: string;
  name: string;
  postCount: number;
  expectedPostCount: number | null;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  /** Number of posts that contain at least one external (non-Patreon) link. */
  postsWithLinks: number;
  /** Total count of external links across all of this creator's posts. */
  totalLinks: number;
  /** Convenience: totalLinks > 0. */
  hasExternalLinks: boolean;
  mediaFileCount: number;
  filesPresent: number;
  filesMissing: number;
  status:
    | "complete"
    | "needsRepair"
    | "linksPending"
    | "metadataOnly"
    | "incompleteScan";
  campaignFolder: string | null;
}

export interface ExportOptions {
  outDir: string;
  creatorIds: string[];
  targetFolder: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface ExportResult {
  filesWritten: string[];
  filesSkipped: string[];
  errors: string[];
}

export interface RepairCreatorResult {
  success: boolean;
  creatorId: string;
  creatorName: string | null;
  creatorURL: string | null;
  campaignFolder: string | null;
  deletedRows: Record<string, number>;
  removedFiles: string[];
  errors: string[];
}

export interface ClearExternalLinksResult {
  removedFiles: string[];
  deletedRows: Record<string, number>;
  errors: string[];
}

/** List every campaign that has at least one post in the patreon-dl DB. */
export function listDownloadedCreators(outDir: string): DownloadedCreator[] {
  const dbPath = path.resolve(outDir, ".patreon-dl", "db.sqlite");
  const db = openDb(dbPath);
  if (!db) {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT c.campaign_id AS id, c.campaign_name AS name,
                COUNT(co.content_id) AS postCount,
                MIN(co.published_at) AS firstPublished,
                MAX(co.published_at) AS lastPublished,
                c.details AS campaignDetails
           FROM campaign c
           LEFT JOIN content co
             ON co.campaign_id = c.campaign_id AND co.content_type = 'post'
          GROUP BY c.campaign_id, c.campaign_name
          ORDER BY c.campaign_name COLLATE NOCASE`
      )
      .all() as Array<{
        id: string;
        name: string;
        postCount: number;
        campaignDetails: string;
        firstPublished: number | null;
        lastPublished: number | null;
      }>;

    const out: DownloadedCreator[] = [];
    for (const row of rows) {
      // Count external links across all of this creator's posts so the
      // GUI can show "X posts with links / Y total links" without
      // writing a file.
      let postsWithLinks = 0;
      let totalLinks = 0;
      if (row.postCount > 0) {
        const postRows = db
          .prepare(
            `SELECT details FROM content
               WHERE content_type = 'post' AND campaign_id = ?`
          )
          .all(row.id) as Array<{ details: string }>;
        for (const pr of postRows) {
          try {
            const post = JSON.parse(pr.details) as Post;
            const links = extractExternalLinksFromPost(post);
            if (links.length > 0) {
              postsWithLinks++;
              totalLinks += links.length;
            }
          } catch {
            // skip malformed
          }
        }
      }
      const health = getCreatorHealth(db, outDir, row.id);
      const expectedPostCount =
        getExpectedPostCount(row.campaignDetails) ??
        getExpectedPostCountFromCampaignFolder(health.campaignFolder);
      out.push({
        id: row.id,
        name: row.name || `Campaign #${row.id}`,
        postCount: row.postCount,
        expectedPostCount,
        firstPublishedAt: toIsoOrNull(row.firstPublished),
        lastPublishedAt: toIsoOrNull(row.lastPublished),
        postsWithLinks,
        totalLinks,
        hasExternalLinks: totalLinks > 0,
        ...health
      });
    }
    return out;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function getCreatorHealth(
  db: DBInstanceLike,
  outDir: string,
  creatorId: string
): Pick<
  DownloadedCreator,
  "mediaFileCount" | "filesPresent" | "filesMissing" | "status" | "campaignFolder"
> {
  const group = readCreatorPosts(db, creatorId);
  const campaignFolder = group?.campaign ?
    findDownloadedCampaignFolder(outDir, group.campaign)
  : null;
  const pathRows = db
    .prepare(
      `SELECT m.download_path AS filePath
         FROM media m
         JOIN content_media cm ON cm.media_id = m.media_id
        WHERE cm.campaign_id = ? AND m.download_path IS NOT NULL
       UNION ALL
       SELECT m.thumbnail_download_path AS filePath
         FROM media m
         JOIN content_media cm ON cm.media_id = m.media_id
        WHERE cm.campaign_id = ? AND m.thumbnail_download_path IS NOT NULL`
    )
    .all(creatorId, creatorId) as Array<{ filePath: string }>;

  let filesPresent = 0;
  let filesMissing = 0;
  for (const row of pathRows) {
    const rel = String(row.filePath || "").trim();
    if (!rel) {
      continue;
    }
    if (existsSync(path.resolve(outDir, rel))) {
      filesPresent++;
    } else {
      filesMissing++;
    }
  }

  let status: DownloadedCreator["status"];
  const expectedPostCount =
    group?.campaign ?
      getExpectedPostCount(JSON.stringify(group.campaign)) ??
      getExpectedPostCountFromCampaignFolder(campaignFolder)
    : null;
  if (
    expectedPostCount !== null &&
    group &&
    group.posts.length > 0 &&
    group.posts.length < expectedPostCount
  ) {
    status = "incompleteScan";
  } else if (filesMissing > 0) {
    status = "needsRepair";
  } else if (pathRows.length === 0) {
    status = "metadataOnly";
  } else {
    const hasLinks = group?.posts.some(
      (post) => extractExternalLinksFromPost(post).length > 0
    );
    status = hasLinks ? "linksPending" : "complete";
  }

  return {
    mediaFileCount: pathRows.length,
    filesPresent,
    filesMissing,
    status,
    campaignFolder
  };
}

function getExpectedPostCount(campaignDetails: string): number | null {
  try {
    const campaign = JSON.parse(campaignDetails) as {
      attributes?: {
        creation_count?: unknown;
        post_count?: unknown;
        postCount?: unknown;
      };
      creation_count?: unknown;
      post_count?: unknown;
      postCount?: unknown;
    };
    const raw =
      campaign.attributes?.creation_count ??
      campaign.attributes?.post_count ??
      campaign.attributes?.postCount ??
      campaign.creation_count ??
      campaign.post_count ??
      campaign.postCount;
    const count = Number(raw);
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

function getExpectedPostCountFromCampaignFolder(
  campaignFolder: string | null
): number | null {
  if (!campaignFolder) {
    return null;
  }
  const apiPath = path.resolve(campaignFolder, "campaign_info", "campaign-api.json");
  try {
    return getExpectedPostCount(readFileSync(apiPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * For each requested creator id, build an _external-links.html file in
 * `targetFolder` containing all of that creator's external links. One
 * file per creator. Returns the absolute paths of the files written.
 */
export async function exportCreatorExternalLinks(
  opts: ExportOptions
): Promise<ExportResult> {
  const { outDir, creatorIds, targetFolder } = opts;
  const result: ExportResult = {
    filesWritten: [],
    filesSkipped: [],
    errors: []
  };

  if (!outDir) {
    result.errors.push("No output directory configured");
    return result;
  }
  if (!targetFolder) {
    result.errors.push("No target folder chosen");
    return result;
  }
  if (!creatorIds || creatorIds.length === 0) {
    result.errors.push("No creators selected");
    return result;
  }

  const dbPath = path.resolve(outDir, ".patreon-dl", "db.sqlite");
  const db = openDb(dbPath);
  if (!db) {
    result.errors.push(`patreon-dl database not found at ${dbPath}`);
    return result;
  }

  try {
    await ensureDir(targetFolder);
    for (const creatorId of creatorIds) {
      try {
        const group = readCreatorPosts(db, creatorId);
        if (!group) {
          result.errors.push(`Creator ${creatorId} not found in DB`);
          continue;
        }
        const campaignFolder = await ensureCreatorAttachmentsFolder(
          outDir,
          group.campaign
        );
        const collected: Array<{
          post: Post;
          links: ReturnType<typeof extractExternalLinksFromPost>;
        }> = [];
        for (const post of group.posts) {
          const links = extractExternalLinksFromPost(post);
          if (links.length > 0) {
            collected.push({ post, links });
          }
        }
        if (collected.length === 0) {
          result.filesSkipped.push(
            `${group.campaign.name || group.campaign.id} (no external links)`
          );
          continue;
        }
        const fileName = `${sanitizeFileName(group.campaign.name || `campaign-${group.campaign.id}`)}_external-links.html`;
        const filePath = path.resolve(targetFolder, fileName);
        const html = renderExternalLinksHTML(group.campaign, collected);
        await writeFile(filePath, html, "utf-8");
        result.filesWritten.push(filePath);

        for (const entry of collected) {
          const postFolder = await ensurePostAttachmentsFolder(
            outDir,
            group.campaign,
            entry.post,
            campaignFolder
          );
          const postFilePath = path.resolve(
            postFolder,
            POST_EXTERNAL_LINKS_FILE_NAME
          );
          await writeFile(
            postFilePath,
            renderPostExternalLinksHTML(
              group.campaign,
              entry.post,
              entry.links
            ),
            "utf-8"
          );
          result.filesWritten.push(postFilePath);
        }

        opts.log?.(
          "info",
          `Wrote ${collected.length} post(s) of external links to ${filePath}`
        );
      } catch (error: unknown) {
        const msg = `Failed for creator ${creatorId}: ${getErrorString(error)}`;
        result.errors.push(msg);
        opts.log?.("error", msg);
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  return result;
}

export function clearExternalLinkFiles(
  outDir: string,
  targetFolder?: string | null
): ClearExternalLinksResult {
  const result: ClearExternalLinksResult = {
    removedFiles: [],
    deletedRows: {},
    errors: []
  };
  const seen = new Set<string>();
  const allowedRoots = getAllowedRemovalRoots(outDir, targetFolder);

  const removeFile = (filePath: string) => {
    const resolved = path.resolve(filePath);
    const managedPath = resolveManagedRemovalPath(resolved, allowedRoots);
    if (!managedPath) {
      result.errors.push(`Blocked removal outside allowed roots: ${resolved}`);
      return;
    }
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    try {
      rmSync(managedPath, { force: true });
      result.removedFiles.push(managedPath);
    } catch (error: unknown) {
      result.errors.push(`${managedPath}: ${getErrorString(error)}`);
    }
  };

  if (outDir && existsSync(outDir)) {
    for (const filePath of findFilesRecursive(
      outDir,
      (name) => name === POST_EXTERNAL_LINKS_FILE_NAME
    )) {
      removeFile(filePath);
    }
    for (const filePath of findFilesRecursive(
      outDir,
      (name) => name === "status-cache.json"
    )) {
      removeFile(filePath);
    }
  }

  if (outDir) {
    const dbPath = path.resolve(outDir, ".patreon-dl", "db.sqlite");
    const db = openDb(dbPath);
    if (db) {
      try {
        db.prepare("PRAGMA foreign_keys = OFF").run();
        for (const table of [
          "post_comments",
          "post_collection",
          "post_tag_post",
          "post_tier",
          "content_media",
          "collection_fts_source",
          "collection_fts",
          "post_fts_source",
          "post_fts",
          "product_fts_source",
          "product_fts",
          "media",
          "collection",
          "post_tag",
          "reward",
          "content",
          "campaign",
          "user"
        ]) {
          result.deletedRows[table] = deleteAllRowsIfTableExists(db, table);
        }
      } catch (error: unknown) {
        result.errors.push(`Could not clear creator library: ${getErrorString(error)}`);
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  if (targetFolder && existsSync(targetFolder)) {
    for (const filePath of findFilesInFolder(
      targetFolder,
      (name) => name.endsWith("_external-links.html")
    )) {
      removeFile(filePath);
    }
  }

  return result;
}

export function repairCreatorDownloadState(
  outDir: string,
  creatorId: string
): RepairCreatorResult {
  const allowedRoots = getAllowedRemovalRoots(outDir);
  const result: RepairCreatorResult = {
    success: false,
    creatorId,
    creatorName: null,
    creatorURL: null,
    campaignFolder: null,
    deletedRows: {},
    removedFiles: [],
    errors: []
  };

  if (!outDir) {
    result.errors.push("No output directory configured");
    return result;
  }
  if (!creatorId) {
    result.errors.push("No creator selected");
    return result;
  }

  const dbPath = path.resolve(outDir, ".patreon-dl", "db.sqlite");
  const db = openDb(dbPath);
  if (!db) {
    result.errors.push(`patreon-dl database not found at ${dbPath}`);
    return result;
  }

  try {
    const campaignRow = db
      .prepare(
        `SELECT campaign_id, creator_id, campaign_name, details
           FROM campaign
          WHERE campaign_id = ?`
      )
      .get(creatorId) as
      | {
          campaign_id: string;
          creator_id: string | null;
          campaign_name: string | null;
          details: string;
        }
      | undefined;
    if (!campaignRow) {
      result.errors.push(`Creator ${creatorId} not found in DB`);
      return result;
    }

    let campaign: Campaign | null = null;
    try {
      campaign = JSON.parse(campaignRow.details) as Campaign;
    } catch {
      // Keep repairing even if details are malformed.
    }
    result.creatorName =
      campaign?.name || campaignRow.campaign_name || `Campaign #${creatorId}`;
    result.creatorURL = campaign ? getCampaignURL(campaign) : null;
    result.campaignFolder = campaign ?
      findDownloadedCampaignFolder(outDir, campaign)
    : null;

    const contentRows = db
      .prepare(
        `SELECT content_id AS id, content_type AS type
           FROM content
          WHERE campaign_id = ?`
      )
      .all(creatorId) as Array<{ id: string; type: string }>;
    const mediaRows = db
      .prepare(
        `SELECT media_id AS id
           FROM content_media
          WHERE campaign_id = ?`
      )
      .all(creatorId) as Array<{ id: string }>;

    db.prepare("PRAGMA foreign_keys = OFF").run();
    result.deletedRows.post_comments = deleteByIds(
      db,
      "post_comments",
      "post_id",
      contentRows.filter((row) => row.type === "post").map((row) => row.id)
    );
    result.deletedRows.post_collection = db
      .prepare(`DELETE FROM post_collection WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.post_tag_post = db
      .prepare(`DELETE FROM post_tag_post WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.post_tier = db
      .prepare(`DELETE FROM post_tier WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.content_media = db
      .prepare(`DELETE FROM content_media WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.media = deleteUnreferencedMediaByIds(
      db,
      mediaRows.map((row) => row.id)
    );
    result.deletedRows.collection = db
      .prepare(`DELETE FROM collection WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.post_tag = db
      .prepare(`DELETE FROM post_tag WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.reward = db
      .prepare(`DELETE FROM reward WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.content = db
      .prepare(`DELETE FROM content WHERE campaign_id = ?`)
      .run(creatorId).changes;
    result.deletedRows.campaign = db
      .prepare(`DELETE FROM campaign WHERE campaign_id = ?`)
      .run(creatorId).changes;
    if (campaignRow.creator_id) {
      result.deletedRows.user = db
        .prepare(
          `DELETE FROM user
            WHERE user_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM campaign WHERE creator_id = ?
              )`
        )
        .run(campaignRow.creator_id, campaignRow.creator_id).changes;
    }

    const statusCachePath = result.campaignFolder ?
      path.resolve(result.campaignFolder, ".patreon-dl", "status-cache.json")
    : null;
    if (statusCachePath && existsSync(statusCachePath)) {
      const managedStatusPath = resolveManagedRemovalPath(statusCachePath, allowedRoots);
      if (!managedStatusPath) {
        result.errors.push(`Blocked removal outside allowed roots: ${statusCachePath}`);
      } else {
        rmSync(managedStatusPath, { force: true });
        result.removedFiles.push(managedStatusPath);
      }
    }
    result.success = result.errors.length === 0;
    return result;
  } catch (error: unknown) {
    result.errors.push(getErrorString(error));
    return result;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function openDb(dbPath: string): DBInstanceLike | null {
  try {
    return new DatabaseCtor(dbPath) as DBInstanceLike;
  } catch {
    return null;
  }
}

function deleteByIds(
  db: DBInstanceLike,
  table: string,
  column: string,
  ids: string[]
): number {
  if (ids.length === 0) {
    return 0;
  }
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
    .run(...ids).changes;
}

function deleteUnreferencedMediaByIds(
  db: DBInstanceLike,
  mediaIds: string[]
): number {
  if (mediaIds.length === 0) {
    return 0;
  }
  const placeholders = mediaIds.map(() => "?").join(",");
  return db
    .prepare(
      `DELETE FROM media
        WHERE media_id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM content_media cm WHERE cm.media_id = media.media_id
          )`
    )
    .run(...mediaIds).changes;
}

function deleteAllRowsIfTableExists(db: DBInstanceLike, table: string): number {
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type IN ('table', 'view') AND name = ?`
    )
    .get(table);
  if (!exists) {
    return 0;
  }
  return db.prepare(`DELETE FROM "${table}"`).run().changes;
}

function findFilesRecursive(
  root: string,
  matches: (name: string) => boolean
): string[] {
  const found: string[] = [];
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(entryPath);
      }
    }
  }
  return found;
}

function findFilesInFolder(
  folder: string,
  matches: (name: string) => boolean
): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matches(entry.name))
      .map((entry) => path.resolve(folder, entry.name));
  } catch {
    return [];
  }
}

function readCreatorPosts(
  db: DBInstanceLike,
  creatorId: string
): { campaign: Campaign; posts: Post[] } | null {
  const campaignRow = db
    .prepare(`SELECT details FROM campaign WHERE campaign_id = ?`)
    .all(creatorId) as Array<{ details: string }>;
  if (campaignRow.length === 0) {
    return null;
  }
  let campaign: Campaign;
  try {
    campaign = JSON.parse(campaignRow[0].details) as Campaign;
  } catch {
    return null;
  }
  const postRows = db
    .prepare(
      `SELECT details FROM content
         WHERE content_type = 'post' AND campaign_id = ?
         ORDER BY COALESCE(published_at, 0) ASC`
    )
    .all(creatorId) as Array<{ details: string }>;
  const posts: Post[] = [];
  for (const pr of postRows) {
    try {
      const parsed = JSON.parse(pr.details) as Post;
      if (parsed && parsed.id) {
        if (!parsed.campaign) {
          parsed.campaign = campaign;
        }
        posts.push(parsed);
      }
    } catch {
      // skip
    }
  }
  return { campaign, posts };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "creator";
}

function findDownloadedPostFolder(
  outDir: string,
  campaign: Campaign,
  post: Post
): string | null {
  const campaignDir = findDownloadedCampaignFolder(outDir, campaign);
  if (!campaignDir) {
    return null;
  }
  const postsDir = path.resolve(campaignDir, "posts");
  const candidates = [
    path.resolve(postsDir, `${sanitizeFileName(post.title || "")} - ${post.id}`),
    path.resolve(postsDir, `${post.id} - ${sanitizeFileName(post.title || "")}`)
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return findChildDirByPostId(postsDir, post.id);
}

async function ensureCreatorAttachmentsFolder(
  outDir: string,
  campaign: Campaign
): Promise<string> {
  const campaignFolder =
    findDownloadedCampaignFolder(outDir, campaign) ||
    getFallbackCampaignFolder(outDir, campaign);
  await ensureDir(path.resolve(campaignFolder, ATTACHMENTS_DIR_NAME));
  return campaignFolder;
}

async function ensurePostAttachmentsFolder(
  outDir: string,
  campaign: Campaign,
  post: Post,
  campaignFolder?: string
): Promise<string> {
  const postFolder =
    findDownloadedPostFolder(outDir, campaign, post) ||
    getFallbackPostFolder(campaignFolder || getFallbackCampaignFolder(outDir, campaign), post);
  await ensureDir(path.resolve(postFolder, ATTACHMENTS_DIR_NAME));
  return postFolder;
}

function findDownloadedCampaignFolder(
  outDir: string,
  campaign: Campaign
): string | null {
  const name = campaign.name || `campaign-${campaign.id}`;
  const vanity = "vanity" in campaign ? String(campaign.vanity || "") : "";
  const candidates = [
    path.resolve(outDir, sanitizeFileName(name)),
    vanity && name ? path.resolve(outDir, `${sanitizeFileName(vanity)} - ${sanitizeFileName(name)}`) : "",
    path.resolve(outDir, `campaign-${campaign.id}`)
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return findChildDirByCampaignName(outDir, name);
}

function getFallbackCampaignFolder(outDir: string, campaign: Campaign): string {
  const name = campaign.name || `campaign-${campaign.id}`;
  return path.resolve(outDir, sanitizeFileName(name));
}

function getFallbackPostFolder(campaignFolder: string, post: Post): string {
  const title = sanitizeFileName(cleanContentNameForDir(post.title || "")) || `post-${post.id}`;
  return path.resolve(campaignFolder, "posts", `${title} - ${post.id}`);
}

function cleanContentNameForDir(name: string): string {
  return (
    name
      .replace(/^\s*[[(]?\s*download\s*[\])]?[\s:._-]*/i, "")
      .replace(/\s*[[(]\s*download\s*[\])]\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || name
  );
}

function getCampaignURL(campaign: Campaign): string {
  const rawCampaign = campaign as Campaign & {
    url?: string;
    vanity?: string;
    creator?: { vanity?: string };
  };
  if (rawCampaign.url) {
    return rawCampaign.url;
  }
  const vanity = rawCampaign.creator?.vanity || rawCampaign.vanity || "";
  if (vanity) {
    return `https://www.patreon.com/${vanity}`;
  }
  return `https://www.patreon.com/campaigns/${campaign.id}`;
}

function findChildDirByCampaignName(
  outDir: string,
  campaignName: string
): string | null {
  let entries;
  try {
    entries = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const sanitizedName = sanitizeFileName(campaignName).toLowerCase();
  const suffix = ` - ${sanitizedName}`;
  const match = entries.find((entry) => {
    if (!entry.isDirectory()) {
      return false;
    }
    const name = entry.name.toLowerCase();
    return name === sanitizedName || name.endsWith(suffix);
  });
  return match ? path.resolve(outDir, match.name) : null;
}

function findChildDirByPostId(postsDir: string, postId: string): string | null {
  let entries;
  try {
    entries = readdirSync(postsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const suffix = ` - ${postId}`;
  const prefix = `${postId} - `;
  const match = entries.find(
    (entry) =>
      entry.isDirectory() &&
      (entry.name.endsWith(suffix) || entry.name.startsWith(prefix))
  );
  return match ? path.resolve(postsDir, match.name) : null;
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function toIsoOrNull(value: number | null): string | null {
  if (!value || !Number.isFinite(value)) {
    return null;
  }
  // patreon-dl stores published_at as unix milliseconds.
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}
