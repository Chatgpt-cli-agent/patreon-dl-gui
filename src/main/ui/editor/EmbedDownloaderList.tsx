import type { CustomEmbedDownloader, UIConfig } from "../../types/UIConfig";
import { useConfig } from "../contexts/ConfigProvider";
import TextInputRow from "./components/TextInputRow";
import { Button, Card, Container, Stack } from "react-bootstrap";
import { useCallback, useMemo } from "react";
import _ from "lodash";

interface EmbedDownloaderListState {
  entries: UIConfig["embed.downloader.others"]["entries"];
}

let oldState: EmbedDownloaderListState | null = null;

function getEmbedDownloaderListState(
  config: UIConfig
): EmbedDownloaderListState {
  const state: EmbedDownloaderListState = {
    entries: config["embed.downloader.others"]["entries"]
  };
  if (oldState && _.isEqual(oldState, state)) {
    return oldState;
  }
  oldState = _.cloneDeep(state);
  return state;
}

const EXEC_INSERTABLES = [
  { value: "{post.id}", label: "post id" },
  { value: "{post.url}", label: "post url" },
  { value: "{embed.provider}", label: "provider" },
  { value: "{embed.provider.url}", label: "provider url" },
  { value: "{embed.url}", label: "content url" },
  { value: "{embed.subject}", label: "subject" },
  { value: "{embed.html}", label: "embed html" },
  { value: "{cookie}", label: "cookie" },
  { value: "{dest.dir}", label: "destination directory" }
];

function EmbedDownloaderListRow(props: {
  index: number;
  entry: CustomEmbedDownloader;
  delete: (index: number) => void;
}) {
  const { index, entry } = props;
  const { provider, exec } = entry;

  return (
    <Stack
      direction="horizontal"
      gap={2}
      className="d-flex align-items-center mb-3"
    >
      <Card>
        <Card.Body className="pb-0">
          <Container fluid className="p-0">
            <TextInputRow
              type="any"
              config={["embed.downloader.others", "entries"]}
              getDisplayValue={() => provider}
              updateConfigValue={(entries, inputValue) => {
                entries[index].provider = inputValue;
                return entries;
              }}
              label="Provider"
              helpTooltip="The provider of the embedded content."
              helpHasMoreInfo
            />
            <TextInputRow
              type="any"
              config={["embed.downloader.others", "entries"]}
              getDisplayValue={() => exec}
              updateConfigValue={(entries, inputValue) => {
                entries[index].exec = inputValue;
                return entries;
              }}
              label="Command"
              insertables={EXEC_INSERTABLES}
              helpTooltip="The command to download the embedded content."
              helpHasMoreInfo
            />
          </Container>
        </Card.Body>
      </Card>
      <Button
        variant="link"
        className="text-danger px-0"
        size="sm"
        onClick={() => props.delete(index)}
        title="Delete this entry"
        aria-label="Delete entry"
      >
        <span className="material-symbols-outlined">delete</span>
      </Button>
    </Stack>
  );
}

function EmbedDownloaderList() {
  const { config, setConfigValue } = useConfig();
  const state = getEmbedDownloaderListState(config);

  const addRow = useCallback(() => {
    const newEntries = [...state.entries, { provider: "", exec: "" }];
    setConfigValue("embed.downloader.others", "entries", newEntries);
  }, [state.entries, setConfigValue]);

  const deleteRow = useCallback(
    (index: number) => {
      const newEntries = [...state.entries];
      newEntries.splice(index, 1);
      setConfigValue("embed.downloader.others", "entries", newEntries);
    },
    [state.entries, setConfigValue]
  );

  return useMemo(() => {
    return (
      <>
        <Container fluid>
          {state.entries.map((entry, index) => (
            <EmbedDownloaderListRow
              key={`custom-embed-downloader-${index}`}
              index={index}
              entry={entry}
              delete={deleteRow}
            />
          ))}
          {state.entries.length === 0 ?
            <div
              className="text-center text-muted my-5"
              style={{ userSelect: "none" }}
            >
              No custom embed downloaders configured.
            </div>
          : null}
        </Container>
        <Container fluid className="d-flex justify-content-center mb-2">
          <Button className="d-flex align-items-center" onClick={addRow}>
            <span className="material-icons me-1">add</span> Add
          </Button>
        </Container>
      </>
    );
  }, [state.entries, addRow, deleteRow]);
}

export default EmbedDownloaderList;
