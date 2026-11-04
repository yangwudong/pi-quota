import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchLike } from "../src/http.ts";
import { fetchGlmCodingPlan, GLM_QUOTA_URL, parseGlmCodingPlan } from "../src/providers/glm-coding-plan.ts";

const KEY = "0123456789abcdef0123456789abcdef.SecretPart123456";
const FIVE_HOUR_RESET = "2026-01-01T03:00:00.000Z";
const WEEKLY_RESET = "2026-01-05T00:00:00.000Z";

function limitsReply(limits: unknown[]) {
  return { code: 200, msg: "操作成功", success: true, data: { level: "pro", limits } };
}

function credit(fields: Record<string, number>) {
  return { type: "CREDIT_LIMIT", unit: 3, ...fields };
}

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: () => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return reply();
    },
  };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

function header(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("parseGlmCodingPlan: windows", () => {
  it("reads the real bigmodel.cn reply: 5h (unit 3) and the monthly MCP allowance (TIME_LIMIT)", () => {
    // Shape captured from the live endpoint (2026-11); no weekly window on this plan.
    const reply = {
      code: 200,
      msg: "操作成功",
      data: {
        limits: [
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            usage: 1000,
            currentValue: 0,
            remaining: 1000,
            percentage: 0,
            nextResetTime: 1793769309998,
            usageDetails: [{ modelCode: "search-prime", usage: 0 }],
          },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 19, nextResetTime: 1793710229326 },
        ],
        level: "pro",
      },
      success: true,
    };
    assert.deepEqual(parseGlmCodingPlan(reply), {
      ok: true,
      plan: "pro",
      rows: [
        {
          provider: "zai-coding-cn",
          window: "five-hour",
          percentRemaining: 81,
          resetsAt: new Date(1793710229326).toISOString(),
        },
        {
          provider: "zai-coding-cn",
          window: "mcp-monthly",
          percentRemaining: 100,
          resetsAt: new Date(1793769309998).toISOString(),
          used: 0,
          limit: 1000,
        },
      ],
    });
  });

  it("splits unit 3 / unit 6 / TIME_LIMIT; a later limit of a window wins; other units are left out", () => {
    // Ported from opencode-quota tests/providers.glm-coding-plan.test.ts.
    const result = parseGlmCodingPlan(
      limitsReply([
        { type: "TOKENS_LIMIT", unit: 4, percentage: 10, nextResetTime: Date.parse(WEEKLY_RESET) },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 120 },
        { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: Date.parse(WEEKLY_RESET) },
        { type: "TIME_LIMIT", unit: 9, percentage: 10, nextResetTime: -1 },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 20, nextResetTime: Date.parse(FIVE_HOUR_RESET) + 0.4 },
      ]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.rows.map((row) => [row.window, row.percentRemaining, row.resetsAt ?? null]),
      [
        ["five-hour", 80, FIVE_HOUR_RESET],
        ["weekly", 30, WEEKLY_RESET],
        ["mcp-monthly", 90, null],
      ],
    );
  });

  it("counts CREDIT_LIMIT unit 6 as the weekly window, and TIME_LIMIT is MCP whatever its unit", () => {
    const result = parseGlmCodingPlan(
      limitsReply([
        { type: "CREDIT_LIMIT", unit: 6, percentage: 40 },
        { type: "TIME_LIMIT", unit: 3, percentage: 25 },
      ]),
    );
    assert.deepEqual(
      result.ok && result.rows.map((row) => [row.window, row.percentRemaining]),
      [
        ["weekly", 60],
        ["mcp-monthly", 75],
      ],
    );
  });

  const percents: Array<[string, Record<string, unknown>, number]> = [
    ["exact credit values", credit({ usage: 12_000, currentValue: 569, percentage: 4 }), 95],
    ["no current value", credit({ usage: 12_000, percentage: 4 }), 96],
    ["zero usage", credit({ usage: 0, currentValue: 569, percentage: 11 }), 89],
    ["credit use above the limit", credit({ usage: 100, currentValue: 150, percentage: 25 }), 0],
    ["a token limit", { ...credit({ usage: 12_000, currentValue: 569, percentage: 4 }), type: "TOKENS_LIMIT" }, 96],
  ];
  for (const [name, limit, expected] of percents) {
    it(`gives the 5h percent of ${name}`, () => {
      const result = parseGlmCodingPlan(limitsReply([limit]));
      assert.deepEqual(result.ok && result.rows.map((row) => row.percentRemaining), [expected]);
    });
  }
});

