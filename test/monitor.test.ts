import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProviderFetcher, quotaPaths } from "../src/core/store.ts";
import type { ProviderId, ProviderResult } from "../src/core/types.ts";
import {
  COMMAND_USAGE,
  completeArguments,
  createMonitor,
  defaultFetchers,
  type MonitorUi,
  REFRESH_INTERVAL_MS,
  type SetTimer,
  WIDGET_KEY,
} from "../src/monitor.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

function fakeUi() {
  const notes: Array<{ level: string; message: string }> = [];
  const widgets: Array<string[] | undefined> = [];
  const ui: MonitorUi = {
    notify: (message, level) => notes.push({ level, message }),
    setWidget: (key, lines) => {
      assert.equal(key, WIDGET_KEY);
      widgets.push(lines);
    },
  };
  return { ui, notes, widgets, widget: () => widgets.at(-1), warnings: () => notes.filter((n) => n.level === "warning") };
}

function fakeTimers() {
  const armed: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const setTimer: SetTimer = (run, ms) => {
    const timer = { run, ms, cancelled: false };
    armed.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { setTimer, live: () => armed.filter((timer) => !timer.cancelled) };
}

/** Fetchers whose answers the test sets; each counts its calls. */
function fakeProviders() {
  const answers: Record<ProviderId, ProviderResult> = {
    "zai-coding-cn": { ok: true, rows: [{ provider: "zai-coding-cn", window: "five-hour", percentRemaining: 81, resetsAt: at(150) }] },
    "github-copilot": { ok: true, rows: [{ provider: "github-copilot", window: undefined, percentRemaining: 90, resetsAt: at(40_000) }] },
  };
  const calls: Record<ProviderId, number> = { "zai-coding-cn": 0, "github-copilot": 0 };
  const fetcher =
    (id: ProviderId): ProviderFetcher =>
    async () => {
      calls[id] += 1;
      return answers[id];
    };
  const fetchers: Array<[ProviderId, ProviderFetcher]> = [
    ["zai-coding-cn", fetcher("zai-coding-cn")],
    ["github-copilot", fetcher("github-copilot")],
  ];
  const fiveHour = (percentRemaining: number, resetsAt = at(150)) => {
    answers["zai-coding-cn"] = { ok: true, rows: [{ provider: "zai-coding-cn", window: "five-hour", percentRemaining, resetsAt }] };
  };
  return { answers, calls, fetchers, fiveHour };
}

function setup(options: { automatic?: boolean; agentDir?: string } = {}) {
  const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-quota-monitor-"));
  const paths = quotaPaths(agentDir);
  const providers = fakeProviders();
  const timers = fakeTimers();
  const clock = { now: NOW };
  const make = () =>
    createMonitor({
      fetchers: providers.fetchers,
      paths,
      now: () => clock.now,
      setTimer: timers.setTimer,
      ...(options.automatic === undefined ? {} : { automatic: options.automatic }),
    });
  return { agentDir, paths, providers, timers, clock, make, monitor: make() };
}

describe("monitor: widget and refresh", () => {
  it("draws a pending widget at once, then the windows; re-arms the 60 s timer", async () => {
    const { monitor, timers } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    assert.deepEqual(view.widgets[0], ["Zhipu   … 查询中", "Copilot … 查询中"]);
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Zhipu   5h  ▰▰▰▰▰▰▰▰▱▱  81%  ↻2h30m", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻27d"]);
    assert.deepEqual(timers.live().map((timer) => timer.ms), [REFRESH_INTERVAL_MS]);
    assert.deepEqual(view.notes, []);
  });

  it("turn ends reuse the 60 s cache; the timer refreshes once it expired", async () => {
    const { monitor, providers, timers, clock } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    for (let turn = 0; turn < 5; turn += 1) {
      clock.now += 5_000;
      monitor.onTurnEnd(view.ui);
      await monitor.idle();
    }
    assert.equal(providers.calls["zai-coding-cn"], 1);
    clock.now = NOW + 61_000;
    const timer = timers.live()[0];
    timer?.run();
    await monitor.idle();
    assert.equal(providers.calls["zai-coding-cn"], 2);
    assert.equal(timers.live().length, 1);
  });

  it("an error shows as the provider's line and nothing breaks", async () => {
    const { monitor, providers } = setup();
    providers.answers["zai-coding-cn"] = { ok: false, error: { kind: "auth", message: "未找到智谱 API key" } };
    providers.answers["github-copilot"] = { ok: false, error: { kind: "timeout", message: "Request timeout after 8s" } };
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Zhipu   ✗ auth", "Copilot ✗ timeout"]);
  });

  it("a slow provider holds back no other: each is drawn as it answers", async () => {
    const { paths } = setup();
    let release: (result: ProviderResult) => void = () => {};
    const slow = new Promise<ProviderResult>((resolve) => (release = resolve));
    const monitor = createMonitor({
      fetchers: [
        ["zai-coding-cn", () => slow],
        ["github-copilot", async () => ({ ok: true, rows: [{ provider: "github-copilot", window: undefined, percentRemaining: 90, resetsAt: at(40_000) }] })],
      ],
      paths,
      now: () => NOW,
      setTimer: fakeTimers().setTimer,
    });
    const view = fakeUi();
    monitor.start(view.ui);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(view.widget(), ["Zhipu   … 查询中", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻27d"]);
    release({ ok: false, error: { kind: "timeout", message: "Zhipu API: Request timeout after 8s" } });
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Zhipu   ✗ timeout", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻27d"]);
  });

  it("a provider without any credential stays out of sight; with none there is no widget", async () => {
    const { monitor, providers } = setup();
    providers.answers["zai-coding-cn"] = { ok: false, error: { kind: "not_configured", message: "未配置智谱 API key" } };
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻27d"]);

    providers.answers["github-copilot"] = { ok: false, error: { kind: "not_configured", message: "未登录 GitHub Copilot" } };
    await monitor.command("refresh", view.ui);
    assert.equal(view.widget(), undefined);
    await monitor.command("", view.ui);
    assert.match(view.notes.at(-1)?.message ?? "", /Zhipu GLM Coding Plan · 未配置\n  未配置智谱 API key/);
  });

  it("stop() cancels the timer, and a check still in flight tells nobody", async () => {
    const { monitor, timers, providers } = setup();
    providers.fiveHour(10);
    const view = fakeUi();
    monitor.start(view.ui);
    monitor.stop();
    await monitor.idle();
    assert.equal(timers.live().length, 0);
    assert.deepEqual(view.notes, []);
  });

  it("offline (--offline) checks nothing by itself, only on /quota", async () => {
    const { monitor, providers, timers } = setup({ automatic: false });
    const view = fakeUi();
    monitor.start(view.ui);
    monitor.onTurnEnd(view.ui);
    await monitor.idle();
    assert.equal(providers.calls["zai-coding-cn"], 0);
    assert.equal(view.widget(), undefined);
    await monitor.command("status", view.ui);
    assert.equal(providers.calls["zai-coding-cn"], 1);
    assert.equal(timers.live().length, 0);
  });
});

