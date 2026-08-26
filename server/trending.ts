// Trending & Emerging source: Reddit hot posts from audio-related subreddits.
// Polled periodically, returned to the Discovery "Trending" tab.

import { storage } from "./storage";

interface RedditPost {
  id: string;
  title: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  subreddit: string;
  author: string;
  thumbnail: string | null;
  selftext: string;
}

export interface TrendingPost {
  id: string;
  title: string;
  url: string;        // external link or reddit permalink
  permalink: string;  // always the reddit discussion link
  subreddit: string;
  score: number;
  numComments: number;
  createdAt: string;  // ISO timestamp
  author: string;
  thumbnail: string | null;
  selftext: string;
  // Optional heads-up signal — populated by detectSignal() when the post looks
  // like a leak, rumour, or breaking-news story.
  signal?: "breaking" | "leak" | "rumour" | null;
  signalReason?: string;  // short human-readable explanation (matched phrase)
}

// ─── Signal detection ────────────────────────────────────────────────────────
// Tag posts that resemble a leak / rumour / breaking-news story so the UI can
// surface them at the top of the tab. Pure regex match over title + selftext —
// fast, deterministic, no AI costs.
const BREAKING_RX = /\b(breaking|just in|just announced|announcing|official(ly)?\s+(announced|revealed|launched|unveiled)|launched\s+today|unveiled\s+today|live\s+now|available\s+now|goes\s+on\s+sale|now\s+shipping|pre-?order\s+(opens?|available|live))\b/i;
const LEAK_RX = /\b(leak(ed|s)?|exposed|spotted\s+(at|in)|hands[- ]on\s+(photos?|images?|pics?)|prototype|spy\s+(shots?|pics?)|caught\s+(on\s+camera|in\s+the\s+wild)|unreleased|early\s+look)\b/i;
const RUMOUR_RX = /\b(rumou?r(ed|s)?|speculation|reportedly|sources?\s+say|allegedly|tip(ped|ster)|may\s+launch|might\s+launch|could\s+be|next[- ]?gen|upcoming|teased|hint(ed|s)?|whispered)\b/i;

export function detectSignal(title: string, selftext: string = ""): { signal: TrendingPost["signal"]; reason?: string } {
  const text = `${title}\n${selftext}`;
  // Priority: leak > breaking > rumour (most actionable first)
  const leakMatch = text.match(LEAK_RX);
  if (leakMatch) return { signal: "leak", reason: leakMatch[0] };
  const breakingMatch = text.match(BREAKING_RX);
  if (breakingMatch) return { signal: "breaking", reason: breakingMatch[0] };
  const rumourMatch = text.match(RUMOUR_RX);
  if (rumourMatch) return { signal: "rumour", reason: rumourMatch[0] };
  return { signal: null };
}

// Expanded subreddit list (May 2026). Was 8, now 25 — covers product launches
// and leaks that escape audiophile-only subs. Each entry has a sort hint:
// "new" surfaces fresh news before the upvote system buries it (best signal
// for leaks/launches), while "hot" stays useful for niche subs where signal
// density is naturally lower.
const SUBREDDIT_FEEDS: { name: string; sort: "new" | "hot" }[] = [
  // Core audiophile subs — use /new to catch leaks before they get upvoted
  { name: "audiophile", sort: "new" },
  { name: "headphones", sort: "new" },
  { name: "hifiaudio", sort: "new" },
  { name: "hometheater", sort: "new" },
  { name: "BudgetAudiophile", sort: "new" },
  { name: "stereoadvice", sort: "hot" },
  { name: "TrueAudio", sort: "hot" },
  { name: "vinyl", sort: "new" },
  // IEM / portable / earbud subs — product-news heavy
  { name: "iems", sort: "new" },
  { name: "InEarFidelity", sort: "new" },
  { name: "Earphones", sort: "new" },
  { name: "HeadphoneAdvice", sort: "hot" },
  // AV / display / home cinema
  { name: "AVoverHDMI", sort: "new" },
  { name: "4kTV", sort: "new" },
  { name: "OLED", sort: "new" },
  { name: "Projectors", sort: "new" },
  // Manufacturer / brand subs (best signal for first-party leaks/launches)
  { name: "KossMods", sort: "new" },
  { name: "KEFAudio", sort: "new" },
  { name: "sennheiser", sort: "new" },
  { name: "sonos", sort: "new" },
  { name: "bose", sort: "new" },
  // Streaming / network audio
  { name: "BlueSoundOfficial", sort: "new" },
  { name: "WiimAudio", sort: "new" },
  { name: "roonlabs", sort: "new" },
  // Turntables / vinyl gear
  { name: "turntables", sort: "new" },
];

