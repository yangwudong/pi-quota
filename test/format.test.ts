import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/core/store.ts";
import type { ProviderId, ProviderReport, QuotaRow } from "../src/core/types.ts";
import {
  bar,
  clockTime,
  formatDuration,
  formatResetCountdown,
  fullReport,
  rowLine,
  statusLine,
  widgetLines,
} from "../src/format.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("formatDuration / formatResetCountdown (compact, as the widget shows it)", () => {
  const compact: Array<[number, string]> = [
    [30_000, "1m"], // partial minutes round up: never understates
    [14 * MINUTE, "14m"],
    [59 * MINUTE, "59m"], // just under an hour
    [59 * MINUTE + 1, "1h0m"], // rounds up across the hour
    [HOUR, "1h0m"],
    [3 * HOUR + 12 * MINUTE, "3h12m"],
    [23 * HOUR + 59 * MINUTE, "23h59m"], // just under a day
    [DAY - 1, "1d"], // rounds up across the day
    [DAY, "1d"],
    [4 * DAY + 5 * HOUR, "4d"],
    [27 * DAY + 11 * HOUR, "27d"],
  ];
  for (const [ms, text] of compact) {
    it(`${ms} ms → ${text}`, () => {
      assert.equal(formatDuration(ms), text);
      assert.equal(formatResetCountdown(at(ms), NOW), text);
    });
  }

  it("the exact style spells every unit (the full report)", () => {
    assert.equal(formatDuration(14 * MINUTE, "exact"), "14m");
    assert.equal(formatDuration(3 * HOUR + 12 * MINUTE, "exact"), "3h 12m");
    assert.equal(formatDuration(2 * DAY + 5 * HOUR + 14 * MINUTE, "exact"), "2d 5h 14m");
  });

  it("is empty without a reset time and 'reset' once it passed", () => {
    assert.equal(formatResetCountdown(undefined, NOW), "");
    assert.equal(formatResetCountdown(at(0), NOW), "reset");
    assert.equal(formatResetCountdown(at(-HOUR), NOW), "reset");
    assert.equal(formatResetCountdown("not a date", NOW), "reset");
  });
});

describe("bar", () => {
  it("has 10 cells, ▰ for what is left", () => {
    assert.equal(bar(62), "▰▰▰▰▰▰▱▱▱▱");
    assert.equal(bar(84), "▰▰▰▰▰▰▰▰▱▱");
    assert.equal(bar(0), "▱▱▱▱▱▱▱▱▱▱");
    assert.equal(bar(100), "▰▰▰▰▰▰▰▰▰▰");
    assert.equal(bar(-5), "▱▱▱▱▱▱▱▱▱▱");
    assert.equal(bar(140), "▰▰▰▰▰▰▰▰▰▰");
  });
});

const zhipu = (window: QuotaRow["window"], percentRemaining: number, resetInMs: number): QuotaRow => ({
  provider: "zai-coding-cn",
  window,
  percentRemaining,
  resetsAt: at(resetInMs),
});

const reports: ProviderReport[] = [
  {
    provider: "zai-coding-cn",
    ok: true,
    plan: "pro",
    checkedAtMs: NOW,
    rows: [
      zhipu("five-hour", 62, 3 * HOUR + 12 * MINUTE),
      zhipu("weekly", 84, 4 * DAY + 3 * HOUR),
      { ...zhipu("mcp-monthly", 100, 30 * DAY), used: 0, limit: 1000 },
    ],
  },
  {
    provider: "github-copilot",
    ok: true,
    plan: "business",
    checkedAtMs: NOW,
    rows: [
      {
        provider: "github-copilot",
        window: undefined,
        percentRemaining: 90.3,
        resetsAt: at(6 * DAY + HOUR),
        label: "AI credits",
        used: 2404,
        limit: 25000,
      },
    ],
  },
];

