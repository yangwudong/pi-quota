import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AuthSources, resolveAgentDir, resolveCopilotToken, resolveZhipuKey } from "../src/auth.ts";
import { messages } from "../src/i18n.ts";

const KEY = "0123456789abcdef0123456789abcdef.SecretPart123456";
const OAUTH = "ghu_TestOAuthToken0123456789abcdefABCDEF";
const INFERENCE = "tid=abc123;exp=1793000000;sku=copilot_for_business_seat_quota:secret";

/** Sources with an in-memory auth.json (an object, raw text, or no file). */
function sources(auth: Record<string, unknown> | string | undefined, env: Record<string, string> = {}): AuthSources {
  return {
    env,
    agentDir: "/agent",
    readFile: (path) => {
      assert.equal(path, "/agent/auth.json");
      if (auth === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return typeof auth === "string" ? auth : JSON.stringify(auth);
    },
  };
}

describe("resolveAgentDir", () => {
  it("is PI_CODING_AGENT_DIR when set, else ~/.pi/agent", () => {
    assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
    assert.match(resolveAgentDir({}), /\.pi\/agent$/);
  });
});

describe("Zhipu key", () => {
  it("takes ZAI_CODING_CN_API_KEY first", () => {
    const resolved = resolveZhipuKey(
      sources({ "zai-coding-cn": { type: "api_key", key: "from-auth-json" } }, { ZAI_CODING_CN_API_KEY: ` ${KEY} ` }),
    );
    assert.deepEqual(resolved, { ok: true, secret: KEY, source: "env" });
  });

  it("then pi's auth.json entry zai-coding-cn (BOM tolerated)", () => {
    const text = `\uFEFF${JSON.stringify({ "zai-coding-cn": { type: "api_key", key: KEY } })}`;
    assert.deepEqual(resolveZhipuKey(sources(text, { ZAI_CODING_CN_API_KEY: "  " })), {
      ok: true,
      secret: KEY,
      source: "auth.json",
    });
  });

  it("without either it is not configured, with the setup hint", () => {
    for (const auth of [undefined, "{broken", {}, { "zai-coding-cn": { type: "oauth", refresh: "x" } }]) {
      const resolved = resolveZhipuKey(sources(auth));
      assert.deepEqual(resolved, { ok: false, error: { kind: "not_configured", message: "", hint: "zhipu_setup" } });
    }
    // The hint is worded at display time, in the user's language.
    assert.match(messages("en").hints.zhipu_setup, /ZAI_CODING_CN_API_KEY/);
    assert.match(messages("zh").hints.zhipu_setup, /未配置智谱 API key/);
  });

  it("does not run a !command key, and does not show it", () => {
    const resolved = resolveZhipuKey(sources({ "zai-coding-cn": { type: "api_key", key: "!security find-generic-password -w zai" } }));
    // Configured but unusable: an auth problem, not "not in use".
    assert.deepEqual(resolved, { ok: false, error: { kind: "auth", message: "", hint: "zhipu_command_key" } });
    assert.ok(!JSON.stringify(resolved).includes("security find-generic-password"));
  });
});

describe("Copilot token", () => {
  it("uses the GitHub OAuth token (refresh), never the Copilot inference token (access)", () => {
    const resolved = resolveCopilotToken(
      sources({ "github-copilot": { type: "oauth", refresh: OAUTH, access: INFERENCE, expires: 1793000000000 } }),
    );
    assert.deepEqual(resolved, { ok: true, secret: OAUTH, source: "auth.json" });
  });

  it("takes no API key or env substitute", () => {
    const apiKey = resolveCopilotToken(
      sources({ "github-copilot": { type: "api_key", key: "ghp_Classic0123456789" } }, { COPILOT_GITHUB_TOKEN: OAUTH }),
    );
    assert.deepEqual(apiKey, { ok: false, error: { kind: "auth", message: "", hint: "copilot_not_oauth" } });
    assert.match(messages("en").hints.copilot_not_oauth, /API keys are not accepted/);
    const nothing = resolveCopilotToken(sources({}, { COPILOT_GITHUB_TOKEN: OAUTH }));
    assert.deepEqual(nothing, { ok: false, error: { kind: "not_configured", message: "", hint: "copilot_login" } });
    assert.match(messages("en").hints.copilot_login, /\/login github-copilot/);
  });

  it("refuses a GitHub Enterprise login and a login without its OAuth token", () => {
    const enterprise = resolveCopilotToken(
      sources({ "github-copilot": { type: "oauth", refresh: OAUTH, enterpriseUrl: "acme.ghe.com" } }),
    );
    assert.equal(!enterprise.ok && enterprise.error.hint, "copilot_enterprise");
    assert.match(messages("en").hints.copilot_enterprise, /Enterprise/);
    const github = resolveCopilotToken(
      sources({ "github-copilot": { type: "oauth", refresh: OAUTH, enterpriseUrl: "https://github.com" } }),
    );
    assert.equal(github.ok, true);
    const missing = resolveCopilotToken(sources({ "github-copilot": { type: "oauth", access: INFERENCE } }));
    assert.deepEqual(missing, { ok: false, error: { kind: "auth", message: "", hint: "copilot_no_token" } });
  });

  it("never puts a token in an error", () => {
    const results = [
      resolveCopilotToken(sources({ "github-copilot": { type: "api_key", key: OAUTH } })),
      resolveCopilotToken(sources({ "github-copilot": { type: "oauth", refresh: OAUTH, enterpriseUrl: "x.ghe.com" } })),
      resolveCopilotToken(sources({ "github-copilot": { type: "oauth", access: INFERENCE } })),
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(OAUTH));
      assert.ok(!JSON.stringify(result).includes("tid="));
    }
  });
});
