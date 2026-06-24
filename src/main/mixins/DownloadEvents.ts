import type { MainProcessConstructor } from "../MainProcess";
import type { Editor } from "../types/App";
import { findExternalLinks } from "../util/ExternalLinks";

export function DownloadEventSupportMixin<TBase extends MainProcessConstructor>(
  Base: TBase
) {
  return class DownloadEventSupportedProcess extends Base {
    protected registerMainEventListeners() {
      const callbacks = super.registerMainEventListeners();

      this.downloadManager.onJobsUpdate((jobs) => {
        this.emitRendererEvent(
          this.win.editorView,
          "downloadCenter:jobsUpdate",
          jobs
        );
      });

      this.downloadManager.onLog((payload) => {
        this.emitRendererEvent(
          this.win.editorView,
          "downloadCenter:log",
          payload
        );
      });

      return [
        ...callbacks,

        this.handle("startDownload", (editor: Editor) => {
          return this.downloadManager.addJob(editor, this.resolvedUserAgent);
        }),

        this.handle("pauseDownload", (jobId: string) => {
          this.downloadManager.pauseJob(jobId);
        }),

        this.handle("stopDownload", (jobId: string) => {
          this.downloadManager.stopJob(jobId);
        }),

        this.handle("resumeDownload", (jobId: string) => {
          this.downloadManager.startJob(jobId);
        }),

        this.handle("clearFinishedDownloads", () => {
          this.downloadManager.clearFinished();
        }),

        this.handle("getDownloadCenterJobs", () => {
          return this.downloadManager.getJobs();
        }),

        this.handle("getExternalLinks", (outDir: string) => {
          return findExternalLinks(outDir);
        }),

        this.handle("removeDownload", (jobId: string) => {
          this.downloadManager.removeJob(jobId);
        })
      ];
    }
  };
}
