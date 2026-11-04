import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchLike } from "../src/http.ts";
import { messages } from "../src/i18n.ts";
import {
  COPILOT_USER_URL,
  copilotResult,
  fetchCopilotQuota,
  parseCopilotInternalUser,
} from "../src/providers/copilot.ts";

const TOKEN = "ghu_TestOAuthToken0123456789abcdefABCDEF";
const RESET = "2026-02-01T00:00:00.000Z";

/** Ported from opencode-quota tests/lib.copilot.test.ts `copilotUser`. */
function copilotUser(overrides: Record<string, unknown> = {}) {
  return {
    copilot_plan: "enterprise",
    quota_reset_date_utc: RESET,
    token_based_billing: true,
    quota_snapshots: {
      premium_interactions: {
        entitlement: 1000,
        remaining: 400,
        quota_remaining: 399.5,
        percent_remaining: 40,
        unlimited: false,
      },
    },
    ...overrides,
  };
}

function snapshot(premiumInteractions: Record<string, unknown>) {
  return { quota_snapshots: { premium_interactions: premiumInteractions } };
}

const overLimit = {
  entitlement: 3000,
  remaining: -740,
  quota_remaining: -739.5,
  percent_remaining: 0,
  unlimited: false,
};

function fetchReplying(reply: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply();
  };
  return { fetch, calls };
}

describe("parseCopilotInternalUser (numbers as the original)", () => {
  it("reads the real personal reply: token-based billing is AI credits", () => {
    // Shape captured from the live endpoint (business seat, 2026-11).
    const quota = parseCopilotInternalUser({
      copilot_plan: "business",
      quota_reset_date: "2026-12-01",
      quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 25000,
          remaining: 22596,
          quota_remaining: 22596,
          percent_remaining: 90.3,
          credits_used: 2404,
          unlimited: false,
          token_based_billing: true,
        },
      },
    });
    assert.deepEqual(quota, {
      mode: "quota",
      unit: "ai_credits",
      used: 2404,
      total: 25000,
      percentRemaining: 90.3,
      authority: "locally_derived",
      plan: "business",
      resetTimeIso: "2026-12-01T00:00:00.000Z",
    });
    assert.deepEqual(copilotResult(quota), {
      ok: true,
      plan: "business",
      rows: [
        {
          provider: "github-copilot",
          window: undefined,
          percentRemaining: 90.3,
          resetsAt: "2026-12-01T00:00:00.000Z",
          label: "AI credits",
          used: 2404,
          limit: 25000,
        },
      ],
    });
  });

  it("uses quota_remaining over remaining and keeps the reported percent", () => {
    assert.deepEqual(parseCopilotInternalUser(copilotUser()), {
      mode: "quota",
      unit: "ai_credits",
      used: 600.5,
      total: 1000,
      percentRemaining: 40,
      authority: "locally_derived",
      plan: "enterprise",
      resetTimeIso: RESET,
    });
  });

  it("legacy billing (no token_based_billing) is premium requests, never AI credits", () => {
    const quota = parseCopilotInternalUser({ token_based_billing: false, ...snapshot({ entitlement: 300, remaining: 120 }) });
    assert.equal(quota.mode === "quota" && quota.unit, "premium_requests");
    const result = copilotResult(quota);
    assert.equal(result.ok && result.rows[0]?.label, "premium requests");
  });

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["derives an absent percentage", snapshot({ entitlement: 1000, remaining: 250, unlimited: false }), { percentRemaining: 25 }],
    ["keeps a reported 0 percentage", snapshot({ entitlement: 1000, remaining: 250, percent_remaining: 0 }), { percentRemaining: 0 }],
    ["drops an out-of-range reported percentage", snapshot({ entitlement: 1000, remaining: 250, percent_remaining: 140 }), { percentRemaining: undefined }],
    ["drops a non-numeric reported percentage", snapshot({ entitlement: 1000, remaining: 250, percent_remaining: "25" }), { percentRemaining: undefined }],
    ["keeps unlimited", snapshot({ unlimited: true }), { mode: "unlimited" }],
    ["does not derive a percentage from zero entitlement", snapshot({ entitlement: 0, remaining: 0 }), { mode: "plan_only" }],
    [
      "keeps token-based placeholders plan-only",
      { copilot_plan: "business", ...snapshot({ entitlement: 0, remaining: 0, percent_remaining: 0 }) },
      { mode: "plan_only", plan: "business" },
    ],
    [
      "reads token-based over-limit credits with the reported percentage",
      { copilot_plan: "business", ...snapshot({ ...overLimit, credits_used: 3739 }) },
      { mode: "quota", unit: "ai_credits", used: 3739, total: 3000, percentRemaining: 0, authority: "provider_reported" },
    ],
    [
      "keeps a negative remaining with an out-of-range percentage plan-only",
      snapshot({ ...overLimit, percent_remaining: 140 }),
      { mode: "plan_only" },
    ],
    ["keeps a negative remaining without a percentage plan-only", snapshot({ ...overLimit, percent_remaining: undefined }), { mode: "plan_only" }],
  ];
  for (const creditsUsed of [undefined, -1, "3739"]) {
    cases.push([
      `derives over-limit use when credits_used is ${String(creditsUsed)}`,
      { copilot_plan: "business", ...snapshot({ ...overLimit, credits_used: creditsUsed }) },
      { mode: "quota", used: 3739.5, total: 3000, percentRemaining: 0, authority: "locally_derived" },
    ]);
  }
  for (const [name, overrides, expected] of cases) {
    it(name, () => {
      const quota = parseCopilotInternalUser(copilotUser(overrides)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(quota[key], value, key);
    });
  }

  it("rejects a negative remaining without token billing", () => {
    assert.throws(
      () => parseCopilotInternalUser(copilotUser({ token_based_billing: false, ...snapshot(overLimit) })),
      /did not include a usable quota snapshot/,
    );
  });
});

