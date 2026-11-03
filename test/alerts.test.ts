import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AlertOptions, type AlertState, evaluateAlerts } from "../src/core/alerts.ts";
import type { QuotaRow } from "../src/core/types.ts";
import type { AlertWindow } from "../src/core/windows.ts";
import { recoveryMessage, warningMessage } from "../src/format.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number, from = NOW) => new Date(from + minutes * MINUTE).toISOString();

/** A 5h row; `resetsAt: null` gives one without a reset time (undefined would take the default). */
const fiveHour = (percentRemaining: number, resetsAt: string | null = at(150)): QuotaRow => ({
  provider: "zai-coding-cn",
  window: "five-hour",
  percentRemaining,
  ...(resetsAt ? { resetsAt } : {}),
});

function options(fields: Partial<AlertOptions> = {}): AlertOptions {
  return { nowMs: NOW, muted: new Set<AlertWindow>(), warnBelow: 20, recoverAt: 50, ...fields };
}

/** Runs the rows through several checks, carrying the state along; returns every check's alerts. */
function run(checks: Array<{ rows: QuotaRow[]; nowMs?: number }>, base: Partial<AlertOptions> = {}) {
  let state: AlertState = {};
  return checks.map(({ rows, nowMs }) => {
    const result = evaluateAlerts(rows, state, options({ ...base, ...(nowMs ? { nowMs } : {}) }));
    state = result.state;
    return result.alerts.map((alert) => `${alert.kind}:${alert.row.window}:${alert.row.percentRemaining}`);
  });
}

describe("warnings", () => {
  it("warns under 20% once per window lifecycle (resetsAt is the window's identity)", () => {
    assert.deepEqual(
      run([{ rows: [fiveHour(25)] }, { rows: [fiveHour(15)] }, { rows: [fiveHour(10)] }, { rows: [fiveHour(2)] }]),
      [[], ["warning:five-hour:15"], [], []],
    );
  });

  it("warns again in the next window", () => {
    const next = at(150 + 300);
    assert.deepEqual(
      run([
        { rows: [fiveHour(15)] },
        { rows: [fiveHour(12, next)], nowMs: NOW + 151 * MINUTE },
      ]),
      [["warning:five-hour:15"], ["warning:five-hour:12"]],
    );
  });

  it("treats a reset time that jitters by seconds as the same window", () => {
    assert.deepEqual(
      run([{ rows: [fiveHour(15, at(150))] }, { rows: [fiveHour(14, at(150.5))] }]),
      [["warning:five-hour:15"], []],
    );
  });

  it("does not repeat while the window warned about has not reset, even if its reset time moves", () => {
    assert.deepEqual(
      run([{ rows: [fiveHour(15, at(150))] }, { rows: [fiveHour(14, at(200))], nowMs: NOW + 30 * MINUTE }]),
      [["warning:five-hour:15"], []],
    );
  });

  it("covers the weekly window too, each window on its own", () => {
    const weekly: QuotaRow = { provider: "zai-coding-cn", window: "weekly", percentRemaining: 18, resetsAt: at(3000) };
    assert.deepEqual(run([{ rows: [fiveHour(15), weekly] }, { rows: [fiveHour(15), weekly] }]), [
      ["warning:five-hour:15", "warning:weekly:18"],
      [],
    ]);
  });

  it("never alerts for MCP or for rows without a window (Copilot)", () => {
    const mcp: QuotaRow = { provider: "zai-coding-cn", window: "mcp-monthly", percentRemaining: 1, resetsAt: at(9000) };
    const copilot: QuotaRow = { provider: "github-copilot", window: undefined, percentRemaining: 1, resetsAt: at(9000) };
    assert.deepEqual(run([{ rows: [mcp, copilot] }, { rows: [{ ...mcp, percentRemaining: 100 }] }]), [[], []]);
  });

  it("a muted window sends nothing; unmuted, it warns", () => {
    const muted = new Set<AlertWindow>(["five-hour"]);
    let state: AlertState = {};
    const first = evaluateAlerts([fiveHour(10)], state, options({ muted }));
    state = first.state;
    assert.deepEqual(first.alerts, []);
    const unmuted = evaluateAlerts([fiveHour(10)], state, options());
    assert.deepEqual(unmuted.alerts.map((alert) => alert.kind), ["warning"]);
  });

  it("with the threshold at 99 (the acceptance check) it warns at 81% and only once", () => {
    assert.deepEqual(run([{ rows: [fiveHour(81)] }, { rows: [fiveHour(81)] }], { warnBelow: 99 }), [
      ["warning:five-hour:81"],
      [],
    ]);
  });

  it("without a reset time a window warns once until it recovers", () => {
    assert.deepEqual(
      run([
        { rows: [fiveHour(15, null)] },
        { rows: [fiveHour(10, null)] },
        { rows: [fiveHour(90, null)] },
        { rows: [fiveHour(12, null)] },
      ]),
      [["warning:five-hour:15"], [], ["recovered:five-hour:90"], ["warning:five-hour:12"]],
    );
  });
});