describe("widget", () => {
  it("draws each window as name, window, bar, percent and countdown", () => {
    assert.deepEqual(
      widgetLines(["zai-coding-cn", "github-copilot"], reports, { nowMs: NOW, warnBelow: 20 }).map((line) => line.text),
      [
        "Zhipu   5h  ▰▰▰▰▰▰▱▱▱▱  62%  ↻3h12m",
        "Zhipu   wk  ▰▰▰▰▰▰▰▰▱▱  84%  ↻4d",
        "Zhipu   mcp ▰▰▰▰▰▰▰▰▰▰ 100%  ↻30d",
        "Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻6d",
      ],
    );
  });

  it("marks a fast pace past the window's first tenth", () => {
    // 4h of 5h passed with 10% left: even use would leave 20%.
    assert.equal(rowLine(zhipu("five-hour", 10, HOUR), NOW), "Zhipu   5h  ▰▱▱▱▱▱▱▱▱▱  10%  ↻1h0m  ⚠ 快于正常");
    // Early in the window: no mark.
    assert.equal(rowLine(zhipu("five-hour", 80, 4 * HOUR + 50 * MINUTE), NOW), "Zhipu   5h  ▰▰▰▰▰▰▰▰▱▱  80%  ↻4h50m");
  });

  it("shows an error, a note or a pending check in the provider's place", () => {
    const lines = widgetLines(
      ["zai-coding-cn", "github-copilot"],
      [
        { provider: "zai-coding-cn", ok: false, error: { kind: "auth", message: "no key" }, checkedAtMs: NOW },
        { provider: "github-copilot", ok: true, rows: [], note: "AI credits 不限量", checkedAtMs: NOW },
      ],
      { nowMs: NOW, warnBelow: 20 },
    );
    assert.deepEqual(lines, [
      { text: "Zhipu   ✗ auth", tone: "error" },
      { text: "Copilot — AI credits 不限量", tone: "normal" },
    ]);
    assert.deepEqual(
      widgetLines(["zai-coding-cn"], undefined, { nowMs: NOW, warnBelow: 20 }).map((line) => line.text),
      ["Zhipu   … 查询中"],
    );
    const timeout: ProviderReport = { provider: "zai-coding-cn", ok: false, error: { kind: "timeout", message: "t" }, checkedAtMs: NOW };
    assert.equal(widgetLines(["zai-coding-cn"], [timeout], { nowMs: NOW, warnBelow: 20 })[0]?.text, "Zhipu   ✗ timeout");
  });

  it("leaves out providers without any credential; with none configured it is empty", () => {
    const unused = (provider: ProviderId): ProviderReport => ({
      provider,
      ok: false,
      error: { kind: "not_configured", message: "未登录 GitHub Copilot：请在 pi 中运行 /login github-copilot" },
      checkedAtMs: NOW,
    });
    const copilotOnly = [unused("zai-coding-cn"), reports[1] as ProviderReport];
    const both = ["zai-coding-cn", "github-copilot"] as const;
    assert.deepEqual(
      widgetLines(both, copilotOnly, { nowMs: NOW, warnBelow: 20 }).map((line) => line.text),
      ["Copilot     ▰▰▰▰▰▰▰▰▰▱  90%  ↻6d"],
    );
    const none = [unused("zai-coding-cn"), unused("github-copilot")];
    assert.deepEqual(widgetLines(both, none, { nowMs: NOW, warnBelow: 20 }), []);
    assert.equal(statusLine(copilotOnly, { nowMs: NOW, config: DEFAULT_CONFIG }), "配额：Copilot 90% ↻6d");
    assert.equal(statusLine(none, { nowMs: NOW, config: DEFAULT_CONFIG }), "配额：未配置任何 provider（/quota 查看配置方法）");
    // The full report still lists it, with how to set it up.
    const lines = fullReport(both, none, { nowMs: NOW, config: DEFAULT_CONFIG });
    assert.deepEqual(lines.slice(3, 5), ["GitHub Copilot · 未配置", "  未登录 GitHub Copilot：请在 pi 中运行 /login github-copilot"]);
  });

  it("tones a row by what is left: low under the threshold, warning under 50%", () => {
    const tones = widgetLines(
      ["zai-coding-cn"],
      [{ provider: "zai-coding-cn", ok: true, checkedAtMs: NOW, rows: [zhipu("five-hour", 15, 4 * HOUR + 50 * MINUTE), zhipu("weekly", 45, 6 * DAY), zhipu("mcp-monthly", 90, 9 * DAY)] }],
      { nowMs: NOW, warnBelow: 20 },
    ).map((line) => line.tone);
    assert.deepEqual(tones, ["low", "warning", "normal"]);
  });
});

