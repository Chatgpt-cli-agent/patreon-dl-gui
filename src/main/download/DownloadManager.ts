import PatreonDownloader from "patreon-dl";
import { convertUIConfigToPatreonDLOptions } from "../Downloader";
import type DownloaderConsoleLogger from "../DownloaderConsoleLogger";
import type { Editor } from "../types/App";
import type {
  DownloadCenterJobInfo,
  DownloadCenterLogEntry,
  DownloadJobStatus
} from "../types/DownloadCenter";
import type { UIConfig } from "../types/UIConfig";
import { convertUIConfigToFileContents } from "../config/FileConfig";
import { getErrorString } from "../../common/util/Misc";
import EventEmitter from "events";
import type { FileLogger, FileLoggerType } from "patreon-dl";
import { ExternalLinksCollector } from "../util/ExternalLinksWriter";
import {
  extractDownloadedArchive,
  extractDownloadedArchives
} from "../util/ArchiveExtractor";
import chokidar, { type FSWatcher } from "chokidar";

const MAX_LOG_ENTRIES = 500;
const DEFAULT_MAX_CONCURRENT = 20;

interface DownloadJobInitArgs {
  targetURL: string;
  bootstrapData: object | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  downloaderOptions: Record<string, any>;
  consoleLogger: DownloaderConsoleLogger;
  fileLogger: FileLogger<FileLoggerType.Downloader>;
  prompt: boolean;
}

interface DownloadJob {
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
  initArgs: DownloadJobInitArgs | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: PatreonDownloader<any> | null;
  abortController: AbortController | null;
  consoleLogger: DownloaderConsoleLogger | null;
}

type DownloadManagerEvent = "jobsUpdate" | "log";

