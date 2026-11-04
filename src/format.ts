/**
 * Everything the user reads: bars, countdowns, widget lines, the one-line status, the full report
 * and the alert messages, in the user's language (src/i18n.ts). Pure: data, the clock and the
 * locale in, plain text out (the caller adds colors).
 */
import type { Alert } from "./core/alerts.ts";
import { type Pace, paceOf } from "./core/pace.ts";
import type { QuotaConfig } from "./core/store.ts";
import type { ProviderId, ProviderReport, QuotaError, QuotaRow } from "./core/types.ts";
import { WINDOWS } from "./core/windows.ts";
import { type Locale, type Messages, messages, type PanelState, type PercentShown } from "./i18n.ts";

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  "zai-coding-cn": "Zhipu",
  "github-copilot": "Copilot",
};

const PROVIDER_TITLES: Readonly<Record<ProviderId, string>> = {
  "zai-coding-cn": "Zhipu GLM Coding Plan",
  "github-copilot": "GitHub Copilot",
};

/** Marks a reset countdown: an hourglass still running, then a space ("⏳ 3h12m"). */
export const RESET_ICON = "⏳";

const MINUTE_MS = 60_000;
/** Widget columns: the provider name, then the window. */
const NAME_WIDTH = 8;
const WINDOW_WIDTH = 4;
/** Under this percent a row is drawn as a warning, under `warnBelow` as low. */
const WARNING_TONE_BELOW = 50;

