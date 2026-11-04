import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CACHE_TTL_MS,
  DEFAULT_CONFIG,
  loadAlertState,
  loadConfig,
  parseConfig,
  QuotaCache,
  quotaPaths,
  writeJsonAtomic,
} from "../src/core/store.ts";
import type { ProviderResult } from "../src/core/types.ts";

const OK: ProviderResult = {
  ok: true,
  rows: [{ provider: "zai-coding-cn", window: "five-hour", percentRemaining: 81 }],
};
const FAIL: ProviderResult = { ok: false, error: { kind: "network", message: "down" } };

/** A fetcher that counts its calls and answers what `answer` says. */
function counting(answer: () => ProviderResult | Promise<ProviderResult>) {
  const counter = { calls: 0 };
  const fetcher = async () => {
    counter.calls += 1;
    return answer();
  };
  return { counter, fetcher };
}

describe("QuotaCache", () => {
  it("keeps a successful answer for 60 s, then asks again", async () => {
    let clock = 1_000_000;
    const { counter, fetcher } = counting(() => OK);
    const cache = new QuotaCache([["zai-coding-cn", fetcher]], { now: () => clock });
    assert.equal(CACHE_TTL_MS, 60_000);

    await cache.get("zai-coding-cn");
    clock += 59_999;
    const cached = await cache.get("zai-coding-cn");
    assert.equal(counter.calls, 1);
    assert.equal(cached.checkedAtMs, 1_000_000);

    clock += 1;
    await cache.get("zai-coding-cn");
    assert.equal(counter.calls, 2);
  });

  it("does not keep a failure: the next check asks again", async () => {
    const { counter, fetcher } = counting(() => FAIL);
    const cache = new QuotaCache([["zai-coding-cn", fetcher]], { now: () => 0 });
    await cache.get("zai-coding-cn");
    await cache.get("zai-coding-cn");
    assert.equal(counter.calls, 2);
  });

  it("a failure after a success drops the stale answer", async () => {
    let clock = 0;
    let answer: ProviderResult = OK;
    const { counter, fetcher } = counting(() => answer);
    const cache = new QuotaCache([["zai-coding-cn", fetcher]], { now: () => clock });
    await cache.get("zai-coding-cn");
    clock += CACHE_TTL_MS;
    answer = FAIL;
    assert.equal((await cache.get("zai-coding-cn")).ok, false);
    answer = OK;
    await cache.get("zai-coding-cn");
    assert.equal(counter.calls, 3);
  });

  it("force and clear() ask again at once", async () => {
    const { counter, fetcher } = counting(() => OK);
    const cache = new QuotaCache([["zai-coding-cn", fetcher]], { now: () => 0 });
    await cache.get("zai-coding-cn");
    await cache.get("zai-coding-cn", { force: true });
    cache.clear();
    await cache.get("zai-coding-cn");
    assert.equal(counter.calls, 3);
  });

  it("is single-flight: callers during a request share it", async () => {
    let release: (value: ProviderResult) => void = () => {};
    const { counter, fetcher } = counting(() => new Promise<ProviderResult>((resolve) => (release = resolve)));
    const cache = new QuotaCache([["zai-coding-cn", fetcher]], { now: () => 0 });
    const first = cache.get("zai-coding-cn");
    const second = cache.get("zai-coding-cn");
    release(OK);
    assert.deepEqual(await first, await second);
    assert.equal(counter.calls, 1);
  });

  it("asks providers in parallel; one failing or throwing never hides the other", async () => {
    const cache = new QuotaCache(
      [
        ["zai-coding-cn", async () => OK],
        [
          "github-copilot",
          async () => {
            throw new Error("boom ghu_SecretToken0123456789abcdef");
          },
        ],
      ],
      { now: () => 7 },
    );
    const [zhipu, copilot] = await cache.getAll();
    assert.equal(zhipu?.ok, true);
    assert.deepEqual(copilot, {
      ok: false,
      error: { kind: "internal", message: "boom [redacted]" },
      provider: "github-copilot",
      checkedAtMs: 7,
    });
  });
});

describe("settings and alert state files", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "pi-quota-test-"));

  it("live under <agent-dir>/pi-quota/", () => {
    assert.deepEqual(quotaPaths("/x/agent"), {
      dir: "/x/agent/pi-quota",
      config: "/x/agent/pi-quota/config.json",
      state: "/x/agent/pi-quota/state.json",
    });
  });

  it("a missing or broken file gives the defaults", () => {
    const paths = quotaPaths(dir());
    assert.deepEqual(loadConfig(paths.config), DEFAULT_CONFIG);
    assert.deepEqual(loadAlertState(paths.state), {});
    writeJsonAtomic(paths.config, DEFAULT_CONFIG);
    writeFileSync(paths.config, "{not json");
    assert.deepEqual(loadConfig(paths.config), DEFAULT_CONFIG);
  });

  it("bad fields take their defaults; muted keeps only alert windows; English, top right, percent left unless told", () => {
    assert.deepEqual(
      parseConfig({ language: "fr", hidden: "yes", placement: "left", percent: "half", muted: ["weekly", "mcp-monthly", "weekly", 3], warnBelow: 0, recoverAt: 101 }),
      { language: "en", hidden: false, placement: "top-right", percent: "remaining", muted: ["weekly"], warnBelow: 20, recoverAt: 50 },
    );
    assert.deepEqual(
      parseConfig({ language: "zh", hidden: true, placement: "bottom-right", percent: "used", muted: ["five-hour"], warnBelow: 99, recoverAt: 60 }),
      {
        language: "zh",
        hidden: true,
        placement: "bottom-right",
        percent: "used",
        muted: ["five-hour"],
        warnBelow: 99,
        recoverAt: 60,
      },
    );
    // A config.json from 0.1.x (no language, no placement) reads as English, top right, percent left.
    const old = parseConfig({ hidden: false, muted: [], warnBelow: 20, recoverAt: 50 });
    assert.equal(old.language, "en");
    assert.equal(old.placement, "top-right");
    assert.equal(old.percent, "remaining");
    // 0.3.x saved "float" (0.3.0 drew it at the top right, 0.3.1 at the bottom right): the default.
    assert.equal(parseConfig({ placement: "float" }).placement, "top-right");
  });

  it("round-trips settings and alert state, writing whole files", () => {
    const paths = quotaPaths(dir());
    const config = {
      language: "zh" as const,
      hidden: true,
      placement: "inline" as const,
      percent: "used" as const,
      muted: ["five-hour" as const],
      warnBelow: 20,
      recoverAt: 50,
    };
    assert.equal(writeJsonAtomic(paths.config, config), true);
    assert.deepEqual(loadConfig(paths.config), config);
    const state = { "zai-coding-cn:five-hour": { low: true, warnedReset: "2026-11-03T14:30:00.000Z" } };
    writeJsonAtomic(paths.state, state);
    assert.deepEqual(loadAlertState(paths.state), state);
    assert.ok(readFileSync(paths.state, "utf8").endsWith("}\n"));
  });
});
