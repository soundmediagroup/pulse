// FX rates cache. Used by the public media-kit currency selector so we can
// render the canonical USD prices in AUD/GBP/EUR/NZD without storing a row per
// currency in media_kit_addons. Pulls once per day from a free no-key API
// (exchangerate.host) and falls back to a hardcoded snapshot if the fetch fails.

import { sqlite } from "./storage";

const SUPPORTED = ["USD", "AUD", "GBP", "EUR", "NZD"] as const;
export type SupportedCurrency = (typeof SUPPORTED)[number];

// Hardcoded fallback rates (mid-market, mid-2026 snapshot). Used only when the
// FX API is unreachable. Refresh occasionally to keep them roughly current.
const FALLBACK_RATES: Record<SupportedCurrency, number> = {
  USD: 1.0,
  AUD: 1.52,
  GBP: 0.79,
  EUR: 0.92,
  NZD: 1.66,
};

function readRates(): Record<string, { rate: number; updated_at: string }> {
  const rows = sqlite.prepare(`SELECT code, rate_from_usd, updated_at FROM fx_rates`).all() as any[];
  const out: Record<string, { rate: number; updated_at: string }> = {};
  for (const r of rows) out[r.code] = { rate: Number(r.rate_from_usd), updated_at: String(r.updated_at) };
  return out;
}

function writeRates(rates: Record<SupportedCurrency, number>) {
  const stmt = sqlite.prepare(`
    INSERT INTO fx_rates (code, rate_from_usd, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET rate_from_usd = excluded.rate_from_usd, updated_at = excluded.updated_at
  `);
  for (const [code, rate] of Object.entries(rates)) stmt.run(code, rate);
}

async function fetchFromApi(): Promise<Record<SupportedCurrency, number> | null> {
  try {
    // exchangerate.host is a free, no-key mid-market FX feed. We pull rates
    // from USD to our supported currencies. Timeout aggressively so a slow
    // call never blocks the request thread.
    const url = `https://api.exchangerate.host/latest?base=USD&symbols=AUD,GBP,EUR,NZD`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "PULSE-fx-fetcher/1.0" } });
    clearTimeout(timeoutId);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j?.rates) return null;
    return {
      USD: 1.0,
      AUD: Number(j.rates.AUD) || FALLBACK_RATES.AUD,
      GBP: Number(j.rates.GBP) || FALLBACK_RATES.GBP,
      EUR: Number(j.rates.EUR) || FALLBACK_RATES.EUR,
      NZD: Number(j.rates.NZD) || FALLBACK_RATES.NZD,
    };
  } catch (e: any) {
    console.warn("[fx] fetch failed:", e?.message);
    return null;
  }
}

/**
 * Returns the latest FX rates. Refreshes from the API at most once per 24h.
 * Falls back to a hardcoded snapshot if the API has never succeeded.
 */
export async function getFxRates(): Promise<{ base: "USD"; rates: Record<SupportedCurrency, number>; fetched_at: string; source: "api" | "cache" | "fallback" }> {
  const cached = readRates();
  const usd = cached["USD"];
  const now = Date.now();
  const stale = !usd || (now - new Date(usd.updated_at).getTime()) > 24 * 60 * 60 * 1000;
  if (!stale) {
    return {
      base: "USD",
      rates: {
        USD: 1.0,
        AUD: cached.AUD?.rate || FALLBACK_RATES.AUD,
        GBP: cached.GBP?.rate || FALLBACK_RATES.GBP,
        EUR: cached.EUR?.rate || FALLBACK_RATES.EUR,
        NZD: cached.NZD?.rate || FALLBACK_RATES.NZD,
      },
      fetched_at: usd.updated_at,
      source: "cache",
    };
  }
  const fresh = await fetchFromApi();
  if (fresh) {
    writeRates(fresh);
    return { base: "USD", rates: fresh, fetched_at: new Date().toISOString(), source: "api" };
  }
  // API failed and we have stale or no rows; serve fallback (still write so the
  // cache exists; updated_at marks it as stale).
  if (!usd) writeRates(FALLBACK_RATES);
  return { base: "USD", rates: FALLBACK_RATES, fetched_at: new Date().toISOString(), source: "fallback" };
}

export const FX_SUPPORTED = SUPPORTED;
