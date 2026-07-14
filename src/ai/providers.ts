import { invoke } from "@tauri-apps/api/core";
import type { AiMessage, AiProvider } from "../types";

export interface ProviderAdapter {
  id: AiProvider;
  label: string;
  keyPlaceholder: string;
  keyUrl: string;
}

export const PROVIDERS: Record<AiProvider, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
  },
};

export function askProvider(provider: AiProvider, apiKey: string, messages: AiMessage[]) {
  return invoke<string>("ask_ai", { provider, apiKey, messages });
}
