import type { MainProcessConstructor } from "../MainProcess";
import type { Editor } from "../types/App";
import { shell } from "electron";
import {
  clearExternalLinkFiles,
  exportCreatorExternalLinks,
  listDownloadedCreators,
  repairCreatorDownloadState
} from "../util/ExternalLinksExporter";

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

        this.handle("listDownloadedCreators", (outDir: string) => {
          return listDownloadedCreators(outDir);
        }),

        this.handle(
          "exportCreatorExternalLinks",
          (
            outDir: string,
            creatorIds: string[],
            targetFolder: string
          ) => {
            return exportCreatorExternalLinks({
              outDir,
              creatorIds,
              targetFolder
            });
          }
        ),

        this.handle(
          "repairCreatorDownloadState",
          (outDir: string, creatorId: string) => {
            return repairCreatorDownloadState(outDir, creatorId);
          }
        ),

        this.handle(
          "clearExternalLinkFiles",
          (outDir: string, targetFolder?: string | null) => {
            return clearExternalLinkFiles(outDir, targetFolder);
          }
        ),

        this.handle("openInFileManager", (folder: string) => {
          return shell.openPath(folder);
        }),

        this.handle("removeDownload", (jobId: string) => {
          this.downloadManager.removeJob(jobId);
        })
      ];
    }
  };
}
