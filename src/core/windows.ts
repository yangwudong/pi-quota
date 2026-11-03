/**
 * The table of quota windows (port of opencode-quota `core/windows.ts`, cut to the three windows
 * these providers report): labels, nominal length, and whether the window resets on a schedule.
 */
import type { QuotaWindow } from "./types.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type WindowInfo = {
  label: string;
  short: string;
  /** Fixed length, when the window has one (months do not). */
  lengthMs?: number;
  /** True when the window refills at a reset time, so a reset notice makes sense. */
  resets: boolean;
};

export const WINDOWS: Readonly<Record<QuotaWindow, WindowInfo>> = {
  // 300 minutes
  "five-hour": { label: "5h", short: "5h", lengthMs: 5 * HOUR_MS, resets: true },
  // 10080 minutes
  weekly: { label: "Weekly", short: "wk", lengthMs: 7 * DAY_MS, resets: true },
  "mcp-monthly": { label: "MCP", short: "mcp", resets: false },
};

export function isQuotaWindow(value: unknown): value is QuotaWindow {
  return typeof value === "string" && Object.hasOwn(WINDOWS, value);
}

/** The windows that warn, send "Quota available" and take `/quota mute`; MCP only shows. */
export const ALERT_WINDOWS = ["five-hour", "weekly"] as const;
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

export function isAlertWindow(value: unknown): value is AlertWindow {
  return typeof value === "string" && (ALERT_WINDOWS as readonly string[]).includes(value);
}
