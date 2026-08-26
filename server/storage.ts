import BetterSqlite3 from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { articles, refreshLog } from "@shared/schema";
import type { InsertArticle, Article, RefreshLog } from "@shared/schema";
import { extractBrands } from "./feeds";

// Pulse local-dev fallback DB path. Filename retained for backward compatibility
// with existing local dev installs; production sets DB_PATH explicitly.
const dbPath = process.env.DB_PATH ?? "cadence_tracker.db";
export const sqlite = new BetterSqlite3(dbPath);
export const db = drizzle(sqlite, { schema });

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    published_at TEXT NOT NULL,
    published_date TEXT NOT NULL,
    content_type TEXT NOT NULL,
    categories TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS refresh_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_at TEXT NOT NULL,
    articles_added INTEGER NOT NULL,
    status TEXT NOT NULL,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_articles_site ON articles(site);
  CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_date);
  CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(content_type);
  -- Add author column if it doesn't exist (safe migration)
  -- This is a no-op if the column already exists
`);
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN author TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN brands TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN description TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN attachments TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN message_id TEXT`); } catch {}

// Audit log for Article Discovery actions
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS discovery_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    article_id INTEGER,
    article_title TEXT,
    article_site TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON discovery_audit(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_article ON discovery_audit(article_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON discovery_audit(username);
`);
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN body_html TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN sender_name TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN sender_email TEXT`); } catch {}
// Editor-brief extensions — see /api/ingest/article schema
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN summary TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN brief_markdown TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN hero_image_url TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN please_write INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN pinned_by TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN suggested_word_count TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN suggested_headlines TEXT`); } catch {}  // JSON array
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN open_questions TEXT`); } catch {}      // JSON array
try { sqlite.exec(`ALTER TABLE articles ADD COLUMN sources TEXT`); } catch {}             // JSON array
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_articles_please_write ON articles(please_write) WHERE please_write = 1`); } catch {}

// File uploads table (editor-brief attachments, press hero images, etc.)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY,
    sha256        TEXT UNIQUE NOT NULL,
    storage_path  TEXT NOT NULL,
    url           TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    width         INTEGER,
    height        INTEGER,
    original_name TEXT,
    caption       TEXT,
    credit        TEXT,
    credit_url    TEXT,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    uploaded_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
  CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_at ON attachments(uploaded_at DESC);
`);

// Track user-deleted site keys so seedSitesIfEmpty doesn't re-add them on startup
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS deleted_sites (
    site_key TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Generic key-value settings (admin-controlled feature flags, etc)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Translation cache for foreign-language article titles. Keyed by SHA-256 of
// the source text + target language so identical titles only get translated
// once across the whole DB. MyMemory or LibreTranslate populates this lazily
// on first read; subsequent reads serve straight from cache.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS article_translations (
    source_hash TEXT NOT NULL,
    target_lang TEXT NOT NULL DEFAULT 'en',
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    source_lang TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_hash, target_lang)
  );
`);

// User-marked B-Side articles — low-priority items that may be written up
// later. Listed in their own tab, hidden from Active. Rows expire from the
// B-Sides view 28 days after being marked (silently — the row stays in DB).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS article_bsides (
    article_id INTEGER PRIMARY KEY,
    marked_by TEXT,
    marked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );
`);

// User-curated title keyword filters — articles whose titles contain ANY of
// these keywords (whole-word, case-insensitive) get auto-hidden from the
// Active discovery tab and surfaced in Dismissed tab as soft-filtered.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS filter_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );
`);

// Cached Top Picks generations (one row per day)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS top_picks (
    date TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    picks_json TEXT NOT NULL
  );
`);

// Users table for auth
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
try { sqlite.exec(`ALTER TABLE users ADD COLUMN last_login TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE users ADD COLUMN redline_access INTEGER NOT NULL DEFAULT 0`); } catch {}
// PITCH — per-user access level: none | view | edit | admin
try { sqlite.exec(`ALTER TABLE users ADD COLUMN pitch_access TEXT NOT NULL DEFAULT 'none'`); } catch {}
// Collapse the legacy 4-tier model (none/view/edit/admin) to 3 tiers (none/manager/admin).
// 'view' → 'edit' so existing read-only users become Managers (they can already navigate).
try { sqlite.prepare(`UPDATE users SET pitch_access = 'edit' WHERE pitch_access = 'view'`).run(); } catch {}
// PITCH — per-user lead-notification regions (CSV: 'all' or comma-separated 'anz,uk_eu,na,asia,global')
try { sqlite.exec(`ALTER TABLE users ADD COLUMN notify_regions TEXT NOT NULL DEFAULT ''`); } catch {}
try { sqlite.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE users ADD COLUMN full_name TEXT`); } catch {}
// Backfill display name from username for anyone who hasn't set one yet.
try { sqlite.prepare(`UPDATE users SET full_name = CASE WHEN username LIKE '%@%' THEN REPLACE(SUBSTR(username, 1, INSTR(username,'@')-1), '.', ' ') ELSE username END WHERE full_name IS NULL OR full_name = ''`).run(); } catch {}
// MEDIA KIT SHARES — proposal lifecycle state
// draft | sent | viewed | accepted | declined | changes_requested
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN proposal_state TEXT NOT NULL DEFAULT 'draft'`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN sent_at TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN first_viewed_at TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN accepted_at TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN accepted_by_name TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN accepted_by_email TEXT`); } catch {}
// Phase B of pitch ↔ media-kit unification: when a prospect formally accepts
// a proposal on /kit/..., we capture the legally-meaningful acceptance fields
// here — same shape the old /pitch/ flow captured.
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_billing_company TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_billing_address TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_contacts_json TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_signed_name TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_ip TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_shares ADD COLUMN acceptance_user_agent TEXT`); } catch {}
// Backfill: scrub prospect_name/prospect_company on internal-preview-% shares (they should be NULL so the hero shows the kit label, not "Prepared for StereoNET (preview)")
try { sqlite.prepare(`UPDATE media_kit_shares SET prospect_name = NULL, prospect_company = NULL WHERE slug LIKE 'internal-preview-%'`).run(); } catch {}
// Activity log for proposal lifecycle events (sent, viewed, accepted, declined, changes_requested, kit_updated)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS proposal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_name TEXT,
    actor_email TEXT,
    ip TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_proposal_events_share ON proposal_events(share_id, created_at DESC)`);
} catch {}
// Auto-grant pitch admin — ONE-TIME seed only. Previously this ran every startup
// and undid any explicit "None" choice for @stereonet.com users. The flag below
// ensures we only seed once per database. To re-seed, delete the flag row.
try {
  const seedFlag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_access_admin_seed_v1'`).get() as any;
  if (!seedFlag) {
    sqlite.prepare(`UPDATE users SET pitch_access='admin' WHERE (role='admin' OR username='marcrushton' OR username='admin') AND (pitch_access='none' OR pitch_access IS NULL)`).run();
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('pitch_access_admin_seed_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString() }));
  }
} catch {}
// Strict invariant: role='admin' users ALWAYS get pitch_access='admin' (kept fresh,
// but doesn't touch non-admin users). This is the safe portion of the old seed.
try { sqlite.prepare(`UPDATE users SET pitch_access='admin' WHERE role='admin' AND pitch_access <> 'admin'`).run(); } catch {}
// Seed: ensure marcrushton has an email + receives all-region lead notifications by default
try { sqlite.prepare(`UPDATE users SET email = COALESCE(NULLIF(email,''), 'marcrushton@stereonet.com'), notify_regions = CASE WHEN notify_regions = '' OR notify_regions IS NULL THEN 'all' ELSE notify_regions END WHERE username = 'marcrushton'`).run(); } catch {}
// Seed: backfill email = username for any user whose username looks like an email (one-time, only fills NULL/empty)
try { sqlite.prepare(`UPDATE users SET email = username WHERE (email IS NULL OR email = '') AND username LIKE '%@%'`).run(); } catch {}

// PITCH — additive columns on pitch_proposals (regions, billing, accounts contacts)
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN regions_json TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN billing_company_name TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN billing_address TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN accounts_contacts_json TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN additional_recipients_json TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN audience_overrides_json TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN proposed_start_date TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN discount_label_override TEXT`); } catch {}
// 'proposal' (default — monthly base + tier + contract) | 'casual' (one-off, bolt-ons only, no contract math)
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN proposal_type TEXT NOT NULL DEFAULT 'proposal'`); } catch {}
// New pitch → media-kit unification: when the wizard generates a proposal we now
// also auto-create a per-prospect Media Kit clone with a populated proposal
// block. We stash the resulting kit and share IDs here so the Proposals list
// can deep-link to the Media Kit and copy the right magic link.
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN media_kit_id INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN media_kit_share_id INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN media_kit_share_slug TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_proposals ADD COLUMN media_kit_share_token TEXT`); } catch {}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT,
    format TEXT,
    FOREIGN KEY (proposal_id) REFERENCES pitch_proposals(id)
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_downloads_proposal ON pitch_downloads(proposal_id, downloaded_at DESC)`); } catch {}

// PITCH — admin-editable tier templates (the default inclusions for each tier).
// Tier templates are region-scoped: 'global' (default fallback), 'anz', 'uk_eu', 'asia', 'na'.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_tier_templates (
    tier_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    monthly_usd REAL NOT NULL DEFAULT 0,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pitch_tier_template_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier_key TEXT NOT NULL REFERENCES pitch_tier_templates(tier_key) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'core',
    label TEXT NOT NULL,
    description TEXT,
    qty REAL NOT NULL DEFAULT 1,
    unit TEXT,
    unit_price_usd REAL NOT NULL DEFAULT 0,
    included INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_pitch_tier_items_tier ON pitch_tier_template_items(tier_key);
`);
// Migration: drop the single-column PRIMARY KEY on tier_key and rebuild with
// (region, tier_key) composite uniqueness. Idempotent — we detect if region
// column is already present and skip.
try {
  const cols = sqlite.prepare(`PRAGMA table_info(pitch_tier_templates)`).all() as any[];
  const hasRegion = cols.some(c => c.name === "region");
  if (!hasRegion) {
    sqlite.exec(`BEGIN TRANSACTION;
      ALTER TABLE pitch_tier_templates RENAME TO _pitch_tier_templates_old;
      CREATE TABLE pitch_tier_templates (
        region TEXT NOT NULL DEFAULT 'global',
        tier_key TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        monthly_usd REAL NOT NULL DEFAULT 0,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (region, tier_key)
      );
      INSERT INTO pitch_tier_templates (region, tier_key, label, sort_order, monthly_usd, description, active, updated_at)
        SELECT 'global', tier_key, label, sort_order, monthly_usd, description, active, updated_at FROM _pitch_tier_templates_old;
      DROP TABLE _pitch_tier_templates_old;
    COMMIT;`);
    console.log("[pitch] migrated pitch_tier_templates to region-scoped PK");
  }
} catch (e) { console.error("[pitch] tier-template region migration failed:", e); }
try {
  const cols = sqlite.prepare(`PRAGMA table_info(pitch_tier_template_items)`).all() as any[];
  const hasRegion = cols.some(c => c.name === "region");
  if (!hasRegion) {
    sqlite.exec(`ALTER TABLE pitch_tier_template_items ADD COLUMN region TEXT NOT NULL DEFAULT 'global'`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_tier_items_region_tier ON pitch_tier_template_items(region, tier_key)`);
  }
} catch (e) { console.error("[pitch] tier-items region migration failed:", e); }

// PITCH — client proposals (digital, magic-link)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    magic_token TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL,
    client_logo_url TEXT,
    client_contact_name TEXT,
    client_contact_email TEXT,
    client_region TEXT,
    base_tier TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    fx_rate_to_usd REAL NOT NULL DEFAULT 1.0,
    fx_rate_date TEXT,
    contract_months INTEGER NOT NULL DEFAULT 6,
    override_discount_pct REAL NOT NULL DEFAULT 0,
    pricing_posture TEXT,
    levers_json TEXT,
    target_monthly_usd REAL,
    intro_text TEXT,
    competitors_json TEXT,
    brands_json TEXT,
    notify_emails_json TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    expires_at TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    first_viewed_at TEXT,
    last_viewed_at TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    decided_at TEXT,
    decision TEXT,
    decision_name TEXT,
    decision_ip TEXT,
    decision_user_agent TEXT,
    decision_comment TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pitch_proposals_status ON pitch_proposals(status);
  CREATE INDEX IF NOT EXISTS idx_pitch_proposals_created_by ON pitch_proposals(created_by);
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES pitch_proposals(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'core',
    label TEXT NOT NULL,
    description TEXT,
    qty REAL NOT NULL DEFAULT 1,
    unit TEXT,
    unit_price_usd REAL NOT NULL DEFAULT 0,
    included INTEGER NOT NULL DEFAULT 1,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pitch_line_items_proposal ON pitch_line_items(proposal_id);
`);
// 2026-06: complimentary-bolton flag + original price snapshot. Lets the
// public view show a struck-through original price next to a green
// COMPLIMENTARY badge while keeping the effective unit_price_usd at 0.
try { sqlite.exec(`ALTER TABLE pitch_line_items ADD COLUMN is_complimentary INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_line_items ADD COLUMN original_unit_price_usd REAL`); } catch {}
sqlite.exec(`
  -- placeholder so the closing backtick of the original CREATE block stays valid
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES pitch_proposals(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT,
    section TEXT,
    duration_seconds INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pitch_views_proposal ON pitch_views(proposal_id);
`);

// Redline sub-edit jobs
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS redline_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    original_text TEXT,
    edited_text TEXT,
    changes_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

// Clean up multi-page review duplicates (Stereophile etc.)
// Delete sub-pages when the base review article also exists from the same site
try {
  const allArticles = sqlite.prepare(`SELECT id, site, title FROM articles ORDER BY length(title) ASC`).all() as { id: number; site: string; title: string }[];
  const baseTitles = new Map<string, Set<string>>(); // site -> set of titles
  const toDelete: number[] = [];
  for (const a of allArticles) {
    if (!baseTitles.has(a.site)) baseTitles.set(a.site, new Set());
    const siteSet = baseTitles.get(a.site)!;
    // Check if this title is a sub-page of an existing shorter title
    let isDuplicate = false;
    for (const existing of siteSet) {
      if (a.title.startsWith(existing + " ") && a.title.length > existing.length) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      toDelete.push(a.id);
    } else {
      siteSet.add(a.title);
    }
  }
  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => "?").join(",");
    sqlite.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).run(...toDelete);
    console.log(`[cleanup] Removed ${toDelete.length} multi-page duplicate articles`);
  }
} catch (e) { console.error("[cleanup] dedup error:", e); }

// Article hit counts cache
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS article_hits (
    url TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try { sqlite.exec(`ALTER TABLE article_hits ADD COLUMN image TEXT`); } catch {}

// Hit count history for trending detection
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS article_hits_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    hits INTEGER NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_hits_history_url ON article_hits_history(url)`); } catch {}

// Clean duplicate EE-backfilled articles (same title, different URL from RSS version)
try {
  const dupes = sqlite.prepare(`
    DELETE FROM articles WHERE id IN (
      SELECT a1.id FROM articles a1
      INNER JOIN articles a2 ON a1.site = a2.site AND a1.title = a2.title AND a1.id > a2.id
      WHERE a1.site = 'stereonet'
    )
  `).run();
  if (dupes.changes > 0) console.log(`[cleanup] Removed ${dupes.changes} duplicate stereonet articles`);
} catch {}

// Clean broken EE-backfilled articles (missing published_date)
try {
  const cleaned = sqlite.prepare(`DELETE FROM articles WHERE published_date IS NULL OR published_date = ''`).run();
  if (cleaned.changes > 0) console.log(`[cleanup] Removed ${cleaned.changes} articles with missing dates`);
} catch {}

// Clean bad forum stats (topics/posts should have k/m suffix like "601.4k")
try { sqlite.prepare(`DELETE FROM forum_stats WHERE total_topics NOT LIKE '%k' AND total_topics NOT LIKE '%m'`).run(); } catch {}
try { sqlite.exec(`ALTER TABLE forum_stats ADD COLUMN total_members TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE forum_stats ADD COLUMN total_topics_precise INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE forum_stats ADD COLUMN total_posts_precise INTEGER`); } catch {}
try { sqlite.exec(`ALTER TABLE forum_stats ADD COLUMN total_members_precise INTEGER`); } catch {}

