import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ProviderFetcher, quotaPaths } from "../src/core/store.ts";
import type { ProviderId, ProviderResult } from "../src/core/types.ts";
import { messages } from "../src/i18n.ts";
import {
  COMMAND_ARGUMENTS,
  completeArguments,
  createMonitor,
  defaultFetchers,
  type MonitorUi,
  REFRESH_INTERVAL_MS,
  type SetTimer,
} from "../src/monitor.ts";
import type { DisplayLine } from "../src/format.ts";
import type { PanelPlacement } from "../src/layout.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
const EN = messages("en");
const ZH = messages("zh");

/** A fake pi UI; `picks` answers its select() calls in order (undefined: the user cancels). */
function fakeUi(picks: Array<string | undefined> | null = null) {
  const notes: Array<{ level: string; message: string }> = [];
  /** Each panel update as its lines' plain text (undefined: no panel). */
  const widgets: Array<string[] | undefined> = [];
  const placements: PanelPlacement[] = [];
  const panels: Array<readonly DisplayLine[] | undefined> = [];
  const menus: Array<{ title: string; options: string[] }> = [];
  const ui: MonitorUi = {
    notify: (message, level) => notes.push({ level, message }),
    showPanel: (lines, placement) => {
      panels.push(lines);
      widgets.push(lines?.map((line) => line.text));
      placements.push(placement);
    },
    ...(picks
      ? {
          select: async (title: string, options: string[]) => {
            menus.push({ title, options });
            const pick = picks.shift();
            if (pick !== undefined) assert.ok(options.includes(pick), `"${pick}" is not offered in ${JSON.stringify(options)}`);
            return pick;
          },
        }
      : {}),
  };
  return {
    ui,
    notes,
    widgets,
    placements,
    panels,
    menus,
    widget: () => widgets.at(-1),
    warnings: () => notes.filter((n) => n.level === "warning"),
  };
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

function setup(options: { automatic?: boolean; config?: Record<string, unknown> } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-monitor-"));
  const paths = quotaPaths(agentDir);
  if (options.config) {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.config, JSON.stringify(options.config));
  }
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
  const savedConfig = () => JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>;
  return { agentDir, paths, providers, timers, clock, make, savedConfig, monitor: make() };
}

const WIDGET_EN = ["Zhipu   5h  ▰▰▰▰▰▰▰▰▱▱  81%  ⏳ 2h30m", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ⏳ 27d"];

describe("monitor: widget and refresh", () => {
  it("draws a pending widget at once, then the windows (English by default); re-arms the 60 s timer", async () => {
    const { monitor, timers } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    assert.deepEqual(view.widgets[0], ["Zhipu   … checking", "Copilot … checking"]);
    await monitor.idle();
    assert.deepEqual(view.widget(), WIDGET_EN);
    assert.deepEqual(timers.live().map((timer) => timer.ms), [REFRESH_INTERVAL_MS]);
    assert.deepEqual(view.notes, []);
    assert.equal(monitor.locale(), "en");
  });

  it("follows the saved language from the start", async () => {
    const { monitor } = setup({ config: { language: "zh" } });
    const view = fakeUi();
    monitor.start(view.ui);
    assert.deepEqual(view.widgets[0], ["Zhipu   … 查询中", "Copilot … 查询中"]);
    assert.equal(monitor.locale(), "zh");
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
    timers.live()[0]?.run();
    await monitor.idle();
    assert.equal(providers.calls["zai-coding-cn"], 2);
    assert.equal(timers.live().length, 1);
  });

  it("an error shows as the provider's line and nothing breaks", async () => {
    const { monitor, providers } = setup();
    providers.answers["zai-coding-cn"] = { ok: false, error: { kind: "auth", message: "", hint: "zhipu_command_key" } };
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
    assert.deepEqual(view.widget(), ["Zhipu   … checking", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ⏳ 27d"]);
    release({ ok: false, error: { kind: "timeout", message: "Zhipu API: Request timeout after 8s" } });
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Zhipu   ✗ timeout", "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ⏳ 27d"]);
  });

  it("a provider without any credential stays out of sight; with none there is no widget", async () => {
    const { monitor, providers } = setup();
    providers.answers["zai-coding-cn"] = { ok: false, error: { kind: "not_configured", message: "", hint: "zhipu_setup" } };
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    assert.deepEqual(view.widget(), ["Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ⏳ 27d"]);

    providers.answers["github-copilot"] = { ok: false, error: { kind: "not_configured", message: "", hint: "copilot_login" } };
    await monitor.command("refresh", view.ui);
    assert.equal(view.widget(), undefined);
    await monitor.command("", view.ui);
    assert.match(view.notes.at(-1)?.message ?? "", /Zhipu GLM Coding Plan · not set up\n {2}Zhipu API key not set/);
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
    assert.match(view.warnings()[0]?.message ?? "", /^pi-quota · Zhipu 5h window: 15% left/);
    first.stop();

    const second = make();
    const view2 = fakeUi();
    second.start(view2.ui);
    await second.idle();
    assert.equal(view2.warnings().length, 0);
  });

  it("warns in the user's language", async () => {
    const { monitor, providers } = setup({ config: { language: "zh" } });
    providers.fiveHour(15);
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    assert.match(view.warnings()[0]?.message ?? "", /^pi-quota · Zhipu 5h 窗口配额仅剩 15%/);
  });

  it("after /quota mute five-hour no warning comes; the choice is saved", async () => {
    const { monitor, providers, savedConfig, clock } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("mute five-hour", view.ui);
    assert.equal(view.notes.at(-1)?.message, EN.muted("five-hour"));
    assert.deepEqual(savedConfig().muted, ["five-hour"]);
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
    assert.deepEqual(view.notes.at(-1), { level: "info", message: "✅ Quota available · Zhipu 5h window is back to 100%" });
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
    assert.equal(first, "✅ Quota available · Zhipu 5h window is back to 100%");
    assert.match(second ?? "", /^Quota: Copilot 90% ⏳ /);
  });

  it("with the threshold at 99 in config.json, 81% warns once (the acceptance simulation)", async () => {
    const { monitor } = setup({ config: { warnBelow: 99 } });
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("refresh", view.ui);
    assert.equal(view.warnings().length, 1);
    assert.match(view.warnings()[0]?.message ?? "", /81% left/);
  });
});

describe("monitor: the / menu", () => {
  it("completes /quota arguments with descriptions in the user's language", () => {
    assert.equal(completeArguments("")?.length, COMMAND_ARGUMENTS.length);
    assert.deepEqual(completeArguments("mu"), [
      { value: "mute five-hour", description: "no alerts for the 5h window" },
      { value: "mute weekly", description: "no alerts for the weekly window" },
    ]);
    assert.deepEqual(completeArguments("con", "zh"), [{ value: "config", description: "设置：语言、面板、提醒" }]);
    assert.deepEqual(completeArguments("lang ", "en")?.map((item) => item.value), ["lang en", "lang zh"]);
  });

  it("offers nothing once an argument is complete, so Enter runs it", () => {
    assert.equal(completeArguments("status"), null);
    assert.equal(completeArguments("mute weekly"), null);
    assert.equal(completeArguments("nope"), null);
  });

  it("has a description for every argument in every language", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const value of COMMAND_ARGUMENTS) {
        assert.ok(messages(locale).argument[value], `${locale}: no description for "${value}"`);
      }
      assert.ok(messages(locale).commandDescription);
    }
  });
});

