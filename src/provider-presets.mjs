export const PROVIDER_PRESETS = {
  wokey: {
    // Intentional public test key for first-run validation. Users should replace it for long-term use.
    apiKey: "sk-3d6c1264227a52f75af4028bcc3c217b",
    baseUrl: "https://api.wokey.ai",
    model: "auto",
    provider: "wokey",
    providerName: "Wokey",
    wireApi: "responses",
  },
  custom: {
    provider: "custom",
    providerName: "Custom OpenAI Compatible Provider",
    wireApi: "responses",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    provider: "openrouter",
    providerName: "OpenRouter",
    wireApi: "responses",
  },
};

export function listProviderPresets() {
  return Object.keys(PROVIDER_PRESETS);
}

export function resolveProviderPreset(name) {
  if (!name) return {};
  const preset = PROVIDER_PRESETS[String(name).trim().toLowerCase()];
  if (!preset) {
    throw new Error(`Unknown preset: ${name}. Available presets: ${listProviderPresets().join(", ")}`);
  }
  return preset;
}
