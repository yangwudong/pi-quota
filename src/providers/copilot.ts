/**
 * GitHub Copilot, pi provider `github-copilot`: the personal subscription through the OAuth token
 * of `/login github-copilot`, read from `GET https://api.github.com/copilot_internal/user`.
 *
 * Port of opencode-quota `lib/copilot.ts` `parseCopilotInternalUser` / `queryCopilotOAuthQuota`
 * and `providers/copilot.ts` `personalRow`. Dropped on purpose: the PAT config and its billing
 * reports (AI Credit / legacy premium-request usage, budgets), GHE.com hosts, organization and
 * enterprise billing, several logins.
 *
 * The numbers follow the original exactly: unlimited; a remaining within the entitlement (with the
 * reported percent, else one derived when none was reported, never one replacing an invalid one);
 * token-based billing over the entitlement (negative remaining, with `credits_used`); plan-only;
 * anything else is an error. One deviation: the unit name comes from `token_based_billing`
 * (true → "AI credits", the new billing; false → legacy "premium requests"), where the original
 * says neutral "Premium interactions" unless it is over the limit. It never calls credits PRUs.
 */
import { safeText } from "../core/redact.ts";
import type { ProviderResult, QuotaError } from "../core/types.ts";
import { type FetchLike, type RequestFailure, requestJson } from "../http.ts";

export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const API = "GitHub Copilot API";

type PremiumSnapshot = {
  entitlement?: unknown;
  remaining?: unknown;
  quota_remaining?: unknown;
  percent_remaining?: unknown;
  credits_used?: unknown;
  unlimited?: unknown;
  token_based_billing?: unknown;
};

type CopilotInternalUserResponse = {
  copilot_plan?: unknown;
  quota_reset_date_utc?: unknown;
  quota_reset_date?: unknown;
  token_based_billing?: unknown;
  quota_snapshots?: { premium_interactions?: PremiumSnapshot | null } | null;
};

/** `ai_credits`: token-based billing (AI Credits); `premium_requests`: legacy request billing. */
export type CopilotUnit = "ai_credits" | "premium_requests";

export const COPILOT_UNIT_LABELS: Readonly<Record<CopilotUnit, string>> = {
  ai_credits: "AI credits",
  premium_requests: "premium requests",
};

export type CopilotQuota =
  | {
      mode: "quota";
      unit: CopilotUnit;
      used: number;
      total: number;
      /** Undefined when the reported percent was invalid (dropped, not replaced). */
      percentRemaining?: number;
      authority: "provider_reported" | "locally_derived";
      plan?: string;
      resetTimeIso?: string;
    }
  | { mode: "unlimited"; unit: CopilotUnit; plan?: string; resetTimeIso?: string }
  | { mode: "plan_only"; plan?: string; resetTimeIso?: string };

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeResetTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** The quota of a `copilot_internal/user` reply; throws when it holds no usable snapshot. Pure. */
export function parseCopilotInternalUser(response: CopilotInternalUserResponse): CopilotQuota {
  const plan =
    typeof response.copilot_plan === "string"
      ? safeText(response.copilot_plan, [], 64) || undefined
      : undefined;
  const resetTimeIso = normalizeResetTime(response.quota_reset_date_utc ?? response.quota_reset_date);
  const snapshot = response.quota_snapshots?.premium_interactions ?? undefined;
  const tokenBasedBilling =
    response.token_based_billing === true || snapshot?.token_based_billing === true;
  const unit: CopilotUnit = tokenBasedBilling ? "ai_credits" : "premium_requests";

  if (snapshot?.unlimited === true) return { mode: "unlimited", unit, plan, resetTimeIso };

  const entitlement = finite(snapshot?.entitlement);
  const remaining = finite(snapshot?.quota_remaining ?? snapshot?.remaining);
  const reportedPercent = finite(snapshot?.percent_remaining);
  const validReportedPercent =
    reportedPercent !== undefined && reportedPercent >= 0 && reportedPercent <= 100
      ? reportedPercent
      : undefined;

  if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    if (remaining >= 0 && remaining <= entitlement) {
      return {
        mode: "quota",
        unit,
        used: entitlement - remaining,
        total: entitlement,
        // An invalid reported percentage is dropped, not replaced by a derived one.
        percentRemaining:
          validReportedPercent ??
          (snapshot?.percent_remaining === undefined
            ? Math.min(100, Math.max(0, (remaining / entitlement) * 100))
            : undefined),
        authority: "locally_derived",
        plan,
        resetTimeIso,
      };
    }
    // Token-based billing reports a negative remaining once usage goes over the entitlement,
    // alongside a provider-reported clamp in [0, 100].
    if (tokenBasedBilling && remaining < 0 && validReportedPercent !== undefined) {
      const creditsUsed = finite(snapshot?.credits_used);
      const hasCreditsUsed = creditsUsed !== undefined && creditsUsed >= 0;
      return {
        mode: "quota",
        unit,
        used: hasCreditsUsed ? creditsUsed : entitlement - remaining,
        total: entitlement,
        percentRemaining: validReportedPercent,
        authority: hasCreditsUsed ? "provider_reported" : "locally_derived",
        plan,
        resetTimeIso,
      };
    }
  }
  // Token-based billing without usable numbers (e.g. an all-zero placeholder) is plan-only.
  if (tokenBasedBilling) return { mode: "plan_only", plan, resetTimeIso };
  throw new Error("GitHub Copilot user response did not include a usable quota snapshot");
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** The quota as this extension's result: one row with a percent, else a note. */
export function copilotResult(quota: CopilotQuota): ProviderResult {
  const plan = quota.plan ? { plan: quota.plan } : {};
  if (quota.mode === "plan_only") return { ok: true, rows: [], note: "仅有套餐信息，无用量数据", ...plan };
  const label = COPILOT_UNIT_LABELS[quota.unit];
  if (quota.mode === "unlimited") return { ok: true, rows: [], note: `${label} 不限量`, ...plan };
  if (quota.percentRemaining === undefined) {
    return { ok: true, rows: [], note: `已用 ${COUNT.format(quota.used)} ${label}（无剩余百分比）`, ...plan };
  }
  return {
    ok: true,
    rows: [
      {
        provider: "github-copilot",
        window: undefined,
        percentRemaining: quota.percentRemaining,
        ...(quota.resetTimeIso ? { resetsAt: quota.resetTimeIso } : {}),
        label,
        used: quota.used,
        limit: quota.total,
      },
    ],
    ...plan,
  };
}

