import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Blocks,
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
  SlidersHorizontal,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { BoardOptionsModal } from "./components/BoardOptionsModal";
import { BuildOutput } from "./components/BuildOutput";
import { PackageInstallBar } from "./components/PackageInstallBar";
import { SerialConsole } from "./components/SerialConsole";
import { StartupSplash } from "./components/StartupSplash";
import { TraceMark } from "./components/TraceMark";
import { DEFAULT_SETTINGS, PRESET_LAYOUTS, readSettings, writeSettings } from "./lib/settings";
import type {
  AiProvider,
  AppSettings,
  Board,
  BoardConfiguration,
  InstalledBoard,
  LibraryInstallEvent,
  LayoutPreset,
  LogEntry,
  Operation,
  OperationResult,
  SerialEntry,
  SerialLine,
  SerialStateEvent,
  ToolOutput,
} from "./types";

const BlockEditor = lazy(async () => {
  const module = await import("./components/BlockEditor");
  return { default: module.BlockEditor };
});

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

function sourceSignature(source: string, port: string, fqbn: string, boardOptions: Record<string, string>) {
  let hash = 2166136261;
  const options = Object.entries(boardOptions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([option, selected]) => `${option}=${selected}`)
    .join(",");
  const value = `${port}\0${fqbn}\0${options}\0${source}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

interface AiEditProposal {
  original: string;
  modified: string;
}

interface AiToolResult {
  success: boolean;
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string | null): string {
  if (!path) return "Untitled.ino";
  return path.split(/[\\/]/).pop() || "Untitled.ino";
}

function extractLibraryHeaders(source: string): string[] {
  const headers = new Set<string>();
  const pattern = /^\s*#\s*include\s*<\s*([^>]+?)\s*>/gm;
  for (const match of source.matchAll(pattern)) {
    const header = match[1]?.trim();
    if (header && /\.(?:h|hpp)$/i.test(header)) headers.add(header);
  }
  return [...headers];
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
  const [editorView, setEditorView] = useState<"code" | "blocks">("code");
  const [blocksOpened, setBlocksOpened] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [boards, setBoards] = useState<Board[]>([]);
  const [installedBoards, setInstalledBoards] = useState<InstalledBoard[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardConfiguration, setBoardConfiguration] = useState<BoardConfiguration | null>(null);
  const [boardConfigurationLoading, setBoardConfigurationLoading] = useState(false);
  const [boardConfigurationError, setBoardConfigurationError] = useState<string | null>(null);
  const [boardOptionsOpen, setBoardOptionsOpen] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [compiledSignature, setCompiledSignature] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [libraryInstalls, setLibraryInstalls] = useState<Record<string, LibraryInstallEvent>>({});
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialEntries, setSerialEntries] = useState<SerialEntry[]>([]);
  const [baudRate, setBaudRate] = useState(115200);
  const [serialInput, setSerialInput] = useState("");
  const [reconnectTarget, setReconnectTarget] = useState<{ port: string; baudRate: number } | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeWarningOpen, setCloseWarningOpen] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [showStartup, setShowStartup] = useState(true);
  const [explainPrompt, setExplainPrompt] = useState<string | null>(null);
  const [aiEdit, setAiEdit] = useState<AiEditProposal | null>(null);
  const logId = useRef(0);
  const serialId = useRef(0);
  const serialStartedAt = useRef(Date.now());
  const compileSucceededRef = useRef(false);
  const dirtyRef = useRef(dirty);
  const filePathRef = useRef(filePath);
  const closeApprovedRef = useRef(false);
  const libraryDismissTimers = useRef(new Map<string, number>());
  const outerGroup = useGroupRef();
  const verticalGroup = useGroupRef();
  const bottomGroup = useGroupRef();

  const selectedBoard = useMemo(
    () => boards.find((board) => board.port === selectedPort) ?? null,
    [boards, selectedPort],
  );
  const selectedOverride = selectedBoard ? settings.boardTypeOverrides[selectedBoard.identityKey] : undefined;
  const selectedFqbn = selectedBoard
    ? selectedOverride ?? selectedBoard.fqbn
    : "";
  const selectedBoardOptions = useMemo(
    () => selectedFqbn ? settings.boardOptionSelections[selectedFqbn] ?? {} : {},
    [selectedFqbn, settings.boardOptionSelections],
  );
  const selectedBoardName = boardConfiguration?.name
    ?? (selectedBoard?.matched ? selectedBoard.name : selectedBoard ? `Unidentified board (${selectedBoard.usbLabel})` : "Arduino board");
  const boardChoices = useMemo(() => {
    if (!selectedBoard) return [];
    const choices = [...selectedBoard.candidates, ...installedBoards];
    const seen = new Set<string>();
    return choices.filter((board) => {
      if (seen.has(board.fqbn)) return false;
      seen.add(board.fqbn);
      return true;
    });
  }, [installedBoards, selectedBoard]);
  const currentCompileSignature = selectedBoard
    ? sourceSignature(code, selectedBoard.port, selectedFqbn, selectedBoardOptions)
    : null;
  const currentCompileSignatureRef = useRef<string | null>(null);
  currentCompileSignatureRef.current = currentCompileSignature;
  const compileSucceeded = currentCompileSignature !== null && compiledSignature === currentCompileSignature;
  const includedHeaders = useMemo(() => extractLibraryHeaders(code), [code]);
  const libraryInstallList = useMemo(() => Object.values(libraryInstalls), [libraryInstalls]);
  const activeLibraryInstalls = useMemo(
    () => libraryInstallList.filter((install) => ["resolving", "downloading", "installing"].includes(install.status)),
    [libraryInstallList],
  );
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

  useEffect(() => {
    compileSucceededRef.current = compileSucceeded;
  }, [compileSucceeded]);

  useEffect(() => {
    if (aiEdit) setEditorView("code");
  }, [aiEdit]);

  const invalidateCompile = useCallback(() => {
    setCompiledSignature(null);
    compileSucceededRef.current = false;
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (closeApprovedRef.current || (!dirtyRef.current && filePathRef.current !== null)) return;
      event.preventDefault();
      setCloseWarningOpen(true);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const discardAndClose = useCallback(async () => {
    setCloseWarningOpen(false);
    closeApprovedRef.current = true;
    try {
      await invoke("quit_app");
    } catch {
      closeApprovedRef.current = false;
      setCloseWarningOpen(true);
    }
  }, []);

  const appendLog = useCallback(
    (text: string, source: LogEntry["source"] = "system", stream: LogEntry["stream"] = "system") => {
      setLogs((entries) => [
        ...entries.slice(-4999),
        { id: logId.current++, source, stream, text },
      ]);
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
      listen<LibraryInstallEvent>("library-install", ({ payload }) => {
        const existingTimer = libraryDismissTimers.current.get(payload.header);
        if (existingTimer !== undefined) window.clearTimeout(existingTimer);
        setLibraryInstalls((current) => ({ ...current, [payload.header]: payload }));
        if (payload.status === "installed") {
          const timer = window.setTimeout(() => {
            setLibraryInstalls((current) => {
              if (current[payload.header]?.status !== "installed") return current;
              const next = { ...current };
              delete next[payload.header];
              return next;
            });
            libraryDismissTimers.current.delete(payload.header);
          }, 5000);
          libraryDismissTimers.current.set(payload.header, timer);
        }
      }),
    ];

    return () => {
      void Promise.all(unlisteners).then((stops) => stops.forEach((stop) => stop()));
      libraryDismissTimers.current.forEach((timer) => window.clearTimeout(timer));
      libraryDismissTimers.current.clear();
    };
  }, [appendLog, appendSerial]);

  const refreshBoards = useCallback(async (showSpinner = true) => {
    if (showSpinner) setBoardsLoading(true);
    try {
      const detected = await invoke<Board[]>("list_boards");
      setBoardError(null);
      setBoards(detected);
      setSelectedPort((current) => {
        if (detected.some((board) => board.port === current)) return current;
        return detected[0]?.port ?? "";
      });
    } catch (error) {
      setBoardError(errorMessage(error));
    } finally {
      if (showSpinner) setBoardsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBoards();
    const timer = window.setInterval(() => void refreshBoards(false), 2500);
    return () => window.clearInterval(timer);
  }, [refreshBoards]);

  useEffect(() => {
    void invoke<InstalledBoard[]>("list_installed_boards")
      .then(setInstalledBoards)
      .catch((error) => setBoardConfigurationError(`Could not list installed boards: ${errorMessage(error)}`));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedFqbn) {
      setBoardConfiguration(null);
      setBoardConfigurationError(null);
      setBoardConfigurationLoading(false);
      return;
    }
    setBoardConfigurationLoading(true);
    setBoardConfigurationError(null);
    void invoke<BoardConfiguration>("get_board_configuration", {
      fqbn: selectedFqbn,
      boardOptions: selectedBoardOptions,
    }).then((configuration) => {
      if (cancelled) return;
      setBoardConfiguration(configuration);
      if (configuration.requiresSelection.length > 0) setBoardOptionsOpen(true);
    }).catch((error) => {
      if (cancelled) return;
      setBoardConfiguration(null);
      setBoardConfigurationError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setBoardConfigurationLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFqbn, selectedBoardOptions]);

  useEffect(() => {
    if (!selectedBoard || !selectedFqbn || includedHeaders.length === 0) return;
    const timer = window.setTimeout(() => {
      void invoke("sync_libraries", {
        headers: includedHeaders,
        fqbn: selectedFqbn,
        retry: false,
      }).catch((error) => appendLog(`Library check failed: ${errorMessage(error)}`, "system", "stderr"));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [appendLog, includedHeaders, selectedBoard?.identityKey, selectedFqbn]);

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
    setFilePath(inoPath);
    setDirty(false);
    appendLog(`Saved ${inoPath}`);
    return inoPath;
  }, [appendLog, code]);

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
    if (dirty || filePath === null) {
      const discard = await confirm(
        "The current sketch has not been saved. Open another sketch and discard it?",
        {
          title: "Unsaved sketch",
          kind: "warning",
          okLabel: "Discard and open",
          cancelLabel: "Keep editing",
        },
      ).catch(() => window.confirm("Discard the unsaved sketch and open another file?"));
      if (!discard) return;
    }
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
      setAiEdit(null);
      setEditorView("code");
      setBlocksOpened(false);
      setFilePath(path);
      setDirty(false);
      invalidateCompile();
      appendLog(`Opened ${path}`);
    } catch (error) {
      appendLog(`Open failed: ${errorMessage(error)}`, "system", "stderr");
    }
  };

  const runCompile = async (): Promise<AiToolResult> => {
    if (operation !== null) {
      return { success: false, message: "Compile could not start because another operation is running." };
    }
    if (activeLibraryInstalls.length > 0) {
      const message = `${activeLibraryInstalls.length} ${activeLibraryInstalls.length === 1 ? "library is" : "libraries are"} still installing. Wait for package installation to finish, then compile again.`;
      appendLog(message, "system", "stderr");
      return { success: false, message };
    }
    if (!selectedBoard) {
      appendLog("Select a connected board before compiling.", "system", "stderr");
      return { success: false, message: "Compile could not start because no board is selected." };
    }
    if (!selectedFqbn) {
      const message = "Choose a concrete installed board for this port before compiling.";
      appendLog(message, "system", "stderr");
      return { success: false, message };
    }
    if (boardConfigurationLoading) {
      const message = "Board configuration is still loading. Try Compile again in a moment.";
      appendLog(message, "system", "stderr");
      return { success: false, message };
    }
    if (boardConfigurationError || !boardConfiguration) {
      const message = boardConfigurationError ?? "Board configuration could not be resolved.";
      appendLog(message, "system", "stderr");
      return { success: false, message };
    }
    if (boardConfiguration.requiresSelection.length > 0) {
      setBoardOptionsOpen(true);
      const message = `Choose board options for ${boardConfiguration.requiresSelection.join(", ")} before compiling.`;
      appendLog(message, "system", "stderr");
      return { success: false, message };
    }
    if (includedHeaders.length > 0) {
      try {
        await invoke("sync_libraries", {
          headers: includedHeaders,
          fqbn: selectedFqbn,
          retry: false,
        });
      } catch (error) {
        appendLog(`Library preflight failed: ${errorMessage(error)}`, "library", "stderr");
      }
    }
    setOperation("compile");
    invalidateCompile();
    appendLog(`Compiling ${filePath ? basename(filePath) : "Untitled.ino"} for ${selectedBoardName}…`, "compile");
    try {
      const result = await invoke<OperationResult>("compile_sketch", {
        sketchCode: code,
        fqbn: selectedFqbn,
        boardOptions: selectedBoardOptions,
      });
      setCompiledSignature(result.success ? currentCompileSignature : null);
      compileSucceededRef.current = result.success
        && currentCompileSignatureRef.current === currentCompileSignature;
      if (!result.success && result.missingHeader) {
        const header = result.missingHeader;
        appendLog(
          `Missing header ${header}. Trace can try to install a matching Arduino library from the package bar.`,
          "library",
          "stderr",
        );
        setLibraryInstalls((installs) => ({
          ...installs,
          [header]: {
            header,
            package: installs[header]?.package ?? "",
            status: "failed",
            progress: 100,
            message: "Header missing during compile. Click Install to search Arduino Library Manager.",
          },
        }));
      }
      appendLog(
        result.success ? "Compile finished successfully." : `Compile failed (exit ${result.exitCode ?? "unknown"}).`,
        "compile",
        result.success ? "system" : "stderr",
      );
      return {
        success: result.success,
        message: result.success
          ? `Compile succeeded for ${selectedBoardName}.`
          : `Compile failed with exit code ${result.exitCode ?? "unknown"}. Check Build output for details.`,
      };
    } catch (error) {
      const message = errorMessage(error);
      appendLog(`Compile failed: ${message}`, "compile", "stderr");
      return { success: false, message: `Compile failed: ${message}` };
    } finally {
      setOperation(null);
    }
  };

  const openSerial = useCallback(async (target?: { port: string; baudRate: number }) => {
    const port = target?.port ?? selectedPort;
    const rate = target?.baudRate ?? baudRate;
    if (!port) {
      appendSerial("Select a port before connecting.");
      return false;
    }
    try {
      serialStartedAt.current = Date.now();
      await invoke("open_serial", { port, baudRate: rate });
      setSerialOpen(true);
      setReconnectTarget(null);
      appendSerial(`Connected to ${port} at ${rate} baud.`);
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

  const runUpload = async (): Promise<AiToolResult> => {
    if (operation !== null) {
      return { success: false, message: "Upload could not start because another operation is running." };
    }
    if (!selectedBoard) {
      return { success: false, message: "Upload could not start because no board is selected." };
    }
    if (!selectedFqbn || !boardConfiguration || boardConfigurationError) {
      return { success: false, message: "Choose a valid concrete board configuration before uploading." };
    }
    if (!compileSucceededRef.current) {
      return { success: false, message: "Upload is disabled until the current editor buffer compiles successfully." };
    }
    const wasOpen = serialOpen;
    const serialTarget = wasOpen ? { port: selectedPort, baudRate } : null;
    setOperation("upload");
    setReconnectTarget(null);
    if (wasOpen) {
      appendSerial("Disconnected for upload…");
      await closeSerial("upload");
    }
    appendLog(`Uploading ${filePath ? basename(filePath) : "Untitled.ino"} to ${selectedBoard.port}…`, "upload");
    try {
      const result = await invoke<OperationResult>("upload_sketch", {
        sketchCode: code,
        port: selectedBoard.port,
        fqbn: selectedFqbn,
        boardOptions: selectedBoardOptions,
      });
      appendLog(
        result.success ? "Upload finished successfully." : `Upload failed (exit ${result.exitCode ?? "unknown"}).`,
        "upload",
        result.success ? "system" : "stderr",
      );
      return {
        success: result.success,
        message: result.success
          ? `Upload to ${selectedBoard.port} succeeded.`
          : `Upload failed with exit code ${result.exitCode ?? "unknown"}. Check Build output for details.`,
      };
    } catch (error) {
      const message = errorMessage(error);
      appendLog(`Upload failed: ${message}`, "upload", "stderr");
      return { success: false, message: `Upload failed: ${message}` };
    } finally {
      setReconnectTarget(serialTarget);
      setOperation(null);
    }
  };

  const runAiCompile = async (): Promise<AiToolResult> => {
    if (aiEdit) {
      return { success: false, message: "Review and apply or discard the pending code changes before compiling." };
    }
    return runCompile();
  };

  const runAiUpload = async (): Promise<AiToolResult> => {
    if (aiEdit) {
      return { success: false, message: "Review and apply or discard the pending code changes before uploading." };
    }
    if (!selectedBoard || !compileSucceededRef.current) return runUpload();
    const approved = await confirm(
      `The AI requested an upload to ${selectedBoardName} on ${selectedBoard.port}. Continue?`,
      {
        title: "Allow AI upload?",
        kind: "warning",
        okLabel: "Upload",
        cancelLabel: "Cancel",
      },
    );
    if (!approved) return { success: false, message: "Upload cancelled—nothing was written to the board." };
    return runUpload();
  };

  const retryLibraryInstall = (header: string) => {
    if (!selectedBoard) {
      appendLog("Select a connected board before retrying library installation.", "system", "stderr");
      return;
    }
    const current = libraryInstalls[header];
    setLibraryInstalls((installs) => ({
      ...installs,
      [header]: {
        header,
        package: current?.package ?? "",
        status: "resolving",
        progress: 8,
        message: "Retry queued…",
      },
    }));
    void invoke("sync_libraries", {
      headers: [header],
      fqbn: selectedFqbn,
      retry: true,
    }).catch((error) => {
      const message = errorMessage(error);
      appendLog(`Library install failed for ${header}: ${message}`, "library", "stderr");
      setLibraryInstalls((installs) => ({
        ...installs,
        [header]: {
          header,
          package: current?.package ?? "",
          status: "failed",
          progress: 100,
          message,
        },
      }));
    });
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

  const enableAi = (provider: AiProvider, apiKey: string, customUrl: string, model: string) => {
    updateSettings((current) => ({
      ...current,
      onboardingComplete: true,
      aiEnabled: true,
      aiProvider: provider,
      apiKeys: { ...current.apiKeys, [provider]: apiKey },
      aiModels: { ...current.aiModels, [provider]: model },
      customProviderUrl: customUrl,
      customProviderModel: provider === "custom" ? model : current.customProviderModel,
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
      layout: { ...current.layout, preset: "custom", aiVisible: false, outer: { workspace: 100, ai: 0 } },
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
  const finishStartup = useCallback(() => setShowStartup(false), []);

  if (showStartup) {
    return <StartupSplash onComplete={finishStartup} />;
  }

  if (!settingsReady) {
    return (
      <main className="grid h-screen place-items-center bg-canvas text-zinc-400">
        <div className="flex items-center gap-3 text-sm">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-orange-500/15 text-orange-400">
            <TraceMark className="h-[18px] w-[18px]" />
          </span>
          <span>Loading Trace…</span>
          <LoaderCircle size={14} className="animate-spin" />
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-[520px] flex-col overflow-hidden bg-canvas text-zinc-200">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <div className="mr-2 flex items-center gap-2" title="Trace">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-zinc-700/80 bg-zinc-900 text-zinc-100">
            <TraceMark className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Trace</span>
        </div>

        <button className="toolbar-button" onClick={openSketch} disabled={operation !== null || aiEdit !== null}><FolderOpen size={14} /> Open</button>
        <button className="toolbar-button" onClick={() => void saveAsSketch()} disabled={operation !== null || aiEdit !== null}><Save size={14} /> Save As</button>
        <div className="mx-1 h-5 w-px bg-line" />

        <div className="select-wrap min-w-48 max-w-72 flex-1">
          <CircleDot size={13} className={selectedBoard ? "text-emerald-400" : "text-zinc-600"} />
          <select
            value={selectedPort}
            onChange={(event) => {
              setSelectedPort(event.target.value);
              setBoardConfiguration(null);
              setBoardConfigurationError(null);
              setBoardOptionsOpen(false);
              invalidateCompile();
              setReconnectTarget(null);
              if (serialOpen) void closeSerial();
            }}
            disabled={boardsLoading || operation !== null}
            aria-label="Target board and port"
          >
            {boards.length === 0 && <option value="">No boards connected</option>}
            {boards.map((board) => (
              <option key={board.identityKey} value={board.port}>
                {board.matched
                  ? `${board.name} · ${board.port}`
                  : `Unidentified board (${board.usbLabel}) · ${board.port}`}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none text-zinc-500" />
        </div>
        {selectedBoard && (!selectedBoard.matched || selectedBoard.candidates.length > 1 || (selectedOverride && selectedOverride !== selectedBoard.fqbn)) && (
          <div className="layout-switcher max-w-64" title={`Choose the concrete board connected through ${selectedBoard.usbLabel}`}>
            <select
              value={selectedFqbn}
              onChange={(event) => {
                const fqbn = event.target.value;
                setBoardConfiguration(null);
                setBoardConfigurationError(null);
                setBoardOptionsOpen(false);
                updateSettings((current) => ({
                  ...current,
                  boardTypeOverrides: {
                    ...current.boardTypeOverrides,
                    [selectedBoard.identityKey]: fqbn,
                  },
                }));
                invalidateCompile();
              }}
              disabled={operation !== null}
              aria-label="Concrete board model"
            >
              {!selectedFqbn && <option value="">Choose board…</option>}
              {boardChoices.map((board) => (
                <option key={board.fqbn} value={board.fqbn}>{board.name} · {board.fqbn}</option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none text-zinc-500" />
          </div>
        )}
        {selectedFqbn && (
          <button
            className={`icon-button ${boardOptionsOpen ? "is-active" : ""}`}
            onClick={() => boardConfiguration && setBoardOptionsOpen(true)}
            disabled={operation !== null || boardConfigurationLoading || !boardConfiguration}
            title={boardConfigurationLoading ? "Loading board options…" : "Board options"}
            aria-label="Board options"
          >
            {boardConfigurationLoading ? <LoaderCircle size={14} className="animate-spin" /> : <SlidersHorizontal size={14} />}
          </button>
        )}
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
          <button className="action-button border border-zinc-600 bg-zinc-100 text-zinc-950 hover:bg-white" onClick={() => void runCompile()} disabled={operation !== null || aiEdit !== null}>
            {operation === "compile" ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
            Compile
          </button>
          <button
            className="action-button upload-button"
            onClick={() => void runUpload()}
            disabled={!compileSucceeded || !selectedBoard || operation !== null || aiEdit !== null}
            title={!compileSucceeded ? "Compile successfully before uploading" : "Upload to board"}
          >
            {operation === "upload" ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
        </div>
      </header>

      {boardError && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-red-950/70 bg-red-950/20 px-3 text-[11px] text-red-300" role="status">
          <AlertTriangle size={12} /> Board detection failed: {boardError}
          <button className="panel-action ml-auto" onClick={() => void refreshBoards()}>Retry</button>
        </div>
      )}
      {boardConfigurationError && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-amber-950/70 bg-amber-950/20 px-3 text-[11px] text-amber-200" role="status">
          <AlertTriangle size={12} /> Board configuration: {boardConfigurationError}
        </div>
      )}

      <PackageInstallBar installs={libraryInstallList} onRetry={retryLibraryInstall} />

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
                  <div className="ml-4 flex items-center rounded-md border border-zinc-800 bg-zinc-950/70 p-0.5">
                    <button
                      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition ${editorView === "code" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                      onClick={() => setEditorView("code")}
                    >
                      <Code2 size={11} /> Code
                    </button>
                    <button
                      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition ${editorView === "blocks" ? "bg-orange-500/15 text-orange-300" : "text-zinc-500 hover:text-zinc-300"}`}
                      onClick={() => {
                        setBlocksOpened(true);
                        setEditorView("blocks");
                      }}
                      disabled={aiEdit !== null}
                      title={aiEdit ? "Apply or discard AI changes before editing blocks" : "Build the sketch with visual blocks"}
                    >
                      <Blocks size={11} /> Blocks
                    </button>
                  </div>
                  {aiEdit ? (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500">AI changes</span>
                      <button
                        className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                        onClick={() => setAiEdit(null)}
                      >
                        Discard
                      </button>
                      <button
                        className="rounded border border-emerald-800 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                        onClick={() => {
                          setCode(aiEdit.modified);
                          setDirty(true);
                          invalidateCompile();
                          setAiEdit(null);
                          setBlocksOpened(false);
                        }}
                      >
                        Apply changes
                      </button>
                    </div>
                  ) : (
                    <span className="ml-auto truncate text-[11px] text-zinc-600">{filePath ?? "Untitled sketch · compiles without saving"}</span>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  {aiEdit ? (
                    <DiffEditor
                      height="100%"
                      language="cpp"
                      theme="trace-dark"
                      original={aiEdit.original}
                      modified={aiEdit.modified}
                      beforeMount={configureMonaco}
                      options={{
                        automaticLayout: true,
                        readOnly: true,
                        originalEditable: false,
                        renderSideBySide: true,
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineHeight: 21,
                        fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
                        scrollBeyondLastLine: false,
                      }}
                    />
                  ) : (
                    <>
                      <div className={editorView === "code" ? "h-full" : "hidden h-full"}>
                        <Editor
                          height="100%"
                          language="cpp"
                          theme="trace-dark"
                          value={code}
                          beforeMount={configureMonaco}
                          onChange={(value) => {
                            setCode(value ?? "");
                            setDirty(true);
                            invalidateCompile();
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
                      {blocksOpened && (
                        <div className={editorView === "blocks" ? "h-full" : "hidden h-full"}>
                          <Suspense fallback={<div className="grid h-full place-items-center text-xs text-zinc-600">Loading blocks…</div>}>
                            <BlockEditor
                              active={editorView === "blocks"}
                              onCodeChange={(generated) => {
                                if (!generated || generated === code) return;
                                setCode(generated);
                                setDirty(true);
                                invalidateCompile();
                              }}
                            />
                          </Suspense>
                        </div>
                      )}
                    </>
                  )}
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
                    reconnectAvailable={reconnectTarget !== null}
                    onBaudRate={setBaudRate}
                    onTimestamps={(value) => updateSettings((current) => ({ ...current, serialTimestamps: value }))}
                    onInput={setSerialInput}
                    onToggle={() => serialOpen ? void closeSerial() : void openSerial()}
                    onSend={() => void sendSerial()}
                    onClear={() => setSerialEntries([])}
                    onReconnect={() => reconnectTarget && void openSerial(reconnectTarget)}
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
              <AiAssistant
                provider={settings.aiProvider}
                apiKey={apiKey}
                model={settings.aiModels[settings.aiProvider] ?? settings.customProviderModel}
                customUrl={settings.customProviderUrl}
                currentCode={aiEdit?.modified ?? code}
                explainPrompt={explainPrompt}
                onExplainConsumed={() => setExplainPrompt(null)}
                onProposeCode={(replacement) => {
                  setAiEdit({ original: aiEdit?.modified ?? code, modified: replacement });
                }}
                onCompile={runAiCompile}
                onUpload={runAiUpload}
              />
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
        <span className="ml-auto">{boardConfiguration ? `${boardConfiguration.platformArchitecture.toUpperCase()} · Arduino` : "Arduino"}</span>
      </footer>

      {boardOptionsOpen && boardConfiguration && (
        <BoardOptionsModal
          configuration={boardConfiguration}
          selections={selectedBoardOptions}
          onSave={(selections) => {
            setBoardConfiguration(null);
            setBoardConfigurationLoading(true);
            updateSettings((current) => ({
              ...current,
              boardOptionSelections: {
                ...current.boardOptionSelections,
                [selectedFqbn]: selections,
              },
            }));
            invalidateCompile();
            setBoardOptionsOpen(false);
          }}
          onClose={() => setBoardOptionsOpen(false)}
        />
      )}

      {(!settings.onboardingComplete || settingsOpen) && (
        <AiSettingsModal
          firstLaunch={!settings.onboardingComplete}
          settings={settings}
          onEnable={enableAi}
          onDisable={disableAi}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {closeWarningOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card max-w-md" role="alertdialog" aria-modal="true" aria-labelledby="discard-changes-title" aria-describedby="discard-changes-description">
            <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-amber-500/10 text-amber-300">
              <AlertTriangle size={20} />
            </div>
            <h2 id="discard-changes-title" className="text-lg font-semibold text-zinc-100">Discard Changes</h2>
            <p id="discard-changes-description" className="mt-2 text-sm leading-6 text-zinc-400">
              Your sketch has unsaved changes. Close Trace and discard them?
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button className="toolbar-button" onClick={() => void discardAndClose()}>Discard and close</button>
              <button className="action-button border border-zinc-600 bg-zinc-100 text-zinc-950 hover:bg-white" onClick={() => setCloseWarningOpen(false)} autoFocus>
                Keep editing
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
