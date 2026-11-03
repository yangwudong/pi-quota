/**
 * Everything the user reads: bars, countdowns, widget lines, the one-line status, the full report
 * and the alert messages. Pure: data and the clock in, plain text out (the caller adds colors).
 */
import type { Alert } from "./core/alerts.ts";
import { type Pace, paceOf } from "./core/pace.ts";
import type { QuotaConfig } from "./core/store.ts";
import type { ProviderId, ProviderReport, QuotaError, QuotaRow, QuotaWindow } from "./core/types.ts";
import { WINDOWS } from "./core/windows.ts";

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  "zai-coding-cn": "Zhipu",
  "github-copilot": "Copilot",
};

const PROVIDER_TITLES: Readonly<Record<ProviderId, string>> = {
  "zai-coding-cn": "Zhipu GLM Coding Plan",
  "github-copilot": "GitHub Copilot",
};

/** Window names in sentences ("Zhipu 5h 窗口配额仅剩 15%"). */
const WINDOW_WORDS: Readonly<Record<QuotaWindow, string>> = {
  "five-hour": "5h 窗口",
  weekly: "周窗口",
  "mcp-monthly": "MCP 月度",
};

const MINUTE_MS = 60_000;
/** Widget columns: the provider name, then the window. */
const NAME_WIDTH = 8;
const WINDOW_WIDTH = 4;
/** Under this percent a row is drawn as a warning, under `warnBelow` as low. */
const WARNING_TONE_BELOW = 50;
const FAST_MARK = "⚠ 快于正常";