/** GitHub's JSON error message (and its documentation link), else a bounded plain-text snippet. */
function gitHubErrorMessage(body: string, secrets: readonly string[]): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const documentationUrl = typeof parsed.documentation_url === "string" ? parsed.documentation_url : null;
    if (message) return safeText(documentationUrl ? `${message} (${documentationUrl})` : message, secrets);
  } catch {
    // Fall through to a bounded plain-text snippet.
  }
  return safeText(body, secrets);
}

function requestError(failure: RequestFailure, secrets: readonly string[]): QuotaError {
  if (failure.kind === "timeout") return { kind: "timeout", message: `${API}: ${failure.detail}` };
  if (failure.kind === "network") return { kind: "network", message: `${API}: ${failure.detail}` };
  if (failure.kind === "invalid_json") return { kind: "bad_data", message: `${API} returned malformed JSON` };
  const status = failure.status ?? 0;
  const words = gitHubErrorMessage(failure.body ?? "", secrets);
  const head = `${API} error ${status}${words ? `: ${words}` : ""}`;
  if (status === 401) {
    // An expired or revoked OAuth login: pi-quota does not refresh tokens itself.
    return { kind: "auth", status, message: `${head} — 请在 pi 中重新 /login github-copilot` };
  }
  if (status === 429 || (status === 403 && failure.headers?.get("x-ratelimit-remaining") === "0")) {
    return { kind: "rate_limited", status, message: `${head} (GitHub API rate limit exhausted)` };
  }
  return { kind: status === 403 ? "auth" : "http", status, message: head };
}

export async function fetchCopilotQuota(options: {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<ProviderResult> {
  const { token } = options;
  const secrets = [token];
  const reply = await requestJson(COPILOT_USER_URL, {
    // The original's request, with the Bearer scheme (GitHub accepts it as it does "token").
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-GitHub-Api-Version": "2025-04-01",
    },
    secrets,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  if (!reply.ok) return { ok: false, error: requestError(reply.failure, secrets) };
  if (!reply.json || typeof reply.json !== "object") {
    return { ok: false, error: { kind: "bad_data", message: `${API} returned malformed JSON` } };
  }
  try {
    return copilotResult(parseCopilotInternalUser(reply.json as CopilotInternalUserResponse));
  } catch (error) {
    return {
      ok: false,
      error: { kind: "bad_data", message: safeText(error instanceof Error ? error.message : String(error), secrets) },
    };
  }
}
