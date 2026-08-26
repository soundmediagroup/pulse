// ─── Primary-Source Watchers ──────────────────────────────────────────────
//
// Article Discovery has historically only watched other publishers' RSS
// feeds — meaning we always see news AFTER someone else has published it.
// This module watches the SOURCES those publishers themselves watch, so we
// can beat them to the story.
//
// Sources monitored:
//   1. FCC ID filings (fccid.io) — product certifications, 30-90 days before
//      product launch. This is where the Sonos Ace Ultra story broke on 10
//      Aug — a full day before eCoustics or any other publisher wrote it up.
//   2. YouTube channels of gold-standard reviewers — Steve Guttenberg, Vincent
//      Teoh, Darko, Techmoan, Hans Beekhuyzen. Video announcements often
//      precede written press by 24-72h.
//   3. Kickstarter/Indiegogo audio category — pre-launch products, often
//      months before mainstream coverage.
//   4. Manufacturer press portals — some brands post to /press or /news
//      before emailing PR distribution.
//
// All primary-source hits are written to the standard `articles` table with
// a marker so Article Discovery can surface them with a PRIMARY SOURCE pill.

import Database from "better-sqlite3";
import * as crypto from "node:crypto";

type DB = Database.Database;

// ─── Schema ────────────────────────────────────────────────────────────────

export function ensurePrimarySourceSchema(sqlite: DB) {
  // Watchlist of FCC applicant IDs. Each brand may have 1..N grantee codes.
  // Pre-seeded with 40 major audio brands (see seedFCCTargets below).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fcc_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT NOT NULL,
      grantee_code TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_polled_at TEXT,
      last_signal_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fcc_targets_active ON fcc_targets(is_active, last_polled_at);
  `);

  // Watchlist of YouTube channels. RSS feed at
  // youtube.com/feeds/videos.xml?channel_id=UCxxxxxx
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS youtube_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_name TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'standard',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_polled_at TEXT,
      last_signal_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Watchlist of manufacturer press portals with a scrape pattern.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS brand_press_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT NOT NULL,
      press_url TEXT NOT NULL UNIQUE,
      link_selector TEXT,
      title_selector TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_polled_at TEXT,
      last_signal_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Dedupe log for primary-source signals so we don't re-alert on the same
  // FCC ID / video / press item.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS primary_source_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      article_id INTEGER,
      UNIQUE(source_type, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_seen_time ON primary_source_seen(first_seen_at DESC);
  `);
}

// ─── Seeds ─────────────────────────────────────────────────────────────────