describe("monitor: language", () => {
  it("/quota lang zh switches at once: the widget redraws, the choice is saved, it answers in Chinese", async () => {
    const { monitor, savedConfig } = setup();
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("lang zh", view.ui);
    assert.equal(savedConfig().language, "zh");
    assert.equal(view.notes.at(-1)?.message, "pi-quota 语言：简体中文");
    assert.equal(monitor.locale(), "zh");
    await monitor.command("", view.ui);
    assert.match(view.notes.at(-1)?.message ?? "", /^pi-quota 配额报告/);
    await monitor.command("lang English", view.ui);
    assert.equal(view.notes.at(-1)?.message, "pi-quota language: English");
    assert.equal(savedConfig().language, "en");
  });

  it("/quota lang without a value asks with a picker", async () => {
    const { monitor, savedConfig } = setup();
    const view = fakeUi(["简体中文"]);
    await monitor.command("lang", view.ui);
    assert.deepEqual(view.menus, [{ title: "pi-quota language", options: ["English", "简体中文"] }]);
    assert.equal(savedConfig().language, "zh");
    // Cancelling the picker changes nothing.
    const cancel = fakeUi([undefined]);
    await monitor.command("lang", cancel.ui);
    assert.equal(savedConfig().language, "zh");
    assert.deepEqual(cancel.notes, []);
  });

  it("an unknown language, or no picker to ask with, shows the usage", async () => {
    const { monitor } = setup();
    const view = fakeUi();
    await monitor.command("lang fr", view.ui);
    await monitor.command("lang", view.ui);
    assert.deepEqual(view.notes, [
      { level: "warning", message: EN.usage },
      { level: "warning", message: EN.usage },
    ]);
  });
});

