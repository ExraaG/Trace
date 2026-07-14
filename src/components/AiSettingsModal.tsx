import { Bot, ExternalLink, KeyRound, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listProviderModels, PROVIDERS } from "../ai/providers";
import type { AiModel, AiProvider, AppSettings } from "../types";

interface AiSettingsModalProps {
  firstLaunch: boolean;
  settings: AppSettings;
  onEnable: (provider: AiProvider, apiKey: string, customUrl: string, model: string) => void;
  onDisable: () => void;
  onClose: () => void;
}

export function AiSettingsModal({ firstLaunch, settings, onEnable, onDisable, onClose }: AiSettingsModalProps) {
  const [enabled, setEnabled] = useState(firstLaunch || settings.aiEnabled);
  const [provider, setProvider] = useState<AiProvider | "">(firstLaunch ? "" : settings.aiProvider);
  const [apiKey, setApiKey] = useState(settings.apiKeys[settings.aiProvider] ?? "");
  const [customUrl, setCustomUrl] = useState(settings.customProviderUrl);
  const [model, setModel] = useState(settings.aiModels[settings.aiProvider] ?? settings.customProviderModel);
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelRequest = useRef(0);
  const selectedProvider = provider ? PROVIDERS[provider] : null;
  const keyMissing = Boolean(selectedProvider?.keyRequired && !apiKey.trim());
  const customMissing = provider === "custom" && !customUrl.trim();
  const modelMissing = !model.trim();

  useEffect(() => {
    modelRequest.current += 1;
    setModelsLoading(false);
    setApiKey(provider ? settings.apiKeys[provider] ?? "" : "");
    setModel(provider ? settings.aiModels[provider] ?? PROVIDERS[provider].defaultModel : "");
    setModels([]);
    setModelsError(null);
  }, [provider, settings.aiModels, settings.apiKeys]);

  const loadModels = useCallback(async () => {
    if (!provider || (PROVIDERS[provider].keyRequired && !apiKey.trim()) || (provider === "custom" && !customUrl.trim())) return;
    const request = ++modelRequest.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const available = await listProviderModels(provider, apiKey.trim(), customUrl.trim());
      if (request !== modelRequest.current) return;
      setModels(available);
      setModel((current) => available.some((item) => item.id === current) ? current : available[0]?.id ?? current);
    } catch (reason) {
      if (request !== modelRequest.current) return;
      setModels([]);
      setModelsError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === modelRequest.current) setModelsLoading(false);
    }
  }, [apiKey, customUrl, provider]);

  useEffect(() => {
    if (!enabled || !provider || keyMissing || customMissing) return;
    const timer = window.setTimeout(() => void loadModels(), 600);
    return () => window.clearTimeout(timer);
  }, [customMissing, enabled, keyMissing, loadModels, provider]);

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
          This is completely optional and uses credentials you provide when required. Trace sends chat content only to the destination you choose—never to a Trace server—and makes no AI requests while disabled.
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
              <option value="" disabled>Select a provider…</option>
              {Object.values(PROVIDERS).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {provider === "custom" && (
            <>
              <label className="settings-field">
                <span>OpenAI-compatible endpoint URL</span>
                <input
                  type="url"
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="http://localhost:11434/v1/chat/completions"
                  spellCheck={false}
                />
              </label>
              <p className="-mt-2 text-[11px] leading-5 text-amber-300/70">
                Chat content and the optional bearer token are sent directly to this URL.
              </p>
            </>
          )}
          <label className="settings-field">
            <span className="flex items-center gap-1.5"><KeyRound size={12} /> API key{provider === "custom" ? " (optional)" : ""}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={selectedProvider?.keyPlaceholder ?? "Select a provider first"}
              disabled={!selectedProvider}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {selectedProvider?.keyUrl && (
            <a
              className="inline-flex w-fit items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              href={selectedProvider.keyUrl}
              target="_blank"
              rel="noreferrer"
            >
              Create a {selectedProvider.label} API key <ExternalLink size={11} />
            </a>
          )}
          {selectedProvider && (
            <label className="settings-field">
              <span className="flex items-center justify-between">
                <span>Model</span>
                <button
                  className="inline-flex items-center gap-1 text-[10px] font-normal text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                  type="button"
                  onClick={() => void loadModels()}
                  disabled={modelsLoading || keyMissing || customMissing}
                >
                  <RefreshCw size={10} className={modelsLoading ? "spin-centered" : ""} />
                  {modelsLoading ? "Checking API…" : "Refresh models"}
                </button>
              </span>
              <select value={model} onChange={(event) => setModel(event.target.value)} disabled={modelsLoading && models.length === 0}>
                {!models.some((item) => item.id === model) && model && <option value={model}>{model}</option>}
                {models.map((item) => <option key={item.id} value={item.id}>{item.label}{item.label !== item.id ? ` · ${item.id}` : ""}</option>)}
              </select>
            </label>
          )}
          {provider === "custom" && (
            <label className="settings-field">
              <span>Manual model ID</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="local-model" spellCheck={false} />
            </label>
          )}
          {modelsError && <p className="-mt-2 text-[11px] leading-5 text-red-300">Could not load models: {modelsError}</p>}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button className="toolbar-button" onClick={firstLaunch ? decline : onClose}>{firstLaunch ? "Not now" : "Cancel"}</button>
          <button
            className={`action-button ${enabled ? "bg-orange-500 text-zinc-950 hover:bg-orange-400" : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"}`}
            disabled={enabled && (!provider || keyMissing || customMissing || modelMissing)}
            onClick={() => {
              if (enabled && provider) onEnable(provider, apiKey.trim(), customUrl.trim(), model.trim());
              else onDisable();
              onClose();
            }}
          >
            {firstLaunch ? "Enable assistant" : "Save settings"}
          </button>
        </div>
        <p className="mt-4 text-[11px] leading-5 text-zinc-600">
          Credentials and custom endpoint details are stored locally in Trace’s app-data settings file. They are never written to build logs or serial output.
        </p>
      </section>
    </div>
  );
}
