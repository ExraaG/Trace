import { Check, Cpu, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Board, InstalledBoard } from "../types";

interface BoardPickerModalProps {
  board: Board;
  choices: InstalledBoard[];
  selectedFqbn: string;
  hasOverride: boolean;
  onSelect: (fqbn: string) => void;
  onUseDetected: () => void;
  onClose: () => void;
}

export function BoardPickerModal({
  board,
  choices,
  selectedFqbn,
  hasOverride,
  onSelect,
  onUseDetected,
  onClose,
}: BoardPickerModalProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(selectedFqbn);
  const detected = useMemo(() => new Set(board.candidates.map((candidate) => candidate.fqbn)), [board.candidates]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return choices;
    return choices.filter((choice) => `${choice.name} ${choice.fqbn}`.toLocaleLowerCase().includes(normalized));
  }, [choices, query]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card max-w-xl" role="dialog" aria-modal="true" aria-labelledby="board-picker-title">
        <button className="icon-button absolute right-4 top-4" onClick={onClose} aria-label="Close board picker">
          <X size={14} />
        </button>
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-orange-500/10 text-orange-300">
          <Cpu size={20} />
        </div>
        <h2 id="board-picker-title" className="text-lg font-semibold text-zinc-100">Wrong board?</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Choose the board connected at <span className="text-zinc-200">{board.port}</span>. Trace will remember it for this USB device.
        </p>

        <label className="settings-field mt-5">
          <span>Search installed boards</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" size={13} />
            <input
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Board name or FQBN…"
              autoFocus
            />
          </span>
        </label>

        <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line bg-zinc-950/60 p-1">
          {filtered.map((choice) => (
            <button
              type="button"
              key={choice.fqbn}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${selected === choice.fqbn ? "bg-orange-500/15 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"}`}
              onClick={() => setSelected(choice.fqbn)}
            >
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${selected === choice.fqbn ? "border-orange-400 bg-orange-500 text-zinc-950" : "border-zinc-700"}`}>
                {selected === choice.fqbn && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-medium">
                  <span className="truncate">{choice.name}</span>
                  {detected.has(choice.fqbn) && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-300">Detected</span>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">{choice.fqbn}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-zinc-600">No installed boards match “{query}”.</p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            className="panel-action"
            onClick={onUseDetected}
            disabled={!hasOverride || !board.fqbn}
            title={!board.fqbn ? "Automatic detection did not find one concrete board" : "Remove the saved correction"}
          >
            Use automatic detection
          </button>
          <div className="flex gap-2">
            <button className="toolbar-button" onClick={onClose}>Cancel</button>
            <button
              className="action-button bg-orange-500 text-zinc-950 hover:bg-orange-400"
              disabled={!selected}
              onClick={() => onSelect(selected)}
            >
              Remember this board
            </button>
          </div>
        </div>
        <p className="mt-4 text-[10px] leading-4 text-zinc-600">
          Stored locally for {board.usbLabel} · {board.identityKey}. Disconnecting the board does not remove the mapping.
        </p>
      </section>
    </div>
  );
}