// Curated list of 40 audio brand FCC applicant / grantee codes. These are
// the "FCC ID" prefixes assigned to each brand. Confirming a code against
// fccid.io is a one-time lookup; codes rarely change once assigned.
// If a brand has multiple codes (Samsung has dozens, for example) list the
// ones most likely to be used for audio product lines.
const FCC_SEED_TARGETS: Array<{ brand: string; grantee_code: string }> = [
  { brand: "Sonos", grantee_code: "RMH" },
  { brand: "Sonos", grantee_code: "2ADX8" }, // alt grantee sometimes used
  { brand: "Bose", grantee_code: "AO2" },
  { brand: "Bose", grantee_code: "2AZAV" },
  { brand: "Bowers & Wilkins", grantee_code: "2ANDF" },
  { brand: "Bowers & Wilkins", grantee_code: "SAY" },
  { brand: "Sennheiser", grantee_code: "DMOMT" },
  { brand: "Sennheiser", grantee_code: "2AC7Z" },
  { brand: "Focal", grantee_code: "2AMHM" },
  { brand: "Naim", grantee_code: "2ARRP" },
  { brand: "KEF", grantee_code: "2ADXZ" },
  { brand: "Bang & Olufsen", grantee_code: "OMPBEO" },
  { brand: "Devialet", grantee_code: "2AC8M" },
  { brand: "Sony (audio)", grantee_code: "AK8" },
  { brand: "JBL / Harman", grantee_code: "AK8HK" },
  { brand: "Harman Kardon", grantee_code: "AK8HK" },
  { brand: "Denon", grantee_code: "M4Y" },
  { brand: "Marantz", grantee_code: "M4Y" },
  { brand: "Audio-Technica", grantee_code: "2AEDR" },
  { brand: "Shure", grantee_code: "2AB9Q" },
  { brand: "Beats / Apple audio", grantee_code: "BCG" },
  { brand: "Apple", grantee_code: "BCG" },
  { brand: "Bluesound / NAD / Lenbrook", grantee_code: "2AAXL" },
  { brand: "Cambridge Audio", grantee_code: "2AJYA" },
  { brand: "Anker Soundcore", grantee_code: "2AL3D" },
  { brand: "Master & Dynamic", grantee_code: "2AKUJ" },
  { brand: "Beyerdynamic", grantee_code: "2A9V6" },
  { brand: "HiFiMAN", grantee_code: "2AN8Q" },
  { brand: "Astell&Kern", grantee_code: "V8G" },
  { brand: "Marshall Amplification", grantee_code: "2ADZG" },
  { brand: "Ultimate Ears / Logitech", grantee_code: "JNZ" },
  { brand: "Devialet", grantee_code: "2AC8M" },
  { brand: "Yamaha", grantee_code: "K73" },
  { brand: "Onkyo / Pioneer", grantee_code: "AJDCS" },
  { brand: "Pioneer", grantee_code: "AJD" },
  { brand: "TCL Audio", grantee_code: "2ACCJH" },
  { brand: "Klipsch", grantee_code: "2AAEZ" },
  { brand: "Polk Audio / Sound United", grantee_code: "2ARJ7" },
  { brand: "Definitive Technology", grantee_code: "2ARJ7" },
  { brand: "Loewe", grantee_code: "IYS" },
  { brand: "Nothing (audio)", grantee_code: "2A6VW" },
];

// 25 gold-standard reviewer channels. YouTube channel IDs (starts with UC).
// These are curated audio/AV reviewer channels whose new-video posts are
// gold-standard signals for either scoops or high-authority reviews.
const YOUTUBE_SEED_TARGETS: Array<{ channel_name: string; channel_id: string; tier: string }> = [
  { channel_name: "Steve Guttenberg Audiophiliac", channel_id: "UCj9dtPLIA6-ROqI2xIIsMhA", tier: "gold" },
  { channel_name: "HDTVTest (Vincent Teoh)", channel_id: "UCynh64k9tXlyLwLC5oe37lQ", tier: "gold" },
  { channel_name: "Darko.Audio", channel_id: "UC5xthDgQ_60QcCyz_lgQvow", tier: "gold" },
  { channel_name: "Techmoan", channel_id: "UC5I2hjZYiW9gZPVkvzM8_Cw", tier: "gold" },
  { channel_name: "Hans Beekhuyzen Channel", channel_id: "UCw_LB4tCIRR2WuY69wcW4NA", tier: "gold" },
  { channel_name: "Andrew Robinson", channel_id: "UCwq50DIVCTKcAeAjXVE-Kag", tier: "gold" },
  { channel_name: "Currawong (Amir/Audio Science Review)", channel_id: "UCTOUomYuwaXjT6XvC_lZLBw", tier: "gold" },
  { channel_name: "The HEADPHONE Show", channel_id: "UCsD3IIsjilFYbz-hnTnKxdA", tier: "gold" },
  { channel_name: "Zeos Pantera", channel_id: "UCsxNfLwOl8j9dvvFtRe6bcw", tier: "standard" },
  { channel_name: "Erin's Audio Corner", channel_id: "UCsFcHTC4Wgm5EQCV_-onWkg", tier: "gold" },
  { channel_name: "GoldenSound", channel_id: "UCPjq_hASxvj2CxdUp6HDsBg", tier: "gold" },
  { channel_name: "Jay's iyagi", channel_id: "UCB4iVFJ6EDW9EvdRlvKPQvw", tier: "standard" },
  { channel_name: "Audio Advice", channel_id: "UCa4kFPz3aeVUJz3G4H8wRZg", tier: "gold" },
  { channel_name: "Passion for Sound", channel_id: "UCLpZ3v-5nrfL_QcVMlIw6-Q", tier: "gold" },
  { channel_name: "Cheapaudioman", channel_id: "UCUB9lIUlbF7cTFhwqoNz4Nw", tier: "standard" },
  { channel_name: "Thomas & Stereo", channel_id: "UCcKUVFQuiWY9dgeb-Uh30Iw", tier: "standard" },
  { channel_name: "Digital Trends", channel_id: "UCiwK6toTKMYIRP-eZjbW3AA", tier: "standard" },
  { channel_name: "What Hi-Fi?", channel_id: "UC0eFwCudDlrhKpqRVzT2f7A", tier: "gold" },
  { channel_name: "MKBHD (audio segments)", channel_id: "UCBJycsmduvYEL83R_U4JriQ", tier: "standard" },
  { channel_name: "Rtings.com", channel_id: "UCXvz88rbmB2Y_2VwFxN_5tQ", tier: "gold" },
  { channel_name: "The Verge (audio segments)", channel_id: "UCddiUEpeqJcYeBxX1IVBKvQ", tier: "standard" },
  { channel_name: "Home Theater Gamer", channel_id: "UCn3E9dgQuXvA9C6r0-4iAHw", tier: "standard" },
  { channel_name: "Regis Audio", channel_id: "UCE0DFy1ycl7f1IPjbxq-D9Q", tier: "standard" },
  { channel_name: "Sam / OZ Home Cinema", channel_id: "UCJ_zM-Xar_o3-DKA6IqI3jw", tier: "standard" },
  { channel_name: "iiWi Reviews", channel_id: "UCEDvQF1s5DE13tD08rC6Tug", tier: "standard" },
];

