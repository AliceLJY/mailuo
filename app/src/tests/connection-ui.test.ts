import assert from "node:assert/strict";
import test from "node:test";

import {
  humanizeLocalProviderError,
  maskSecret,
  validateLocalKeySettings,
} from "../connection/presentation";
import { testServerConnection } from "../connection/server-health";
import { resolveStartupDestination } from "../connection/startup";

test("startup route sends an unconfigured app to the guide", () => {
  assert.equal(resolveStartupDestination(null, "ios"), "guide");
});

test("startup route opens the home screen for a server config", () => {
  assert.equal(
    resolveStartupDestination({ mode: "server", serverUrl: "https://mailuo.test" }, "android"),
    "home",
  );
});

test("startup route opens native local mode but sends web local config to server form", () => {
  assert.equal(resolveStartupDestination({ mode: "local" }, "ios"), "home");
  assert.equal(resolveStartupDestination({ mode: "local" }, "web"), "server-form");
});

test("startup route preserves the v1 public server URL fallback", () => {
  assert.equal(resolveStartupDestination(null, "android", "https://mailuo.test"), "home");
});

test("secret mask exposes only the final four characters", () => {
  const secret = "dashscope-private-7X9Z";
  const masked = maskSecret(secret);

  assert.equal(masked, "****7X9Z");
  assert.equal(masked?.includes("dashscope-private"), false);
});

test("local key validation requires DashScope but not DeepSeek", () => {
  assert.equal(
    validateLocalKeySettings({ dashscopeMask: null, dashscopeValue: "" }),
    "请填写 DashScope API Key。已设置的 Key 不需要重复填写。",
  );
  assert.equal(
    validateLocalKeySettings({ dashscopeMask: null, dashscopeValue: " dashscope-key " }),
    null,
  );
  assert.equal(
    validateLocalKeySettings({ dashscopeMask: "****1234", dashscopeValue: "" }),
    null,
  );
});

test("local provider errors distinguish key, network, and rate-limit failures without echoing details", () => {
  const keyMessage = humanizeLocalProviderError({
    statusCode: 401,
    message: "invalid api key: private-value",
  });

  assert.equal(keyMessage, "模型服务没有接受这个 Key，请检查后重新填写。");
  assert.equal(keyMessage.includes("private-value"), false);
  assert.equal(
    humanizeLocalProviderError(new TypeError("Network request failed")),
    "现在连不上模型服务，请检查网络后再试。",
  );
  assert.equal(
    humanizeLocalProviderError({ statusCode: 429, message: "rate limit" }),
    "模型服务现在请求太多，请稍等一会再试。",
  );
});

test("server connection test validates the Mailuo health response and reports latency", async () => {
  const times = [100, 137];
  const result = await testServerConnection(
    " https://mailuo.test/ ",
    async () =>
      new Response(
        JSON.stringify({ ok: true, data: { status: "ok", now: "2026-08-27T00:00:00Z" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => times.shift() ?? 137,
  );

  assert.deepEqual(result, { latencyMs: 37, serverUrl: "https://mailuo.test" });
});

test("server connection test rejects non-server addresses with a concrete message", async () => {
  await assert.rejects(
    () => testServerConnection("mailuo.test"),
    /以 http:\/\/ 或 https:\/\/ 开头/u,
  );
  await assert.rejects(
    () =>
      testServerConnection("https://mailuo.test", async () => new Response("missing", { status: 404 })),
    /服务器返回 404/u,
  );
});
