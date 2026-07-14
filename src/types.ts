export interface Board {
  name: string;
  port: string;
  fqbn: string;
}

export type Operation = "compile" | "upload";

export interface ToolOutput {
  operation: Operation;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface OperationResult {
  success: boolean;
  exitCode: number | null;
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
  source: "compile" | "upload" | "system";
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
  layout: PanelLayout;
}
