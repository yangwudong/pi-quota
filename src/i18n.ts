/**
 * The words the user reads, per language. English is the default; `/quota lang` (or `/quota
 * config`) switches. Both catalogs implement `Messages`, so a message missing in one language
 * fails to compile. Product and provider names (Zhipu, Copilot, "AI credits", "Quota available"),
 * window short labels (5h / wk / mcp), durations and times are the same in every language.
 */
import type { JsonValue } from "./core/json.ts";
import type { ErrorHint, ProviderNote, QuotaWindow } from "./core/types.ts";
import type { AlertWindow } from "./core/windows.ts";

export type Locale = "en" | "zh";
export const LOCALES: readonly Locale[] = ["en", "zh"];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language's own name, as the language picker shows it. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", zh: "简体中文" };

const LOCALE_ALIASES: Readonly<Record<string, Locale>> = {
  en: "en",
  english: "en",
  "en-us": "en",
  zh: "zh",
  cn: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  chinese: "zh",
  中文: "zh",
  简体中文: "zh",
};

/** The language a word names ("en", "zh", "English", "中文"…); undefined for anything else. */
export function parseLocale(word: string): Locale | undefined {
  return LOCALE_ALIASES[word.trim().toLowerCase()];
}

export function isLocale(value: JsonValue | undefined): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A warning's reset clause: nothing without a reset time, `soon` once it passed, else `within`. */
function resetClause(resetIn: string, soon: string, within: (duration: string) => string): string {
  if (resetIn === "") return "";
  return resetIn === "reset" ? soon : within(resetIn);
}

/** The parts of a warning, already formatted (percent, durations). */
export type WarningParts = {
  name: string;
  percent: number;
  /** "" without a reset time, "reset" once it passed, else a duration such as "1h20m". */
  resetIn: string;
  /** The run-out time at the current pace, when it is worth saying. */
  runsOutIn?: string;
  window: AlertWindow;
};

/** The quota panel as the settings show it: floating, above the editor, or hidden. */
export type PanelState = "float" | "inline" | "hidden";

/** The parts of the alert-settings line of the full report. */
export type SettingsParts = {
  warnBelow: number;
  recoverAt: number;
  muted: readonly string[];
  panel: PanelState;
};

export type Messages = {
  /** The widget's line for a provider before its first answer. */
  checking: string;
  /** The widget's mark for a window used faster than even use. */
  fastMark: string;
  noData: string;
  notSetUp: string;
  /** Window names in sentences: "Zhipu 5h window". */
  windows: Readonly<Record<QuotaWindow, string>>;
  note(note: ProviderNote): string;
  /** What to do about an error, by hint code. */
  hints: Readonly<Record<ErrorHint, string>>;
  // ---- one-line status
  statusLine(parts: string): string;
  statusNothing: string;
  statusMuted(windows: string): string;
  // ---- full report
  reportTitle(time: string): string;
  reportChecking: string;
  reportMuted: string;
  /** A window's reset in the full report: "22:10 (3h 12m)". */
  resetAt(time: string, countdown: string): string;
  reportSettings(parts: SettingsParts): string;
  paceSpare(evenLeft: number): string;
  paceOnTrack(evenLeft: number): string;
  paceEarly(evenLeft: number): string;
  paceUsedUp(evenLeft: number): string;
  paceFast(runsOutIn: string, evenLeft: number): string;
  // ---- alerts
  warning(parts: WarningParts): string;
  recovered(name: string, percent: number): string;
  // ---- commands
  usage: string;
  refreshed(status: string): string;
  muted(window: AlertWindow): string;
  unmuted(window: AlertWindow): string;
  hidden: string;
  shown: string;
  saveFailed(path: string): string;
  languageSet(name: string): string;
  languageTitle: string;
  configTitle: string;
  configLanguage(name: string): string;
  /** The panel's state in words: "floating", "above the editor", "hidden". */
  panelStates: Readonly<Record<PanelState, string>>;
  configPanel(panel: PanelState): string;
  configMute(window: AlertWindow, muted: boolean): string;
  configDone: string;
  /** The `/` menu: the command's own line, and one per argument. */
  commandDescription: string;
  argument: Readonly<Record<string, string>>;
};

const EN_PANEL: Readonly<Record<PanelState, string>> = { float: "floating", inline: "above the editor", hidden: "hidden" };
const ZH_PANEL: Readonly<Record<PanelState, string>> = { float: "悬浮（右上）", inline: "编辑器上方", hidden: "隐藏" };

