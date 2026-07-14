import Editor, { type Monaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleDot,
  Code2,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Send,
  TerminalSquare,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Board,
  LogEntry,
  Operation,
  OperationResult,
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

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string | null): string {
  if (!path) return "Untitled.ino";
  return path.split(/[\\/]/).pop() || "Untitled.ino";
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
  const [serialPanel, setSerialPanel] = useState(false);
  const [serialLines, setSerialLines] = useState<string[]>([]);
  const [baudRate, setBaudRate] = useState(115200);
  const [serialInput, setSerialInput] = useState("");
  const [reopenAfterUpload, setReopenAfterUpload] = useState(false);
  const logId = useRef(0);
  const logEnd = useRef<HTMLDivElement>(null);
  const serialEnd = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const unlisteners = [
      listen<ToolOutput>("tool-output", ({ payload }) => {
        appendLog(payload.line, payload.operation, payload.stream);
      }),
      listen<SerialLine>("serial-line", ({ payload }) => {
        setSerialLines((lines) => [...lines.slice(-1999), payload.line]);
      }),
      listen<SerialStateEvent>("serial-state", ({ payload }) => {
        setSerialOpen(payload.open);
        if (!payload.open && payload.reason === "disconnected") {
          appendLog("Serial device disconnected.", "system", "stderr");
        }
      }),
    ];

    return () => {
      void Promise.all(unlisteners).then((stops) => stops.forEach((stop) => stop()));
    };
  }, [appendLog]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  useEffect(() => {
    serialEnd.current?.scrollIntoView({ block: "end" });
  }, [serialLines]);

  const refreshBoards = useCallback(async () => {
    setBoardsLoading(true);
    try {
      const detected = await invoke<Board[]>("list_boards");
      setBoards(detected);
      setSelectedPort((current) => {
        if (detected.some((board) => board.port === current)) return current;
        return detected[0]?.port ?? "";
      });
      if (detected.length === 0) {
        appendLog("No connected boards found. Connect an ESP32 and refresh.");
      }
    } catch (error) {
      appendLog(`Board detection failed: ${errorMessage(error)}`, "system", "stderr");
    } finally {
      setBoardsLoading(false);
    }
  }, [appendLog]);

  useEffect(() => {
    void refreshBoards();
  }, [refreshBoards]);

  const saveTo = useCallback(
    async (path: string) => {
      let inoPath = path;
      if (!inoPath.toLowerCase().endsWith(".ino")) inoPath += ".ino";
      await invoke("write_sketch", { path: inoPath, contents: code });
      if (filePath !== inoPath) setCompileSucceeded(false);
      setFilePath(inoPath);
      setDirty(false);
      appendLog(`Saved ${inoPath}`);
      return inoPath;
    },
    [appendLog, code, filePath],
  );

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
      appendLog("Select a port before opening the serial monitor.", "system", "stderr");
      return false;
    }
    try {
      await invoke("open_serial", { port: selectedPort, baudRate });
      setSerialOpen(true);
      setSerialPanel(true);
      appendLog(`Serial monitor opened on ${selectedPort} at ${baudRate} baud.`);
      return true;
    } catch (error) {
      appendLog(`Serial monitor: ${errorMessage(error)}`, "system", "stderr");
      setSerialOpen(false);
      return false;
    }
  }, [appendLog, baudRate, selectedPort]);

  const closeSerial = useCallback(async () => {
    try {
      await invoke("close_serial", { reason: "user" });
    } catch (error) {
      appendLog(`Could not close serial port: ${errorMessage(error)}`, "system", "stderr");
    } finally {
      setSerialOpen(false);
    }
  }, [appendLog]);

  const runUpload = async () => {
    if (!selectedBoard || !filePath || !compileSucceeded) return;
    const path = await persistSketch();
    if (!path) return;
    const wasOpen = serialOpen;
    setOperation("upload");
    setReopenAfterUpload(false);
    if (wasOpen) {
      appendLog("Closing the serial monitor before upload…", "upload");
      await closeSerial();
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
      setReopenAfterUpload(wasOpen);
    } catch (error) {
      appendLog(`Upload failed: ${errorMessage(error)}`, "upload", "stderr");
      setReopenAfterUpload(wasOpen);
    } finally {
      setOperation(null);
    }
  };

  const toggleSerial = async () => {
    if (serialOpen) await closeSerial();
    else await openSerial();
  };

  const sendSerial = async () => {
    if (!serialInput || !serialOpen) return;
    try {
      await invoke("write_serial", { data: `${serialInput}\n` });
      setSerialInput("");
    } catch (error) {
      appendLog(`Serial write failed: ${errorMessage(error)}`, "system", "stderr");
    }
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

  return (
    <main className="flex h-screen min-h-[600px] flex-col overflow-hidden bg-canvas text-zinc-200">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <div className="mr-2 flex items-center gap-2" title="Trace">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-orange-500/15 text-orange-400">
            <Code2 size={16} strokeWidth={2.2} />
          </span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Trace</span>
        </div>

        <button className="toolbar-button" onClick={openSketch} disabled={operation !== null}>
          <FolderOpen size={14} /> Open
        </button>
        <button className="toolbar-button" onClick={() => void saveAsSketch()} disabled={operation !== null}>
          <Save size={14} /> Save As
        </button>

        <div className="mx-1 h-5 w-px bg-line" />

        <div className="select-wrap min-w-52 max-w-72 flex-1">
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
            {boards.map((board) => (
              <option key={board.port} value={board.port}>
                {board.name} · {board.port}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none text-zinc-500" />
        </div>
        <button
          className="icon-button"
          onClick={() => void refreshBoards()}
          disabled={boardsLoading || operation !== null}
          title="Refresh boards"
          aria-label="Refresh boards"
        >
          <RefreshCw size={14} className={boardsLoading ? "animate-spin" : ""} />
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            className={`toolbar-button ${serialOpen ? "border-emerald-700/70 text-emerald-300" : ""}`}
            onClick={() => {
              setSerialPanel(true);
              void toggleSerial();
            }}
            disabled={!selectedPort || operation !== null}
          >
            <TerminalSquare size={14} /> {serialOpen ? "Close serial" : "Open serial"}
          </button>
          <button
            className="action-button bg-zinc-100 text-zinc-950 hover:bg-white"
            onClick={() => void runCompile()}
            disabled={!selectedBoard || operation !== null}
          >
            {operation === "compile" ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
            Compile
          </button>
          <button
            className="action-button bg-orange-500 text-zinc-950 hover:bg-orange-400"
            onClick={() => void runUpload()}
            disabled={!compileSucceeded || !selectedBoard || operation !== null}
            title={!compileSucceeded ? "Compile successfully before uploading" : "Upload to board"}
          >
            {operation === "upload" ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col">
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

      <section className={`grid shrink-0 border-t border-line bg-panel ${serialPanel ? "grid-cols-2" : "grid-cols-1"}`}>
        <div className="flex h-56 min-w-0 flex-col border-r border-line last:border-r-0">
          <div className="panel-header">
            <TerminalSquare size={13} />
            <span>Build output</span>
            {operation && <LoaderCircle size={12} className="ml-1 animate-spin text-orange-400" />}
            <button className="panel-action ml-auto" onClick={() => setLogs([])}>Clear</button>
          </div>
          <div className="log-scroll">
            {logs.length === 0 && <span className="text-zinc-600">Build and upload output will appear here.</span>}
            {logs.map((entry) => (
              <div key={entry.id} className={entry.stream === "stderr" ? "text-red-300" : entry.stream === "system" ? "text-zinc-400" : "text-zinc-300"}>
                <span className="mr-2 select-none text-zinc-700">›</span>{entry.text}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
          {reopenAfterUpload && !serialOpen && (
            <div className="flex h-9 shrink-0 items-center gap-2 border-t border-line bg-orange-500/5 px-3 text-xs text-orange-200">
              <AlertCircle size={13} /> Serial monitor was closed for upload.
              <button
                className="ml-auto rounded border border-orange-700/60 px-2 py-1 hover:bg-orange-500/10"
                onClick={() => {
                  setReopenAfterUpload(false);
                  void openSerial();
                }}
              >
                Reopen
              </button>
            </div>
          )}
        </div>

        {serialPanel && (
          <div className="flex h-56 min-w-0 flex-col">
            <div className="panel-header">
              <span className={`h-2 w-2 rounded-full ${serialOpen ? "bg-emerald-400" : "bg-zinc-600"}`} />
              <span>Serial monitor</span>
              <select
                className="ml-auto rounded border border-line bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 outline-none"
                value={baudRate}
                onChange={(event) => setBaudRate(Number(event.target.value))}
                disabled={serialOpen}
                aria-label="Serial baud rate"
              >
                {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate} baud</option>)}
              </select>
              <button
                className="icon-button h-6 w-6"
                onClick={() => {
                  if (serialOpen) void closeSerial();
                  setSerialPanel(false);
                }}
                title="Close panel"
                aria-label="Close serial panel"
              >
                <X size={13} />
              </button>
            </div>
            <div className="log-scroll flex-1">
              {serialLines.length === 0 && <span className="text-zinc-600">{serialOpen ? "Waiting for serial data…" : "Open the serial port to monitor output."}</span>}
              {serialLines.map((line, index) => <div key={index} className="text-emerald-200/90">{line || " "}</div>)}
              <div ref={serialEnd} />
            </div>
            <form
              className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-2"
              onSubmit={(event) => {
                event.preventDefault();
                void sendSerial();
              }}
            >
              <input
                className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                value={serialInput}
                onChange={(event) => setSerialInput(event.target.value)}
                placeholder={serialOpen ? "Send to board…" : "Serial port is closed"}
                disabled={!serialOpen}
              />
              <button className="icon-button" type="submit" disabled={!serialOpen || !serialInput} title="Send" aria-label="Send serial data">
                <Send size={13} />
              </button>
              <button className="panel-action" type="button" onClick={() => setSerialLines([])}>Clear</button>
            </form>
          </div>
        )}
      </section>

      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-[#0d0d10] px-3 text-[10px] text-zinc-600">
        <span className="flex items-center gap-1.5">
          {compileSucceeded ? <Check size={11} className="text-emerald-500" /> : <CircleDot size={11} />}
          {compileSucceeded ? "Compiled" : "Not compiled"}
        </span>
        <span className="ml-auto">ESP32 · Arduino</span>
      </footer>
    </main>
  );
}

export default App;
