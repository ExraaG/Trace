import { Clock3, Plug, Send, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Operation, SerialEntry } from "../types";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface SerialConsoleProps {
  entries: SerialEntry[];
  open: boolean;
  hasPort: boolean;
  baudRate: number;
  timestamps: boolean;
  input: string;
  operation: Operation | null;
  reconnectAvailable: boolean;
  onBaudRate: (value: number) => void;
  onTimestamps: (value: boolean) => void;
  onInput: (value: string) => void;
  onToggle: () => void;
  onSend: () => void;
  onClear: () => void;
  onReconnect: () => void;
}

function timestamp(elapsedMs: number) {
  return `+${(elapsedMs / 1000).toFixed(3).padStart(8, "0")}`;
}

export function SerialConsole(props: SerialConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followOutput, setFollowOutput] = useState(true);

  useEffect(() => {
    if (!followOutput) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [followOutput, props.entries]);

  return (
    <section className="panel-shell" aria-label="Serial console">
      <div className="panel-header normal-case tracking-normal">
        <span className={`h-2 w-2 rounded-full ${props.open ? "bg-emerald-400" : "bg-zinc-600"}`} />
        <span className="font-semibold uppercase tracking-wider">Console</span>
        <select
          className="compact-select ml-auto"
          value={props.baudRate}
          onChange={(event) => props.onBaudRate(Number(event.target.value))}
          disabled={props.open}
          aria-label="Serial baud rate"
        >
          {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate} baud</option>)}
        </select>
        <button
          className={`panel-action flex items-center gap-1 ${props.timestamps ? "text-orange-300" : ""}`}
          onClick={() => props.onTimestamps(!props.timestamps)}
          title="Toggle relative timestamps"
        >
          <Clock3 size={11} /> Time
        </button>
        <button
          className="panel-action"
          onClick={() => {
            setFollowOutput(true);
            props.onClear();
          }}
        >
          Clear
        </button>
        <button
          className={`console-connect ${props.open ? "is-open" : ""}`}
          onClick={props.onToggle}
          disabled={!props.hasPort || props.operation !== null}
        >
          {props.open ? <Unplug size={12} /> : <Plug size={12} />}
          {props.open ? "Disconnect" : "Connect"}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="log-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowOutput(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
        }}
      >
        {props.entries.length === 0 && (
          <span className="text-zinc-600">{props.open ? "Waiting for serial data…" : "Connect to monitor serial output."}</span>
        )}
        {props.entries.map((entry) => (
          <div key={entry.id} className={entry.kind === "status" ? "text-amber-300/90" : "text-emerald-200/90"}>
            {props.timestamps && <span className="mr-2 select-none text-zinc-600">{timestamp(entry.elapsedMs)}</span>}
            {entry.line || " "}
          </div>
        ))}
      </div>
      {props.reconnectAvailable && !props.open && props.operation === null && (
        <div className="console-notice">
          Upload released the serial port.
          <button onClick={props.onReconnect}>Reconnect</button>
        </div>
      )}
      <form
        className="console-input"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSend();
        }}
      >
        <input
          value={props.input}
          onChange={(event) => props.onInput(event.target.value)}
          placeholder={props.open ? "Send to board and press Enter…" : "Connect to send data"}
          disabled={!props.open}
        />
        <button className="icon-button h-7 w-7" type="submit" disabled={!props.open || !props.input} title="Send" aria-label="Send serial data">
          <Send size={13} />
        </button>
      </form>
    </section>
  );
}
