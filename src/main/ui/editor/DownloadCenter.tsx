import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Collapse,
  Form,
  ProgressBar,
  Spinner,
  Table,
  Tabs,
  Tab
} from "react-bootstrap";
import { useConfig } from "../contexts/ConfigProvider";
import type {
  DownloadCenterJobInfo,
  DownloadCenterLogEntry,
  DownloadJobStatus
} from "../../types/DownloadCenter";
import type {
  SimsInstallResult,
  SimsInstallSettings,
  SimsLibraryItem,
  SimsScanResult
} from "../../util/SimsContentInstaller";

interface DownloadedCreator {
  id: string;
  name: string;
  postCount: number;
  expectedPostCount: number | null;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  postsWithLinks: number;
  totalLinks: number;
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

type SimsActionStatus = {
  type: "info" | "success" | "error";
  text: string;
} | null;

const MAX_INLINE_LOGS = 100;
const LIBRARY_PAGE_SIZE = 240;

function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return "--";
  }
  return new Date(timestamp).toLocaleTimeString();
}

function formatDate(value: string | null) {
  if (!value) {
    return "--";
  }
  return new Date(value).toLocaleDateString();
}

function getStatusVariant(status: DownloadJobStatus) {
  switch (status) {
    case "running":
      return "info";
    case "completed":
      return "success";
    case "error":
    case "aborted":
      return "danger";
    case "paused":
      return "warning";
    case "queued":
      return "secondary";
    default:
      return "dark";
  }
}

function getStatusLabel(status: DownloadJobStatus) {
  switch (status) {
    case "confirmRequired":
      return "confirm";
    default:
      return status;
  }
}

function getCreatorStatusVariant(status: DownloadedCreator["status"]) {
  switch (status) {
    case "complete":
      return "success";
    case "needsRepair":
      return "danger";
    case "linksPending":
      return "info";
    case "metadataOnly":
      return "secondary";
    case "incompleteScan":
      return "warning";
    default:
      return "dark";
  }
}

function getCreatorStatusLabel(status: DownloadedCreator["status"]) {
  switch (status) {
    case "complete":
      return "Complete";
    case "needsRepair":
      return "Needs repair";
    case "linksPending":
      return "Links pending";
    case "metadataOnly":
      return "Metadata only";
    case "incompleteScan":
      return "Incomplete scan";
    default:
      return status;
  }
}

function formatPostCount(creator: DownloadedCreator) {
  if (
    creator.expectedPostCount !== null &&
    creator.expectedPostCount > creator.postCount
  ) {
    return `${creator.postCount}/${creator.expectedPostCount} posts`;
  }
  return `${creator.postCount} post${creator.postCount === 1 ? "" : "s"}`;
}

function formatSimsCandidateCount(scan: SimsScanResult | null) {
  if (!scan) {
    return "No scan yet";
  }
  const modFiles = scan.candidates.filter((candidate) => candidate.kind === "mods").length;
  const trayFiles = scan.candidates.filter((candidate) => candidate.kind === "tray").length;
  return `${modFiles} Mods file${modFiles === 1 ? "" : "s"}, ${trayFiles} Tray file${trayFiles === 1 ? "" : "s"}`;
}