// ─── Media Kits ─────────────────────────────────────────────────────────────
// One canonical Trade kit + regional overrides (anz, uk_eu, asia, na).
// One Retailer kit (no regional overrides — single USD kit with live FX display).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'trade',            -- 'trade' | 'retailer'
    region TEXT,                                    -- NULL for canonical & retailer; else 'anz','uk_eu','asia','na'
    is_canonical INTEGER NOT NULL DEFAULT 0,
    parent_kit_id INTEGER,                          -- regional kits point at their canonical
    label TEXT NOT NULL,
    subtitle TEXT,
    version_quarter TEXT,                           -- e.g. 'Q1 2026'
    status TEXT NOT NULL DEFAULT 'draft',           -- 'draft' | 'published' | 'archived'
    base_currency TEXT NOT NULL DEFAULT 'USD',
    tax_suffix TEXT DEFAULT 'no tax',               -- ' no tax', ' ex GST', etc.
    intro_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (parent_kit_id) REFERENCES media_kits(id)
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kits_kind ON media_kits(kind, region)`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kits ADD COLUMN prospect_lead_id INTEGER REFERENCES pitch_inbound_leads(id) ON DELETE SET NULL`); } catch {} // 2026-06: per-prospect kit clones
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kits_prospect ON media_kits(prospect_lead_id)`); } catch {}
// 2026-06: billing_period — controls how a tier or bolt-on price is
// interpreted. 'monthly' = recurring per month (default, existing behaviour).
// 'annual' = recurring per year (Retailer Partner tier).
// 'one_off' = single charge (used by some bolt-ons, also implied by casual
// proposals). When NULL we treat as 'monthly' for backwards compatibility.
try { sqlite.exec(`ALTER TABLE media_kit_addons ADD COLUMN billing_period TEXT`); } catch {}

// 2026-06: locked_currency — when set, public retailer kit shows ONLY this currency
// (no selector). Used by Retailer Proposals to freeze a customer-specific currency
// on their kit clone. NULL = show currency selector to public viewers.
try { sqlite.exec(`ALTER TABLE media_kits ADD COLUMN locked_currency TEXT`); } catch {}

// 2026-06: FX rates cache. Pulled from a public mid-market FX API once per day.
// Rates are stored as multipliers from USD (base = 1.0). On lookup failure we
// fall back to hardcoded defaults (see ensureFxRates) so the public kit never
// renders blank prices.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS fx_rates (
    code TEXT PRIMARY KEY,
    rate_from_usd REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Polymorphic block storage. content_json is the block-type-specific payload.
// is_override = 1 means this row overrides the canonical block of the same
// (kit_id grouped by parent) — only used on regional kits.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kit_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id INTEGER NOT NULL,
    block_key TEXT NOT NULL,                        -- 'hero','who_are_we','why_us','audience','offer','investment','casual','boltons','ready','terms','contact'
    position INTEGER NOT NULL DEFAULT 0,
    is_override INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    content_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(kit_id, block_key),
    FOREIGN KEY (kit_id) REFERENCES media_kits(id) ON DELETE CASCADE
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kit_blocks_kit ON media_kit_blocks(kit_id, position)`); } catch {}
// edited_at: timestamp the block was last touched by a user. Used to distinguish
// blocks that were copy-pasted onto a clone (legacy) from blocks the admin has actually customised.
try { sqlite.exec(`ALTER TABLE media_kit_blocks ADD COLUMN edited_at TEXT`); } catch {}
// addon_order_override_json: per-kit override of inherited addon display order.
// Shape: { "tier": ["addon_key", ...], "bolton": ["addon_key", ...] }
// When set, the public viewer sorts addons by this list; unknown keys fall back to position order.
// Lets prospect clones reorder their addons without mutating the shared regional master.
try { sqlite.exec(`ALTER TABLE media_kits ADD COLUMN addon_order_override_json TEXT`); } catch {}
// 2026-06: block_order_override_json — per-kit override of content-block
// display order. NULL = inherit canonical position. Array of block_keys in
// the desired order. Renderer (getEffectiveBlocks) applies this when set.
try { sqlite.exec(`ALTER TABLE media_kits ADD COLUMN block_order_override_json TEXT`); } catch {}

// Shared add-on catalogue used by Media Kits AND PITCH. 'tier' rows are the
// Bronze/Silver/Gold etc. subscription packages; 'bolton' rows are the one-off
// Masthead, Diamond, Newsletter, EDM, Social, Brand Profile promos.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kit_addons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                             -- 'tier' | 'bolton'
    addon_key TEXT NOT NULL,                        -- 'bronze','silver','masthead','diamond_banner','edm','newsletter_banner','social_boost','brand_profile_meets','brand_profile_inside_track'
    region TEXT,                                    -- NULL = global / retailer fallback; else region scope
    audience_kind TEXT NOT NULL DEFAULT 'trade',    -- 'trade' | 'retailer' | 'both'
    label TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    price_value REAL,                               -- numeric, NULL for POA
    price_currency TEXT NOT NULL DEFAULT 'USD',
    price_suffix TEXT,                              -- 'no tax', 'ex GST', '/month', 'each'
    billing TEXT NOT NULL DEFAULT 'monthly',        -- 'monthly' | 'one_off' | '3_month' | 'poa'
    inclusions_json TEXT DEFAULT '{}',
    availability TEXT NOT NULL DEFAULT 'available', -- 'available' | 'sold_out' | 'coming_soon' | 'not_available'
    position INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    is_poa INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kit_addons_kind ON media_kit_addons(kind, region, audience_kind)`); } catch {}
// Migration: example_url column (added v2.18x) — used for "View example" CTA on bolt-on cards.
try { sqlite.exec(`ALTER TABLE media_kit_addons ADD COLUMN example_url TEXT`); } catch {}

// Shareable magic-link records — same pattern as pitch_proposals.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kit_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id INTEGER NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    magic_token TEXT NOT NULL,
    prospect_name TEXT,
    prospect_email TEXT,
    prospect_company TEXT,
    note TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'revoked' | 'expired'
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (kit_id) REFERENCES media_kits(id) ON DELETE CASCADE
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kit_shares_kit ON media_kit_shares(kit_id, status)`); } catch {}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kit_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id INTEGER NOT NULL,
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT,
    time_on_page_seconds INTEGER,
    scroll_depth_pct INTEGER,
    FOREIGN KEY (share_id) REFERENCES media_kit_shares(id) ON DELETE CASCADE
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_media_kit_views_share ON media_kit_views(share_id, viewed_at DESC)`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_views ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_views ADD COLUMN bot_reason TEXT`); } catch {}
try { sqlite.exec(`ALTER TABLE media_kit_views ADD COLUMN recipient_email TEXT`); } catch {}

// Per-recipient share tokens. When a proposal is sent to multiple contacts,
// each one gets their own unique token in the magic link so we can attribute
// opens individually. share_id + recipient_email + token are the row identity.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS media_kit_share_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id INTEGER NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT,
    token TEXT NOT NULL UNIQUE,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    first_viewed_at TEXT,
    last_viewed_at TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (share_id) REFERENCES media_kit_shares(id) ON DELETE CASCADE
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_mkr_share ON media_kit_share_recipients(share_id)`); } catch {}
try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkr_share_email ON media_kit_share_recipients(share_id, recipient_email)`); } catch {}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pitch_inbound_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'advertising_page',  -- 'advertising_page' | 'manual' | 'pitch_referral'
    name TEXT,
    company TEXT,
    company_type TEXT,                                 -- 'manufacturer' | 'distributor' | 'retailer' | 'other'
    role TEXT,
    country TEXT,                                      -- ISO-2 or free text
    region TEXT,                                       -- 'anz' | 'uk_eu' | 'asia' | 'na' | 'global'
    email TEXT,
    phone TEXT,
    message TEXT,
    interests_json TEXT,                               -- JSON array: ['news','reviews','banners','forum','newsletter','social','classifieds','brand','ai','other']
    kit_share_id INTEGER,                              -- linked auto-sent share
    status TEXT NOT NULL DEFAULT 'new',                -- 'new' | 'contacted' | 'qualified' | 'won' | 'lost'
    assigned_to INTEGER,
    notes TEXT,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (kit_share_id) REFERENCES media_kit_shares(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_inbound_leads_status ON pitch_inbound_leads(status, created_at DESC)`); } catch {}
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pitch_inbound_leads_email ON pitch_inbound_leads(email)`); } catch {}
try { sqlite.exec(`ALTER TABLE pitch_inbound_leads ADD COLUMN company_type TEXT`); } catch {} // 2026-06: company type field

// 2026-06: /advertising page hit log. One row per page view. Bot-light: same-IP
// within 60s is suppressed at insert time by the route handler.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS advertising_page_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT,
    referrer TEXT
  )
`);
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_advertising_page_hits_ts ON advertising_page_hits(ts DESC)`); } catch {}
try { sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_advertising_page_hits_ip_ts ON advertising_page_hits(ip, ts DESC)`); } catch {}

// 2026-06: one-time backfill — repair StereoNET article URLs that are missing
// their content-type segment (/news/, /reviews/, /opinion/, /features/). The
// flag in app_settings ensures the heavy scan runs only the first time per db.
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'stereonet_url_backfill_v1'`).get() as any;
  if (!flag) {
    const segFor = (t: string | null) => t === "review" ? "reviews" : t === "news" ? "news" : t === "opinion" ? "opinion" : t === "feature" ? "features" : null;
    const ALREADY_RE = /^\/(news|reviews|opinion|features|opinions|review|headphone-zone|tag|category|series|forum|product-news|videos|video|in-the-press|press-release|press-releases|podcast|podcasts|community|guide|guides|deals|gallery|images|account|advertising)(\/|$)/i;
    const rows = sqlite.prepare(`SELECT id, url, content_type FROM articles WHERE site = 'stereonet'`).all() as any[];
    let fixed = 0, skipped = 0, collided = 0;
    const updateStmt = sqlite.prepare(`UPDATE articles SET url = ? WHERE id = ?`);
    const existsStmt = sqlite.prepare(`SELECT id FROM articles WHERE url = ?`);
    const deleteStmt = sqlite.prepare(`DELETE FROM articles WHERE id = ?`);
    for (const r of rows) {
      try {
        const u = new URL(r.url);
        if (!/(^|\.)stereonet\.com$/i.test(u.hostname)) { skipped++; continue; }
        if (ALREADY_RE.test(u.pathname)) { skipped++; continue; }
        const path = u.pathname.replace(/^\/+/, "");
        if (!path) { skipped++; continue; }
        const seg = segFor(r.content_type);
        if (!seg) { skipped++; continue; }
        u.pathname = `/${seg}/${path}`;
        const newUrl = u.toString();
        const dupe = existsStmt.get(newUrl) as any;
        if (dupe && dupe.id !== r.id) {
          deleteStmt.run(r.id);
          collided++;
          continue;
        }
        updateStmt.run(newUrl, r.id);
        fixed++;
      } catch { skipped++; }
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('stereonet_url_backfill_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), fixed, skipped, collided }));
    console.log(`[storage] StereoNET URL backfill complete: fixed=${fixed} skipped=${skipped} collided=${collided}`);
  }
} catch (e) { console.warn("[storage] StereoNET URL backfill failed:", e); }

// Article relevance feedback
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS article_relevance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_url TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    relevant INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(article_url, user_id)
  );
`);

// Tracked sites (dynamic, DB-managed)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS tracked_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    rss_url TEXT NOT NULL,
    site_url TEXT,
    color TEXT NOT NULL DEFAULT '#6b7280',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Forum stats snapshots
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS forum_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    active_ads INTEGER,
    total_ads INTEGER,
    successful_sales INTEGER,
    clearance_rate TEXT,
    total_sales_14d TEXT,
    total_ads_value TEXT,
    total_topics TEXT,
    total_posts TEXT
  );

  CREATE TABLE IF NOT EXISTS article_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id)
  );
  CREATE INDEX IF NOT EXISTS idx_comments_article ON article_comments(article_id);

  CREATE TABLE IF NOT EXISTS comment_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (comment_id) REFERENCES article_comments(id) ON DELETE CASCADE,
    UNIQUE(comment_id, username, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_comment ON comment_reactions(comment_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    from_user TEXT NOT NULL,
    article_id INTEGER,
    comment_id INTEGER,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(username, read);

  CREATE TABLE IF NOT EXISTS article_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL UNIQUE,
    username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed',
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id)
  );
  CREATE INDEX IF NOT EXISTS idx_claims_article ON article_claims(article_id);
`);

// Migration: add language column to tracked_sites if missing. ISO 639-1 code,
// 'en' for English (default), 'de' for German, etc. Used to drive automatic
// title translation on the Discovery view.
try {
  sqlite.prepare(`SELECT language FROM tracked_sites LIMIT 1`).get();
} catch {
  sqlite.exec(`ALTER TABLE tracked_sites ADD COLUMN language TEXT NOT NULL DEFAULT 'en'`);
  // Seed known foreign-language sites we've added so far.
  sqlite.prepare(`UPDATE tracked_sites SET language = 'de' WHERE site_key = 'hifi_de' OR site_key = 'hifide' OR site_url LIKE '%hifi.de%' OR rss_url LIKE '%hifi.de%'`).run();
}

// Migration: add exclude_velocity column to tracked_sites if missing
try {
  sqlite.prepare(`SELECT exclude_velocity FROM tracked_sites LIMIT 1`).get();
} catch {
  sqlite.exec(`ALTER TABLE tracked_sites ADD COLUMN exclude_velocity INTEGER NOT NULL DEFAULT 0`);
}

// Migration: add status column to article_claims if missing
try {
  sqlite.prepare(`SELECT status FROM article_claims LIMIT 1`).get();
} catch {
  sqlite.exec(`ALTER TABLE article_claims ADD COLUMN status TEXT NOT NULL DEFAULT 'claimed'`);
}

sqlite.exec(`

  CREATE TABLE IF NOT EXISTS article_dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(article_id, username)
  );
  CREATE INDEX IF NOT EXISTS idx_dismissals_user ON article_dismissals(username);

  CREATE TABLE IF NOT EXISTS irrelevant_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    site TEXT NOT NULL,
    username TEXT NOT NULL,
    marked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(article_id, username)
  );

  CREATE TABLE IF NOT EXISTS blocked_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'learned',
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS article_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT 'Please Write',
    pinned_by TEXT NOT NULL,
    pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id)
  );
`);

export interface TrackedSite {
  id: number;
  site_key: string;
  label: string;
  rss_url: string;
  site_url: string | null;
  color: string;
  enabled: number;
  exclude_velocity: number;
  created_at: string;
}

export interface AuthorCount {
  author: string;
  count: number;
}

export interface HeatmapRow {
  site: string;
  dow: number; // 0=Sun, 1=Mon ... 6=Sat
  count: number;
}

export interface TimeOfDayRow {
  site: string;
  hour: number;
  count: number;
}

export interface AuthorWeeklyRow {
  author: string;
  week: string; // YYYY-WW
  count: number;
}

export interface BrandRow {
  brand: string;
  total: number;
  sites: string; // JSON: {site: count}
}

export interface TopicOverlapRow {
  brand: string;
  sites: string; // comma-separated site keys
  site_count: number;
  article_count: number;
  stereonet_only: number; // 1 if only stereonet covers it
}

export interface VelocityRow {
  site: string;
  avgPerDay: number;
  total: number;
  gap: number; // positive = StereoNET leads, negative = competitor leads
}

export interface FirstMoverTopic {
  brand: string;
  firstSite: string;       // who published first
  firstDate: string;       // YYYY-MM-DD
  stereonetDate: string | null;
  daysBehind: number;      // 0 = first or joint, positive = behind
  jointFirst: boolean;
  siteCount: number;
}

export interface FirstMoverData {
  score: number;           // 0-100 %
  firstCount: number;      // topics where SN was first or joint
  totalTopics: number;     // total multi-site topics
  topics: FirstMoverTopic[];
}

export interface ScorecardData {
  current: { total: number; review: number; news: number; feature: number; opinion: number; avgPerDay: number; topAuthor: string | null; topBrand: string | null; };
  previous: { total: number; review: number; news: number; feature: number; opinion: number; avgPerDay: number; topAuthor: string | null; topBrand: string | null; };
  shareOfVoice: { current: number; previous: number }; // % of all-site output
}