const en: Messages = {
  checking: "… checking",
  fastMark: "⚠ fast",
  noData: "no quota data",
  notSetUp: "not set up",
  windows: { "five-hour": "5h window", weekly: "weekly window", "mcp-monthly": "MCP monthly" },
  note(note) {
    if (note.kind === "plan_only") return "plan info only, no usage data";
    if (note.kind === "unlimited") return `${note.label}: unlimited`;
    return `${COUNT.format(note.used)} ${note.label} used (no percent left reported)`;
  },
  hints: {
    zhipu_setup: "Zhipu API key not set: set ZAI_CODING_CN_API_KEY, or run /login zai-coding-cn in pi",
    zhipu_command_key:
      "the zai-coding-cn key in auth.json is a !command, which pi-quota does not run; set ZAI_CODING_CN_API_KEY instead",
    copilot_login: "not logged in to GitHub Copilot: run /login github-copilot in pi",
    copilot_not_oauth:
      "the github-copilot entry in auth.json is not an OAuth login (API keys are not accepted): run /login github-copilot",
    copilot_enterprise: "GitHub Enterprise accounts are not supported (personal subscriptions only)",
    copilot_no_token: "the github-copilot login has no GitHub OAuth token: run /login github-copilot again",
    copilot_relogin: "run /login github-copilot in pi again",
  },
  statusLine: (parts) => `Quota: ${parts}`,
  statusNothing: "no provider set up (see /quota)",
  statusMuted: (windows) => ` · muted ${windows}`,
  reportTitle: (time) => `pi-quota report · ${time}`,
  reportChecking: "checking",
  reportMuted: "[muted]",
  resetAt: (time, countdown) => `${time} (${countdown})`,
  reportSettings: (p) =>
    `Alerts: warn under ${p.warnBelow}% · "Quota available" back at ≥${p.recoverAt}% · muted: ${p.muted.length > 0 ? p.muted.join(", ") : "none"} · panel: ${EN_PANEL[p.panel]}`,
  paceSpare: (even) => `Pace: spare (even use ${even}%)`,
  paceOnTrack: (even) => `Pace: on track (even use ${even}%)`,
  paceEarly: (even) => `Pace: fast, too early in the window to forecast (even use ${even}%)`,
  paceUsedUp: (even) => `Pace: used up (even use ${even}%)`,
  paceFast: (runsOutIn, even) => `Pace: fast, runs out in about ${runsOutIn} at this rate (even use ${even}%)`,
  warning(p) {
    const reset = resetClause(p.resetIn, ", resets soon", (duration) => `, resets in ${duration}`);
    const head = p.percent <= 0 ? `${p.name} is used up${reset}` : `${p.name}: ${p.percent}% left${reset}`;
    const runsOut = p.runsOutIn ? `; at this pace it runs out in about ${p.runsOutIn}` : "";
    return `pi-quota · ${head}${runsOut} (mute: /quota mute ${p.window})`;
  },
  recovered: (name, percent) => `✅ Quota available · ${name} is back to ${percent}%`,
  usage:
    "Usage: /quota [status | refresh | config | lang <en|zh> | mute <five-hour|weekly> | unmute <five-hour|weekly> | hide | show]",
  refreshed: (status) => `Refreshed · ${status}`,
  muted: (window) => `Muted ${window}: no more warnings or "Quota available" for this window`,
  unmuted: (window) => `Unmuted ${window}`,
  hidden: "Quota panel hidden (monitoring and alerts go on; /quota show brings it back)",
  shown: "Quota panel shown",
  saveFailed: (path) => ` (could not save to ${path})`,
  languageSet: (name) => `pi-quota language: ${name}`,
  languageTitle: "pi-quota language",
  configTitle: "pi-quota settings",
  configLanguage: (name) => `Language: ${name}`,
  panelStates: EN_PANEL,
  configPanel: (panel) => `Quota panel: ${EN_PANEL[panel]}`,
  configMute: (window, isMuted) => `Alerts for ${window}: ${isMuted ? "muted" : "on"}`,
  configDone: "Done",
  commandDescription: "Quota of Zhipu GLM Coding Plan and GitHub Copilot: report, status, settings",
  argument: {
    status: "one-line summary, tightest window first",
    refresh: "check again now",
    config: "settings: language, panel, alerts",
    lang: "choose the language",
    "lang en": "English",
    "lang zh": "简体中文",
    "mute five-hour": "no alerts for the 5h window",
    "mute weekly": "no alerts for the weekly window",
    "unmute five-hour": "alerts for the 5h window again",
    "unmute weekly": "alerts for the weekly window again",
    hide: "hide the quota panel",
    show: "show the quota panel",
  },
};

