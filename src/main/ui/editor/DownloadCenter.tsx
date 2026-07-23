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

const MAX_INLINE_LOGS = 100;

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

  useEffect(() => {
    refreshJobs();
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
  }, [refreshJobs]);

  // Whenever the user switches to the External Links tab, refresh the
  // creator list from the DB.
  const [activeTab, setActiveTab] = useState<string>("jobs");
  useEffect(() => {
    if (activeTab === "external-links") {
      void refreshCreators();
    }
  }, [activeTab, refreshCreators]);

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
  const totalExternalLinks = useMemo(
    () => creators.reduce((sum, creator) => sum + creator.totalLinks, 0),
    [creators]
  );
  const creatorsNeedingRepair = useMemo(
    () => creators.filter((creator) => creator.status === "needsRepair").length,
    [creators]
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
      </Tabs>
    </div>
  );
}

export default DownloadCenter;
