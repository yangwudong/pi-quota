/**
 * The store: the 60-second cache of provider answers, the user's settings (widget shown or hidden,
 * muted windows, thresholds) and the alert state, the last two saved under
 * `<agent-dir>/pi-quota/`. A simplification of opencode-quota `core/store.ts` + `core/persist.ts`:
 *
 * - A successful answer is reused for 60 s; a failure is not kept, so the next check asks again.
 * - Checks of one provider are single-flight: a second caller waits for the request in flight.
 * - Providers are asked in parallel (`Promise.allSettled`); one failing never hides the other.
 * - Files are written whole through a temp file and a rename, so a reader never sees half a file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n.ts";
import { DEFAULT_PLACEMENT, isPlacement, type PanelPlacement } from "../layout.ts";
import type { AlertState, WindowAlertState } from "./alerts.ts";
import { isJsonObject, type JsonObject, type JsonValue, parseJson } from "./json.ts";
import { safeErrorText } from "./redact.ts";
import type { ProviderId, ProviderReport, ProviderResult } from "./types.ts";
import { type AlertWindow, isAlertWindow } from "./windows.ts";

export const CACHE_TTL_MS = 60_000;

/** Asks one provider; never expected to throw (a throw still becomes an error report). */
export type ProviderFetcher = () => Promise<ProviderResult>;

export class QuotaCache {
  readonly #fetchers: ReadonlyMap<ProviderId, ProviderFetcher>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #fresh = new Map<ProviderId, ProviderReport>();
  readonly #inflight = new Map<ProviderId, Promise<ProviderReport>>();

  constructor(
    fetchers: ReadonlyArray<readonly [ProviderId, ProviderFetcher]>,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.#fetchers = new Map(fetchers);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  }

  /** The providers in the order they show. */
  get providers(): ProviderId[] {
    return [...this.#fetchers.keys()];
  }

  /** Forgets every cached answer (`/quota refresh`). */
  clear(): void {
    this.#fresh.clear();
  }

  /** One provider's answer: cached when fresh, else a new request (shared with a caller in flight). */
  async get(provider: ProviderId, { force = false }: { force?: boolean } = {}): Promise<ProviderReport> {
    const cached = this.#fresh.get(provider);
    if (!force && cached && this.#now() - cached.checkedAtMs < this.#ttlMs) return cached;
    const running = this.#inflight.get(provider);
    if (running) return running;

    const fetcher = this.#fetchers.get(provider);
    const request = (async (): Promise<ProviderReport> => {
      let result: ProviderResult;
      try {
        result = fetcher
          ? await fetcher()
          : { ok: false, error: { kind: "internal", message: `unknown provider ${provider}` } };
      } catch (error) {
        result = { ok: false, error: { kind: "internal", message: safeErrorText(error) } };
      }
      const report: ProviderReport = { ...result, provider, checkedAtMs: this.#now() };
      if (report.ok) this.#fresh.set(provider, report);
      else this.#fresh.delete(provider);
      return report;
    })();
    this.#inflight.set(provider, request);
    try {
      return await request;
    } finally {
      this.#inflight.delete(provider);
    }
  }

  /** Every provider's answer, asked in parallel; `onReport` hears each one as soon as it arrives. */
  async getAll(
    options: { force?: boolean; onReport?: (report: ProviderReport) => void } = {},
  ): Promise<ProviderReport[]> {
    const providers = this.providers;
    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const report = await this.get(provider, options);
        try {
          options.onReport?.(report);
        } catch {
          // A listener's failure is not the provider's.
        }
        return report;
      }),
    );
    return settled.map((outcome, index): ProviderReport => {
      if (outcome.status === "fulfilled") return outcome.value;
      return {
        ok: false,
        error: { kind: "internal", message: safeErrorText(outcome.reason) },
        provider: providers[index] as ProviderId,
        checkedAtMs: this.#now(),
      };
    });
  }
}

// ---- settings and alert state on disk ------------------------------------------------------

export type QuotaConfig = {
  /** `/quota lang`: the language of everything pi-quota shows. */
  language: Locale;
  /** `/quota hide`: no widget; checks and alerts go on. */
  hidden: boolean;
  /** Where the panel goes in pi's TUI: floating at the top right, or above the editor. */
  placement: PanelPlacement;
  /** `/quota mute <window>`: windows that send no warning and no "Quota available". */
  muted: AlertWindow[];
  /** Warn under this percent left. */
  warnBelow: number;
  /** After a warning, announce "Quota available" at this percent left or more. */
  recoverAt: number;
};

export const DEFAULT_CONFIG: Readonly<QuotaConfig> = {
  language: DEFAULT_LOCALE,
  hidden: false,
  placement: DEFAULT_PLACEMENT,
  muted: [],
  warnBelow: 20,
  recoverAt: 50,
};

export type QuotaPaths = { dir: string; config: string; state: string };

export function quotaPaths(agentDir: string): QuotaPaths {
  const dir = join(agentDir, "pi-quota");
  return { dir, config: join(dir, "config.json"), state: join(dir, "state.json") };
}

function percentSetting(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100 ? value : fallback;
}

/** Settings from a decoded file: each bad or missing field takes its default. */
export function parseConfig(raw: JsonValue | undefined): QuotaConfig {
  const value: JsonObject = isJsonObject(raw) ? raw : {};
  const muted = Array.isArray(value.muted) ? value.muted.filter(isAlertWindow) : [];
  return {
    language: isLocale(value.language) ? value.language : DEFAULT_CONFIG.language,
    hidden: value.hidden === true,
    placement: isPlacement(value.placement) ? value.placement : DEFAULT_CONFIG.placement,
    muted: [...new Set(muted)],
    warnBelow: percentSetting(value.warnBelow, DEFAULT_CONFIG.warnBelow),
    recoverAt: percentSetting(value.recoverAt, DEFAULT_CONFIG.recoverAt),
  };
}

/** Alert state from a decoded file: entries that are not objects of the known fields are dropped. */
export function parseAlertState(raw: JsonValue | undefined): AlertState {
  if (!isJsonObject(raw)) return {};
  const state: AlertState = {};
  for (const [key, fields] of Object.entries(raw)) {
    if (!isJsonObject(fields)) continue;
    const entry: WindowAlertState = {};
    if (typeof fields.warnedReset === "string") entry.warnedReset = fields.warnedReset;
    if (typeof fields.recoveredReset === "string") entry.recoveredReset = fields.recoveredReset;
    if (fields.low === true) entry.low = true;
    state[key] = entry;
  }
  return state;
}

/** A JSON file decoded by `parse`; a missing or unreadable file goes to `parse` as undefined. */
function readParsed<T>(path: string, parse: (raw: JsonValue | undefined) => T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return parse(undefined);
  }
  return parse(parseJson(text));
}

/** Writes a settings or state file whole: a sibling temp file renamed into place. False on failure. */
export function writeJsonAtomic(path: string, value: QuotaConfig | AlertState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(path: string): QuotaConfig {
  return readParsed(path, parseConfig);
}

export function loadAlertState(path: string): AlertState {
  return readParsed(path, parseAlertState);
}