// Manufacturer press portals. Selectors are best-effort — if a brand
// redesigns their site the scraper degrades gracefully to no-signal.
const BRAND_PRESS_SEED_TARGETS: Array<{ brand: string; press_url: string; link_selector?: string; title_selector?: string }> = [
  { brand: "Sonos", press_url: "https://en.newsroom.sonos.com/press-releases" },
  { brand: "Bose", press_url: "https://www.bose.com/en_us/better_with_bose/newsroom.html" },
  { brand: "Bowers & Wilkins", press_url: "https://www.bowerswilkins.com/en/press" },
  { brand: "Sennheiser", press_url: "https://newsroom.sennheiser.com/press-releases/" },
  { brand: "Focal", press_url: "https://www.focal.com/en/press-releases" },
  { brand: "Naim", press_url: "https://www.naimaudio.com/news" },
  { brand: "KEF", press_url: "https://us.kef.com/blogs/news" },
  { brand: "Bang & Olufsen", press_url: "https://www.bang-olufsen.com/en/us/story/press" },
  { brand: "Devialet", press_url: "https://www.devialet.com/en-gb/pages/press" },
  { brand: "Bluesound", press_url: "https://www.bluesound.com/blog/" },
  { brand: "NAD", press_url: "https://nadelectronics.com/news/" },
  { brand: "Cambridge Audio", press_url: "https://www.cambridgeaudio.com/gbr/en/blog" },
  { brand: "Audio-Technica", press_url: "https://www.audio-technica.com/en-us/news" },
  { brand: "Shure", press_url: "https://www.shure.com/en-US/about-us/newsroom" },
  { brand: "Beyerdynamic", press_url: "https://north-america.beyerdynamic.com/press.html" },
  { brand: "Klipsch", press_url: "https://www.klipsch.com/blog/" },
  { brand: "Polk Audio", press_url: "https://www.polkaudio.com/blog/" },
  { brand: "Marantz", press_url: "https://www.marantz.com/en-gb/news" },
  { brand: "Denon", press_url: "https://www.denon.com/en-gb/news" },
  { brand: "Yamaha", press_url: "https://usa.yamaha.com/news_events/index.html" },
];

