import { requireBaseUrl, requireNonEmpty, requireWireApi } from "./codex-config.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

export async function testProviderConnection({
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  wireApi,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }
  const resolvedBaseUrl = requireBaseUrl(baseUrl);
  const resolvedWireApi = requireWireApi(wireApi ?? "responses");
  const resolvedModel = requireNonEmpty(model, "model");
  const resolvedApiKey = requireNonEmpty(apiKey, "apiKey");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const request = buildProviderTestRequest({
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      model: resolvedModel,
      wireApi: resolvedWireApi,
    });
    const response = await fetchImpl(request.url, {
      body: JSON.stringify(request.body),
      headers: request.headers,
      method: "POST",
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        suggestion: suggestionForStatus(response.status),
        wireApi: resolvedWireApi,
        error: providerErrorMessage(parsed, text),
      };
    }
    return {
      ok: true,
      statusCode: response.status,
      wireApi: resolvedWireApi,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      suggestion:
        error?.name === "AbortError"
          ? "请求超时，请检查中转站地址、网络或代理。"
          : "网络请求失败，请检查中转站地址、防火墙或代理。",
      wireApi: resolvedWireApi,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildProviderTestRequest({ apiKey, baseUrl, model, wireApi }) {
  const resolvedBaseUrl = requireBaseUrl(baseUrl);
  const resolvedWireApi = requireWireApi(wireApi);
  const endpoint = `${resolvedBaseUrl}/responses`;
  const body = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK." }],
      },
    ],
    model,
    stream: false,
  };
  return {
    body,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    url: endpoint,
  };
}

function suggestionForStatus(status) {
  if (status === 401 || status === 403) {
    return "API Key 无效或没有权限，请检查中转站后台的密钥和额度。";
  }
  if (status === 404) {
    return "接口不存在，请检查 Base URL 是否包含 /v1，或切换 wire_api。";
  }
  if (status === 400 || status === 422) {
    return "请求格式或模型名不被中转站接受，请检查模型名和 wire_api。";
  }
  if (status === 429) {
    return "中转站限流或额度不足，请稍后重试或检查套餐。";
  }
  if (status >= 500) {
    return "中转站服务异常，请稍后重试或更换节点。";
  }
  return "连接测试失败，请检查中转站配置。";
}

function providerErrorMessage(parsed, fallback) {
  if (parsed?.error?.message) return String(parsed.error.message);
  if (parsed?.message) return String(parsed.message);
  return String(fallback ?? "").slice(0, 500);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