describe("monitor: alerts", () => {
  it("warns once per window across turns and across sessions (state is saved)", async () => {
    const setupResult = setup();
    const { providers, make } = setupResult;
    providers.fiveHour(15);
    const view = fakeUi();
    const first = setupResult.monitor;
    first.start(view.ui);
    await first.idle();
    for (let turn = 0; turn < 3; turn += 1) {
      first.onTurnEnd(view.ui);
      await first.idle();
    }
    assert.equal(view.warnings().length, 1);
    assert.match(view.warnings()[0]?.message ?? "", /^pi-quota · Zhipu 5h 窗口配额仅剩 15%/);
    first.stop();

    const second = make();
    const view2 = fakeUi();
    second.start(view2.ui);
    await second.idle();
    assert.equal(view2.warnings().length, 0);
  });

  it("after /quota mute five-hour no warning comes; the choice is saved", async () => {
    const { monitor, providers, paths, clock } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("mute five-hour", view.ui);
    assert.match(view.notes.at(-1)?.message ?? "", /已静音 five-hour/);
    assert.deepEqual(JSON.parse(readFileSync(paths.config, "utf8")).muted, ["five-hour"]);
    providers.fiveHour(5);
    clock.now += 61_000;
    monitor.onTurnEnd(view.ui);
    await monitor.idle();
    assert.equal(view.warnings().length, 0);

    await monitor.command("unmute 5h", view.ui);
    clock.now += 61_000;
    monitor.onTurnEnd(view.ui);
    await monitor.idle();
    assert.equal(view.warnings().length, 1);
  });

  it("says Quota available when a low window is back, while idle (timer)", async () => {
    const { monitor, providers, timers, clock } = setup();
    providers.fiveHour(12);
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    providers.fiveHour(100, at(450));
    clock.now = NOW + 151 * MINUTE;
    timers.live()[0]?.run();
    await monitor.idle();
    assert.deepEqual(view.notes.at(-1), { level: "info", message: "✅ Quota available · Zhipu 5h 窗口已恢复至 100%" });
  });

  it("a command's output carries a Quota available found by its own check (info lines replace each other in pi)", async () => {
    const { monitor, providers, clock } = setup();
    providers.fiveHour(12);
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    providers.fiveHour(100, at(450));
    clock.now = NOW + 151 * MINUTE;
    await monitor.command("status", view.ui);
    const last = view.notes.at(-1);
    assert.equal(last?.level, "info");
    const [first, second] = last?.message.split("\n") ?? [];
    assert.equal(first, "✅ Quota available · Zhipu 5h 窗口已恢复至 100%");
    assert.match(second ?? "", /^配额：Copilot 90% ↻/);
  });

  it("with the threshold at 99 in config.json, 81% warns once (the acceptance simulation)", async () => {
    const { monitor, paths } = setup();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ warnBelow: 99 }));
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("refresh", view.ui);
    assert.equal(view.warnings().length, 1);
    assert.match(view.warnings()[0]?.message ?? "", /配额仅剩 81%/);
  });
});