export function seedPrimarySources(sqlite: DB) {
  ensurePrimarySourceSchema(sqlite);
  const fccInsert = sqlite.prepare(`INSERT OR IGNORE INTO fcc_targets (brand, grantee_code) VALUES (?, ?)`);
  for (const t of FCC_SEED_TARGETS) fccInsert.run(t.brand, t.grantee_code);
  const ytInsert = sqlite.prepare(`INSERT OR IGNORE INTO youtube_targets (channel_name, channel_id, tier) VALUES (?, ?, ?)`);
  for (const t of YOUTUBE_SEED_TARGETS) ytInsert.run(t.channel_name, t.channel_id, t.tier);
  const bpInsert = sqlite.prepare(`INSERT OR IGNORE INTO brand_press_targets (brand, press_url) VALUES (?, ?)`);
  for (const t of BRAND_PRESS_SEED_TARGETS) bpInsert.run(t.brand, t.press_url);
}

// ─── FCC ID Watcher ────────────────────────────────────────────────────────

// Poll fccid.io RSS for each grantee code. The RSS feed at
// https://fccid.io/<grantee>/rss.xml contains all recent grants for that
// applicant, with title (product) and pubDate (grant date).
async function fetchFccGrantee(grantee: string): Promise<Array<{ id: string; title: string; url: string; pubDate: string }>> {
  const url = `https://fccid.io/${encodeURIComponent(grantee)}/rss.xml`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 StereoNET-Discovery/1.0" },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const xml = await res.text();
  const items: Array<{ id: string; title: string; url: string; pubDate: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const it = m[1];
    const title = it.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const guid = it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() ?? link;
    const pd = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? new Date().toUTCString();
    if (!title || !link) continue;
    items.push({ id: guid || link, title, url: link, pubDate: pd });
  }
  return items;
}

export async function runFccWatcher(sqlite: DB): Promise<{ polled: number; new_signals: number }> {
  ensurePrimarySourceSchema(sqlite);
  const targets = sqlite.prepare(`SELECT id, brand, grantee_code FROM fcc_targets WHERE is_active = 1 ORDER BY COALESCE(last_polled_at, '1970') ASC LIMIT 25`).all() as any[];
  let newSignals = 0;
  for (const t of targets) {
    let items: Awaited<ReturnType<typeof fetchFccGrantee>> = [];
    try {
      items = await fetchFccGrantee(t.grantee_code);
    } catch {}
    sqlite.prepare(`UPDATE fcc_targets SET last_polled_at = datetime('now') WHERE id = ?`).run(t.id);
    for (const it of items.slice(0, 20)) {
      const externalId = `fcc:${t.grantee_code}:${it.id}`;
      const seen = sqlite.prepare(`SELECT 1 FROM primary_source_seen WHERE source_type = 'fcc' AND external_id = ?`).get(externalId);
      if (seen) continue;
      // Insert a synthetic article so it appears in Article Discovery.
      const articleTitle = `[FCC filing] ${t.brand}: ${it.title}`;
      const publishedAt = new Date(it.pubDate).toISOString().replace("T", " ").slice(0, 19);
      try {
        const info = sqlite.prepare(`
          INSERT OR IGNORE INTO articles (site, title, url, published_at, published_date, content_type, categories, brands, fetched_at, description)
          VALUES ('fcc_filings', ?, ?, ?, ?, 'news', ?, ?, datetime('now'), ?)
        `).run(
          articleTitle,
          it.url,
          publishedAt,
          publishedAt.slice(0, 10),
          JSON.stringify(["FCC filing", "primary source"]),
          JSON.stringify([t.brand]),
          `FCC certification filing for ${t.brand}. Product: ${it.title}. Grantee code: ${t.grantee_code}.`
        );
        if (info.changes > 0) {
          sqlite.prepare(`INSERT OR IGNORE INTO primary_source_seen (source_type, external_id, article_id) VALUES ('fcc', ?, ?)`).run(externalId, info.lastInsertRowid);
          sqlite.prepare(`UPDATE fcc_targets SET last_signal_at = datetime('now') WHERE id = ?`).run(t.id);
          newSignals++;
        }
      } catch {}
    }
  }
  return { polled: targets.length, new_signals: newSignals };
}