// Backwards compat for any code that imports SUBREDDITS
const SUBREDDITS = SUBREDDIT_FEEDS.map(f => f.name);

// How many posts to pull per sub. /new feeds use a smaller count because we
// only care about recent posts; /hot feeds need more because they're sorted
// by engagement and the news posts may be deeper in the list.
const POSTS_PER_NEW = 30;
const POSTS_PER_HOT = 50;

// ─── Product-news keyword filter ────────────────────────────────────────
// A post is considered "product news / leak / rumour" if its title or selftext
// matches one of these regexes (case-insensitive).
const NEWS_PATTERNS = [
  /\bannoun\w*\b/i,           // announced, announcement, announces
  /\blaunch(?:ed|ing|es)?\b/i, // launched, launching, launches
  /\bunveil\w*\b/i,            // unveils, unveiled
  /\breveal\w*\b/i,            // revealed, reveals
  /\breleas(?:ed|ing|es)?\b/i, // released, releasing, releases
  /\bleak(?:ed|s)?\b/i,        // leaked, leaks
  /\brumou?r(?:ed|s)?\b/i,     // rumour, rumor, rumoured, rumored, rumours
  /\bteas(?:er|ed|ing)\b/i,    // teaser, teased, teasing
  /\bpreview(?:ed|s)?\b/i,     // preview, previewed
  /\bspec(?:s|ifications)?\b/i,// specs, specifications
  /\bfirst\s+look\b/i,
  /\bhands[- ]on\b/i,
  /\bnew\s+(?:amp(?:lifier)?|speaker|loudspeaker|headphone|iem|dac|streamer|turntable|cartridge|receiver|soundbar|subwoofer|av\s+receiver|power\s+amp|pre[- ]?amp|phono)/i,
  /\bdebut(?:s|ed|ing)?\b/i,
  /\bintroduc(?:e|es|ed|ing)\b/i,
  /\bupcoming\b/i,
  /\bces\s+\d{4}\b/i,          // CES 2026
  /\bmunich\s+(?:high\s+end|hi[- ]fi)\b/i,
  /\bhigh\s+end\s+\d{4}\b/i,   // High End Munich 2026
  /\baxpona\b/i,
  /\bbristol\s+(?:show|hi[- ]fi)\b/i,
  /\bflorida\s+audio\s+expo\b/i,
  /\bfirmware\s+update\b/i,
  /\bmodel\s+refresh\b/i,
  /\bsuccessor\s+to\b/i,
  /\bprice\s+(?:announced|revealed|leaked)\b/i,
  /\bpre[- ]?order\b/i,
];

function isProductNews(title: string, selftext: string, flair: string | undefined): boolean {
  const text = `${title}\n${selftext}`;
  // Flair-based fast path
  const f = (flair || "").toLowerCase();
  if (f && (f.includes("news") || f.includes("announcement") || f.includes("launch") || f.includes("review") || f.includes("leak"))) {
    return true;
  }
  return NEWS_PATTERNS.some(rx => rx.test(text));
}

