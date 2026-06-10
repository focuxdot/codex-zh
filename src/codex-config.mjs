export const SUPPORTED_WIRE_APIS = new Set(["responses"]);

export function buildCodexConfig(input) {
  const provider = requireProviderId(input.provider);
  const providerName = requireNonEmpty(input.providerName ?? input.provider, "providerName");
  const baseUrl = requireBaseUrl(input.baseUrl);
  const model = requireNonEmpty(input.model, "model");
  const wireApi = requireWireApi(input.wireApi ?? "responses");
  const apiKey = requireNonEmpty(input.apiKey, "apiKey");
  const reasoningEffort = requireNonEmpty(input.reasoningEffort ?? "medium", "reasoningEffort");
  const conversationDetailMode = requireNonEmpty(
    input.conversationDetailMode ?? "STEPS_COMMANDS",
    "conversationDetailMode",
  );

  return [
    `model = "${escapeToml(model)}"`,
    `model_provider = "${escapeToml(provider)}"`,
    `model_reasoning_effort = "${escapeToml(reasoningEffort)}"`,
    "",
    `[model_providers.${provider}]`,
    `name = "${escapeToml(providerName)}"`,
    `base_url = "${escapeToml(baseUrl)}"`,
    `wire_api = "${escapeToml(wireApi)}"`,
    `experimental_bearer_token = "${escapeToml(apiKey)}"`,
    "",
    "[desktop]",
    `conversationDetailMode = "${escapeToml(conversationDetailMode)}"`,
    "",
  ].join("\n");
}

export function requireProviderId(value) {
  const provider = requireNonEmpty(value, "provider");
  if (!/^[A-Za-z0-9_-]+$/u.test(provider)) {
    throw new Error("provider must contain only letters, numbers, underscores, or dashes");
  }
  return provider;
}

export function requireWireApi(value) {
  const wireApi = requireNonEmpty(value, "wireApi");
  if (!SUPPORTED_WIRE_APIS.has(wireApi)) {
    throw new Error(`wireApi must be one of: ${Array.from(SUPPORTED_WIRE_APIS).join(", ")}`);
  }
  return wireApi;
}

export function requireBaseUrl(value) {
  const baseUrl = stripTrailingSlash(requireNonEmpty(value, "baseUrl"));
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return baseUrl;
}

export function requireNonEmpty(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

export function stripTrailingSlash(value) {
  return String(value ?? "").trim().replace(/\/+$/u, "");
}

export function escapeToml(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t");
}
