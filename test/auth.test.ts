import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AuthSources, resolveAgentDir, resolveCopilotToken, resolveZhipuKey } from "../src/auth.ts";

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

  it("without either it is not configured, and says how to configure", () => {
    for (const auth of [undefined, "{broken", {}, { "zai-coding-cn": { type: "oauth", refresh: "x" } }]) {
      const resolved = resolveZhipuKey(sources(auth));
      assert.equal(resolved.ok, false);
      if (resolved.ok) continue;
      assert.equal(resolved.error.kind, "not_configured");
      assert.match(resolved.error.message, /ZAI_CODING_CN_API_KEY/);
    }
  });

  it("does not run a !command key, and does not show it", () => {
    const resolved = resolveZhipuKey(sources({ "zai-coding-cn": { type: "api_key", key: "!security find-generic-password -w zai" } }));
    assert.equal(resolved.ok, false);
    // Configured but unusable: an auth problem, not "not in use".
    assert.equal(!resolved.ok && resolved.error.kind, "auth");
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
    assert.equal(!apiKey.ok && apiKey.error.kind, "auth");
    assert.match(!apiKey.ok ? apiKey.error.message : "", /不接受 API key/);
    const nothing = resolveCopilotToken(sources({}, { COPILOT_GITHUB_TOKEN: OAUTH }));
    assert.match(!nothing.ok ? nothing.error.message : "", /\/login github-copilot/);
  });

  it("refuses a GitHub Enterprise login and a login without its OAuth token", () => {
    const enterprise = resolveCopilotToken(
      sources({ "github-copilot": { type: "oauth", refresh: OAUTH, enterpriseUrl: "acme.ghe.com" } }),
    );
    assert.match(!enterprise.ok ? enterprise.error.message : "", /Enterprise/);
    const github = resolveCopilotToken(
      sources({ "github-copilot": { type: "oauth", refresh: OAUTH, enterpriseUrl: "https://github.com" } }),
    );
    assert.equal(github.ok, true);
    const missing = resolveCopilotToken(sources({ "github-copilot": { type: "oauth", access: INFERENCE } }));
    assert.equal(!missing.ok && missing.error.kind, "auth");
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
