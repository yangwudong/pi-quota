# Changelog

## [0.3.0] - 2026-11-04

- **The quota panel floats at the top right** by default, over the chat: it takes no rows and
  no keyboard input, so the chat and the editor keep their place. When the terminal is too narrow
  to keep 40 columns of chat beside it (or too short), and in pi's regular TUI mode, it goes back
  above the editor. `/quota config` → *Quota panel* cycles floating / above the editor / hidden;
  the choice is saved as `placement` in `~/.pi/agent/pi-quota/config.json`. To keep the 0.2
  layout, pick "above the editor" once.
- Provider names (`Zhipu`, `Copilot`) are blue, `#008AFA` (the nearest 256 color in terminals
  without truecolor).

## [0.2.0] - 2026-11-04

- **English by default**, Simplified Chinese on request: everything pi-quota shows (panel,
  warnings, "Quota available", `/quota` report, command replies) follows `language` in
  `~/.pi/agent/pi-quota/config.json`. To keep the 0.1.x Chinese text, run `/quota lang zh` once.
- `/quota config`: a settings menu for the language, the quota panel and the alerts of each
  window; each pick applies at once.
- `/quota lang [en|zh]`: sets the language, or offers a picker without an argument.
- Typing `/quota ` lists every argument with a description, in the chosen language.
- The reset countdown is marked with `⏳` and a space: `⏳ 3h12m` (was `↻3h12m`).

## [0.1.1] - 2026-11-04

- Published from GitHub Actions through npm Trusted Publishing, so this and later versions
  carry a signed provenance attestation linking the package to its source commit.
- No functional changes.

## [0.1.0] - 2026-11-03

- Initial release: port of opencode-quota's Zhipu GLM Coding Plan (CN, `zai-coding-cn`) and
  GitHub Copilot (personal OAuth) quota providers to pi 1.5.0.
- Resident widget above the editor: 5-hour, weekly and monthly MCP windows plus Copilot AI
  credits, as 10-cell bars with percent left, a compact reset countdown and a `⚠ 快于正常` mark
  when the window is used faster than even use.
- Passive monitoring on session start, every turn end and a 60 s timer (successful answers are
  cached for 60 s, requests time out after 8 s). A 5-hour or weekly window under 20% warns once
  per window, with the run-out time at the current pace; a window that was low and is back at
  50% or more says "Quota available".
- `/quota` (full report with pace analysis), `/quota status`, `/quota refresh`,
  `/quota mute|unmute <five-hour|weekly>`, `/quota hide|show`. Settings persist in
  `~/.pi/agent/pi-quota/config.json`.
- Providers without credentials stay out of sight; quota data never enters the model's context;
  keys and tokens are redacted from every message.