describe("pace in warnings", () => {
  it("adds the run-out time when the pace is fast past the window's first tenth", () => {
    // 150 of 300 minutes passed, 10% left: at this pace it runs out in (10/90)*150 min ≈ 16.7 min.
    const { alerts } = evaluateAlerts([fiveHour(10)], {}, options());
    const alert = alerts[0];
    assert.equal(alert?.kind, "warning");
    if (alert?.kind !== "warning") return;
    assert.equal(alert.pace?.kind, "fast");
    assert.equal(warningMessage(alert, NOW), "pi-quota · Zhipu 5h 窗口配额仅剩 10%，2h30m 后重置；按当前速度约 17m 后耗尽（/quota mute five-hour 可静音）");
  });

  it("gives no run-out time early in the window", () => {
    // 10 of 300 minutes passed.
    const { alerts } = evaluateAlerts([fiveHour(15, at(290))], {}, options());
    const alert = alerts[0];
    assert.ok(alert?.kind === "warning" && alert.pace?.early);
    if (alert?.kind !== "warning") return;
    assert.ok(!warningMessage(alert, NOW).includes("耗尽"));
  });

  it("says when a window is used up", () => {
    const { alerts } = evaluateAlerts([fiveHour(0)], {}, options());
    const alert = alerts[0];
    if (alert?.kind !== "warning") return assert.fail("expected a warning");
    assert.equal(warningMessage(alert, NOW), "pi-quota · Zhipu 5h 窗口配额已用尽，2h30m 后重置（/quota mute five-hour 可静音）");
  });
});

describe("Quota available", () => {
  it("announces a window seen under 20% once it is back at 50% or more", () => {
    const next = at(450);
    assert.deepEqual(
      run([
        { rows: [fiveHour(15)] },
        { rows: [fiveHour(35, next)], nowMs: NOW + 160 * MINUTE },
        { rows: [fiveHour(100, next)], nowMs: NOW + 170 * MINUTE },
        { rows: [fiveHour(99, next)], nowMs: NOW + 180 * MINUTE },
      ]),
      [["warning:five-hour:15"], [], ["recovered:five-hour:100"], []],
    );
  });

  it("never announces a window that was not low", () => {
    assert.deepEqual(run([{ rows: [fiveHour(40)] }, { rows: [fiveHour(100, at(450))] }]), [[], []]);
  });

  it("announces once per window identity, even if it dips again in the same window", () => {
    const next = at(450);
    const later = NOW + 200 * MINUTE;
    assert.deepEqual(
      run([
        { rows: [fiveHour(10)] },
        { rows: [fiveHour(100, next)], nowMs: later },
        { rows: [fiveHour(15, next)], nowMs: later },
        { rows: [fiveHour(80, next)], nowMs: later },
      ]),
      [["warning:five-hour:10"], ["recovered:five-hour:100"], ["warning:five-hour:15"], []],
    );
  });

  it("reads like a success toast", () => {
    assert.equal(
      recoveryMessage({ kind: "recovered", row: fiveHour(100) }),
      "✅ Quota available · Zhipu 5h 窗口已恢复至 100%",
    );
  });
});
