import DownloadBox from "./DownloadBox";
import IncludeBox from "./IncludeBox";
import OutputBox from "./OutputBox";
import EmbedsBox from "./EmbedsBox";
import LoggingBox from "./LoggingBox";
import OtherBox from "./OtherBox";
import AlertsBox from "./AlertsBox";
import { useEffect } from "react";
import { Tab, Tabs } from "react-bootstrap";
import { useCommands } from "../contexts/CommandsProvider";
import NetworkBox from "./NetworkBox";
import DownloadCenter from "./DownloadCenter";

function EditorPanel() {
  const { closeActiveEditor } = useCommands();

  useEffect(() => {
    const closeEditorKeyListener = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        closeActiveEditor();
      }
    };
    window.addEventListener("keyup", closeEditorKeyListener);

    return () => {
      window.removeEventListener("keyup", closeEditorKeyListener);
    };
  }, [closeActiveEditor]);

  return (
    <div className="pd-control-panel">
      <AlertsBox />
      <DownloadBox />
      <Tabs
        className="w-100 mt-3 pd-editor-sections"
        defaultActiveKey="editor-include"
      >
        <Tab
          eventKey="editor-include"
          title={
            <>
              <span className="material-symbols-outlined">filter_alt</span>
              <span>Include</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <IncludeBox />
        </Tab>
        <Tab
          eventKey="editor-profile"
          title={
            <>
              <span className="material-symbols-outlined">folder_open</span>
              <span>Output</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <OutputBox />
        </Tab>
        <Tab
          eventKey="editor-embeds"
          title={
            <>
              <span className="material-symbols-outlined">smart_display</span>
              <span>Embeds</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <EmbedsBox />
        </Tab>
        <Tab
          eventKey="editor-network"
          title={
            <>
              <span className="material-symbols-outlined">language</span>
              <span>Network</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <NetworkBox />
        </Tab>
        <Tab
          eventKey="editor-logging"
          title={
            <>
              <span className="material-symbols-outlined">terminal</span>
              <span>Logging</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <LoggingBox />
        </Tab>
        <Tab
          eventKey="editor-other"
          title={
            <>
              <span className="material-symbols-outlined">tune</span>
              <span>Other</span>
            </>
          }
          className="pd-editor-pane"
          tabClassName="pd-section-tab"
        >
          <OtherBox />
        </Tab>
        <Tab
          eventKey="editor-download-center"
          title={
            <>
              <span className="material-symbols-outlined">download</span>
              <span>Downloads</span>
            </>
          }
          className="pd-editor-pane pd-downloads-pane"
          tabClassName="pd-section-tab"
        >
          <DownloadCenter />
        </Tab>
      </Tabs>
    </div>
  );
}

export default EditorPanel;
