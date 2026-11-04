/**
 * The quota data model: a trimmed port of opencode-quota's `core/types.ts` QuotaRow (only the
 * fields two providers need), plus the provider result and the error vocabulary. Every value is
 * plain JSON.
 */

/** The providers this extension watches, by their pi provider id. */
export type ProviderId = "zai-coding-cn" | "github-copilot";

/** The period a quota row covers; drives labels, pace and alerts. */
export type QuotaWindow = "five-hour" | "weekly" | "mcp-monthly";

export type QuotaRow = {
  provider: ProviderId;
  /** undefined for a row without a known window: Copilot's monthly allowance. */
  window: QuotaWindow | undefined;
  /** Percent left, 0-100. */
  percentRemaining: number;
  /** ISO time the window resets. */
  resetsAt?: string;
  /** ISO time the window started, when the API says so (pace uses it over the window length). */
  windowStartedAt?: string;
  /** Display only (the original row's label / used / limit): "AI credits", 2404, 25000. */
  label?: string;
  used?: number;
  limit?: number;
};

/**
 * Why a provider has no rows. `not_configured`: no credential at all, so the provider is left out
 * of the widget and the status line (someone who uses only one of the two sees only that one).
 * `auth`: a credential that cannot be used or that the API rejects (HTTP 401/403, GLM codes
 * 1000-1004, an unsupported login); the widget shows it as "✗ auth".
 */
export type QuotaErrorKind =
  | "not_configured"
  | "auth"
  | "timeout"
  | "network"
  | "http"
  | "rate_limited"
  | "api"
  | "bad_data"
  | "internal";

/**
 * What the user can do about an error, as a code: the text is rendered in the user's language at
 * display time (src/i18n.ts), so a language switch needs no new request.
 */
export type ErrorHint =
  | "zhipu_setup"
  | "zhipu_command_key"
  | "copilot_login"
  | "copilot_not_oauth"
  | "copilot_enterprise"
  | "copilot_no_token"
  | "copilot_relogin";

export type QuotaError = {
  kind: QuotaErrorKind;
  /**
   * Provider text, one line, control characters removed and credentials redacted, for example
   * "Zhipu API error 1000: 身份验证失败。" (the API's own words); "" when the hint says it all.
   */
  message: string;
  hint?: ErrorHint;
  /** The HTTP status, or the API's own error code. */
  status?: number;
};

/** Why a provider answered without a percent to show (rendered in the user's language). */
export type ProviderNote =
  | { kind: "plan_only" }
  | { kind: "unlimited"; label: string }
  | { kind: "used_only"; used: number; label: string };

/** One provider's answer: its rows (maybe none, with a note), or the error shown instead. */
export type ProviderResult =
  | { ok: true; rows: QuotaRow[]; plan?: string; note?: ProviderNote }
  | { ok: false; error: QuotaError };

/** A provider's answer as the store keeps it. */
export type ProviderReport = ProviderResult & { provider: ProviderId; checkedAtMs: number };
