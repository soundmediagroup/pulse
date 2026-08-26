// Lazy on-read translation of foreign-language article titles.
//
// Provider: MyMemory Translation (truly free, no API key, rate-limited to
// ~5,000 chars/day per IP unmonetised). Falls back to LibreTranslate's free
// public instance if MyMemory fails.
//
// All translations are cached in the `article_translations` table keyed by
// SHA-256 of the source text. Identical headlines across articles only get
// translated once.

import { createHash } from "crypto";
import { sqlite } from "./storage";

const PROVIDER_TIMEOUT_MS = 6000;
// Conservative per-call delay so we don't blast MyMemory and trip the
// per-IP throttle. Translations happen in the background after a Discovery
// query returns, so latency isn't user-facing.
const INTER_CALL_DELAY_MS = 250;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function getCachedTranslation(
  text: string,
  targetLang: string = "en"
): string | null {
  const row = sqlite
    .prepare(
      `SELECT translated_text FROM article_translations
       WHERE source_hash = ? AND target_lang = ?`
    )
    .get(sha256(text), targetLang) as { translated_text: string } | undefined;
  return row?.translated_text || null;
}

function setCached(
  source: string,
  sourceLang: string,
  targetLang: string,
  translated: string
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO article_translations
       (source_hash, target_lang, source_text, translated_text, source_lang)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sha256(source), targetLang, source, translated, sourceLang);
}

async function translateViaMyMemory(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<string | null> {
  const url =
    "https://api.mymemory.translated.net/get?" +
    new URLSearchParams({
      q: text,
      langpair: `${sourceLang}|${targetLang}`,
      // Per their docs, an email parameter raises the free quota from 5k to
      // 50k chars/day. We use a noreply address so they have something to
      // attribute the volume to.
      de: "noreply@stereonet.com",
    }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== "string" || !translated.trim()) return null;
    // MyMemory sometimes returns "PLEASE SELECT TWO DISTINCT LANGUAGES" type
    // errors as the translated string; reject obvious failure tells.
    if (/^MYMEMORY WARNING/i.test(translated)) return null;
    if (translated.trim().toLowerCase() === text.trim().toLowerCase()) {
      // Same string back — provider couldn't translate, probably already English
      return null;
    }
    return translated;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function translateViaLibre(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<string | null> {
  // libretranslate.de went paid in late 2024. Use a community-hosted instance.
  const url = "https://translate.flossboxin.org.in/translate";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source: sourceLang,
        target: targetLang,
        format: "text",
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data?.translatedText === "string"
      ? data.translatedText
      : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string = "en"
): Promise<string | null> {
  if (!text || !text.trim()) return null;
  if (sourceLang === targetLang) return text;
  const cached = getCachedTranslation(text, targetLang);
  if (cached) return cached;

  // Try MyMemory first, fall back to LibreTranslate
  let result = await translateViaMyMemory(text, sourceLang, targetLang);
  if (!result) result = await translateViaLibre(text, sourceLang, targetLang);
  if (!result) return null;

  setCached(text, sourceLang, targetLang, result);
  return result;
}

// Background batch translator. Spawns a debounced background task whenever
// new foreign articles arrive; quietly fills the translation cache so the
// next Discovery read serves cached results. Never blocks request handling.
let backlogTimer: NodeJS.Timeout | null = null;

export function scheduleBacklogFill() {
  if (backlogTimer) return;
  backlogTimer = setTimeout(async () => {
    backlogTimer = null;
    try {
      await fillTranslationBacklog();
    } catch (err: any) {
      console.error("[translate] backlog fill failed:", err?.message);
    }
  }, 5_000);
}

async function fillTranslationBacklog() {
  // Find recent foreign-language titles, then filter out the already-cached
  // ones in JS (SQLite has no SHA-256 built-in so we can't JOIN on the hash).
  const BATCH_RAW = 200;
  const BATCH_TRANSLATE = 40;
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT a.title, ts.language
       FROM articles a
       INNER JOIN tracked_sites ts ON ts.site_key = a.site
       WHERE ts.language != 'en'
         AND a.title IS NOT NULL
         AND a.title != ''
         AND a.fetched_at >= datetime('now', '-14 days')
       ORDER BY a.fetched_at DESC
       LIMIT ?`
    )
    .all(BATCH_RAW) as { title: string; language: string }[];

  const todo: { title: string; language: string }[] = [];
  for (const r of rows) {
    if (todo.length >= BATCH_TRANSLATE) break;
    if (!getCachedTranslation(r.title, "en")) todo.push(r);
  }

  for (const r of todo) {
    await translateText(r.title, r.language, "en");
    await new Promise(resolve => setTimeout(resolve, INTER_CALL_DELAY_MS));
  }
  if (todo.length) {
    console.log(`[translate] filled ${todo.length} translation(s)`);
  }
}
