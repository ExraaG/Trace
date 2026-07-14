import { load, type Store } from "@tauri-apps/plugin-store";
import type { AiProvider, AppSettings, LayoutPreset, PanelLayout } from "../types";

const SETTINGS_KEY = "settings";

export const PRESET_LAYOUTS: Record<Exclude<LayoutPreset, "custom">, PanelLayout> = {
  focus: {
    preset: "focus",
    outer: { workspace: 100, ai: 0 },
    vertical: { editor: 80, lower: 20 },
    bottom: { build: 100, console: 0 },
    consoleVisible: false,
    aiVisible: false,
  },
  debug: {
    preset: "debug",
    outer: { workspace: 100, ai: 0 },
    vertical: { editor: 55, lower: 45 },
    bottom: { build: 42, console: 58 },
    consoleVisible: true,
    aiVisible: false,
  },
  full: {
    preset: "full",
    outer: { workspace: 72, ai: 28 },
    vertical: { editor: 58, lower: 42 },
    bottom: { build: 45, console: 55 },
    consoleVisible: true,
    aiVisible: true,
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  aiEnabled: false,
  aiProvider: "anthropic",
  apiKeys: {},
  aiModels: {
    anthropic: "claude-sonnet-5",
    openai: "gpt-5.6-luna",
    gemini: "gemini-3.5-flash",
    custom: "local-model",
  },
  customProviderUrl: "http://localhost:11434/v1/chat/completions",
  customProviderModel: "local-model",
  serialTimestamps: false,
  layout: PRESET_LAYOUTS.debug,
};

let storePromise: Promise<Store> | null = null;

function settingsStore() {
  storePromise ??= load("trace-settings.json", { autoSave: 150, defaults: {} });
  return storePromise;
}

const PROVIDER_IDS: AiProvider[] = ["anthropic", "openai", "gemini", "custom"];
const PRESET_IDS: LayoutPreset[] = ["focus", "debug", "full", "custom"];

function cleanLayout(
  value: Record<string, number> | undefined,
  fallback: Record<string, number>,
  ids: string[],
) {
  if (!value) return { ...fallback };
  const entries = ids.map((id) => [id, Number(value[id])] as const);
  if (entries.some(([, size]) => !Number.isFinite(size) || size < 0) || entries.every(([, size]) => size === 0)) {
    return { ...fallback };
  }
  return Object.fromEntries(entries);
}

function mergeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  if (!value) return structuredClone(DEFAULT_SETTINGS);
  const layout = value.layout;
  const provider = PROVIDER_IDS.includes(value.aiProvider as AiProvider)
    ? value.aiProvider as AiProvider
    : DEFAULT_SETTINGS.aiProvider;
  const apiKeys = Object.fromEntries(
    Object.entries(value.apiKeys ?? {}).filter(
      ([id, key]) => PROVIDER_IDS.includes(id as AiProvider) && typeof key === "string",
    ),
  ) as AppSettings["apiKeys"];
  const aiModels = Object.fromEntries(
    Object.entries(value.aiModels ?? {}).filter(
      ([id, model]) => PROVIDER_IDS.includes(id as AiProvider) && typeof model === "string" && model.trim(),
    ),
  ) as AppSettings["aiModels"];
  return {
    onboardingComplete: typeof value.onboardingComplete === "boolean" ? value.onboardingComplete : false,
    aiEnabled: typeof value.aiEnabled === "boolean" ? value.aiEnabled : false,
    aiProvider: provider,
    apiKeys,
    aiModels: { ...DEFAULT_SETTINGS.aiModels, ...aiModels },
    customProviderUrl: typeof value.customProviderUrl === "string" ? value.customProviderUrl : DEFAULT_SETTINGS.customProviderUrl,
    customProviderModel: typeof value.customProviderModel === "string" ? value.customProviderModel : DEFAULT_SETTINGS.customProviderModel,
    serialTimestamps: typeof value.serialTimestamps === "boolean" ? value.serialTimestamps : false,
    layout: {
      preset: PRESET_IDS.includes(layout?.preset as LayoutPreset) ? layout!.preset : DEFAULT_SETTINGS.layout.preset,
      outer: cleanLayout(layout?.outer, DEFAULT_SETTINGS.layout.outer, ["workspace", "ai"]),
      vertical: cleanLayout(layout?.vertical, DEFAULT_SETTINGS.layout.vertical, ["editor", "lower"]),
      bottom: cleanLayout(layout?.bottom, DEFAULT_SETTINGS.layout.bottom, ["build", "console"]),
      consoleVisible: typeof layout?.consoleVisible === "boolean" ? layout.consoleVisible : DEFAULT_SETTINGS.layout.consoleVisible,
      aiVisible: typeof layout?.aiVisible === "boolean" ? layout.aiVisible : DEFAULT_SETTINGS.layout.aiVisible,
    },
  };
}

export async function readSettings(): Promise<AppSettings> {
  const store = await settingsStore();
  return mergeSettings(await store.get<Partial<AppSettings>>(SETTINGS_KEY));
}

export async function writeSettings(settings: AppSettings): Promise<void> {
  const store = await settingsStore();
  await store.set(SETTINGS_KEY, settings);
}
