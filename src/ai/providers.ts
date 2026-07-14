import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiMessage, AiModel, AiProvider, AiStreamChunk } from "../types";

export interface ProviderAdapter {
  id: AiProvider;
  label: string;
  keyPlaceholder: string;
  keyUrl?: string;
  keyRequired: boolean;
  defaultModel: string;
}

export const PROVIDERS: Record<AiProvider, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyRequired: true,
    defaultModel: "claude-sonnet-5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    keyRequired: true,
    defaultModel: "gpt-5.6-luna",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyRequired: true,
    defaultModel: "gemini-3.5-flash",
  },
  custom: {
    id: "custom",
    label: "Custom URL",
    keyPlaceholder: "Optional bearer token",
    keyRequired: false,
    defaultModel: "local-model",
  },
};

export function askProvider(
  provider: AiProvider,
  apiKey: string,
  model: string,
  messages: AiMessage[],
  customUrl: string | undefined,
  onDelta: (delta: string) => void,
) {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return listen<AiStreamChunk>("ai-stream", ({ payload }) => {
    if (payload.requestId === requestId) onDelta(payload.delta);
  }).then(async (unlisten) => {
    try {
      return await invoke<string>("ask_ai", { requestId, provider, apiKey, model, messages, customUrl });
    } finally {
      unlisten();
    }
  });
}

export function listProviderModels(provider: AiProvider, apiKey: string, customUrl?: string) {
  return invoke<AiModel[]>("list_ai_models", { provider, apiKey, customUrl });
}
