import type { LogLevel } from "patreon-dl";

export type DownloadJobStatus =
  | "pending"
  | "queued"
  | "confirmRequired"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "aborted";

export interface DownloadCenterLogEntry {
  text: string;
  level: LogLevel;
  time: number;
}

export interface DownloadCenterJobInfo {
  id: string;
  editorId: number;
  name: string;
  targetDesc: string;
  targetURL: string;
  outDir: string;
  status: DownloadJobStatus;
  error: string | null;
  startTime: number | null;
  endTime: number | null;
  logs: DownloadCenterLogEntry[];
}

export interface ExternalLink {
  title: string;
  url: string;
}

export interface ExternalLinkGroup {
  source: string;
  links: ExternalLink[];
}
