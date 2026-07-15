export interface Board {
  name: string;
  port: string;
  fqbn: string;
  matched: boolean;
  usbLabel: string;
  vid: string;
  pid: string;
  identityKey: string;
  candidates: InstalledBoard[];
}

export interface InstalledBoard {
  name: string;
  fqbn: string;
}

export interface BoardMenuValue {
  value: string;
  label: string;
  selected: boolean;
}

export interface BoardMenu {
  option: string;
  label: string;
  values: BoardMenuValue[];
  selected: string | null;
  requiresSelection: boolean;
}

export interface BoardConfiguration {
  name: string;
  fqbn: string;
  platformPackage: string;
  platformArchitecture: string;
  platformVersion: string;
  platformPath: string;
  boardsFile: string;
  menus: BoardMenu[];
  requiresSelection: string[];
}

export type Operation = "compile" | "upload" | "library";

export interface ToolOutput {
  operation: Operation;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface OperationResult {
  success: boolean;
  exitCode: number | null;
  missingHeader: string | null;
}

export type LibraryInstallStatus = "resolving" | "downloading" | "installing" | "installed" | "failed";

export interface LibraryInstallEvent {
  header: string;
  package: string;
  status: LibraryInstallStatus;
  progress: number;
  message: string;
}

export interface SerialLine {
  line: string;
}

export interface SerialEntry {
  id: number;
  line: string;
  elapsedMs: number;
  kind: "data" | "status";
}

export interface SerialStateEvent {
  open: boolean;
  port: string | null;
  reason: string;
}

export interface LogEntry {
  id: number;
  source: "compile" | "upload" | "library" | "system";
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export type AiProvider = "anthropic" | "openai" | "gemini" | "custom";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiModel {
  id: string;
  label: string;
}

export interface AiStreamChunk {
  requestId: string;
  delta: string;
}

export type LayoutPreset = "focus" | "debug" | "full" | "custom";

export interface PanelLayout {
  preset: LayoutPreset;
  outer: Record<string, number>;
  vertical: Record<string, number>;
  bottom: Record<string, number>;
  consoleVisible: boolean;
  aiVisible: boolean;
}

export interface AppSettings {
  onboardingComplete: boolean;
  aiEnabled: boolean;
  aiProvider: AiProvider;
  apiKeys: Partial<Record<AiProvider, string>>;
  aiModels: Partial<Record<AiProvider, string>>;
  customProviderUrl: string;
  customProviderModel: string;
  serialTimestamps: boolean;
  boardTypeOverrides: Record<string, string>;
  boardOptionSelections: Record<string, Record<string, string>>;
  layout: PanelLayout;
}
