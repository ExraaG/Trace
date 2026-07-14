import { Bot, ExternalLink, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PROVIDERS } from "../ai/providers";
import type { AiProvider, AppSettings } from "../types";

interface AiSettingsModalProps {
  firstLaunch: boolean;
  settings: AppSettings;
  onEnable: (provider: AiProvider, apiKey: string) => void;
  onDisable: () => void;
  onClose: () => void;
}

export function AiSettingsModal({ firstLaunch, settings, onEnable, onDisable, onClose }: AiSettingsModalProps) {
  const [enabled, setEnabled] = useState(firstLaunch || settings.aiEnabled);
  const [provider, setProvider] = useState<AiProvider>(settings.aiProvider);
  const [apiKey, setApiKey] = useState(settings.apiKeys[settings.aiProvider] ?? "");

  useEffect(() => {
    setApiKey(settings.apiKeys[provider] ?? "");
  }, [provider, settings.apiKeys]);

  const decline = () => {
    onDisable();
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        {!firstLaunch && (
          <button className="icon-button absolute right-4 top-4" onClick={onClose} aria-label="Close settings">
            <X size={14} />
          </button>
        )}
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-orange-500/10 text-orange-300">
          <Bot size={20} />
        </div>
        <h2 id="ai-settings-title" className="text-lg font-semibold text-zinc-100">
          {firstLaunch ? "Would you like to enable an AI assistant?" : "AI assistant settings"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          This is completely optional and uses your own API key. Trace sends chat content only to the provider you choose—never to a Trace server—and makes no AI requests while disabled.
        </p>

        {!firstLaunch && (
          <label className="settings-toggle mt-5">
            <span>
              <strong>AI assistant</strong>
              <small>{enabled ? "Visible and available in the workspace" : "No panel and no provider requests"}</small>
            </span>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          </label>
        )}

        <div className={`mt-5 grid gap-4 ${!enabled ? "pointer-events-none opacity-45" : ""}`}>
          <label className="settings-field">
            <span>Provider</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as AiProvider)}
            >
              {Object.values(PROVIDERS).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="settings-field">
            <span className="flex items-center gap-1.5"><KeyRound size={12} /> API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={PROVIDERS[provider].keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <a
            className="inline-flex w-fit items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
            href={PROVIDERS[provider].keyUrl}
            target="_blank"
            rel="noreferrer"
          >
            Create a {PROVIDERS[provider].label} API key <ExternalLink size={11} />
          </a>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button className="toolbar-button" onClick={firstLaunch ? decline : onClose}>{firstLaunch ? "Not now" : "Cancel"}</button>
          <button
            className={`action-button ${enabled ? "bg-orange-500 text-zinc-950 hover:bg-orange-400" : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"}`}
            disabled={enabled && !apiKey.trim()}
            onClick={() => {
              if (enabled) onEnable(provider, apiKey.trim());
              else onDisable();
              onClose();
            }}
          >
            {firstLaunch ? "Enable assistant" : "Save settings"}
          </button>
        </div>
        <p className="mt-4 text-[11px] leading-5 text-zinc-600">
          The key is stored locally in Trace’s app-data settings file. It is never written to build logs or serial output.
        </p>
      </section>
    </div>
  );
}