describe("copilotResult notes", () => {
  it("unlimited, plan-only and percent-less quotas give a structured note instead of a row", () => {
    assert.deepEqual(copilotResult({ mode: "unlimited", unit: "ai_credits" }), {
      ok: true,
      rows: [],
      note: { kind: "unlimited", label: "AI credits" },
    });
    assert.deepEqual(copilotResult({ mode: "plan_only", plan: "business" }), {
      ok: true,
      rows: [],
      note: { kind: "plan_only" },
      plan: "business",
    });
    const result = copilotResult({ mode: "quota", unit: "ai_credits", used: 750, total: 1000, authority: "locally_derived" });
    assert.deepEqual(result, { ok: true, rows: [], note: { kind: "used_only", used: 750, label: "AI credits" } });
  });

  it("words the notes in the user's language", () => {
    assert.equal(messages("en").note({ kind: "unlimited", label: "AI credits" }), "AI credits: unlimited");
    assert.equal(messages("zh").note({ kind: "unlimited", label: "AI credits" }), "AI credits 不限量");
    assert.equal(messages("en").note({ kind: "plan_only" }), "plan info only, no usage data");
    assert.equal(messages("zh").note({ kind: "plan_only" }), "仅有套餐信息，无用量数据");
    assert.equal(messages("en").note({ kind: "used_only", used: 2404, label: "AI credits" }), "2,404 AI credits used (no percent left reported)");
    assert.equal(messages("zh").note({ kind: "used_only", used: 750, label: "AI credits" }), "已用 750 AI credits（无剩余百分比）");
  });
});

describe("fetchCopilotQuota", () => {
  it("sends the original's request with the OAuth token as Bearer", async () => {
    const { fetch, calls } = fetchReplying(() => new Response(JSON.stringify(copilotUser())));
    const result = await fetchCopilotQuota({ token: TOKEN, fetch });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "https://api.github.com/copilot_internal/user");
    assert.equal(COPILOT_USER_URL, calls[0]?.url);
    assert.deepEqual(calls[0]?.init.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-GitHub-Api-Version": "2025-04-01",
    });
  });

  it("a 401 (expired or revoked login) is an auth error that asks for /login, never repeating the token", async () => {
    const body = JSON.stringify({ message: `Bad credentials ${TOKEN}`, documentation_url: "https://docs.github.com/rest" });
    const { fetch } = fetchReplying(() => new Response(body, { status: 401 }));
    const result = await fetchCopilotQuota({ token: TOKEN, fetch });
    assert.equal(!result.ok && result.error.kind, "auth");
    assert.match(!result.ok ? result.error.message : "", /GitHub Copilot API error 401: Bad credentials/);
    // "Log in again" is a hint code, worded at display time.
    assert.equal(!result.ok && result.error.hint, "copilot_relogin");
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it("an exhausted rate limit is reported as such", async () => {
    const { fetch } = fetchReplying(
      () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    const result = await fetchCopilotQuota({ token: TOKEN, fetch });
    assert.equal(!result.ok && result.error.kind, "rate_limited");
  });

  it("malformed JSON and an unusable snapshot are bad data", async () => {
    const broken = await fetchCopilotQuota({ token: TOKEN, fetch: fetchReplying(() => new Response("{")).fetch });
    assert.deepEqual(broken, { ok: false, error: { kind: "bad_data", message: "GitHub Copilot API returned malformed JSON" } });
    const empty = await fetchCopilotQuota({
      token: TOKEN,
      fetch: fetchReplying(() => new Response(JSON.stringify({ copilot_plan: "pro" }))).fetch,
    });
    assert.equal(!empty.ok && empty.error.kind, "bad_data");
  });
});
