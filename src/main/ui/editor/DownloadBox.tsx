import type { UIConfig } from "../../types/UIConfig";
import CheckboxRow from "./components/CheckboxRow";
import TextInputRow from "./components/TextInputRow";
import BrowserObtainableInputRow from "./components/BrowserObtainableInputRow";
import { useConfig } from "../contexts/ConfigProvider";
import { Container, Card } from "react-bootstrap";
import { useMemo } from "react";
import _ from "lodash";

interface DownloadBoxState {
  target: UIConfig["downloader"]["target"];
  outDir: string;
  cookie: UIConfig["downloader"]["cookie"];
  useStatusCache: boolean;
}

let oldState: DownloadBoxState | null = null;

function getDownloadBoxState(config: UIConfig): DownloadBoxState {
  const state = {
    target: config.downloader.target,
    outDir: config.output["out.dir"],
    cookie: config.downloader.cookie,
    useStatusCache: config.downloader["use.status.cache"]
  };
  if (oldState && _.isEqual(oldState, state)) {
    return oldState;
  }
  oldState = _.cloneDeep(state);
  return state;
}

function DownloadBox() {
  const { config } = useConfig();
  const state = getDownloadBoxState(config);

  return useMemo(() => {
    return (
      <Card className="pd-download-setup-card">
        <Card.Header className="pd-card-heading">
          <span className="pd-card-heading-icon material-symbols-outlined">
            cloud_download
          </span>
          <span>
            <strong>Download setup</strong>
            <small>Choose a Patreon target and where its files belong.</small>
          </span>
        </Card.Header>
        <Card.Body className="pd-download-setup-body">
          <Container fluid>
            <BrowserObtainableInputRow
              config={["downloader", "target"]}
              label="Target"
              disableManualInput
              helpTooltip="The target to download."
              helpHasMoreInfo
            />
            <TextInputRow
              type="dir"
              config={["output", "out.dir"]}
              label="Destination"
              helpTooltip="Permanent creator-organized Patreon download library. ZIP and RAR files extract beside their originals."
            />
            <BrowserObtainableInputRow
              config={["downloader", "cookie"]}
              label="Cookie"
              helpTooltip="The cookie to use in download requests."
              helpHasMoreInfo
            />
            <CheckboxRow
              config={["downloader", "use.status.cache"]}
              label="Use status cache"
              helpTooltip="Use status cache to quickly skip previously downloaded items."
              helpHasMoreInfo
            />
          </Container>
        </Card.Body>
      </Card>
    );
  }, [state]);
}

export default DownloadBox;