describe("status line", () => {
  it("puts the tightest window first, errors before everything", () => {
    assert.equal(
      statusLine(reports, { nowMs: NOW, config: DEFAULT_CONFIG }),
      "配额：Zhipu 5h 62% ↻3h12m · Zhipu wk 84% ↻4d · Copilot 90% ↻6d · Zhipu mcp 100% ↻30d",
    );
    const failed: ProviderReport[] = [
      reports[1] as ProviderReport,
      { provider: "zai-coding-cn", ok: false, error: { kind: "auth", message: "x" }, checkedAtMs: NOW },
    ];
    assert.equal(
      statusLine(failed, { nowMs: NOW, config: { ...DEFAULT_CONFIG, muted: ["five-hour"] } }),
      "配额：Zhipu ✗ auth · Copilot 90% ↻6d · 静音 five-hour",
    );
  });
});

describe("full report", () => {
  it("lists counts, reset times, the pace analysis and the alert settings", () => {
    const lines = fullReport(["zai-coding-cn", "github-copilot"], reports, { nowMs: NOW, config: DEFAULT_CONFIG });
    const fiveHourReset = clockTime(NOW + 3 * HOUR + 12 * MINUTE, NOW);
    assert.equal(lines[0], `pi-quota 配额报告 · ${clockTime(NOW, NOW)}`);
    assert.equal(lines[1], "Zhipu GLM Coding Plan · pro");
    assert.equal(lines[2], `  5h  ▰▰▰▰▰▰▱▱▱▱  62%  ↻ ${fiveHourReset}（3h 12m）`);
    // 1h48m of 5h passed: even use leaves 64%; 62% is within 5 points.
    assert.equal(lines[3], "        节奏：正常（均匀线 64%）");
    assert.ok(lines.some((line) => line.includes("0/1,000")));
    assert.ok(lines.some((line) => line.startsWith("GitHub Copilot · business")));
    assert.ok(lines.some((line) => line.includes("2,404/25,000 AI credits")));
    assert.equal(lines.at(-1), "提醒：<20% 警告 · 回到 ≥50% 发 Quota available · 静音：无 · 面板：显示");
  });

  it("shows an error with its message, and muted windows", () => {
    const lines = fullReport(
      ["zai-coding-cn"],
      [
        { provider: "zai-coding-cn", ok: true, checkedAtMs: NOW, rows: [zhipu("five-hour", 62, HOUR)] },
      ],
      { nowMs: NOW, config: { ...DEFAULT_CONFIG, muted: ["five-hour"], hidden: true } },
    );
    assert.ok(lines[2]?.endsWith("[静音]"));
    assert.match(lines.at(-1) ?? "", /静音：five-hour · 面板：隐藏/);
    const failed = fullReport(
      ["zai-coding-cn"],
      [{ provider: "zai-coding-cn", ok: false, error: { kind: "auth", message: "Zhipu API error 1000: 身份验证失败。" }, checkedAtMs: NOW }],
      { nowMs: NOW, config: DEFAULT_CONFIG },
    );
    assert.deepEqual(failed.slice(1, 3), ["Zhipu GLM Coding Plan · ✗ auth", "  Zhipu API error 1000: 身份验证失败。"]);
  });
});
