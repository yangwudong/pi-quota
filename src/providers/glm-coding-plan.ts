/**
 * Zhipu GLM Coding Plan (China), pi provider `zai-coding-cn`. Port of opencode-quota
 * `providers/glm-coding-plan.ts`, Zhipu endpoint only.
 *
 * Reply envelope: `{ code, msg, success, data: { level, limits: [...] } }`. Each limit has a
 * `type` (TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT), a `unit` (3 = the 5-hour window, 6 = the
 * week, for the first two types), `percentage` used and `nextResetTime` in ms. TIME_LIMIT is the
 * monthly MCP allowance.
 *
 * Deviations from the original, each because of what bigmodel.cn really does:
 * - The `success:false` / `code >= 400` check runs for Zhipu too (the original kept it to the Z.ai
 *   envelope): a wrong or missing key gets HTTP 200 with `{"code":1000,"success":false}`, which
 *   the original showed as "Invalid quota data".
 * - `Authorization: Bearer <key>` as the task asks (the original sends the bare key; bigmodel.cn
 *   accepts both).
 * - MCP rows keep `used`/`limit` (currentValue/usage) for the report; display only.
 */
import { safeText } from "../core/redact.ts";
import type { ProviderResult, QuotaError, QuotaRow, QuotaWindow } from "../core/types.ts";
import { type FetchLike, type RequestFailure, requestJson } from "../http.ts";

export const GLM_QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const API = "Zhipu API";

type GlmEnvelope = {
  code?: unknown;
  msg?: unknown;
  success?: unknown;
  data?: { limits?: unknown; level?: unknown } | null;
};

/** One entry of the reply's `limits`: unit 3 is the 5h window, unit 6 the week. */
type GlmLimit = {
  type: string;
  unit: number;
  usage: number;
  currentValue?: number;
  percentage: number;
  nextResetTime?: number;
};

type GlmWindow = { percentRemaining: number; resetTimeIso?: string; used?: number; limit?: number };

/** API codes of a 200 reply that mean the key is missing, wrong or expired. */
const AUTH_CODES = new Set([1000, 1001, 1002, 1003, 1004]);
/** API code for "request rate limit reached". */
const RATE_CODE = 1302;

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The percent left: from exact credit values when a credit limit has them, else reported. A
 * `percentage` that is not a finite number throws, so the whole reply fails as bad data rather
 * than showing a made-up 0% (or 100%) left.
 */
function percentRemaining(limit: GlmLimit): number {
  if (typeof limit.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    throw new Error("Invalid quota data: a limit's percentage is not a number");
  }
  const reported = clampPercent(100 - limit.percentage);
  if (
    limit.type === "CREDIT_LIMIT" &&
    typeof limit.usage === "number" &&
    Number.isFinite(limit.usage) &&
    limit.usage > 0 &&
    typeof limit.currentValue === "number" &&
    Number.isFinite(limit.currentValue) &&
    limit.currentValue >= 0
  ) {
    return clampPercent(((limit.usage - limit.currentValue) / limit.usage) * 100);
  }
  return reported;
}

/** The 5h, weekly and MCP rows of the reply's limits; a later limit of a window wins. Throws on bad data. */
function glmRows(limits: GlmLimit[]): QuotaRow[] {
  const windows: Partial<Record<QuotaWindow, GlmWindow>> = {};
  for (const limit of limits) {
    if (!limit || typeof limit !== "object") throw new Error("Invalid quota data: a limit is not an object");
    const resetDate = limit.nextResetTime ? new Date(Math.round(limit.nextResetTime)) : null;
    const resetTimeIso =
      resetDate && Number.isFinite(resetDate.valueOf()) && resetDate.valueOf() > 0
        ? resetDate.toISOString()
        : undefined;
    const window: GlmWindow = { percentRemaining: percentRemaining(limit), resetTimeIso };

    const isQuotaWindow = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
    if (isQuotaWindow && limit.unit === 3) windows["five-hour"] = window;
    else if (isQuotaWindow && limit.unit === 6) windows.weekly = window;
    else if (limit.type === "TIME_LIMIT") {
      const used = finite(limit.currentValue);
      const total = finite(limit.usage);
      windows["mcp-monthly"] = used !== undefined && total !== undefined ? { ...window, used, limit: total } : window;
    }
  }
  const order: QuotaWindow[] = ["five-hour", "weekly", "mcp-monthly"];
  return order.flatMap((name): QuotaRow[] => {
    const value = windows[name];
    if (!value) return [];
    return [
      {
        provider: "zai-coding-cn",
        window: name,
        percentRemaining: value.percentRemaining,
        ...(value.resetTimeIso ? { resetsAt: value.resetTimeIso } : {}),
        ...(value.used !== undefined ? { used: value.used } : {}),
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
      },
    ];
  });
}

function apiError(code: number | undefined, message: string): QuotaError {
  const kind = code === undefined ? "api" : AUTH_CODES.has(code) ? "auth" : code === RATE_CODE ? "rate_limited" : "api";
  const head = code === undefined ? `${API} error` : `${API} error ${code}`;
  return { kind, message: message ? `${head}: ${message}` : head, ...(code !== undefined ? { status: code } : {}) };
}

/**
 * A parsed reply as rows, or its error: an envelope with `success:false` or an error code, or
 * `limits` that are not a list. Pure; `secrets` are redacted from any provider text.
 */
export function parseGlmCodingPlan(body: unknown, secrets: readonly string[] = []): ProviderResult {
  try {
    if (!body || typeof body !== "object") {
      return { ok: false, error: { kind: "bad_data", message: "Invalid quota data" } };
    }
    const envelope = body as GlmEnvelope;
    if (envelope.success === false || (typeof envelope.code === "number" && envelope.code >= 400)) {
      const message = typeof envelope.msg === "string" ? safeText(envelope.msg, secrets, 120) : "";
      return { ok: false, error: apiError(finite(envelope.code), message) };
    }
    const limits = envelope.data?.limits;
    if (!Array.isArray(limits)) {
      return { ok: false, error: { kind: "bad_data", message: "Invalid quota data" } };
    }
    const level = typeof envelope.data?.level === "string" ? safeText(envelope.data.level, secrets, 32) : "";
    return { ok: true, rows: glmRows(limits as GlmLimit[]), ...(level ? { plan: level } : {}) };
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : String(error), secrets);
    return { ok: false, error: { kind: "bad_data", message } };
  }
}

/** A failed request as an error: HTTP status with the reply's first words, timeout, network. */
function requestError(failure: RequestFailure): QuotaError {
  if (failure.kind === "timeout") return { kind: "timeout", message: `${API}: ${failure.detail}` };
  if (failure.kind === "network") return { kind: "network", message: `${API}: ${failure.detail}` };
  if (failure.kind === "invalid_json") return { kind: "bad_data", message: `${API} returned malformed JSON` };
  const status = failure.status ?? 0;
  const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : "http";
  const words = failure.detail ? `: ${failure.detail}` : "";
  return { kind, status, message: `${API} error ${status}${words}` };
}

export async function fetchGlmCodingPlan(options: {
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<ProviderResult> {
  const { apiKey } = options;
  const reply = await requestJson(GLM_QUOTA_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "pi-quota",
    },
    secrets: [apiKey],
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  if (!reply.ok) return { ok: false, error: requestError(reply.failure) };
  return parseGlmCodingPlan(reply.json, [apiKey]);
}
