import { AlertTriangle, Check, ChevronDown, Download, LoaderCircle, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { LibraryInstallEvent } from "../types";

interface PackageInstallBarProps {
  installs: LibraryInstallEvent[];
  onRetry: (header: string) => void;
}

const ACTIVE_STATUSES = new Set(["resolving", "downloading", "installing"]);

function statusLabel(install: LibraryInstallEvent) {
  switch (install.status) {
    case "resolving": return "Resolving";
    case "downloading": return "Downloading";
    case "installing": return "Installing";
    case "installed": return "Installed";
    case "failed": return "Failed";
  }
}

export function PackageInstallBar({ installs, onRetry }: PackageInstallBarProps) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...installs].sort((left, right) => {
    const rank = (status: LibraryInstallEvent["status"]) => status === "failed" ? 0 : ACTIVE_STATUSES.has(status) ? 1 : 2;
    return rank(left.status) - rank(right.status) || left.header.localeCompare(right.header);
  }), [installs]);
  const active = installs.filter((install) => ACTIVE_STATUSES.has(install.status));
  const failed = installs.filter((install) => install.status === "failed");
  const completed = installs.filter((install) => install.status === "installed");
  const averageProgress = active.length
    ? Math.round(active.reduce((sum, install) => sum + install.progress, 0) / active.length)
    : 100;

  if (installs.length === 0) return null;

  const summary = active.length > 0
    ? `${active.length} ${active.length === 1 ? "Package" : "Packages"} Installing`
    : failed.length > 0
      ? `${failed.length} ${failed.length === 1 ? "Package" : "Packages"} Failed`
      : `${completed.length} ${completed.length === 1 ? "Package" : "Packages"} Installed`;

  return (
    <section className={`package-install-bar ${expanded ? "is-expanded" : ""}`} aria-label="Library installations">
      <button className="package-install-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {active.length > 0
          ? <LoaderCircle size={13} className="spin-centered text-orange-400" />
          : failed.length > 0
            ? <AlertTriangle size={13} className="text-red-400" />
            : <Check size={13} className="text-emerald-400" />}
        <span className="font-medium text-zinc-300">{summary}</span>
        {active.length > 0 && <span className="text-[10px] tabular-nums text-zinc-600">{averageProgress}%</span>}
        <ChevronDown size={13} className={`ml-auto text-zinc-600 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="package-install-list">
          {sorted.map((install) => (
            <div className="package-install-item" key={install.header}>
              <div className="flex min-w-0 items-center gap-2">
                {ACTIVE_STATUSES.has(install.status)
                  ? <Download size={12} className="shrink-0 text-orange-400" />
                  : install.status === "failed"
                    ? <AlertTriangle size={12} className="shrink-0 text-red-400" />
                    : <Check size={12} className="shrink-0 text-emerald-400" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="truncate font-medium text-zinc-300">{install.package || install.header}</span>
                    {install.package && <span className="truncate text-zinc-600">for {install.header}</span>}
                    <span className={`ml-auto shrink-0 ${install.status === "failed" ? "text-red-400" : "text-zinc-500"}`}>
                      {statusLabel(install)}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${install.status === "failed" ? "bg-red-500" : install.status === "installed" ? "bg-emerald-500" : "bg-orange-500"}`}
                      style={{ width: `${Math.max(4, install.progress)}%` }}
                    />
                  </div>
                  <p className={`mt-1 truncate text-[10px] ${install.status === "failed" ? "text-red-300/80" : "text-zinc-600"}`} title={install.message}>
                    {install.message}
                  </p>
                </div>
                {install.status === "failed" && (
                  <button className="panel-action flex shrink-0 items-center gap-1" onClick={() => onRetry(install.header)}>
                    <RotateCcw size={10} /> Install
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