/** A percent as a whole number from 0 to 100: display rounds and clamps. */
export function displayPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** A bar of `width` cells: ▰ for the share given (left, or used), ▱ for the rest. */
export function bar(percent: number, width = 10): string {
  const filled = Math.round((displayPercent(percent) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** The percent to show of a row: what is left (as reported), or what is used. */
export function shownPercent(percentRemaining: number, shown: PercentShown): number {
  return shown === "used" ? 100 - displayPercent(percentRemaining) : displayPercent(percentRemaining);
}

/** "▰▰▰▰▰▰▱▱▱▱  62%": a row's bar and percent as `shown` says. */
function barAndPercent(row: QuotaRow, shown: PercentShown): string {
  const percent = shownPercent(row.percentRemaining, shown);
  return `${bar(percent)} ${`${percent}%`.padStart(4)}`;
}

/**
 * A duration as opencode-quota's `formatResetCountdown` wrote it; partial minutes round up so it
 * never understates the time left. "compact": "14m", "3h12m", and from one day on whole days "4d"
 * (its compact day style); "exact": "14m", "3h 12m", "2d 5h 14m". The same in every language.
 */
export function formatDuration(ms: number, style: "compact" | "exact" = "compact"): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (style === "compact") {
    if (days > 0) return `${days}d`;
    return hours > 0 ? `${hours}h${rest}m` : `${rest}m`;
  }
  if (days > 0) return `${days}d ${hours}h ${rest}m`;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** The time until `iso`: "" without one, "reset" once it has passed (as the original). */
export function formatResetCountdown(
  iso: string | undefined,
  nowMs: number,
  style: "compact" | "exact" = "compact",
): string {
  if (!iso) return "";
  const diffMs = Date.parse(iso) - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "reset";
  return formatDuration(diffMs, style);
}

/** "⏳ 3h12m", or "" without a reset time. */
function resetMark(countdown: string): string {
  return countdown ? `${RESET_ICON} ${countdown}` : "";
}

/** The few words an error shows in the widget: "auth", "timeout", "http 500"; codes, not prose. */
export function shortReason(error: QuotaError, locale: Locale): string {
  switch (error.kind) {
    case "not_configured":
      return messages(locale).notSetUp;
    case "auth":
      return "auth";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "rate_limited":
      return "rate limit";
    case "http":
      return error.status === undefined ? "http" : `http ${error.status}`;
    case "api":
      return error.status === undefined ? "api" : `api ${error.status}`;
    case "bad_data":
      return "bad data";
    case "internal":
      return "error";
    default: {
      // Every kind is handled above, so a new kind fails to compile here.
      const unhandled: never = error.kind;
      return String(unhandled);
    }
  }
}

/** An error's whole text: the provider's own words, then what to do, in the user's language. */
export function errorText(error: QuotaError, locale: Locale): string {
  const hint = error.hint ? messages(locale).hints[error.hint] : "";
  return [error.message, hint].filter(Boolean).join(" — ");
}

/** A fast pace worth showing: past the first tenth of the window (the original's level rule). */
function isFast(pace: Pace | undefined): boolean {
  return pace?.kind === "fast" && !pace.early;
}

export type Tone = "normal" | "warning" | "low" | "error";
/**
 * One panel line: `name` is the provider name padded to its column (painted in the provider
 * color), `rest` everything after it (painted by `tone`); `text` is the two together, unstyled.
 */
export type DisplayLine = { text: string; name: string; rest: string; tone: Tone };

function displayLine(provider: ProviderId, rest: string, tone: Tone): DisplayLine {
  const name = namePart(provider);
  return { text: `${name}${rest}`, name, rest, tone };
}

function rowTone(row: QuotaRow, pace: Pace | undefined, warnBelow: number): Tone {
  if (row.percentRemaining < warnBelow) return "low";
  if (isFast(pace) || row.percentRemaining < WARNING_TONE_BELOW) return "warning";
  return "normal";
}

function namePart(provider: ProviderId): string {
  return PROVIDER_NAMES[provider].padEnd(NAME_WIDTH);
}

/** "Zhipu   5h  ▰▰▰▰▰▰▱▱▱▱  62%  ⏳ 3h12m  ⚠ fast" */
export function rowLine(row: QuotaRow, nowMs: number, locale: Locale, shown: PercentShown = "remaining"): string {
  return `${namePart(row.provider)}${rowRest(row, nowMs, locale, shown)}`;
}

/** A window's line without the provider name: "5h  ▰▰▰▰▰▰▱▱▱▱  62%  ⏳ 3h12m". */
function rowRest(row: QuotaRow, nowMs: number, locale: Locale, shown: PercentShown): string {
  const window = (row.window ? WINDOWS[row.window].short : "").padEnd(WINDOW_WIDTH);
  const reset = resetMark(formatResetCountdown(row.resetsAt, nowMs));
  const fast = isFast(paceOf(row, nowMs)) ? `  ${messages(locale).fastMark}` : "";
  return `${window}${barAndPercent(row, shown)}${reset ? `  ${reset}` : ""}${fast}`;
}

/** At most this many lines per provider (5h, weekly, MCP). */
const MAX_ROWS_PER_PROVIDER = 3;

/** True for a provider with no credential at all: not in use, so the widget and status skip it. */
function notInUse(report: ProviderReport | undefined): boolean {
  return report !== undefined && !report.ok && report.error.kind === "not_configured";
}

/** A provider's note, or "no quota data" when it has neither rows nor a note. */
function noteText(report: Extract<ProviderReport, { ok: true }>, m: Messages): string {
  return report.note ? m.note(report.note) : m.noData;
}

/**
 * The resident widget: each provider's windows, its error ("Zhipu   ✗ auth"), its note when it
 * has no percent, or "checking" before its first answer. Providers without a credential are left
 * out; with none configured the widget is empty. `percent` picks left or used; the tone always
 * follows what is left.
 */
export function widgetLines(
  providers: readonly ProviderId[],
  reports: readonly ProviderReport[] | undefined,
  options: { nowMs: number; warnBelow: number; locale: Locale; percent?: PercentShown },
): DisplayLine[] {
  const m = messages(options.locale);
  const shown = options.percent ?? "remaining";
  return providers.flatMap((provider): DisplayLine[] => {
    const report = reports?.find((item) => item.provider === provider);
    if (!report) return [displayLine(provider, m.checking, "normal")];
    if (notInUse(report)) return [];
    if (!report.ok) return [displayLine(provider, `✗ ${shortReason(report.error, options.locale)}`, "error")];
    if (report.rows.length === 0) return [displayLine(provider, `— ${noteText(report, m)}`, "normal")];
    return report.rows
      .slice(0, MAX_ROWS_PER_PROVIDER)
      .map((row) =>
        displayLine(provider, rowRest(row, options.nowMs, options.locale, shown), rowTone(row, paceOf(row, options.nowMs), options.warnBelow)),
      );
  });
}

/** "Zhipu 5h" / "Copilot": a row's name in the one-line status. */
function shortName(row: QuotaRow): string {
  const window = row.window ? ` ${WINDOWS[row.window].short}` : "";
  return `${PROVIDER_NAMES[row.provider]}${window}`;
}

/** One line, the tightest first: errors, then windows by percent left, then notes. */
export function statusLine(
  reports: readonly ProviderReport[],
  options: { nowMs: number; config: QuotaConfig },
): string {
  const { config } = options;
  const m = messages(config.language);
  const parts: Array<{ rank: number; text: string }> = [];
  for (const report of reports) {
    if (notInUse(report)) continue;
    const name = PROVIDER_NAMES[report.provider];
    if (!report.ok) {
      parts.push({ rank: -1, text: `${name} ✗ ${shortReason(report.error, config.language)}` });
      continue;
    }
    if (report.rows.length === 0) parts.push({ rank: 101, text: `${name} ${noteText(report, m)}` });
    for (const row of report.rows) {
      const reset = resetMark(formatResetCountdown(row.resetsAt, options.nowMs));
      const fast = isFast(paceOf(row, options.nowMs)) ? " ⚠" : "";
      parts.push({
        rank: row.percentRemaining,
        text: `${shortName(row)} ${shownPercent(row.percentRemaining, config.percent)}%${reset ? ` ${reset}` : ""}${fast}`,
      });
    }
  }
  parts.sort((a, b) => a.rank - b.rank);
  const muted = config.muted.length > 0 ? m.statusMuted(config.muted.join(",")) : "";
  return `${m.statusLine(parts.map((part) => part.text).join(" · ") || m.statusNothing)}${muted}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** A local time: "22:10" today, else "12-01 08:00". */
export function clockTime(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

/** The pace analysis of a window, for the full report. */
export function paceText(pace: Pace | undefined, locale: Locale): string | undefined {
  if (!pace) return undefined;
  const m = messages(locale);
  const even = Math.round(pace.evenLeft);
  if (pace.kind === "spare") return m.paceSpare(even);
  if (pace.kind === "on_track") return m.paceOnTrack(even);
  if (pace.early) return m.paceEarly(even);
  if (pace.runsOutInMs === undefined) return m.paceUsedUp(even);
  return m.paceFast(formatDuration(pace.runsOutInMs), even);
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "2,404/25,000 AI credits" or "0/1000"; "" without counts. */
function amountText(row: QuotaRow): string {
  if (row.used === undefined || row.limit === undefined) return "";
  return `${COUNT.format(row.used)}/${COUNT.format(row.limit)}${row.label ? ` ${row.label}` : ""}`;
}

/** One window of the full report, then its pace analysis when it has one. */
function reportRow(row: QuotaRow, nowMs: number, config: QuotaConfig, m: Messages): string[] {
  const window = (row.window ? WINDOWS[row.window].short : "").padEnd(WINDOW_WIDTH);
  const amount = amountText(row);
  const resetMs = Date.parse(row.resetsAt ?? "");
  const reset = Number.isFinite(resetMs)
    ? `  ${RESET_ICON} ${m.resetAt(clockTime(resetMs, nowMs), formatResetCountdown(row.resetsAt, nowMs, "exact"))}`
    : "";
  const muted = row.window && (config.muted as readonly string[]).includes(row.window) ? `  ${m.reportMuted}` : "";
  const lines = [`  ${window}${barAndPercent(row, config.percent)}${amount ? `  ${amount}` : ""}${reset}${muted}`];
  const pace = paceText(paceOf(row, nowMs), config.language);
  if (pace) lines.push(`        ${pace}`);
  return lines;
}

/**
 * `/quota`: every provider with its windows, counts, reset time (local and as a countdown), the
 * pace analysis, then the alert settings. Shown with notify only, never sent to the model.
 */
export function fullReport(
  providers: readonly ProviderId[],
  reports: readonly ProviderReport[],
  options: { nowMs: number; config: QuotaConfig },
): string[] {
  const { nowMs, config } = options;
  const m = messages(config.language);
  const lines = [m.reportTitle(clockTime(nowMs, nowMs))];
  for (const provider of providers) {
    const report = reports.find((item) => item.provider === provider);
    const title = PROVIDER_TITLES[provider];
    if (!report) {
      lines.push(`${title} · ${m.reportChecking}`);
      continue;
    }
    if (!report.ok) {
      const state = report.error.kind === "not_configured" ? m.notSetUp : `✗ ${shortReason(report.error, config.language)}`;
      lines.push(`${title} · ${state}`, `  ${errorText(report.error, config.language)}`);
      continue;
    }
    lines.push(report.plan ? `${title} · ${report.plan}` : title);
    if (report.rows.length === 0) lines.push(`  ${noteText(report, m)}`);
    for (const row of report.rows) lines.push(...reportRow(row, nowMs, config, m));
  }
  lines.push(settingsLine(config));
  return lines;
}

/** The panel as the settings name it: floating at a corner, above the editor, or hidden. */
export function panelState(config: QuotaConfig): PanelState {
  return config.hidden ? "hidden" : config.placement;
}

/** The alert settings in one line: thresholds, muted windows, the panel, the percent shown. */
export function settingsLine(config: QuotaConfig): string {
  return messages(config.language).reportSettings({
    warnBelow: config.warnBelow,
    recoverAt: config.recoverAt,
    muted: config.muted,
    panel: panelState(config),
    percent: config.percent,
  });
}

function alertName(row: QuotaRow, m: Messages): string {
  return `${PROVIDER_NAMES[row.provider]} ${row.window ? m.windows[row.window] : ""}`.trimEnd();
}

/**
 * A warning: the percent left and the time to the reset, the run-out time when the pace is fast
 * past the window's first tenth, and how to mute it. pi shows it after "Warning: ".
 */
export function warningMessage(alert: Extract<Alert, { kind: "warning" }>, nowMs: number, locale: Locale): string {
  const { row, pace } = alert;
  const m = messages(locale);
  const runsOut = pace?.kind === "fast" && !pace.early && pace.runsOutInMs !== undefined;
  return m.warning({
    name: alertName(row, m),
    percent: displayPercent(row.percentRemaining),
    resetIn: formatResetCountdown(row.resetsAt, nowMs),
    ...(runsOut && pace.runsOutInMs !== undefined ? { runsOutIn: formatDuration(pace.runsOutInMs) } : {}),
    // Only five-hour and weekly rows alert (core/alerts.ts).
    window: row.window === "weekly" ? "weekly" : "five-hour",
  });
}

/** "✅ Quota available · Zhipu 5h window is back to 100%" */
export function recoveryMessage(alert: Extract<Alert, { kind: "recovered" }>, locale: Locale): string {
  const m = messages(locale);
  return m.recovered(alertName(alert.row, m), displayPercent(alert.row.percentRemaining));
}
