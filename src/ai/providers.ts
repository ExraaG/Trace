import { invoke } from "@tauri-apps/api/core";
import type { AiMessage, AiProvider } from "../types";

export interface ProviderAdapter {
  id: AiProvider;
  label: string;
  keyPlaceholder: string;
  keyUrl?: string;
  keyRequired: boolean;
}

export const PROVIDERS: Record<AiProvider, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyRequired: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    keyRequired: true,
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyRequired: true,
  },
  custom: {
    id: "custom",
    label: "Custom URL",
    keyPlaceholder: "Optional bearer token",
    keyRequired: false,
  },
};

export function askProvider(
  provider: AiProvider,
  apiKey: string,
  messages: AiMessage[],
  customUrl?: string,
  customModel?: string,
) {
  return invoke<string>("ask_ai", { provider, apiKey, messages, customUrl, customModel });
}