describe("monitor: commands", () => {
  it("completes /quota arguments, and offers nothing once an argument is complete", () => {
    assert.deepEqual(completeArguments("")?.length, 8);
    assert.deepEqual(completeArguments("mu"), ["mute five-hour", "mute weekly"]);
    assert.deepEqual(completeArguments("st"), ["status"]);
    assert.equal(completeArguments("status"), null);
    assert.equal(completeArguments("mute weekly"), null);
    assert.equal(completeArguments("nope"), null);
  });
  it("/quota shows the full report through notify", async () => {
    const { monitor } = setup();
    const view = fakeUi();
    await monitor.command("", view.ui);
    const report = view.notes.at(-1);
    assert.equal(report?.level, "info");
    assert.match(report?.message ?? "", /^pi-quota 配额报告/);
    assert.match(report?.message ?? "", /节奏：/);
    assert.match(report?.message ?? "", /Zhipu GLM Coding Plan/);
  });

  it("/quota refresh asks the providers again at once", async () => {
    const { monitor, providers } = setup();
    const view = fakeUi();
    await monitor.command("status", view.ui);
    await monitor.command("refresh", view.ui);
    assert.equal(providers.calls["github-copilot"], 2);
    assert.match(view.notes.at(-1)?.message ?? "", /^已刷新 · 配额：/);
  });

  it("/quota hide and show toggle the widget and are saved", async () => {
    const setupResult = setup();
    const { monitor, paths, make } = setupResult;
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("hide", view.ui);
    assert.equal(view.widget(), undefined);
    assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).hidden, true);

    const next = make();
    const view2 = fakeUi();
    next.start(view2.ui);
    await next.idle();
    assert.equal(view2.widget(), undefined);
    await next.command("show", view2.ui);
    assert.equal(view2.widget()?.length, 2);
  });

  it("an unknown or incomplete command shows the usage", async () => {
    const { monitor } = setup();
    const view = fakeUi();
    await monitor.command("bogus", view.ui);
    await monitor.command("mute mcp-monthly", view.ui);
    assert.deepEqual(view.notes, [
      { level: "warning", message: COMMAND_USAGE },
      { level: "warning", message: COMMAND_USAGE },
    ]);
  });
});

describe("monitor with the real providers", () => {
  it("never lets a key or token reach the UI, even when the APIs echo them", async (t) => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-e2e-"));
    const key = "0123456789abcdef0123456789abcdef.SecretPart123456";
    const token = "ghu_TestOAuthToken0123456789abcdefABCDEF";
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "zai-coding-cn": { type: "api_key", key },
        "github-copilot": { type: "oauth", refresh: token, access: "tid=inference;exp=1", expires: 1 },
      }),
    );
    const seen: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string>).Authorization ?? "";
      seen.push(`${url} ${authorization === `Bearer ${key}` || authorization === `Bearer ${token}`}`);
      return new Response(JSON.stringify({ message: `bad ${authorization} ${key} ${token}` }), { status: 401 });
    });
    const monitor = createMonitor({
      fetchers: defaultFetchers(() => ({ env: {}, agentDir })),
      paths: quotaPaths(agentDir),
      setTimer: fakeTimers().setTimer,
    });
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("", view.ui);
    await monitor.command("status", view.ui);
    monitor.stop();

    assert.deepEqual(view.widget(), ["Zhipu   ✗ auth", "Copilot ✗ auth"]);
    assert.ok(seen.every((line) => line.endsWith(" true")), "each request carries its own credential");
    const everything = JSON.stringify([view.notes, view.widgets]);
    for (const secret of [key, "SecretPart", token, "TestOAuthToken", "tid=inference"]) {
      assert.ok(!everything.includes(secret), `UI output contains ${secret}`);
    }
    for (const file of ["config.json", "state.json"]) {
      try {
        const text = readFileSync(join(agentDir, "pi-quota", file), "utf8");
        assert.ok(!text.includes(key) && !text.includes(token));
      } catch {
        // Not written: nothing to leak.
      }
    }
  });
});
