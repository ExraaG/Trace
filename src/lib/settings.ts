import { load, type Store } from "@tauri-apps/plugin-store";
import type { AppSettings, LayoutPreset, PanelLayout } from "../types";

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
  serialTimestamps: false,
  layout: PRESET_LAYOUTS.debug,
};

let storePromise: Promise<Store> | null = null;

function settingsStore() {
  storePromise ??= load("trace-settings.json", { autoSave: 150, defaults: {} });
  return storePromise;
}

function mergeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  if (!value) return structuredClone(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...value.apiKeys },
    layout: {
      ...DEFAULT_SETTINGS.layout,
      ...value.layout,
      outer: { ...DEFAULT_SETTINGS.layout.outer, ...value.layout?.outer },
      vertical: { ...DEFAULT_SETTINGS.layout.vertical, ...value.layout?.vertical },
      bottom: { ...DEFAULT_SETTINGS.layout.bottom, ...value.layout?.bottom },
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
