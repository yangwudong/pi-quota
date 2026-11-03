/**
 * When to tell the user (the core of passive monitoring). Pure: rows, the saved alert state and
 * the clock in; the alerts to show and the next state out.
 *
 * - Warning: a five-hour or weekly window under `warnBelow` percent, once per window lifecycle.
 *   The window's identity is its `resetsAt`; two reset times within a couple of minutes are the
 *   same window, and so is any while the window warned about has not reset yet (a later reset time
 *   cannot start a new window before the old one ends).
 * - Recovery ("Quota available"): a window seen under `warnBelow` that is back at `recoverAt` or
 *   more, once per window identity as well.
 * - MCP and rows without a window (Copilot) never alert; muted windows are skipped entirely.
 */
import { type Pace, paceOf } from "./pace.ts";
import type { QuotaRow } from "./types.ts";
import { type AlertWindow, isAlertWindow } from "./windows.ts";

/** Reset times this close apart name the same window (guards against API jitter). */
const SAME_WINDOW_TOLERANCE_MS = 2 * 60_000;

/** What is remembered per window (`${provider}:${window}`); "" stands for "no reset time". */
export type WindowAlertState = {
  /** The window last warned about. */
  warnedReset?: string;
  /** Seen under the warning threshold, not yet back at the recovery threshold. */
  low?: boolean;
  /** The window last announced as available again. */
  recoveredReset?: string;
};

export type AlertState = Record<string, WindowAlertState>;

export type Alert =
  | { kind: "warning"; row: QuotaRow; pace?: Pace }
  | { kind: "recovered"; row: QuotaRow };

export type AlertOptions = {
  nowMs: number;
  muted: ReadonlySet<AlertWindow>;
  warnBelow: number;
  recoverAt: number;
};

export function alertKey(row: QuotaRow): string {
  return `${row.provider}:${row.window ?? ""}`;
}

/** True when `id` names the window `previous` named, or a time before that window ended. */
function sameLifecycle(previous: string, id: string, nowMs: number): boolean {
  if (previous === id) return true;
  const previousMs = Date.parse(previous);
  const ms = Date.parse(id);
  if (!Number.isFinite(previousMs) || !Number.isFinite(ms)) return false;
  return Math.abs(previousMs - ms) <= SAME_WINDOW_TOLERANCE_MS || nowMs < previousMs;
}

export function evaluateAlerts(
  rows: readonly QuotaRow[],
  state: AlertState,
  options: AlertOptions,
): { alerts: Alert[]; state: AlertState } {
  const { nowMs, muted, warnBelow, recoverAt } = options;
  const next: AlertState = { ...state };
  const alerts: Alert[] = [];

  for (const row of rows) {
    if (!isAlertWindow(row.window) || muted.has(row.window)) continue;
    const key = alertKey(row);
    const id = row.resetsAt ?? "";
    const previous = state[key] ?? {};
    const entry: WindowAlertState = { ...previous };

    if (row.percentRemaining < warnBelow) {
      entry.low = true;
      if (previous.warnedReset === undefined || !sameLifecycle(previous.warnedReset, id, nowMs)) {
        const pace = paceOf(row, nowMs);
        alerts.push(pace ? { kind: "warning", row, pace } : { kind: "warning", row });
        entry.warnedReset = id;
      }
    } else if (row.percentRemaining >= recoverAt && previous.low) {
      // Without a reset time there is no window identity: each low → available cycle counts.
      const announced =
        id !== "" && previous.recoveredReset !== undefined && sameLifecycle(previous.recoveredReset, id, nowMs);
      if (!announced) {
        alerts.push({ kind: "recovered", row });
        entry.recoveredReset = id;
      }
      entry.low = false;
      if (id === "") delete entry.warnedReset;
    }
    next[key] = entry;
  }
  return { alerts, state: next };
}

/** True when two states differ (so the file is written only on change). */
export function alertStateChanged(before: AlertState, after: AlertState): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