// Extract product/brand tokens from a title for cross-post mention counting.
// Any capitalised multi-word phrase and common brand names get picked up.
const BRAND_LIST = [
  "KEF", "Bowers & Wilkins", "B&W", "B&O", "Bang & Olufsen", "Sonos", "Bose", "Sony", "Denon", "Marantz",
  "Yamaha", "Pioneer", "NAD", "Cambridge Audio", "Arcam", "Rotel", "McIntosh", "Mark Levinson", "Krell",
  "Accuphase", "Naim", "Linn", "Rega", "Pro-Ject", "Technics", "Clearaudio", "VPI", "SME", "Thorens",
  "Dynaudio", "Focal", "Klipsch", "Polk", "Wharfedale", "Mission", "Monitor Audio", "PSB", "Paradigm",
  "Revel", "JBL", "Harbeth", "Spendor", "Proac", "Audiovector", "Sonus Faber", "Wilson Audio", "Magico",
  "YG Acoustics", "Estelon", "Vivid Audio", "MBL", "Devialet", "Chord", "dCS", "MSB", "Esoteric",
  "T+A", "Hegel", "Bryston", "Classe", "Parasound", "Benchmark", "Topping", "SMSL", "Schiit", "Audeze",
  "HiFiMan", "HIFIMAN", "Focal", "Dan Clark Audio", "DCA", "Sennheiser", "Beyerdynamic", "Shure",
  "Audio-Technica", "AKG", "Grado", "Meze", "Campfire", "Moondrop", "Empire Ears", "64 Audio", "ZMF",
  "SVS", "REL", "JL Audio", "Perlisten", "Seaton", "Arendal", "Buchardt", "Genelec", "Adam Audio",
  "Neumann", "Focal Utopia", "Sony WH", "AirPods", "WH-1000XM", "LG", "Panasonic", "Samsung", "TCL",
  "Hisense", "Philips", "Roku", "Apple TV", "Nvidia Shield", "Sonos Arc", "HomePod", "Bluesound",
  "Roon", "Tidal", "Qobuz", "WiiM", "Eversolo", "Aurender", "Innuos", "Antipodes", "Melco",
];
const BRAND_RX = new RegExp(`\\b(${BRAND_LIST.map(b => b.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|")})\\b`, "i");

function extractTopic(title: string): string | null {
  const m = title.match(BRAND_RX);
  if (m) return m[1].toLowerCase();
  // Fallback: first 3 capitalised-word run after position 0
  const capRun = title.match(/\b([A-Z][a-zA-Z0-9-]+(?:\s+[A-Z0-9][a-zA-Z0-9-]+){1,2})\b/);
  if (capRun) return capRun[1].toLowerCase();
  return null;
}

// Decode HTML entities that Reddit escapes (&amp; etc.)
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

// Pick the best available image. Reddit placeholders: "self", "default", "nsfw", "spoiler", "image"
function extractThumbnail(d: any): string | null {
  // Prefer a proper preview image (higher-res than thumbnail)
  const previewUrl = d?.preview?.images?.[0]?.resolutions?.slice(-1)?.[0]?.url
    || d?.preview?.images?.[0]?.source?.url;
  if (previewUrl && typeof previewUrl === "string") {
    return decodeHtmlEntities(previewUrl);
  }
  // Fallback to the thumbnail field if it's an actual URL
  const thumb = d?.thumbnail;
  if (thumb && typeof thumb === "string" && thumb.startsWith("http")) {
    return decodeHtmlEntities(thumb);
  }
  return null;
}

