import Editor, { type Monaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Code2,
  Columns3,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Settings,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { AiAssistant } from "./components/AiAssistant";
import { AiSettingsModal } from "./components/AiSettingsModal";
import { BuildOutput } from "./components/BuildOutput";
import { SerialConsole } from "./components/SerialConsole";
import { DEFAULT_SETTINGS, PRESET_LAYOUTS, readSettings, writeSettings } from "./lib/settings";
import type {
  AiProvider,
  AppSettings,
  Board,
  LayoutPreset,
  LogEntry,
  Operation,
  OperationResult,
  SerialEntry,
  SerialLine,
  SerialStateEvent,
  ToolOutput,
} from "./types";

const STARTER_SKETCH = `void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string | null): string {
  if (!path) return "Untitled.ino";
  return path.split(/[\\/]/).pop() || "Untitled.ino";
}

function clonePreset(preset: Exclude<LayoutPreset, "custom">, aiEnabled: boolean) {
  const value = structuredClone(PRESET_LAYOUTS[preset]);
  if (!aiEnabled) {
    value.outer = { workspace: 100 };
    value.aiVisible = false;
  }
  return value;
}

function App() {
  const [code, setCode] = useState(STARTER_SKETCH);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [compileSucceeded, setCompileSucceeded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialEntries, setSerialEntries] = useState<SerialEntry[]>([]);
  const [baudRate, setBaudRate] = useState(115200);
  const [serialInput, setSerialInput] = useState("");
  const [reopenAfterUpload, setReopenAfterUpload] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [explainPrompt, setExplainPrompt] = useState<string | null>(null);
  const logId = useRef(0);
  const serialId = useRef(0);
  const serialStartedAt = useRef(Date.now());
  const outerGroup = useGroupRef();
  const verticalGroup = useGroupRef();
  const bottomGroup = useGroupRef();

  const selectedBoard = useMemo(
    () => boards.find((board) => board.port === selectedPort) ?? null,
    [boards, selectedPort],
  );

  const appendLog = useCallback(
    (text: string, source: LogEntry["source"] = "system", stream: LogEntry["stream"] = "system") => {
      setLogs((entries) => [...entries, { id: logId.current++, source, stream, text }]);
    },
    [],
  );

  const appendSerial = useCallback((line: string, kind: SerialEntry["kind"] = "status") => {
    setSerialEntries((entries) => [
      ...entries.slice(-1999),
      { id: serialId.current++, line, kind, elapsedMs: Date.now() - serialStartedAt.current },
    ]);
  }, []);

  const updateSettings = useCallback((update: (current: AppSettings) => AppSettings) => {
    setSettings((current) => {
      const next = update(current);
      void writeSettings(next).catch((error) => {
        appendLog(`Could not save settings: ${errorMessage(error)}`, "system", "stderr");
      });
      return next;
    });
  }, [appendLog]);

  useEffect(() => {
    void readSettings()
      .then(setSettings)
      .catch((error) => appendLog(`Could not load settings: ${errorMessage(error)}`, "system", "stderr"))
      .finally(() => setSettingsReady(true));
  }, [appendLog]);

  useEffect(() => {
    const unlisteners = [
      listen<ToolOutput>("tool-output", ({ payload }) => {
        appendLog(payload.line, payload.operation, payload.stream);
      }),
      listen<SerialLine>("serial-line", ({ payload }) => {
        appendSerial(payload.line, "data");
      }),
      listen<SerialStateEvent>("serial-state", ({ payload }) => {
        setSerialOpen(payload.open);
        if (!payload.open && payload.reason === "disconnected") {
          appendSerial("Serial device disconnected.");
          appendLog("Serial device disconnected.", "system", "stderr");
        }
      }),
    ];

    return () => {
      void Promise.all(unlisteners).then((stops) => stops.forEach((stop) => stop()));
    };
  }, [appendLog, appendSerial]);

  const refreshBoards = useCallback(async () => {
    setBoardsLoading(true);
    try {
      const detected = await invoke<Board[]>("list_boards");
      setBoards(detected);
      setSelectedPort((current) => {
        if (detected.some((board) => board.port === current)) return current;
        return detected[0]?.port ?? "";
      });
    } catch (error) {
      appendLog(`Board detection failed: ${errorMessage(error)}`, "system", "stderr");
    } finally {
      setBoardsLoading(false);
    }
  }, [appendLog]);

  useEffect(() => {
    void refreshBoards();
  }, [refreshBoards]);

  useEffect(() => {
    const layout = settings.layout;
    verticalGroup.current?.setLayout(layout.vertical);
    bottomGroup.current?.setLayout(layout.bottom);
    outerGroup.current?.setLayout(settings.aiEnabled ? layout.outer : { workspace: 100 });
  }, [bottomGroup, outerGroup, settings.aiEnabled, settings.layout, verticalGroup]);

  const recordLayout = useCallback((group: "outer" | "vertical" | "bottom", layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    updateSettings((current) => ({
      ...current,
      layout: {
        ...current.layout,
        [group]: layout,
        preset: "custom",
        ...(group === "bottom" ? { consoleVisible: (layout.console ?? 0) > 0.5 } : {}),
        ...(group === "outer" ? { aiVisible: (layout.ai ?? 0) > 0.5 } : {}),
      },
    }));
  }, [updateSettings]);

  const applyPreset = (preset: Exclude<LayoutPreset, "custom">) => {
    updateSettings((current) => ({ ...current, layout: clonePreset(preset, current.aiEnabled) }));
  };

  const toggleConsolePanel = () => {
    updateSettings((current) => {
      const show = !current.layout.consoleVisible;
      return {
        ...current,
        layout: {
          ...current.layout,
          preset: "custom",
          consoleVisible: show,
          bottom: show ? { build: 45, console: 55 } : { build: 100, console: 0 },
        },
      };
    });
  };

  const toggleAiPanel = () => {
    updateSettings((current) => {
      const show = !current.layout.aiVisible;
      return {
        ...current,
        layout: {
          ...current.layout,
          preset: "custom",
          aiVisible: show,
          outer: show ? { workspace: 72, ai: 28 } : { workspace: 100, ai: 0 },
        },
      };
    });
  };

  const saveTo = useCallback(async (path: string) => {
    let inoPath = path;
    if (!inoPath.toLowerCase().endsWith(".ino")) inoPath += ".ino";
    await invoke("write_sketch", { path: inoPath, contents: code });
    if (filePath !== inoPath) setCompileSucceeded(false);
    setFilePath(inoPath);
    setDirty(false);
    appendLog(`Saved ${inoPath}`);
    return inoPath;
  }, [appendLog, code, filePath]);

  const saveAsSketch = useCallback(async () => {
    const path = await save({
      title: "Save Arduino sketch",
      defaultPath: filePath ?? "Untitled.ino",
      filters: [{ name: "Arduino sketch", extensions: ["ino"] }],
    });
    if (!path) return null;
    try {
      return await saveTo(path);
    } catch (error) {
      appendLog(`Save failed: ${errorMessage(error)}`, "system", "stderr");
      return null;
    }
  }, [appendLog, filePath, saveTo]);

  const openSketch = async () => {
    const path = await open({
      title: "Open Arduino sketch",
      multiple: false,
      directory: false,
      filters: [{ name: "Arduino sketch", extensions: ["ino"] }],
    });
    if (!path) return;
    try {
      const contents = await invoke<string>("read_sketch", { path });
      setCode(contents);
      setFilePath(path);
      setDirty(false);
      setCompileSucceeded(false);
      appendLog(`Opened ${path}`);
    } catch (error) {
      appendLog(`Open failed: ${errorMessage(error)}`, "system", "stderr");
    }
  };

  const persistSketch = async () => {
    if (!filePath) return saveAsSketch();
    try {
      return await saveTo(filePath);
    } catch (error) {
      appendLog(`Save failed: ${errorMessage(error)}`, "system", "stderr");
      return null;
    }
  };

  const runCompile = async () => {
    if (!selectedBoard) {
      appendLog("Select a connected board before compiling.", "system", "stderr");
      return;
    }
    const path = await persistSketch();
    if (!path) return;
    setOperation("compile");
    setCompileSucceeded(false);
    appendLog(`Compiling ${basename(path)} for ${selectedBoard.name}…`, "compile");
    try {
      const result = await invoke<OperationResult>("compile_sketch", {
        sketchPath: path,
        fqbn: selectedBoard.fqbn,
      });
      setCompileSucceeded(result.success);
      appendLog(
        result.success ? "Compile finished successfully." : `Compile failed (exit ${result.exitCode ?? "unknown"}).`,
        "compile",
        result.success ? "system" : "stderr",
      );
    } catch (error) {
      appendLog(`Compile failed: ${errorMessage(error)}`, "compile", "stderr");
    } finally {
      setOperation(null);
    }
  };

  const openSerial = useCallback(async () => {
    if (!selectedPort) {
      appendSerial("Select a port before connecting.");
      return false;
    }
    try {
      serialStartedAt.current = Date.now();
      await invoke("open_serial", { port: selectedPort, baudRate });
      setSerialOpen(true);
      setReopenAfterUpload(false);
      appendSerial(`Connected to ${selectedPort} at ${baudRate} baud.`);
      return true;
    } catch (error) {
      appendSerial(`Connection failed: ${errorMessage(error)}`);
      setSerialOpen(false);
      return false;
    }
  }, [appendSerial, baudRate, selectedPort]);

  const closeSerial = useCallback(async (reason = "user") => {
    try {
      await invoke("close_serial", { reason });
    } catch (error) {
      appendSerial(`Could not close serial port: ${errorMessage(error)}`);
    } finally {
      setSerialOpen(false);
    }
  }, [appendSerial]);

  const runUpload = async () => {
    if (!selectedBoard || !filePath || !compileSucceeded) return;
    const path = await persistSketch();
    if (!path) return;
    const wasOpen = serialOpen;
    setOperation("upload");
    setReopenAfterUpload(false);
    if (wasOpen) {
      appendSerial("Disconnected for upload…");
      await closeSerial("upload");
    }
    appendLog(`Uploading ${basename(path)} to ${selectedBoard.port}…`, "upload");
    try {
      const result = await invoke<OperationResult>("upload_sketch", {
        sketchPath: path,
        port: selectedBoard.port,
        fqbn: selectedBoard.fqbn,
      });
      appendLog(
        result.success ? "Upload finished successfully." : `Upload failed (exit ${result.exitCode ?? "unknown"}).`,
        "upload",
        result.success ? "system" : "stderr",
      );
    } catch (error) {
      appendLog(`Upload failed: ${errorMessage(error)}`, "upload", "stderr");
    } finally {
      setReopenAfterUpload(wasOpen);
      setOperation(null);
    }
  };

  const sendSerial = async () => {
    if (!serialInput || !serialOpen) return;
    try {
      await invoke("write_serial", { data: `${serialInput}\n` });
      setSerialInput("");
    } catch (error) {
      appendSerial(`Write failed: ${errorMessage(error)}`);
    }
  };

  const enableAi = (provider: AiProvider, apiKey: string) => {
    updateSettings((current) => ({
      ...current,
      onboardingComplete: true,
      aiEnabled: true,
      aiProvider: provider,
      apiKeys: { ...current.apiKeys, [provider]: apiKey },
      layout: {
        ...current.layout,
        preset: "custom",
        aiVisible: true,
        outer: { workspace: 72, ai: 28 },
      },
    }));
  };

  const disableAi = () => {
    updateSettings((current) => ({
      ...current,
      onboardingComplete: true,
      aiEnabled: false,
      layout: { ...current.layout, preset: "custom", aiVisible: false, outer: { workspace: 100 } },
    }));
  };

  const explainBuildOutput = () => {
    const output = logs.map((entry) => entry.text).join("\n").slice(-20_000);
    setExplainPrompt(`Explain this ESP32/Arduino build output and suggest the smallest likely fix:\n\n${output}`);
    if (!settings.layout.aiVisible) toggleAiPanel();
  };

  const configureMonaco = (monaco: Monaco) => {
    monaco.editor.defineTheme("trace-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "71717a" },
        { token: "keyword", foreground: "fb923c" },
        { token: "number", foreground: "fbbf24" },
        { token: "string", foreground: "a3e635" },
      ],
      colors: {
        "editor.background": "#09090b",
        "editor.foreground": "#e4e4e7",
        "editorLineNumber.foreground": "#52525b",
        "editorLineNumber.activeForeground": "#a1a1aa",
        "editor.selectionBackground": "#7c2d1266",
        "editor.lineHighlightBackground": "#18181b",
        "editorCursor.foreground": "#fb923c",
      },
    });
  };

  const apiKey = settings.apiKeys[settings.aiProvider] ?? "";

  return (
    <main className="flex h-screen min-h-[520px] flex-col overflow-hidden bg-canvas text-zinc-200">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <div className="mr-2 flex items-center gap-2" title="Trace">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-orange-500/15 text-orange-400"><Code2 size={16} strokeWidth={2.2} /></span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Trace</span>
        </div>

        <button className="toolbar-button" onClick={openSketch} disabled={operation !== null}><FolderOpen size={14} /> Open</button>
        <button className="toolbar-button" onClick={() => void saveAsSketch()} disabled={operation !== null}><Save size={14} /> Save As</button>
        <div className="mx-1 h-5 w-px bg-line" />

        <div className="select-wrap min-w-48 max-w-72 flex-1">
          <CircleDot size={13} className={selectedBoard ? "text-emerald-400" : "text-zinc-600"} />
          <select
            value={selectedPort}
            onChange={(event) => {
              setSelectedPort(event.target.value);
              setCompileSucceeded(false);
              if (serialOpen) void closeSerial();
            }}
            disabled={boardsLoading || operation !== null}
            aria-label="Target board and port"
          >
            {boards.length === 0 && <option value="">No boards connected</option>}
            {boards.map((board) => <option key={board.port} value={board.port}>{board.name} · {board.port}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none text-zinc-500" />
        </div>
        <button className="icon-button" onClick={() => void refreshBoards()} disabled={boardsLoading || operation !== null} title="Refresh boards" aria-label="Refresh boards">
          <RefreshCw size={14} className={boardsLoading ? "animate-spin" : ""} />
        </button>

        <div className="layout-switcher" title="Layout preset">
          <Columns3 size={13} className="text-zinc-500" />
          <select value={settings.layout.preset} onChange={(event) => event.target.value !== "custom" && applyPreset(event.target.value as Exclude<LayoutPreset, "custom">)}>
            <option value="focus">Focus</option>
            <option value="debug">Debug</option>
            <option value="full">Full</option>
            {settings.layout.preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </div>
        <button className={`icon-button ${settings.layout.consoleVisible ? "is-active" : ""}`} onClick={toggleConsolePanel} title="Toggle console" aria-label="Toggle console"><TerminalSquare size={14} /></button>
        {settings.aiEnabled && (
          <button className={`icon-button ${settings.layout.aiVisible ? "is-active" : ""}`} onClick={toggleAiPanel} title="Toggle AI assistant" aria-label="Toggle AI assistant"><Bot size={14} /></button>
        )}
        <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><Settings size={14} /></button>

        <div className="ml-auto flex items-center gap-2">
          <button className="action-button border border-zinc-600 bg-zinc-100 text-zinc-950 hover:bg-white" onClick={() => void runCompile()} disabled={operation !== null}>
            {operation === "compile" ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
            Compile
          </button>
          <button
            className="action-button upload-button"
            onClick={() => void runUpload()}
            disabled={!compileSucceeded || !selectedBoard || operation !== null}
            title={!compileSucceeded ? "Compile successfully before uploading" : "Upload to board"}
          >
            {operation === "upload" ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
        </div>
      </header>

      <Group
        id="trace-outer"
        groupRef={outerGroup}
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={settings.aiEnabled ? settings.layout.outer : { workspace: 100 }}
        onLayoutChanged={(layout, meta) => recordLayout("outer", layout, meta)}
      >
        <Panel id="workspace" minSize="500px">
          <Group
            id="trace-vertical"
            groupRef={verticalGroup}
            orientation="vertical"
            defaultLayout={settings.layout.vertical}
            onLayoutChanged={(layout, meta) => recordLayout("vertical", layout, meta)}
          >
            <Panel id="editor" minSize="200px">
              <section className="flex h-full min-h-0 flex-col">
                <div className="flex h-8 shrink-0 items-center border-b border-line bg-[#0d0d10] px-4 text-xs">
                  <span className="mr-2 h-2 w-2 rounded-full bg-orange-500" />
                  <span className="text-zinc-300">{basename(filePath)}</span>
                  {dirty && <span className="ml-1 text-zinc-500">•</span>}
                  <span className="ml-auto truncate text-[11px] text-zinc-600">{filePath ?? "Save the sketch before compiling"}</span>
                </div>
                <div className="min-h-0 flex-1">
                  <Editor
                    height="100%"
                    language="cpp"
                    theme="trace-dark"
                    value={code}
                    beforeMount={configureMonaco}
                    onChange={(value) => {
                      setCode(value ?? "");
                      setDirty(true);
                      setCompileSucceeded(false);
                    }}
                    options={{
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineHeight: 21,
                      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
                      fontLigatures: true,
                      padding: { top: 12, bottom: 12 },
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      renderLineHighlight: "all",
                      bracketPairColorization: { enabled: true },
                      guides: { bracketPairs: true, indentation: false },
                      tabSize: 2,
                    }}
                  />
                </div>
              </section>
            </Panel>
            <Separator className="resize-handle horizontal" />
            <Panel id="lower" minSize="120px">
              <Group
                id="trace-bottom"
                groupRef={bottomGroup}
                orientation="horizontal"
                defaultLayout={settings.layout.bottom}
                onLayoutChanged={(layout, meta) => recordLayout("bottom", layout, meta)}
              >
                <Panel id="build" minSize="120px">
                  <BuildOutput logs={logs} operation={operation} onClear={() => setLogs([])} onExplain={settings.aiEnabled ? explainBuildOutput : undefined} />
                </Panel>
                <Separator className="resize-handle vertical" />
                <Panel id="console" minSize="150px" collapsible collapsedSize={0}>
                  <SerialConsole
                    entries={serialEntries}
                    open={serialOpen}
                    hasPort={Boolean(selectedPort)}
                    baudRate={baudRate}
                    timestamps={settings.serialTimestamps}
                    input={serialInput}
                    operation={operation}
                    reconnectAvailable={reopenAfterUpload}
                    onBaudRate={setBaudRate}
                    onTimestamps={(value) => updateSettings((current) => ({ ...current, serialTimestamps: value }))}
                    onInput={setSerialInput}
                    onToggle={() => serialOpen ? void closeSerial() : void openSerial()}
                    onSend={() => void sendSerial()}
                    onClear={() => setSerialEntries([])}
                    onReconnect={() => void openSerial()}
                  />
                </Panel>
              </Group>
            </Panel>
          </Group>
        </Panel>

        {settings.aiEnabled && (
          <>
            <Separator className="resize-handle vertical" />
            <Panel id="ai" minSize="280px" collapsible collapsedSize={0}>
              <AiAssistant provider={settings.aiProvider} apiKey={apiKey} explainPrompt={explainPrompt} onExplainConsumed={() => setExplainPrompt(null)} />
            </Panel>
          </>
        )}
      </Group>

      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-[#0d0d10] px-3 text-[10px] text-zinc-600">
        <span className="flex items-center gap-1.5">
          {compileSucceeded ? <Check size={11} className="text-emerald-500" /> : <CircleDot size={11} />}
          {compileSucceeded ? "Compiled" : "Not compiled"}
        </span>
        <span>{settings.layout.preset === "custom" ? "Custom layout" : `${settings.layout.preset[0].toUpperCase()}${settings.layout.preset.slice(1)} layout`}</span>
        <span className="ml-auto">ESP32 · Arduino</span>
      </footer>

      {settingsReady && (!settings.onboardingComplete || settingsOpen) && (
        <AiSettingsModal
          firstLaunch={!settings.onboardingComplete}
          settings={settings}
          onEnable={enableAi}
          onDisable={disableAi}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}

export default App;
