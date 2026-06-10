import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderTestRequest, testProviderConnection } from "../src/provider-test.mjs";

test("buildProviderTestRequest creates responses request", () => {
  const request = buildProviderTestRequest({
    apiKey: "sk-test",
    baseUrl: "https://relay.example.com/v1",
    model: "gpt-5-codex",
    wireApi: "responses",
  });

  assert.equal(request.url, "https://relay.example.com/v1/responses");
  assert.equal(request.body.model, "gpt-5-codex");
  assert.deepEqual(request.body.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Reply with OK." }],
    },
  ]);
  assert.equal(request.body.stream, false);
  assert.equal("max_output_tokens" in request.body, false);
});

test("testProviderConnection returns ok for successful provider response", async () => {
  const result = await testProviderConnection({
    apiKey: "sk-test",
    baseUrl: "https://relay.example.com/v1",
    fetchImpl: async () => new Response(JSON.stringify({ id: "ok" }), { status: 200 }),
    model: "gpt-4.1",
    wireApi: "responses",
  });

  assert.deepEqual(result, {
    ok: true,
    statusCode: 200,
    wireApi: "responses",
  });
});

test("testProviderConnection classifies auth errors", async () => {
  const result = await testProviderConnection({
    apiKey: "bad-key",
    baseUrl: "https://relay.example.com/v1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    model: "gpt-4.1",
    wireApi: "responses",
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, "invalid api key");
  assert.match(result.suggestion, /API Key/u);
});

test("chat wire API is rejected before writing an unsupported Codex config", () => {
  assert.throws(
    () =>
      buildProviderTestRequest({
        apiKey: "sk-test",
        baseUrl: "https://relay.example.com/v1",
        model: "gpt-4.1",
        wireApi: "chat",
      }),
    /wireApi must be one of: responses/u,
  );
});