function DownloadCenter() {
  const [jobs, setJobs] = useState<DownloadCenterJobInfo[]>([]);
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const { config, setConfigValue } = useConfig();
  const outDir = config?.output["out.dir"] || "";

  const refreshJobs = useCallback(async () => {
    const currentJobs = await window.mainAPI.invoke("getDownloadCenterJobs");
    setJobs(currentJobs);
  }, []);

  // External-links tab state. The user picks which creators to export
  // and where to write the file(s).
  const [creators, setCreators] = useState<DownloadedCreator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(false);
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<Set<string>>(
    new Set()
  );
  const [targetFolder, setTargetFolder] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [clearingExternalLinks, setClearingExternalLinks] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [repairingCreatorId, setRepairingCreatorId] = useState<string | null>(
    null
  );
  const [simsSettings, setSimsSettings] =
    useState<SimsInstallSettings | null>(null);
  const [simsScan, setSimsScan] = useState<SimsScanResult | null>(null);
  const [simsInstallResult, setSimsInstallResult] =
    useState<SimsInstallResult | null>(null);
  const [simsStatus, setSimsStatus] = useState<SimsActionStatus>(null);
  const [simsBusy, setSimsBusy] = useState(false);
  const [libraryItems, setLibraryItems] = useState<SimsLibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryKind, setLibraryKind] = useState<"all" | "mods" | "tray" | "missing">("all");
  const [libraryPage, setLibraryPage] = useState(1);
  const [selectedLibraryCreator, setSelectedLibraryCreator] = useState<string | null>(null);

  const refreshCreators = useCallback(async () => {
    if (!outDir) {
      setCreators([]);
      return;
    }
    setCreatorsLoading(true);
    try {
      const list = await window.mainAPI.invoke(
        "listDownloadedCreators",
        outDir
      );
      setCreators(list);
      // Drop any selected ids that are no longer in the list.
      setSelectedCreatorIds((prev) => {
        const ids = new Set(list.map((c) => c.id));
        const next = new Set<string>();
        for (const id of prev) {
          if (ids.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
    } catch (error: unknown) {
      setExportStatus(
        `Could not list creators: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setCreatorsLoading(false);
    }
  }, [outDir]);

  const toggleCreatorSelected = useCallback((id: string) => {
    setSelectedCreatorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedCreatorIds(new Set(creators.map((c) => c.id)));
  }, [creators]);

  const clearSelection = useCallback(() => {
    setSelectedCreatorIds(new Set());
  }, []);

  const browseForFolder = useCallback(async () => {
    try {
      const result = (await window.mainAPI.invoke("openFSChooser", {
        title: "Choose folder for external-links files",
        properties: ["openDirectory", "createDirectory"]
      })) as { canceled?: boolean; paths?: string[] };
      if (!result.canceled && result.paths && result.paths[0]) {
        setTargetFolder(result.paths[0]);
      }
    } catch (error: unknown) {
      setExportStatus(
        `Could not open folder picker: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }, []);

  const createExternalLinks = useCallback(async () => {
    if (
      !outDir ||
      exporting ||
      selectedCreatorIds.size === 0 ||
      !targetFolder
    ) {
      return;
    }
    setExporting(true);
    setExportStatus(null);
    try {
      const result = await window.mainAPI.invoke(
        "exportCreatorExternalLinks",
        outDir,
        Array.from(selectedCreatorIds),
        targetFolder
      );
      const lines: string[] = [];
      if (result.filesWritten.length > 0) {
        lines.push(`Wrote ${result.filesWritten.length} file(s).`);
      }
      if (result.filesSkipped.length > 0) {
        lines.push(
          `Skipped ${result.filesSkipped.length} (no external links): ${result.filesSkipped.join(", ")}.`
        );
      }
      if (result.errors.length > 0) {
        lines.push(`${result.errors.length} error(s): ${result.errors.join("; ")}.`);
      }
      if (lines.length === 0) {
        lines.push("Nothing to write.");
      }
      setExportStatus(lines.join(" "));
    } catch (error: unknown) {
      setExportStatus(
        `Export failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setExporting(false);
    }
  }, [outDir, exporting, selectedCreatorIds, targetFolder]);

  const openTargetFolder = useCallback(() => {
    if (targetFolder) {
      window.mainAPI.invoke("openInFileManager", targetFolder);
    }
  }, [targetFolder]);

  const clearExternalLinks = useCallback(async () => {
    if (!outDir || clearingExternalLinks) {
      return;
    }
    const confirmed = window.confirm(
      "Clear the external-links creator library?\n\nThis removes generated _external-links.html reports, saved creator records, and status cache files. It does not delete downloaded files or folders."
    );
    if (!confirmed) {
      return;
    }
    setClearingExternalLinks(true);
    setExportStatus(null);
    try {
      const result = await window.mainAPI.invoke(
        "clearExternalLinkFiles",
        outDir,
        targetFolder || null
      );
      const deletedRows = Object.values(result.deletedRows).reduce(
        (sum, count) => sum + count,
        0
      );
      if (result.errors.length > 0) {
        setExportStatus(
          `Cleared ${result.removedFiles.length} file(s) and ${deletedRows} library row(s), with ${result.errors.length} error(s): ${result.errors.join("; ")}.`
        );
      } else {
        setExportStatus(
          result.removedFiles.length > 0 || deletedRows > 0 ?
            `Cleared ${result.removedFiles.length} file(s) and ${deletedRows} library row(s).`
          : "No generated files or saved creator records were found."
        );
      }
      await refreshCreators();
    } catch (error: unknown) {
      setExportStatus(
        `Clear failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setClearingExternalLinks(false);
    }
  }, [clearingExternalLinks, outDir, refreshCreators, targetFolder]);

  const repairCreator = useCallback(
    async (creator: DownloadedCreator) => {
      if (!outDir || repairingCreatorId) {
        return;
      }
      const confirmed = window.confirm(
        `Repair "${creator.name}"?\n\nThis clears stale local DB records and the creator status cache. It does not delete downloaded files. After this, run the creator again to redownload missing content.`
      );
      if (!confirmed) {
        return;
      }
      setRepairingCreatorId(creator.id);
      setExportStatus(null);
      try {
        const result = await window.mainAPI.invoke(
          "repairCreatorDownloadState",
          outDir,
          creator.id
        );
        if (!result.success) {
          setExportStatus(
            `Repair failed: ${
              result.errors.length > 0 ?
                result.errors.join("; ")
              : "unknown error"
            }`
          );
          return;
        }
        const deletedRows = Object.values(result.deletedRows).reduce(
          (sum, count) => sum + count,
          0
        );
        setExportStatus(
          `Repaired ${result.creatorName || creator.name}: cleared ${deletedRows} DB row(s) and ${result.removedFiles.length} cache file(s). Run the creator again to redownload missing content.`
        );
        await refreshCreators();
        if (result.creatorURL) {
          const targetValue = {
            value: result.creatorURL,
            description: `Posts by user "${result.creatorName || creator.name}"`
          };
          setConfigValue("support.data", "browserObtainedValues", {
            ...config["support.data"].browserObtainedValues,
            target: targetValue
          });
          setConfigValue("support.data", "bootstrapData", null);
          setConfigValue("downloader", "target", {
            ...config.downloader.target,
            inputMode: "browser",
            browserValue: targetValue
          });
          await window.mainAPI.invoke("setWebBrowserURL", result.creatorURL);
        }
      } catch (error: unknown) {
        setExportStatus(
          `Repair failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        setRepairingCreatorId(null);
      }
    },
    [config, outDir, refreshCreators, repairingCreatorId, setConfigValue]
  );

  const refreshSimsSettings = useCallback(async () => {
    const settings = await window.mainAPI.invoke("getSimsInstallSettings");
    setSimsSettings(settings);
  }, []);

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const items = await window.mainAPI.invoke("listSimsLibrary");
      setLibraryItems(items);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const scanSimsOutput = useCallback(
    async (sourceRoot = outDir) => {
      if (!sourceRoot || simsBusy) {
        return null;
      }
      setSimsBusy(true);
      setSimsStatus(null);
      try {
        const result = await window.mainAPI.invoke(
          "scanSimsContent",
          sourceRoot
        );
        setSimsScan(result);
        setSimsInstallResult(null);
        setSimsStatus({
          type: result.errors.length > 0 ? "error" : "info",
          text: `Found ${result.candidates.length} Sims file(s) across ${result.archives} archive(s), with ${result.errors.length} archive error(s).`
        });
        return result;
      } catch (error: unknown) {
        setSimsStatus({
          type: "error",
          text: `Scan failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        return null;
      } finally {
        setSimsBusy(false);
      }
    },
    [outDir, simsBusy]
  );

  const installSimsOutput = useCallback(
    async (sourceRoot = outDir) => {
      if (!sourceRoot || simsBusy) {
        return null;
      }
      setSimsBusy(true);
      setSimsStatus(null);
      try {
        const result = await window.mainAPI.invoke(
          "installSimsContent",
          sourceRoot
        );
        setSimsScan(result);
        setSimsInstallResult(result);
        await refreshLibrary();
        setSimsStatus({
          type: result.errors.length > 0 ? "error" : "success",
          text: `Installed ${result.installed.length}, skipped ${result.skipped.length}, ${result.errors.length} error(s).`
        });
        return result;
      } catch (error: unknown) {
        setSimsStatus({
          type: "error",
          text: `Install failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        return null;
      } finally {
        setSimsBusy(false);
      }
    },
    [outDir, refreshLibrary, simsBusy]
  );

  useEffect(() => {
    refreshJobs();
    void refreshSimsSettings();
    void refreshLibrary();
    const removeListeners = [
      window.mainAPI.on("downloadCenter:jobsUpdate", (updatedJobs) => {
        setJobs(updatedJobs);
      }),
      window.mainAPI.on(
        "downloadCenter:log",
        (payload: { jobId: string; message: DownloadCenterLogEntry }) => {
          setJobs((prev) =>
            prev.map((job) =>
              job.id === payload.jobId ?
                {
                  ...job,
                  logs: [...job.logs, payload.message].slice(-MAX_INLINE_LOGS)
                }
              : job
            )
          );
        }
      )
    ];
    return () => {
      removeListeners.forEach((cb) => cb());
    };
  }, [refreshJobs, refreshLibrary, refreshSimsSettings]);

  // Whenever the user switches to the External Links tab, refresh the
  // creator list from the DB.
  const [activeTab, setActiveTab] = useState<string>("jobs");
  useEffect(() => {
    if (activeTab === "external-links") {
      void refreshCreators();
    }
    if (activeTab === "sims-mods") {
      void refreshSimsSettings();
    }
    if (activeTab === "library") {
      void refreshLibrary();
    }
  }, [activeTab, refreshCreators, refreshLibrary, refreshSimsSettings]);

  const toggleExpanded = useCallback((jobId: string) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  }, []);

  const startAll = useCallback(() => {
    jobs
      .filter((job) =>
        ["pending", "queued", "confirmRequired", "paused"].includes(job.status)
      )
      .forEach((job) => {
        window.mainAPI.invoke("resumeDownload", job.id);
      });
  }, [jobs]);

  const pauseAll = useCallback(() => {
    jobs
      .filter((job) => job.status === "running" || job.status === "queued")
      .forEach((job) => {
        window.mainAPI.invoke("pauseDownload", job.id);
      });
  }, [jobs]);

  const stopAll = useCallback(() => {
    jobs
      .filter(
        (job) =>
          job.status === "running" ||
          job.status === "queued" ||
          job.status === "paused"
      )
      .forEach((job) => {
        window.mainAPI.invoke("stopDownload", job.id);
      });
  }, [jobs]);

  const clearFinished = useCallback(() => {
    window.mainAPI.invoke("clearFinishedDownloads");
  }, []);

  const runningCount = useMemo(
    () => jobs.filter((job) => job.status === "running").length,
    [jobs]
  );
  const completedCount = useMemo(
    () => jobs.filter((job) => job.status === "completed").length,
    [jobs]
  );
  const problemCount = useMemo(
    () => jobs.filter((job) => ["error", "aborted"].includes(job.status)).length,
    [jobs]
  );
  const queuedCount = useMemo(
    () =>
      jobs.filter((job) =>
        ["pending", "queued", "confirmRequired", "paused"].includes(job.status)
      ).length,
    [jobs]
  );
  const totalCount = jobs.length;
  const completePercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const externalLinkCreators = useMemo(
    () => creators.filter((creator) => creator.hasExternalLinks).length,
    [creators]
  );
  const totalExternalLinks = useMemo(
    () => creators.reduce((sum, creator) => sum + creator.totalLinks, 0),
    [creators]
  );
  const creatorsNeedingRepair = useMemo(
    () => creators.filter((creator) => creator.status === "needsRepair").length,
    [creators]
  );
  const filteredLibraryItems = useMemo(() => {
    const search = librarySearch.trim().toLowerCase();
    return libraryItems.filter((item) => {
      if (selectedLibraryCreator && item.creatorName !== selectedLibraryCreator) {
        return false;
      }
      if (libraryKind === "mods" && item.kind !== "mods") {
        return false;
      }
      if (libraryKind === "tray" && item.kind !== "tray") {
        return false;
      }
      if (libraryKind === "missing" && !item.missing) {
        return false;
      }
      if (!search) {
        return true;
      }
      return [
        item.displayName,
        item.creatorName,
        item.postTitle,
        item.fileName,
        item.destinationPath
      ].some((value) => value.toLowerCase().includes(search));
    });
  }, [libraryItems, libraryKind, librarySearch, selectedLibraryCreator]);
  const libraryCreators = useMemo(() => {
    const creatorMap = new Map<string, {
      name: string;
      count: number;
      installed: number;
      missing: number;
      thumbnailUrl: string | null;
    }>();
    for (const item of libraryItems) {
      const existing = creatorMap.get(item.creatorName) || {
        name: item.creatorName,
        count: 0,
        installed: 0,
        missing: 0,
        thumbnailUrl: null
      };
      existing.count++;
      if (item.installed) {
        existing.installed++;
      }
      if (item.missing) {
        existing.missing++;
      }
      if (!existing.thumbnailUrl && item.thumbnailUrl) {
        existing.thumbnailUrl = item.thumbnailUrl;
      }
      creatorMap.set(item.creatorName, existing);
    }
    return [...creatorMap.values()].sort((a, b) => {
      return b.count - a.count || a.name.localeCompare(b.name);
    });
  }, [libraryItems]);
  const libraryPageCount = Math.max(
    1,
    Math.ceil(filteredLibraryItems.length / LIBRARY_PAGE_SIZE)
  );
  const clampedLibraryPage = Math.min(libraryPage, libraryPageCount);
  const pagedLibraryItems = useMemo(() => {
    const start = (clampedLibraryPage - 1) * LIBRARY_PAGE_SIZE;
    return filteredLibraryItems.slice(start, start + LIBRARY_PAGE_SIZE);
  }, [clampedLibraryPage, filteredLibraryItems]);
  useEffect(() => {
    setLibraryPage(1);
  }, [libraryKind, librarySearch, selectedLibraryCreator]);
  useEffect(() => {
    if (libraryPage > libraryPageCount) {
      setLibraryPage(libraryPageCount);
    }
  }, [libraryPage, libraryPageCount]);
  const installedLibraryCount = useMemo(
    () => libraryItems.filter((item) => item.installed).length,
    [libraryItems]
  );
  const missingLibraryCount = useMemo(
    () => libraryItems.filter((item) => item.missing).length,
    [libraryItems]
  );
  const libraryCreatorsCount = useMemo(
    () => new Set(libraryItems.map((item) => item.creatorName)).size,
    [libraryItems]
  );

  const renderJobActions = (job: DownloadCenterJobInfo) => {
    const canStart =
      ["pending", "queued", "confirmRequired", "paused"].includes(job.status);
    const canPause =
      job.status === "running" ||
      job.status === "queued" ||
      job.status === "confirmRequired";
    const canStop =
      job.status === "running" ||
      job.status === "queued" ||
      job.status === "confirmRequired" ||
      job.status === "paused";
    const canDelete = job.status !== "running";
    const canInstall = job.status === "completed" && !!job.outDir;

    return (
      <div className="d-flex gap-1">
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={!canStart}
          onClick={() => window.mainAPI.invoke("resumeDownload", job.id)}
          title="Start / resume"
        >
          <span className="material-symbols-outlined">play_arrow</span>
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={!canPause}
          onClick={() => window.mainAPI.invoke("pauseDownload", job.id)}
          title="Pause"
        >
          <span className="material-symbols-outlined">pause</span>
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={!canStop}
          onClick={() => window.mainAPI.invoke("stopDownload", job.id)}
          title="Stop"
        >
          <span className="material-symbols-outlined">stop</span>
        </Button>
        <Button
          size="sm"
          variant="outline-danger"
          disabled={!canDelete}
          onClick={() => window.mainAPI.invoke("removeDownload", job.id)}
          title="Delete from list"
        >
          <span className="material-symbols-outlined">delete</span>
        </Button>
        <Button
          size="sm"
          variant="outline-success"
          disabled={!canInstall || simsBusy}
          onClick={() => void installSimsOutput(job.outDir)}
          title="Install Sims files from this output folder"
        >
          <span className="material-symbols-outlined">inventory_2</span>
        </Button>
      </div>
    );
  };

  const renderJobsTab = () => (
    <>
      <div className="pd-panel-header mb-3">
        <div>
          <div className="pd-eyebrow">Queue</div>
          <h2>Download Center</h2>
        </div>
        <div className="pd-action-row">
          <Button size="sm" variant="outline-secondary" onClick={startAll}>
            <span className="material-symbols-outlined">play_arrow</span>
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={pauseAll}>
            <span className="material-symbols-outlined">pause</span>
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={stopAll}>
            <span className="material-symbols-outlined">stop</span>
          </Button>
          <Button size="sm" variant="outline-danger" onClick={clearFinished}>
            Clear finished
          </Button>
        </div>
      </div>
      <div className="pd-stat-grid mb-3">
        <div className="pd-stat">
          <span className="pd-stat-label">Running</span>
          <strong>{runningCount}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Queued</span>
          <strong>{queuedCount}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Complete</span>
          <strong>{completedCount}</strong>
        </div>
        <div className={`pd-stat ${problemCount > 0 ? "pd-stat-alert" : ""}`}>
          <span className="pd-stat-label">Needs attention</span>
          <strong>{problemCount}</strong>
        </div>
      </div>
      {totalCount > 0 ?
        <div className="mb-3">
          <div className="d-flex justify-content-between small text-muted mb-1">
            <span>{completedCount} of {totalCount} jobs complete</span>
            <span>{completePercent}%</span>
          </div>
          <ProgressBar now={completePercent} variant={problemCount > 0 ? "warning" : "info"} />
        </div>
      : null}
      {jobs.length === 0 ? (
        <div className="pd-empty-state">
          <span className="material-symbols-outlined">download</span>
          <div>No downloads in the queue.</div>
        </div>
      ) : (
        <Table hover size="sm" variant="dark" className="mb-0 pd-job-table">
          <thead>
            <tr>
              <th style={{ width: "1%" }}></th>
              <th>Creator / Target</th>
              <th>Status</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <Fragment key={job.id}>
                <tr>
                  <td>
                    <Button
                      size="sm"
                      variant="link"
                      className="p-0 text-light"
                      onClick={() => toggleExpanded(job.id)}
                    >
                      <span className="material-symbols-outlined">
                        {expandedJobIds.has(job.id) ?
                          "expand_less"
                        : "expand_more"}
                      </span>
                    </Button>
                  </td>
                  <td>
                    <div className="fw-semibold">{job.targetDesc}</div>
                    <div className="small text-muted text-truncate" style={{ maxWidth: "240px" }}>
                      {job.targetURL}
                    </div>
                    {job.error ?
                      <div className="small text-danger">{job.error}</div>
                    : null}
                  </td>
                  <td>
                    <Badge
                      bg={getStatusVariant(job.status)}
                      className={job.status === "running" ? "pd-status-running" : ""}
                    >
                      {job.status === "running" ?
                        <>
                          <Spinner
                            as="span"
                            animation="border"
                            size="sm"
                            role="status"
                            aria-hidden="true"
                            className="me-1"
                          />
                          running
                        </>
                      : getStatusLabel(job.status)}
                    </Badge>
                  </td>
                  <td className="text-nowrap">{formatTime(job.startTime)}</td>
                  <td className="text-nowrap">{formatTime(job.endTime)}</td>
                  <td>{renderJobActions(job)}</td>
                </tr>
                <tr>
                  <td colSpan={6} className="p-0">
                    <Collapse in={expandedJobIds.has(job.id)}>
                      <div>
                        <div
                          className="bg-black text-light font-monospace p-2 overflow-auto log-viewer"
                          style={{ maxHeight: "200px", whiteSpace: "pre-wrap" }}
                        >
                          {job.logs.length === 0 ?
                            <span className="text-muted">No messages yet.</span>
                          : job.logs.map((log, index) => (
                              <div
                                key={`${job.id}-log-${index}`}
                                dangerouslySetInnerHTML={{ __html: log.text }}
                              />
                            ))}
                        </div>
                      </div>
                    </Collapse>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );

  const renderExternalLinksTab = () => (
    <>
      <div className="pd-panel-header mb-3">
        <div>
          <div className="pd-eyebrow">Creator Library</div>
          <h2>External Links</h2>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={refreshCreators}
          disabled={creatorsLoading || !outDir}
        >
          {creatorsLoading ?
            <Spinner animation="border" size="sm" />
          : <span className="material-symbols-outlined">refresh</span>}
        </Button>
      </div>
      <div className="pd-stat-grid mb-3">
        <div className="pd-stat">
          <span className="pd-stat-label">Creators</span>
          <strong>{creators.length}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Needs repair</span>
          <strong>{creatorsNeedingRepair}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">External links</span>
          <strong>{totalExternalLinks}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Selected</span>
          <strong>{selectedCreatorIds.size}</strong>
        </div>
      </div>
      {!outDir ?
        <div className="pd-empty-state mb-2">
          Set a destination folder in the Output tab to see downloaded creators.
        </div>
      : null}
      {creators.length === 0 && outDir && !creatorsLoading ?
        <div className="pd-empty-state mb-2">
          No creators found in the patreon-dl database at{" "}
          <code>{outDir}/.patreon-dl/db.sqlite</code>. Download a creator
          first, then come back here.
        </div>
      : null}
      {creators.length > 0 ?
        <div className="pd-creator-list mb-3">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <div className="small text-muted">
              {selectedCreatorIds.size} of {creators.length} selected
            </div>
            <div className="d-flex gap-1">
              <Button
                size="sm"
                variant="outline-light"
                onClick={selectAll}
                disabled={selectedCreatorIds.size === creators.length}
              >
                Select all
              </Button>
              <Button
                size="sm"
                variant="outline-light"
                onClick={clearSelection}
                disabled={selectedCreatorIds.size === 0}
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="pd-creator-grid">
            {creators.map((c) => (
              <label
                key={c.id}
                htmlFor={`creator-${c.id}`}
                className={`pd-creator-card ${selectedCreatorIds.has(c.id) ? "is-selected" : ""}`}
              >
                <Form.Check.Input
                  id={`creator-${c.id}`}
                  type="checkbox"
                  checked={selectedCreatorIds.has(c.id)}
                  onChange={() => toggleCreatorSelected(c.id)}
                />
                <div className="pd-creator-main">
                  <div className="pd-creator-name">{c.name}</div>
                  <div className="pd-creator-meta">
                    {formatPostCount(c)} · {c.filesPresent}/{c.mediaFileCount} file{c.mediaFileCount === 1 ? "" : "s"} present · {formatDate(c.lastPublishedAt)}
                  </div>
                </div>
                <div className="pd-creator-badges">
                  <Badge bg={getCreatorStatusVariant(c.status)}>
                    {getCreatorStatusLabel(c.status)}
                  </Badge>
                  {c.filesMissing > 0 ?
                    <span className="small text-danger">
                      {c.filesMissing} missing
                    </span>
                  : null}
                  {c.hasExternalLinks ?
                    <>
                      <Badge bg="success">
                        {c.totalLinks} link{c.totalLinks === 1 ? "" : "s"}
                      </Badge>
                      <span className="small text-info">
                        {c.postsWithLinks} post{c.postsWithLinks === 1 ? "" : "s"}
                      </span>
                    </>
                  : <Badge bg="secondary">no links</Badge>}
                  <div className="pd-creator-actions">
                    {c.campaignFolder ?
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        title="Open creator folder"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const folder = c.campaignFolder;
                          if (!folder) {
                            return;
                          }
                          window.mainAPI.invoke(
                            "openInFileManager",
                            folder
                          );
                        }}
                      >
                        <span className="material-symbols-outlined">folder_open</span>
                      </Button>
                    : null}
                    {c.status === "needsRepair" ?
                      <Button
                        size="sm"
                        variant="outline-warning"
                        disabled={repairingCreatorId === c.id}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void repairCreator(c);
                        }}
                      >
                        {repairingCreatorId === c.id ?
                          <Spinner animation="border" size="sm" />
                        : <span className="material-symbols-outlined">build</span>}
                      </Button>
                    : null}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      : null}
      <div className="mb-2">
        <Form.Label className="small mb-1">Save to folder</Form.Label>
        <div className="d-flex gap-1">
          <Form.Control
            type="text"
            value={targetFolder}
            onChange={(e) => setTargetFolder(e.target.value)}
            placeholder="Pick a folder..."
            readOnly
          />
          <Button
            variant="secondary"
            onClick={browseForFolder}
            disabled={!outDir}
          >
            Browse...
          </Button>
          <Button
            variant="outline-secondary"
            onClick={openTargetFolder}
            disabled={!targetFolder}
            title="Open the chosen folder in the system file manager"
          >
            Open
          </Button>
        </div>
      </div>
      <div className="d-flex justify-content-end mb-2">
        <Button
          variant="outline-danger"
          className="me-2"
          onClick={clearExternalLinks}
          disabled={clearingExternalLinks || !outDir}
        >
          {clearingExternalLinks ?
            <Spinner animation="border" size="sm" />
          : "Clear creator library"}
        </Button>
        <Button
          variant="success"
          onClick={createExternalLinks}
          disabled={
            exporting ||
            !outDir ||
            !targetFolder ||
            selectedCreatorIds.size === 0
          }
        >
          {exporting ?
            <Spinner animation="border" size="sm" />
          : `Create external-links file(s) (${selectedCreatorIds.size})`}
        </Button>
      </div>
      {exportStatus ?
        <div className="small text-info">{exportStatus}</div>
      : null}
    </>
  );

  const renderSimsModsTab = () => (
    <>
      <div className="pd-panel-header mb-3">
        <div>
          <div className="pd-eyebrow">Post Processing</div>
          <h2>Sims Mods</h2>
        </div>
        <div className="pd-action-row">
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => void scanSimsOutput()}
            disabled={!outDir || simsBusy}
          >
            {simsBusy ?
              <Spinner animation="border" size="sm" />
            : <span className="material-symbols-outlined">search</span>}
          </Button>
          <Button
            size="sm"
            variant="success"
            onClick={() => void installSimsOutput()}
            disabled={!outDir || simsBusy}
          >
            Install found files
          </Button>
        </div>
      </div>
      {!outDir ?
        <div className="pd-empty-state mb-2">
          Set a destination folder in the Download box before scanning.
        </div>
      : null}
      <div className="pd-stat-grid mb-3">
        <div className="pd-stat">
          <span className="pd-stat-label">Found</span>
          <strong>{simsScan ? simsScan.candidates.length : 0}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Archives</span>
          <strong>{simsScan ? simsScan.archives : 0}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Installed</span>
          <strong>{simsInstallResult ? simsInstallResult.installed.length : 0}</strong>
        </div>
        <div className={`pd-stat ${(simsInstallResult?.errors.length || simsScan?.errors.length) ? "pd-stat-alert" : ""}`}>
          <span className="pd-stat-label">Errors</span>
          <strong>{simsInstallResult ? simsInstallResult.errors.length : simsScan ? simsScan.errors.length : 0}</strong>
        </div>
      </div>
      <div className="pd-sims-paths mb-3">
        <div>
          <span>Source</span>
          <code>{outDir || "--"}</code>
        </div>
        <div>
          <span>Mods</span>
          <code>{simsSettings?.libraryDir || "--"}</code>
        </div>
        <div>
          <span>Tray</span>
          <code>{simsSettings?.trayDir || "--"}</code>
        </div>
      </div>
      {simsStatus ?
        <div className={`small mb-2 text-${simsStatus.type === "error" ? "danger" : simsStatus.type === "success" ? "success" : "info"}`}>
          {simsStatus.text}
        </div>
      : null}
      <div className="small text-muted mb-2">
        {formatSimsCandidateCount(simsScan)}
      </div>
      {simsScan && simsScan.candidates.length > 0 ?
        <Table hover size="sm" variant="dark" className="mb-0 pd-job-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {simsScan.candidates.slice(0, 80).map((candidate) => (
              <tr key={candidate.sourceKey}>
                <td>{candidate.fileName}</td>
                <td>
                  <Badge bg={candidate.kind === "tray" ? "warning" : "info"}>
                    {candidate.kind === "tray" ? "Tray" : "Mods"}
                  </Badge>
                </td>
                <td className="small text-muted">
                  {candidate.fromArchive ?
                    `Archive: ${candidate.relativePath}`
                  : candidate.relativePath}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      : null}
      {simsScan && simsScan.candidates.length > 80 ?
        <div className="small text-muted mt-2">
          Showing 80 of {simsScan.candidates.length} files.
        </div>
      : null}
      {simsInstallResult && simsInstallResult.errors.length > 0 ?
        <div className="mt-2 small text-danger">
          {simsInstallResult.errors.slice(0, 5).join("; ")}
        </div>
      : null}
      {!simsInstallResult && simsScan && simsScan.errors.length > 0 ?
        <div className="mt-2 small text-danger">
          {simsScan.errors.slice(0, 5).join("; ")}
        </div>
      : null}
    </>
  );

  const renderLibraryTab = () => (
    <>
      <div className="pd-panel-header mb-3">
        <div>
          <div className="pd-eyebrow">Installed Content</div>
          <h2>Library</h2>
        </div>
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={() => void refreshLibrary()}
          disabled={libraryLoading}
        >
          {libraryLoading ?
            <Spinner animation="border" size="sm" />
          : <span className="material-symbols-outlined">refresh</span>}
        </Button>
      </div>
      <div className="pd-stat-grid mb-3">
        <div className="pd-stat">
          <span className="pd-stat-label">Installed</span>
          <strong>{installedLibraryCount}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Creators</span>
          <strong>{libraryCreatorsCount}</strong>
        </div>
        <div className="pd-stat">
          <span className="pd-stat-label">Shown</span>
          <strong>{filteredLibraryItems.length}</strong>
        </div>
        <div className={`pd-stat ${missingLibraryCount > 0 ? "pd-stat-alert" : ""}`}>
          <span className="pd-stat-label">Missing</span>
          <strong>{missingLibraryCount}</strong>
        </div>
      </div>
      <div className="pd-library-toolbar mb-3">
        <Form.Control
          type="text"
          value={librarySearch}
          onChange={(event) => setLibrarySearch(event.target.value)}
          placeholder="Search creator, post, or file"
        />
        <Form.Select
          value={libraryKind}
          onChange={(event) =>
            setLibraryKind(event.target.value as typeof libraryKind)
          }
        >
          <option value="all">All</option>
          <option value="mods">Mods</option>
          <option value="tray">Tray</option>
          <option value="missing">Missing</option>
        </Form.Select>
      </div>
      <div className="pd-library-creators mb-3">
        <button
          type="button"
          className={`pd-library-creator-chip ${selectedLibraryCreator === null ? "is-selected" : ""}`}
          onClick={() => setSelectedLibraryCreator(null)}
        >
          <span className="pd-library-creator-avatar">
            <span className="material-symbols-outlined">groups</span>
          </span>
          <span className="pd-library-creator-chip-main">
            <span>All creators</span>
            <small>{libraryItems.length} item{libraryItems.length === 1 ? "" : "s"}</small>
          </span>
        </button>
        {libraryCreators.map((creator) => (
          <button
            type="button"
            key={creator.name}
            className={`pd-library-creator-chip ${selectedLibraryCreator === creator.name ? "is-selected" : ""}`}
            onClick={() => setSelectedLibraryCreator(creator.name)}
          >
            <span className="pd-library-creator-avatar">
              {creator.thumbnailUrl ?
                <img src={creator.thumbnailUrl} alt="" />
              : <span className="material-symbols-outlined">person</span>}
            </span>
            <span className="pd-library-creator-chip-main">
              <span title={creator.name}>{creator.name}</span>
              <small>
                {creator.count} item{creator.count === 1 ? "" : "s"}
                {creator.missing > 0 ? `, ${creator.missing} missing` : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
      {selectedLibraryCreator ?
        <div className="pd-library-selection mb-3">
          <span>
            Showing downloads for <strong>{selectedLibraryCreator}</strong>
          </span>
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => setSelectedLibraryCreator(null)}
          >
            Clear
          </Button>
        </div>
      : null}
      {filteredLibraryItems.length === 0 ?
        <div className="pd-empty-state">
          <span className="material-symbols-outlined">inventory_2</span>
          <div>No installed Patreon content matches this view.</div>
        </div>
      : <>
        <div className="pd-library-grid">
          {pagedLibraryItems.map((item) => (
            <div key={item.id} className={`pd-library-card ${item.missing ? "is-missing" : ""}`}>
              <div className="pd-library-thumb">
                {item.thumbnailUrl ?
                  <img src={item.thumbnailUrl} alt="" />
                : <span className="material-symbols-outlined">image</span>}
              </div>
              <div className="pd-library-body">
                <div className="pd-library-title" title={item.displayName}>
                  {item.displayName}
                </div>
                <div className="pd-library-creator" title={item.creatorName}>
                  {item.creatorName}
                </div>
                <div className="pd-library-post" title={item.postTitle}>
                  {item.postTitle}
                </div>
                <div className="pd-library-meta">
                  <Badge bg={item.kind === "tray" ? "warning" : "info"}>
                    {item.kind === "tray" ? "Tray" : "Mods"}
                  </Badge>
                  {item.fromArchive ?
                    <Badge bg="secondary">Archive</Badge>
                  : null}
                  <Badge bg={item.missing ? "danger" : "success"}>
                    {item.missing ? "Missing" : "Installed"}
                  </Badge>
                </div>
              </div>
              <div className="pd-library-actions">
                <Button
                  size="sm"
                  variant="outline-secondary"
                  title="Open installed folder"
                  onClick={() =>
                    window.mainAPI.invoke(
                      "openInFileManager",
                      item.destinationPath.split("/").slice(0, -1).join("/") || item.destinationPath
                    )
                  }
                >
                  <span className="material-symbols-outlined">folder_open</span>
                </Button>
                {item.postUrl ?
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    title="Open Patreon post"
                    onClick={() =>
                      window.mainAPI.invoke("openExternalBrowser", item.postUrl || "")
                    }
                  >
                    <span className="material-symbols-outlined">open_in_new</span>
                  </Button>
                : null}
              </div>
            </div>
          ))}
        </div>
        <div className="pd-library-pagination mt-3">
          <div className="small text-muted">
            Showing {(clampedLibraryPage - 1) * LIBRARY_PAGE_SIZE + 1}
            {" - "}
            {Math.min(clampedLibraryPage * LIBRARY_PAGE_SIZE, filteredLibraryItems.length)}
            {" of "}
            {filteredLibraryItems.length}
          </div>
          <div className="pd-action-row">
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={clampedLibraryPage <= 1}
              onClick={() => setLibraryPage(1)}
              title="First page"
            >
              <span className="material-symbols-outlined">first_page</span>
            </Button>
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={clampedLibraryPage <= 1}
              onClick={() => setLibraryPage((page) => Math.max(1, page - 1))}
              title="Previous page"
            >
              <span className="material-symbols-outlined">chevron_left</span>
            </Button>
            <span className="pd-page-label">
              Page {clampedLibraryPage} of {libraryPageCount}
            </span>
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={clampedLibraryPage >= libraryPageCount}
              onClick={() =>
                setLibraryPage((page) => Math.min(libraryPageCount, page + 1))
              }
              title="Next page"
            >
              <span className="material-symbols-outlined">chevron_right</span>
            </Button>
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={clampedLibraryPage >= libraryPageCount}
              onClick={() => setLibraryPage(libraryPageCount)}
              title="Last page"
            >
              <span className="material-symbols-outlined">last_page</span>
            </Button>
          </div>
        </div>
      </>}
    </>
  );

  return (
    <div className="pd-download-center">
      <Tabs
        activeKey={activeTab}
        onSelect={(k) => setActiveTab(k || "jobs")}
        className="mb-2"
        variant="pills"
      >
        <Tab eventKey="jobs" title="Jobs">
          {renderJobsTab()}
        </Tab>
        <Tab eventKey="external-links" title="External Links">
          {renderExternalLinksTab()}
        </Tab>
        <Tab eventKey="sims-mods" title="Sims Mods">
          {renderSimsModsTab()}
        </Tab>
        <Tab eventKey="library" title="Library">
          {renderLibraryTab()}
        </Tab>
      </Tabs>
    </div>
  );
}

export default DownloadCenter;