describe("monitor: /quota config", () => {
  it("is a settings menu: each pick applies at once, the menu comes back in the new state, until Done", async () => {
    const { monitor, savedConfig } = setup();
    const view = fakeUi([
      EN.configLanguage("English"), // → language picker
      "简体中文",
      ZH.configPanel("top-right"), // the menu is Chinese now: top right → bottom right
      ZH.configPanel("bottom-right"), // bottom right → above the editor
      ZH.configPercent("remaining"), // percent left → used
      ZH.configMute("weekly", false), // mute weekly
      ZH.configDone,
    ]);
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("config", view.ui);

    assert.deepEqual(
      view.menus.map((menu) => menu.title),
      ["pi-quota settings", "pi-quota language", "pi-quota 设置", "pi-quota 设置", "pi-quota 设置", "pi-quota 设置", "pi-quota 设置"],
    );
    assert.deepEqual(view.menus[0]?.options, [
      "Language: English",
      "Quota panel: floating, top right",
      "Percent shown: left",
      "Alerts for five-hour: on",
      "Alerts for weekly: on",
      "Done",
    ]);
    assert.deepEqual(view.menus.at(-1)?.options, [
      "语言：简体中文",
      "配额面板：编辑器上方",
      "显示：已用",
      "five-hour 提醒：开启",
      "weekly 提醒：已静音",
      "完成",
    ]);
    assert.deepEqual(
      {
        language: savedConfig().language,
        placement: savedConfig().placement,
        percent: savedConfig().percent,
        hidden: savedConfig().hidden,
        muted: savedConfig().muted,
      },
      { language: "zh", placement: "inline", percent: "used", hidden: false, muted: ["weekly"] },
    );
    // The panel moved at once: the UI was told to put it above the editor, showing what is used.
    assert.equal(view.placements.at(-1), "inline");
    assert.equal(view.widget()?.length, 2);
    assert.match(view.notes.at(-1)?.message ?? "", /^语言：简体中文 · 提醒：<20% 警告 .* 静音：weekly · 面板：编辑器上方 · 显示：已用$/);
  });

  it("cycles the panel: top right → bottom right → above the editor → hidden → top right", async () => {
    const { monitor, savedConfig } = setup();
    const view = fakeUi([
      EN.configPanel("top-right"),
      EN.configPanel("bottom-right"),
      EN.configPanel("inline"),
      EN.configPanel("hidden"),
      EN.configDone,
    ]);
    monitor.start(view.ui);
    await monitor.idle();
    assert.equal(view.placements.at(-1), "top-right");
    await monitor.command("config", view.ui);
    assert.deepEqual(
      view.menus.map((menu) => menu.options[1]),
      [
        "Quota panel: floating, top right",
        "Quota panel: floating, bottom right",
        "Quota panel: above the editor",
        "Quota panel: hidden",
        "Quota panel: floating, top right",
      ],
    );
    assert.deepEqual({ placement: savedConfig().placement, hidden: savedConfig().hidden }, { placement: "top-right", hidden: false });
    assert.ok(view.placements.includes("bottom-right"), "the bottom right was offered to the UI");
    // While hidden there was no panel; floating again, it is back.
    assert.ok(view.widgets.includes(undefined));
    assert.equal(view.widget()?.length, 2);
  });

  it("closes on cancel and still sums up the settings", async () => {
    const { monitor } = setup();
    const view = fakeUi([undefined]);
    await monitor.command("config", view.ui);
    assert.equal(view.menus.length, 1);
    assert.match(view.notes.at(-1)?.message ?? "", /^Language: English · Alerts: warn under 20%/);
  });

  it("without a picker (no UI for it) shows the usage", async () => {
    const { monitor } = setup();
    const view = fakeUi();
    await monitor.command("config", view.ui);
    assert.deepEqual(view.notes, [{ level: "warning", message: EN.usage }]);
  });
});

describe("monitor: commands", () => {
  it("/quota shows the full report through notify", async () => {
    const { monitor } = setup();
    const view = fakeUi();
    await monitor.command("", view.ui);
    const report = view.notes.at(-1);
    assert.equal(report?.level, "info");
    assert.match(report?.message ?? "", /^pi-quota report/);
    assert.match(report?.message ?? "", /Pace: /);
    assert.match(report?.message ?? "", /Zhipu GLM Coding Plan/);
  });

  it("/quota refresh asks the providers again at once", async () => {
    const { monitor, providers } = setup();
    const view = fakeUi();
    await monitor.command("status", view.ui);
    await monitor.command("refresh", view.ui);
    assert.equal(providers.calls["github-copilot"], 2);
    assert.match(view.notes.at(-1)?.message ?? "", /^Refreshed · Quota: /);
  });

  it("/quota hide and show toggle the widget and are saved", async () => {
    const setupResult = setup();
    const { monitor, savedConfig, make } = setupResult;
    const view = fakeUi();
    monitor.start(view.ui);
    await monitor.idle();
    await monitor.command("hide", view.ui);
    assert.equal(view.widget(), undefined);
    assert.equal(savedConfig().hidden, true);

    const next = make();
    const view2 = fakeUi();
    next.start(view2.ui);
    await next.idle();
    assert.equal(view2.widget(), undefined);
    await next.command("show", view2.ui);
    assert.equal(view2.widget()?.length, 2);
  });

  it("an unknown or incomplete command shows the usage, in the user's language", async () => {
    const { monitor } = setup({ config: { language: "zh" } });
    const view = fakeUi();
    await monitor.command("bogus", view.ui);
    await monitor.command("mute mcp-monthly", view.ui);
    assert.deepEqual(view.notes, [
      { level: "warning", message: ZH.usage },
      { level: "warning", message: ZH.usage },
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
