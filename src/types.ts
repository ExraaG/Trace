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
