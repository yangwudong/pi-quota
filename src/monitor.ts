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
  type DisplayLine,
  fullReport,
  panelState,
  recoveryMessage,
  settingsLine,
  statusLine,
  warningMessage,
  widgetLines,
} from "./format.ts";
import type { PanelPlacement } from "./layout.ts";
import { fetchCopilotQuota } from "./providers/copilot.ts";
import { fetchGlmCodingPlan } from "./providers/glm-coding-plan.ts";
import {
  DEFAULT_LOCALE,
  type Locale,
  LOCALE_NAMES,
  LOCALES,
  type Messages,
  messages,
  type PanelState,
  PERCENTS_SHOWN,
  type PercentShown,
  parseLocale,
} from "./i18n.ts";

export const REFRESH_INTERVAL_MS = 60_000;

export type NotifyLevel = "info" | "warning" | "error";

/** The part of pi's `ctx.ui` the monitor uses. */
export type MonitorUi = {
  notify(message: string, level: NotifyLevel): void;
  /**
   * Shows the quota panel's lines where `placement` says (pi's TUI floats them at the bottom right,
   * just above the editor; other modes put them above the editor), or removes the panel when `lines` is undefined.
   */
  showPanel(lines: readonly DisplayLine[] | undefined, placement: PanelPlacement): void;
  /** A pick from a list (`/quota config`, `/quota lang`); undefined when cancelled. */
  select?(title: string, options: string[]): Promise<string | undefined>;
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

/** Argument completions of `/quota`. */
export const COMMAND_ARGUMENTS: readonly string[] = [
  "status",
  "refresh",
  "config",
  "lang",
  ...LOCALES.map((locale) => `lang ${locale}`),
  ...ALERT_WINDOWS.map((window) => `mute ${window}`),
  ...ALERT_WINDOWS.map((window) => `unmute ${window}`),
  "hide",
  "show",
];

export type ArgumentCompletion = { value: string; description: string };

/**
 * The completions for what follows `/quota `, each with a description in the user's language;
 * none once the argument is complete, so Enter runs the command at once instead of first accepting
 * the same text from the popup.
 */
export function completeArguments(prefix: string, locale: Locale = DEFAULT_LOCALE): ArgumentCompletion[] | null {
  // Keep a trailing space: "lang " asks for a value, so the bare "lang" is no longer offered.
  const typed = prefix.trimStart().toLowerCase();
  const matches = COMMAND_ARGUMENTS.filter((value) => value.startsWith(typed));
  if (matches.length === 0 || (matches.length === 1 && matches[0] === typed.trimEnd())) return null;
  const words = messages(locale).argument;
  return matches.map((value) => ({ value, description: words[value] ?? "" }));
}

const WINDOW_ALIASES: Readonly<Record<string, AlertWindow>> = { "5h": "five-hour", wk: "weekly", week: "weekly" };

/** The settings that make each panel state, in the order `/quota config` cycles them. */
const PANEL_STATES: Readonly<Record<PanelState, Pick<QuotaConfig, "hidden" | "placement">>> = {
  "top-right": { hidden: false, placement: "top-right" },
  "bottom-right": { hidden: false, placement: "bottom-right" },
  inline: { hidden: false, placement: "inline" },
  hidden: { hidden: true, placement: "top-right" },
};
const PANEL_CYCLE: readonly PanelState[] = ["top-right", "bottom-right", "inline", "hidden"];

function nextPanelState(state: PanelState): PanelState {
  return PANEL_CYCLE[(PANEL_CYCLE.indexOf(state) + 1) % PANEL_CYCLE.length] ?? "top-right";
}

function nextPercentShown(shown: PercentShown): PercentShown {
  return PERCENTS_SHOWN[(PERCENTS_SHOWN.indexOf(shown) + 1) % PERCENTS_SHOWN.length] ?? "remaining";
}

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
  /** The language in use now: the `/` menu's argument descriptions follow it. */
  locale(): Locale;
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
        current.showPanel(undefined, config.placement);
        return;
      }
      const lines = widgetLines(providers, reports, {
        nowMs: now(),
        warnBelow: config.warnBelow,
        locale: config.language,
        percent: config.percent,
      });
      // Nothing configured: no panel at all rather than an empty one.
      current.showPanel(lines.length === 0 ? undefined : lines, config.placement);
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
      if (alert.kind === "warning") {
        withUi((current) => current.notify(warningMessage(alert, now(), config.language), "warning"));
      } else pendingInfo.push(recoveryMessage(alert, config.language));
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

  /** The words of the language in use. */
  function words(): Messages {
    return messages(config.language);
  }

  /** Changes the settings (re-read first: another session may have changed them), saves, redraws. */
  function updateConfig(change: (current: QuotaConfig) => QuotaConfig): string {
    config = change(loadConfig(paths.config));
    const saved = writeJsonAtomic(paths.config, config);
    render();
    return saved ? "" : words().saveFailed(paths.config);
  }

  function setMuted(window: AlertWindow, mute: boolean): string {
    return updateConfig((current) => {
      const muted = new Set(current.muted);
      if (mute) muted.add(window);
      else muted.delete(window);
      return { ...current, muted: ALERT_WINDOWS.filter((name) => muted.has(name)) };
    });
  }

  /** The language picker; undefined when cancelled or when this UI has no picker. */
  async function pickLanguage(current: MonitorUi): Promise<Locale | undefined> {
    if (!current.select) return undefined;
    const picked = await current.select(
      words().languageTitle,
      LOCALES.map((locale) => LOCALE_NAMES[locale]),
    );
    return LOCALES.find((locale) => LOCALE_NAMES[locale] === picked);
  }

  /** `/quota lang [en|zh]`: sets the language, or asks for it. Says so in the new language. */
  async function language(argument: string, current: MonitorUi): Promise<void> {
    const locale = argument ? parseLocale(argument) : await pickLanguage(current);
    if (!locale) {
      if (argument || !current.select) say(words().usage, "warning");
      return;
    }
    const failed = updateConfig((settings) => ({ ...settings, language: locale }));
    say(`${words().languageSet(LOCALE_NAMES[locale])}${failed}`);
  }

  /** `/quota config`: a settings menu; each pick applies at once and the menu comes back until Done. */
  async function settingsMenu(current: MonitorUi): Promise<void> {
    const select = current.select;
    if (!select) {
      say(words().usage, "warning");
      return;
    }
    for (;;) {
      config = loadConfig(paths.config);
      const w = words();
      const items: Array<{ label: string; apply?: () => Promise<unknown> | unknown }> = [
        {
          label: w.configLanguage(LOCALE_NAMES[config.language]),
          apply: async () => {
            const locale = await pickLanguage(current);
            if (locale) updateConfig((settings) => ({ ...settings, language: locale }));
          },
        },
        {
          label: w.configPanel(panelState(config)),
          apply: () => updateConfig((settings) => ({ ...settings, ...PANEL_STATES[nextPanelState(panelState(settings))] })),
        },
        {
          label: w.configPercent(config.percent),
          apply: () => updateConfig((settings) => ({ ...settings, percent: nextPercentShown(settings.percent) })),
        },
        ...ALERT_WINDOWS.map((window) => {
          const isMuted = config.muted.includes(window);
          return { label: w.configMute(window, isMuted), apply: () => setMuted(window, !isMuted) };
        }),
        { label: w.configDone },
      ];
      const picked = await select(w.configTitle, items.map((item) => item.label));
      const apply = items.find((item) => item.label === picked)?.apply;
      if (!apply) break;
      await apply();
    }
    const w = words();
    say(`${w.configLanguage(LOCALE_NAMES[config.language])} · ${settingsLine(config)}`);
  }

  async function report(): Promise<void> {
    const latest = await refresh();
    say(fullReport(providers, latest, { nowMs: now(), config }).join("\n"));
  }

  async function status(force: boolean): Promise<void> {
    const latest = await refresh(force);
    const line = statusLine(latest, { nowMs: now(), config });
    say(force ? words().refreshed(line) : line);
  }

  function mute(on: boolean, argument: string): void {
    const window = parseWindow(argument);
    if (!window) {
      say(words().usage, "warning");
      return;
    }
    const failed = setMuted(window, on);
    say(`${on ? words().muted(window) : words().unmuted(window)}${failed}`);
  }

  function visibility(hidden: boolean): void {
    const failed = updateConfig((settings) => ({ ...settings, hidden }));
    say(`${hidden ? words().hidden : words().shown}${failed}`);
  }

  async function command(args: string, nextUi: MonitorUi): Promise<void> {
    ui = nextUi;
    // The command answers in the language set now, also when another session changed it.
    config = loadConfig(paths.config);
    const [sub = "", argument = ""] = args.trim().split(/\s+/u);
    const name = sub.toLowerCase();
    if (name === "") return report();
    if (name === "status" || name === "refresh") return status(name === "refresh");
    if (name === "config" || name === "settings") return settingsMenu(nextUi);
    if (name === "lang" || name === "language") return language(argument, nextUi);
    if (name === "mute" || name === "unmute") return mute(name === "mute", argument);
    if (name === "hide" || name === "show") return visibility(name === "hide");
    say(words().usage, "warning");
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
    locale: () => config.language,
  };
}
