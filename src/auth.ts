/**
 * Credentials for the two quota APIs, read fresh on every check so a new /login applies at once.
 *
 * - Zhipu: env `ZAI_CODING_CN_API_KEY`, else pi's `auth.json` entry `zai-coding-cn` (an API key).
 * - Copilot: only pi's `auth.json` entry `github-copilot` from `/login github-copilot`. pi keeps the
 *   GitHub OAuth token (`ghu_…`) in `refresh` and the short-lived Copilot inference token (`tid=…`)
 *   in `access`; the quota endpoint takes only the OAuth token. No env or API-key substitute.
 *
 * A secret never goes into an error message; callers pass it to the request as a redaction secret.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, type JsonObject, type JsonValue, jsonText as text, parseJson } from "./core/json.ts";
import type { ErrorHint, QuotaError } from "./core/types.ts";

export const ZHIPU_KEY_ENV = "ZAI_CODING_CN_API_KEY";
export const ZHIPU_AUTH_ID = "zai-coding-cn";
export const COPILOT_AUTH_ID = "github-copilot";

export type AuthSources = {
  env: Readonly<Record<string, string | undefined>>;
  /** pi's agent dir, home of `auth.json`. */
  agentDir: string;
  /** Injected in tests. */
  readFile?: (path: string) => string;
};

export type Credential =
  | { ok: true; secret: string; source: "env" | "auth.json" }
  | { ok: false; error: QuotaError };

/** pi's agent dir: `PI_CODING_AGENT_DIR`, else `~/.pi/agent` (as pi resolves it). */
export function resolveAgentDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? override : join(homedir(), ".pi", "agent");
}

/** One provider's entry of `auth.json`; undefined when the file or the entry is missing or bad. */
function readAuthEntry(sources: AuthSources, providerId: string): JsonObject | undefined {
  const read = sources.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let data: ReturnType<typeof parseJson>;
  try {
    data = parseJson(read(join(sources.agentDir, "auth.json")));
  } catch {
    return undefined;
  }
  if (!isJsonObject(data)) return undefined;
  const entry = data[providerId];
  return isJsonObject(entry) ? entry : undefined;
}

/** A credential that exists but cannot be used; `hint` says what to do, in the user's language. */
function authError(hint: ErrorHint): Credential {
  return { ok: false, error: { kind: "auth", message: "", hint } };
}

/** No credential at all: the provider is not in use, so it stays out of sight (see QuotaErrorKind). */
function notConfigured(hint: ErrorHint): Credential {
  return { ok: false, error: { kind: "not_configured", message: "", hint } };
}

export function resolveZhipuKey(sources: AuthSources): Credential {
  const fromEnv = text(sources.env[ZHIPU_KEY_ENV]);
  if (fromEnv) return { ok: true, secret: fromEnv, source: "env" };

  const entry = readAuthEntry(sources, ZHIPU_AUTH_ID);
  const key = entry?.type === "api_key" ? text(entry.key) : "";
  // pi runs a "!command" key itself; pi-quota does not run shell commands from auth.json.
  if (key.startsWith("!")) return authError("zhipu_command_key");
  if (key) return { ok: true, secret: key, source: "auth.json" };
  return notConfigured("zhipu_setup");
}

/** True for a GitHub Enterprise host; personal github.com is the only supported deployment. */
function isEnterpriseHost(value: JsonValue | undefined): boolean {
  const host = text(value);
  if (!host) return false;
  try {
    return new URL(host.includes("://") ? host : `https://${host}`).hostname.toLowerCase() !== "github.com";
  } catch {
    return true;
  }
}

export function resolveCopilotToken(sources: AuthSources): Credential {
  const entry = readAuthEntry(sources, COPILOT_AUTH_ID);
  if (!entry) return notConfigured("copilot_login");
  if (entry.type !== "oauth") return authError("copilot_not_oauth");
  if (isEnterpriseHost(entry.enterpriseUrl)) return authError("copilot_enterprise");
  const token = text(entry.refresh);
  if (!token) return authError("copilot_no_token");
  return { ok: true, secret: token, source: "auth.json" };
}