const zh: Messages = {
  checking: "… 查询中",
  fastMark: "⚠ 快于正常",
  noData: "无配额数据",
  notSetUp: "未配置",
  windows: { "five-hour": "5h 窗口", weekly: "周窗口", "mcp-monthly": "MCP 月度" },
  note(note) {
    if (note.kind === "plan_only") return "仅有套餐信息，无用量数据";
    if (note.kind === "unlimited") return `${note.label} 不限量`;
    return `已用 ${COUNT.format(note.used)} ${note.label}（无剩余百分比）`;
  },
  hints: {
    zhipu_setup: "未配置智谱 API key：设置 ZAI_CODING_CN_API_KEY，或在 pi 中 /login zai-coding-cn",
    zhipu_command_key: "auth.json 中 zai-coding-cn 的 key 是 !命令 形式，pi-quota 不执行命令；请改设 ZAI_CODING_CN_API_KEY",
    copilot_login: "未登录 GitHub Copilot：请在 pi 中运行 /login github-copilot",
    copilot_not_oauth: "auth.json 的 github-copilot 不是 OAuth 登录（不接受 API key）：请 /login github-copilot",
    copilot_enterprise: "暂不支持 GitHub Enterprise 账号的 Copilot 配额（仅个人订阅）",
    copilot_no_token: "github-copilot 登录缺少 GitHub OAuth token：请重新 /login github-copilot",
    copilot_relogin: "请在 pi 中重新 /login github-copilot",
  },
  statusLine: (parts) => `配额：${parts}`,
  statusNothing: "未配置任何 provider（/quota 查看配置方法）",
  statusMuted: (windows) => ` · 静音 ${windows}`,
  reportTitle: (time) => `pi-quota 配额报告 · ${time}`,
  reportChecking: "查询中",
  reportMuted: "[静音]",
  resetAt: (time, countdown) => `${time}（${countdown}）`,
  reportSettings: (p) =>
    `提醒：<${p.warnBelow}% 警告 · 回到 ≥${p.recoverAt}% 发 Quota available · 静音：${p.muted.length > 0 ? p.muted.join(", ") : "无"} · 面板：${ZH_PANEL[p.panel]}`,
  paceSpare: (even) => `节奏：有富余（均匀线 ${even}%）`,
  paceOnTrack: (even) => `节奏：正常（均匀线 ${even}%）`,
  paceEarly: (even) => `节奏：偏快，窗口刚开始暂不预测（均匀线 ${even}%）`,
  paceUsedUp: (even) => `节奏：已耗尽（均匀线 ${even}%）`,
  paceFast: (runsOutIn, even) => `节奏：偏快，按当前速度约 ${runsOutIn} 后耗尽（均匀线 ${even}%）`,
  warning(p) {
    const reset = resetClause(p.resetIn, "，即将重置", (duration) => `，${duration} 后重置`);
    const head = p.percent <= 0 ? `${p.name}配额已用尽${reset}` : `${p.name}配额仅剩 ${p.percent}%${reset}`;
    const runsOut = p.runsOutIn ? `；按当前速度约 ${p.runsOutIn} 后耗尽` : "";
    return `pi-quota · ${head}${runsOut}（/quota mute ${p.window} 可静音）`;
  },
  recovered: (name, percent) => `✅ Quota available · ${name}已恢复至 ${percent}%`,
  usage:
    "用法：/quota [status | refresh | config | lang <en|zh> | mute <five-hour|weekly> | unmute <five-hour|weekly> | hide | show]",
  refreshed: (status) => `已刷新 · ${status}`,
  muted: (window) => `已静音 ${window}：不再发送该窗口的警告与 Quota available`,
  unmuted: (window) => `已取消静音 ${window}`,
  hidden: "已隐藏配额面板（后台监控与提醒照常，/quota show 恢复）",
  shown: "已显示配额面板",
  saveFailed: (path) => `（未能保存到 ${path}）`,
  languageSet: (name) => `pi-quota 语言：${name}`,
  languageTitle: "pi-quota 语言",
  configTitle: "pi-quota 设置",
  configLanguage: (name) => `语言：${name}`,
  panelStates: ZH_PANEL,
  configPanel: (panel) => `配额面板：${ZH_PANEL[panel]}`,
  configMute: (window, isMuted) => `${window} 提醒：${isMuted ? "已静音" : "开启"}`,
  configDone: "完成",
  commandDescription: "智谱 GLM Coding Plan 与 GitHub Copilot 配额：报告、摘要、设置",
  argument: {
    status: "单行摘要，最紧张的窗口在前",
    refresh: "立即重查",
    config: "设置：语言、面板、提醒",
    lang: "选择语言",
    "lang en": "English",
    "lang zh": "简体中文",
    "mute five-hour": "关闭 5h 窗口的提醒",
    "mute weekly": "关闭周窗口的提醒",
    "unmute five-hour": "恢复 5h 窗口的提醒",
    "unmute weekly": "恢复周窗口的提醒",
    hide: "隐藏配额面板",
    show: "显示配额面板",
  },
};

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const CATALOGS: Readonly<Record<Locale, Messages>> = { en, zh };

export function messages(locale: Locale): Messages {
  return CATALOGS[locale];
}
