// Media Kits ─── Interactive replacement for the PDF media kits.
// Backed by media_kits / media_kit_blocks / media_kit_addons / media_kit_shares / media_kit_views.
// Public viewer at /kit/:slug?t=<token>. Admin under /api/media-kit/*.
// Access piggy-backs on pitch_access (view/edit/admin).

import type { Express, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { sqlite, storage } from "./storage";

// ─── Permissions ────────────────────────────────────────────────────────────
type Level = "view" | "edit" | "admin";
const LEVELS: Record<Level, number> = { view: 1, edit: 2, admin: 3 };

function pitchLevelFor(req: any): Level | null {
  if (!req.session?.authenticated) return null;
  const username = req.session?.username;
  if (!username) return null;
  if (req.session?.role === "admin") return "admin";
  const row = sqlite.prepare(`SELECT COALESCE(pitch_access, 'none') AS lvl FROM users WHERE username = ?`).get(username) as any;
  if (!row) return null;
  const lvl = row.lvl as string;
  if (lvl === "view" || lvl === "edit" || lvl === "admin") return lvl;
  return null;
}

function requireKitAccess(min: Level) {
  return (req: Request, res: Response, next: NextFunction) => {
    const lvl = pitchLevelFor(req as any);
    if (!lvl) return res.status(403).json({ message: "Media Kit access required" });
    if (LEVELS[lvl] < LEVELS[min]) return res.status(403).json({ message: `Requires ${min} access` });
    next();
  };
}

// ─── Tokens & slugs ─────────────────────────────────────────────────────────
function genToken(len = 24): string {
  return crypto.randomBytes(len).toString("base64url").slice(0, len);
}
function genShareSlug(prospect: string): string {
  const safe = String(prospect || "share").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "share";
  // Timestamp (second precision) + 4-char random tail so multiple recipients
  // sent in the same second don't collide on slug. Base36 keeps it URL-clean.
  const stamp = Math.floor(Date.now() / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${safe}-${stamp}${rand}`;
}

// Mint a share slug guaranteed to be unique in media_kit_shares. Retries with
// a fresh random tail if a collision is ever detected.
function genUniqueShareSlug(prospect: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = genShareSlug(prospect);
    const clash = sqlite.prepare(`SELECT 1 FROM media_kit_shares WHERE slug = ? LIMIT 1`).get(candidate);
    if (!clash) return candidate;
  }
  // Ultimate fallback: append a long random suffix that will not collide.
  return `${genShareSlug(prospect)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Inheritance: when reading blocks for a regional kit, prefer the kit's
// own row; fall back to the canonical parent's row when missing. ─────────────
export function getEffectiveBlocks(kit_id: number): any[] {
  // Walk the kit → parent → grandparent chain so prospect-clones (which only override the
  // 'proposal' block) inherit everything else live from their parent regional kit, which
  // in turn inherits from the canonical Global kit.
  const chain: number[] = [];
  let cur: any = sqlite.prepare(`SELECT id, parent_kit_id FROM media_kits WHERE id = ?`).get(kit_id);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    chain.push(cur.id);
    seen.add(cur.id);
    cur = cur.parent_kit_id ? sqlite.prepare(`SELECT id, parent_kit_id FROM media_kits WHERE id = ?`).get(cur.parent_kit_id) : null;
  }
  if (chain.length === 0) return [];

  // Build effective map: first occurrence (most-specific kit) wins.
  const byKey = new Map<string, { row: any; ownerLevel: number }>();
  for (let i = 0; i < chain.length; i++) {
    const ownerId = chain[i];
    const rows = sqlite.prepare(`SELECT * FROM media_kit_blocks WHERE kit_id = ?`).all(ownerId) as any[];
    for (const r of rows) {
      if (!byKey.has(r.block_key)) {
        byKey.set(r.block_key, { row: r, ownerLevel: i });
      }
    }
  }

  const out: any[] = [];
  for (const [, v] of byKey) {
    const r = v.row;
    const inherited = v.ownerLevel > 0;
    out.push({
      ...r,
      kit_id,
      content: safeJson(r.content_json),
      source: inherited ? "inherited" : "own",
      inherited,
      is_override: inherited ? 0 : (r.is_override || 0),
    });
  }
  out.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // Apply per-kit block_order_override_json. Walk the inheritance chain so a
  // regional kit's override beats canonical, and a prospect clone's override
  // beats the regional. First non-null wins.
  let orderOverride: string[] | null = null;
  for (const ownerId of chain) {
    const k = sqlite.prepare(`SELECT block_order_override_json FROM media_kits WHERE id = ?`).get(ownerId) as any;
    if (k?.block_order_override_json) {
      try {
        const parsed = JSON.parse(k.block_order_override_json);
        if (Array.isArray(parsed) && parsed.length > 0) { orderOverride = parsed; break; }
      } catch { /* ignore bad JSON */ }
    }
  }
  if (orderOverride) {
    const orderIdx = new Map<string, number>();
    orderOverride.forEach((k, i) => orderIdx.set(k, i));
    out.sort((a, b) => {
      const ai = orderIdx.has(a.block_key) ? orderIdx.get(a.block_key)! : 9999 + (a.position ?? 0);
      const bi = orderIdx.has(b.block_key) ? orderIdx.get(b.block_key)! : 9999 + (b.position ?? 0);
      return ai - bi;
    });
  }
  return out;
}

function safeJson(s: string | null | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function loadAddonsForKit(kit_id: number, opts: { includeHidden?: boolean } = {}): { tiers: any[]; boltons: any[] } {
  const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(kit_id) as any;
  if (!kit) return { tiers: [], boltons: [] };
  const region = kit.region as string | null;
  const kind = kit.kind as string;

  // Trade kits: scope to region (or NULL for canonical/global) + audience_kind in ('trade','both')
  // Retailer kit: audience_kind in ('retailer','both'), region NULL
  const audienceClause = kind === "retailer"
    ? `(audience_kind = 'retailer' OR audience_kind = 'both')`
    : `(audience_kind = 'trade' OR audience_kind = 'both')`;
  const regionClause = region
    ? `region = '${region}'`
    : `region IS NULL`;
  // includeHidden flag is used by the admin AddonsTab so admins can find and
  // un-hide tiers/bolt-ons they previously hid. Public-facing reads always
  // filter on is_visible = 1.
  const visibilityClause = opts.includeHidden ? "" : " AND is_visible = 1";

  const rows = sqlite.prepare(
    `SELECT * FROM media_kit_addons WHERE ${audienceClause} AND ${regionClause}${visibilityClause} ORDER BY kind ASC, position ASC`
  ).all() as any[];

  let tiers = rows.filter(r => r.kind === "tier").map(addAddonHelpers);
  let boltons = rows.filter(r => r.kind === "bolton").map(addAddonHelpers);

  // Apply per-kit order override (used by prospect clones to reorder their addons
  // without mutating the shared regional master).
  const override = safeJson(kit.addon_order_override_json);
  if (override && typeof override === "object") {
    tiers = applyAddonOrderOverride(tiers, override.tier);
    boltons = applyAddonOrderOverride(boltons, override.bolton);
  }
  return { tiers, boltons };
}

function applyAddonOrderOverride(items: any[], orderKeys: any): any[] {
  if (!Array.isArray(orderKeys) || orderKeys.length === 0) return items;
  const indexOf = new Map<string, number>();
  orderKeys.forEach((k, i) => { if (typeof k === "string") indexOf.set(k, i); });
  // Stable sort: items present in the override come first (in override order),
  // followed by any items not in the override (in their original position order).
  const inOverride: any[] = [];
  const notInOverride: any[] = [];
  for (const item of items) {
    if (indexOf.has(item.addon_key)) inOverride.push(item);
    else notInOverride.push(item);
  }
  inOverride.sort((a, b) => (indexOf.get(a.addon_key)! - indexOf.get(b.addon_key)!));
  return [...inOverride, ...notInOverride];
}

function addAddonHelpers(r: any): any {
  return {
    ...r,
    inclusions: safeJson(r.inclusions_json),
  };
}

// ─── Default content for new block types ────────────────────────────────────
function defaultAudienceGrid(): any {
  return {
    heading: "Our Audience",
    subheading: "the audiophiles who actually buy",
    footer_note: "Sources: GA4 last 30 days · StereoNET Forum Survey n=540, May 2026 · Facebook Page Insights · Australian Bureau of Statistics",
    tiles: [
      { label: "Monthly readers", value: "700K+", note: "Active users, GA4 last 30 days" },
      { label: "Monthly page views", value: "1.4M+", note: "GA4 last 30 days" },
      { label: "Active forum community", value: "100K+", note: "Decades-deep audiophiles posting daily — the trusted core no competitor can match" },
      { label: "Audience aged 45+", value: "93%", note: "Peak discretionary-spending years" },
      { label: "Avg. disposable income, 40-somethings (AU)", value: "$55K+", note: "The buyers ready to spend now" },
      { label: "Audience in hobby 10+ years", value: "93%", note: "Informed, committed buyers · Forum survey n=540" },
      { label: "Social reach YTD 2026", value: "4.7M", note: "+74.9% YoY · Facebook Insights" },
      { label: "Avg. time on site", value: "1m 54s", note: "GA4 last 30 days — longer than typical hi-fi sites" },
      { label: "Rely on hi-fi sites + forums to research purchases", value: "37%", note: "Forum survey n=540" },
    ],
  };
}

function defaultFeaturedArticle(): any {
  return {
    enabled: true,
    eyebrow: "Our Position On Hi-Fi Buyers",
    headline: "My Generation: Why Hi-Fi Brands Are Chasing the Wrong Buyers",
    pull_quote: "The most successful businesses in any industry understand a fundamental truth: you build tomorrow's market share with today's revenue.",
    author: "Marc Rushton",
    author_role: "Publisher, StereoNET",
    published: "17 September 2025",
    cta_label: "Read the full opinion piece",
    url: "https://www.stereonet.com/opinion/my-generation-why-hi-fi-brands-are-chasing-the-wrong-buyers",
    intro_paragraph: "Forty-somethings in Australia have around $55,100 of discretionary income each year. Young Australians have closer to $30,000 — and most of that goes to phones, watches, and laptops, not hi-fi. The buyers who fund the audio industry are the ones we already reach.",
  };
}

function defaultResearchSources(): any {
  return {
    heading: "Where audiophiles research purchases",
    subheading: "Print collapsed. Reddit and AI didn't register. Our audience comes to hi-fi websites and forums.",
    footer_note: "StereoNET Forum Survey, May 2026. n=540 active forum members. Question: \"Today, when researching a hi-fi purchase, which sources do you rely on most?\"",
    show_highlight: true,
    highlight_label: "Combined: hi-fi websites + forums",
    highlight_pct: 37,
    sources: [
      { name: "Hi-fi websites & online publications", pct: 20, highlight: true },
      { name: "Forums & online communities", pct: 17, highlight: true },
      { name: "YouTube channels / video reviews", pct: 12 },
      { name: "Hi-fi shops & dealer demos", pct: 12 },
      { name: "Manufacturer websites & spec sheets", pct: 9 },
      { name: "Friends, family, colleagues", pct: 6 },
      { name: "Print magazines", pct: 4 },
      { name: "Measurements-focused sites (ASR etc.)", pct: 4 },
      { name: "AI tools (ChatGPT, Perplexity, Gemini, Claude)", pct: 2 },
      { name: "Reddit", pct: 1 },
      { name: "Social media (Instagram, TikTok, Facebook, X)", pct: 1 },
      { name: "Podcasts", pct: 0 },
    ],
  };
}

// ─── Backfill: add new block types to existing canonical kit ────────────────
// Idempotent. Safe to call on every server start. Inserts missing blocks only.
export function backfillNewBlocks() {
  const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
  if (!canonical) return;
  const canonicalId = canonical.id as number;

  const has = (key: string) =>
    !!sqlite.prepare(`SELECT 1 FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(canonicalId, key);

  // Refresh the legacy 'audience' block's heading/subheading if it still says 'four million'
  const legacyAudience = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'audience'`).get(canonicalId) as any;
  if (legacyAudience) {
    const cur = safeJson(legacyAudience.content_json) || {};
    const sub = String(cur.subheading || "");
    if (/four\s*million|four-million/i.test(sub) || /4,?000,?000/.test(sub) || /4\s*million/i.test(sub)) {
      cur.heading = "Global Reach, Regionally Targeted";
      cur.subheading = "where our 700K+ monthly readers live";
      sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ? WHERE kit_id = ? AND block_key = 'audience'`).run(JSON.stringify(cur), canonicalId);
      console.log(`[media-kit] Backfill: replaced legacy 'four million' subheading on audience block`);
    }
  }

  // First, renumber existing legacy blocks to make room for the new ones
  // Target final order: hero=1, who_are_we=2, why_us=3, audience=4, audience_grid=5,
  //   featured_article=6, research_sources=7, offer=8, investment=9, casual=10,
  //   boltons=11, ready=12, terms=13, contact=14
  const targetPositions: Record<string, number> = {
    hero: 1, who_are_we: 2, why_us: 3, audience: 4,
    audience_stats: 5,
    audience_grid: 6, featured_article: 7, research_sources: 8,
    offer: 9, investment: 10, casual: 11, boltons: 12,
    ready: 13, terms: 14, contact: 15,
  };
  for (const [key, pos] of Object.entries(targetPositions)) {
    sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE kit_id = ? AND block_key = ?`).run(pos, canonicalId, key);
  }

  let added = 0;
  if (!has("audience_stats")) {
    insertBlock(canonicalId, "audience_stats", 5, false, {
      heading: "The numbers brands want to see",
      subheading: "verified audience and AI visibility",
      footnote: "Actual human traffic only — bots filtered. Source data: Google Analytics 4 (audience), Cloudflare (AI bot traffic).",
    });
    added++;
  }
  if (!has("audience_grid")) {
    insertBlock(canonicalId, "audience_grid", 5, false, defaultAudienceGrid());
    added++;
  } else {
    // Refresh tile content to the latest defaults (only when admin hasn't customised)
    const existing = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'audience_grid'`).get(canonicalId) as any;
    const cur = existing ? safeJson(existing.content_json) : null;
    const looksDefaultish = cur && Array.isArray(cur.tiles) && cur.tiles.some((t: any) => t.label === "Audience aged 55+" || t.label === "Avg. session duration" || t.label === "New visitors monthly" || t.label === "Watch hi-fi YouTube monthly+");
    if (looksDefaultish) {
      insertBlock(canonicalId, "audience_grid", 5, false, defaultAudienceGrid());
      console.log(`[media-kit] Backfill: refreshed audience_grid tiles to latest defaults`);
    }
  }
  if (!has("featured_article")) {
    insertBlock(canonicalId, "featured_article", 6, false, defaultFeaturedArticle());
    added++;
  }
  if (!has("research_sources")) {
    insertBlock(canonicalId, "research_sources", 7, false, defaultResearchSources());
    added++;
  }
  if (added > 0) {
    console.log(`[media-kit] Backfill: added ${added} new block(s) to canonical trade kit (${canonicalId})`);
  }

  // Backfill: ensure Broadstreet zones are present on the canonical Trade kit's offer block.
  // Also: drop any region-specific 'offer' override that only existed to enable Broadstreet,
  // so regional kits inherit the canonical's zones cleanly.
  const STANDARD_ZONES = {
    enabled: true,
    masthead_enabled: false,
    billboard_zone: "49787",
    hpu_zone: "49786",
    mrec_zone: "82125",
    masthead_zone: "49790",
  };

  // 1. Canonical: patch the offer block with the standard zone IDs if missing
  const canonicalOfferRow = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'offer'`).get(canonicalId) as any;
  if (canonicalOfferRow) {
    const cur = safeJson(canonicalOfferRow.content_json) || {};
    const bs = cur.broadstreet || {};
    if (bs.billboard_zone !== "49787" || bs.hpu_zone !== "49786" || bs.mrec_zone !== "82125" || bs.masthead_zone !== "49790" || !bs.enabled) {
      cur.broadstreet = STANDARD_ZONES;
      sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ? WHERE kit_id = ? AND block_key = 'offer'`).run(JSON.stringify(cur), canonicalId);
      console.log(`[media-kit] Backfill: set Broadstreet zones on canonical Trade kit offer block`);
    }
  }

  // 2. One-time cleanup: remove the legacy ANZ offer-override that I just incorrectly
  //    added in a previous deploy. It was identical to the canonical except for the
  //    Broadstreet block. Now that the canonical has Broadstreet enabled, the override
  //    is redundant and would block inheritance of any future canonical edits.
  const legacyAnzOverride = sqlite.prepare(`
    SELECT b.id, b.content_json
    FROM media_kit_blocks b
    JOIN media_kits k ON k.id = b.kit_id
    WHERE b.block_key = 'offer' AND b.is_override = 1 AND k.region = 'anz' AND k.kind = 'trade'
  `).get() as any;
  if (legacyAnzOverride) {
    const cur = safeJson(legacyAnzOverride.content_json) || {};
    // Safety check: only remove if its broadstreet config matches the standard zones
    // (i.e. nothing else was customised on top).
    const bs = cur.broadstreet || {};
    const matchesStandard = bs.billboard_zone === "49787" && bs.hpu_zone === "49786" && bs.mrec_zone === "82125" && bs.masthead_zone === "49790";
    if (matchesStandard) {
      sqlite.prepare(`DELETE FROM media_kit_blocks WHERE id = ?`).run(legacyAnzOverride.id);
      console.log(`[media-kit] Backfill: removed legacy ANZ offer-override (now inherits canonical Broadstreet zones)`);
    }
  }
}

// ─── Seeding ────────────────────────────────────────────────────────────────
// Idempotent: seeds only when media_kits is empty.
export function seedMediaKitsIfEmpty() {
  const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM media_kits`).get() as any).n;
  if (n > 0) return;
  console.log("[media-kit] Seeding canonical Trade kit + 4 regional overrides + Retailer kit + addons");

  // 1. Canonical Trade kit
  const canonicalId = insertKit({
    slug: "trade-canonical",
    kind: "trade",
    region: null,
    is_canonical: 1,
    parent_kit_id: null,
    label: "StereoNET Trade Media Kit",
    subtitle: "Canonical (Global)",
    version_quarter: "Q1 2026",
    status: "published",
    base_currency: "USD",
    tax_suffix: "no tax",
    intro_text: "Established in 2003, StereoNET has evolved into a highly successful, respected publication and global brand.",
  });

  // Shared / canonical blocks
  insertBlock(canonicalId, "hero", 1, false, {
    region_label: "GLOBAL",
    quarter: "Q1 2026",
    background_image: "",
  });
  insertBlock(canonicalId, "who_are_we", 2, false, {
    heading: "Who Are We",
    subheading: "we are an extension of your marketing department",
    epigraph: "Energy and persistence conquer all things…",
    epigraph_attribution: "— Benjamin Franklin",
    paragraphs: [
      "Established in 2003, StereoNET has evolved into a highly successful, respected publication and global brand.",
      "Our team are spread across Southeast Asia, United Kingdom and wider Europe, and Australia. This reach allows us to have **strong relationships with the people that make the industry tick**, from retailers to distributors, manufacturers, and show organisers.",
      "StereoNET has become the **No.1 publication in Australia, UK and across Europe**. We are the most widely read publication in **Southeast Asia** (English language), and we are also emerging fast in **North America**. Statistically, readers spend two to five times longer on-site and read over twice as many pages as competing publications.",
      "In January 2025 we received a **Digital Top 100 Award** in the *Consumer Electronics* category, awarded 11th place as one of the **fastest growing digital brands globally** by analytics company *Similarweb*.",
      "Over two decades we've done the hard work to capture an engaged global audience of **over four million enthusiasts per month** and one of the highest global reaches of any comparable publication.",
    ],
  });
  insertBlock(canonicalId, "why_us", 3, false, {
    heading: "Why Us",
    epigraph: "We work harder, smarter, and we love it. It's our passion.",
    epigraph_attribution: "— Marc Rushton, StereoNET Founder",
    paragraphs: [
      "**We respect journalism.** We don't rely on influencers, AI, or affiliate marketing. We believe in writing the stories that matter, promoting the industry and its brands, and delivering results for our commercial partners.",
      "Our diverse and original editorial is headed up by **Global Editor-in-Chief, David Price**, supported by Regional Editors and one of the largest freelancer teams in the industry.",
      "We attract an attentive and engaged buying audience. Our readers look to us for **trustworthy reviews**, the latest news and information, and informed opinions on every aspect of hi-fi, home cinema, digital audio, headphones and more.",
      "You will find us at shows and events around the world, and you'll find no one else **working as hard as we do** to deliver what our partners and readers want.",
      "We use state of the art technology to deliver relevant content and advertising to the reader for specific regional markets, including — **North America**, **Australia and New Zealand**, **Southeast Asia**, and **UK and Europe**.",
      "Our unmatched audience was carefully **built over two decades** and we remain as loyal to them as they are to us.",
    ],
  });
  insertBlock(canonicalId, "audience", 4, false, {
    heading: "Global Reach, Regionally Targeted",
    subheading: "where our 700K+ monthly readers live",
    use_live_ga4: true,
    region_split: [
      { region: "Asia", pct: 38.34 },
      { region: "UK & Europe", pct: 25.50 },
      { region: "North America", pct: 20.76 },
      { region: "ANZ", pct: 13.19 },
    ],
  });
  insertBlock(canonicalId, "audience_grid", 5, false, defaultAudienceGrid());
  insertBlock(canonicalId, "featured_article", 6, false, defaultFeaturedArticle());
  insertBlock(canonicalId, "research_sources", 7, false, defaultResearchSources());
  insertBlock(canonicalId, "offer", 8, false, {
    heading: "What We Offer",
    intro: "We offer the essentials for your brand to cut through the noise, reach a new and relevant audience, and achieve return on your investment.",
    bullets: [
      { title: "Display Advertising — Every Page, Every Reader", body: "Your brand appears alongside every page our audience reads — billboards, sidebars, and in-content placements. Higher tiers buy more frequency and category exclusivity." },
      { title: "Editorial Priority for News and Promotions", body: "Relevant news from supplied press releases is generally turned around and published within 48 hours." },
      { title: "Up to 6 Product Reviews per Campaign", body: "Depending on marketing package selected, you will be entitled to a specific number of reviews per campaign. *Results not guaranteed.*" },
      { title: "Dedicated Brand and Distributor Pages", body: "Brand specific pages within our database showing distributors, retailers, social media links and more. Massive SEO benefits." },
      { title: "Commercial Membership of Forums (Optional)", body: "Treat the forums just like another social media platform, except this one directly targets a relevant audience." },
      { title: "Applause Awards and POTY Awards", body: "If your product achieves an Applause Award, there are no additional licensing fees and your product will be eligible for the annual POTY Awards." },
      { title: "Email and Social Media Promotions", body: "Additional options are available to promote to our subscriber database of over 200,000 trade and enthusiasts, or our social media platforms." },
    ],
    banner_specs: [
      { name: "Billboard", size: "970 × 250 pixels" },
      { name: "HPU", size: "300 × 600 pixels" },
      { name: "MREC", size: "300 × 250 pixels" },
    ],
    broadstreet: {
      enabled: true,
      masthead_enabled: false,
      billboard_zone: "49787",
      hpu_zone: "49786",
      mrec_zone: "82125",
      masthead_zone: "49790",
    },
    notes: [
      "Every banner set includes the three sizes above. Our system will deliver the appropriate banner for desktop, tablet and mobile use.",
      "We need a relevant URL for the destination of each banner.",
      "We accept JPG and Animated GIF, but HTML5 is the new \"norm\". Please engage a suitable designer where possible.",
      "**Geo-targeting** — We can build campaigns delivering different ads to different countries or regions.",
    ],
  });
  insertBlock(canonicalId, "investment", 9, false, {
    heading: "Your Investment",
    // tier rows are pulled from media_kit_addons keyed by region — see loadAddonsForKit
    show_tier_descriptors: true,
    show_discount_column: true,
    show_review_column: true,
  });
  insertBlock(canonicalId, "casual", 10, false, {
    heading: "Casual / Ad-hoc",
    subheading: "one time promotions to get your message seen and heard",
    enabled: true, // canonical has it; regional kits inherit
    price: "USD $4,999",
    price_period: "/ 3 months",
    body: "Great for product launches. But Bronze partners get 2× the impressions, priority review scheduling, and partner discounts on bolt-ons.\n\nNeed to run a special promotion around a product launch? Our Casual (3 Months) plan will suit your budget.",
    bullets: [
      { title: "Display Advertising (Triple Banner Set)", body: "Weighting at SILVER level." },
      { title: "Editorial Priority for News and Promotions", body: "Relevant news from supplied press releases is generally turned around and published within 48 hours." },
      { title: "One Product Review (or Feature) Included", body: "You will be entitled to one review per campaign. *Results not guaranteed.*" },
      { title: "Dedicated Brand and Distributor Pages", body: "Brand specific pages within our database showing distributors, retailers, social media links and more. Massive SEO benefits." },
      { title: "Much More", body: "Put us to the test and see what can be achieved within 3 months, before committing to the better value ongoing plans." },
    ],
    footer: "Our Casual (3 Months) plans can only be booked once per company in any 12 months period.",
  });
  insertBlock(canonicalId, "boltons", 11, false, {
    heading: "Bolt-on Promos",
    subheading: "bolster your campaign with additional exposure",
    // bolt-ons are pulled from media_kit_addons keyed by region
  });
  insertBlock(canonicalId, "ready", 12, false, {
    heading: "Are You Ready?",
    subheading: "we deliver next-gen marketing for next-gen brands",
    epigraph: "We are ready to work with you and amplify your brand.",
    paragraphs: [
      "Our team has helped build brands from the ground up. From the one-person speaker manufacturer to the multi-national household names — for more than twenty years **we've worked with them all**.",
      "We applied all we know to growing our own brand to what it is today and we used the very **same techniques and services we can provide you**.",
      "If you're looking for a new distributor in a certain region, or want to open more retail outlets and dealers, or perhaps you're looking for more brand awareness or direct sales, **we have the solutions and the audience**.",
      "We can tailor a campaign to your needs and deliver genuine and measurable results with **state of the art reporting and analytics**.",
      "All that's left to do is to reach out to discuss your goals, and the most relevant options for your budget to achieve return on investment for your brand.",
    ],
    cta_label: "Build my proposal",
    cta_enabled: true,
  });
  insertBlock(canonicalId, "terms", 13, false, {
    heading: "Terms & Conditions",
    bullets: [
      "All contracts are for a minimum of 6 months then ongoing and flexible with one month's notice.",
      "Clients are responsible for providing Press Releases and proposing reviews within the contract period. Allocated ads, reviews, bonuses, etc., are only valid within the contract period and do not carry forward.",
      "We love helping our partners, but we are a publisher, not a marketing or ad agency. We do not offer design services however we can recommend some. We cannot write your press releases for you or run your review schedule. We aim to run PR and news releases within 48 hours of receipt where possible, but this is not guaranteed.",
      "Reviews must be planned with your regional editor and run on a 6-8 week cycle from delivery. Product reviews may be carried out by our team in any of our global locations.",
    ],
  });
  insertBlock(canonicalId, "contact", 14, false, {
    heading: "Contact",
    publisher: "Global",
    publisher_name: "Marc Rushton",
    publisher_email: "marcrushton@stereonet.com",
    ad_copy_email: "admin@stereonet.com",
    company: "Sound Media International Pty Ltd",
    managing_director: "Marc Rushton",
    md_email: "marcrushton@stereonet.com",
  });

  // 2. Regional Trade kits (inherit canonical, only override what differs)
  const regionalDefs = [
    {
      slug: "trade-anz",
      region: "anz" as const,
      label: "StereoNET ANZ Trade",
      subtitle: "Australia & New Zealand",
      base_currency: "AUD",
      tax_suffix: "ex GST",
      hero_region_label: "AUSTRALIA & NEW ZEALAND",
    },
    {
      slug: "trade-uk-eu",
      region: "uk_eu" as const,
      label: "StereoNET UK & EU Trade",
      subtitle: "United Kingdom & Europe",
      base_currency: "GBP",
      tax_suffix: "no tax",
      hero_region_label: "UK & EUROPE",
    },
    {
      slug: "trade-asia",
      region: "asia" as const,
      label: "StereoNET Asia Trade",
      subtitle: "Southeast Asia",
      base_currency: "USD",
      tax_suffix: "no tax",
      hero_region_label: "SOUTHEAST ASIA",
    },
    {
      slug: "trade-na",
      region: "na" as const,
      label: "StereoNET North America Trade",
      subtitle: "United States & Canada",
      base_currency: "USD",
      tax_suffix: "no tax",
      hero_region_label: "NORTH AMERICA",
    },
  ];

  for (const r of regionalDefs) {
    const id = insertKit({
      slug: r.slug,
      kind: "trade",
      region: r.region,
      is_canonical: 0,
      parent_kit_id: canonicalId,
      label: r.label,
      subtitle: r.subtitle,
      version_quarter: "Q1 2026",
      status: "published",
      base_currency: r.base_currency,
      tax_suffix: r.tax_suffix,
      intro_text: null,
    });
    // Hero override (region label)
    insertBlock(id, "hero", 1, true, {
      region_label: r.hero_region_label,
      quarter: "Q1 2026",
      background_image: "",
    });
    // Regional kits inherit Broadstreet zones from canonical (enabled there by default).
    // Investment + boltons inherit position only; addons pull from media_kit_addons by region
  }

  // 3. Retailer kit (single, USD base, no regional overrides)
  const retailerId = insertKit({
    slug: "retailer-global",
    kind: "retailer",
    region: null,
    is_canonical: 1,
    parent_kit_id: null,
    label: "StereoNET Retailer Media Kit",
    subtitle: "Global · USD with live FX",
    version_quarter: "Q1 2026",
    status: "draft", // Marc to flesh out
    base_currency: "USD",
    tax_suffix: "no tax",
    intro_text: "Exclusively for retail outlets. One kit, one price catalogue (USD), live currency conversion for prospects.",
  });
  insertBlock(retailerId, "hero", 1, false, {
    region_label: "RETAILER · GLOBAL",
    quarter: "Q1 2026",
    background_image: "",
  });
  insertBlock(retailerId, "who_are_we", 2, false, safeJson(getCanonicalBlockJson(canonicalId, "who_are_we")));
  insertBlock(retailerId, "why_us", 3, false, safeJson(getCanonicalBlockJson(canonicalId, "why_us")));
  insertBlock(retailerId, "audience", 4, false, safeJson(getCanonicalBlockJson(canonicalId, "audience")));
  insertBlock(retailerId, "offer", 5, false, safeJson(getCanonicalBlockJson(canonicalId, "offer")));
  insertBlock(retailerId, "investment", 6, false, { heading: "Your Investment", show_tier_descriptors: true, show_discount_column: true, show_review_column: true, currency_picker: true });
  insertBlock(retailerId, "boltons", 7, false, { heading: "Bolt-on Promos", subheading: "bolster your campaign with additional exposure" });
  insertBlock(retailerId, "ready", 8, false, safeJson(getCanonicalBlockJson(canonicalId, "ready")));
  insertBlock(retailerId, "terms", 9, false, safeJson(getCanonicalBlockJson(canonicalId, "terms")));
  insertBlock(retailerId, "contact", 10, false, safeJson(getCanonicalBlockJson(canonicalId, "contact")));

  seedAddons();
  console.log("[media-kit] Seed complete");
}

function insertKit(k: any): number {
  const r = sqlite.prepare(`
    INSERT INTO media_kits (slug, kind, region, is_canonical, parent_kit_id, label, subtitle, version_quarter, status, base_currency, tax_suffix, intro_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(k.slug, k.kind, k.region, k.is_canonical, k.parent_kit_id, k.label, k.subtitle, k.version_quarter, k.status, k.base_currency, k.tax_suffix, k.intro_text);
  return Number(r.lastInsertRowid);
}

function insertBlock(kit_id: number, key: string, position: number, is_override: boolean, content: any) {
  sqlite.prepare(`
    INSERT OR REPLACE INTO media_kit_blocks (kit_id, block_key, position, is_override, content_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(kit_id, key, position, is_override ? 1 : 0, JSON.stringify(content));
}

function getCanonicalBlockJson(kit_id: number, key: string): string {
  const r = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(kit_id, key) as any;
  return r?.content_json || "{}";
}

function seedAddons() {
  // Tier rows: one per (region, tier_key). Region NULL = canonical/global trade.
  const tiers = [
    // Canonical/Global Trade (USD)
    { region: null, audience_kind: "trade", addon_key: "partner",  label: "Partner",  subtitle: "Suited to start-ups and smaller manufacturers.", price: 499,  pos: 1, incl: tierIncl({ banners: 0, weight: 0,   reviews: 0, discount: 0,  forum: true,  classifieds: true }) },
    { region: null, audience_kind: "trade", addon_key: "bronze",   label: "Bronze",   subtitle: "Single brand distributors or established local manufacturers.", price: 2499, pos: 2, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 2, discount: 0,  forum: true,  classifieds: true }) },
    { region: null, audience_kind: "trade", addon_key: "silver",   label: "Silver",   subtitle: "Suited to medium sized multi-brand distributors.", price: 3999, pos: 3, incl: tierIncl({ banners: 2, weight: 1,   reviews: 4, discount: 5,  forum: true,  classifieds: true }) },
    { region: null, audience_kind: "trade", addon_key: "gold",     label: "Gold",     subtitle: "Suited for large portfolio multi-brand distributors.", price: 5499, pos: 4, incl: tierIncl({ banners: 3, weight: 1.5, reviews: 6, discount: 10, forum: true,  classifieds: true }) },
    { region: null, audience_kind: "trade", addon_key: "platinum", label: "Platinum", subtitle: "Maximum exposure across all brands for ultra large portfolios.", price: null, pos: 5, poa: true, incl: tierIncl({ banners: "custom", weight: "2+", reviews: "6+ custom", discount: 15, forum: true, classifieds: true }) },

    // ANZ Trade (AUD ex GST)
    { region: "anz", audience_kind: "trade", addon_key: "partner",  label: "Partner",  subtitle: "Suited to start-ups and smaller manufacturers.", price: 499,  currency: "AUD", suffix: "ex GST", pos: 1, incl: tierIncl({ banners: 0, weight: 0,   reviews: 0, discount: 0,  forum: true, classifieds: true }) },
    { region: "anz", audience_kind: "trade", addon_key: "bronze",   label: "Bronze",   subtitle: "Single brand distributors or established local manufacturers.", price: 1499, currency: "AUD", suffix: "ex GST", pos: 2, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 2, discount: 0,  forum: true, classifieds: true }) },
    { region: "anz", audience_kind: "trade", addon_key: "silver",   label: "Silver",   subtitle: "Suited to medium sized multi-brand distributors.", price: 2799, currency: "AUD", suffix: "ex GST", pos: 3, incl: tierIncl({ banners: 2, weight: 1,   reviews: 4, discount: 5,  forum: true, classifieds: true }) },
    { region: "anz", audience_kind: "trade", addon_key: "gold",     label: "Gold",     subtitle: "Suited for large portfolio multi-brand distributors.", price: 3999, currency: "AUD", suffix: "ex GST", pos: 4, incl: tierIncl({ banners: 3, weight: 1.5, reviews: 6, discount: 10, forum: true, classifieds: true }) },
    { region: "anz", audience_kind: "trade", addon_key: "platinum", label: "Platinum", subtitle: "Maximum exposure across all brands for ultra large portfolios.", price: null, currency: "AUD", suffix: "ex GST", pos: 5, poa: true, incl: tierIncl({ banners: "custom", weight: "2+", reviews: "custom", discount: 15, forum: true, classifieds: true }) },

    // UK & EU Trade (GBP no tax) — 4 tiers, no Partner
    { region: "uk_eu", audience_kind: "trade", addon_key: "bronze",   label: "Bronze",   subtitle: "Best suited to small local market manufacturers.", price: 499,  currency: "GBP", suffix: "no tax", pos: 1, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 2, discount: 0,  forum: true, classifieds: true }) },
    { region: "uk_eu", audience_kind: "trade", addon_key: "silver",   label: "Silver",   subtitle: "Best suited to smaller multi-brand distributors.", price: 649,  currency: "GBP", suffix: "no tax", pos: 2, incl: tierIncl({ banners: 2, weight: 1,   reviews: 4, discount: 5,  forum: true, classifieds: true }) },
    { region: "uk_eu", audience_kind: "trade", addon_key: "gold",     label: "Gold",     subtitle: "Best suited to larger multi-brand distributors.", price: 949,  currency: "GBP", suffix: "no tax", pos: 3, incl: tierIncl({ banners: 3, weight: 1.5, reviews: 6, discount: 10, forum: true, classifieds: true }) },
    { region: "uk_eu", audience_kind: "trade", addon_key: "platinum", label: "Platinum", subtitle: "Large brand portfolios for equal brand exposure.", price: null, currency: "GBP", suffix: "no tax", pos: 4, poa: true, incl: tierIncl({ banners: "custom", weight: "2+", reviews: "6+ custom", discount: 15, forum: true, classifieds: true }) },

    // Asia Trade (USD primary, SGD secondary) — 4 tiers: Partner, Silver, Gold, Custom
    { region: "asia", audience_kind: "trade", addon_key: "partner",  label: "Partner",  subtitle: "Best suited to start-ups and smaller manufacturers.", price: 300,  currency: "USD", suffix: "no tax", pos: 1, incl: tierIncl({ banners: 0, weight: 0,   reviews: 0, discount: 0,  forum: true, classifieds: true }) },
    { region: "asia", audience_kind: "trade", addon_key: "silver",   label: "Silver",   subtitle: "Smaller multi-brand distributors.", price: 600,  currency: "USD", suffix: "no tax", pos: 2, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 2, discount: 0,  forum: true, classifieds: true }) },
    { region: "asia", audience_kind: "trade", addon_key: "gold",     label: "Gold",     subtitle: "Larger multi-brand distributors.", price: 1000, currency: "USD", suffix: "no tax", pos: 3, incl: tierIncl({ banners: 2, weight: 1,   reviews: 4, discount: 5,  forum: true, classifieds: true }) },
    { region: "asia", audience_kind: "trade", addon_key: "custom",   label: "Custom",   subtitle: "Bespoke campaigns.", price: null, currency: "USD", suffix: "no tax", pos: 4, poa: true, incl: tierIncl({ banners: "custom", weight: "2+", reviews: "6+ custom", discount: 10, forum: true, classifieds: true }) },

    // North America Trade (USD no tax) — 5 tiers
    { region: "na", audience_kind: "trade", addon_key: "partner",  label: "Partner",  subtitle: "Suited to start-ups and smaller manufacturers.", price: 299,  currency: "USD", suffix: "no tax", pos: 1, incl: tierIncl({ banners: 0, weight: 0,   reviews: 0, discount: 0,  forum: true, classifieds: true }) },
    { region: "na", audience_kind: "trade", addon_key: "bronze",   label: "Bronze",   subtitle: "Single brand distributors or established local manufacturers.", price: 899,  currency: "USD", suffix: "no tax", pos: 2, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 2, discount: 0,  forum: true, classifieds: true }) },
    { region: "na", audience_kind: "trade", addon_key: "silver",   label: "Silver",   subtitle: "Medium sized multi-brand distributors.", price: 1699, currency: "USD", suffix: "no tax", pos: 3, incl: tierIncl({ banners: 2, weight: 1,   reviews: 4, discount: 5,  forum: true, classifieds: true }) },
    { region: "na", audience_kind: "trade", addon_key: "gold",     label: "Gold",     subtitle: "Large portfolio multi-brand distributors.", price: 2499, currency: "USD", suffix: "no tax", pos: 4, incl: tierIncl({ banners: 3, weight: 1.5, reviews: 6, discount: 10, forum: true, classifieds: true }) },
    { region: "na", audience_kind: "trade", addon_key: "platinum", label: "Platinum", subtitle: "Maximum exposure across all brands.", price: null, currency: "USD", suffix: "no tax", pos: 5, poa: true, incl: tierIncl({ banners: "custom", weight: "2+", reviews: "6+ custom", discount: 15, forum: true, classifieds: true }) },

    // Retailer (USD) — placeholder; Marc to flesh out
    { region: null, audience_kind: "retailer", addon_key: "starter",   label: "Starter",   subtitle: "Single-location retailers.", price: 199,  currency: "USD", suffix: "no tax", pos: 1, incl: tierIncl({ banners: 1, weight: 0.5, reviews: 0, discount: 0, forum: true, classifieds: true }) },
    { region: null, audience_kind: "retailer", addon_key: "growth",    label: "Growth",    subtitle: "Multi-location retail.", price: 399,  currency: "USD", suffix: "no tax", pos: 2, incl: tierIncl({ banners: 2, weight: 1,   reviews: 0, discount: 5, forum: true, classifieds: true }) },
    { region: null, audience_kind: "retailer", addon_key: "premier",   label: "Premier",   subtitle: "Flagship retail partners.", price: 799,  currency: "USD", suffix: "no tax", pos: 3, incl: tierIncl({ banners: 3, weight: 1.5, reviews: 0, discount: 10, forum: true, classifieds: true }) },
  ];

  const tierStmt = sqlite.prepare(`
    INSERT INTO media_kit_addons (kind, addon_key, region, audience_kind, label, subtitle, description, price_value, price_currency, price_suffix, billing, inclusions_json, availability, position, is_poa, is_visible)
    VALUES ('tier', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'monthly', ?, 'available', ?, ?, 1)
  `);
  for (const t of tiers as any[]) {
    tierStmt.run(
      t.addon_key, t.region, t.audience_kind, t.label, t.subtitle, null,
      t.price ?? null, t.currency || "USD", t.suffix || "no tax",
      JSON.stringify(t.incl), t.pos, t.poa ? 1 : 0,
    );
  }

  // Bolt-on rows
  const boltons = [
    // Global / canonical (USD)
    { region: null, addon_key: "masthead",                 label: "Masthead Advertisement", description: "Powerful ad position at the very top of every page. Highest performing display ad. Max 4 / month in rotation.",                                price: 999,  currency: "USD", billing: "monthly", suffix: "/month",  availability: "not_available", pos: 1 },
    { region: null, addon_key: "masthead_3m",              label: "Masthead — 3 Month Special",                                  description: "Three-month booking discount on the Masthead position.",                                                          price: 2499, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "not_available", pos: 2 },
    { region: null, addon_key: "diamond_banner",           label: "Exclusive Diamond Banner",  description: "Exclusive (one-only) banner shown directly below every article. This position is not shared with any other advertiser for the duration.", price: 3499, currency: "USD", billing: "monthly", suffix: "/month",  availability: "not_available", pos: 3 },
    { region: null, addon_key: "diamond_banner_3m",        label: "Exclusive Diamond Banner — 3 Month Special", description: "Three-month booking discount on the Exclusive Diamond Banner.",                                                                price: 8999, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "not_available", pos: 4 },
    { region: null, addon_key: "newsletter_banner",        label: "Newsletter Banners",        description: "Feature your brand at the top and bottom of our regular newsletter updates. Banners (600×300px) click through to provided URL.",          price: 2999, currency: "USD", billing: "one_off", suffix: "per email", availability: "available", pos: 5 },
    { region: null, addon_key: "social_boost_7d",          label: "Social Media Boosts — 7 days",        description: "Promote your review or news story as a paid boosted post across our Meta audiences. 7-day campaign.",                              price: 999,  currency: "USD", billing: "one_off", suffix: "7 days",  availability: "available", pos: 6 },
    { region: null, addon_key: "social_boost_14d",         label: "Social Media Boosts — 14 days",       description: "14-day Meta boost campaign across StereoNET's refined lookalike audiences.",                                                        price: 1499, currency: "USD", billing: "one_off", suffix: "14 days", availability: "available", pos: 7 },
    { region: null, addon_key: "social_boost_1m",          label: "Social Media Boosts — 1 month",       description: "One-month Meta boost campaign.",                                                                                                  price: 2799, currency: "USD", billing: "one_off", suffix: "1 month", availability: "available", pos: 8 },
    { region: null, addon_key: "brand_profile_meets",      label: "Featured Brand Profile — StereoNET Meets", description: "Short feature article (1000 words) from a telephone/Zoom or email interview.",                                                price: 1499, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 9 },
    { region: null, addon_key: "brand_profile_inside",     label: "Featured Brand Profile — Inside Track",    description: "Long-form feature (3000 words) from a telephone/Zoom interview, email interview, or in person where possible.",              price: 3499, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 10 },
    { region: null, addon_key: "edm_newsletter",           label: "Exclusive EDM Newsletter",                 description: "Send an Exclusive Email headlining your promotion to our 200,000+ enthusiast subscriber base.",                                price: 2999, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 11 },

    // ANZ (AUD)
    { region: "anz", addon_key: "masthead",                label: "Masthead Advertisement", description: "Powerful ad position at the top of every page. Max 4 / month in rotation.",   price: 1499, currency: "AUD", billing: "monthly", suffix: "/month",  availability: "sold_out", pos: 1 },
    { region: "anz", addon_key: "masthead_3m",             label: "Masthead — 3 Month Special",         description: "3-month discount.",                                                  price: 3699, currency: "AUD", billing: "3_month", suffix: "/3 months", availability: "sold_out", pos: 2 },
    { region: "anz", addon_key: "diamond_banner",          label: "Exclusive Diamond Banner",           description: "Exclusive banner under every article.",                              price: 2499, currency: "AUD", billing: "monthly", suffix: "/month",  availability: "sold_out", pos: 3 },
    { region: "anz", addon_key: "diamond_banner_3m",       label: "Exclusive Diamond Banner — 3 Month Special", description: "3-month discount.",                                          price: 5999, currency: "AUD", billing: "3_month", suffix: "/3 months", availability: "sold_out", pos: 4 },
    { region: "anz", addon_key: "newsletter_banner",       label: "Newsletter Banners",                 description: "Top/bottom of regular newsletter (600×300px).",                      price: 2499, currency: "AUD", billing: "one_off", suffix: "per email", availability: "available", pos: 5 },
    { region: "anz", addon_key: "social_boost_7d",         label: "Social Media Boosts — 7 days",       description: "Meta boost campaign.",                                              price: 999,  currency: "AUD", billing: "one_off", suffix: "7 days",  availability: "available", pos: 6 },
    { region: "anz", addon_key: "social_boost_14d",        label: "Social Media Boosts — 14 days",      description: "Meta boost campaign.",                                              price: 1499, currency: "AUD", billing: "one_off", suffix: "14 days", availability: "available", pos: 7 },
    { region: "anz", addon_key: "social_boost_1m",         label: "Social Media Boosts — 1 month",      description: "Meta boost campaign.",                                              price: 2799, currency: "AUD", billing: "one_off", suffix: "1 month", availability: "available", pos: 8 },
    { region: "anz", addon_key: "brand_profile_meets",     label: "Featured Brand Profile — StereoNET Meets", description: "1000 words.",                                                  price: 1499, currency: "AUD", billing: "one_off", suffix: "each",    availability: "available", pos: 9 },
    { region: "anz", addon_key: "brand_profile_inside",    label: "Featured Brand Profile — Inside Track",    description: "3000 words.",                                                  price: 3499, currency: "AUD", billing: "one_off", suffix: "each",    availability: "available", pos: 10 },
    { region: "anz", addon_key: "edm_newsletter",          label: "Exclusive EDM Newsletter",                 description: "200k+ subscriber base.",                                       price: 2999, currency: "AUD", billing: "one_off", suffix: "each",    availability: "available", pos: 11 },

    // UK (GBP)
    { region: "uk_eu", addon_key: "masthead",              label: "Masthead Advertisement",             description: "Powerful ad position.",                                                                                          price: 699,  currency: "GBP", billing: "monthly", suffix: "/month",  availability: "available", pos: 1 },
    { region: "uk_eu", addon_key: "masthead_3m",           label: "Masthead — 3 Month Special",         description: "3-month discount.",                                                                                              price: 1749, currency: "GBP", billing: "3_month", suffix: "/3 months", availability: "available", pos: 2 },
    { region: "uk_eu", addon_key: "diamond_banner",        label: "Exclusive Diamond Banner",           description: "Exclusive banner under every article.",                                                                          price: 999,  currency: "GBP", billing: "monthly", suffix: "/month",  availability: "available", pos: 3 },
    { region: "uk_eu", addon_key: "diamond_banner_3m",     label: "Exclusive Diamond Banner — 3 Month Special", description: "3-month discount.",                                                                                      price: 2499, currency: "GBP", billing: "3_month", suffix: "/3 months", availability: "available", pos: 4 },
    { region: "uk_eu", addon_key: "newsletter_banner",     label: "Newsletter Banners",                 description: "Top/bottom of regular newsletter.",                                                                              price: 499,  currency: "GBP", billing: "one_off", suffix: "per email", availability: "available", pos: 5 },
    { region: "uk_eu", addon_key: "social_boost_7d",       label: "Social Media Boosts — 7 days",       description: "Meta boost.",                                                                                                    price: 749,  currency: "GBP", billing: "one_off", suffix: "7 days",  availability: "available", pos: 6 },
    { region: "uk_eu", addon_key: "social_boost_14d",      label: "Social Media Boosts — 14 days",      description: "Meta boost.",                                                                                                    price: 1099, currency: "GBP", billing: "one_off", suffix: "14 days", availability: "available", pos: 7 },
    { region: "uk_eu", addon_key: "social_boost_1m",       label: "Social Media Boosts — 1 month",      description: "Meta boost.",                                                                                                    price: 1999, currency: "GBP", billing: "one_off", suffix: "1 month", availability: "available", pos: 8 },
    { region: "uk_eu", addon_key: "brand_profile_meets",   label: "Featured Brand Profile — StereoNET Meets", description: "1000 words.",                                                                                              price: 1099, currency: "GBP", billing: "one_off", suffix: "each",    availability: "available", pos: 9 },
    { region: "uk_eu", addon_key: "brand_profile_inside",  label: "Featured Brand Profile — Inside Track",    description: "3000 words.",                                                                                              price: 2499, currency: "GBP", billing: "one_off", suffix: "each",    availability: "available", pos: 10 },
    { region: "uk_eu", addon_key: "edm_newsletter",        label: "Exclusive EDM Newsletter",                 description: "Subscriber base.",                                                                                          price: 2199, currency: "GBP", billing: "one_off", suffix: "each",    availability: "available", pos: 11 },

    // Asia (USD)
    { region: "asia", addon_key: "masthead",               label: "Masthead Advertisement",             description: "Powerful ad position.",                                                                                          price: 700,  currency: "USD", billing: "monthly", suffix: "/month",  availability: "coming_soon", pos: 1 },
    { region: "asia", addon_key: "masthead_3m",            label: "Masthead — 3 Month Special",         description: "3-month discount.",                                                                                              price: 1700, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "coming_soon", pos: 2 },
    { region: "asia", addon_key: "diamond_banner",         label: "Exclusive Diamond Banner",           description: "Exclusive banner under every article.",                                                                          price: 400,  currency: "USD", billing: "monthly", suffix: "/month",  availability: "available", pos: 3 },
    { region: "asia", addon_key: "diamond_banner_3m",      label: "Exclusive Diamond Banner — 3 Month Special", description: "3-month discount.",                                                                                      price: 1000, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "available", pos: 4 },
    { region: "asia", addon_key: "newsletter_banner",      label: "Newsletter Banners",                 description: "Top/bottom of regular newsletter.",                                                                              price: 400,  currency: "USD", billing: "one_off", suffix: "per email", availability: "available", pos: 5 },
    { region: "asia", addon_key: "social_boost_7d",        label: "Social Media Boosts — 7 days",       description: "Meta boost.",                                                                                                    price: 600,  currency: "USD", billing: "one_off", suffix: "7 days",  availability: "available", pos: 6 },
    { region: "asia", addon_key: "social_boost_14d",       label: "Social Media Boosts — 14 days",      description: "Meta boost.",                                                                                                    price: 900,  currency: "USD", billing: "one_off", suffix: "14 days", availability: "available", pos: 7 },
    { region: "asia", addon_key: "social_boost_1m",        label: "Social Media Boosts — 1 month",      description: "Meta boost.",                                                                                                    price: 1700, currency: "USD", billing: "one_off", suffix: "1 month", availability: "available", pos: 8 },
    { region: "asia", addon_key: "brand_profile_meets",    label: "Featured Brand Profile — StereoNET Meets", description: "1000 words.",                                                                                              price: 900,  currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 9 },
    { region: "asia", addon_key: "brand_profile_inside",   label: "Featured Brand Profile — Inside Track",    description: "3000 words.",                                                                                              price: 2100, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 10 },
    { region: "asia", addon_key: "edm_newsletter",         label: "Exclusive EDM Newsletter",                 description: "Subscriber base.",                                                                                          price: 1800, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 11 },

    // NA (USD)
    { region: "na", addon_key: "masthead",                 label: "Masthead Advertisement",             description: "Powerful ad position.",                                                                                          price: 999,  currency: "USD", billing: "monthly", suffix: "/month",  availability: "coming_soon", pos: 1 },
    { region: "na", addon_key: "masthead_3m",              label: "Masthead — 3 Month Special",         description: "3-month discount.",                                                                                              price: 2499, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "coming_soon", pos: 2 },
    { region: "na", addon_key: "diamond_banner",           label: "Exclusive Diamond Banner",           description: "Exclusive banner under every article.",                                                                          price: 1499, currency: "USD", billing: "monthly", suffix: "/month",  availability: "available", pos: 3 },
    { region: "na", addon_key: "diamond_banner_3m",        label: "Exclusive Diamond Banner — 3 Month Special", description: "3-month discount.",                                                                                      price: 3999, currency: "USD", billing: "3_month", suffix: "/3 months", availability: "available", pos: 4 },
    { region: "na", addon_key: "newsletter_banner",        label: "Newsletter Banners",                 description: "Top/bottom of regular newsletter.",                                                                              price: 1499, currency: "USD", billing: "one_off", suffix: "per email", availability: "available", pos: 5 },
    { region: "na", addon_key: "social_boost_7d",          label: "Social Media Boosts — 7 days",       description: "Meta boost.",                                                                                                    price: 999,  currency: "USD", billing: "one_off", suffix: "7 days",  availability: "available", pos: 6 },
    { region: "na", addon_key: "social_boost_14d",         label: "Social Media Boosts — 14 days",      description: "Meta boost.",                                                                                                    price: 1499, currency: "USD", billing: "one_off", suffix: "14 days", availability: "available", pos: 7 },
    { region: "na", addon_key: "social_boost_1m",          label: "Social Media Boosts — 1 month",      description: "Meta boost.",                                                                                                    price: 2799, currency: "USD", billing: "one_off", suffix: "1 month", availability: "available", pos: 8 },
    { region: "na", addon_key: "brand_profile_meets",      label: "Featured Brand Profile — StereoNET Meets", description: "1000 words.",                                                                                              price: 1499, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 9 },
    { region: "na", addon_key: "brand_profile_inside",     label: "Featured Brand Profile — Inside Track",    description: "3000 words.",                                                                                              price: 3499, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 10 },
    { region: "na", addon_key: "edm_newsletter",           label: "Exclusive EDM Newsletter",                 description: "Subscriber base.",                                                                                          price: 2999, currency: "USD", billing: "one_off", suffix: "each",    availability: "available", pos: 11 },
  ];

  const boltStmt = sqlite.prepare(`
    INSERT INTO media_kit_addons (kind, addon_key, region, audience_kind, label, subtitle, description, price_value, price_currency, price_suffix, billing, availability, position, is_visible)
    VALUES ('bolton', ?, ?, 'both', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const b of boltons) {
    boltStmt.run(b.addon_key, b.region, b.label, b.description, b.price, b.currency, b.suffix, b.billing, b.availability, b.pos);
  }
}

function tierIncl(o: any): any {
  return {
    banners: o.banners ?? 0,
    ad_weighting: o.weight ?? 0,
    reviews_per_year: o.reviews ?? 0,
    discount_pct: o.discount ?? 0,
    news_pr: true,
    newsletter_social: true,
    brand_distributor_pages: true,
    exclusive_forum: o.forum ?? true,
    classifieds_access: o.classifieds ?? true,
    ai_discoverability: true,
  };
}

// ─── Express routes ─────────────────────────────────────────────────────────
export function registerMediaKitRoutes(app: Express) {
  seedMediaKitsIfEmpty();
  backfillNewBlocks();

  // List all kits (admin)
  app.get("/api/media-kit/kits", requireKitAccess("view"), (req: any, res) => {
    // By default, hide per-prospect clones AND wizard preview clones from the
    // main Media Kits list. Preview clones are tagged with an
    // `internal-preview-*` slug by /api/pitch/preview-kit, and per-prospect
    // clones carry a prospect_lead_id. Pass ?include_prospects=1 to show them.
    // PITCH proposal clones (Phase A) link via pitch_proposals.media_kit_id so
    // we filter those out by their id appearing in that column — they're not
    // standalone kits the editor needs to manage.
    const includeProspects = req.query?.include_prospects === "1";
    const baseFilter = "slug NOT LIKE 'internal-preview-%' AND id NOT IN (SELECT media_kit_id FROM pitch_proposals WHERE media_kit_id IS NOT NULL)";
    const sql = includeProspects
      ? `SELECT * FROM media_kits WHERE ${baseFilter} ORDER BY kind ASC, is_canonical DESC, region ASC, id ASC`
      : `SELECT * FROM media_kits WHERE prospect_lead_id IS NULL AND ${baseFilter} ORDER BY kind ASC, is_canonical DESC, region ASC, id ASC`;
    const rows = sqlite.prepare(sql).all();
    res.json({ kits: rows });
  });

  // Get-or-create an internal preview share for this kit (admin only).
  // Returns a stable URL the admin can use to view the kit publicly without a prospect lead.
  app.post("/api/media-kit/kits/:id/preview-share", requireKitAccess("edit"), (req, res) => {
    const id = Number(req.params.id);
    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    // Re-use existing preview share if present + still active.
    const existing = sqlite.prepare(`SELECT slug, magic_token FROM media_kit_shares WHERE kit_id = ? AND status = 'active' AND slug LIKE 'internal-preview-%' ORDER BY id DESC LIMIT 1`).get(id) as any;
    if (existing) {
      return res.json({ slug: existing.slug, magic_token: existing.magic_token, magic_link: `https://dashboard.stereonet.com/kit/${existing.slug}?t=${existing.magic_token}` });
    }
    // Mint a new one. Long expiry (10 years) since it's an internal preview.
    const slug = `internal-preview-${id}-${Math.random().toString(36).slice(2, 8)}`;
    const token = require("node:crypto").randomBytes(24).toString("base64url").slice(0, 24);
    const expiry = (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 10); return d.toISOString(); })();
    // Important: leave prospect_name/prospect_company NULL so the public hero falls back to the kit's own label
    // (not "Prepared for StereoNET (preview)"). The 'internal-preview-' slug prefix is the only marker we need.
    sqlite.prepare(`INSERT INTO media_kit_shares (kit_id, slug, magic_token, expires_at) VALUES (?, ?, ?, ?)`)
      .run(id, slug, token, expiry);
    res.json({ slug, magic_token: token, magic_link: `https://dashboard.stereonet.com/kit/${slug}?t=${token}` });
  });

  // Reorder blocks on a kit. Persists order as a per-kit override JSON column
  // (block_order_override_json) so we don't materialise rows on regional kits
  // and accidentally break content inheritance from canonical.
  // The renderer (getEffectiveBlocks) applies this override on top of the
  // inherited positions.
  app.patch("/api/media-kit/kits/:id/blocks/reorder", requireKitAccess("admin"), (req: any, res) => {
    const id = Number(req.params.id);
    const order = req.body?.block_keys;
    if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ message: "block_keys[] required" });
    try {
      sqlite.prepare(`UPDATE media_kits SET block_order_override_json = ? WHERE id = ?`).run(JSON.stringify(order), id);
    } catch (e: any) {
      return res.status(500).json({ message: e?.message });
    }
    const blocks = getEffectiveBlocks(id);
    res.json({ ok: true, blocks });
  });

  // Clear the block order override — the kit falls back to canonical order.
  app.delete("/api/media-kit/kits/:id/blocks/reorder", requireKitAccess("admin"), (req: any, res) => {
    const id = Number(req.params.id);
    sqlite.prepare(`UPDATE media_kits SET block_order_override_json = NULL WHERE id = ?`).run(id);
    const blocks = getEffectiveBlocks(id);
    res.json({ ok: true, blocks });
  });

  // Get one kit with effective (inherited+override) blocks + addons resolved by region
  app.get("/api/media-kit/kits/:id", requireKitAccess("view"), (req: any, res) => {
    const id = Number(req.params.id);
    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(id);
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    const blocks = getEffectiveBlocks(id);
    // Admin AddonsTab can opt-in to seeing hidden tiers/bolt-ons via ?include_hidden=1.
    const includeHidden = req.query?.include_hidden === "1" || req.query?.include_hidden === "true";
    const addons = loadAddonsForKit(id, { includeHidden });
    res.json({ kit, blocks, addons });
  });

  // Patch the kit row itself (label, status, currency, etc.)
  // Admin-only — changing the kit's label/status/currency is a structural override.
  app.patch("/api/media-kit/kits/:id", requireKitAccess("admin"), (req, res) => {
    const id = Number(req.params.id);
    const editable = ["label", "subtitle", "version_quarter", "status", "base_currency", "tax_suffix", "intro_text", "locked_currency"];
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of editable) {
      if (k in (req.body || {})) { sets.push(`${k} = ?`); params.push(req.body[k]); }
    }
    if (sets.length === 0) return res.json({ ok: true });
    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    sqlite.prepare(`UPDATE media_kits SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  });

  // Save/override a block. Body: { content: {...}, is_visible?: boolean }
  // ─── Delete a kit ───────────────────────────────────────────────────────────
  // Admin-only. Blocked when:
  //   - The kit has any non-draft shares (real prospects have been sent this link)
  //   - The kit is the canonical Global trade or Global retailer kit (it's the parent)
  //   - The kit is a prospect clone with proposal activity
  // Cascades: media_kit_blocks (overrides), media_kit_shares (drafts only), proposal_events for those shares.
  app.delete("/api/media-kit/kits/:id", requireKitAccess("admin"), (req: any, res) => {
    const id = Number(req.params.id);
    console.log(`[media-kit] DELETE /api/media-kit/kits/${id} by ${req.session?.username || "?"}`);
    const kit = sqlite.prepare(`SELECT id, region, kind, label, prospect_lead_id, is_canonical FROM media_kits WHERE id = ?`).get(id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    // Refuse to delete the canonical/Global master kit — it's the inheritance root
    // for the regional kits. Prospect clones can have region=NULL too (especially
    // retailer clones, since the retailer master is global), so we must NOT block
    // those: only block when the kit is the actual master (no prospect_lead_id).
    if (kit.region == null && !kit.prospect_lead_id) {
      return res.status(409).json({ message: "Cannot delete the Global kit \u2014 it's the source other regional kits inherit from." });
    }
    // Block if any share has been sent / accessed / accepted / declined.
    const liveShare = sqlite.prepare(`SELECT id, proposal_state FROM media_kit_shares WHERE kit_id = ? AND proposal_state != 'draft' LIMIT 1`).get(id) as any;
    if (liveShare) {
      return res.status(409).json({ message: `Cannot delete: this kit has at least one share that has been sent (share #${liveShare.id}, state '${liveShare.proposal_state}'). Archive the kit instead.` });
    }
    // Cascade.
    const shareIds = (sqlite.prepare(`SELECT id FROM media_kit_shares WHERE kit_id = ?`).all(id) as any[]).map(r => r.id);
    const tx = sqlite.transaction(() => {
      if (shareIds.length) {
        const placeholders = shareIds.map(() => "?").join(",");
        sqlite.prepare(`DELETE FROM proposal_events WHERE share_id IN (${placeholders})`).run(...shareIds);
      }
      sqlite.prepare(`DELETE FROM media_kit_shares WHERE kit_id = ?`).run(id);
      sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ?`).run(id);
      // If this kit was a prospect clone, clear the lead's pointer back.
      if (kit.prospect_lead_id) {
        sqlite.prepare(`UPDATE pitch_inbound_leads SET kit_share_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(kit.prospect_lead_id);
      }
      sqlite.prepare(`DELETE FROM media_kits WHERE id = ?`).run(id);
    });
    try { tx(); } catch (e: any) {
      console.error("[media-kit] delete failed:", e);
      return res.status(500).json({ message: e?.message || "Delete failed" });
    }
    res.json({ ok: true });
  });

  // Save/override a block. Body: { content: {...}, is_visible?: boolean }
  // Admin-only — editing content blocks is a customisation operation.
  app.put("/api/media-kit/kits/:id/blocks/:block_key", requireKitAccess("admin"), (req, res) => {
    const id = Number(req.params.id);
    const key = req.params.block_key;
    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    const content = req.body?.content || {};
    const visible = req.body?.is_visible == null ? 1 : (req.body.is_visible ? 1 : 0);
    // Compute position: keep existing or fall back to parent's position or 99
    const existing = sqlite.prepare(`SELECT position FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(id, key) as any;
    const parentPos = kit.parent_kit_id
      ? (sqlite.prepare(`SELECT position FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(kit.parent_kit_id, key) as any)?.position
      : null;
    const position = existing?.position ?? parentPos ?? 99;
    // is_override = 1 when this kit has a parent (regional)
    const is_override = kit.parent_kit_id ? 1 : 0;
    sqlite.prepare(`
      INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(kit_id, block_key) DO UPDATE SET
        content_json = excluded.content_json,
        is_visible = excluded.is_visible,
        is_override = excluded.is_override,
        edited_at = datetime('now')
    `).run(id, key, position, is_override, visible, JSON.stringify(content));
    sqlite.prepare(`UPDATE media_kits SET updated_at = datetime('now') WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // Revert a regional block to inherit from canonical
  // Admin-only — deleting/reverting block overrides is a customisation operation.
  app.delete("/api/media-kit/kits/:id/blocks/:block_key", requireKitAccess("admin"), (req, res) => {
    const id = Number(req.params.id);
    const key = req.params.block_key;
    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    if (!kit.parent_kit_id) return res.status(400).json({ message: "Canonical kits can't be reverted; edit the block instead" });
    sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).run(id, key);
    res.json({ ok: true });
  });

  // ─── Addons ───────────────────────────────────────────────────────────────
  app.get("/api/media-kit/addons", requireKitAccess("view"), (req, res) => {
    const { kind, region, audience_kind } = req.query as any;
    const where: string[] = [];
    const params: any[] = [];
    if (kind) { where.push(`kind = ?`); params.push(kind); }
    if (region) { where.push(`region = ?`); params.push(region); }
    else if (region === null) { where.push(`region IS NULL`); }
    if (audience_kind) { where.push(`(audience_kind = ? OR audience_kind = 'both')`); params.push(audience_kind); }
    const sql = `SELECT * FROM media_kit_addons ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY kind, position ASC`;
    const rows = sqlite.prepare(sql).all(...params) as any[];
    res.json({ addons: rows.map(addAddonHelpers) });
  });

  // Admin-only — editing tier/bolt-on definitions or pricing is a customisation operation.
  app.patch("/api/media-kit/addons/:id", requireKitAccess("admin"), (req, res, next) => {
    // Guard: when path is /addons/reorder, fall through so the next handler matches.
    if (req.params.id === "reorder") return next();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid addon id" });
    const editable = ["label", "subtitle", "description", "price_value", "price_currency", "price_suffix", "billing", "inclusions_json", "availability", "position", "is_visible", "is_poa", "example_url"];
    const sets: string[] = [];
    const params: any[] = [];
    const patch: Record<string, any> = {};
    for (const k of editable) {
      if (k in (req.body || {})) {
        sets.push(`${k} = ?`);
        let v = req.body[k];
        if (k === "inclusions_json" && typeof v !== "string") v = JSON.stringify(v);
        params.push(v);
        patch[k] = v;
      }
    }
    if (sets.length === 0) return res.json({ ok: true });
    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    sqlite.prepare(`UPDATE media_kit_addons SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    // ── Inheritance: if this is a Global addon (region IS NULL), propagate the
    // non-pricing / non-availability / non-visibility fields to every regional
    // addon sharing the same addon_key + kind. Regional kits stay in charge of
    // their own price, availability, and visibility.
    let propagated = 0;
    const row = sqlite.prepare(`SELECT region, kind, addon_key FROM media_kit_addons WHERE id = ?`).get(id) as any;
    if (row && row.region === null) {
      const INHERITED_FIELDS = ["label", "subtitle", "description", "billing", "inclusions_json", "position", "is_poa", "example_url"];
      const propSets: string[] = [];
      const propParams: any[] = [];
      for (const k of INHERITED_FIELDS) {
        if (k in patch) {
          propSets.push(`${k} = ?`);
          propParams.push(patch[k]);
        }
      }
      if (propSets.length > 0) {
        propSets.push(`updated_at = datetime('now')`);
        propParams.push(row.kind, row.addon_key);
        const r = sqlite.prepare(`UPDATE media_kit_addons SET ${propSets.join(", ")} WHERE region IS NOT NULL AND kind = ? AND addon_key = ?`).run(...propParams);
        propagated = r.changes;
      }
    }
    // Mirror tier price/label changes into BOTH pitch_tier_template_items (the
    // per-tier line item rows used at proposal create time) AND pitch_tier_templates
    // (the wizard's Tier dropdown source). All three tables must stay in sync
    // so editors don't see ghost prices.
    try {
      const addonRow = sqlite.prepare(`SELECT kind, addon_key, region, label, price_value FROM media_kit_addons WHERE id = ?`).get(id) as any;
      if (addonRow && addonRow.kind === "tier" && ("price_value" in patch || "label" in patch)) {
        const tierRegion = addonRow.region == null ? "global" : addonRow.region;
        const baseLabelLike = `${addonRow.label} Tier — Monthly Base`;
        let updatedItems = 0;
        let updatedTemplates = 0;
        if ("price_value" in patch) {
          const r1 = sqlite.prepare(`
            UPDATE pitch_tier_template_items
               SET unit_price_usd = ?
             WHERE tier_key = ? AND region = ? AND sort_order = 0
          `).run(Number(patch.price_value) || 0, addonRow.addon_key, tierRegion);
          updatedItems += r1.changes;
          const r2 = sqlite.prepare(`
            UPDATE pitch_tier_templates
               SET monthly_usd = ?
             WHERE tier_key = ? AND region = ?
          `).run(Number(patch.price_value) || 0, addonRow.addon_key, tierRegion);
          updatedTemplates += r2.changes;
        }
        if ("label" in patch) {
          const r3 = sqlite.prepare(`
            UPDATE pitch_tier_template_items
               SET label = ?
             WHERE tier_key = ? AND region = ? AND sort_order = 0
          `).run(baseLabelLike, addonRow.addon_key, tierRegion);
          updatedItems += r3.changes;
          const r4 = sqlite.prepare(`
            UPDATE pitch_tier_templates
               SET label = ?
             WHERE tier_key = ? AND region = ?
          `).run(addonRow.label, addonRow.addon_key, tierRegion);
          updatedTemplates += r4.changes;
        }
        console.log(`[mk→pitch] tier sync: addon=${addonRow.addon_key} region=${tierRegion} items=${updatedItems} templates=${updatedTemplates}`);
      }
    } catch (e) {
      console.warn("[mk→pitch] tier sync failed:", e);
    }

    res.json({ ok: true, propagated_to_regions: propagated });
  });

  // Bulk reorder addons — body { ids: number[], kit_id?: number } in desired display order.
  //
  // Behaviour:
  //   - If kit_id is a prospect clone (prospect_lead_id IS NOT NULL): persist the new
  //     order as a per-kit override on media_kits.addon_order_override_json. The shared
  //     regional addon rows are NOT mutated.
  //   - Otherwise (Global or regional master kit): mutate the addon rows' position
  //     directly. If all ids belong to Global, also propagate position to regions.
  // Admin-only — reordering bolt-ons / tiers is a customisation operation.
  app.patch("/api/media-kit/addons/reorder", requireKitAccess("admin"), (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    const kitIdRaw = req.body?.kit_id;
    const kitId = kitIdRaw != null && !isNaN(Number(kitIdRaw)) ? Number(kitIdRaw) : null;
    if (ids.length === 0) return res.status(400).json({ message: "ids[] required" });

    // If this reorder is happening in the context of a prospect-clone kit, store it as an override.
    if (kitId) {
      const kit = sqlite.prepare(`SELECT id, prospect_lead_id, addon_order_override_json FROM media_kits WHERE id = ?`).get(kitId) as any;
      if (kit && kit.prospect_lead_id) {
        const addonRows = sqlite.prepare(`SELECT id, kind, addon_key FROM media_kit_addons WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
        const byId = new Map<number, any>(addonRows.map(r => [r.id, r]));
        const orderedKeys: string[] = [];
        let kind: string | null = null;
        for (const id of ids) {
          const row = byId.get(id);
          if (!row) continue;
          if (!kind) kind = row.kind;
          if (row.kind !== kind) continue; // safety: ignore cross-kind
          orderedKeys.push(row.addon_key);
        }
        if (!kind) return res.status(400).json({ message: "Could not resolve addon kind" });
        let existing: any = {};
        try { existing = JSON.parse(kit.addon_order_override_json || "{}") || {}; } catch {}
        existing[kind] = orderedKeys;
        sqlite.prepare(`UPDATE media_kits SET addon_order_override_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(existing), kitId);
        return res.json({ ok: true, mode: "per_kit_override", kit_id: kitId, kind, order: orderedKeys });
      }
    }
    const stmt = sqlite.prepare(`UPDATE media_kit_addons SET position = ?, updated_at = datetime('now') WHERE id = ?`);
    const txn = sqlite.transaction((arr: number[]) => {
      arr.forEach((id, i) => stmt.run(i + 1, id));
    });
    try {
      txn(ids);
      // Check if these ids are all Global addons; if yes propagate position.
      const placeholders = ids.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT id, region, kind, addon_key FROM media_kit_addons WHERE id IN (${placeholders})`).all(...ids) as any[];
      const allGlobal = rows.length === ids.length && rows.every(r => r.region === null);
      let propagated = 0;
      if (allGlobal) {
        const propStmt = sqlite.prepare(`UPDATE media_kit_addons SET position = ?, updated_at = datetime('now') WHERE region IS NOT NULL AND kind = ? AND addon_key = ?`);
        const propTxn = sqlite.transaction((arr: number[]) => {
          arr.forEach((id, i) => {
            const row = rows.find(r => r.id === id);
            if (!row) return;
            const r = propStmt.run(i + 1, row.kind, row.addon_key);
            propagated += r.changes;
          });
        });
        propTxn(ids);
      }
      res.json({ ok: true, updated: ids.length, propagated_to_regions: propagated });
    }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ─── Shares ───────────────────────────────────────────────────────────────
  // ─── Global history: every share ever sent, across every kit. Used by the
  // Media Kits sidebar's "History" group so admins can see who has been
  // emailed a kit, when, whether they opened it, and from where.
  app.get("/api/media-kit/history", requireKitAccess("view"), async (req: any, res) => {
    const rows = sqlite.prepare(`
      SELECT
        s.id, s.kit_id, s.slug, s.magic_token, s.prospect_name, s.prospect_email,
        s.prospect_company, s.note, s.created_at, s.sent_at, s.expires_at,
        s.proposal_state, s.first_viewed_at, s.last_viewed_at, s.view_count,
        s.created_by,
        k.label  AS kit_label,
        k.region AS kit_region,
        k.kind   AS kit_kind,
        k.is_canonical AS kit_is_canonical,
        u.username AS created_by_username,
        (SELECT id FROM pitch_proposals p WHERE p.media_kit_id = s.kit_id LIMIT 1) AS proposal_id
      FROM media_kit_shares s
      JOIN media_kits k ON k.id = s.kit_id
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.sent_at IS NOT NULL
      ORDER BY s.sent_at DESC
      LIMIT 500
    `).all() as any[];
    // Tag each row with a source label: 'proposal' when the kit is a prospect
    // clone linked from PITCH; 'quick_send' otherwise.
    const out = rows.map((r) => ({
      ...r,
      source: r.proposal_id ? "proposal" : "quick_send",
      link: `/kit/${r.slug}?t=${r.magic_token}`,
    }));
    res.json({ shares: out });
  });

  // Per-share view log with IP + country (matches the PITCH view-activity
  // panel). 200-row cap. Country lookup uses the cached ip-api.com table.
  app.get("/api/media-kit/shares/:id/view-activity", requireKitAccess("view"), async (req: any, res) => {
    const id = Number(req.params.id);
    const share = sqlite.prepare(`SELECT id, kit_id FROM media_kit_shares WHERE id = ?`).get(id) as any;
    if (!share) return res.status(404).json({ message: "Share not found" });
    const rows = sqlite.prepare(`
      SELECT id, viewed_at, ip, user_agent, is_bot, bot_reason, recipient_email
      FROM media_kit_views
      WHERE share_id = ?
      ORDER BY viewed_at DESC
      LIMIT 200
    `).all(id) as any[];
    // Country cache lookup mirrors the /api/pitch/:id/views logic.
    let cache: Record<string, { cc: string; country: string; ts: number }> = {};
    try {
      const raw = (sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'ip_country_cache'`).get() as any)?.value;
      if (raw) cache = JSON.parse(raw);
    } catch {}
    const now = Date.now();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
    const uniqueIps = Array.from(new Set(rows.map(r => r.ip).filter((x: any) => !!x && x !== "unknown")));
    const toFetch = uniqueIps.filter((ip: any) => !cache[ip] || (now - cache[ip].ts) > maxAgeMs);
    const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc|fd)/i.test(ip);
    await Promise.all(toFetch.slice(0, 30).map(async (ip: any) => {
      if (isPrivate(ip)) { cache[ip] = { cc: "", country: "Local", ts: now }; return; }
      try {
        const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, { signal: AbortSignal.timeout(3000) });
        const j: any = await r.json().catch(() => ({}));
        if (j?.status === "success") cache[ip] = { cc: String(j.countryCode || ""), country: String(j.country || ""), ts: now };
        else cache[ip] = { cc: "", country: "", ts: now };
      } catch { cache[ip] = { cc: "", country: "", ts: now }; }
    }));
    try {
      sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('ip_country_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cache));
    } catch {}
    const views = rows.map((r: any) => ({
      id: r.id,
      viewed_at: r.viewed_at,
      ip: r.ip,
      user_agent: r.user_agent,
      is_bot: !!r.is_bot,
      bot_reason: r.bot_reason || null,
      recipient_email: r.recipient_email || null,
      country: r.ip ? (cache[r.ip]?.country || null) : null,
      country_code: r.ip ? (cache[r.ip]?.cc || null) : null,
    }));
    res.json({ views });
  });

  app.get("/api/media-kit/kits/:id/shares", requireKitAccess("view"), (req, res) => {
    const id = Number(req.params.id);
    const rows = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE kit_id = ? ORDER BY id DESC`).all(id);
    res.json({ shares: rows });
  });

  app.post("/api/media-kit/kits/:id/shares", requireKitAccess("edit"), (req: any, res) => {
    const id = Number(req.params.id);
    const kit = sqlite.prepare(`SELECT id FROM media_kits WHERE id = ?`).get(id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    const body = req.body || {};
    const slug = genShareSlug(body.prospect_company || body.prospect_name || "share");
    const token = genToken(24);
    const expiry = body.expires_at || (() => {
      const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString();
    })();
    const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session?.username) as any)?.id || null;
    const r = sqlite.prepare(`
      INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, note, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, slug, token, body.prospect_name || null, body.prospect_email || null, body.prospect_company || null, body.note || null, expiry, meId);
    res.json({ id: Number(r.lastInsertRowid), slug, magic_token: token, expires_at: expiry });
  });

  // ─── Quick Send ────────────────────────────────────────────────────────
  // Create a personalised share for an arbitrary recipient on a kit, fire the
  // "Your Media Kit is ready" email, and log a 'sent' event so it's tracked
  // exactly like a normal lead send. No lead row is created. Used by the
  // Quick Send button in the PITCH header.
  app.post("/api/media-kit/quick-send", requireKitAccess("edit"), async (req: any, res) => {
    const body = req.body || {};
    const kitId = Number(body.kit_id);
    const toEmail = String(body.email || "").trim();
    const toName = String(body.name || "").trim();
    const toCompany = String(body.company || "").trim();
    const note = String(body.note || "").trim();
    // Additional recipients [{name, email}]. Each one gets their own share row
    // + their own unique magic link so opens can be attributed per-recipient.
    const additionalRecipients: Array<{ name?: string; email: string }> = Array.isArray(body.additional_recipients)
      ? body.additional_recipients.filter((r: any) => r && r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(r.email).trim()))
      : [];
    if (!kitId) return res.status(400).json({ message: "kit_id is required" });
    if (!toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail)) return res.status(400).json({ message: "A valid recipient email is required" });
    if (!toName) return res.status(400).json({ message: "Recipient name is required" });
    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(kitId) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });

    const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session?.username) as any)?.id || null;
    const { sendEmail, buildKitDeliveryEmail } = await import("./email");
    const sender = storage.getUserSenderInfo(req.session?.username || "");

    // Build the full recipient list: primary + additional, de-duped on email.
    const seen = new Set<string>();
    const allRecipients: Array<{ name: string; email: string; company: string }> = [];
    const pushIfNew = (name: string, email: string, company: string) => {
      const key = email.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      allRecipients.push({ name, email, company });
    };
    pushIfNew(toName, toEmail, toCompany);
    for (const r of additionalRecipients) {
      pushIfNew(String(r.name || toName).trim(), String(r.email).trim(), toCompany);
    }

    const results: Array<{ ok: boolean; email: string; share_id?: number; magic_link?: string; error?: string }> = [];
    for (const r of allRecipients) {
      // Mint a fresh share for THIS recipient. 30-day expiry.
      // Use the collision-safe generator so multiple recipients sent in the
      // same second (or repeat sends to the same company) don't fail on the
      // media_kit_shares.slug UNIQUE constraint.
      const slug = genUniqueShareSlug(r.company || r.name);
      const token = genToken(24);
      const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
      const insert = sqlite.prepare(`
        INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, note, expires_at, created_by, proposal_state, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', datetime('now'))
      `).run(kitId, slug, token, r.name, r.email, r.company || null, note || null, expiry, meId);
      const shareId = Number(insert.lastInsertRowid);
      const magicLink = `https://dashboard.stereonet.com/kit/${slug}?t=${token}`;
      try {
        const tpl = buildKitDeliveryEmail({
          name: r.name,
          company: r.company,
          magicLink,
          kitLabel: kit.label || "StereoNET Media Kit",
        });
        // CC the sender ONLY on the primary recipient so they don't get N copies.
        const isPrimary = r.email.toLowerCase() === toEmail.toLowerCase();
        const result = await sendEmail({
          to: r.email,
          toName: r.name,
          subject: tpl.subject,
          html: tpl.html,
          fromName: sender.name || undefined,
          replyTo: sender.email || undefined,
          cc: isPrimary ? (sender.email || undefined) : undefined,
        });
        if (!result.ok) {
          sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'draft', sent_at = NULL WHERE id = ?`).run(shareId);
          results.push({ ok: false, email: r.email, error: result.error || "unknown" });
          continue;
        }
        sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, actor_name, message) VALUES (?, 'sent', ?, ?)`)
          .run(shareId, req.session?.username || "system", `Quick Send to ${r.email}${r.company ? " (" + r.company + ")" : ""}`);
        // FREEZE the kit on first successful Quick Send so future Global edits
        // don't leak into a kit a prospect has already received.
        try {
          const { freezeInheritedBlocksForKit } = require("./pitch");
          freezeInheritedBlocksForKit(kitId);
        } catch (e) { console.warn("[quick-send] freeze failed:", e); }
        results.push({ ok: true, email: r.email, share_id: shareId, magic_link: magicLink });
      } catch (e: any) {
        console.error("[media-kit] quick-send delivery failed:", e);
        sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'draft', sent_at = NULL WHERE id = ?`).run(shareId);
        results.push({ ok: false, email: r.email, error: e?.message || "unknown" });
      }
    }

    const delivered = results.filter(r => r.ok).length;
    const total = results.length;
    // Back-compat: when there's only one recipient, mirror the old fields.
    const primaryResult = results.find(r => r.email.toLowerCase() === toEmail.toLowerCase()) || results[0];
    if (delivered === 0) {
      return res.status(500).json({ ok: false, message: `All sends failed: ${results.map(r => r.error).filter(Boolean).join("; ")}`, results });
    }
    res.json({
      ok: true,
      delivered, total, results,
      // Legacy single-recipient fields (preserved for any older client code):
      share_id: primaryResult?.share_id,
      magic_link: primaryResult?.magic_link,
      sent_to: primaryResult?.email,
    });
  });

  app.patch("/api/media-kit/shares/:id", requireKitAccess("edit"), (req, res) => {
    const id = Number(req.params.id);
    const editable = ["status", "expires_at", "note", "prospect_name", "prospect_email", "prospect_company"];
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of editable) {
      if (k in (req.body || {})) { sets.push(`${k} = ?`); params.push(req.body[k]); }
    }
    if (sets.length === 0) return res.json({ ok: true });
    params.push(id);
    sqlite.prepare(`UPDATE media_kit_shares SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  });

  app.post("/api/media-kit/shares/:id/regenerate-token", requireKitAccess("edit"), (req, res) => {
    const id = Number(req.params.id);
    const token = genToken(24);
    sqlite.prepare(`UPDATE media_kit_shares SET magic_token = ?, status = 'active' WHERE id = ?`).run(token, id);
    res.json({ magic_token: token });
  });

  app.delete("/api/media-kit/shares/:id", requireKitAccess("edit"), (req, res) => {
    const id = Number(req.params.id);
    // Cascade: views, events, then the share itself.
    sqlite.prepare(`DELETE FROM media_kit_views WHERE share_id = ?`).run(id);
    try { sqlite.prepare(`DELETE FROM proposal_events WHERE share_id = ?`).run(id); } catch {}
    try { sqlite.prepare(`DELETE FROM media_kit_share_recipients WHERE share_id = ?`).run(id); } catch {}
    sqlite.prepare(`DELETE FROM media_kit_shares WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  // Revoke a share without deleting it: rotates the magic_token so the old link
  // 404s, expires the share immediately, and logs the event. View history
  // stays intact for record-keeping.
  app.post("/api/media-kit/shares/:id/revoke", requireKitAccess("edit"), (req: any, res) => {
    const id = Number(req.params.id);
    const share = sqlite.prepare(`SELECT id FROM media_kit_shares WHERE id = ?`).get(id) as any;
    if (!share) return res.status(404).json({ message: "Share not found" });
    const newToken = genToken(24);
    sqlite.prepare(`
      UPDATE media_kit_shares
         SET magic_token = ?, expires_at = datetime('now'), proposal_state = 'revoked'
       WHERE id = ?
    `).run(newToken, id);
    try {
      sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, actor_name, message) VALUES (?, 'revoked', ?, ?)`)
        .run(id, req.session?.username || "system", "Magic link revoked by admin");
    } catch {}
    res.json({ ok: true });
  });

  app.get("/api/media-kit/shares/:id/views", requireKitAccess("view"), (req, res) => {
    const id = Number(req.params.id);
    const rows = sqlite.prepare(`SELECT id, viewed_at, ip, user_agent, time_on_page_seconds, scroll_depth_pct FROM media_kit_views WHERE share_id = ? ORDER BY viewed_at DESC LIMIT 200`).all(id);
    res.json({ views: rows });
  });

  // ─── Public viewer endpoint (token-gated) ─────────────────────────────────
  app.get("/api/media-kit/public/:slug", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const share = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE slug = ?`).get(slug) as any;
    if (!share) return res.status(404).json({ message: "Not found" });
    if (share.status === "revoked") return res.status(403).json({ message: "This link has been revoked. Please contact your StereoNET representative." });
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      sqlite.prepare(`UPDATE media_kit_shares SET status = 'expired' WHERE id = ?`).run(share.id);
      return res.status(403).json({ message: "This link has expired. Please contact your StereoNET representative for a fresh one." });
    }
    if (!t || t !== share.magic_token) return res.status(403).json({ message: "Invalid token" });

    const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(share.kit_id) as any;
    if (!kit) return res.status(404).json({ message: "Kit not found" });
    const blocks = getEffectiveBlocks(kit.id);
    const addons = loadAddonsForKit(kit.id);

    // Skip all view tracking when the viewer is recognised as the owner. We
    // use four independent signals because incognito + logged-out previews
    // would otherwise look like genuine prospect opens:
    //   1. internal-preview-* slugs are wizard previews — never count.
    //   2. An active dashboard session means it's a logged-in staff user.
    //   3. A long-lived `mk_owner=1` cookie set when the kit is created/sent
    //      so the same browser (even incognito-less private windows) recognises
    //      itself across visits.
    //   4. An IP allowlist stored in app_settings.media_kit_owner_ips (CSV).
    //      Catches the incognito-from-same-IP case where no cookie is present.
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;
    const ua = (req.headers["user-agent"] as string) || null;
    const isInternalPreview = String(req.params.slug || "").startsWith("internal-preview-");
    const sessionUsername = (req as any).session?.username || null;
    const sessionUserId = sessionUsername ? (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(sessionUsername) as any)?.id : null;
    const ownerCookie = (req as any).cookies?.mk_owner === "1";
    const ownerIpsCsv = (sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'media_kit_owner_ips'`).get() as any)?.value || "";
    const ownerIps = ownerIpsCsv.split(",").map((s: string) => s.trim()).filter(Boolean);
    const ipIsOwner = !!ip && ownerIps.includes(ip);
    const isOwnerView = isInternalPreview || (sessionUsername != null) || (sessionUserId && share.created_by === sessionUserId) || ownerCookie || ipIsOwner;
    if (sessionUsername) {
      // Drop a long-lived (1 year) cookie so this browser keeps suppressing
      // view tracking even after the dashboard session expires.
      try { (res as any).cookie("mk_owner", "1", { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: "lax", httpOnly: false }); } catch {}
      // Also auto-add the current IP to the owner-IP allowlist so future
      // incognito or signed-out opens from the same network don't trip.
      if (ip && !ownerIps.includes(ip)) {
        const next = [...ownerIps, ip].slice(-20).join(",");
        try { sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('media_kit_owner_ips', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(next); } catch (e) { console.warn("[media-kit] owner-ip allowlist update failed:", e); }
      }
    }

    // Bot classifier: email security scanners (Outlook ATP/Defender SafeLinks,
    // Mimecast, Proofpoint, Barracuda), preview unfurlers (Slack/Teams/iMessage),
    // and generic crawlers all open links before a human ever does. They almost
    // always announce themselves in the user-agent. Flag them so they don't
    // inflate the "opened" count but keep the row for debugging.
    const botPatterns: Array<[RegExp, string]> = [
      [/bingpreview|microsoft.*defender|outlook|office.*protection|atp.*safelinks|safelinks/i, "Microsoft SafeLinks/ATP"],
      [/proofpoint|urldefense/i, "Proofpoint URLDefense"],
      [/mimecast/i, "Mimecast"],
      [/barracuda/i, "Barracuda"],
      [/symantec|broadcom.*email/i, "Symantec"],
      [/cisco.*esa|ironport/i, "Cisco IronPort"],
      [/slackbot|slack-imgproxy/i, "Slack unfurl"],
      [/twitterbot|facebookexternalhit|linkedinbot|whatsapp|telegrambot|discordbot/i, "Social unfurl"],
      [/googlebot|bingbot|yandex|baiduspider|duckduckbot|applebot/i, "Search crawler"],
      [/headlesschrome|phantomjs|puppeteer|playwright|selenium/i, "Headless browser"],
      [/bot\b|crawler|spider|scanner|preview|fetch|http\s*client|curl|wget|python-requests|axios|node-fetch/i, "Generic bot"],
      [/^$|^-$/, "Empty UA"],
    ];
    const classifyBot = (uaStr: string): { isBot: boolean; reason: string | null } => {
      const s = String(uaStr || "").trim();
      if (!s) return { isBot: true, reason: "Empty UA" };
      for (const [re, reason] of botPatterns) {
        if (re.test(s)) return { isBot: true, reason };
      }
      return { isBot: false, reason: null };
    };

    // If the magic link carries a per-recipient token (?r=...), look up which
    // recipient that token belongs to so the view row can be attributed.
    let recipientEmail: string | null = null;
    let recipientRowId: number | null = null;
    try {
      const rToken = String((req.query?.r || "")).trim();
      if (rToken) {
        const rr = sqlite.prepare(`SELECT id, recipient_email FROM media_kit_share_recipients WHERE share_id = ? AND token = ?`).get(share.id, rToken) as any;
        if (rr) {
          recipientEmail = rr.recipient_email || null;
          recipientRowId = rr.id;
        }
      }
    } catch {}

    // Track view (debounce: if same IP viewed within last 60s, don't double-count)
    if (!isOwnerView) {
      const recent = sqlite.prepare(`SELECT id FROM media_kit_views WHERE share_id = ? AND ip = ? AND viewed_at >= datetime('now','-60 seconds')`).get(share.id, ip) as any;
      if (!recent) {
        const { isBot, reason } = classifyBot(ua);
        sqlite.prepare(`INSERT INTO media_kit_views (share_id, ip, user_agent, is_bot, bot_reason, recipient_email) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(share.id, ip, ua, isBot ? 1 : 0, reason, recipientEmail);
        // Only real (non-bot) views count toward the share's view_count and
        // bump last_viewed_at. Bot rows stay in the log for diagnostics.
        if (!isBot) {
          sqlite.prepare(`UPDATE media_kit_shares SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?`).run(share.id);
          // Also bump the per-recipient counter if we know who this was.
          if (recipientRowId) {
            sqlite.prepare(`UPDATE media_kit_share_recipients SET view_count = view_count + 1, last_viewed_at = datetime('now'), first_viewed_at = COALESCE(first_viewed_at, datetime('now')) WHERE id = ?`).run(recipientRowId);
          }
        }
      }
    }

    // Proposal lifecycle: if the kit is in 'sent' state, flip to 'viewed' on first view.
    // Don't override accepted/declined/changes_requested. Log a 'first_viewed' event once,
    // and email the share's creator (the sender) so they know their prospect opened it.
    // Only fire on a REAL (non-bot) first view.
    const realFirstView = !isOwnerView && !classifyBot(ua).isBot;
    if (realFirstView && share.proposal_state === "sent" && !share.first_viewed_at) {
      sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'viewed', first_viewed_at = datetime('now') WHERE id = ?`).run(share.id);
      sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, ip, message) VALUES (?, 'first_viewed', ?, ?)`).run(share.id, ip, "Prospect opened the kit for the first time");

      // Fire-and-forget: notify the sender (and BCC marcrushton@ via sendEmail's catch-all).
      void (async () => {
        try {
          const sender = sqlite.prepare(`SELECT u.email, u.full_name, u.username FROM media_kit_shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`).get(share.id) as any;
          if (!sender?.email) return; // No creator email on file (legacy share); rely on BCC catch-all.
          const kitRow = sqlite.prepare(`SELECT label FROM media_kits WHERE id = ?`).get(share.kit_id) as any;
          const dashboardLink = `https://dashboard.stereonet.com/pitch?tab=kits&kit_id=${share.kit_id}`;
          const { sendEmail, renderTemplate, EMAIL_TEMPLATES } = await import("./email");
          const def = (EMAIL_TEMPLATES as any).admin_share_first_viewed;
          if (!def) return;
          const { subject, html } = renderTemplate(def, {
            sender_first_name: (sender.full_name || sender.username || "there").split(/\s+/)[0],
            prospect_name: share.prospect_name || "(no name on file)",
            prospect_company: share.prospect_company || "(no company on file)",
            prospect_email: share.prospect_email || "(no email on file)",
            kit_label: kitRow?.label || "StereoNET Media Kit",
            viewed_at_aest: new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }),
            ip: ip || "(unknown)",
            dashboard_link: dashboardLink,
          });
          await sendEmail({ to: sender.email, toName: sender.full_name || undefined, subject, html });
        } catch (e) {
          console.error("[media-kit] first-viewed notify failed:", e);
        }
      })();
    }

    // Proposal scope: if the proposal block defines selected_tier_key / selected_bolton_keys,
    // compute the locked total (when auto_total is on) and include a resolved scope snapshot.
    const proposalBlock = blocks.find((b: any) => b.block_key === "proposal");
    let proposalScope: any = null;
    if (proposalBlock?.content) {
      const pc = proposalBlock.content;
      const tierKey = pc.selected_tier_key || null;
      const boltonKeys: string[] = Array.isArray(pc.selected_bolton_keys) ? pc.selected_bolton_keys.filter((k: any) => typeof k === "string") : [];
      const qtyMap: Record<string, number> = (pc.bolton_quantities && typeof pc.bolton_quantities === "object") ? pc.bolton_quantities : {};
      const selectedTier = tierKey ? addons.tiers.find((t: any) => t.addon_key === tierKey) || null : null;
      const selectedBoltons = boltonKeys
        .map(k => addons.boltons.find((b: any) => b.addon_key === k))
        .filter(Boolean)
        .map((b: any) => ({ ...b, quantity: Math.max(1, Number(qtyMap[b.addon_key]) || 1) }));
      let computedTotal: number | null = null;
      if (pc.auto_total) {
        let sum = 0;
        if (selectedTier && !selectedTier.is_poa && selectedTier.price_value != null) sum += Number(selectedTier.price_value);
        for (const b of selectedBoltons) {
          if (!b.is_poa && b.price_value != null) sum += Number(b.price_value) * (b.quantity || 1);
        }
        computedTotal = sum;
      }
      proposalScope = {
        tier_key: tierKey,
        tier: selectedTier,
        bolton_keys: boltonKeys,
        boltons: selectedBoltons,
        auto_total: !!pc.auto_total,
        computed_total: computedTotal,
      };
    }

    // Pitch settings (T&Cs) — expose to the public viewer so the proposal
    // acceptance flow can render the Terms & Conditions block.
    const settings = {
      terms_text: storage.getSetting("pitch_terms_text") || "",
    };
    res.json({
      kit,
      blocks,
      addons,
      proposalScope,
      settings,
      share: {
        share_id: share.id,
        prospect_name: share.prospect_name,
        prospect_email: share.prospect_email,
        prospect_company: share.prospect_company,
        expires_at: share.expires_at,
        proposal_state: share.proposal_state || "draft",
        accepted_at: share.accepted_at,
        accepted_by_name: share.accepted_by_name,
      },
    });
  });

  // ─── Proposal lifecycle: Accept / Request Changes / Decline ──────────────
  // Public endpoints. Token-gated. Idempotent on accepted/declined.
  function escapeHtml(s: string): string {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
  }
  function logProposalEvent(shareId: number, type: string, opts: { actor_name?: string|null; actor_email?: string|null; ip?: string|null; message?: string|null }) {
    sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, actor_name, actor_email, ip, message) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(shareId, type, opts.actor_name || null, opts.actor_email || null, opts.ip || null, opts.message || null);
  }

  function notifyLeadOwners(opts: { share_id: number; template_key: string; vars: Record<string, any> }) {
    // Find the lead this share belongs to; pull region; fan-out email to users
    // whose notify_regions includes that region (or 'all'). Always include the
    // share's creator (whoever Quick Sent / sent the kit) and marcrushton@.
    void (async () => {
      try {
        const lead = sqlite.prepare(`SELECT region FROM pitch_inbound_leads WHERE kit_share_id = ? LIMIT 1`).get(opts.share_id) as any;
        const region = (lead?.region || "global").toLowerCase();
        const users = sqlite.prepare(`SELECT email, notify_regions FROM users WHERE email IS NOT NULL AND email != '' AND notify_regions IS NOT NULL AND notify_regions != ''`).all() as any[];
        const recipients = new Set<string>();
        for (const u of users) {
          const csv = String(u.notify_regions || "").toLowerCase();
          if (csv === "all" || csv.split(",").map(s => s.trim()).includes(region)) {
            recipients.add(String(u.email).trim());
          }
        }
        // Always notify whoever sent the kit, even if they have no notify_regions set
        // (this is the primary owner for Quick Send shares which have no lead).
        const creator = sqlite.prepare(`SELECT u.email FROM media_kit_shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`).get(opts.share_id) as any;
        if (creator?.email) recipients.add(String(creator.email).trim());
        // marcrushton@ is added automatically as a BCC by sendEmail; don't duplicate it here.
        const { sendEmail, renderTemplate, EMAIL_TEMPLATES } = await import("./email");
        const def = (EMAIL_TEMPLATES as any)[opts.template_key];
        if (!def) { console.error("[proposal] unknown template_key", opts.template_key); return; }
        const { subject, html } = renderTemplate(def, opts.vars);
        for (const to of recipients) {
          // bccCatchAll:false on the loop — we already BCC the catch-all on the
          // first send via the SendGrid default, no need to dup-send N times.
          await sendEmail({ to, subject, html, bccCatchAll: to === Array.from(recipients)[0] });
        }
      } catch (e) {
        console.error("[proposal] notify failed:", e);
      }
    })();
  }

  function loadShareByToken(slug: string, token: string) {
    const share = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE slug = ?`).get(slug) as any;
    if (!share) return { error: { status: 404, message: "Not found" } };
    if (share.status === "revoked") return { error: { status: 403, message: "This link has been revoked." } };
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return { error: { status: 403, message: "This link has expired." } };
    if (!token || token !== share.magic_token) return { error: { status: 403, message: "Invalid token" } };
    return { share };
  }

  app.post("/api/media-kit/public/:slug/accept", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const r = loadShareByToken(slug, t);
    if (r.error) return res.status(r.error.status).json({ message: r.error.message });
    const share = r.share;
    if (share.proposal_state === "accepted") {
      return res.json({ ok: true, already_accepted: true, accepted_at: share.accepted_at });
    }
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || share.prospect_email || "").trim();
    if (!name) return res.status(400).json({ message: "Name is required" });
    // Phase B: rich acceptance fields. These are optional — if not provided we
    // still record the acceptance with just name/email (so the Quick Send flow
    // and Inbound Lead flow keep working unchanged).
    const billingCompany = String(body.billing_company || "").trim() || null;
    const billingAddress = String(body.billing_address || "").trim() || null;
    const contactsRaw = Array.isArray(body.accounts_contacts) ? body.accounts_contacts : [];
    const contacts = contactsRaw.map((c: any) => ({
      name: String(c?.name || "").trim(),
      email: String(c?.email || "").trim(),
    })).filter((c: any) => c.name || c.email);
    const signedName = String(body.signed_name || name).trim();
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;
    const ua = (req.headers["user-agent"] as string) || null;
    sqlite.prepare(`UPDATE media_kit_shares SET
      proposal_state = 'accepted',
      accepted_at = datetime('now'),
      accepted_by_name = ?,
      accepted_by_email = ?,
      acceptance_billing_company = ?,
      acceptance_billing_address = ?,
      acceptance_contacts_json = ?,
      acceptance_signed_name = ?,
      acceptance_ip = ?,
      acceptance_user_agent = ?
      WHERE id = ?`).run(
      name, email || null,
      billingCompany, billingAddress,
      contacts.length ? JSON.stringify(contacts) : null,
      signedName,
      ip, ua,
      share.id
    );
    logProposalEvent(share.id, "accepted", { actor_name: name, actor_email: email || null, ip, message: `Proposal accepted${billingCompany ? " for " + billingCompany : ""}` });
    // Bump the linked lead to 'won'
    sqlite.prepare(`UPDATE pitch_inbound_leads SET status = 'won', updated_at = datetime('now') WHERE kit_share_id = ?`).run(share.id);
    notifyLeadOwners({
      share_id: share.id,
      template_key: "admin_proposal_accepted",
      vars: {
        name,
        email: email || share.prospect_email || "(not provided)",
        company: share.prospect_company || billingCompany || "",
        accepted_at: new Date().toISOString(),
        dashboard_link: "https://dashboard.stereonet.com/pitch",
      },
    });
    res.json({ ok: true });
  });

  app.post("/api/media-kit/public/:slug/request-changes", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const r = loadShareByToken(slug, t);
    if (r.error) return res.status(r.error.status).json({ message: r.error.message });
    const share = r.share;
    const name = String(req.body?.name || share.prospect_name || "").trim();
    const email = String(req.body?.email || share.prospect_email || "").trim();
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ message: "Please tell us what you'd like to change" });
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;
    // Don't downgrade from accepted/declined
    if (share.proposal_state !== "accepted" && share.proposal_state !== "declined") {
      sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'changes_requested' WHERE id = ?`).run(share.id);
    }
    logProposalEvent(share.id, "changes_requested", { actor_name: name, actor_email: email || null, ip, message });
    notifyLeadOwners({
      share_id: share.id,
      template_key: "admin_proposal_changes",
      vars: {
        name: name || "Prospect",
        email: email || share.prospect_email || "(not provided)",
        company: share.prospect_company || "",
        message,
        dashboard_link: "https://dashboard.stereonet.com/pitch",
      },
    });
    res.json({ ok: true });
  });

  // ─── Request a proposal ───────────────────────────────────────
  // The kit recipient picks a tier + bolt-ons + notes. State → 'proposal_requested'.
  // Notifies the share's creator (the sender) plus any users matching the lead region.
  app.post("/api/media-kit/public/:slug/request-proposal", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const r = loadShareByToken(slug, t);
    if (r.error) return res.status(r.error.status).json({ message: r.error.message });
    const share = r.share;
    const name = String(req.body?.name || share.prospect_name || "").trim();
    const email = String(req.body?.email || share.prospect_email || "").trim();
    const company = String(req.body?.company || share.prospect_company || "").trim();
    const tier = String(req.body?.tier || "").trim();
    const boltonsRaw = req.body?.boltons;
    const boltons: string[] = Array.isArray(boltonsRaw) ? boltonsRaw.map((s: any) => String(s).trim()).filter(Boolean) : [];
    const message = String(req.body?.message || "").trim();
    if (!name) return res.status(400).json({ message: "Your name is required" });
    if (!email) return res.status(400).json({ message: "Your email is required" });
    if (!tier) return res.status(400).json({ message: "Please choose a package tier" });
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;

    // Don't overwrite accepted/declined.
    if (share.proposal_state !== "accepted" && share.proposal_state !== "declined") {
      sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'proposal_requested' WHERE id = ?`).run(share.id);
    }

    const summaryLines: string[] = [
      `Tier: ${tier}`,
      boltons.length ? `Bolt-ons: ${boltons.join(", ")}` : `Bolt-ons: (none selected)`,
    ];
    if (message) summaryLines.push(`Notes: ${message}`);
    const eventMsg = summaryLines.join(" | ");
    logProposalEvent(share.id, "proposal_requested", { actor_name: name, actor_email: email, ip, message: eventMsg });
    // Bump linked lead status to 'proposal' (if there is one).
    sqlite.prepare(`UPDATE pitch_inbound_leads SET status = 'proposal', updated_at = datetime('now') WHERE kit_share_id = ?`).run(share.id);

    const boltonsHtml = boltons.length
      ? `<ul style="margin:8px 0;padding-left:18px;color:#CCCCCC">${boltons.map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
      : `<em style="color:#999">None selected</em>`;

    notifyLeadOwners({
      share_id: share.id,
      template_key: "admin_proposal_requested",
      vars: {
        name,
        email,
        company: company || "(not provided)",
        tier,
        boltons_html: boltonsHtml,
        message: message || "(no additional notes)",
        kit_label: share.kit_id ? (sqlite.prepare(`SELECT label FROM media_kits WHERE id = ?`).get(share.kit_id) as any)?.label || "" : "",
        dashboard_link: "https://dashboard.stereonet.com/pitch",
      },
    });
    res.json({ ok: true });
  });

  app.post("/api/media-kit/public/:slug/decline", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const r = loadShareByToken(slug, t);
    if (r.error) return res.status(r.error.status).json({ message: r.error.message });
    const share = r.share;
    if (share.proposal_state === "accepted") return res.status(400).json({ message: "This proposal has already been accepted." });
    const name = String(req.body?.name || share.prospect_name || "").trim();
    const email = String(req.body?.email || share.prospect_email || "").trim();
    const reason = String(req.body?.reason || "").trim();
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;
    sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'declined' WHERE id = ?`).run(share.id);
    logProposalEvent(share.id, "declined", { actor_name: name, actor_email: email || null, ip, message: reason || null });
    sqlite.prepare(`UPDATE pitch_inbound_leads SET status = 'lost', updated_at = datetime('now') WHERE kit_share_id = ?`).run(share.id);
    notifyLeadOwners({
      share_id: share.id,
      template_key: "admin_proposal_declined",
      vars: {
        name: name || "Prospect",
        email: email || share.prospect_email || "(not provided)",
        company: share.prospect_company || "",
        reason: reason || "",
        dashboard_link: "https://dashboard.stereonet.com/pitch",
      },
    });
    res.json({ ok: true });
  });

  // Public beacon for time-on-page / scroll depth — fired by the viewer on unload.
  app.post("/api/media-kit/public/:slug/ping", (req, res) => {
    const slug = req.params.slug;
    const t = String(req.query.t || "");
    const share = sqlite.prepare(`SELECT id, magic_token FROM media_kit_shares WHERE slug = ?`).get(slug) as any;
    if (!share || share.magic_token !== t) return res.json({ ok: false });
    const body = req.body || {};
    const seconds = Number(body.time_on_page_seconds) || null;
    const scroll = Number(body.scroll_depth_pct) || null;
    // Update the most recent view row for this share
    const last = sqlite.prepare(`SELECT id FROM media_kit_views WHERE share_id = ? ORDER BY id DESC LIMIT 1`).get(share.id) as any;
    if (last) {
      sqlite.prepare(`UPDATE media_kit_views SET time_on_page_seconds = COALESCE(?, time_on_page_seconds), scroll_depth_pct = COALESCE(?, scroll_depth_pct) WHERE id = ?`).run(seconds, scroll, last.id);
    }
    res.json({ ok: true });
  });

  // ─── Public: Request a Media Kit (from /advertising page) ─────────────────
  // CORS-enabled, rate-limited, anti-spam (honeypot + min-time).
  // Creates an inbound lead row + a media kit share for the matching regional kit
  // + (later) fires SendGrid emails to prospect and Marc.
  app.post("/api/media-kit/request", (req, res) => {
    const body = req.body || {};
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || (req.socket as any)?.remoteAddress || null;
    const ua = (req.headers["user-agent"] as string) || null;
    const referrer = (req.headers["referer"] as string) || null;

    // 1. Honeypot field — if filled, silently "succeed" but do nothing.
    if (body.website || body.honey || body.fax) {
      return res.json({ ok: true, message: "Thanks — we'll be in touch." });
    }

    // 2. Minimum-time gate — form must have been on screen ≥3 seconds
    const renderedAt = Number(body.rendered_at) || 0;
    if (renderedAt && Date.now() - renderedAt < 3000) {
      return res.status(429).json({ ok: false, message: "Form submitted too quickly. Please try again." });
    }

    // 3. Required fields
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const company = String(body.company || "").trim();
    const country = String(body.country || "").trim();
    if (!name || !email || !company) {
      return res.status(400).json({ ok: false, message: "Name, email, and company are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, message: "Please enter a valid email address." });
    }

    // 4. Rate limit: max 5 requests per IP per hour
    if (ip) {
      const recent = sqlite.prepare(`
        SELECT COUNT(*) as cnt FROM pitch_inbound_leads
        WHERE ip_address = ? AND created_at > datetime('now', '-1 hour')
      `).get(ip) as any;
      if (recent?.cnt >= 5) {
        return res.status(429).json({ ok: false, message: "Too many requests. Please try again in an hour." });
      }
    }

    // 5. Pick the regional kit — explicit form value wins over country inference.
    const validRegions = new Set(["anz", "uk_eu", "na", "asia", "global"]);
    const requestedRegion = String(body.region || "").trim().toLowerCase();
    const region = validRegions.has(requestedRegion) ? requestedRegion : countryToRegion(country);
    const kit = findKitForRegion(region);
    if (!kit) {
      return res.status(500).json({ ok: false, message: "No kit available for your region. Please email marcrushton@stereonet.com." });
    }

    // 6. Create the share
    const slug = genShareSlug(company || name);
    const token = genToken(24);
    const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
    const shareResult = sqlite.prepare(`
      INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kit.id, slug, token, name, email, company, expiry);
    const shareId = Number(shareResult.lastInsertRowid);

    // 7. Parse interests (multi-select from form)
    const allowedInterests = new Set(["news", "reviews", "banners", "forum", "newsletter", "social", "classifieds", "brand", "ai", "other"]);
    const rawInterests = Array.isArray(body.interests) ? body.interests : (typeof body.interests === "string" ? body.interests.split(",") : []);
    const interests = rawInterests
      .map((s: any) => String(s || "").trim().toLowerCase())
      .filter((s: string) => allowedInterests.has(s));

    // 8. Validate company_type (optional but recommended)
    const allowedCompanyTypes = new Set(["manufacturer", "distributor", "retailer", "other"]);
    const rawCompanyType = String(body.company_type || "").trim().toLowerCase();
    const companyType = allowedCompanyTypes.has(rawCompanyType) ? rawCompanyType : null;

    // 9. Create the inbound lead row
    sqlite.prepare(`
      INSERT INTO pitch_inbound_leads (source, name, email, company, company_type, role, country, region, message, interests_json, kit_share_id, ip_address, user_agent, referrer)
      VALUES ('advertising_page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, email, company,
      companyType,
      String(body.role || "").trim() || null,
      country || null,
      region,
      String(body.message || "").trim() || null,
      interests.length ? JSON.stringify(interests) : null,
      shareId,
      ip, ua, referrer
    );

    // 9. Fire SendGrid emails (best-effort; failure shouldn't block the response)
    const magicLink = `https://dashboard.stereonet.com/kit/${slug}?t=${token}`;
    const leadId = Number(sqlite.prepare(`SELECT id FROM pitch_inbound_leads WHERE kit_share_id = ? ORDER BY id DESC LIMIT 1`).get(shareId) as any)?.id || 0;

    void (async () => {
      try {
        const { sendEmail, buildProspectKitEmail, buildAdminNotifyEmail } = await import("./email");
        const prospectEmail = buildProspectKitEmail({ name, company });
        await sendEmail({ to: email, toName: name, subject: prospectEmail.subject, html: prospectEmail.html });

        // Fan-out: all users with notify_regions matching this lead's region (or 'all'), plus marcrushton@stereonet.com as fallback.
        const users = sqlite.prepare(`SELECT email, notify_regions FROM users WHERE email IS NOT NULL AND email != '' AND notify_regions IS NOT NULL AND notify_regions != ''`).all() as any[];
        const recipients = new Set<string>();
        for (const u of users) {
          const csv = String(u.notify_regions || "").toLowerCase();
          if (csv === "all" || csv.split(",").map((s: string) => s.trim()).includes(String(region).toLowerCase())) {
            recipients.add(String(u.email).trim());
          }
        }
        // Always include the legacy setting fallback so we never miss a notification
        const fallback = storage.getSetting("sendgrid_notify_to") || "marcrushton@stereonet.com";
        recipients.add(fallback);

        const adminEmail = buildAdminNotifyEmail({
          name, company, email,
          companyType,
          role: String(body.role || "").trim() || null,
          country: country || null,
          region,
          message: String(body.message || "").trim() || null,
          interests,
          magicLink,
          leadId,
          kitLabel: kit.label,
        });
        for (const to of recipients) {
          await sendEmail({ to, subject: adminEmail.subject, html: adminEmail.html, replyTo: email });
        }
      } catch (e) {
        console.error("[media-kit/request] Email dispatch failed:", e);
      }
    })();

    res.json({
      ok: true,
      message: "Thanks — we've received your enquiry. Our team will be in touch within one business day.",
      region,
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function countryToRegion(country: string): string {
  const c = country.trim().toUpperCase();
  if (!c) return "global";
  // ANZ
  if (["AU", "AUSTRALIA", "NZ", "NEW ZEALAND"].includes(c)) return "anz";
  // UK & EU
  const ukEu = new Set([
    "GB", "UK", "UNITED KINGDOM", "IE", "IRELAND",
    "DE", "GERMANY", "FR", "FRANCE", "IT", "ITALY", "ES", "SPAIN", "PT", "PORTUGAL",
    "NL", "NETHERLANDS", "BE", "BELGIUM", "AT", "AUSTRIA", "CH", "SWITZERLAND",
    "SE", "SWEDEN", "NO", "NORWAY", "DK", "DENMARK", "FI", "FINLAND",
    "PL", "POLAND", "CZ", "CZECHIA", "CZECH REPUBLIC", "GR", "GREECE",
    "HU", "HUNGARY", "RO", "ROMANIA", "BG", "BULGARIA", "HR", "CROATIA",
    "SI", "SLOVENIA", "SK", "SLOVAKIA", "EE", "ESTONIA", "LV", "LATVIA", "LT", "LITHUANIA",
    "LU", "LUXEMBOURG", "MT", "MALTA", "CY", "CYPRUS", "IS", "ICELAND",
  ]);
  if (ukEu.has(c)) return "uk_eu";
  // Asia
  const asia = new Set([
    "SG", "SINGAPORE", "MY", "MALAYSIA", "TH", "THAILAND", "ID", "INDONESIA",
    "PH", "PHILIPPINES", "VN", "VIETNAM", "JP", "JAPAN", "KR", "KOREA", "SOUTH KOREA",
    "CN", "CHINA", "HK", "HONG KONG", "TW", "TAIWAN", "IN", "INDIA",
    "AE", "UAE", "UNITED ARAB EMIRATES", "SA", "SAUDI ARABIA",
  ]);
  if (asia.has(c)) return "asia";
  // North America
  if (["US", "USA", "UNITED STATES", "CA", "CANADA", "MX", "MEXICO"].includes(c)) return "na";
  // Fallback
  return "global";
}

function findKitForRegion(region: string): { id: number; label: string } | null {
  // Prefer the regional Trade kit. Fall back to canonical Trade.
  if (region !== "global") {
    const r = sqlite.prepare(`SELECT id, label FROM media_kits WHERE region = ? AND kind = 'trade' LIMIT 1`).get(region) as any;
    if (r) return r;
  }
  const canon = sqlite.prepare(`SELECT id, label FROM media_kits WHERE kind = 'trade' AND is_canonical = 1 LIMIT 1`).get() as any;
  return canon || null;
}
