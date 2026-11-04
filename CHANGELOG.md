# Changelog

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