export default class DownloadManager extends EventEmitter {
  #jobs: DownloadJob[] = [];
  #maxConcurrent: number;
  #queueCheckScheduled = false;
  #archiveWatchers = new Map<string, FSWatcher>();

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    super();
    this.#maxConcurrent = Math.max(1, maxConcurrent);
  }

  getJobs(): DownloadCenterJobInfo[] {
    return this.#jobs.map((job) => this.#toJobInfo(job));
  }

  getRunningJobs(): DownloadCenterJobInfo[] {
    return this.#jobs
      .filter((job) => job.status === "running")
      .map((job) => this.#toJobInfo(job));
  }

  getRunningCount(): number {
    return this.#jobs.filter((job) => job.status === "running").length;
  }

  async addJob(editor: Editor, userAgent: string): Promise<string> {
    const jobId = this.#createJobId();
    const targetURL =
      editor.config.downloader.target.browserValue?.value ||
      editor.config.downloader.target.manualValue ||
      "";
    const targetDesc =
      editor.config["support.data"].browserObtainedValues.target?.description ||
      targetURL ||
      "Unknown";

    const job: DownloadJob = {
      id: jobId,
      editorId: editor.id,
      name: editor.name,
      targetDesc,
      targetURL,
      outDir: this.#getOutDir(editor.config),
      status: "pending",
      error: null,
      startTime: null,
      endTime: null,
      logs: [],
      initArgs: null,
      instance: null,
      abortController: null,
      consoleLogger: null
    };

    this.#jobs.push(job);
    this.#watchArchiveRoot(job.outDir);
    this.#emitJobs();

    try {
      const {
        targetURL: resolvedTargetURL,
        bootstrapData,
        downloaderOptions,
        consoleLogger,
        fileLogger,
        prompt
      } = convertUIConfigToPatreonDLOptions(editor.config, {
        userAgent
      });

      job.initArgs = {
        targetURL: resolvedTargetURL,
        bootstrapData: bootstrapData as object | null,
        downloaderOptions,
        consoleLogger,
        fileLogger,
        prompt
      };
      job.consoleLogger = consoleLogger;

      const instance = await PatreonDownloader.getInstance(
        (bootstrapData || resolvedTargetURL) as Parameters<
          typeof PatreonDownloader.getInstance
        >[0],
        downloaderOptions
      );
      job.instance = instance;

      await this.#showDenoMissingWarningDialog(instance.getConfig());

      if (!prompt) {
        this.startJob(jobId);
      } else {
        job.status = "confirmRequired";
        this.#emitJobs();
      }
    } catch (error: unknown) {
      job.status = "error";
      job.error = getErrorString(error);
      this.#addLog(job, {
        text: `Failed to create downloader: ${job.error}`,
        level: "error"
      });
      this.#emitJobs();
    }

    return jobId;
  }

  startJob(jobId: string) {
    const job = this.#getJob(jobId);
    if (!job) {
      return;
    }
    if (
      !["pending", "queued", "confirmRequired", "paused"].includes(job.status)
    ) {
      return;
    }
    job.status = "queued";
    this.#processQueue();
    this.#emitJobs();
  }

  pauseJob(jobId: string) {
    const job = this.#getJob(jobId);
    if (!job) {
      return;
    }
    if (
      job.status !== "running" &&
      job.status !== "queued" &&
      job.status !== "confirmRequired"
    ) {
      return;
    }
    if (job.status === "running" && job.abortController) {
      job.abortController.abort();
    }
    job.status = "paused";
    this.#emitJobs();
  }

  stopJob(jobId: string) {
    const job = this.#getJob(jobId);
    if (!job) {
      return;
    }
    if (
      job.status !== "running" &&
      job.status !== "queued" &&
      job.status !== "confirmRequired" &&
      job.status !== "paused"
    ) {
      return;
    }
    if (job.abortController) {
      job.abortController.abort();
    }
    job.status = "aborted";
    job.endTime = Date.now();
    this.#addLog(job, {
      text: "Download stopped by user.",
      level: "warning"
    });
    this.#emitJobs();
    this.#processQueue();
  }

  clearFinished() {
    const terminalStatuses: DownloadJobStatus[] = [
      "completed",
      "error",
      "aborted"
    ];
    this.#jobs = this.#jobs.filter(
      (job) => !terminalStatuses.includes(job.status)
    );
    this.#emitJobs();
  }

  removeJob(jobId: string) {
    const job = this.#getJob(jobId);
    if (!job) {
      return;
    }
    if (job.status === "running" && job.abortController) {
      job.abortController.abort();
    }
    this.#jobs = this.#jobs.filter((j) => j.id !== jobId);
    this.#emitJobs();
  }

  abortAll() {
    this.#jobs
      .filter(
        (job) => job.status === "running" || job.status === "queued"
      )
      .forEach((job) => this.pauseJob(job.id));
  }

  async closeArchiveWatchers() {
    const watchers = [...this.#archiveWatchers.values()];
    this.#archiveWatchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  watchArchiveRoot(outDir: string) {
    this.#watchArchiveRoot(outDir);
  }

  on(event: DownloadManagerEvent, listener: (...args: unknown[]) => void) {
    return super.on(event, listener);
  }

  emit(event: DownloadManagerEvent, ...args: unknown[]) {
    return super.emit(event, ...args);
  }

  #getJob(jobId: string): DownloadJob | undefined {
    return this.#jobs.find((job) => job.id === jobId);
  }

  #createJobId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  #watchArchiveRoot(outDir: string) {
    if (!outDir || this.#archiveWatchers.has(outDir)) {
      return;
    }
    const watcher = chokidar.watch(outDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 200
      }
    });
    watcher.on("add", async (filePath) => {
      if (!/\.(?:zip|rar)$/i.test(filePath)) {
        return;
      }
      const result = await extractDownloadedArchive(filePath);
      const job = [...this.#jobs]
        .reverse()
        .find((candidate) => candidate.outDir === outDir);
      if (!job) {
        return;
      }
      if (result.status === "extracted") {
        this.#addLog(job, {
          text: `Automatically extracted archive without removing the original: ${result.archivePath} → ${result.destinationPath}`,
          level: "info"
        });
      } else if (result.status === "error") {
        this.#addLog(job, {
          text: `Archive extraction warning for ${result.archivePath}: ${result.error}`,
          level: "warning"
        });
      }
    });
    watcher.on("error", (error) => {
      console.error(`Archive watcher error for ${outDir}:`, error);
    });
    this.#archiveWatchers.set(outDir, watcher);
  }

  #getOutDir(config: UIConfig): string {
    try {
      const fileContents = convertUIConfigToFileContents(config, {
        userAgent: ""
      });
      return fileContents.output["out.dir"];
    } catch (error: unknown) {
      console.error(`Could not determine output dir: ${getErrorString(error)}`);
      return "";
    }
  }

  #processQueue() {
    if (this.#queueCheckScheduled) {
      return;
    }
    this.#queueCheckScheduled = true;
    process.nextTick(() => {
      this.#queueCheckScheduled = false;
      const running = this.getRunningCount();
      let slots = this.#maxConcurrent - running;
      if (slots <= 0) {
        return;
      }
      for (const job of this.#jobs) {
        if (slots <= 0) {
          break;
        }
        if (job.status === "queued") {
          slots--;
          this.#runJob(job);
        }
      }
    });
  }

  async #runJob(job: DownloadJob) {
    job.status = "running";
    if (!job.startTime) {
      job.startTime = Date.now();
    }
    job.endTime = null;
    this.#emitJobs();

    if (!job.instance && job.initArgs) {
      try {
        const { bootstrapData, targetURL, downloaderOptions } = job.initArgs;
        job.instance = await PatreonDownloader.getInstance(
          (bootstrapData || targetURL) as Parameters<
            typeof PatreonDownloader.getInstance
          >[0],
          downloaderOptions
        );
      } catch (error: unknown) {
        job.status = "error";
        job.error = getErrorString(error);
        job.endTime = Date.now();
        this.#addLog(job, {
          text: `Failed to start downloader: ${job.error}`,
          level: "error"
        });
        this.#emitJobs();
        this.#processQueue();
        return;
      }
    }

    if (!job.instance) {
      job.status = "error";
      job.error = "Downloader instance not available";
      job.endTime = Date.now();
      this.#emitJobs();
      this.#processQueue();
      return;
    }

    const abortController = new AbortController();
    job.abortController = abortController;

    const logListener = (message: { text: string; level: string }) => {
      this.#addLog(job, message);
    };
    job.consoleLogger?.on("message", logListener);

    const externalLinksCollector = new ExternalLinksCollector({
      outDir: job.outDir,
      log: (level, message) => {
        this.#addLog(job, { text: message, level });
      }
    });
    const detachExternalLinksCollector =
      externalLinksCollector.attach(job.instance);

    try {
      await job.instance.start({ signal: abortController.signal });
      if (
        (job.status as DownloadJobStatus) === "paused" ||
        (job.status as DownloadJobStatus) === "aborted"
      ) {
        return;
      }
      if (abortController.signal.aborted) {
        job.status = "aborted";
      } else {
        job.status = "completed";
      }
    } catch (error: unknown) {
      if (
        (job.status as DownloadJobStatus) === "paused" ||
        (job.status as DownloadJobStatus) === "aborted"
      ) {
        return;
      }
      if (abortController.signal.aborted) {
        job.status = "aborted";
      } else {
        job.status = "error";
        job.error = getErrorString(error);
        this.#addLog(job, {
          text: `Download error: ${job.error}`,
          level: "error"
        });
      }
    } finally {
      if ((job.status as DownloadJobStatus) !== "paused") {
        job.endTime = Date.now();
      }
      await externalLinksCollector.flushNow();
      if ((job.status as DownloadJobStatus) === "completed" && job.outDir) {
        const extractionResult = await extractDownloadedArchives(job.outDir);
        for (const entry of extractionResult.extracted) {
          this.#addLog(job, {
            text: `Extracted archive without removing the original: ${entry.archivePath} → ${entry.destinationPath}`,
            level: "info"
          });
        }
        for (const entry of extractionResult.errors) {
          this.#addLog(job, {
            text: `Archive extraction warning for ${entry.archivePath}: ${entry.error}`,
            level: "warning"
          });
        }
      }
      detachExternalLinksCollector();
      job.consoleLogger?.removeAllListeners();
      this.#emitJobs();
      this.#processQueue();
    }
  }

  #addLog(
    job: DownloadJob,
    message: { text: string; level: string }
  ) {
    const entry: DownloadCenterLogEntry = {
      text: message.text,
      level: message.level as DownloadCenterLogEntry["level"],
      time: Date.now()
    };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOG_ENTRIES) {
      job.logs.shift();
    }
    this.emit("log", { jobId: job.id, message: entry });
  }

  #emitJobs() {
    this.emit("jobsUpdate", this.getJobs());
  }

  onJobsUpdate(listener: (jobs: DownloadCenterJobInfo[]) => void) {
    return this.on("jobsUpdate", listener as (...args: unknown[]) => void);
  }

  onLog(
    listener: (payload: {
      jobId: string;
      message: DownloadCenterLogEntry;
    }) => void
  ) {
    return this.on("log", listener as (...args: unknown[]) => void);
  }

  #toJobInfo(job: DownloadJob): DownloadCenterJobInfo {
    return {
      id: job.id,
      editorId: job.editorId,
      name: job.name,
      targetDesc: job.targetDesc,
      targetURL: job.targetURL,
      outDir: job.outDir,
      status: job.status,
      error: job.error,
      startTime: job.startTime,
      endTime: job.endTime,
      logs: [...job.logs]
    };
  }

  async #showDenoMissingWarningDialog(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _config: ReturnType<PatreonDownloader<any>["getConfig"]>
  ) {
    // Deno is only relevant to the built-in YouTube embed downloader. This
    // build treats it as optional so normal Patreon post/file jobs are not
    // interrupted by a warning dialog on every session.
  }
}