/** A percent as a whole number from 0 to 100: display rounds and clamps. */
export function displayPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** A bar of `width` cells: ▰ for the share left, ▱ for the rest. */
export function bar(percent: number, width = 10): string {
  const filled = Math.round((displayPercent(percent) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/**
 * A duration as opencode-quota's `formatResetCountdown` wrote it; partial minutes round up so it
 * never understates the time left. "compact": "14m", "3h12m", and from one day on whole days "4d"
 * (its compact day style); "exact": "14m", "3h 12m", "2d 5h 14m".
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

/** The few words an error shows in the widget: "auth", "timeout", "http 500". */
export function shortReason(error: QuotaError): string {
  switch (error.kind) {
    case "not_configured":
      return "未配置";
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

/** A fast pace worth showing: past the first tenth of the window (the original's level rule). */
function isFast(pace: Pace | undefined): boolean {
  return pace?.kind === "fast" && !pace.early;
}

export type Tone = "normal" | "warning" | "low" | "error";
export type DisplayLine = { text: string; tone: Tone };

function rowTone(row: QuotaRow, pace: Pace | undefined, warnBelow: number): Tone {
  if (row.percentRemaining < warnBelow) return "low";
  if (isFast(pace) || row.percentRemaining < WARNING_TONE_BELOW) return "warning";
  return "normal";
}

function namePart(provider: ProviderId): string {
  return PROVIDER_NAMES[provider].padEnd(NAME_WIDTH);
}

/** "Zhipu   5h  ▰▰▰▰▰▰▱▱▱▱  62%  ↻3h12m  ⚠ 快于正常" */
export function rowLine(row: QuotaRow, nowMs: number): string {
  const window = (row.window ? WINDOWS[row.window].short : "").padEnd(WINDOW_WIDTH);
  const percent = `${displayPercent(row.percentRemaining)}%`.padStart(4);
  const countdown = formatResetCountdown(row.resetsAt, nowMs);
  const reset = countdown ? `  ↻${countdown}` : "";
  const fast = isFast(paceOf(row, nowMs)) ? `  ${FAST_MARK}` : "";
  return `${namePart(row.provider)}${window}${bar(row.percentRemaining)} ${percent}${reset}${fast}`;
}

/** At most this many lines per provider (5h, weekly, MCP). */
const MAX_ROWS_PER_PROVIDER = 3;

/** True for a provider with no credential at all: not in use, so the widget and status skip it. */
function notInUse(report: ProviderReport | undefined): boolean {
  return report !== undefined && !report.ok && report.error.kind === "not_configured";
}

/**
 * The resident widget: each provider's windows, its error ("Zhipu   ✗ auth"), its note when it
 * has no percent, or "查询中" before its first answer. Providers without a credential are left out;
 * with none configured the widget is empty.
 */
export function widgetLines(
  providers: readonly ProviderId[],
  reports: readonly ProviderReport[] | undefined,
  options: { nowMs: number; warnBelow: number },
): DisplayLine[] {
  return providers.flatMap((provider): DisplayLine[] => {
    const report = reports?.find((item) => item.provider === provider);
    if (!report) return [{ text: `${namePart(provider)}… 查询中`, tone: "normal" }];
    if (notInUse(report)) return [];
    if (!report.ok) return [{ text: `${namePart(provider)}✗ ${shortReason(report.error)}`, tone: "error" }];
    if (report.rows.length === 0) {
      return [{ text: `${namePart(provider)}— ${report.note ?? "无配额数据"}`, tone: "normal" }];
    }
    return report.rows.slice(0, MAX_ROWS_PER_PROVIDER).map((row) => ({
      text: rowLine(row, options.nowMs),
      tone: rowTone(row, paceOf(row, options.nowMs), options.warnBelow),
    }));
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
  const parts: Array<{ rank: number; text: string }> = [];
  for (const report of reports) {
    if (notInUse(report)) continue;
    const name = PROVIDER_NAMES[report.provider];
    if (!report.ok) {
      parts.push({ rank: -1, text: `${name} ✗ ${shortReason(report.error)}` });
      continue;
    }
    if (report.rows.length === 0) parts.push({ rank: 101, text: `${name} ${report.note ?? "无配额数据"}` });
    for (const row of report.rows) {
      const countdown = formatResetCountdown(row.resetsAt, options.nowMs);
      const fast = isFast(paceOf(row, options.nowMs)) ? " ⚠" : "";
      parts.push({
        rank: row.percentRemaining,
        text: `${shortName(row)} ${displayPercent(row.percentRemaining)}%${countdown ? ` ↻${countdown}` : ""}${fast}`,
      });
    }
  }
  parts.sort((a, b) => a.rank - b.rank);
  const muted = options.config.muted.length > 0 ? ` · 静音 ${options.config.muted.join(",")}` : "";
  return `配额：${parts.map((part) => part.text).join(" · ") || "未配置任何 provider（/quota 查看配置方法）"}${muted}`;
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
export function paceText(pace: Pace | undefined): string | undefined {
  if (!pace) return undefined;
  const even = `均匀线 ${Math.round(pace.evenLeft)}%`;
  if (pace.kind === "spare") return `节奏：有富余（${even}）`;
  if (pace.kind === "on_track") return `节奏：正常（${even}）`;
  if (pace.early) return `节奏：偏快，窗口刚开始暂不预测（${even}）`;
  if (pace.runsOutInMs === undefined) return `节奏：已耗尽（${even}）`;
  return `节奏：偏快，按当前速度约 ${formatDuration(pace.runsOutInMs)} 后耗尽（${even}）`;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "2,404/25,000 AI credits" or "0/1000"; "" without counts. */
function amountText(row: QuotaRow): string {
  if (row.used === undefined || row.limit === undefined) return "";
  return `${COUNT.format(row.used)}/${COUNT.format(row.limit)}${row.label ? ` ${row.label}` : ""}`;
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
  const lines = [`pi-quota 配额报告 · ${clockTime(nowMs, nowMs)}`];
  for (const provider of providers) {
    const report = reports.find((item) => item.provider === provider);
    const title = PROVIDER_TITLES[provider];
    if (!report) {
      lines.push(`${title} · 查询中`);
      continue;
    }
    if (!report.ok) {
      const state = report.error.kind === "not_configured" ? "未配置" : `✗ ${shortReason(report.error)}`;
      lines.push(`${title} · ${state}`, `  ${report.error.message}`);
      continue;
    }
    lines.push(report.plan ? `${title} · ${report.plan}` : title);
    if (report.rows.length === 0) lines.push(`  ${report.note ?? "无配额数据"}`);
    for (const row of report.rows) {
      const window = (row.window ? WINDOWS[row.window].short : "").padEnd(WINDOW_WIDTH);
      const percent = `${displayPercent(row.percentRemaining)}%`.padStart(4);
      const amount = amountText(row);
      const resetMs = Date.parse(row.resetsAt ?? "");
      const reset = Number.isFinite(resetMs)
        ? `  ↻ ${clockTime(resetMs, nowMs)}（${formatResetCountdown(row.resetsAt, nowMs, "exact")}）`
        : "";
      const mutedMark = row.window && (config.muted as readonly string[]).includes(row.window) ? "  [静音]" : "";
      lines.push(`  ${window}${bar(row.percentRemaining)} ${percent}${amount ? `  ${amount}` : ""}${reset}${mutedMark}`);
      const pace = paceText(paceOf(row, nowMs));
      if (pace) lines.push(`        ${pace}`);
    }
  }
  const muted = config.muted.length > 0 ? config.muted.join(", ") : "无";
  lines.push(
    `提醒：<${config.warnBelow}% 警告 · 回到 ≥${config.recoverAt}% 发 Quota available · 静音：${muted} · 面板：${config.hidden ? "隐藏" : "显示"}`,
  );
  return lines;
}

function alertName(row: QuotaRow): string {
  return `${PROVIDER_NAMES[row.provider]} ${row.window ? WINDOW_WORDS[row.window] : ""}`;
}

/** "，1h20m 后重置" / "，即将重置" / "" without a reset time. */
function resetClause(countdown: string): string {
  if (countdown === "") return "";
  if (countdown === "reset") return "，即将重置";
  return `，${countdown} 后重置`;
}

/**
 * A warning: the percent left and the time to the reset, the run-out time when the pace is fast
 * past the window's first tenth, and how to mute it. pi shows it after "Warning: ".
 */
export function warningMessage(alert: Extract<Alert, { kind: "warning" }>, nowMs: number): string {
  const { row, pace } = alert;
  const percent = displayPercent(row.percentRemaining);
  const reset = resetClause(formatResetCountdown(row.resetsAt, nowMs));
  const head = percent <= 0 ? `${alertName(row)}配额已用尽${reset}` : `${alertName(row)}配额仅剩 ${percent}%${reset}`;
  const runsOut =
    pace?.kind === "fast" && !pace.early && pace.runsOutInMs !== undefined
      ? `；按当前速度约 ${formatDuration(pace.runsOutInMs)} 后耗尽`
      : "";
  return `pi-quota · ${head}${runsOut}（/quota mute ${row.window} 可静音）`;
}

/** "✅ Quota available · Zhipu 5h 窗口已恢复至 100%" */
export function recoveryMessage(alert: Extract<Alert, { kind: "recovered" }>): string {
  return `✅ Quota available · ${alertName(alert.row)}已恢复至 ${displayPercent(alert.row.percentRemaining)}%`;
}
