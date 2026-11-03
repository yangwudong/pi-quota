/**
 * Credential redaction for every provider text this extension shows: HTTP error bodies, API
 * messages and thrown errors. Provider errors can echo a request (an Authorization header, a key
 * in a JSON body), so each such text passes here before it is cut to length and shown.
 *
 * Port of the ideas of opencode-quota `core/redact.ts`: the caller's own secrets are replaced
 * wherever they appear; then header values, auth-scheme credentials, secret-named values, known
 * key formats and long opaque runs. Dropped: the public-issue filters (home dir, emails, account
 * ids) and the agent-tool key-shape checks, which this extension has no use for.
 */

export const REDACTED = "[redacted]";

/** Terminal escape sequences (CSI/OSC/DCS/APC/PM/SOS) and other control characters. */
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x1B\u0007]*(?:\u0007|\x1B\\)|P[\s\S]*?\x1B\\|_[\s\S]*?\x1B\\|\^[\s\S]*?\x1B\\|X[\s\S]*?\x1B\\|[@-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Provider text as one plain line: no terminal controls, whitespace collapsed. */
export function singleLine(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "").replace(/\s+/gu, " ").trim();
}

/** Words that make a field name secret wherever they stand in it: "access_token", "apiKey". */
const SECRET_WORDS = new Set([
  "token",
  "key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "cookie",
  "session",
  "sessionid",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "sig",
  "jwt",
  "bearer",
]);

/** Last words of a name that make it a fact about a secret, not the secret: "key_source". */
const FACT_WORDS = new Set([
  "source",
  "env",
  "present",
  "configured",
  "set",
  "kind",
  "type",
  "status",
  "expires",
  "expiry",
  "age",
  "state",
  "path",
  "file",
  "name",
  "count",
]);

/** A field name's words, split on anything but letters and digits and on camelCase. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** True when a name holds a secret: a secret word in it, and its last word is not a fact word. */
function holdsSecret(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1) === "at" ? words.at(-2) : words.at(-1);
  return words.some((word) => SECRET_WORDS.has(word)) && !FACT_WORDS.has(last ?? "");
}

/** A field value: quoted to its closing quote (escapes included), or one unquoted word. */
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s"'&,;}]+)`;
/** `name: value`, `name=value`, `"name":"value"`. */
const NAMED_VALUE = new RegExp(String.raw`\b([A-Za-z_][\w-]{0,63})(["']?\s*[:=]\s*)${VALUE}`, "gu");

/** The value of every pair whose name holds a secret; other values are searched as well. */
function redactNamedValues(text: string): string {
  const pattern = new RegExp(NAMED_VALUE.source, "gu");
  let result = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, name = "", separator = ""] = match;
    const valueAt = match.index + name.length + separator.length;
    if (holdsSecret(name)) {
      result += `${text.slice(copied, valueAt)}${REDACTED}`;
      copied = match.index + whole.length;
    } else {
      // The value may hold pairs of its own: {"error":"bad api_key=abc"}.
      pattern.lastIndex = valueAt;
    }
  }
  return result + text.slice(copied);
}

/** Cookie and Authorization header values, to the end of the line. */
const HEADER_VALUE = /\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*[:=]\s*)[^\r\n]*/giu;
/** A credential after an auth scheme, outside a header too: "Bearer abc". */
const SCHEME_CREDENTIAL = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu;

/** Known key formats, found anywhere in a text; each is replaced whole. */
const KEY_FORMATS: readonly RegExp[] = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/gu, // GitHub (ghu_ is Copilot's OAuth token)
  /\btid=[A-Za-z0-9;:=._~+/-]{10,}/gu, // Copilot inference token
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/gu, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/gu, // OpenAI-style keys
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}\b/gu, // Zhipu API key: <id>.<secret>
];

/** One part of a name or model id: a word, a number, or up to 4 letters and digits. */
const NAME_PART =
  /^(?:[a-z]{1,20}|[A-Z]{1,20}\d{0,4}|(?:[A-Z]{1,6}|[A-Z]?[a-z]{2,20}){1,3}\d{0,4}|\d{1,14}|[A-Za-z0-9]{1,4})$/u;

/** A long run of letters, digits, `_` and `-` is a token unless it is words joined by separators. */
function hideOpaqueRun(run: string): string {
  const parts = run.split(/[-_]+/u).filter(Boolean);
  const wordsOnly = parts.length >= 2 && parts.every((part) => NAME_PART.test(part));
  return wordsOnly ? run : REDACTED;
}

/** `text` with credential-looking parts replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  let result = text
    .replace(HEADER_VALUE, `$1$2${REDACTED}`)
    .replace(SCHEME_CREDENTIAL, `$1 ${REDACTED}`);
  result = redactNamedValues(result);
  for (const pattern of KEY_FORMATS) result = result.replace(pattern, REDACTED);
  return result.replace(/[A-Za-z0-9_-]{32,}/gu, hideOpaqueRun);
}

/** Secrets this long are replaced anywhere; shorter ones only as a whole token, so no word is cut. */
const LONG_SECRET_LENGTH = 8;

/** Replaces each of `secrets` (longest first, so a secret holding another goes whole). */
export function replaceSecretValues(text: string, secrets: readonly string[]): string {
  const sorted = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return sorted.reduce((result, secret) => {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const pattern =
      secret.length < LONG_SECRET_LENGTH ? `(?<![\\w-])${escaped}(?![\\w-])` : escaped;
    return result.replace(new RegExp(pattern, "g"), REDACTED);
  }, text);
}

/**
 * One safe line of provider text: controls removed, the caller's secrets and every credential
 * shape redacted, then cut to `maxLength` (last, so a cut never leaves part of a hidden value).
 */
export function safeText(text: string, secrets: readonly string[] = [], maxLength = 160): string {
  return redactSecrets(replaceSecretValues(singleLine(text), secrets)).slice(0, maxLength);
}

/** An error's message (or any thrown value) as one safe line. */
export function safeErrorText(error: unknown, secrets: readonly string[] = []): string {
  return safeText(error instanceof Error ? error.message : String(error), secrets);
}