export interface IStorage {
  getArticles(opts?: { site?: string; contentType?: string; fromDate?: string; toDate?: string }): Article[];
  insertArticle(a: InsertArticle): boolean;
  insertEditorBriefArticle(a: any): number | null;
  getArticleCount(): number;
  getDailyBreakdown(opts?: { site?: string; contentType?: string; fromDate?: string; toDate?: string }): DailyBreakdown[];
  getSiteBreakdown(opts?: { fromDate?: string; toDate?: string }): SiteTypeBreakdown[];
  getAuthorBreakdown(opts?: { fromDate?: string; toDate?: string }): AuthorCount[];
  getAuthorWeekly(opts?: { fromDate?: string; toDate?: string }): AuthorWeeklyRow[];
  getHeatmap(opts?: { fromDate?: string; toDate?: string }): HeatmapRow[];
  getTimeOfDay(opts?: { fromDate?: string; toDate?: string }): TimeOfDayRow[];
  getBrands(opts?: { fromDate?: string; toDate?: string; minCount?: number }): BrandRow[];
  getTopicOverlap(opts?: { fromDate?: string; toDate?: string; windowDays?: number }): TopicOverlapRow[];
  getScorecard(currentFrom: string, currentTo: string, previousFrom: string, previousTo: string): ScorecardData;
  deleteSeedData(): number;
  backfillTitles(): number;
  backfillBrands(): number;
  getVelocity(opts?: { fromDate?: string; toDate?: string }): VelocityRow[];
  getFirstMover(opts?: { fromDate?: string; toDate?: string }): FirstMoverData;
  getContentGaps(opts?: { fromDate?: string; toDate?: string }): { brand: string; competitorReviews: { site: string; title: string; date: string; url: string }[]; siteCount: number }[];
  getDiscoveryArticles(opts?: { search?: string; limit?: number }): (Article & { covered: boolean; filteredByKeyword?: string | null; bsidedAt?: string | null; titleEn?: string | null; sourceLang?: string | null })[]
  insertForumStats(stats: { active_ads: number; total_ads: number; successful_sales: number; clearance_rate: string; total_sales_14d: string; total_ads_value: string; total_topics: string; total_posts: string; total_members?: string; total_topics_precise?: number | null; total_posts_precise?: number | null; total_members_precise?: number | null }): void;
  getForumStats(): { current: any; previous: any } | null;
  clearForumStats(): void;
  upsertHitCounts(hits: { url: string; hits: number; image?: string }[]): void;
  getHitCounts(): Map<string, { hits: number; image: string | null }>;
  getMostViewedRecent(opts?: { hours?: number }): { article: Article; hits: number; deltaHits: number; image: string | null } | null;
  fixArticleAuthor(url: string, slug: string, author: string): void;
  getArticlesByAuthor(author: string): { title: string; url: string; published_date: string; type: string | null; brands: string | null }[];
  getAuthorStats(author: string): { thisWeek: number; thisMonth: number; allTime: number; rank: number; totalAuthors: number; streak: number; firstMoverPct: number; latestArticle: { title: string; url: string; published_date: string } | null } | null;
  getAuthorStreaks(): { author: string; streak: number }[];
  getUsers(): { id: number; username: string; role: string; created_at: string; last_login: string | null; redline_access: number; pitch_access: string; email: string; full_name: string; notify_regions: string }[];
  getUser(username: string): { id: number; username: string; password: string; role: string; redline_access: number; pitch_access?: string } | undefined;
  setPitchAccess(id: number, level: "none" | "view" | "edit" | "admin"): void;
  setUserEmail(id: number, email: string | null): void;
  setUserFullName(id: number, fullName: string | null): void;
  setNotifyRegions(id: number, csv: string): void;
  getUserSenderInfo(username: string): { email: string | null; name: string | null };
  upsertUser(username: string, password: string, role: string): void;
  updateLastLogin(username: string): void;
  updatePassword(id: number, password: string): void;
  deleteUser(id: number): void;
  setRedlineAccess(id: number, access: boolean): void;
  getUserCount(): number;
  insertRedlineJob(userId: number, filename: string, originalText: string): number;
  updateRedlineJob(id: number, status: string, editedText?: string, changesSummary?: string): void;
  getRedlineJobs(userId: number): any[];
  getRedlineJob(id: number): any;
  setArticleRelevance(articleUrl: string, userId: number, relevant: boolean): void;
  removeArticleRelevance(articleUrl: string, userId: number): void;
  getArticleRelevance(): { article_url: string; relevant: number; not_relevant: number }[];
  getLatestRefresh(): RefreshLog | undefined;
  logRefresh(added: number, status: string, notes?: string): void;
  getSites(): TrackedSite[];
  getEnabledSites(): TrackedSite[];
  addSite(siteKey: string, label: string, rssUrl: string, siteUrl: string | null, color: string): number;
  updateSite(id: number, fields: Partial<{ label: string; rss_url: string; site_url: string | null; color: string; enabled: number; exclude_velocity: number }>): void;
  deleteSite(id: number): void;
  seedSitesIfEmpty(): void;
  getArticleComments(articleId: number): { id: number; article_id: number; username: string; comment: string; created_at: string }[];
  addArticleComment(articleId: number, username: string, comment: string): number;
  deleteArticleComment(id: number): void;
  getCommentCounts(): { article_id: number; count: number }[];
  toggleReaction(commentId: number, username: string, emoji: string): boolean;
  getReactionsForComments(commentIds: number[]): { comment_id: number; emoji: string; username: string }[];
  addNotification(username: string, type: string, message: string, fromUser: string, articleId?: number, commentId?: number): number;
  getNotifications(username: string, limit?: number): { id: number; username: string; type: string; message: string; from_user: string; article_id: number | null; comment_id: number | null; read: number; created_at: string }[];
  getUnreadCount(username: string): number;
  markNotificationRead(id: number): void;
  markAllNotificationsRead(username: string): void;
  getCommentOwner(commentId: number): string | null;
  getCommentersForArticle(articleId: number): string[];
  getArticleTitle(articleId: number): string | null;
  claimArticle(articleId: number, username: string): void;
  unclaimArticle(articleId: number): void;
  markWritten(articleId: number): void;
  getClaims(): { article_id: number; username: string; status: string; claimed_at: string }[];
  getWrittenArticles(): { article_id: number; username: string; claimed_at: string }[];
  getClaim(articleId: number): { article_id: number; username: string; status: string; claimed_at: string } | null;
  dismissArticle(articleId: number, username: string): void;
  undismissArticle(articleId: number): void;
  getDismissals(): { article_id: number; username: string; dismissed_at: string }[];
  pinArticle(articleId: number, username: string, note?: string): void;
  unpinArticle(articleId: number): void;
  getPins(): { article_id: number; note: string; pinned_by: string; pinned_at: string }[];
  markIrrelevant(articleId: number, title: string, site: string, username: string): void;
  getIrrelevantMarks(): { article_id: number; title: string; site: string; username: string; marked_at: string }[];
  removeIrrelevantMark(articleId: number): void;
  logAudit(entry: { username: string; action: string; articleId?: number | null; detail?: string | null }): void;
  getAuditLog(opts?: { limit?: number; articleId?: number; username?: string; action?: string }): any[];
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  getTopPicks(date: string): { date: string; generated_at: string; picks_json: string } | null;
  setTopPicks(date: string, picksJson: string): void;
  getBlockedKeywords(): { id: number; keyword: string; source: string; hit_count: number; created_at: string }[];
  addBlockedKeyword(keyword: string, source?: string): void;
  removeBlockedKeyword(id: number): void;
  incrementBlockedKeywordHits(keyword: string): void;
  getIrrelevantArticleIds(): number[];
}

export interface DailyBreakdown {
  date: string;
  total: number;
  review: number;
  news: number;
  feature: number;
  opinion: number;
  unknown: number;
  [key: string]: string | number;
}

export interface SiteTypeBreakdown {
  site: string;
  contentType: string;
  count: number;
}

