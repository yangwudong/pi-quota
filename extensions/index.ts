/**
 * pi-quota: watches the Zhipu GLM Coding Plan (CN) and GitHub Copilot quotas, shows them above the
 * editor, warns before a 5-hour or weekly window runs out, and says "Quota available" when it is
 * back. Everything reaches the user through `ctx.ui` (widget / notify); nothing is a tool result
 * or a message, so quota never enters the model's context.
 *
 * This file only wires pi's events to the monitor (`src/monitor.ts`).
 */
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../src/auth.ts";
import { loadConfig, quotaPaths } from "../src/core/store.ts";
import type { Tone } from "../src/format.ts";
import { messages } from "../src/i18n.ts";
import { completeArguments, createMonitor, defaultFetchers, type MonitorUi } from "../src/monitor.ts";

const TONE_COLORS: Readonly<Record<Tone, ThemeColor>> = {
  normal: "muted",
  warning: "warning",
  low: "error",
  error: "error",
};

function monitorUi(ctx: ExtensionContext): MonitorUi {
  return {
    notify: (message, level) => ctx.ui.notify(message, level),
    setWidget: (key, lines) => ctx.ui.setWidget(key, lines),
    paint: (tone, text) => ctx.ui.theme.fg(TONE_COLORS[tone], text),
    select: (title, options) => ctx.ui.select(title, options),
  };
}

export default function piQuota(pi: ExtensionAPI): void {
  // Subagent children never show quota (opencode-quota skips child sessions too).
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const agentDir = resolveAgentDir();
  const paths = quotaPaths(agentDir);
  const monitor = createMonitor({
    fetchers: defaultFetchers(() => ({ env: process.env, agentDir })),
    paths,
    // `--offline` sets PI_OFFLINE: then quota is checked only when asked with /quota.
    automatic: process.env.PI_OFFLINE === undefined,
  });

  // Timers and requests start with the session, never in the factory (pi may load it without one).
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) monitor.start(monitorUi(ctx));
  });
  // pi awaits turn_end handlers before the next turn: start the check, never wait for it.
  pi.on("turn_end", (_event, ctx) => {
    if (ctx.hasUI) monitor.onTurnEnd(monitorUi(ctx));
  });
  pi.on("session_shutdown", () => {
    monitor.stop();
  });

  pi.registerCommand("quota", {
    // Read once at load (the `/` menu keeps it); a language change shows here after /reload.
    description: messages(loadConfig(paths.config).language).commandDescription,
    // Asked on every keystroke: the descriptions follow the language as it is now.
    getArgumentCompletions: (prefix) =>
      completeArguments(prefix, monitor.locale())?.map(({ value, description }) => ({
        value,
        label: value,
        description,
      })) ?? null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      await monitor.command(args, monitorUi(ctx));
    },
  });
}
