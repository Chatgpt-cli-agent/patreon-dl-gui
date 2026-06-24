import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Collapse,
  Spinner,
  Table,
  Tabs,
  Tab
} from "react-bootstrap";
import { useConfig } from "../contexts/ConfigProvider";
import type {
  DownloadCenterJobInfo,
  DownloadCenterLogEntry,
  DownloadJobStatus,
  ExternalLinkGroup
} from "../../types/DownloadCenter";

const MAX_INLINE_LOGS = 100;

function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return "--";
  }
  return new Date(timestamp).toLocaleTimeString();
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

function DownloadCenter() {
  const [jobs, setJobs] = useState<DownloadCenterJobInfo[]>([]);
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const [externalLinks, setExternalLinks] = useState<ExternalLinkGroup[]>([]);
  const [externalLinksLoading, setExternalLinksLoading] = useState(false);
  const { config } = useConfig();
  const outDir = config?.output["out.dir"] || "";

  const refreshJobs = useCallback(async () => {
    const currentJobs = await window.mainAPI.invoke("getDownloadCenterJobs");
    setJobs(currentJobs);
  }, []);

  const refreshExternalLinks = useCallback(async () => {
    if (!outDir) {
      setExternalLinks([]);
      return;
    }
    setExternalLinksLoading(true);
    try {
      const links = await window.mainAPI.invoke("getExternalLinks", outDir);
      setExternalLinks(links);
    } finally {
      setExternalLinksLoading(false);
    }
  }, [outDir]);

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

  const openExternalLink = useCallback((url: string) => {
    window.mainAPI.invoke("openExternalBrowser", url);
  }, []);

  const runningCount = useMemo(
    () => jobs.filter((job) => job.status === "running").length,
    [jobs]
  );
  const totalCount = jobs.length;

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
          variant="success"
          disabled={!canStart}
          onClick={() => window.mainAPI.invoke("resumeDownload", job.id)}
          title="Start / resume"
        >
          <span className="material-symbols-outlined">play_arrow</span>
        </Button>
        <Button
          size="sm"
          variant="warning"
          disabled={!canPause}
          onClick={() => window.mainAPI.invoke("pauseDownload", job.id)}
          title="Pause"
        >
          <span className="material-symbols-outlined">pause</span>
        </Button>
        <Button
          size="sm"
          variant="danger"
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
      <div className="d-flex justify-content-between align-items-center mb-2">
        <div className="d-flex gap-2 align-items-center">
          <span className="fw-bold">Download Center</span>
          <Badge bg="secondary">
            {runningCount} running / {totalCount} total
          </Badge>
        </div>
        <div className="d-flex gap-1">
          <Button size="sm" variant="success" onClick={startAll}>
            Start all
          </Button>
          <Button size="sm" variant="warning" onClick={pauseAll}>
            Pause all
          </Button>
          <Button size="sm" variant="danger" onClick={stopAll}>
            Stop all
          </Button>
          <Button size="sm" variant="outline-danger" onClick={clearFinished}>
            Clear finished
          </Button>
        </div>
      </div>
      {jobs.length === 0 ? (
        <div className="text-muted fst-italic">
          No downloads. Use the toolbar play button to add the current creator to
          the Download Center.
        </div>
      ) : (
        <Table striped bordered hover size="sm" variant="dark" className="mb-0">
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
      <div className="d-flex justify-content-between align-items-center mb-2">
        <span className="fw-bold">External Links</span>
        <Button
          size="sm"
          variant="primary"
          onClick={refreshExternalLinks}
          disabled={externalLinksLoading || !outDir}
        >
          {externalLinksLoading ?
            <Spinner animation="border" size="sm" />
          : "Refresh"}
        </Button>
      </div>
      {!outDir ?
        <div className="text-muted fst-italic">
          Set a destination folder in the Output tab to scan for external links.
        </div>
      : externalLinks.length === 0 ?
        <div className="text-muted fst-italic">
          No <code>_external-links.html</code> files found under the destination
          folder.
        </div>
      : (
        <div
          className="bg-black text-light p-2 overflow-auto"
          style={{ maxHeight: "300px" }}
        >
          {externalLinks.map((group) => (
            <div key={group.source} className="mb-3">
              <div className="text-info fw-semibold">{group.source}</div>
              <ul className="list-unstyled mb-0">
                {group.links.map((link, index) => (
                  <li key={`${group.source}-${index}`} className="my-1 external-link-item">
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-start text-decoration-none"
                      onClick={() => openExternalLink(link.url)}
                      title={link.url}
                    >
                      <span className="material-symbols-outlined small align-middle me-1">
                        open_in_new
                      </span>
                      <span className="align-middle">{link.title}</span>
                    </Button>
                    <div className="small text-muted text-break">{link.url}</div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="pd-download-center">
      <Tabs defaultActiveKey="jobs" className="mb-2" variant="pills">
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