export const storage: IStorage = {
  getArticles(opts = {}) {
    let q = db.select().from(articles);
    const conditions = [];
    if (opts.site && opts.site !== "all") conditions.push(eq(articles.site, opts.site));
    if (opts.contentType && opts.contentType !== "all") conditions.push(eq(articles.contentType, opts.contentType));
    if (opts.fromDate) conditions.push(gte(articles.publishedDate, opts.fromDate));
    if (opts.toDate) conditions.push(lte(articles.publishedDate, opts.toDate));
    const filtered = conditions.length > 0
      ? db.select().from(articles).where(and(...conditions)).orderBy(desc(articles.publishedAt)).all()
      : db.select().from(articles).orderBy(desc(articles.publishedAt)).all();
    return filtered;
  },

  // Insert a webhook-ingested article with full editor-brief support.
  // Returns the article id on success, or null if a row with this URL already exists.
  // Raw SQL so we can include columns that aren't in the Drizzle schema.
  insertEditorBriefArticle(a: {
    site: string;
    title: string;
    url: string;
    publishedAt: string;
    publishedDate: string;
    contentType: string;
    categories: string;         // JSON
    author: string | null;
    brands: string;             // JSON
    fetchedAt: string;
    summary?: string | null;
    briefMarkdown?: string | null;
    heroImageUrl?: string | null;
    attachments?: string | null;   // JSON array (see /api/ingest/article)
    pleaseWrite?: boolean;
    pinnedBy?: string | null;
    suggestedWordCount?: string | null;
    suggestedHeadlines?: string | null;  // JSON
    openQuestions?: string | null;       // JSON
    sources?: string | null;             // JSON
  }): number | null {
    try {
      const result = sqlite.prepare(`
        INSERT INTO articles (
          site, title, url, published_at, published_date, content_type,
          categories, author, brands, fetched_at,
          summary, brief_markdown, hero_image_url, attachments,
          please_write, pinned_by,
          suggested_word_count, suggested_headlines, open_questions, sources
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        a.site, a.title, a.url, a.publishedAt, a.publishedDate, a.contentType,
        a.categories, a.author, a.brands, a.fetchedAt,
        a.summary || null, a.briefMarkdown || null, a.heroImageUrl || null, a.attachments || null,
        a.pleaseWrite ? 1 : 0, a.pinnedBy || null,
        a.suggestedWordCount || null, a.suggestedHeadlines || null, a.openQuestions || null, a.sources || null,
      );
      return Number(result.lastInsertRowid);
    } catch {
      // Duplicate URL — update the editor-brief fields so a re-fire of the same
      // story with richer metadata overwrites the stub.
      try {
        const existing = sqlite.prepare(`SELECT id FROM articles WHERE url = ?`).get(a.url) as { id: number } | undefined;
        if (!existing) return null;
        sqlite.prepare(`
          UPDATE articles SET
            title = ?, summary = ?, brief_markdown = ?, hero_image_url = ?,
            attachments = ?, please_write = ?, pinned_by = ?,
            suggested_word_count = ?, suggested_headlines = ?, open_questions = ?, sources = ?
          WHERE id = ?
        `).run(
          a.title,
          a.summary || null, a.briefMarkdown || null, a.heroImageUrl || null,
          a.attachments || null, a.pleaseWrite ? 1 : 0, a.pinnedBy || null,
          a.suggestedWordCount || null, a.suggestedHeadlines || null, a.openQuestions || null, a.sources || null,
          existing.id,
        );
        return existing.id;
      } catch {
        return null;
      }
    }
  },

  insertArticle(a: InsertArticle): boolean {
    try {
      // Per-site category allowlist at ingest time. Configured in
      // site_ingest_filters — for general-tech publishers we only accept
      // articles whose categories intersect the allowlist (e.g. gearpatrol
      // only accepts articles categorised as audio/headphones/hi-fi).
      // Articles that don't match are silently dropped at ingest — they never
      // enter Discovery, never learn state, never generate hot-story noise.
      try {
        const filter = sqlite.prepare(`SELECT categories_include_json, url_include_patterns_json FROM site_ingest_filters WHERE site_key = ?`).get(a.site) as any;
        if (filter) {
          const catInclude: string[] = (() => { try { return JSON.parse(filter.categories_include_json || "[]"); } catch { return []; } })();
          const urlPatterns: string[] = (() => { try { return JSON.parse(filter.url_include_patterns_json || "[]"); } catch { return []; } })();
          const hasFilter = catInclude.length > 0 || urlPatterns.length > 0;
          if (hasFilter) {
            // Article's categories (JSON array in the InsertArticle payload)
            let articleCats: string[] = [];
            try { articleCats = JSON.parse((a as any).categories || "[]"); } catch {}
            if (!Array.isArray(articleCats)) articleCats = [];
            const articleCatsLower = articleCats.map(c => String(c).toLowerCase());
            const catMatch = catInclude.length === 0 || catInclude.some(allowed => articleCatsLower.includes(String(allowed).toLowerCase()));
            const urlMatch = urlPatterns.length === 0 || urlPatterns.some(p => (a.url || "").toLowerCase().includes(String(p).toLowerCase()));
            if (!(catMatch || urlMatch)) {
              // Log to a lightweight audit so we can see what got filtered out
              try {
                sqlite.prepare(`
                  INSERT INTO site_ingest_filter_drops (site, title, url, categories_json, dropped_at)
                  VALUES (?, ?, ?, ?, datetime('now'))
                `).run(a.site, a.title, a.url, (a as any).categories || "[]");
              } catch {}
              return false;
            }
          }
        }
      } catch (e) {
        // If the filter table doesn't exist yet, fall through and behave as before.
      }

      // Check if this is a sub-page of an existing article from the same site
      // e.g. "Product Review Measurements" when "Product Review" already exists
      // Only match when the base title is long enough (>30 chars) and suffix is short (<50 chars)
      const existing = sqlite.prepare(
        `SELECT id FROM articles WHERE site = ? AND ? LIKE title || ' %' AND length(title) > 30 AND length(?) - length(title) < 50 LIMIT 1`
      ).get(a.site, a.title, a.title) as { id: number } | undefined;
      if (existing) return false; // Skip sub-page

      db.insert(articles).values(a).run();
      return true;
    } catch {
      // Duplicate URL — update author/brands if previously missing
      // Also try matching by title+site for EE backfill (different URL format)
      try {
        if (a.author) {
          sqlite.prepare(`UPDATE articles SET author = ? WHERE url = ? AND (author IS NULL OR author = '' OR author = 'StereoNET')`).run(a.author, a.url);
          // Also try matching by title + site (handles EE vs RSS URL mismatch)
          sqlite.prepare(`UPDATE articles SET author = ? WHERE site = ? AND title = ? AND (author IS NULL OR author = '' OR author = 'StereoNET')`).run(a.author, a.site, a.title);
        }
        if (a.brands && a.brands !== '[]') {
          sqlite.prepare(`UPDATE articles SET brands = ? WHERE url = ? AND (brands IS NULL OR brands = '[]')`).run(a.brands, a.url);
        }
      } catch {}
      return false;
    }
  },

  getArticleCount() {
    const result = sqlite.prepare("SELECT COUNT(*) as count FROM articles").get() as { count: number };
    return result.count;
  },

  getDailyBreakdown(opts = {}) {
    let whereClause = "1=1";
    const params: any[] = [];
    if (opts.site && opts.site !== "all") { whereClause += " AND site = ?"; params.push(opts.site); }
    if (opts.contentType && opts.contentType !== "all") { whereClause += " AND content_type = ?"; params.push(opts.contentType); }
    if (opts.fromDate) { whereClause += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { whereClause += " AND published_date <= ?"; params.push(opts.toDate); }

    const rows = sqlite.prepare(`
      SELECT 
        published_date as date,
        COUNT(*) as total,
        SUM(CASE WHEN content_type = 'review' THEN 1 ELSE 0 END) as review,
        SUM(CASE WHEN content_type = 'news' THEN 1 ELSE 0 END) as news,
        SUM(CASE WHEN content_type = 'feature' THEN 1 ELSE 0 END) as feature,
        SUM(CASE WHEN content_type = 'opinion' THEN 1 ELSE 0 END) as opinion,
        SUM(CASE WHEN content_type = 'unknown' THEN 1 ELSE 0 END) as unknown
      FROM articles
      WHERE ${whereClause}
      GROUP BY published_date
      ORDER BY published_date ASC
    `).all(...params) as DailyBreakdown[];
    return rows;
  },

  getAuthorBreakdown(opts = {}) {
    let whereClause = "site = 'stereonet' AND author IS NOT NULL AND author != ''";
    const params: any[] = [];
    if (opts.fromDate) { whereClause += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { whereClause += " AND published_date <= ?"; params.push(opts.toDate); }
    return sqlite.prepare(`
      SELECT author, COUNT(*) as count
      FROM articles
      WHERE ${whereClause}
      GROUP BY author
      ORDER BY count DESC
    `).all(...params) as AuthorCount[];
  },

  getAuthorWeekly(opts: { fromDate?: string; toDate?: string } = {}) {
    let where = "site = 'stereonet' AND author IS NOT NULL AND author != ''";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }
    return sqlite.prepare(`
      SELECT author,
             strftime('%Y-W%W', published_date) as week,
             COUNT(*) as count
      FROM articles
      WHERE ${where}
      GROUP BY author, week
      ORDER BY week ASC, count DESC
    `).all(...params) as AuthorWeeklyRow[];
  },

  getHeatmap(opts: { fromDate?: string; toDate?: string } = {}) {
    let where = "site != 'headfi'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }
    return sqlite.prepare(`
      SELECT site,
             CAST(strftime('%w', published_date) AS INTEGER) as dow,
             COUNT(*) as count
      FROM articles
      WHERE ${where}
      GROUP BY site, dow
      ORDER BY site, dow
    `).all(...params) as HeatmapRow[];
  },

  getTimeOfDay(opts: { fromDate?: string; toDate?: string } = {}) {
    let where = "site != 'headfi'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }
    return sqlite.prepare(`
      SELECT site,
             CAST(strftime('%H', published_at) AS INTEGER) as hour,
             COUNT(*) as count
      FROM articles
      WHERE ${where}
      GROUP BY site, hour
      ORDER BY site, hour
    `).all(...params) as TimeOfDayRow[];
  },

  getBrands(opts: { fromDate?: string; toDate?: string; minCount?: number } = {}) {
    let where = "site != 'headfi' AND brands IS NOT NULL AND brands != '[]'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }
    // Explode brands JSON array per article using the articles table
    const rows = sqlite.prepare(`SELECT site, brands FROM articles WHERE ${where}`).all(...params) as { site: string; brands: string }[];
    // Tally in JS since SQLite doesn't have JSON_EACH without extension
    const tally = new Map<string, Map<string, number>>();
    for (const row of rows) {
      let parsed: string[];
      try { parsed = JSON.parse(row.brands); } catch { continue; }
      for (const brand of parsed) {
        if (!tally.has(brand)) tally.set(brand, new Map());
        const siteCounts = tally.get(brand)!;
        siteCounts.set(row.site, (siteCounts.get(row.site) ?? 0) + 1);
      }
    }
    const minCount = opts.minCount ?? 2;
    return [...tally.entries()]
      .map(([brand, siteCounts]) => ({
        brand,
        total: [...siteCounts.values()].reduce((a, b) => a + b, 0),
        sites: JSON.stringify(Object.fromEntries(siteCounts)),
      }))
      .filter(r => r.total >= minCount)
      .sort((a, b) => b.total - a.total)
      .slice(0, 100) as BrandRow[];
  },

  getTopicOverlap(opts: { fromDate?: string; toDate?: string; windowDays?: number } = {}) {
    let where = "site != 'headfi' AND brands IS NOT NULL AND brands != '[]'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }
    const rows = sqlite.prepare(`SELECT site, brands, published_date FROM articles WHERE ${where}`).all(...params) as { site: string; brands: string; published_date: string }[];
    // Group: for each brand, find which sites covered it within rolling 7-day windows
    const windowDays = opts.windowDays ?? 7;
    const brandArticles = new Map<string, { site: string; date: string }[]>();
    for (const row of rows) {
      let parsed: string[];
      try { parsed = JSON.parse(row.brands); } catch { continue; }
      for (const brand of parsed) {
        if (!brandArticles.has(brand)) brandArticles.set(brand, []);
        brandArticles.get(brand)!.push({ site: row.site, date: row.published_date });
      }
    }
    const results: TopicOverlapRow[] = [];
    for (const [brand, articles] of brandArticles.entries()) {
      // Find unique sites
      const sitesSet = new Set(articles.map(a => a.site));
      const stereonetOnly = sitesSet.size === 1 && sitesSet.has("stereonet") ? 1 : 0;
      if (articles.length < 2 && !stereonetOnly) continue;
      results.push({
        brand,
        sites: [...sitesSet].join(","),
        site_count: sitesSet.size,
        article_count: articles.length,
        stereonet_only: stereonetOnly,
      });
    }
    // Deduplicate: remove topics that are substrings of longer topics
    const sorted = results.sort((a, b) => b.brand.length - a.brand.length);
    const kept: TopicOverlapRow[] = [];
    const keptBrands = new Set<string>();
    for (const r of sorted) {
      const dominated = sorted.some(other =>
        other.brand !== r.brand &&
        other.brand.toLowerCase().includes(r.brand.toLowerCase()) &&
        !keptBrands.has(other.brand)
      );
      if (!dominated) {
        kept.push(r);
        keptBrands.add(r.brand);
      }
    }

    return kept
      .sort((a, b) => b.article_count - a.article_count)
      .slice(0, 200) as TopicOverlapRow[];
  },

  getScorecard(currentFrom: string, currentTo: string, previousFrom: string, previousTo: string): ScorecardData {
    function periodStats(from: string, to: string) {
      const daily = sqlite.prepare(`
        SELECT published_date, content_type FROM articles
        WHERE site = 'stereonet' AND published_date >= ? AND published_date <= ?
      `).all(from, to) as { published_date: string; content_type: string }[];
      const total = daily.length;
      const review = daily.filter(r => r.content_type === 'review').length;
      const news = daily.filter(r => r.content_type === 'news').length;
      const feature = daily.filter(r => r.content_type === 'feature').length;
      const opinion = daily.filter(r => r.content_type === 'opinion').length;
      const days = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
      const avgPerDay = Math.round((total / days) * 10) / 10;
      const topAuthorRow = sqlite.prepare(`
        SELECT author, COUNT(*) as cnt FROM articles
        WHERE site = 'stereonet' AND author IS NOT NULL AND author != '' AND published_date >= ? AND published_date <= ?
        GROUP BY author ORDER BY cnt DESC LIMIT 1
      `).get(from, to) as { author: string } | undefined;
      const topBrandRow = sqlite.prepare(`
        SELECT brands, COUNT(*) as cnt FROM articles
        WHERE site = 'stereonet' AND brands IS NOT NULL AND published_date >= ? AND published_date <= ?
        GROUP BY brands ORDER BY cnt DESC LIMIT 1
      `).get(from, to) as { brands: string } | undefined;
      let topBrand: string | null = null;
      if (topBrandRow?.brands) {
        try { const b = JSON.parse(topBrandRow.brands); topBrand = b[0] ?? null; } catch {}
      }
      return { total, review, news, feature, opinion, avgPerDay, topAuthor: topAuthorRow?.author ?? null, topBrand };
    }

    function allSiteTotal(from: string, to: string) {
      const r = sqlite.prepare(`SELECT COUNT(*) as cnt FROM articles WHERE published_date >= ? AND published_date <= ?`).get(from, to) as { cnt: number };
      return r.cnt;
    }

    const current = periodStats(currentFrom, currentTo);
    const previous = periodStats(previousFrom, previousTo);
    const allCurrent = allSiteTotal(currentFrom, currentTo);
    const allPrevious = allSiteTotal(previousFrom, previousTo);

    return {
      current,
      previous,
      shareOfVoice: {
        current: allCurrent > 0 ? Math.round((current.total / allCurrent) * 1000) / 10 : 0,
        previous: allPrevious > 0 ? Math.round((previous.total / allPrevious) * 1000) / 10 : 0,
      },
    };
  },

  getSiteBreakdown(opts = {}) {
    let whereClause = "site != 'headfi'";
    const params: any[] = [];
    if (opts.fromDate) { whereClause += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { whereClause += " AND published_date <= ?"; params.push(opts.toDate); }
    const rows = sqlite.prepare(`
      SELECT site, content_type, COUNT(*) as count
      FROM articles
      WHERE ${whereClause}
      GROUP BY site, content_type
      ORDER BY site, count DESC
    `).all(...params) as SiteTypeBreakdown[];
    return rows;
  },

  deleteSeedData() {
    // Catch all seed data patterns:
    // 1. URLs ending in 3-4 digit numeric suffix (e.g. -982, -1654)
    // 2. URLs with /-NNN pattern (hifipig style)
    // 3. Google News RSS proxy URLs
    const seedPredicate = `url GLOB '*-[0-9][0-9][0-9]'
        OR url GLOB '*-[0-9][0-9][0-9][0-9]'
        OR url GLOB '*/-[0-9][0-9][0-9]'
        OR url GLOB '*/-[0-9][0-9][0-9][0-9]'
        OR url GLOB 'https://news.google.com/rss/articles/*'`;
    const txn = sqlite.transaction(() => {
      // Clean dependent rows on tables that reference articles(id) without ON DELETE CASCADE
      sqlite.prepare(`DELETE FROM article_pins WHERE article_id IN (SELECT id FROM articles WHERE ${seedPredicate})`).run();
      sqlite.prepare(`DELETE FROM article_claims WHERE article_id IN (SELECT id FROM articles WHERE ${seedPredicate})`).run();
      sqlite.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM article_comments WHERE article_id IN (SELECT id FROM articles WHERE ${seedPredicate}))`).run();
      sqlite.prepare(`DELETE FROM article_comments WHERE article_id IN (SELECT id FROM articles WHERE ${seedPredicate})`).run();
      sqlite.prepare(`DELETE FROM notifications WHERE article_id IN (SELECT id FROM articles WHERE ${seedPredicate})`).run();
    });
    try { txn(); } catch (e) { console.error("[cadence] deleteSeedData child cleanup failed:", e); }
    const result = sqlite.prepare(`DELETE FROM articles WHERE ${seedPredicate}`).run();
    console.log(`[cadence] Deleted ${result.changes} seed data articles`);
    return result.changes;
  },

  fixFutureDates() {
    // Fix articles with dates in the future (from misparsd RSS dates)
    const now = new Date();
    const cutoff = new Date(now.getTime() + 2 * 86400000).toISOString(); // 2 days from now
    const rows = sqlite.prepare(`
      SELECT id, published_at FROM articles WHERE published_at > ?
    `).all(cutoff) as { id: number; published_at: string }[];
    const update = sqlite.prepare(`UPDATE articles SET published_at = ?, published_date = ? WHERE id = ?`);
    let count = 0;
    for (const row of rows) {
      // Try swapping month and day
      const d = new Date(row.published_at);
      const swapped = new Date(d.getFullYear(), d.getDate() - 1, d.getMonth() + 1, d.getHours(), d.getMinutes());
      if (!isNaN(swapped.getTime()) && swapped.getTime() <= now.getTime() + 2 * 86400000) {
        update.run(swapped.toISOString(), swapped.toISOString().slice(0, 10), row.id);
      } else {
        // Just set to now
        update.run(now.toISOString(), now.toISOString().slice(0, 10), row.id);
      }
      count++;
    }
    if (count > 0) console.log(`[cadence] Fixed ${count} future-dated articles`);
    return count;
  },

  backfillTitles() {
    // Decode HTML entities in existing article titles
    const rows = sqlite.prepare(`SELECT id, title FROM articles WHERE title LIKE '%&#%' OR title LIKE '%&amp;%'`).all() as { id: number; title: string }[];
    const update = sqlite.prepare(`UPDATE articles SET title = ? WHERE id = ?`);
    let count = 0;
    for (const row of rows) {
      const decoded = row.title
        .replace(/&#0*38;|&amp;/g, "&")
        .replace(/&#0*60;|&lt;/g, "<")
        .replace(/&#0*62;|&gt;/g, ">")
        .replace(/&#0*34;|&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#8211;/g, "\u2013")
        .replace(/&#8212;/g, "\u2014")
        .replace(/&#8216;/g, "\u2018")
        .replace(/&#8217;/g, "\u2019")
        .replace(/&#8220;/g, "\u201C")
        .replace(/&#8221;/g, "\u201D")
        .replace(/&#124;/g, "|")
        .replace(/&#([0-9]+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .replace(/&[a-z]+;/gi, "");
      if (decoded !== row.title) {
        update.run(decoded, row.id);
        count++;
      }
    }
    console.log(`[cadence] Backfilled titles for ${count} articles`);
    return count;
  },

  backfillBrands() {
    // Run extractBrands on all articles that have NULL or empty brands
    const rows = sqlite.prepare(`SELECT id, title FROM articles WHERE brands IS NULL OR brands = '[]' OR brands = ''`).all() as { id: number; title: string }[];
    const update = sqlite.prepare(`UPDATE articles SET brands = ? WHERE id = ?`);
    let count = 0;
    for (const row of rows) {
      const brands = extractBrands(row.title);
      if (brands.length > 0) {
        update.run(JSON.stringify(brands), row.id);
        count++;
      }
    }
    console.log(`[cadence] Backfilled brands for ${count} articles`);
    return count;
  },

  // ── B-Sides (low-priority watch-list) ──
  // 28-day expiry window for the B-Sides tab. Rows older than this are
  // hidden from listings (but kept in DB, recoverable via direct query).
  listBSidedArticleIds(): Set<number> {
    const rows = sqlite.prepare(
      `SELECT article_id FROM article_bsides WHERE marked_at >= datetime('now', '-28 days')`
    ).all() as { article_id: number }[];
    return new Set(rows.map(r => r.article_id));
  },
  listBSidedDetailed(): { article_id: number; marked_by: string | null; marked_at: string }[] {
    return sqlite.prepare(
      `SELECT article_id, marked_by, marked_at FROM article_bsides
       WHERE marked_at >= datetime('now', '-28 days')
       ORDER BY marked_at DESC`
    ).all() as any[];
  },
  markBSide(articleId: number, username: string | null) {
    sqlite.prepare(
      `INSERT OR REPLACE INTO article_bsides (article_id, marked_by, marked_at) VALUES (?, ?, datetime('now'))`
    ).run(articleId, username);
  },
  unmarkBSide(articleId: number) {
    sqlite.prepare(`DELETE FROM article_bsides WHERE article_id = ?`).run(articleId);
  },

  // ── Title-keyword filters ──
  listFilterKeywords(): { id: number; keyword: string; created_at: string; created_by: string | null }[] {
    return sqlite.prepare(`SELECT id, keyword, created_at, created_by FROM filter_keywords ORDER BY keyword ASC`).all() as any[];
  },
  addFilterKeyword(keyword: string, createdBy: string | null = null): { id: number; keyword: string } | null {
    const k = keyword.trim();
    if (!k) return null;
    try {
      const r = sqlite.prepare(`INSERT INTO filter_keywords (keyword, created_by) VALUES (?, ?)`).run(k, createdBy);
      return { id: r.lastInsertRowid as number, keyword: k };
    } catch (e: any) {
      // UNIQUE constraint violation — keyword already exists
      if (String(e.message).includes("UNIQUE")) return null;
      throw e;
    }
  },
  removeFilterKeyword(id: number): boolean {
    const r = sqlite.prepare(`DELETE FROM filter_keywords WHERE id = ?`).run(id);
    return r.changes > 0;
  },

  // Re-extract brands for ALL articles (used after the brand extractor changes).
  // This is destructive in the sense it overwrites existing brands JSON, but
  // since extractBrands is deterministic and improving, that's the intent.
  reextractAllBrands() {
    const rows = sqlite.prepare(`SELECT id, title FROM articles`).all() as { id: number; title: string }[];
    const update = sqlite.prepare(`UPDATE articles SET brands = ? WHERE id = ?`);
    const tx = sqlite.transaction(() => {
      let count = 0;
      for (const row of rows) {
        const brands = extractBrands(row.title || "");
        update.run(JSON.stringify(brands), row.id);
        count++;
      }
      return count;
    });
    const count = tx();
    console.log(`[cadence] Re-extracted brands for ${count} articles`);
    return count;
  },

  getVelocity(opts: { fromDate?: string; toDate?: string } = {}) {
    let where = "1=1";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }

    // Get sites excluded from velocity graph
    const excludedSites = sqlite.prepare(
      `SELECT site_key FROM tracked_sites WHERE exclude_velocity = 1`
    ).all().map((r: any) => r.site_key) as string[];
    // Exclude non-competitor sources from velocity comparisons:
    // — StereoNET itself (we're comparing against it)
    // — headfi (historical)
    // — email_pressroom (forwarded press emails, not a publication)
    // — manufacturer newsrooms (they're brands, not competitor publications)
    // — Google News queries (aggregator, not a site publishing original content)
    const manufacturerKeys = ["dynaudio", "kef", "klipsch", "lg_newsroom", "mcintosh", "sonos_community", "samsung"];
    const googleNewsKeys = ["gn_bose", "gn_bowerswilkins", "gn_bang_olufsen", "gn_focal", "gn_denon", "gn_marantz", "gn_svs", "gn_sennheiser", "gn_audiotechnica", "gn_panasonic", "gn_sony_audio"];
    const excludeList = ["stereonet", "headfi", "email_pressroom", ...manufacturerKeys, ...googleNewsKeys, ...excludedSites];
    const placeholders = excludeList.map(() => "?").join(",");

    // Only include sites that are currently enabled in tracked_sites
    const enabledSites = sqlite.prepare(
      `SELECT site_key FROM tracked_sites WHERE enabled = 1`
    ).all().map((r: any) => r.site_key) as string[];
    if (enabledSites.length === 0) {
      return [] as VelocityRow[];
    }
    const enabledPlaceholders = enabledSites.map(() => "?").join(",");

    // Competitors (excluding stereonet, headfi, user-excluded sites; must be enabled)
    const rows = sqlite.prepare(`
      SELECT site, COUNT(*) as total
      FROM articles
      WHERE ${where}
        AND site NOT IN (${placeholders})
        AND site IN (${enabledPlaceholders})
      GROUP BY site
    `).all(...params, ...excludeList, ...enabledSites) as { site: string; total: number }[];

    // StereoNET count separately
    const snResult = sqlite.prepare(`
      SELECT COUNT(*) as total FROM articles
      WHERE ${where} AND site = 'stereonet'
    `).get(...params) as { total: number };

    const days = opts.fromDate && opts.toDate
      ? Math.max(1, Math.ceil((new Date(opts.toDate).getTime() - new Date(opts.fromDate).getTime()) / 86400000) + 1)
      : 30;

    const snAvg = Math.round((snResult.total / days) * 10) / 10;

    return rows
      .map(r => ({
        site: r.site,
        total: r.total,
        avgPerDay: Math.round((r.total / days) * 10) / 10,
        gap: Math.round((snAvg - (r.total / days)) * 10) / 10,
      }))
      .sort((a, b) => a.gap - b.gap) as VelocityRow[]; // most behind first
  },

  getFirstMover(opts: { fromDate?: string; toDate?: string } = {}): FirstMoverData {
    let where = "brands IS NOT NULL AND brands != '[]'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }

    const rows = sqlite.prepare(`
      SELECT site, brands, published_date
      FROM articles
      WHERE ${where}
      ORDER BY published_date ASC
    `).all(...params) as { site: string; brands: string; published_date: string }[];

    // Build brand -> [{site, date}] map
    const brandMap = new Map<string, { site: string; date: string }[]>();
    for (const row of rows) {
      let parsed: string[];
      try { parsed = JSON.parse(row.brands); } catch { continue; }
      for (const brand of parsed) {
        if (!brandMap.has(brand)) brandMap.set(brand, []);
        brandMap.get(brand)!.push({ site: row.site, date: row.published_date });
      }
    }

    const topics: FirstMoverTopic[] = [];
    let firstCount = 0;
    let totalTopics = 0;

    for (const [brand, entries] of brandMap.entries()) {
      const sitesSet = new Set(entries.map(e => e.site));
      // Only count multi-site topics (covered by 2+ sites)
      if (sitesSet.size < 2) continue;
      // Must include stereonet to be relevant for scoring
      if (!sitesSet.has("stereonet")) continue;

      totalTopics++;

      // Find earliest date overall
      const sortedDates = [...new Set(entries.map(e => e.date))].sort();
      const firstDate = sortedDates[0];

      // Find who was first
      const firstEntries = entries.filter(e => e.date === firstDate);
      const firstSites = new Set(firstEntries.map(e => e.site));
      const snEntry = entries.filter(e => e.site === "stereonet").sort()[0];
      const snDate = snEntry?.date ?? null;

      const jointFirst = firstSites.has("stereonet");
      const daysBehind = snDate && !jointFirst
        ? Math.ceil((new Date(snDate).getTime() - new Date(firstDate).getTime()) / 86400000)
        : 0;

      if (jointFirst) firstCount++;

      topics.push({
        brand,
        firstSite: [...firstSites][0],
        firstDate,
        stereonetDate: snDate,
        daysBehind,
        jointFirst,
        siteCount: sitesSet.size,
      });
    }

    // Deduplicate: merge topics where one brand is a substring of another
    // e.g. "AXPONA" and "AXPONA 2026" -> keep "AXPONA 2026"
    const dedupedTopics: FirstMoverTopic[] = [];
    const usedBrands = new Set<string>();
    const sortedByLength = topics.sort((a, b) => b.brand.length - a.brand.length);
    for (const t of sortedByLength) {
      const dominated = sortedByLength.some(other =>
        other.brand !== t.brand &&
        other.brand.toLowerCase().includes(t.brand.toLowerCase()) &&
        !usedBrands.has(other.brand)
      );
      if (!dominated) {
        dedupedTopics.push(t);
        usedBrands.add(t.brand);
      }
    }

    // Recalculate score after dedup
    const dedupTotal = dedupedTopics.length;
    const dedupFirst = dedupedTopics.filter(t => t.jointFirst).length;
    const score = dedupTotal > 0 ? Math.round((dedupFirst / dedupTotal) * 100) : 0;

    return {
      score,
      firstCount: dedupFirst,
      totalTopics: dedupTotal,
      topics: dedupedTopics.sort((a, b) => a.daysBehind - b.daysBehind),
    };
  },

  getContentGaps(opts: { fromDate?: string; toDate?: string } = {}) {
    let where = "site != 'headfi' AND brands IS NOT NULL AND brands != '[]' AND content_type = 'review'";
    const params: any[] = [];
    if (opts.fromDate) { where += " AND published_date >= ?"; params.push(opts.fromDate); }
    if (opts.toDate) { where += " AND published_date <= ?"; params.push(opts.toDate); }

    const rows = sqlite.prepare(`
      SELECT site, brands, title, published_date, url
      FROM articles
      WHERE ${where}
    `).all(...params) as { site: string; brands: string; title: string; published_date: string; url: string }[];

    // Build brand -> reviews map
    const brandReviews = new Map<string, { site: string; title: string; date: string; url: string }[]>();
    for (const row of rows) {
      let parsed: string[];
      try { parsed = JSON.parse(row.brands); } catch { continue; }
      for (const brand of parsed) {
        const key = brand.toLowerCase();
        if (!brandReviews.has(key)) brandReviews.set(key, []);
        brandReviews.get(key)!.push({ site: row.site, title: row.title, date: row.published_date, url: row.url });
      }
    }

    // Find gaps: brands reviewed by competitors but NOT by stereonet
    const gaps: { brand: string; competitorReviews: { site: string; title: string; date: string; url: string }[]; siteCount: number }[] = [];
    for (const [brand, reviews] of brandReviews.entries()) {
      const hasStereonet = reviews.some(r => r.site === 'stereonet');
      if (hasStereonet) continue;
      const competitorReviews = reviews.filter(r => r.site !== 'stereonet');
      const uniqueSites = new Set(competitorReviews.map(r => r.site));
      if (uniqueSites.size < 2) continue; // at least 2 competitors reviewed it
      gaps.push({
        brand: brand.charAt(0).toUpperCase() + brand.slice(1), // capitalize
        competitorReviews: competitorReviews.sort((a, b) => a.date.localeCompare(b.date)),
        siteCount: uniqueSites.size,
      });
    }

    // Deduplicate substrings
    const sorted = gaps.sort((a, b) => b.brand.length - a.brand.length);
    const kept: typeof gaps = [];
    const usedBrands = new Set<string>();
    for (const g of sorted) {
      const dominated = sorted.some(other =>
        other.brand !== g.brand &&
        other.brand.toLowerCase().includes(g.brand.toLowerCase()) &&
        !usedBrands.has(other.brand)
      );
      if (!dominated) {
        kept.push(g);
        usedBrands.add(g.brand);
      }
    }

    return kept.sort((a, b) => b.siteCount - a.siteCount).slice(0, 30);
  },

  getDiscoveryArticles(opts: { search?: string; limit?: number } = {}) {
    const limit = opts.limit ?? 200;
    const search = opts.search?.toLowerCase();

    // Audio/hi-fi focused sites — all content is relevant, no keyword filter needed.
    // Expanded 2026-07-03 after the Sonus Faber Olympica G3 miss: gearpatrol, sempre,
    // channelnews, hifiplus, audiophilia, audioholics, dagogo, parttimeaudiophile,
    // enjoythemusic, audioresurgence, audiobacon are all audio-first publishers.
    const AUDIO_SITES = new Set([
      "whathifi", "hifipig", "darko", "ecoustics", "absolutesound", "hifinews",
      "audiophileman", "twitteringmachines", "audiohead", "soundstage",
      "hometheaterhifi", "stereophile", "audioxpress",
      // dailyaudio REMOVED 2026-08-01 — they started syndicating forum threads
      // from AVS/Head-Fi/etc at 30-50/hour, drowning out real news in Discovery.
      // Kept in tracked_sites but disabled by default. If re-enabled, must go
      // through ingest filter and keyword match, not the audio-first bypass.
      // "dailyaudio",
      // Expanded audio-first publishers (previously required keyword match — causing misses)
      "gearpatrol",       // covers hi-fi as primary category (/audio/... paths)
      "sempre",           // German-language audio-only publisher
      "channelnews",      // AU industry trade publisher
      "hifiplus",         // UK audiophile magazine
      "audiophilia",      // US audiophile publisher
      "audioholics",      // US audio/AV publisher
      "dagogo",           // US audiophile publisher
      "parttimeaudiophile", // US audio blog
      "enjoythemusic",    // US audiophile magazine
      "audioresurgence",  // audio publisher
      "audiobacon",       // audio blog
      "soundstagehifi",   // SoundStage variant
      "monoandstereo",    // audio blog
      // Primary-source watchers — always relevant, always gold-standard
      "fcc_filings",       // FCC product certifications (scoops 30-90 days early)
      "youtube_reviewers", // gold-standard reviewer video uploads
      "brand_press",       // direct manufacturer press portal scrapes
      "email_pressroom", // forwarded press releases are always relevant
      "editor-brief",    // editorial briefs submitted via webhook are always relevant
    ]);

    // Gold-standard sources — 100% surfaced regardless of content_type classification.
    // If it made it past ingest, it goes to Discovery. No silent drops.
    const GOLD_STANDARD_SITES = new Set([
      "ecoustics",        // industry benchmark — if it's on eCoustics, it's real (per marc, 2026-07-03)
      "stereophile",
      "absolutesound",
      "whathifi",
      "hifinews",
      "hifiplus",
      // Primary sources — always gold-standard because they precede all publisher coverage
      "fcc_filings",
      "youtube_reviewers",
      "brand_press",
      "email_pressroom",
      "editor-brief",
    ]);

    // Always-visible sites — bypass the tracked_sites enabled-whitelist and the
    // relevance keyword filter entirely. Editor briefs and webhook-posted items
    // should never be silently dropped just because their site key isn't in the
    // scraped-sources table.
    const ALWAYS_VISIBLE_SITES = new Set([
      "editor-brief", "webhook", "task-agent", "task-agent-debug",
      "probe-alpha", "probe-beta", "email_pressroom",
    ]);

    // Keywords that indicate audio/AV relevance for general tech sites
    const RELEVANCE_KEYWORDS = [
      // Product categories
      "headphone", "earphone", "earbud", "iem", "in-ear", "over-ear", "on-ear",
      "speaker", "soundbar", "subwoofer", "loudspeaker", "bookshelf speaker",
      "amplifier", "amp", "receiver", "av receiver", "preamp", "preamplifier", "integrated amp",
      "turntable", "vinyl", "record player", "phono", "cartridge", "tonearm",
      "dac", "streamer", "music streamer", "network player",
      "home theater", "home theatre", "home cinema", "surround sound", "atmos",
      "car audio", "car stereo", "car speaker", "car amplifier", "head unit",
      "hi-fi", "hifi", "hi-res", "high-fidelity", "audiophile",
      "audio", "sound", "acoustic", "music",
      // Technologies
      "bluetooth speaker", "wireless speaker", "portable speaker",
      "noise cancelling", "noise-cancelling", "anc", "active noise",
      "spatial audio", "dolby atmos", "dts",
      "lossless", "flac", "hi-res audio", "mqa",
      "multiroom", "multi-room", "whole-home audio",
      // Brands (audio-specific)
      "sonos", "bose", "sennheiser", "sony wh-", "sony wf-", "sony ult",
      "bang & olufsen", "b&o", "bowers & wilkins", "b&w",
      "kef", "klipsch", "jbl", "harman kardon", "marshall",
      "denon", "marantz", "yamaha", "onkyo", "pioneer",
      "mcintosh", "mark levinson", "naim", "linn", "rega",
      "focal", "devialet", "bluesound", "cambridge audio",
      "ps audio", "audioquest", "chord", "topping", "fiio",
      "hifiman", "audeze", "meze", "campfire audio", "shure",
      "technics", "audio-technica", "beyerdynamic", "akg",
      "wharfedale", "dali", "elac", "svs", "rel", "monitor audio",
      "rotel", "arcam", "musical fidelity", "creek", "cyrus",
      "roon", "tidal", "qobuz", "apple music lossless",
      // Services/platforms
      "spotify", "apple music", "amazon music",
      "podcast", "podcasting",
    ];

    // Only show articles from currently enabled sites
    const enabledSiteKeys = new Set(
      this.getEnabledSites()
        .filter(s => s.site_key !== "stereonet")
        .map(s => s.site_key)
    );

    // SQL prefetch: fail-open on trusted publishers.
    // Previous behaviour rejected content_type='unknown' outright, which silently
    // dropped a large share of articles from eCoustics/gearpatrol/etc when the
    // classifier couldn't confidently label them. Now: allow 'unknown' from
    // AUDIO_SITES + ALWAYS_VISIBLE + GOLD_STANDARD publishers, and continue to
    // exclude only content_type='review' (or other explicitly excluded types)
    // from all sites.
    const trustedSitesList = [...AUDIO_SITES, ...ALWAYS_VISIBLE_SITES, ...GOLD_STANDARD_SITES];
    const trustedPlaceholders = trustedSitesList.map(() => "?").join(",");
    let rows = sqlite.prepare(`
      SELECT * FROM articles
      WHERE site != 'stereonet'
        AND site != 'headfi'
        AND (
          content_type IS NULL
          OR content_type = 'news'
          OR content_type = 'press_release'
          OR content_type = 'editor_brief'
          OR content_type = 'feature'
          OR content_type = 'opinion'
          OR (content_type = 'unknown' AND site IN (${trustedPlaceholders}))
        )
      ORDER BY published_at DESC
      LIMIT ?
    `).all(...trustedSitesList, limit * 5) as Article[];

    // Filter to only enabled sites — but always-visible + gold-standard sites bypass the whitelist
    rows = rows.filter(a => ALWAYS_VISIBLE_SITES.has(a.site) || GOLD_STANDARD_SITES.has(a.site) || enabledSiteKeys.has(a.site));

    // Relevance filter (bypassed by audio-first + always-visible + gold-standard sites).
    // For general tech sites, match keywords against the title AND the description/
    // categories text so clickbait headlines like 'A Legendary Hi-Fi Brand...' still
    // match on 'sonus faber' in the body.
    rows = rows.filter(a => {
      if (ALWAYS_VISIBLE_SITES.has(a.site)) return true;
      if (GOLD_STANDARD_SITES.has(a.site)) return true;
      if (AUDIO_SITES.has(a.site)) return true;
      const haystack = [
        a.title || "",
        (a as any).description || "",
        (a as any).categories || "",
        (a as any).brands || "",
      ].join(" ").toLowerCase();
      return RELEVANCE_KEYWORDS.some(kw => haystack.includes(kw));
    });

    // Apply blocked keywords filter (learned + manual). Editor briefs and press
    // emails bypass this — they're curated/forwarded by humans and shouldn't be
    // silently dropped. Uses whole-word regex (not substring includes), so
    // "release" no longer matches inside "Press Release" or "released".
    const blocked = this.getBlockedKeywords().map(b => b.keyword);
    if (blocked.length > 0) {
      const blockedRegexes = blocked.map(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
      rows = rows.filter(a => {
        if (ALWAYS_VISIBLE_SITES.has(a.site)) return true;
        const title = a.title || "";
        return !blockedRegexes.some(rx => rx.test(title));
      });
    }

    // Positive brand cache — loaded once per call so the scoring loop can boost
    // articles mentioning brands StereoNET has published on recently.
    let positiveBrandSet: Set<string> = new Set();
    try {
      const pbRows = sqlite.prepare(`SELECT brand FROM discovery_positive_brands`).all() as any[];
      positiveBrandSet = new Set(pbRows.map(r => String(r.brand).toLowerCase()));
    } catch {}

    // Learned (site, category) suppressions. When the team has repeatedly
    // dismissed articles under a specific category on a specific site (e.g.
    // toms-guide/wireless-earbuds-deals), auto-drop those from Discovery.
    // Gold-standard sources bypass this to preserve high-quality signal.
    try {
      const learnedCats = sqlite.prepare(`SELECT site, category FROM discovery_learned_categories WHERE is_active = 1`).all() as any[];
      if (learnedCats.length > 0) {
        const suppress = new Set(learnedCats.map(r => `${r.site}::${String(r.category).toLowerCase()}`));
        rows = rows.filter(a => {
          if (GOLD_STANDARD_SITES.has(a.site)) return true;
          if (ALWAYS_VISIBLE_SITES.has(a.site)) return true;
          let cats: string[] = [];
          try { cats = JSON.parse((a as any).categories || "[]"); } catch {}
          if (!Array.isArray(cats)) return true;
          for (const c of cats) {
            const key = `${a.site}::${String(c).toLowerCase()}`;
            if (suppress.has(key)) return false;
          }
          return true;
        });
      }
    } catch {}

    if (search) {
      rows = rows.filter(a => a.title.toLowerCase().includes(search));
    }
    rows = rows.slice(0, limit);

    // Build brand -> site set map from all articles in last 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const allBrandRows = sqlite.prepare(`
      SELECT site, title, brands FROM articles
      WHERE brands IS NOT NULL AND brands != '[]' AND published_date >= ?
    `).all(cutoff) as { site: string; title: string; brands: string }[];

    // brand (lowercase) -> Set of sites that covered it
    const brandSites = new Map<string, Set<string>>();
    for (const r of allBrandRows) {
      try {
        const b: string[] = JSON.parse(r.brands);
        for (const brand of b) {
          const key = brand.toLowerCase();
          if (!brandSites.has(key)) brandSites.set(key, new Set());
          brandSites.get(key)!.add(r.site);
        }
      } catch {}
    }

    // Build StereoNET's covered product signatures: brand + normalised model code.
    // Only articles published by StereoNET itself (site='stereonet') qualify as
    // "we've covered this" for the per-row `covered` flag. This prevents every
    // Sennheiser piece from being marked covered just because StereoNET wrote
    // about a different Sennheiser product recently.
    const MODEL_RX = /\b([A-Z]{1,5}[- ]?\d{2,5}[A-Z0-9]*|\d{3,4}[A-Z]{1,4}|\d{1,2}[A-Z]\d+[A-Z]*)\b/;
    function normaliseModel(m: string): string {
      return m.toUpperCase().replace(/[- ]/g, "");
    }
    // Set of "brand:model" signatures StereoNET has covered
    const snCovered = new Set<string>();
    // Set of model-only signatures — used as fallback when brand extraction is
    // imperfect on either side. Model codes (HD 480, WH-1000XM6, CXA81) are
    // distinctive enough that a bare model match is a strong coverage signal.
    const snCoveredModels = new Set<string>();
    // Per-StereoNET-row token bag for coverage by token-overlap. A candidate is
    // "covered" if it shares >=3 distinctive content tokens with any SN row.
    // This is more flexible than fixed-position fingerprints because it tolerates
    // different word order and surrounding noise (e.g. one site says "Pro-Ject's
    // new Wireless Box E kills the speaker cable" while another says "Pro-Ject
    // Wireless Box E" — they share {pro, ject, wireless, box}).
    const FP_STOPWORDS = new Set([
      "the","a","an","and","or","but","of","in","on","at","to","for","with","by",
      "from","is","are","was","were","new","now","this","that","its",
      "two","three","four","five","all","more","both","most","first",
      "review","reviews","news","feature","opinion","announces","announced",
      "unveils","unveiled","launches","launched","debuts","reveals","introduces",
      "audio","sound","music","hi","fi","hifi","home","theatre","theater",
      "speaker","speakers","headphone","headphones","system","systems",
      "product","products","launch","new","makes","kills","any","future",
      "now","then","out","into","about","after","before","only","just","some",
      "says","said","can","will","may","company","brand","company",
    ]);
    function tokenBag(title: string): Set<string> {
      let t = title.replace(/\s+[\-|\u2014]\s+[^\-|\u2014]+$/, "");
      t = t.replace(/[\u2019']s\b/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
      const tokens = t.split(/\s+/).filter(w => w.length >= 3 && !FP_STOPWORDS.has(w));
      return new Set(tokens);
    }
    // SN coverage as an array of token-bags (not a Set, since we need to test
    // overlap against each one).
    const snTokenBags: Set<string>[] = [];
    // Also extract additional model tokens from anywhere in the title (not just
    // the first match), so titles like "HD 480 PRO" contribute both "HD480" and
    // "HD480PRO" if relevant.
    const ALL_MODELS_RX = /\b([A-Z]{1,5}[- ]?\d{2,5}[A-Z0-9]*|\d{3,4}[A-Z]{1,4}|\d{1,2}[A-Z]\d+[A-Z]*)\b/g;
    for (const r of allBrandRows) {
      if (r.site !== "stereonet") continue;
      let brandList: string[] = [];
      try { brandList = JSON.parse(r.brands); } catch {}
      const title = r.title || "";
      // Always add a token-bag regardless of model presence
      const bag = tokenBag(title);
      if (bag.size >= 3) snTokenBags.push(bag);
      const allMatches = [...title.matchAll(ALL_MODELS_RX)];
      if (!allMatches.length) continue;
      for (const mm of allMatches) {
        const model = normaliseModel(mm[1]);
        snCoveredModels.add(model);
        for (const brand of brandList) {
          snCovered.add(`${brand.toLowerCase()}:${model}`);
        }
      }
    }

    const now = Date.now();
    const DAY = 86400000;

    // Title-keyword filters (whole-word, case-insensitive). Build once per call.
    const filterKeywords = sqlite.prepare(`SELECT keyword FROM filter_keywords`).all() as { keyword: string }[];
    // B-Sides: load active marks once (28-day window) so we can attach bsidedAt
    // to every row in one pass without N+1 lookups.
    const bsideRows = sqlite.prepare(
      `SELECT article_id, marked_at FROM article_bsides WHERE marked_at >= datetime('now', '-28 days')`
    ).all() as { article_id: number; marked_at: string }[];
    const bsideMap = new Map(bsideRows.map(r => [r.article_id, r.marked_at]));

    // Site language map (for translation badges). 'en' is default and isn't
    // stored as a per-row translation, so we attach it only for non-en sites.
    const siteLangRows = sqlite.prepare(
      `SELECT site_key, language FROM tracked_sites WHERE language IS NOT NULL AND language != 'en'`
    ).all() as { site_key: string; language: string }[];
    const siteLangMap = new Map(siteLangRows.map(r => [r.site_key, r.language]));

    // Pre-load cached translations for every foreign title in this batch. One
    // bulk read keeps it O(1) per row instead of N lookups. Triggers a debounced
    // background fill if any foreign titles are uncached.
    const foreignTitlesNeedingTranslation: string[] = [];
    const titleHashes = new Map<string, string>();
    for (const r of rows) {
      const lang = siteLangMap.get(r.site);
      if (lang && r.title) {
        const hash = crypto.createHash("sha256").update(r.title).digest("hex");
        titleHashes.set(r.title, hash);
        foreignTitlesNeedingTranslation.push(hash);
      }
    }
    let translationMap = new Map<string, string>();
    if (foreignTitlesNeedingTranslation.length) {
      const placeholders = foreignTitlesNeedingTranslation.map(() => "?").join(",");
      const tRows = sqlite.prepare(
        `SELECT source_hash, translated_text FROM article_translations
         WHERE target_lang = 'en' AND source_hash IN (${placeholders})`
      ).all(...foreignTitlesNeedingTranslation) as { source_hash: string; translated_text: string }[];
      translationMap = new Map(tRows.map(r => [r.source_hash, r.translated_text]));
      // Kick off background backlog fill for any uncached titles (no await).
      try {
        const { scheduleBacklogFill } = require("./translate");
        scheduleBacklogFill();
      } catch {}
    }
    const filterRegexes: { keyword: string; rx: RegExp }[] = filterKeywords.map(({ keyword }) => ({
      keyword,
      rx: new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    }));
    function matchedKeyword(title: string): string | null {
      for (const { keyword, rx } of filterRegexes) if (rx.test(title)) return keyword;
      return null;
    }

    // Editor briefs are editorial intent — never auto-filter or mark covered.
    // email_pressroom is always-visible for routing but DOES still respect
    // user-set keyword filters (otherwise spam emails like "Business Manager
    // partner request" can't be filtered out).
    const NEVER_FILTERED_SITES = new Set([
      "editor-brief", "webhook", "task-agent", "task-agent-debug",
      "probe-alpha", "probe-beta",
    ]);
    function attachTranslation(a: Article) {
      const lang = siteLangMap.get(a.site);
      if (!lang || !a.title) return { titleEn: null as string | null, sourceLang: null as string | null };
      const hash = titleHashes.get(a.title);
      const titleEn = hash ? (translationMap.get(hash) || null) : null;
      return { titleEn, sourceLang: lang };
    }
    return rows.map(a => {
      const tr = attachTranslation(a);
      if (NEVER_FILTERED_SITES.has(a.site)) {
        return { ...a, covered: false, score: 10, siteCount: 1, filteredByKeyword: null, bsidedAt: bsideMap.get(a.id) || null, ...tr };
      }
      // For email_pressroom and other always-visible-but-filterable sites, run
      // the keyword filter (so spam can be hidden) but skip the coverage check.
      const filteredByKeyword = matchedKeyword(a.title || "");
      if (ALWAYS_VISIBLE_SITES.has(a.site)) {
        return { ...a, covered: false, score: 10, siteCount: 1, filteredByKeyword, bsidedAt: bsideMap.get(a.id) || null, ...tr };
      }
      // Coverage check: requires matching brand AND model with a StereoNET article.
      let covered = false;
      let maxSiteCount = 1;
      let brandList: string[] = [];
      if (a.brands) {
        try { brandList = JSON.parse(a.brands); } catch {}
        for (const brand of brandList) {
          const key = brand.toLowerCase();
          const sc = brandSites.get(key)?.size ?? 1;
          if (sc > maxSiteCount) maxSiteCount = sc;
        }
      }
      // Pull every model-like token from the title (not just the first one)
      const allModelMatches = [...(a.title || "").matchAll(ALL_MODELS_RX)];
      const candidateModels = allModelMatches.map(mm => normaliseModel(mm[1]));
      // Primary: brand+model match against StereoNET
      if (candidateModels.length && brandList.length) {
        outer: for (const model of candidateModels) {
          for (const brand of brandList) {
            if (snCovered.has(`${brand.toLowerCase()}:${model}`)) { covered = true; break outer; }
          }
        }
      }
      // Fallback 1: model-only match for distinctive model codes. Distinctive =
      // ≥5 chars and contains both a letter and a digit, OR ≥6 chars. This avoids
      // false positives on generic codes like "S5", "M3", "X1" which collide
      // across many brands.
      if (!covered && candidateModels.length) {
        for (const model of candidateModels) {
          const distinctive = (model.length >= 5 && /[A-Z]/.test(model) && /\d/.test(model)) || model.length >= 6;
          if (distinctive && snCoveredModels.has(model)) { covered = true; break; }
        }
      }
      // Fallback 2: token-bag overlap match. For products without a digit-bearing
      // model code (e.g. Pro-Ject Box E, Naim Atom, Bluesound Powernode), check
      // whether the candidate's content-token bag overlaps with any SN row's bag
      // by ≥3 tokens. Tolerant of word order and surrounding filler.
      if (!covered) {
        const candBag = tokenBag(a.title || "");
        if (candBag.size >= 3) {
          for (const snBag of snTokenBags) {
            let overlap = 0;
            for (const t of candBag) if (snBag.has(t)) { overlap++; if (overlap >= 3) break; }
            if (overlap >= 3) { covered = true; break; }
          }
        }
      }

      // Popularity score 1-10
      // Site coverage: 1 site = 0pts, 2 = 1pt, 3 = 2pts ... 8+ = 7pts (max)
      const sitePts = Math.min(7, Math.max(0, maxSiteCount - 1));
      // Recency: <24h = 3, <3d = 2, <7d = 1, older = 0
      const ageMs = now - new Date(a.published_at).getTime();
      const recencyPts = ageMs < DAY ? 3 : ageMs < 3 * DAY ? 2 : ageMs < 7 * DAY ? 1 : 0;

      // Positive brand boost — if the article mentions a brand StereoNET has
      // published on in the last 90 days, add 2 points. If it mentions 2+, add 3.
      // Capped so we never exceed 10.
      let brandBoost = 0;
      let positiveMatches: string[] = [];
      if (positiveBrandSet.size > 0) {
        const haystack = ((a.title || "") + " " + (brandList.join(" ") || "")).toLowerCase();
        for (const pb of positiveBrandSet) {
          if (haystack.includes(pb)) positiveMatches.push(pb);
          if (positiveMatches.length >= 3) break;
        }
        if (positiveMatches.length === 1) brandBoost = 2;
        else if (positiveMatches.length >= 2) brandBoost = 3;
      }

      // Primary-source articles get a +3 boost so they always land at the top
      // of Discovery. FCC filings, YouTube gold-standard reviewer channels,
      // and direct brand press portal scrapes are ahead-of-the-curve signals
      // and deserve visibility before publisher coverage appears.
      const primarySourceBoost = ["fcc_filings", "youtube_reviewers", "brand_press"].includes(a.site) ? 3 : 0;

      const score = Math.min(10, Math.max(1, sitePts + recencyPts + brandBoost + primarySourceBoost));

      const tr2 = attachTranslation(a);
      return { ...a, covered, score, siteCount: maxSiteCount, filteredByKeyword, bsidedAt: bsideMap.get(a.id) || null, positive_matches: positiveMatches, brand_boost: brandBoost, primary_source_boost: primarySourceBoost, is_primary_source: primarySourceBoost > 0, ...tr2 };
    });
  },

  insertForumStats(stats: { active_ads: number; total_ads: number; successful_sales: number; clearance_rate: string; total_sales_14d: string; total_ads_value: string; total_topics: string; total_posts: string; total_members?: string; total_topics_precise?: number | null; total_posts_precise?: number | null; total_members_precise?: number | null }) {
    sqlite.prepare(`
      INSERT INTO forum_stats (active_ads, total_ads, successful_sales, clearance_rate, total_sales_14d, total_ads_value, total_topics, total_posts, total_members, total_topics_precise, total_posts_precise, total_members_precise)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stats.active_ads, stats.total_ads, stats.successful_sales, stats.clearance_rate,
      stats.total_sales_14d, stats.total_ads_value, stats.total_topics, stats.total_posts,
      stats.total_members ?? null,
      stats.total_topics_precise ?? null, stats.total_posts_precise ?? null, stats.total_members_precise ?? null,
    );
  },

  getForumStats() {
    const current = sqlite.prepare(`SELECT * FROM forum_stats ORDER BY id DESC LIMIT 1`).get() as any;
    const previous = sqlite.prepare(`SELECT * FROM forum_stats ORDER BY id DESC LIMIT 1 OFFSET 1`).get() as any;
    if (!current) return null;
    return { current, previous: previous || null };
  },

  clearForumStats() {
    sqlite.prepare(`DELETE FROM forum_stats`).run();
  },

  upsertHitCounts(hits: { url: string; hits: number; image?: string }[]) {
    const stmt = sqlite.prepare(`INSERT INTO article_hits (url, hits, image, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(url) DO UPDATE SET hits = ?, image = COALESCE(?, image), updated_at = datetime('now')`);
    const histStmt = sqlite.prepare(`INSERT INTO article_hits_history (url, hits) VALUES (?, ?)`);
    const tx = sqlite.transaction(() => {
      for (const h of hits) {
        stmt.run(h.url, h.hits, h.image || null, h.hits, h.image || null);
        histStmt.run(h.url, h.hits);
      }
    });
    tx();
    // Prune old history (keep last 7 days)
    try { sqlite.prepare(`DELETE FROM article_hits_history WHERE recorded_at < datetime('now', '-7 days')`).run(); } catch {}
  },

  getHitCounts() {
    const rows = sqlite.prepare(`SELECT url, hits, image FROM article_hits`).all() as { url: string; hits: number; image: string | null }[];
    return new Map(rows.map(r => [r.url, { hits: r.hits, image: r.image }]));
  },

  // Top StereoNET article by view-count growth in the last N hours. Uses the
  // article_hits_history snapshots to compute delta = current_hits - earliest
  // snapshot within the window. Falls back to absolute hits if no historical
  // snapshot exists yet for the article. Restricts to articles published in
  // the last 30 days to keep the result editorially relevant (we don't want
  // an evergreen older piece dominating just because it gets steady traffic).
  getMostViewedRecent(opts: { hours?: number } = {}) {
    const hours = opts.hours || 48;
    // Get every StereoNET article published in the last 30 days with a current
    // hit count, plus their earliest snapshot inside the window for delta calc.
    const rows = sqlite.prepare(`
      SELECT
        a.id, a.site, a.url, a.title, a.published_at, a.published_date,
        a.author, a.brands, a.content_type,
        h.hits AS current_hits, h.image,
        (
          SELECT hits FROM article_hits_history
          WHERE url = a.url AND recorded_at >= datetime('now', '-' || ? || ' hours')
          ORDER BY recorded_at ASC LIMIT 1
        ) AS earliest_hits
      FROM articles a
      INNER JOIN article_hits h ON h.url = a.url
      WHERE a.site = 'stereonet'
        AND a.published_at >= datetime('now', '-30 days')
      ORDER BY h.hits DESC
      LIMIT 100
    `).all(hours) as Array<{
      id: number; site: string; url: string; title: string;
      published_at: string; published_date: string;
      author: string | null; brands: string | null; content_type: string | null;
      current_hits: number; image: string | null; earliest_hits: number | null;
    }>;

    if (rows.length === 0) return null;

    // Score each row by delta-in-window. Prefer articles WITH historical
    // snapshots so the score reflects real growth. For articles without a
    // snapshot yet (newly tracked), fall back to absolute hits / 2 so they're
    // still rankable but don't drown out tracked-with-real-growth articles.
    let best: typeof rows[number] | null = null;
    let bestDelta = -1;
    for (const r of rows) {
      const delta = r.earliest_hits != null
        ? Math.max(0, r.current_hits - r.earliest_hits)
        : Math.floor(r.current_hits / 2);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = r;
      }
    }
    if (!best) return null;
    const article = sqlite.prepare(`SELECT * FROM articles WHERE id = ?`).get(best.id) as Article;
    return {
      article,
      hits: best.current_hits,
      deltaHits: bestDelta,
      image: best.image,
    };
  },

  fixArticleAuthor(url: string, slug: string, author: string) {
    // EE is authoritative — always overwrite author for matching stereonet articles
    sqlite.prepare(`UPDATE articles SET author = ? WHERE site = 'stereonet' AND url = ?`)
      .run(author, url);
    sqlite.prepare(`UPDATE articles SET author = ? WHERE site = 'stereonet' AND url LIKE ?`)
      .run(author, `%/${slug}`);
    sqlite.prepare(`UPDATE articles SET author = ? WHERE site = 'stereonet' AND url LIKE ?`)
      .run(author, `%${slug}`);
  },

  insertArticleNoDedup(a: InsertArticle): boolean {
    try {
      // Check if article already exists by title + site (handles EE vs RSS URL mismatch)
      const existing = sqlite.prepare(`SELECT id FROM articles WHERE site = ? AND title = ? LIMIT 1`).get(a.site, a.title) as { id: number } | undefined;
      if (existing) {
        // Update author and date on existing article from EE data
        const updates: string[] = [];
        const params: any[] = [];
        if (a.author) { updates.push("author = ?"); params.push(a.author); }
        if (a.publishedDate) { updates.push("published_date = ?"); params.push(a.publishedDate); }
        if (a.publishedAt) { updates.push("published_at = ?"); params.push(a.publishedAt); }
        if (updates.length > 0) {
          params.push(existing.id);
          sqlite.prepare(`UPDATE articles SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        }
        return false;
      }
      db.insert(articles).values(a).run();
      return true;
    } catch {
      // Duplicate URL — always update author if we have one (EE is authoritative)
      try {
        if (a.author) {
          sqlite.prepare(`UPDATE articles SET author = ? WHERE url = ? AND site = 'stereonet'`).run(a.author, a.url);
        }
      } catch {}
      return false;
    }
  },

  getArticlesByAuthor(author: string) {
    // Deduplicate by title. Prefer URLs with /news/, /opinion/, /feature/ (working paths) over bare EE slugs
    return sqlite.prepare(`
      SELECT a.title, a.url, a.published_date, a.content_type as type, a.brands
      FROM articles a
      INNER JOIN (
        SELECT title, MAX(
          CASE WHEN url LIKE '%/news/%' OR url LIKE '%/opinion/%' OR url LIKE '%/feature/%'
          THEN 1 ELSE 0 END
        ) as has_prefix,
        MAX(published_date) as best_date
        FROM articles
        WHERE site = 'stereonet' AND author = ?
        GROUP BY title
      ) b ON a.title = b.title
      WHERE a.site = 'stereonet' AND a.author = ?
        AND (CASE WHEN url LIKE '%/news/%' OR url LIKE '%/opinion/%' OR url LIKE '%/feature/%' THEN 1 ELSE 0 END) = b.has_prefix
      GROUP BY a.title
      ORDER BY a.published_date DESC, a.id DESC
    `).all(author, author) as { title: string; url: string; published_date: string; type: string | null; brands: string | null }[];
  },

  getAuthorStats(author: string) {
    if (!author) return null;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // Start of current week (Monday)
    const dow = now.getDay();
    const mondayOffset = dow === 0 ? 6 : dow - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset);
    const weekStart = monday.toISOString().slice(0, 10);
    // Start of month
    const monthStart = todayStr.slice(0, 8) + "01";

    const thisWeek = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM articles WHERE site='stereonet' AND author=? AND published_date >= ?`).get(author, weekStart) as any).cnt;
    const thisMonth = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM articles WHERE site='stereonet' AND author=? AND published_date >= ?`).get(author, monthStart) as any).cnt;
    const allTime = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM articles WHERE site='stereonet' AND author=?`).get(author) as any).cnt;

    // Rank among all authors (last 30 days)
    const thirtyAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const allAuthors = sqlite.prepare(`
      SELECT author, COUNT(*) as cnt FROM articles
      WHERE site='stereonet' AND author IS NOT NULL AND author != '' AND published_date >= ?
      GROUP BY author ORDER BY cnt DESC
    `).all(thirtyAgo) as { author: string; cnt: number }[];
    const rank = allAuthors.findIndex(a => a.author === author) + 1;

    // Streak: consecutive days with at least 1 article, walking backwards from today
    const dates = sqlite.prepare(`
      SELECT DISTINCT published_date FROM articles
      WHERE site='stereonet' AND author=?
      ORDER BY published_date DESC
    `).all(author) as { published_date: string }[];
    let streak = 0;
    let checkDate = new Date(now);
    const dateSet = new Set(dates.map(d => d.published_date));
    // Allow today to not have an article yet (check from yesterday if today has none)
    if (!dateSet.has(todayStr)) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    while (dateSet.has(checkDate.toISOString().slice(0, 10))) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Personal first mover %
    // Count this author's articles that were brand-first
    const authorArticles = sqlite.prepare(`
      SELECT brands, published_date FROM articles
      WHERE site='stereonet' AND author=? AND brands IS NOT NULL AND brands != '[]' AND published_date >= ?
    `).all(author, thirtyAgo) as { brands: string; published_date: string }[];
    let firstCount = 0;
    let totalBranded = 0;
    for (const art of authorArticles) {
      let parsed: string[];
      try { parsed = JSON.parse(art.brands); } catch { continue; }
      totalBranded++;
      for (const brand of parsed) {
        const earliest = sqlite.prepare(`
          SELECT MIN(published_date) as d FROM articles
          WHERE brands LIKE ? AND site != 'headfi'
        `).get(`%${brand}%`) as { d: string } | undefined;
        if (earliest && earliest.d === art.published_date) {
          firstCount++;
          break;
        }
      }
    }
    const firstMoverPct = totalBranded > 0 ? Math.round((firstCount / totalBranded) * 100) : 0;

    // Latest article
    const latestArticle = sqlite.prepare(`
      SELECT title, url, published_date FROM articles
      WHERE site='stereonet' AND author=?
      ORDER BY published_date DESC, id DESC LIMIT 1
    `).get(author) as { title: string; url: string; published_date: string } | undefined;

    return { thisWeek, thisMonth, allTime, rank: rank || allAuthors.length + 1, totalAuthors: allAuthors.length, streak, firstMoverPct, latestArticle: latestArticle || null };
  },

  getAuthorStreaks() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // Get all stereonet authors
    const authors = sqlite.prepare(`
      SELECT DISTINCT author FROM articles
      WHERE site='stereonet' AND author IS NOT NULL AND author != ''
    `).all() as { author: string }[];

    return authors.map(({ author }) => {
      const dates = sqlite.prepare(`
        SELECT DISTINCT published_date FROM articles
        WHERE site='stereonet' AND author=?
        ORDER BY published_date DESC
      `).all(author) as { published_date: string }[];
      const dateSet = new Set(dates.map(d => d.published_date));
      let streak = 0;
      let checkDate = new Date(now);
      if (!dateSet.has(todayStr)) {
        checkDate.setDate(checkDate.getDate() - 1);
      }
      while (dateSet.has(checkDate.toISOString().slice(0, 10))) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      }
      return { author, streak };
    }).sort((a, b) => b.streak - a.streak);
  },

  getUsers() {
    return sqlite.prepare(`SELECT id, username, role, created_at, last_login, redline_access, COALESCE(pitch_access, 'none') AS pitch_access, COALESCE(email, '') AS email, COALESCE(full_name, '') AS full_name, COALESCE(notify_regions, '') AS notify_regions FROM users ORDER BY role DESC, username ASC`).all() as any;
  },

  getUser(username: string) {
    return sqlite.prepare(`SELECT id, username, password, role, redline_access, COALESCE(pitch_access, 'none') AS pitch_access FROM users WHERE username = ?`).get(username) as { id: number; username: string; password: string; role: string; redline_access: number; pitch_access: string } | undefined;
  },

  // For outbound prospect emails: who's the human sender? Used to set the
  // From-name, Reply-To, and CC on prospect-facing sends.
  getUserSenderInfo(username: string): { email: string | null; name: string | null } {
    if (!username) return { email: null, name: null };
    const row = sqlite.prepare(`SELECT email, full_name FROM users WHERE username = ?`).get(username) as any;
    return { email: row?.email || null, name: row?.full_name || null };
  },

  setUserFullName(id: number, fullName: string | null) {
    const v = fullName == null ? null : String(fullName).trim() || null;
    sqlite.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(v, id);
  },

  setPitchAccess(id: number, level: "none" | "view" | "edit" | "admin") {
    const allowed = ["none", "view", "edit", "admin"];
    const v = allowed.includes(level) ? level : "none";
    sqlite.prepare(`UPDATE users SET pitch_access = ? WHERE id = ?`).run(v, id);
  },
  setUserEmail(id: number, email: string | null) {
    sqlite.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email && email.trim() ? email.trim() : null, id);
  },
  setNotifyRegions(id: number, csv: string) {
    // csv: 'all' or comma-separated 'anz,uk_eu,na,asia,global' or '' to opt out
    const v = String(csv || "").trim().toLowerCase();
    sqlite.prepare(`UPDATE users SET notify_regions = ? WHERE id = ?`).run(v, id);
  },

  upsertUser(username: string, password: string, role: string) {
    const isHashed = password.startsWith('$2a$') || password.startsWith('$2b$');
    const existing = sqlite.prepare(`SELECT id, password FROM users WHERE username = ?`).get(username) as { id: number; password: string } | undefined;
    if (existing) {
      // On startup re-seed: don't overwrite a hashed password with the plain text from AUTH_USERS
      const existingIsHashed = existing.password.startsWith('$2a$') || existing.password.startsWith('$2b$');
      if (existingIsHashed && !isHashed) {
        // Only update role, keep the hashed password
        sqlite.prepare(`UPDATE users SET role = ? WHERE username = ?`).run(role, username);
      } else {
        const hash = isHashed ? password : bcrypt.hashSync(password, 10);
        sqlite.prepare(`UPDATE users SET password = ?, role = ? WHERE username = ?`).run(hash, role, username);
      }
    } else {
      const hash = isHashed ? password : bcrypt.hashSync(password, 10);
      sqlite.prepare(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`).run(username, hash, role);
    }
  },

  updateLastLogin(username: string) {
    sqlite.prepare(`UPDATE users SET last_login = datetime('now') WHERE username = ?`).run(username);
  },

  updatePassword(id: number, password: string) {
    const hash = bcrypt.hashSync(password, 10);
    sqlite.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hash, id);
  },

  deleteUser(id: number) {
    sqlite.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  },

  setRedlineAccess(id: number, access: boolean) {
    sqlite.prepare(`UPDATE users SET redline_access = ? WHERE id = ?`).run(access ? 1 : 0, id);
  },

  insertRedlineJob(userId: number, filename: string, originalText: string): number {
    const result = sqlite.prepare(`INSERT INTO redline_jobs (user_id, filename, original_text, status) VALUES (?, ?, ?, 'processing')`).run(userId, filename, originalText);
    return Number(result.lastInsertRowid);
  },

  updateRedlineJob(id: number, status: string, editedText?: string, changesSummary?: string) {
    if (editedText) {
      sqlite.prepare(`UPDATE redline_jobs SET status = ?, edited_text = ?, changes_summary = ?, completed_at = datetime('now') WHERE id = ?`).run(status, editedText, changesSummary || '', id);
    } else {
      sqlite.prepare(`UPDATE redline_jobs SET status = ?, completed_at = datetime('now') WHERE id = ?`).run(status, id);
    }
  },

  getRedlineJobs(userId: number) {
    return sqlite.prepare(`SELECT id, filename, status, changes_summary, created_at, completed_at FROM redline_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20`).all(userId) as any[];
  },

  getAllRedlineJobs() {
    return sqlite.prepare(`SELECT r.id, r.filename, r.status, r.changes_summary, r.created_at, r.completed_at, u.username FROM redline_jobs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 50`).all() as any[];
  },

  getRedlineJob(id: number) {
    return sqlite.prepare(`SELECT * FROM redline_jobs WHERE id = ?`).get(id) as any;
  },

  setArticleRelevance(articleUrl: string, userId: number, relevant: boolean) {
    sqlite.prepare(`INSERT INTO article_relevance (article_url, user_id, relevant) VALUES (?, ?, ?) ON CONFLICT(article_url, user_id) DO UPDATE SET relevant = ?, created_at = datetime('now')`).run(articleUrl, userId, relevant ? 1 : 0, relevant ? 1 : 0);
  },

  removeArticleRelevance(articleUrl: string, userId: number) {
    sqlite.prepare(`DELETE FROM article_relevance WHERE article_url = ? AND user_id = ?`).run(articleUrl, userId);
  },

  getArticleRelevance() {
    return sqlite.prepare(`
      SELECT article_url,
        SUM(CASE WHEN relevant = 1 THEN 1 ELSE 0 END) as relevant,
        SUM(CASE WHEN relevant = 0 THEN 1 ELSE 0 END) as not_relevant
      FROM article_relevance GROUP BY article_url
    `).all() as { article_url: string; relevant: number; not_relevant: number }[];
  },

  getUserCount() {
    const r = sqlite.prepare(`SELECT COUNT(*) as cnt FROM users`).get() as { cnt: number };
    return r.cnt;
  },

  getLatestRefresh() {
    return db.select().from(refreshLog).orderBy(desc(refreshLog.id)).limit(1).get();
  },

  logRefresh(added, status, notes) {
    db.insert(refreshLog).values({
      completedAt: new Date().toISOString(),
      articlesAdded: added,
      status,
      notes: notes ?? null,
    }).run();
  },

  // ─── Tracked sites ─────────────────────────────────────────────────────────
  getSites() {
    return sqlite.prepare(`SELECT * FROM tracked_sites ORDER BY label ASC`).all() as TrackedSite[];
  },

  getEnabledSites() {
    return sqlite.prepare(`SELECT * FROM tracked_sites WHERE enabled = 1 ORDER BY label ASC`).all() as TrackedSite[];
  },

  addSite(siteKey, label, rssUrl, siteUrl, color) {
    const result = sqlite.prepare(
      `INSERT INTO tracked_sites (site_key, label, rss_url, site_url, color) VALUES (?, ?, ?, ?, ?)`
    ).run(siteKey, label, rssUrl, siteUrl ?? null, color);
    return result.lastInsertRowid as number;
  },

  updateSite(id, fields) {
    const setClauses: string[] = [];
    const values: any[] = [];
    if (fields.label !== undefined) { setClauses.push("label = ?"); values.push(fields.label); }
    if (fields.rss_url !== undefined) { setClauses.push("rss_url = ?"); values.push(fields.rss_url); }
    if (fields.site_url !== undefined) { setClauses.push("site_url = ?"); values.push(fields.site_url); }
    if (fields.color !== undefined) { setClauses.push("color = ?"); values.push(fields.color); }
    if (fields.enabled !== undefined) { setClauses.push("enabled = ?"); values.push(fields.enabled); }
    if (fields.exclude_velocity !== undefined) { setClauses.push("exclude_velocity = ?"); values.push(fields.exclude_velocity); }
    if (setClauses.length === 0) return;
    values.push(id);
    sqlite.prepare(`UPDATE tracked_sites SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
  },

  deleteSite(id) {
    // Record the site_key so seedSitesIfEmpty won't re-add it on next startup
    const row = sqlite.prepare(`SELECT site_key FROM tracked_sites WHERE id = ?`).get(id) as { site_key: string } | undefined;
    if (row) {
      sqlite.prepare(`INSERT OR IGNORE INTO deleted_sites (site_key) VALUES (?)`).run(row.site_key);
    }
    sqlite.prepare(`DELETE FROM tracked_sites WHERE id = ?`).run(id);
  },

  seedSitesIfEmpty() {
    // Merge hardcoded SITES into DB — adds any new sources that don't exist yet
    const { SITES } = require("./feeds");
    const SITE_URLS: Record<string, string> = {
      stereonet: 'https://www.stereonet.com', whathifi: 'https://www.whathifi.com',
      hifipig: 'https://www.hifipig.com', darko: 'https://darko.audio',
      ecoustics: 'https://www.ecoustics.com', absolutesound: 'https://www.theabsolutesound.com',
      hifinews: 'https://www.hifinews.com', audiophileman: 'https://theaudiophileman.com',
      twitteringmachines: 'https://www.twitteringmachines.com', audiohead: 'https://audio-head.com',
      soundstage: 'https://www.soundstagenetwork.com', hometheaterhifi: 'https://www.hometheaterhifi.com',
      stereophile: 'https://www.stereophile.com', audioxpress: 'https://www.audioxpress.com',
      techradar: 'https://www.techradar.com', cnet: 'https://www.cnet.com',
      theverge: 'https://www.theverge.com', engadget: 'https://www.engadget.com',
      tomsguide: 'https://www.tomsguide.com', gearpatrol: 'https://www.gearpatrol.com',
      channelnews: 'https://channelnews.com.au', '9to5google': 'https://9to5google.com',
      soundonsound: 'https://www.soundonsound.com', dailyaudio: 'https://daily.audio',
      samsung: 'https://news.samsung.com/global',
      // Added April 2026
      audioholics: 'https://www.audioholics.com',
      enjoythemusic: 'https://www.enjoythemusic.com',
      audiophilia: 'https://www.audiophilia.com',
      dagogo: 'https://dagogo.com',
      parttimeaudiophile: 'https://parttimeaudiophile.com',
      hifiplus: 'https://www.hifiplus.com',
      audiobacon: 'https://audiobacon.net',
      audiophilereview: 'https://audiophilereview.com',
      audioresurgence: 'https://audioresurgence.com',
      audiofi: 'https://audiofi.net',
      // Manufacturer newsrooms
      dynaudio: 'https://www.dynaudio.com',
      kef: 'https://us.kef.com',
      klipsch: 'https://www.klipsch.com',
      lg_newsroom: 'https://www.lgnewsroom.com',
      mcintosh: 'https://www.mcintoshlabs.com',
      sonos_community: 'https://en.community.sonos.com',
      // Google News queries
      gn_bose: 'https://www.bose.com',
      gn_bowerswilkins: 'https://www.bowerswilkins.com',
      gn_bang_olufsen: 'https://www.bang-olufsen.com',
      gn_focal: 'https://www.focal.com',
      gn_denon: 'https://www.denon.com',
      gn_marantz: 'https://www.marantz.com',
      gn_svs: 'https://www.svsound.com',
      gn_sennheiser: 'https://www.sennheiser.com',
      gn_audiotechnica: 'https://www.audio-technica.com',
      gn_panasonic: 'https://news.panasonic.com',
      gn_sony_audio: 'https://www.sony.com',
    };
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO tracked_sites (site_key, label, rss_url, site_url, color) VALUES (?, ?, ?, ?, ?)`
    );
    // Skip any site the user has explicitly deleted
    const deletedKeys = new Set(
      (sqlite.prepare(`SELECT site_key FROM deleted_sites`).all() as { site_key: string }[]).map(r => r.site_key)
    );
    const entries = Object.entries(SITES as Record<string, { label: string; url: string; color: string }>).map(
      ([key, val]) => [key, val.label, val.url, SITE_URLS[key] || '', val.color] as [string, string, string, string, string]
    );
    let added = 0;
    let skipped = 0;
    for (const [key, label, url, siteUrl, color] of entries) {
      if (deletedKeys.has(key)) { skipped++; continue; }
      const result = insert.run(key, label, url, siteUrl, color);
      if (result.changes > 0) added++;
    }
    if (added > 0) console.log(`[cadence] Added ${added} new sites to tracked_sites`);
    if (skipped > 0) console.log(`[cadence] Skipped ${skipped} user-deleted sites during seed`);
  },

  updateSiteUrl(siteKey: string, rssUrl: string) {
    sqlite.prepare(`UPDATE tracked_sites SET rss_url = ? WHERE site_key = ?`).run(rssUrl, siteKey);
  },

  getArticleComments(articleId: number) {
    return sqlite.prepare(
      `SELECT id, article_id, username, comment, created_at FROM article_comments WHERE article_id = ? ORDER BY created_at ASC`
    ).all(articleId) as { id: number; article_id: number; username: string; comment: string; created_at: string }[];
  },

  addArticleComment(articleId: number, username: string, comment: string) {
    const result = sqlite.prepare(
      `INSERT INTO article_comments (article_id, username, comment) VALUES (?, ?, ?)`
    ).run(articleId, username, comment);
    return Number(result.lastInsertRowid);
  },

  deleteArticleComment(id: number) {
    sqlite.prepare(`DELETE FROM article_comments WHERE id = ?`).run(id);
  },

  getCommentCounts() {
    return sqlite.prepare(
      `SELECT article_id, COUNT(*) as count FROM article_comments GROUP BY article_id`
    ).all() as { article_id: number; count: number }[];
  },

  toggleReaction(commentId: number, username: string, emoji: string) {
    const existing = sqlite.prepare(
      `SELECT id FROM comment_reactions WHERE comment_id = ? AND username = ? AND emoji = ?`
    ).get(commentId, username, emoji);
    if (existing) {
      sqlite.prepare(`DELETE FROM comment_reactions WHERE comment_id = ? AND username = ? AND emoji = ?`).run(commentId, username, emoji);
      return false; // removed
    }
    sqlite.prepare(
      `INSERT INTO comment_reactions (comment_id, username, emoji) VALUES (?, ?, ?)`
    ).run(commentId, username, emoji);
    return true; // added
  },

  getReactionsForComments(commentIds: number[]) {
    if (commentIds.length === 0) return [];
    const placeholders = commentIds.map(() => "?").join(",");
    return sqlite.prepare(
      `SELECT comment_id, emoji, username FROM comment_reactions WHERE comment_id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...commentIds) as { comment_id: number; emoji: string; username: string }[];
  },

  addNotification(username: string, type: string, message: string, fromUser: string, articleId?: number, commentId?: number) {
    const result = sqlite.prepare(
      `INSERT INTO notifications (username, type, message, from_user, article_id, comment_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(username, type, message, fromUser, articleId ?? null, commentId ?? null);
    return Number(result.lastInsertRowid);
  },

  getNotifications(username: string, limit = 50) {
    // Sort UNREAD first so the bell panel never misses unread items that are
    // older than the LIMIT cap (which caused the "bell says 5 but panel says
    // nothing" desync). Within each group, newest first.
    const rows = sqlite.prepare(
      `SELECT * FROM notifications WHERE username = ? ORDER BY read ASC, created_at DESC LIMIT ?`
    ).all(username, limit) as any[];
    // created_at is stored in UTC but without a Z suffix — normalise to ISO so the
    // client parses it correctly. Values already ending in Z are left alone.
    return rows.map(r => ({
      ...r,
      created_at: r.created_at && !r.created_at.endsWith("Z")
        ? r.created_at.replace(" ", "T") + "Z"
        : r.created_at,
    }));
  },

  getUnreadCount(username: string) {
    const row = sqlite.prepare(
      `SELECT COUNT(*) as count FROM notifications WHERE username = ? AND read = 0`
    ).get(username) as { count: number };
    return row.count;
  },

  markNotificationRead(id: number) {
    sqlite.prepare(`UPDATE notifications SET read = 1 WHERE id = ?`).run(id);
  },

  markAllNotificationsRead(username: string) {
    sqlite.prepare(`UPDATE notifications SET read = 1 WHERE username = ? AND read = 0`).run(username);
  },

  getCommentOwner(commentId: number) {
    const row = sqlite.prepare(`SELECT username FROM article_comments WHERE id = ?`).get(commentId) as { username: string } | undefined;
    return row?.username ?? null;
  },

  getCommentersForArticle(articleId: number) {
    const rows = sqlite.prepare(
      `SELECT DISTINCT username FROM article_comments WHERE article_id = ?`
    ).all(articleId) as { username: string }[];
    return rows.map(r => r.username);
  },

  getArticleTitle(articleId: number) {
    const row = sqlite.prepare(`SELECT title FROM articles WHERE id = ?`).get(articleId) as { title: string } | undefined;
    return row?.title ?? null;
  },

  claimArticle(articleId: number, username: string) {
    sqlite.prepare(
      `INSERT OR REPLACE INTO article_claims (article_id, username) VALUES (?, ?)`
    ).run(articleId, username);
  },

  unclaimArticle(articleId: number) {
    sqlite.prepare(`DELETE FROM article_claims WHERE article_id = ?`).run(articleId);
  },

  markWritten(articleId: number) {
    sqlite.prepare(
      `UPDATE article_claims SET status = 'written' WHERE article_id = ?`
    ).run(articleId);
  },

  getClaims() {
    return sqlite.prepare(
      `SELECT article_id, username, status, claimed_at FROM article_claims WHERE status = 'claimed' ORDER BY claimed_at DESC`
    ).all() as { article_id: number; username: string; status: string; claimed_at: string }[];
  },

  getWrittenArticles() {
    return sqlite.prepare(
      `SELECT article_id, username, claimed_at FROM article_claims WHERE status = 'written' ORDER BY claimed_at DESC`
    ).all() as { article_id: number; username: string; claimed_at: string }[];
  },

  getClaim(articleId: number) {
    const row = sqlite.prepare(
      `SELECT article_id, username, status, claimed_at FROM article_claims WHERE article_id = ?`
    ).get(articleId) as { article_id: number; username: string; status: string; claimed_at: string } | undefined;
    return row ?? null;
  },

  dismissArticle(articleId: number, username: string) {
    // Global dismissal — remove any prior entry for this article, insert fresh
    sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(articleId);
    sqlite.prepare(
      `INSERT INTO article_dismissals (article_id, username) VALUES (?, ?)`
    ).run(articleId, username);
  },

  undismissArticle(articleId: number) {
    sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(articleId);
  },

  getDismissals() {
    return sqlite.prepare(
      `SELECT article_id, username, dismissed_at FROM article_dismissals ORDER BY dismissed_at DESC`
    ).all() as { article_id: number; username: string; dismissed_at: string }[];
  },

  pinArticle(articleId: number, username: string, note = "Please Write") {
    sqlite.prepare(
      `INSERT OR REPLACE INTO article_pins (article_id, pinned_by, note) VALUES (?, ?, ?)`
    ).run(articleId, username, note);
    // Pin always wins over dismissal — if an article was previously dismissed,
    // pinning should resurface it. This is especially important for editor-brief
    // webhook ingest where please_write:true auto-pins.
    sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(articleId);
  },

  unpinArticle(articleId: number) {
    sqlite.prepare(`DELETE FROM article_pins WHERE article_id = ?`).run(articleId);
  },

  getPins() {
    return sqlite.prepare(
      `SELECT article_id, note, pinned_by, pinned_at FROM article_pins ORDER BY pinned_at DESC`
    ).all() as { article_id: number; note: string; pinned_by: string; pinned_at: string }[];
  },

  markIrrelevant(articleId: number, title: string, site: string, username: string) {
    sqlite.prepare(
      `INSERT OR IGNORE INTO irrelevant_marks (article_id, title, site, username) VALUES (?, ?, ?, ?)`
    ).run(articleId, title, site, username);
  },

  getIrrelevantMarks() {
    return sqlite.prepare(
      `SELECT article_id, title, site, username, marked_at FROM irrelevant_marks ORDER BY marked_at DESC`
    ).all() as any[];
  },

  getIrrelevantArticleIds() {
    return sqlite.prepare(`SELECT DISTINCT article_id FROM irrelevant_marks`).all().map((r: any) => r.article_id) as number[];
  },

  removeIrrelevantMark(articleId: number) {
    sqlite.prepare(`DELETE FROM irrelevant_marks WHERE article_id = ?`).run(articleId);
    // Also un-dismiss (remove from dismissals that came from the irrelevant flow)
    sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(articleId);
  },

  logAudit(entry: { username: string; action: string; articleId?: number | null; detail?: string | null }) {
    let title: string | null = null;
    let site: string | null = null;
    if (entry.articleId) {
      const art = sqlite.prepare(`SELECT title, site FROM articles WHERE id = ?`).get(entry.articleId) as { title: string; site: string } | undefined;
      if (art) { title = art.title; site = art.site; }
    }
    sqlite.prepare(
      `INSERT INTO discovery_audit (username, action, article_id, article_title, article_site, detail) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(entry.username, entry.action, entry.articleId || null, title, site, entry.detail || null);
  },

  getSetting(key: string) {
    const row = sqlite.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },

  setSetting(key: string, value: string) {
    sqlite.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, value);
  },

  getTopPicks(date: string) {
    return sqlite.prepare(
      `SELECT date, generated_at, picks_json FROM top_picks WHERE date = ?`
    ).get(date) as any;
  },

  setTopPicks(date: string, picksJson: string) {
    sqlite.prepare(
      `INSERT INTO top_picks (date, picks_json) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET picks_json = excluded.picks_json, generated_at = datetime('now')`
    ).run(date, picksJson);
  },

  getAuditLog(opts?: { limit?: number; articleId?: number; username?: string; action?: string }) {
    const where: string[] = [];
    const params: any[] = [];
    if (opts?.articleId) { where.push("article_id = ?"); params.push(opts.articleId); }
    if (opts?.username) { where.push("username = ?"); params.push(opts.username); }
    if (opts?.action) { where.push("action = ?"); params.push(opts.action); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts?.limit ?? 200;
    params.push(limit);
    return sqlite.prepare(
      `SELECT id, username, action, article_id, article_title, article_site, detail, created_at
       FROM discovery_audit ${whereSql} ORDER BY created_at DESC LIMIT ?`
    ).all(...params);
  },

  getBlockedKeywords() {
    return sqlite.prepare(
      `SELECT id, keyword, source, hit_count, created_at FROM blocked_keywords ORDER BY hit_count DESC, created_at DESC`
    ).all() as any[];
  },

  addBlockedKeyword(keyword: string, source = "learned") {
    sqlite.prepare(`INSERT OR IGNORE INTO blocked_keywords (keyword, source) VALUES (?, ?)`).run(keyword.toLowerCase(), source);
  },

  removeBlockedKeyword(id: number) {
    sqlite.prepare(`DELETE FROM blocked_keywords WHERE id = ?`).run(id);
  },

  incrementBlockedKeywordHits(keyword: string) {
    sqlite.prepare(`UPDATE blocked_keywords SET hit_count = hit_count + 1 WHERE keyword = ?`).run(keyword.toLowerCase());
  },
};


