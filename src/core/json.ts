/**
 * The decode boundary for JSON this extension reads from disk (`auth.json`, its own settings and
 * alert state): text in, a `JsonValue` out, and a guard to narrow to an object. Everything past
 * this point branches on decoded values, never on raw `unknown`.
 */

/** A decoded JSON document: what `JSON.parse` can give. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** `text` decoded as JSON (a leading BOM allowed); undefined when it is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, "")) as JsonValue;
  } catch {
    return undefined;
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A decoded string, trimmed; "" for anything else. */
export function jsonText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
