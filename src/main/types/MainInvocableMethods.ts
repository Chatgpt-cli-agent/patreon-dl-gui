import type { OpenDialogOptions } from "electron";
import type { Editor } from "./App";
import type { UIConfig, UIConfigSection } from "./UIConfig";
import type { SaveFileConfigResult } from "./MainEvents";
import type { WebBrowserSettings } from "../config/WebBrowserSettings";
import type { FSChooserResult } from "../../common/util/FS";
import type { DownloadCenterJobInfo } from "./DownloadCenter";
import type {
  SimsInstallResult,
  SimsInstallSettings,
  SimsLibraryItem,
  SimsScanResult
} from "../util/SimsContentInstaller";

export type MainProcessInvocableMethod =
  | "getEditorPanelWidth"
  | "newEditor"
  | "closeEditor"
  | "openFile"
  | "save"
  | "saveAs"
  | "preview"
  | "saveCurrentConfigAsDefault"
  | "resetDefaultConfig"
  | "openFSChooser"
  | "applyProxy"
  | "requestHelp"
  | "requestAboutInfo"
  | "openExternalBrowser"
  | "setWebBrowserURL"
  | "setWebBrowserURLToHome"
  | "webBrowserBack"
  | "webBrowserForward"
  | "webBrowserReload"
  | "startDownload"
  | "pauseDownload"
  | "stopDownload"
  | "resumeDownload"
  | "clearFinishedDownloads"
  | "getDownloadCenterJobs"
  | "listDownloadedCreators"
  | "exportCreatorExternalLinks"
  | "repairCreatorDownloadState"
  | "clearExternalLinkFiles"
  | "getSimsInstallSettings"
  | "scanSimsContent"
  | "installSimsContent"
  | "listSimsLibrary"
  | "openInFileManager"
  | "removeDownload"
  | "configureYouTube"
  | "startYouTubeConnect"
  | "cancelYouTubeConnect"
  | "disconnectYouTube"
  | "requestWebBrowserSettings"
  | "saveWebBrowserSettings"
  | "clearSessionData";

export type MainProcessInvocableMethodHandler<
  M extends MainProcessInvocableMethod
> =
  M extends "getEditorPanelWidth" ? () => number
  : M extends "newEditor" ? () => void
  : M extends "closeEditor" ? (editor: Editor) => Promise<CloseEditorResult>
  : M extends "openFile" ?
    (currentEditors: Editor[], filePath?: string) => Promise<OpenFileResult>
  : M extends "save" ? (editor: Editor) => Promise<SaveFileConfigResult>
  : M extends "saveAs" ? (editor: Editor) => Promise<SaveFileConfigResult>
  : M extends "saveCurrentConfigAsDefault" ? (editor: Editor) => { success: boolean; }
  : M extends "resetDefaultConfig" ? () => { success: boolean; }
  : M extends "preview" ? (editor: Editor) => void
  : M extends "openFSChooser" ?
    (dialogOptions: OpenDialogOptions) => Promise<FSChooserResult>
  : M extends "applyProxy" ? (editor: Editor) => void
  : M extends "requestHelp" ?
    <S extends UIConfigSection>(section: S, prop: keyof UIConfig[S]) => void
  : M extends "requestAboutInfo" ? () => void
  : M extends "openExternalBrowser" ? (url: string) => void
  : M extends "setWebBrowserURL" ? (url: string) => void
  : M extends "setWebBrowserURLToHome" ? () => void
  : M extends "webBrowserBack" ? () => void
  : M extends "webBrowserForward" ? () => void
  : M extends "webBrowserReload" ? () => void
  : M extends "startDownload" ? (editor: Editor) => Promise<string>
  : M extends "pauseDownload" ? (jobId: string) => void
  : M extends "stopDownload" ? (jobId: string) => void
  : M extends "resumeDownload" ? (jobId: string) => void
  : M extends "clearFinishedDownloads" ? () => void
  : M extends "getDownloadCenterJobs" ? () => DownloadCenterJobInfo[]
  : M extends "listDownloadedCreators" ?
    (outDir: string) => Array<{
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
    }>
  : M extends "exportCreatorExternalLinks" ?
    (outDir: string, creatorIds: string[], targetFolder: string) =>
      Promise<{
        filesWritten: string[];
        filesSkipped: string[];
        errors: string[];
      }>
  : M extends "repairCreatorDownloadState" ?
    (outDir: string, creatorId: string) => {
      success: boolean;
      creatorId: string;
      creatorName: string | null;
      creatorURL: string | null;
      campaignFolder: string | null;
      deletedRows: Record<string, number>;
      removedFiles: string[];
      errors: string[];
    }
  : M extends "clearExternalLinkFiles" ?
    (outDir: string, targetFolder?: string | null) => {
      removedFiles: string[];
      deletedRows: Record<string, number>;
      errors: string[];
    }
  : M extends "getSimsInstallSettings" ? () => SimsInstallSettings
  : M extends "scanSimsContent" ? (sourceRoot: string) => Promise<SimsScanResult>
  : M extends "installSimsContent" ?
    (sourceRoot: string) => Promise<SimsInstallResult>
  : M extends "listSimsLibrary" ? () => SimsLibraryItem[]
  : M extends "openInFileManager" ? (folder: string) => void
  : M extends "removeDownload" ? (jobId: string) => void
  : M extends "configureYouTube" ? () => void
  : M extends "startYouTubeConnect" ? () => void
  : M extends "cancelYouTubeConnect" ? () => void
  : M extends "disconnectYouTube" ? () => void
  : M extends "requestWebBrowserSettings" ? () => void
  : M extends "saveWebBrowserSettings" ?
    (settings: WebBrowserSettings) => Promise<void>
  : M extends "clearSessionData" ? () => void
  : never;

export type CloseEditorResult =
  | {
      canceled: true;
    }
  | {
      canceled: false;
      editor: Editor;
    };

export type OpenFileResult =
  | {
      canceled: true;
      hasError?: undefined;
      editor?: undefined;
      isNewEditor?: undefined;
    }
  | {
      canceled?: undefined;
      hasError: true;
      editor?: undefined;
      isNewEditor?: undefined;
    }
  | {
      canceled?: undefined;
      hasError?: undefined;
      editor: Editor;
      isNewEditor: boolean;
    };