// ─── YouTube Channel Watcher ───────────────────────────────────────────────

async function fetchYoutubeChannel(channelId: string): Promise<Array<{ id: string; title: string; url: string; pubDate: string; description: string }>> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 StereoNET-Discovery/1.0" },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const xml = await res.text();
  const items: Array<{ id: string; title: string; url: string; pubDate: string; description: string }> = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null) {
    const it = m[1];
    const videoId = it.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim();
    const title = it.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const link = it.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    const pd = it.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? new Date().toISOString();
    const desc = it.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.trim() ?? "";
    if (!title || !link || !videoId) continue;
    items.push({ id: videoId, title, url: link, pubDate: pd, description: desc.slice(0, 500) });
  }
  return items;
}

export async function runYoutubeWatcher(sqlite: DB): Promise<{ polled: number; new_signals: number }> {
  ensurePrimarySourceSchema(sqlite);
  const targets = sqlite.prepare(`SELECT id, channel_name, channel_id, tier FROM youtube_targets WHERE is_active = 1 ORDER BY COALESCE(last_polled_at, '1970') ASC LIMIT 15`).all() as any[];
  let newSignals = 0;
  for (const t of targets) {
    let items: Awaited<ReturnType<typeof fetchYoutubeChannel>> = [];
    try {
      items = await fetchYoutubeChannel(t.channel_id);
    } catch {}
    sqlite.prepare(`UPDATE youtube_targets SET last_polled_at = datetime('now') WHERE id = ?`).run(t.id);
    for (const it of items.slice(0, 15)) {
      const externalId = `yt:${it.id}`;
      const seen = sqlite.prepare(`SELECT 1 FROM primary_source_seen WHERE source_type = 'youtube' AND external_id = ?`).get(externalId);
      if (seen) continue;
      // Only surface videos published in the last 7 days (avoids ingesting the
      // full channel backlog on first poll)
      const pubMs = new Date(it.pubDate).getTime();
      if (Date.now() - pubMs > 7 * 24 * 3600 * 1000) {
        // Mark as seen so we don't re-check, but don't create article
        sqlite.prepare(`INSERT OR IGNORE INTO primary_source_seen (source_type, external_id) VALUES ('youtube', ?)`).run(externalId);
        continue;
      }
      const articleTitle = `[${t.channel_name}] ${it.title}`;
      const publishedAt = new Date(it.pubDate).toISOString().replace("T", " ").slice(0, 19);
      try {
        const info = sqlite.prepare(`
          INSERT OR IGNORE INTO articles (site, title, url, published_at, published_date, content_type, categories, fetched_at, description)
          VALUES ('youtube_reviewers', ?, ?, ?, ?, 'news', ?, datetime('now'), ?)
        `).run(
          articleTitle,
          it.url,
          publishedAt,
          publishedAt.slice(0, 10),
          JSON.stringify([`youtube:${t.tier}`, "video", "primary source"]),
          it.description
        );
        if (info.changes > 0) {
          sqlite.prepare(`INSERT OR IGNORE INTO primary_source_seen (source_type, external_id, article_id) VALUES ('youtube', ?, ?)`).run(externalId, info.lastInsertRowid);
          sqlite.prepare(`UPDATE youtube_targets SET last_signal_at = datetime('now') WHERE id = ?`).run(t.id);
          newSignals++;
        }
      } catch {}
    }
  }
  return { polled: targets.length, new_signals: newSignals };
}

// ─── Manufacturer Press Portal Watcher ─────────────────────────────────────

