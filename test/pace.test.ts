import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paceOf } from "../src/core/pace.ts";
import type { QuotaRow } from "../src/core/types.ts";

// Ported from opencode-quota tests/core.pace.test.ts.
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

/** A 5-hour row; by default half of its window has passed, so even use leaves 50%. */
const row = (fields: Partial<QuotaRow> = {}): QuotaRow => ({
  provider: "zai-coding-cn",
  window: "five-hour",
  percentRemaining: 50,
  resetsAt: at(150),
  ...fields,
});

describe("core/pace", () => {
  const cases = [
    { name: "far above even use", left: 80, kind: "spare" },
    { name: "just above even use", left: 54, kind: "on_track" },
    { name: "just below even use", left: 46, kind: "on_track" },
    { name: "below even use", left: 30, kind: "fast", runsOutInMs: (30 / 70) * 150 * MINUTE },
    { name: "nothing left", left: 0, kind: "fast" },
    { name: "over quota", left: -5, kind: "fast" },
  ] as const;
  for (const { name, left, kind, ...rest } of cases) {
    it(`${name} (${left}% left at half time) is ${kind}`, () => {
      const runsOutInMs = "runsOutInMs" in rest ? rest.runsOutInMs : undefined;
      assert.deepEqual(paceOf(row({ percentRemaining: left }), NOW), {
        evenLeft: 50,
        kind,
        ...(runsOutInMs === undefined ? {} : { runsOutInMs }),
      });
    });
  }

  it("gives no run-out time before a tenth of the window has passed (early)", () => {
    // 20 of 300 minutes passed: even use leaves about 93%.
    const pace = paceOf(row({ percentRemaining: 50, resetsAt: at(280) }), NOW);
    assert.equal(pace?.kind, "fast");
    assert.equal(pace?.early, true);
    assert.equal(pace?.runsOutInMs, undefined);
    assert.ok(Math.abs((pace?.evenLeft ?? 0) - (280 / 300) * 100) < 1e-9);
  });

  it("gives a run-out time once a tenth of the window has passed", () => {
    // 30 of 300 minutes passed (exactly a tenth): no longer early.
    const pace = paceOf(row({ percentRemaining: 50, resetsAt: at(270) }), NOW);
    assert.equal(pace?.kind, "fast");
    assert.equal(pace?.early, undefined);
    assert.equal(pace?.runsOutInMs, (50 / 50) * 30 * MINUTE);
  });

  it("uses the weekly window's length (10080 minutes)", () => {
    // Half a week to go: even use leaves 50%.
    const pace = paceOf(row({ window: "weekly", percentRemaining: 50, resetsAt: at(5040) }), NOW);
    assert.deepEqual(pace, { evenLeft: 50, kind: "on_track" });
  });

  it("uses the row's own window start over the window's length", () => {
    const pace = paceOf(
      row({ percentRemaining: 50, window: "weekly", windowStartedAt: at(-60), resetsAt: at(60) }),
      NOW,
    );
    assert.deepEqual(pace, { evenLeft: 50, kind: "on_track" });
  });

  const none: Array<[string, Partial<QuotaRow>]> = [
    ["a row without a reset", { resetsAt: undefined }],
    ["a row without a known window (Copilot)", { window: undefined }],
    ["an MCP row (no fixed length)", { window: "mcp-monthly" }],
    ["a window that already reset", { resetsAt: at(-1) }],
    ["a window that has not started", { windowStartedAt: at(10) }],
  ];
  for (const [name, fields] of none) {
    it(`has no pace for ${name}`, () => {
      assert.equal(paceOf(row({ percentRemaining: 40, ...fields }), NOW), undefined);
    });
  }
});
