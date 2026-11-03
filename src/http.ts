/**
 * HTTP for the two quota APIs: `requestJson` asks for one JSON reply within a deadline that covers
 * the whole transaction (headers and body), and says why it got none, with the caller's secrets
 * redacted. Never throws. Simplified from opencode-quota `lib/http.ts` (no size cap, no
 * Retry-After: the extension retries on the next turn anyway).
 */
import { safeErrorText, safeText } from "./core/redact.ts";

/** Request deadline: the whole request, body included. */
export const REQUEST_TIMEOUT_MS = 8_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Why a request gave no JSON. `http`: a non-2xx reply; `timeout`: the deadline passed; `network`:
 * no reply at all; `invalid_json`: a 2xx reply that is not JSON. `detail` is safe to show.
 */
export type RequestFailure = {
  kind: "http" | "timeout" | "network" | "invalid_json";
  status?: number;
  headers?: Headers;
  detail: string;
  /** For `http`: the raw reply body, for the provider to parse; never shown as is. */
  body?: string;
};

export type JsonReply =
  | { ok: true; status: number; json: unknown }
  | { ok: false; failure: RequestFailure };

export type RequestOptions = {
  headers: Record<string, string>;
  /** Values never shown in `detail`: the key or token the request carries. */
  secrets: readonly string[];
  timeoutMs?: number;
  fetch?: FetchLike;
};

/** A thrown fetch error with its cause code: "fetch failed (ENOTFOUND)". */
function networkText(error: unknown, secrets: readonly string[]): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? ` (${(cause as { code: string }).code})`
      : "";
  return `${safeErrorText(error, secrets)}${safeText(code, secrets)}`;
}

/** GET one JSON reply; the deadline aborts the request and wins even over a fetch that ignores it. */
export async function requestJson(url: string, options: RequestOptions): Promise<JsonReply> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const { secrets } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const timedOut: JsonReply = {
    ok: false,
    failure: { kind: "timeout", detail: `Request timeout after ${Math.round(timeoutMs / 1000)}s` },
  };

  const transaction = (async (): Promise<JsonReply> => {
    const response = await fetchFn(url, {
      method: "GET",
      headers: options.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          kind: "http",
          status: response.status,
          headers: response.headers,
          detail: safeText(text, secrets, 120),
          body: text,
        },
      };
    }
    try {
      return { ok: true, status: response.status, json: JSON.parse(text) as unknown };
    } catch (error) {
      return {
        ok: false,
        failure: { kind: "invalid_json", status: response.status, detail: safeErrorText(error, secrets) },
      };
    }
  })();

  try {
    const winner = await Promise.race([transaction, deadline]);
    return winner === "timeout" ? timedOut : winner;
  } catch (error) {
    if (controller.signal.aborted) return timedOut;
    return { ok: false, failure: { kind: "network", detail: networkText(error, secrets) } };
  } finally {
    clearTimeout(timer);
  }
}
