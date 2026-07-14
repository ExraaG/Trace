import { LoaderCircle, TerminalSquare, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LogEntry, Operation } from "../types";

interface BuildOutputProps {
  logs: LogEntry[];
  operation: Operation | null;
  onClear: () => void;
  onExplain?: () => void;
}

export function BuildOutput({ logs, operation, onClear, onExplain }: BuildOutputProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followOutput, setFollowOutput] = useState(true);

  useEffect(() => {
    if (!followOutput) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [followOutput, logs]);

  return (
    <section className="panel-shell" aria-label="Build output">
      <div className="panel-header">
        <TerminalSquare size={13} />
        <span>Build output</span>
        {operation && <LoaderCircle size={12} className="animate-spin text-orange-400" />}
        <div className="ml-auto flex items-center gap-1">
          {onExplain && logs.length > 0 && (
            <button className="panel-action flex items-center gap-1" onClick={onExplain}>
              <WandSparkles size={11} /> Explain error
            </button>
          )}
          <button
            className="panel-action"
            onClick={() => {
              setFollowOutput(true);
              onClear();
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="log-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowOutput(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
        }}
      >
        {logs.length === 0 && <span className="text-zinc-600">Build and upload output will appear here.</span>}
        {logs.map((entry) => (
          <div
            key={entry.id}
            className={entry.stream === "stderr" ? "text-red-300" : entry.stream === "system" ? "text-zinc-400" : "text-zinc-300"}
          >
            <span className="mr-2 select-none text-zinc-700">›</span>{entry.text}
          </div>
        ))}
      </div>
    </section>
  );
}