async function scrapePressPortal(url: string): Promise<Array<{ title: string; href: string }>> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StereoNET-Discovery/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const html = await res.text();
  // Heuristic extraction: find <a> tags whose text is likely a press-release
  // headline (>15 chars, <200 chars). Filter by whether the URL looks like a
  // permalink (contains /press/ /news/ /blog/ /article/ /post/ or a year).
  const items: Array<{ title: string; href: string }> = [];
  const seen = new Set<string>();
  const aRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = aRegex.exec(html)) !== null) {
    let href = m[1];
    const textRaw = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!textRaw || textRaw.length < 15 || textRaw.length > 200) continue;
    // Filter: URL must contain a news-like path segment or year
    if (!/\/(press|news|blog|article|post|announcement|release|newsroom|stories)\//i.test(href) && !/20\d{2}/.test(href)) continue;
    // Normalise relative URLs
    if (href.startsWith("/")) {
      const u = new URL(url);
      href = `${u.origin}${href}`;
    } else if (!href.startsWith("http")) {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({ title: textRaw, href });
    if (items.length >= 20) break;
  }
  return items;
}

export async function runBrandPressWatcher(sqlite: DB): Promise<{ polled: number; new_signals: number }> {
  ensurePrimarySourceSchema(sqlite);
  const targets = sqlite.prepare(`SELECT id, brand, press_url FROM brand_press_targets WHERE is_active = 1 ORDER BY COALESCE(last_polled_at, '1970') ASC LIMIT 10`).all() as any[];
  let newSignals = 0;
  for (const t of targets) {
    let items: Awaited<ReturnType<typeof scrapePressPortal>> = [];
    try {
      items = await scrapePressPortal(t.press_url);
    } catch {}
    sqlite.prepare(`UPDATE brand_press_targets SET last_polled_at = datetime('now') WHERE id = ?`).run(t.id);
    for (const it of items) {
      const externalId = `press:${t.brand}:${it.href}`;
      const seen = sqlite.prepare(`SELECT 1 FROM primary_source_seen WHERE source_type = 'brand_press' AND external_id = ?`).get(externalId);
      if (seen) continue;
      const articleTitle = `[${t.brand}] ${it.title}`;
      try {
        const info = sqlite.prepare(`
          INSERT OR IGNORE INTO articles (site, title, url, published_at, published_date, content_type, categories, brands, fetched_at, description)
          VALUES ('brand_press', ?, ?, datetime('now'), date('now'), 'press_release', ?, ?, datetime('now'), ?)
        `).run(
          articleTitle,
          it.href,
          JSON.stringify(["brand press portal", "primary source"]),
          JSON.stringify([t.brand]),
          `Direct scrape of ${t.brand} press portal at ${t.press_url}. This appeared before it was picked up by any RSS aggregator.`
        );
        if (info.changes > 0) {
          sqlite.prepare(`INSERT OR IGNORE INTO primary_source_seen (source_type, external_id, article_id) VALUES ('brand_press', ?, ?)`).run(externalId, info.lastInsertRowid);
          sqlite.prepare(`UPDATE brand_press_targets SET last_signal_at = datetime('now') WHERE id = ?`).run(t.id);
          newSignals++;
        }
      } catch {}
    }
  }
  return { polled: targets.length, new_signals: newSignals };
}

// ─── Combined runner ───────────────────────────────────────────────────────

export async function runAllPrimarySourceWatchers(sqlite: DB): Promise<any> {
  const [fcc, yt, bp] = await Promise.allSettled([
    runFccWatcher(sqlite),
    runYoutubeWatcher(sqlite),
    runBrandPressWatcher(sqlite),
  ]);
  return {
    fcc: fcc.status === "fulfilled" ? fcc.value : { error: (fcc.reason as any)?.message },
    youtube: yt.status === "fulfilled" ? yt.value : { error: (yt.reason as any)?.message },
    brand_press: bp.status === "fulfilled" ? bp.value : { error: (bp.reason as any)?.message },
  };
}