export async function fetchTrendingPosts(): Promise<TrendingPost[]> {
  const all: TrendingPost[] = [];
  // Fetch all subs in parallel to keep total wall time reasonable now that we
  // have 25 feeds instead of 8.
  const fetches = SUBREDDIT_FEEDS.map(async (feed) => {
    const sub = feed.name;
    const limit = feed.sort === "new" ? POSTS_PER_NEW : POSTS_PER_HOT;
    try {
      const url = `https://www.reddit.com/r/${sub}/${feed.sort}.json?limit=${limit}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: { "User-Agent": "Pulse-StereoNET-Dashboard/2.0 by u/stereonet" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.log(`[trending] ${sub}/${feed.sort}: HTTP ${res.status}`);
        return [] as TrendingPost[];
      }
      const data: any = await res.json();
      const posts = data?.data?.children || [];
      const out: TrendingPost[] = [];
      for (const p of posts) {
        const d = p.data;
        if (d.stickied) continue;
        if (d.over_18) continue;
        const title = String(d.title || "").slice(0, 300);
        const selftext = String(d.selftext || "").slice(0, 500);
        const flair = d?.link_flair_text as string | undefined;
        const isNews = isProductNews(title, selftext, flair);
        const sig = detectSignal(title, selftext);
        // For /new feeds, drop low-signal posts immediately to avoid noise.
        // /new is unfiltered chronological so most posts are forum chatter.
        // We keep only posts that look like news, OR that are signal-tagged
        // (leak/breaking/rumour), OR have already accumulated some upvotes
        // (≥10) which suggests the community sees value in them.
        if (feed.sort === "new") {
          const score = d.score || 0;
          const hasSignal = !!sig.signal;
          if (!isNews && !hasSignal && score < 10) continue;
        }
        out.push({
          id: `${sub}_${d.id}`,
          title,
          url: d.url || `https://www.reddit.com${d.permalink}`,
          permalink: `https://www.reddit.com${d.permalink}`,
          subreddit: sub,
          score: d.score || 0,
          numComments: d.num_comments || 0,
          createdAt: new Date(d.created_utc * 1000).toISOString(),
          author: d.author || "unknown",
          thumbnail: extractThumbnail(d),
          selftext,
          signal: sig.signal,
          signalReason: sig.reason,
          _isNews: isNews,
        } as any);
      }
      return out;
    } catch (e: any) {
      console.log(`[trending] ${sub}/${feed.sort}: ${e.message}`);
      return [] as TrendingPost[];
    }
  });
  const results = await Promise.all(fetches);
  for (const arr of results) all.push(...arr);

  // De-duplicate cross-posted stories. The same Reddit submission ID can show
  // up across multiple subs when crossposted, but more commonly the same
  // external URL is shared independently. We collapse by external URL when
  // it's a non-reddit link, keeping the version with the highest upvote count.
  const dedupedByUrl = new Map<string, TrendingPost>();
  const passthrough: TrendingPost[] = [];
  for (const post of all) {
    const isExternal = post.url && !/reddit\.com/i.test(post.url) && !/^\/r\//.test(post.url);
    if (isExternal) {
      const key = post.url.toLowerCase().split("#")[0].split("?")[0];
      const existing = dedupedByUrl.get(key);
      if (!existing || (post.score > existing.score)) dedupedByUrl.set(key, post);
    } else {
      passthrough.push(post);
    }
  }
  // Replace the original `all` with deduped + passthrough
  all.length = 0;
  all.push(...passthrough, ...dedupedByUrl.values());
  // Rank by recency + cross-source mentions (the "emerging" signal)
  // Each post gets a combined score:
  //   base      = upvotes
  //   recency   = exp decay over ~7 days
  //   mentions  = count of posts sharing the same topic, boosted when in multiple subs
  const now = Date.now();
  const HOUR = 3600_000;

  // Tally topic mentions
  const topicStats = new Map<string, { count: number; subs: Set<string> }>();
  for (const post of all) {
    const topic = extractTopic(post.title);
    if (!topic) continue;
    const cur = topicStats.get(topic) || { count: 0, subs: new Set<string>() };
    cur.count += 1;
    cur.subs.add(post.subreddit);
    topicStats.set(topic, cur);
  }

  type Ranked = TrendingPost & { _rank: number; topic?: string; _isNews: boolean };
  const ranked: Ranked[] = all.map((post: any) => {
    const ageH = Math.max(0, (now - new Date(post.createdAt).getTime()) / HOUR);
    const recency = Math.exp(-ageH / (7 * 24));
    const topic = extractTopic(post.title) || undefined;
    const stat = topic ? topicStats.get(topic) : undefined;
    const mentionBoost = stat ? (stat.count - 1) * 50 + (stat.subs.size - 1) * 100 : 0;
    // News posts get a 2x boost; breaking/leak/rumour posts get a 3x boost so
    // they float to the top of the tab regardless of upvote count.
    const newsBoost = post._isNews ? 2.0 : 1.0;
    const signalBoost = post.signal === "leak" ? 3.5
                       : post.signal === "breaking" ? 3.0
                       : post.signal === "rumour" ? 2.5
                       : 1.0;
    const rank = (post.score + mentionBoost) * recency * newsBoost * signalBoost;
    return { ...post, _rank: rank, topic, _isNews: !!post._isNews };
  });

  // Always prefer news, but backfill with the top non-news posts if we have fewer
  // than 20 news posts. Keeps the tab populated even when Reddit has a quiet news day.
  const news = ranked.filter(r => r._isNews).sort((a, b) => b._rank - a._rank);
  const nonNews = ranked.filter(r => !r._isNews).sort((a, b) => b._rank - a._rank);
  const combined: Ranked[] = news.length >= 20
    ? news
    : [...news, ...nonNews.slice(0, Math.max(10, 20 - news.length))];

  // Strip internal fields before returning
  return combined.slice(0, 60).map(({ _rank, topic, _isNews, ...rest }) => rest);
}