describe("parseGlmCodingPlan: failures", () => {
  it("success:false with an auth code (what a wrong key gets, with HTTP 200) is an auth error", () => {
    assert.deepEqual(parseGlmCodingPlan({ code: 1000, msg: "身份验证失败。", success: false }), {
      ok: false,
      error: { kind: "auth", status: 1000, message: "Zhipu API error 1000: 身份验证失败。" },
    });
  });

  it("success:false without a key header (code 1001) is an auth error too", () => {
    const result = parseGlmCodingPlan({ code: 1001, msg: "Header中未收到Authorization参数", success: false });
    assert.equal(!result.ok && result.error.kind, "auth");
  });

  it("success:false with another code is an API error with the message scrubbed", () => {
    const result = parseGlmCodingPlan({ code: 500, msg: "\u001b[31mcurrent user has no coding plan", success: false });
    assert.deepEqual(result, {
      ok: false,
      error: { kind: "api", status: 500, message: "Zhipu API error 500: current user has no coding plan" },
    });
  });

  it("success:false without code or message still fails", () => {
    assert.deepEqual(parseGlmCodingPlan({ success: false }), {
      ok: false,
      error: { kind: "api", message: "Zhipu API error" },
    });
  });

  it("limits that are not a list are invalid quota data", () => {
    for (const body of [limitsReply({} as unknown as unknown[]), { code: 200, success: true }, null, "text"]) {
      assert.deepEqual(parseGlmCodingPlan(body), {
        ok: false,
        error: { kind: "bad_data", message: "Invalid quota data" },
      });
    }
  });

  it("a percentage that is no finite number fails the reply, rather than showing a made-up 0% or 100% left", () => {
    const bad: Array<[string, unknown]> = [
      ["missing", undefined],
      ["null", null],
      ["a string", "50"],
      ["NaN", Number.NaN],
      ["an object", { toString: null }],
    ];
    for (const [name, percentage] of bad) {
      const limit: Record<string, unknown> = { type: "TOKENS_LIMIT", unit: 3, nextResetTime: 1793710229326 };
      if (percentage !== undefined) limit.percentage = percentage;
      assert.deepEqual(
        parseGlmCodingPlan(limitsReply([limit as never])),
        { ok: false, error: { kind: "bad_data", message: "Invalid quota data: a limit's percentage is not a number" } },
        name,
      );
    }
    // A credit limit with exact values still needs a valid percentage, as the original reads it first.
    assert.equal(parseGlmCodingPlan(limitsReply([{ ...credit({ usage: 100, currentValue: 10 }) } as never])).ok, false);
    assert.deepEqual(parseGlmCodingPlan(limitsReply([null as never])), {
      ok: false,
      error: { kind: "bad_data", message: "Invalid quota data: a limit is not an object" },
    });
  });

  it("never shows the key, even when the API echoes it", () => {
    const result = parseGlmCodingPlan({ code: 1002, msg: `invalid token ${KEY}`, success: false }, [KEY]);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(!JSON.stringify(result).includes("SecretPart"));
  });
});

describe("fetchGlmCodingPlan", () => {
  it("GETs bigmodel.cn (not open.bigmodel.cn) with a Bearer key", async () => {
    const { fetch, calls } = fakeFetch(json(limitsReply([{ type: "TOKENS_LIMIT", unit: 3, percentage: 19 }])));
    const result = await fetchGlmCodingPlan({ apiKey: KEY, fetch });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://bigmodel.cn/api/monitor/usage/quota/limit");
    assert.equal(GLM_QUOTA_URL, calls[0]?.url);
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(header(calls[0]?.init, "Authorization"), `Bearer ${KEY}`);
  });

  it("an HTTP error shows its status and the reply's first words, scrubbed", async () => {
    const { fetch } = fakeFetch(() => new Response('\u001b[31m{"msg":"down"}', { status: 500 }));
    assert.deepEqual(await fetchGlmCodingPlan({ apiKey: KEY, fetch }), {
      ok: false,
      error: { kind: "http", status: 500, message: 'Zhipu API error 500: {"msg":"down"}' },
    });
  });

  it("an HTTP 401 is an auth error and never repeats the key it echoes", async () => {
    const { fetch } = fakeFetch(() => new Response(`rejected Authorization: Bearer ${KEY}`, { status: 401 }));
    const result = await fetchGlmCodingPlan({ apiKey: KEY, fetch });
    assert.equal(!result.ok && result.error.kind, "auth");
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(JSON.stringify(result).includes("[redacted]"));
  });

  it("a reply that is not JSON is bad data", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    const result = await fetchGlmCodingPlan({ apiKey: KEY, fetch });
    assert.deepEqual(result, { ok: false, error: { kind: "bad_data", message: "Zhipu API returned malformed JSON" } });
  });

  it("gives up after 8 seconds by default, aborting the request", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    let done = false;
    const pending = fetchGlmCodingPlan({ apiKey: KEY, fetch: hanging }).then((result) => {
      done = true;
      return result;
    });
    t.mock.timers.tick(7_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(aborted, true);
    assert.deepEqual(result, { ok: false, error: { kind: "timeout", message: "Zhipu API: Request timeout after 8s" } });
  });

  it("a fetch that ignores the abort still loses to the deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const deaf: FetchLike = () => new Promise(() => {});
    const pending = fetchGlmCodingPlan({ apiKey: KEY, fetch: deaf });
    t.mock.timers.tick(8_000);
    const result = await pending;
    assert.equal(!result.ok && result.error.kind, "timeout");
  });

  it("a network failure says so, with its cause code and without the key", async () => {
    const failing: FetchLike = async () => {
      throw Object.assign(new TypeError(`fetch failed for ${KEY}`), { cause: { code: "ENOTFOUND" } });
    };
    const result = await fetchGlmCodingPlan({ apiKey: KEY, fetch: failing });
    assert.equal(!result.ok && result.error.kind, "network");
    assert.match(!result.ok ? result.error.message : "", /ENOTFOUND/);
    assert.ok(!JSON.stringify(result).includes(KEY));
  });
});
