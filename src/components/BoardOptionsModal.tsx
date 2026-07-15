import { AlertTriangle, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BoardConfiguration } from "../types";

interface BoardOptionsModalProps {
  configuration: BoardConfiguration;
  selections: Record<string, string>;
  onSave: (selections: Record<string, string>) => void;
  onClose: () => void;
}

export function BoardOptionsModal({ configuration, selections, onSave, onClose }: BoardOptionsModalProps) {
  const defaults = useMemo(() => Object.fromEntries(
    configuration.menus.flatMap((menu) => menu.selected ? [[menu.option, menu.selected]] : []),
  ), [configuration]);
  const [draft, setDraft] = useState<Record<string, string>>({ ...defaults, ...selections });

  useEffect(() => {
    setDraft({ ...defaults, ...selections });
  }, [defaults, selections]);

  const missing = configuration.menus.filter(
    (menu) => menu.requiresSelection && !draft[menu.option],
  );

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="board-options-title">
        <button className="icon-button absolute right-4 top-4" onClick={onClose} aria-label="Close board options">
          <X size={14} />
        </button>
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-orange-500/10 text-orange-300">
          <SlidersHorizontal size={19} />
        </div>
        <h2 id="board-options-title" className="text-lg font-semibold text-zinc-100">Board options</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          {configuration.name} · {configuration.platformPackage}:{configuration.platformArchitecture} {configuration.platformVersion}
        </p>

        {missing.length > 0 && (
          <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
            <AlertTriangle className="mt-0.5 shrink-0" size={14} />
            This board has no platform default for {missing.map((menu) => menu.label).join(", ")}. Choose a value before compiling.
          </div>
        )}

        <div className="mt-5 grid gap-4">
          {configuration.menus.map((menu) => (
            <label className="settings-field" key={menu.option}>
              <span>{menu.label}</span>
              <select
                value={draft[menu.option] ?? ""}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  [menu.option]: event.target.value,
                }))}
              >
                {!draft[menu.option] && <option value="" disabled>Select…</option>}
                {menu.values.map((value) => (
                  <option key={value.value} value={value.value}>{value.label || value.value}</option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {configuration.menus.length === 0 && (
          <p className="mt-5 rounded-lg border border-line bg-zinc-950/60 p-3 text-xs text-zinc-500">
            This board has no configurable platform menus.
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button className="toolbar-button" onClick={onClose}>Cancel</button>
          <button
            className="action-button bg-orange-500 text-zinc-950 hover:bg-orange-400"
            disabled={missing.length > 0}
            onClick={() => onSave(draft)}
          >
            Save board options
          </button>
        </div>
        <p className="mt-4 break-all text-[10px] leading-4 text-zinc-600">
          Defaults and available values are read from {configuration.boardsFile}.
        </p>
      </section>
    </div>
  );
}