// Cache in DB as JSON blob + timestamp via app_settings
// Key version bumped to v2 when the image extractor changed (preview.images[].source.url + HTML-decode)
// v3: filtered for product-news / launch / leak / rumour only
// v5: adds signal detection (breaking / leak / rumour) with ranking boosts
// v6: switched to /new + 25 subs + cross-post de-dupe (May 2026)
const CACHE_KEY = "trending_posts_cache_v6";
const CACHE_TIME_KEY = "trending_posts_cached_at_v6";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const DISMISSED_KEY = "trending_dismissed_ids";
const COVERED_KEY = "trending_covered_ids";

function loadDismissed(): Set<string> {
  try {
    const raw = storage.getSetting(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}
function saveDismissed(ids: Set<string>) {
  // Cap at 2000 ids to avoid unbounded growth
  const arr = Array.from(ids);
  storage.setSetting(DISMISSED_KEY, JSON.stringify(arr.slice(-2000)));
}
export function dismissTrending(id: string) {
  const cur = loadDismissed();
  cur.add(id);
  saveDismissed(cur);
}
export function clearTrendingDismissals() {
  storage.setSetting(DISMISSED_KEY, "[]");
}

// ─── Covered (already written about on StereoNET) ─────────────────────────
function loadCovered(): Set<string> {
  try {
    const raw = storage.getSetting(COVERED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}
function saveCovered(ids: Set<string>) {
  const arr = Array.from(ids);
  storage.setSetting(COVERED_KEY, JSON.stringify(arr.slice(-2000)));
}
export function markTrendingCovered(id: string) {
  const cur = loadCovered();
  cur.add(id);
  saveCovered(cur);
}
export function clearTrendingCovered() {
  storage.setSetting(COVERED_KEY, "[]");
}

export async function getTrendingPosts(opts?: { force?: boolean }): Promise<{
  posts: TrendingPost[];
  cachedAt: string | null;
}> {
  const dismissed = loadDismissed();
  const covered = loadCovered();
  const hidden = new Set<string>([...dismissed, ...covered]);
  if (!opts?.force) {
    const cachedAtStr = storage.getSetting(CACHE_TIME_KEY);
    const cached = storage.getSetting(CACHE_KEY);
    if (cachedAtStr && cached) {
      const cachedAt = parseInt(cachedAtStr, 10);
      if (Date.now() - cachedAt < CACHE_TTL_MS) {
        try {
          const posts: TrendingPost[] = JSON.parse(cached);
          return {
            posts: posts.filter(p => !hidden.has(p.id)),
            cachedAt: new Date(cachedAt).toISOString(),
          };
        } catch { /* fall through */ }
      }
    }
  }
  const posts = await fetchTrendingPosts();
  const now = Date.now();
  storage.setSetting(CACHE_KEY, JSON.stringify(posts));
  storage.setSetting(CACHE_TIME_KEY, String(now));
  return {
    posts: posts.filter(p => !hidden.has(p.id)),
    cachedAt: new Date(now).toISOString(),
  };
}
