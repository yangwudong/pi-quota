/**
 * The monitor: what the extension does on pi's events, kept apart from pi so it runs in tests with
 * a fake UI, clock and timers. It holds the latest answers, draws the widget, decides and shows
 * alerts, keeps the 60 s refresh timer, and runs `/quota`.
 *
 * Refreshes come from session start, every turn end and the timer (whichever comes first: each
 * refresh re-arms the timer 60 s out). The cache keeps answers 60 s, so frequent turn ends cost
 * nothing. Alerts are decided on every refresh, so "Quota available" also arrives while idle.
 * Everything goes to the user through notify / setWidget, never into the model's context.
 */
import { type AuthSources, resolveCopilotToken, resolveZhipuKey } from "./auth.ts";
import { type Alert, alertStateChanged, evaluateAlerts } from "./core/alerts.ts";
import {
  DEFAULT_CONFIG,
  loadAlertState,
  loadConfig,
  type ProviderFetcher,
  QuotaCache,
  type QuotaConfig,
  type QuotaPaths,
  writeJsonAtomic,
} from "./core/store.ts";
import type { ProviderId, ProviderReport, ProviderResult } from "./core/types.ts";
import { ALERT_WINDOWS, type AlertWindow, isAlertWindow } from "./core/windows.ts";
import {
  fullReport,
  recoveryMessage,
  statusLine,
  type Tone,
  warningMessage,
  widgetLines,
} from "./format.ts";
import { fetchCopilotQuota } from "./providers/copilot.ts";
import { fetchGlmCodingPlan } from "./providers/glm-coding-plan.ts";

export const WIDGET_KEY = "quota";
export const REFRESH_INTERVAL_MS = 60_000;

export type NotifyLevel = "info" | "warning" | "error";

/** The part of pi's `ctx.ui` the monitor uses. */
export type MonitorUi = {
  notify(message: string, level: NotifyLevel): void;
  setWidget(key: string, lines: string[] | undefined): void;
  /** Colors one widget line; plain text without it. */
  paint?(tone: Tone, text: string): string;
};

/** Starts a timer and returns what cancels it. */
export type SetTimer = (run: () => void, ms: number) => () => void;

export type MonitorOptions = {
  fetchers: ReadonlyArray<readonly [ProviderId, ProviderFetcher]>;
  paths: QuotaPaths;
  now?: () => number;
  setTimer?: SetTimer;
  /** False under `--offline` / PI_OFFLINE: no checks of its own, only on `/quota`. */
  automatic?: boolean;
};

export const COMMAND_USAGE =
  "用法：/quota [status | refresh | mute <five-hour|weekly> | unmute <five-hour|weekly> | hide | show]";

/** Argument completions of `/quota`. */
export const COMMAND_ARGUMENTS: readonly string[] = [
  "status",
  "refresh",
  ...ALERT_WINDOWS.map((window) => `mute ${window}`),
  ...ALERT_WINDOWS.map((window) => `unmute ${window}`),
  "hide",
  "show",
];

/**
 * The completions for what follows `/quota `; none once the argument is complete, so Enter runs
 * the command at once instead of first accepting the same text from the popup.
 */
export function completeArguments(prefix: string): string[] | null {
  const typed = prefix.trim().toLowerCase();
  const matches = COMMAND_ARGUMENTS.filter((value) => value.startsWith(typed));
  if (matches.length === 0 || (matches.length === 1 && matches[0] === typed)) return null;
  return matches;
}

const WINDOW_ALIASES: Readonly<Record<string, AlertWindow>> = { "5h": "five-hour", wk: "weekly", week: "weekly" };

function parseWindow(word: string): AlertWindow | undefined {
  const name = word.trim().toLowerCase();
  return isAlertWindow(name) ? name : WINDOW_ALIASES[name];
}

const defaultTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** The two providers, each reading its credential fresh on every check. */
export function defaultFetchers(sources: () => AuthSources): Array<[ProviderId, ProviderFetcher]> {
  return [
    [
      "zai-coding-cn",
      async (): Promise<ProviderResult> => {
        const credential = resolveZhipuKey(sources());
        if (!credential.ok) return { ok: false, error: credential.error };
        return fetchGlmCodingPlan({ apiKey: credential.secret });
      },
    ],
    [
      "github-copilot",
      async (): Promise<ProviderResult> => {
        const credential = resolveCopilotToken(sources());
        if (!credential.ok) return { ok: false, error: credential.error };
        return fetchCopilotQuota({ token: credential.secret });
      },
    ],
  ];
}

export type QuotaMonitor = {
  /** session_start: draw the widget, check now, arm the timer. */
  start(ui: MonitorUi): void;
  /** turn_end: check again in the background (cached answers make this cheap). */
  onTurnEnd(ui: MonitorUi): void;
  /** `/quota …` */
  command(args: string, ui: MonitorUi): Promise<void>;
  /** session_shutdown: stop the timer; a check in flight ends quietly. */
  stop(): void;
  /** Settles when the check in flight (if any) is done; for tests. */
  idle(): Promise<void>;
};

export function createMonitor(options: MonitorOptions): QuotaMonitor {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultTimer;
  const automatic = options.automatic ?? true;
  const { paths } = options;
  const cache = new QuotaCache(options.fetchers, { now });
  const providers = cache.providers;

  let ui: MonitorUi | undefined;
  let active = false;
  let config: QuotaConfig = { ...DEFAULT_CONFIG, muted: [] };
  let reports: ProviderReport[] | undefined;
  let cancelTimer: (() => void) | undefined;
  let inflight: Promise<ProviderReport[]> | undefined;
  /** "Quota available" texts not shown yet: the next caller to show info takes them along. */
  let pendingInfo: string[] = [];

  /** Calls the UI; a stale pi context (after a session switch) must never break a check. */
  function withUi(use: (current: MonitorUi) => void): void {
    if (!ui) return;
    try {
      use(ui);
    } catch {
      // The context went stale; the next event brings a fresh one.
    }
  }

  function render(): void {
    withUi((current) => {
      if (config.hidden || (!automatic && !reports)) {
        current.setWidget(WIDGET_KEY, undefined);
        return;
      }
      const lines = widgetLines(providers, reports, { nowMs: now(), warnBelow: config.warnBelow });
      // Nothing configured: no widget at all rather than an empty one.
      if (lines.length === 0) {
        current.setWidget(WIDGET_KEY, undefined);
        return;
      }
      const paint = current.paint ?? ((_tone: Tone, text: string) => text);
      current.setWidget(
        WIDGET_KEY,
        lines.map((line) => paint(line.tone, line.text)),
      );
    });
  }

  function arm(): void {
    cancelTimer?.();
    cancelTimer = undefined;
    if (active && automatic) cancelTimer = setTimer(() => void background(), REFRESH_INTERVAL_MS);
  }

  /** Decides the alerts of these answers and saves what they change. */
  function decide(latest: readonly ProviderReport[]): Alert[] {
    const rows = latest.flatMap((report) => (report.ok ? report.rows : []));
    const before = loadAlertState(paths.state);
    const { alerts, state } = evaluateAlerts(rows, before, {
      nowMs: now(),
      muted: new Set(config.muted),
      warnBelow: config.warnBelow,
      recoverAt: config.recoverAt,
    });
    if (alertStateChanged(before, state)) writeJsonAtomic(paths.state, state);
    return alerts;
  }

  async function check(force: boolean): Promise<ProviderReport[]> {
    config = loadConfig(paths.config);
    if (force) cache.clear();
    // Draw each provider as it answers: a slow one (up to the 8 s deadline) holds back no other.
    const latest = await cache.getAll({
      onReport: (report) => {
        reports = [...(reports ?? []).filter((item) => item.provider !== report.provider), report];
        render();
      },
    });
    reports = latest;
    render();
    // Nobody to tell (the session ended meanwhile): leave the alerts to the next session.
    if (!ui) return latest;
    for (const alert of decide(latest)) {
      if (alert.kind === "warning") withUi((current) => current.notify(warningMessage(alert, now()), "warning"));
      else pendingInfo.push(recoveryMessage(alert));
    }
    return latest;
  }

  /** Waits for a check however it ends; its own caller handles a failure. */
  async function settled(run: Promise<ProviderReport[]>): Promise<void> {
    try {
      await run;
    } catch {
      // Seen by the caller of that check.
    }
  }

  async function checkAfter(previous: Promise<ProviderReport[]> | undefined, force: boolean): Promise<ProviderReport[]> {
    if (previous) await settled(previous);
    return check(force);
  }

  /** When a check ends it is no longer in flight, and the timer starts over ("whichever first"). */
  async function finish(run: Promise<ProviderReport[]>): Promise<void> {
    await settled(run);
    if (inflight === run) inflight = undefined;
    arm();
  }

  /** One check at a time; a caller during a check shares it, a forced one runs after it. */
  function refresh(force = false): Promise<ProviderReport[]> {
    if (inflight && !force) return inflight;
    const run = checkAfter(inflight, force);
    inflight = run;
    void finish(run);
    return run;
  }

  function takePending(): string[] {
    const taken = pendingInfo;
    pendingInfo = [];
    return taken;
  }

  /** A check nobody waits for (start, turn end, timer); its "Quota available" shows on its own. */
  async function background(): Promise<void> {
    try {
      await refresh();
    } catch {
      return;
    }
    const info = takePending();
    if (info.length > 0) withUi((current) => current.notify(info.join("\n"), "info"));
  }

  /** Command output, with any "Quota available" first: consecutive info lines replace each other in pi. */
  function say(text: string, level: NotifyLevel = "info"): void {
    const info = takePending();
    if (level === "info") {
      withUi((current) => current.notify([...info, text].join("\n"), "info"));
      return;
    }
    if (info.length > 0) withUi((current) => current.notify(info.join("\n"), "info"));
    withUi((current) => current.notify(text, level));
  }

  function saveConfig(): string {
    return writeJsonAtomic(paths.config, config) ? "" : `（未能保存到 ${paths.config}）`;
  }

  async function command(args: string, nextUi: MonitorUi): Promise<void> {
    ui = nextUi;
    const [sub = "", argument = ""] = args.trim().split(/\s+/u);
    switch (sub.toLowerCase()) {
      case "": {
        const latest = await refresh();
        say(fullReport(providers, latest, { nowMs: now(), config }).join("\n"));
        return;
      }
      case "status": {
        const latest = await refresh();
        say(statusLine(latest, { nowMs: now(), config }));
        return;
      }
      case "refresh": {
        const latest = await refresh(true);
        say(`已刷新 · ${statusLine(latest, { nowMs: now(), config })}`);
        return;
      }
      case "mute":
      case "unmute": {
        const window = parseWindow(argument);
        if (!window) {
          say(COMMAND_USAGE, "warning");
          return;
        }
        config = loadConfig(paths.config);
        const muted = new Set(config.muted);
        if (sub.toLowerCase() === "mute") muted.add(window);
        else muted.delete(window);
        config = { ...config, muted: ALERT_WINDOWS.filter((name) => muted.has(name)) };
        const failed = saveConfig();
        say(
          sub.toLowerCase() === "mute"
            ? `已静音 ${window}：不再发送该窗口的警告与 Quota available${failed}`
            : `已取消静音 ${window}${failed}`,
        );
        return;
      }
      case "hide":
      case "show": {
        config = { ...loadConfig(paths.config), hidden: sub.toLowerCase() === "hide" };
        const failed = saveConfig();
        render();
        say(
          config.hidden
            ? `已隐藏配额面板（后台监控与提醒照常，/quota show 恢复）${failed}`
            : `已显示配额面板${failed}`,
        );
        return;
      }
      default:
        say(COMMAND_USAGE, "warning");
    }
  }

  return {
    start(nextUi) {
      ui = nextUi;
      active = true;
      config = loadConfig(paths.config);
      render();
      if (automatic) void background();
    },
    onTurnEnd(nextUi) {
      ui = nextUi;
      if (active && automatic) void background();
    },
    command,
    stop() {
      active = false;
      cancelTimer?.();
      cancelTimer = undefined;
      ui = undefined;
    },
    async idle() {
      while (inflight) await settled(inflight);
    },
  };
}
