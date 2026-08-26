// PITCH — client proposal builder. Backend module.
// Storage helpers, tier templates, and Express routes.

import type { Express, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { sqlite, storage } from "./storage";
import { cfg } from "./config";
import { fetchGA4Overview, BOT_COUNTRIES, fetchSCQueriesForBrand } from "./analytics";
import { saveAttachment } from "./attachments";

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Pro-rate "per N months" line items to the actual contract length.
// e.g. catalog says "2 Review Slots per 12 months" — if contract is 6 months,
// show 1 slot. unit_price_usd stays 0 so monthly subtotal is unaffected.
// Non-period items (per month, ongoing, one-off, set/month) pass through unchanged.
// When a proposal is sent the prospect's kit clone must be FROZEN — future
// edits to the canonical Global kit (new sections, copy changes, etc) must
// NOT propagate into kits that have already been delivered to a customer.
// We achieve this by walking the inherited blocks for this kit and writing
// each one back into media_kit_blocks as a local override (is_override=1)
// for any block_key that doesn't already have an own row.
export function freezeInheritedBlocksForKit(kitId: number, opts: { excludeBlockKeys?: string[] } = {}): { frozen: number; skipped: number; excluded: number } {
  let frozen = 0, skipped = 0, excluded = 0;
  const exclude = new Set<string>(opts.excludeBlockKeys || []);
  try {
    // SAFETY: never freeze a regional/canonical master kit. Freezing is for
    // PROSPECT clones only — i.e. kits that have a prospect_lead_id set OR
    // were created from a PITCH proposal (linked via pitch_proposals.media_kit_id).
    const kit = sqlite.prepare(`SELECT id, is_canonical, prospect_lead_id, parent_kit_id FROM media_kits WHERE id = ?`).get(kitId) as any;
    if (!kit) return { frozen: 0, skipped: 0, excluded: 0 };
    const isProposalClone = !!sqlite.prepare(`SELECT 1 FROM pitch_proposals WHERE media_kit_id = ? LIMIT 1`).get(kitId);
    const isProspectClone = !!kit.prospect_lead_id;
    if (!isProposalClone && !isProspectClone) {
      // Regional master, canonical, or retailer master — must keep inheriting.
      return { frozen: 0, skipped: 0, excluded: 0 };
    }
    const { getEffectiveBlocks } = require("./media-kit");
    const blocks = getEffectiveBlocks(kitId);
    // Only re-stamp blocks that came from a parent (inherited). Skip rows
    // already owned by this kit (proposal block, frozen investment, etc).
    const inheritedOnly = blocks.filter((b: any) => b.inherited);
    const existing = new Set<string>(
      (sqlite.prepare(`SELECT block_key FROM media_kit_blocks WHERE kit_id = ?`).all(kitId) as any[]).map((r: any) => r.block_key)
    );
    const ins = sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, ?, ?, 1, ?, ?, datetime('now'))`);
    for (const b of inheritedOnly) {
      if (existing.has(b.block_key)) { skipped++; continue; }
      if (exclude.has(b.block_key)) {
        // Explicitly excluded — also write an INVISIBLE override so this kit
        // permanently suppresses the inherited block (even if removed from
        // the exclude list later).
        ins.run(kitId, b.block_key, b.position || 0, 0, JSON.stringify({ _suppressed: true }));
        excluded++;
        continue;
      }
      // Inherited block — stamp a frozen copy.
      ins.run(kitId, b.block_key, b.position || 0, b.is_visible === 0 ? 0 : 1, b.content_json || "{}");
      frozen++;
    }
  } catch (e) { console.warn("[pitch] freezeInheritedBlocksForKit failed:", e); }
  return { frozen, skipped, excluded };
}

function proRateLineItem(li: any, contractMonths: number) {
  const out: any = {
    category: li.category,
    label: li.label,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price_usd,
    is_complimentary: !!li.is_complimentary,
    original_unit_price: li.original_unit_price_usd ?? null,
  };
  const unit = String(li.unit || "");
  const m = unit.match(/per\s+(\d+)\s+months?/i);
  if (m) {
    const periodMonths = Number(m[1]);
    if (periodMonths > 0 && contractMonths !== periodMonths) {
      const ratio = contractMonths / periodMonths;
      const newQty = Math.max(0, Math.round(Number(li.qty || 0) * ratio));
      out.qty = newQty;
      out.unit = contractMonths === 1 ? "per month" : `per ${contractMonths} months`;
      if (li.description) {
        out.description = String(li.description).replace(/\b12\s+months?\b/i, `${contractMonths} months`);
      }
    }
  }
  return out;
}

// Standalone helper that re-stamps the linked Media Kit clone's proposal block
// from the current pitch_proposals row. Lives at module scope so the startup
// backfill below can call it without entering the route-registration closure.
export function restampKitFromProposal(proposalId: number, opts: { force?: boolean } = {}): { restamped: boolean } {
  try {
    const prop = sqlite.prepare(`SELECT * FROM pitch_proposals WHERE id = ?`).get(proposalId) as any;
    if (!prop || !prop.media_kit_id) return { restamped: false };
    // Safety guard: once a proposal is sent the prospect has been quoted those
    // exact values. Never re-stamp sent proposals unless explicitly forced
    // (e.g. the user clicks "Force Restamp" from admin).
    if (prop.status === 'sent' && !opts.force) return { restamped: false };
    const items = sqlite.prepare(`SELECT * FROM pitch_line_items WHERE proposal_id = ? ORDER BY sort_order ASC, id ASC`).all(proposalId) as any[];
    // Parse regions list from pitch_proposals.regions_json (empty array / all 4 = Global).
    let regions: string[] = [];
    try { regions = JSON.parse(prop.regions_json || "[]"); } catch { regions = []; }
    const REGION_LABELS: Record<string, string> = { anz: "Australia & NZ", na: "North America", "uk-eu": "UK & Europe", asia: "Southeast Asia" };
    const isGlobal = regions.length === 0 || regions.length === 4;
    const regionsScopeLabel = isGlobal ? "Global — all four regions" : regions.map(r => REGION_LABELS[r] || r).join(" + ");
    const regionLabels = isGlobal ? ["Australia & NZ", "North America", "UK & Europe", "Southeast Asia"] : regions.map(r => REGION_LABELS[r] || r);
    const monthly = items.reduce((sum: number, li: any) => {
      if (!li.included) return sum;
      const qty = Number(li.qty) || 0;
      const price = Number(li.unit_price_usd) || 0;
      const isMonthly = !li.unit || /month|ongoing|recurring/i.test(li.unit);
      return sum + (isMonthly ? qty * price : 0);
    }, 0);
    // Casual proposals: NO monthly/contract math. Sum the one-off line items
    // as the total. Discount still applies to the one-off subtotal.
    const proposalType = (prop.proposal_type as string) || "proposal";
    const isCasual = proposalType === "casual";
    const oneOffSubtotal = isCasual
      ? (items || []).reduce((sum: number, li: any) => {
          if (!li.included) return sum;
          return sum + (Number(li.qty) || 0) * (Number(li.unit_price_usd) || 0);
        }, 0)
      : 0;
    const discountPct = Number(prop.override_discount_pct) || 0;
    const months = Number(prop.contract_months) || 6;
    const monthlyAfterDiscount = monthly * (1 - discountPct / 100);
    const contractTotal = isCasual ? oneOffSubtotal * (1 - discountPct / 100) : monthlyAfterDiscount * months;
    const currency = prop.currency || "USD";
    const existingBlock = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'proposal'`).get(prop.media_kit_id) as any;
    let existing: any = {};
    try { existing = existingBlock ? JSON.parse(existingBlock.content_json) : {}; } catch { existing = {}; }
    const proposalBlock = {
      ...existing,
      proposal_type: proposalType,
      prepared_for: prop.client_name,
      client_logo_url: prop.client_logo_url || null,
      subtitle: prop.intro_text || "",
      tier: isCasual ? null : prop.base_tier,
      contract_months: isCasual ? null : months,
      proposed_start_date: prop.proposed_start_date || null,
      monthly_subtotal: isCasual ? 0 : Number(monthly.toFixed(2)),
      one_off_subtotal: isCasual ? Number(oneOffSubtotal.toFixed(2)) : 0,
      discount_pct: discountPct,
      monthly_total: isCasual ? 0 : Number(monthlyAfterDiscount.toFixed(2)),
      contract_total: Number(contractTotal.toFixed(2)),
      total_currency: currency,
      total_value: Number(contractTotal.toFixed(2)),
      total_period: isCasual ? "one_off" : "month",
      regions_scope_label: regionsScopeLabel,
      region_labels: regionLabels,
      is_global: isGlobal,
      summary_line: isCasual
        ? `Casual / Ad-hoc · ${currency} · ${regionsScopeLabel}`
        : `${String(prop.base_tier || "").toUpperCase()} · ${months} months · ${currency} · ${regionsScopeLabel}`,
      discount_label_text: (prop.discount_label_override && String(prop.discount_label_override).trim())
        || (sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_discount_label_text'`).get() as any)?.value
        || "Partnership discount applied",
      // Casual line items are one-off; don't pro-rate them. Regular proposals
      // still pro-rate per-month items to the contract length.
      line_items_snapshot: items.filter((li: any) => li.included).map((li: any) =>
        isCasual
          ? {
              category: li.category,
              label: li.label,
              description: li.description,
              qty: li.qty,
              unit: li.unit,
              unit_price: li.unit_price_usd,
              is_complimentary: !!li.is_complimentary,
              original_unit_price: li.original_unit_price_usd ?? null,
            }
          : proRateLineItem(li, months)
      ),
    };
    const json = JSON.stringify(proposalBlock);
    if (existingBlock) {
      sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE kit_id = ? AND block_key = 'proposal'`).run(json, prop.media_kit_id);
    } else {
      sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'proposal', 0, 1, 1, ?, datetime('now'))`).run(prop.media_kit_id, json);
    }
    sqlite.prepare(`UPDATE media_kits SET base_currency = ?, updated_at = datetime('now') WHERE id = ?`).run(currency, prop.media_kit_id);
    return { restamped: true };
  } catch (e) {
    console.error("[pitch→kit] restamp failed:", e);
    return { restamped: false };
  }
}

// One-shot startup sync: copy current media_kit_addons tier prices into BOTH
// pitch_tier_template_items (used by line-item stamping) AND pitch_tier_templates
// (used by the wizard's Tier dropdown) so the three tables can't drift. Bump
// the flag version (v2) to re-sync after price changes.
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_tier_price_sync_v2'`).get() as any;
  if (!flag) {
    const rows = sqlite.prepare(`SELECT addon_key, region, label, price_value FROM media_kit_addons WHERE kind = 'tier'`).all() as any[];
    let updatedItems = 0;
    let updatedTemplates = 0;
    for (const r of rows) {
      const tierRegion = r.region == null ? "global" : r.region;
      const newLabel = `${r.label} Tier — Monthly Base`;
      const itemsRes = sqlite.prepare(`
        UPDATE pitch_tier_template_items
           SET unit_price_usd = ?, label = ?
         WHERE tier_key = ? AND region = ? AND sort_order = 0
      `).run(Number(r.price_value) || 0, newLabel, r.addon_key, tierRegion);
      updatedItems += itemsRes.changes;
      const tmplRes = sqlite.prepare(`
        UPDATE pitch_tier_templates
           SET monthly_usd = ?
         WHERE tier_key = ? AND region = ?
      `).run(Number(r.price_value) || 0, r.addon_key, tierRegion);
      updatedTemplates += tmplRes.changes;
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('pitch_tier_price_sync_v2', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), updated_items: updatedItems, updated_templates: updatedTemplates, total: rows.length }));
    console.log(`[pitch] tier price sync v2 complete: items=${updatedItems} templates=${updatedTemplates} of ${rows.length}`);
  }
} catch (e) { console.warn("[pitch] tier price sync failed:", e); }

// One-shot follow-up: for every DRAFT proposal, re-pull the tier-base unit
// price from pitch_tier_template_items so existing drafts don't carry stale
// $2499 Bronze etc. We only touch status='draft' rows — anything already sent
// or accepted is frozen. Matches by sort_order=0 (tier base row).
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_draft_tier_resync_v1'`).get() as any;
  if (!flag) {
    const drafts = sqlite.prepare(`SELECT id, base_tier, client_region, regions_json FROM pitch_proposals WHERE status = 'draft'`).all() as any[];
    let touched = 0;
    for (const d of drafts) {
      // Resolve the right region the same way the wizard does (priority order).
      let regions: string[] = [];
      try { regions = JSON.parse(d.regions_json || "[]"); } catch {}
      const pickRegion = regions[0] || (d.client_region && d.client_region !== "global" ? d.client_region : null) || "global";
      const tierItem = sqlite.prepare(`
        SELECT unit_price_usd, label FROM pitch_tier_template_items
         WHERE tier_key = ? AND region = ? AND sort_order = 0
         LIMIT 1
      `).get(d.base_tier, pickRegion) || sqlite.prepare(`
        SELECT unit_price_usd, label FROM pitch_tier_template_items
         WHERE tier_key = ? AND region = 'global' AND sort_order = 0
         LIMIT 1
      `).get(d.base_tier) as any;
      if (tierItem) {
        const r = sqlite.prepare(`
          UPDATE pitch_line_items
             SET unit_price_usd = ?, label = ?
           WHERE proposal_id = ? AND sort_order = 0
        `).run((tierItem as any).unit_price_usd, (tierItem as any).label, d.id);
        if (r.changes > 0) touched++;
      }
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('pitch_draft_tier_resync_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), touched, total: drafts.length }));
    console.log(`[pitch] draft tier price resync complete: touched=${touched} of ${drafts.length}`);
  }
} catch (e) { console.warn("[pitch] draft tier resync failed:", e); }

// One-shot startup backfill: re-stamp every proposal that has a linked Media
// Kit. Bump the flag version to re-run when the stamping schema gains new
// fields (e.g. v2 adds regions_scope_label + region_labels for the campaign
// coverage strip on the public kit view).
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_kit_restamp_v6'`).get() as any;
  if (!flag) {
    // Only re-stamp DRAFT proposals. Sent proposals are frozen — pro-rating
    // changes for review slots etc. must not retroactively alter what a
    // prospect was already quoted.
    const rows = sqlite.prepare(`SELECT id FROM pitch_proposals WHERE media_kit_id IS NOT NULL AND status = 'draft'`).all() as any[];
    let ok = 0, fail = 0;
    for (const r of rows) {
      const result = restampKitFromProposal(r.id);
      if (result.restamped) ok++; else fail++;
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('pitch_kit_restamp_v6', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), ok, fail, total: rows.length }));
    console.log(`[pitch] kit restamp v5 backfill complete (drafts only): ok=${ok} fail=${fail} total=${rows.length}`);
  }
} catch (e) { console.warn("[pitch] kit restamp backfill failed:", e); }

// One-shot: reclassify existing media_kit_views as bot/human and recompute
// media_kit_shares.view_count to exclude bots. Email scanners (Outlook ATP,
// Mimecast, Proofpoint), preview unfurlers, and crawlers were previously
// counted as real opens, which inflated proposal view counts.
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'media_kit_view_bot_reclassify_v1'`).get() as any;
  if (!flag) {
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
    const classify = (ua: string | null) => {
      const s = String(ua || "").trim();
      if (!s) return { isBot: true, reason: "Empty UA" };
      for (const [re, reason] of botPatterns) if (re.test(s)) return { isBot: true, reason };
      return { isBot: false, reason: null as string | null };
    };
    const rows = sqlite.prepare(`SELECT id, user_agent FROM media_kit_views`).all() as any[];
    const upd = sqlite.prepare(`UPDATE media_kit_views SET is_bot = ?, bot_reason = ? WHERE id = ?`);
    let botCount = 0;
    for (const r of rows) {
      const { isBot, reason } = classify(r.user_agent);
      upd.run(isBot ? 1 : 0, reason, r.id);
      if (isBot) botCount++;
    }
    // Recompute view_count per share = count of non-bot rows.
    sqlite.exec(`
      UPDATE media_kit_shares
      SET view_count = COALESCE((
        SELECT COUNT(*) FROM media_kit_views v
        WHERE v.share_id = media_kit_shares.id AND v.is_bot = 0
      ), 0)
    `);
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('media_kit_view_bot_reclassify_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), total: rows.length, bots: botCount }));
    console.log(`[media-kit] bot reclassify backfill: total=${rows.length} bots=${botCount}`);
  }
} catch (e) { console.warn("[media-kit] bot reclassify failed:", e); }

// One-shot: retroactively freeze every kit linked to a sent proposal so future
// Global-kit edits do not leak into already-delivered customer kits. This
// snapshots every currently-inherited block as a local override on that kit.
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_sent_kit_freeze_v1'`).get() as any;
  if (!flag) {
    const rows = sqlite.prepare(`SELECT id, media_kit_id, client_name FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
    let totalFrozen = 0;
    for (const r of rows) {
      try {
        const res = freezeInheritedBlocksForKit(r.media_kit_id);
        totalFrozen += res.frozen;
        if (res.frozen) console.log(`[pitch] froze ${res.frozen} block(s) on sent proposal ${r.client_name} (kit ${r.media_kit_id})`);
      } catch (e) { console.warn(`[pitch] freeze ${r.id} failed:`, e); }
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('pitch_sent_kit_freeze_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), proposals: rows.length, blocks_frozen: totalFrozen }));
    console.log(`[pitch] sent-kit freeze backfill: proposals=${rows.length} blocks_frozen=${totalFrozen}`);
  }
} catch (e) { console.warn("[pitch] sent-kit freeze backfill failed:", e); }

// One-shot: freeze every Media Kit that has ever had a SENT share — including
// Quick Send kits and Lead-customised prospect clones (e.g. Audiobro) that the
// proposal-only backfill missed. This is the catch-all so "any kit that has
// been delivered to a customer is frozen, regardless of HOW it was sent."
try {
  const flag = sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'media_kit_sent_freeze_v1'`).get() as any;
  if (!flag) {
    const rows = sqlite.prepare(`
      SELECT DISTINCT k.id AS kit_id, k.label, k.slug
      FROM media_kits k
      JOIN media_kit_shares s ON s.kit_id = k.id
      WHERE s.proposal_state = 'sent' AND s.sent_at IS NOT NULL
    `).all() as any[];
    let totalFrozen = 0;
    for (const r of rows) {
      try {
        const res = freezeInheritedBlocksForKit(r.kit_id);
        totalFrozen += res.frozen;
        if (res.frozen) console.log(`[media-kit] froze ${res.frozen} block(s) on sent kit ${r.label} (id ${r.kit_id})`);
      } catch (e) { console.warn(`[media-kit] freeze kit ${r.kit_id} failed:`, e); }
    }
    sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('media_kit_sent_freeze_v1', ?)`).run(JSON.stringify({ ran_at: new Date().toISOString(), kits: rows.length, blocks_frozen: totalFrozen }));
    console.log(`[media-kit] sent-kit freeze v1 backfill: kits=${rows.length} blocks_frozen=${totalFrozen}`);
  }
} catch (e) { console.warn("[media-kit] sent-kit freeze v1 backfill failed:", e); }

// Tiny diagnostic helper exported for the deploy-token gated route registered
// below. Returns whether a proposal was actually sent (pitch_proposals.sent_at
// is non-null) and whether the linked kit share has been opened by anyone.
export function getProposalSendStatus(proposalId: number) {
  const prop = sqlite.prepare(`SELECT id, client_name, status, sent_at, created_at, media_kit_id, media_kit_share_id FROM pitch_proposals WHERE id = ?`).get(proposalId) as any;
  if (!prop) return null;
  let share: any = null;
  if (prop.media_kit_share_id) {
    share = sqlite.prepare(`SELECT id, slug, proposal_state, sent_at, first_viewed_at, last_viewed_at, view_count, accepted_at FROM media_kit_shares WHERE id = ?`).get(prop.media_kit_share_id);
  }
  return { proposal: prop, share };
}

// GA4 country lists per region (ISO-like names matching GA4's `country` dimension).
const REGION_COUNTRIES: Record<string, string[]> = {
  anz: ["Australia", "New Zealand"],
  uk_eu: [
    "United Kingdom", "Ireland", "France", "Germany", "Italy", "Spain", "Portugal",
    "Netherlands", "Belgium", "Luxembourg", "Switzerland", "Austria",
    "Sweden", "Norway", "Denmark", "Finland", "Iceland",
    "Poland", "Czechia", "Czech Republic", "Slovakia", "Hungary", "Romania",
    "Bulgaria", "Greece", "Croatia", "Slovenia", "Serbia", "Estonia",
    "Latvia", "Lithuania", "Cyprus", "Malta",
  ],
  na: ["United States", "Canada", "Mexico"],
  asia: [
    "Singapore", "Malaysia", "Indonesia", "Thailand", "Vietnam", "Philippines",
    "Hong Kong", "Taiwan", "Japan", "South Korea", "China", "India",
    "Sri Lanka", "Bangladesh", "Pakistan", "Cambodia", "Laos", "Myanmar (Burma)",
    "Brunei",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier templates (mirrors the Q1 2026 Global media kit)
// ─────────────────────────────────────────────────────────────────────────────

type LineItem = {
  category: "core" | "bolt-on" | "discount";
  label: string;
  description?: string;
  qty: number;
  unit: string;
  unit_price_usd: number;
  included?: boolean;
};

type Tier = {
  key: string;
  label: string;
  monthly_usd: number;
  ad_weighting: number;
  reviews_per_year: number;
  ad_banner_sets: number;
  additional_discount_pct: number;
  features: { label: string; description?: string; included: boolean }[];
};

// Region → default currency mapping. When the proposal targets exactly one region
// (or a region's tier set is explicitly used), the prices stored in pitch_tier_templates
// are in this currency.
export const REGION_CURRENCY: Record<string, string> = {
  global: "USD",
  na: "USD",
  uk_eu: "GBP",
  asia: "USD",
  anz: "AUD",
};

export function pickTierRegion(proposalRegions: string[]): string {
  if (!Array.isArray(proposalRegions) || proposalRegions.length === 0) return "global";
  if (proposalRegions.length === 1) {
    const r = proposalRegions[0];
    if (["na", "uk_eu", "asia", "anz"].includes(r)) return r;
  }
  return "global";
}

// Region-specific tier baselines extracted from the published media kits.
// Used only on first-time seed. Admin edits in /pitch/settings → Tiers override.
export const REGIONAL_TIER_BASELINES: Record<string, { key: string; label: string; monthly: number; ad_weighting: number; reviews: number; banners: number; discount: number; sort: number }[]> = {
  anz: [
    { key: "partner",  label: "Partner",  monthly: 499,  ad_weighting: 0,   reviews: 0, banners: 0, discount: 0,  sort: 0 },
    { key: "bronze",   label: "Bronze",   monthly: 1499, ad_weighting: 0.5, reviews: 2, banners: 1, discount: 0,  sort: 1 },
    { key: "silver",   label: "Silver",   monthly: 2799, ad_weighting: 1,   reviews: 4, banners: 2, discount: 5,  sort: 2 },
    { key: "gold",     label: "Gold",     monthly: 3999, ad_weighting: 1.5, reviews: 6, banners: 3, discount: 10, sort: 3 },
    { key: "platinum", label: "Platinum", monthly: 0,    ad_weighting: 2,   reviews: 6, banners: 4, discount: 15, sort: 4 },
  ],
  uk_eu: [
    { key: "bronze",   label: "Bronze",   monthly: 499,  ad_weighting: 0.5, reviews: 2, banners: 1, discount: 0,  sort: 0 },
    { key: "silver",   label: "Silver",   monthly: 649,  ad_weighting: 1,   reviews: 4, banners: 2, discount: 5,  sort: 1 },
    { key: "gold",     label: "Gold",     monthly: 949,  ad_weighting: 1.5, reviews: 6, banners: 3, discount: 10, sort: 2 },
    { key: "platinum", label: "Platinum", monthly: 0,    ad_weighting: 2,   reviews: 6, banners: 4, discount: 15, sort: 3 },
  ],
  asia: [
    { key: "partner",  label: "Partner",  monthly: 300,  ad_weighting: 0,   reviews: 0, banners: 0, discount: 0,  sort: 0 },
    { key: "silver",   label: "Silver",   monthly: 600,  ad_weighting: 0.5, reviews: 2, banners: 1, discount: 0,  sort: 1 },
    { key: "gold",     label: "Gold",     monthly: 1000, ad_weighting: 1,   reviews: 4, banners: 2, discount: 5,  sort: 2 },
    { key: "custom",   label: "Custom",   monthly: 0,    ad_weighting: 2,   reviews: 6, banners: 3, discount: 10, sort: 3 },
  ],
};

export const TIERS: Tier[] = [
  {
    key: "partner",
    label: "Partner",
    monthly_usd: 499,
    ad_weighting: 0,
    reviews_per_year: 0,
    ad_banner_sets: 0,
    additional_discount_pct: 0,
    features: [
      { label: "Display Advertising Banner Sets", description: "Monthly triple banner ad sets (970x250, 300x600, 300x250)", included: false },
      { label: "Ad Weighting", description: "Frequency of appearance relative to others on the site", included: false },
      { label: "Unlimited News & PR with Editorial Priority", description: "Supplied major news and press releases published on our 48hr news cycle", included: true },
      { label: "Newsletter & Social Media Coverage", description: "Relevant editorial included in our regular consumer newsletters and social channels", included: true },
      { label: "Review Slots", description: "Reviews per 12 months (results not guaranteed)", included: false },
      { label: "Brand & Distributor Pages", description: "Dedicated distributor & brand pages", included: true },
      { label: "Exclusive Global Sponsor Forum", description: "Dedicated company and/or brand sponsor forum", included: true },
      { label: "Commercial Classifieds Access", description: "No Seller's Fees for commercial partners", included: true },
      { label: "Additional Advertising Discounts", description: "Overriding discount on all additional ad spend", included: false },
    ],
  },
  {
    key: "bronze",
    label: "Bronze",
    monthly_usd: 2499,
    ad_weighting: 0.5,
    reviews_per_year: 2,
    ad_banner_sets: 1,
    additional_discount_pct: 0,
    features: [],
  },
  {
    key: "silver",
    label: "Silver",
    monthly_usd: 3999,
    ad_weighting: 1,
    reviews_per_year: 4,
    ad_banner_sets: 2,
    additional_discount_pct: 5,
    features: [],
  },
  {
    key: "gold",
    label: "Gold",
    monthly_usd: 5499,
    ad_weighting: 1.5,
    reviews_per_year: 6,
    ad_banner_sets: 3,
    additional_discount_pct: 10,
    features: [],
  },
  {
    key: "platinum",
    label: "Platinum",
    monthly_usd: 0, // P.O.A
    ad_weighting: 2,
    reviews_per_year: 6,
    ad_banner_sets: 4,
    additional_discount_pct: 15,
    features: [],
  },
];

export const BOLT_ONS = [
  { key: "masthead_monthly",     label: "Masthead Advertisement (monthly)",          unit: "month",     unit_price_usd: 3499 },
  { key: "masthead_3mo",         label: "Masthead Advertisement (3-month special)",  unit: "3 months",  unit_price_usd: 8999 },
  { key: "diamond_monthly",      label: "Exclusive Diamond Banner (monthly)",        unit: "month",     unit_price_usd: 999 },
  { key: "diamond_3mo",          label: "Exclusive Diamond Banner (3-month)",        unit: "3 months",  unit_price_usd: 2499 },
  { key: "newsletter_banner",    label: "Newsletter Banner",                         unit: "per email", unit_price_usd: 2999 },
  { key: "exclusive_edm",        label: "Exclusive EDM Newsletter",                  unit: "each",      unit_price_usd: 2999 },
  { key: "meets_profile",        label: "StereoNET Meets (1000-word feature)",       unit: "one-off",   unit_price_usd: 1499 },
  { key: "inside_track",         label: "Inside Track (3000-word feature)",          unit: "one-off",   unit_price_usd: 3499 },
  { key: "social_boost_7d",      label: "Social Media Boost (7 days)",               unit: "one-off",   unit_price_usd: 999 },
  { key: "social_boost_14d",     label: "Social Media Boost (14 days)",              unit: "one-off",   unit_price_usd: 1499 },
  { key: "social_boost_30d",     label: "Social Media Boost (1 month)",              unit: "one-off",   unit_price_usd: 2799 },
];

// Read tier template items from the DB, scoped by region. Falls back to 'global'
// if the region-specific tier doesn't exist.
export function lineItemsForTierFromDB(tierKey: string, region: string = "global"): LineItem[] | null {
  let rows = sqlite.prepare(`
    SELECT category, label, description, qty, unit, unit_price_usd, included
      FROM pitch_tier_template_items WHERE tier_key = ? AND region = ?
      ORDER BY sort_order ASC, id ASC
  `).all(tierKey, region) as any[];
  if (!rows || rows.length === 0) {
    if (region !== "global") {
      rows = sqlite.prepare(`
        SELECT category, label, description, qty, unit, unit_price_usd, included
          FROM pitch_tier_template_items WHERE tier_key = ? AND region = 'global'
          ORDER BY sort_order ASC, id ASC
      `).all(tierKey) as any[];
    }
    if (!rows || rows.length === 0) return null;
  }
  return rows.map(r => ({
    category: r.category as any,
    label: r.label,
    description: r.description ?? undefined,
    qty: r.qty,
    unit: r.unit ?? undefined,
    unit_price_usd: r.unit_price_usd,
    included: !!r.included,
  }));
}

// Generate default line items for a chosen tier.
// Returns the core entitlements that fill the proposal builder.
export function lineItemsForTier(tierKey: string): LineItem[] {
  const tier = TIERS.find(t => t.key === tierKey) || TIERS[2]; // default silver
  const items: LineItem[] = [];
  let sort = 0;
  const push = (i: Omit<LineItem, "included"> & { included?: boolean }) => {
    items.push({ included: true, ...i });
    sort++;
  };

  // Canonical entitlement order (Monthly Base prepended at the end with unshift)
  if (tier.reviews_per_year > 0) {
    push({
      category: "core",
      label: `Review Slots`,
      description: `Available review slots in 12 months. Results not guaranteed. Reviews must be proposed by client.`,
      qty: tier.reviews_per_year,
      unit: "per 12 months",
      unit_price_usd: 0,
    });
  }
  if (tier.ad_banner_sets > 0) {
    push({
      category: "core",
      label: `Display Advertising Banner Sets`,
      description: `Monthly triple banner ad sets (970x250, 300x600, 300x250)`,
      qty: tier.ad_banner_sets,
      unit: "set/month",
      unit_price_usd: 0,
    });
  }
  if (tier.ad_weighting > 0) {
    push({
      category: "core",
      label: `Ad Weighting (Campaign Power) — ${tier.ad_weighting}x`,
      description: `Frequency of appearance of ads relative to others on the site`,
      qty: 1,
      unit: "weighting",
      unit_price_usd: 0,
    });
  }
  push({ category: "core", label: "Unlimited News & PR with Editorial Priority", description: "48hr news cycle on supplied press releases", qty: 1, unit: "ongoing", unit_price_usd: 0 });
  push({ category: "core", label: "Newsletter & Social Media Coverage", description: "Included in regular consumer newsletters and social channels", qty: 1, unit: "ongoing", unit_price_usd: 0 });
  push({ category: "core", label: "Brand & Distributor Pages", description: "Dedicated brand pages with retailer/distributor data, massive SEO benefits", qty: 1, unit: "ongoing", unit_price_usd: 0 });
  push({
    category: "core",
    label: "AI Discoverability & LLM Surfacing",
    description: "Your reviews, news and brand pages are indexed and optimised for retrieval by ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude and other AI assistants. When buyers ask an LLM about your product, StereoNET is one of the sources cited — putting your brand inside the conversation, not just on a results page.",
    qty: 1,
    unit: "ongoing",
    unit_price_usd: 0,
  });
  push({ category: "core", label: "Commercial Classifieds Access", description: "No Seller's Fees for commercial partners", qty: 1, unit: "ongoing", unit_price_usd: 0 });
  push({ category: "core", label: "Exclusive Global Sponsor Forum", description: "Dedicated brand sponsor forum", qty: 1, unit: "ongoing", unit_price_usd: 0 });
  if (tier.additional_discount_pct > 0) {
    push({
      category: "core",
      label: `Additional Advertising Discount — ${tier.additional_discount_pct}%`,
      description: "Override discount applied to all additional ad spend (Wallpapers, EDMs, Newsletters etc.)",
      qty: 1,
      unit: "discount",
      unit_price_usd: 0,
    });
  }
  // Single line item carrying the tier base monthly price
  items.unshift({
    category: "core",
    label: `${tier.label} Tier — Monthly Base`,
    description: `Standard ${tier.label} package monthly subscription`,
    qty: 1,
    unit: "per month",
    unit_price_usd: tier.monthly_usd,
    included: true,
  });
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function genToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function genSlug(clientName: string): string {
  const base = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "client";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

function safeParse<T>(s: any, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function row2prop(r: any) {
  if (!r) return null;
  return {
    ...r,
    levers: safeParse<string[]>(r.levers_json, []),
    competitors: safeParse<string[]>(r.competitors_json, []),
    brands: safeParse<string[]>(r.brands_json, []),
    notify_emails: safeParse<string[]>(r.notify_emails_json, []),
    regions: safeParse<string[]>(r.regions_json, []),
    accounts_contacts: safeParse<{ name: string; email: string }[]>(r.accounts_contacts_json, []),
    additional_recipients: safeParse<{ name: string; email: string }[]>(r.additional_recipients_json, []),
    discount_label_override: r.discount_label_override ?? null,
    proposal_type: (r.proposal_type as string) || "proposal",
    audience_overrides: safeParse<any>(r.audience_overrides_json, null),
  };
}

function getProposalById(id: number) {
  const row = sqlite.prepare(`SELECT * FROM pitch_proposals WHERE id = ?`).get(id);
  return row2prop(row);
}

function getProposalBySlug(slug: string) {
  const row = sqlite.prepare(`SELECT * FROM pitch_proposals WHERE slug = ?`).get(slug);
  return row2prop(row);
}

function getLineItems(proposalId: number) {
  return sqlite.prepare(`SELECT * FROM pitch_line_items WHERE proposal_id = ? ORDER BY sort_order ASC, id ASC`).all(proposalId);
}

function replaceLineItems(proposalId: number, items: LineItem[]) {
  const txn = sqlite.transaction((p: number, list: LineItem[]) => {
    sqlite.prepare(`DELETE FROM pitch_line_items WHERE proposal_id = ?`).run(p);
    const ins = sqlite.prepare(`
      INSERT INTO pitch_line_items
        (proposal_id, sort_order, category, label, description, qty, unit, unit_price_usd, included, notes, is_complimentary, original_unit_price_usd)
      VALUES (@proposal_id, @sort_order, @category, @label, @description, @qty, @unit, @unit_price_usd, @included, @notes, @is_complimentary, @original_unit_price_usd)
    `);
    list.forEach((it, i) => {
      // Complimentary handling: if the line is flagged complimentary, persist
      // the original price so the public view can render it struck-through,
      // and force effective unit_price_usd to 0.
      const compFlag = (it as any).is_complimentary ? 1 : 0;
      const incomingPrice = it.unit_price_usd ?? 0;
      const originalPrice = compFlag
        ? ((it as any).original_unit_price_usd != null ? (it as any).original_unit_price_usd : incomingPrice)
        : null;
      const effectivePrice = compFlag ? 0 : incomingPrice;
      ins.run({
        proposal_id: p,
        sort_order: i,
        category: it.category || "core",
        label: it.label,
        description: it.description ?? null,
        qty: it.qty ?? 1,
        unit: it.unit ?? null,
        unit_price_usd: effectivePrice,
        included: it.included === false ? 0 : 1,
        notes: (it as any).notes ?? null,
        is_complimentary: compFlag,
        original_unit_price_usd: originalPrice,
      });
    });
  });
  txn(proposalId, items);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live audience snapshot from GA4 (cached 60 min)
// ─────────────────────────────────────────────────────────────────────────────

type AudienceSnapshot = {
  period_label: string;
  as_of: string;
  scope: "global" | string[];
  scope_label: string;
  monthly_uniques: number;
  monthly_sessions: number;
  monthly_pageviews: number;
  monthly_uniques_fmt: string;
  monthly_sessions_fmt: string;
  monthly_pageviews_fmt: string;
} | null;

// Cache key includes region scope so different regional proposals don't collide.
const audienceCache: Map<string, { ts: number; data: AudienceSnapshot }> = new Map();

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

let lastAudienceError: string | null = null;
export function getLastAudienceError() { return lastAudienceError; }

const REGION_LABELS_FOR_SCOPE: Record<string, string> = {
  anz: "Australia & New Zealand",
  uk_eu: "UK & Europe",
  na: "North America",
  asia: "Asia",
};

function labelForRegionScope(regions: string[]): string {
  if (regions.length === 0 || regions.length === 4) return "Global";
  return regions.map(r => REGION_LABELS_FOR_SCOPE[r] || r).join(" + ");
}

// Build the GA4 dimensionFilter to INCLUDE only the selected regions' countries.
// Combined with bot exclusion via two separate `andGroup` expressions.
function buildRegionFilter(regions: string[]) {
  if (!regions || regions.length === 0 || regions.length === 4) return undefined;
  const countries = Array.from(new Set(regions.flatMap(r => REGION_COUNTRIES[r] || [])));
  if (countries.length === 0) return undefined;
  return countries;
}

// ─── Pitch insights bundle ──────────────────────────────────────────────────
// Live PULSE data widgets shown on the public proposal:
//   - brand_coverage: editorial coverage of client brand across all tracked sites (90d)
//   - top_queries:    organic Search Console queries containing the brand (90d)
//   - engagement:     GA4 avg session duration etc. (30d) — framed vs industry baseline
//   - yoy_growth:     GA4 30d vs same 30d a year ago
//   - recent_brands:  brands with recently published reviews on StereoNET (30d) — social proof
// Cached for 1h per cache key.
const insightsCache: Map<string, { ts: number; data: any }> = new Map();
export async function getPitchInsights(opts: { client_name: string; competitors: string[] }): Promise<any> {
  const brand = (opts.client_name || "").trim().toLowerCase();
  if (!brand) return null;
  const cacheKey = `${brand}|${[...opts.competitors].sort().join(",")}`;
  const now = Date.now();
  const cached = insightsCache.get(cacheKey);
  if (cached && (now - cached.ts) < 60 * 60 * 1000) return cached.data;

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const end30 = new Date(); end30.setDate(end30.getDate() - 1);
  const start30 = new Date(end30); start30.setDate(start30.getDate() - 29);
  const start90 = new Date(end30); start90.setDate(start90.getDate() - 89);

  // --- 1. Editorial brand coverage across all tracked sites (90d) ---
  let brand_coverage: any[] = [];
  try {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const rows = sqlite.prepare(`
      SELECT site, COUNT(*) AS n
        FROM articles
       WHERE lower(title) LIKE ?
         AND COALESCE(published_at, published_date) >= ?
       GROUP BY site
       ORDER BY n DESC
    `).all(`%${brand}%`, cutoff.toISOString()) as any[];
    brand_coverage = rows;
  } catch (e) { console.warn("[pitch insights] brand_coverage failed:", e); }

  // --- 2. Top organic SC queries containing the brand (90d) ---
  let top_queries: any[] = [];
  let top_queries_total_impressions = 0;
  let top_queries_total_clicks = 0;
  try {
    top_queries = await fetchSCQueriesForBrand(fmt(start90), fmt(end30), brand, 10);
    top_queries_total_impressions = top_queries.reduce((s, r) => s + r.impressions, 0);
    top_queries_total_clicks = top_queries.reduce((s, r) => s + r.clicks, 0);
  } catch (e) { console.warn("[pitch insights] top_queries failed:", e); }

  // --- 3. GA4 engagement (30d) ---
  let engagement: any = null;
  try {
    const o = await fetchGA4Overview(fmt(start30), fmt(end30));
    if (o) {
      const secs = Math.round(o.avgSessionDuration || 0);
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      engagement = {
        avg_session_seconds: secs,
        avg_session_label: `${mins}m ${String(rem).padStart(2, "0")}s`,
        sessions_per_user: o.activeUsers > 0 ? (o.sessions / o.activeUsers) : 0,
        pages_per_session: o.sessions > 0 ? (o.pageviews / o.sessions) : 0,
      };
    }
  } catch (e) { console.warn("[pitch insights] engagement failed:", e); }

  // --- 4. YoY growth (last 30d vs same 30d a year ago) ---
  let yoy_growth: any = null;
  try {
    const lastYearEnd = new Date(end30); lastYearEnd.setFullYear(lastYearEnd.getFullYear() - 1);
    const lastYearStart = new Date(lastYearEnd); lastYearStart.setDate(lastYearStart.getDate() - 29);
    const [cur, prior] = await Promise.all([
      fetchGA4Overview(fmt(start30), fmt(end30)),
      fetchGA4Overview(fmt(lastYearStart), fmt(lastYearEnd)),
    ]);
    if (cur && prior && prior.activeUsers > 0) {
      const usersDelta = ((cur.activeUsers - prior.activeUsers) / prior.activeUsers) * 100;
      const pvDelta = prior.pageviews > 0 ? ((cur.pageviews - prior.pageviews) / prior.pageviews) * 100 : 0;
      yoy_growth = {
        users_pct_change: Math.round(usersDelta * 10) / 10,
        pageviews_pct_change: Math.round(pvDelta * 10) / 10,
        current_users: cur.activeUsers,
        prior_users: prior.activeUsers,
      };
    }
  } catch (e) { console.warn("[pitch insights] yoy_growth failed:", e); }

  // --- 5. StereoNET editorial output in the last 30 days, by content type ---
  // Buckets: news, review, feature, opinion. Each maps from the `content_type`
  // column to one of the four canonical labels.
  let editorial_output: any = null;
  try {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const rows = sqlite.prepare(`
      SELECT content_type, COUNT(*) AS n
        FROM articles
       WHERE site = 'stereonet'
         AND COALESCE(published_at, published_date) >= ?
       GROUP BY content_type
    `).all(cutoff.toISOString()) as any[];
    const buckets = { news: 0, reviews: 0, features: 0, opinion: 0, total: 0 };
    for (const r of rows) {
      const ct = String(r.content_type || "").toLowerCase();
      const n = Number(r.n) || 0;
      buckets.total += n;
      if (/review/.test(ct)) buckets.reviews += n;
      else if (/opinion|editorial|column/.test(ct)) buckets.opinion += n;
      else if (/feature|guide|interview|how-to|long-?form/.test(ct)) buckets.features += n;
      else buckets.news += n; // default bucket
    }
    editorial_output = buckets;
  } catch (e) { console.warn("[pitch insights] editorial_output failed:", e); }

  // --- 6. Forum activity (current totals + 30-day deltas when precise data is available) ---
  // Prefer the *_precise INTEGER columns; the *_text columns are abbreviated (e.g. "601.9k")
  // and too coarse for meaningful month-over-month deltas. Deltas only show when we have
  // precise snapshots from both endpoints AND the delta is plausibly above the rounding noise.
  let forum_activity: any = null;
  try {
    const latest = sqlite.prepare(`SELECT * FROM forum_stats ORDER BY id DESC LIMIT 1`).get() as any;
    if (latest) {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
      const old = sqlite.prepare(`SELECT * FROM forum_stats WHERE fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1`).get(cutoff.toISOString()) as any;

      const topicsNow = latest.total_topics_precise as number | null;
      const postsNow = latest.total_posts_precise as number | null;
      const membersNow = latest.total_members_precise as number | null;
      const topicsThen = old?.total_topics_precise as number | null | undefined;
      const postsThen = old?.total_posts_precise as number | null | undefined;
      const membersThen = old?.total_members_precise as number | null | undefined;

      const computeDelta = (now: number | null | undefined, then: number | null | undefined) => {
        if (now == null || then == null) return null;
        const d = now - then;
        return d >= 0 ? d : null; // negative deltas are likely data noise
      };

      forum_activity = {
        // Current totals (prefer precise int when available, else fall back to abbreviated text)
        total_topics: topicsNow != null ? topicsNow.toLocaleString() : latest.total_topics,
        total_posts: postsNow != null ? postsNow.toLocaleString() : latest.total_posts,
        total_members: membersNow != null ? membersNow.toLocaleString() : (latest.total_members || null),
        // Deltas — only set when both endpoints are precise integers
        new_topics_30d: computeDelta(topicsNow, topicsThen),
        new_posts_30d: computeDelta(postsNow, postsThen),
        new_members_30d: computeDelta(membersNow, membersThen),
        active_ads: latest.active_ads,
        as_of: latest.fetched_at,
      };
    }
  } catch (e) { console.warn("[pitch insights] forum_activity failed:", e); }

  const data = {
    brand,
    brand_coverage,
    top_queries,
    top_queries_total_impressions,
    top_queries_total_clicks,
    engagement,
    yoy_growth,
    editorial_output,
    forum_activity,
  };
  insightsCache.set(cacheKey, { ts: now, data });
  return data;
}

async function getAudienceSnapshot(regions: string[] = []): Promise<AudienceSnapshot> {
  // Normalise scope key for cache: empty/all-four → 'global', else sorted CSV.
  const normalised = (regions.length === 0 || regions.length === 4) ? [] : [...regions].sort();
  const cacheKey = normalised.length === 0 ? "global" : normalised.join(",");
  const now = Date.now();
  const cached = audienceCache.get(cacheKey);
  if (cached && (now - cached.ts) < 60 * 60 * 1000) return cached.data;
  try {
    const end = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - 29);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    // Bigger numbers look better. Do NOT exclude bot countries on the public proposal.
    const includeCountries = buildRegionFilter(normalised);
    console.log(`[pitch] fetching GA4 overview ${fmt(start)} → ${fmt(end)} scope=${cacheKey} include=${includeCountries?.length || 0} (no bot exclusion)`);
    const overview = await fetchGA4Overview(fmt(start), fmt(end), undefined, includeCountries);
    if (!overview) {
      lastAudienceError = "GA4 returned null — see server logs.";
      console.warn("[pitch] GA4 overview returned null");
      return null;
    }
    lastAudienceError = null;
    const data: AudienceSnapshot = {
      period_label: "last 30 days",
      as_of: fmt(end),
      scope: normalised.length === 0 ? "global" : normalised,
      scope_label: labelForRegionScope(normalised),
      monthly_uniques: overview.activeUsers || 0,
      monthly_sessions: overview.sessions || 0,
      monthly_pageviews: overview.pageviews || 0,
      monthly_uniques_fmt: formatCompact(overview.activeUsers || 0),
      monthly_sessions_fmt: formatCompact(overview.sessions || 0),
      monthly_pageviews_fmt: formatCompact(overview.pageviews || 0),
    };
    audienceCache.set(cacheKey, { ts: now, data });
    return data;
  } catch (e: any) {
    lastAudienceError = e?.message || String(e);
    console.error("[pitch] audience snapshot failed:", e);
    return null;
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Access middleware
// ─────────────────────────────────────────────────────────────────────────────

function pitchAccessLevel(req: any): "none" | "view" | "edit" | "admin" {
  const username = req.session?.username;
  if (!username) return "none";
  const row = sqlite.prepare(`SELECT pitch_access, role FROM users WHERE username = ?`).get(username) as any;
  if (!row) return "none";
  // Legacy: existing admin role auto-grants pitch admin
  if (row.role === "admin") return "admin";
  return (row.pitch_access || "none") as any;
}

function requirePitch(min: "view" | "edit" | "admin") {
  const order = { none: 0, view: 1, edit: 2, admin: 3 } as const;
  return (req: any, res: Response, next: NextFunction) => {
    const lvl = pitchAccessLevel(req);
    if (order[lvl] < order[min]) {
      return res.status(403).json({ message: "Insufficient PITCH access" });
    }
    (req as any).pitchAccess = lvl;
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// One-time backfill: insert AI Discoverability into any existing proposal
// line items where it's missing. Idempotent. Only touches drafts and sent
// proposals — leaves accepted/declined/revoked alone.
function backfillAIDiscoverabilityProposals() {
  try {
    const props = sqlite.prepare(`
      SELECT id FROM pitch_proposals
       WHERE status IN ('draft', 'sent', 'viewed', 'expired')
    `).all() as any[];
    for (const p of props) {
      const has = sqlite.prepare(`
        SELECT 1 FROM pitch_line_items WHERE proposal_id = ? AND label LIKE 'AI Discoverability%'
      `).get(p.id);
      if (has) continue;
      const maxSort = (sqlite.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM pitch_line_items WHERE proposal_id = ?`).get(p.id) as any).m;
      sqlite.prepare(`
        INSERT INTO pitch_line_items
          (proposal_id, sort_order, category, label, description, qty, unit, unit_price_usd, included)
        VALUES (?, ?, 'core', 'AI Discoverability & LLM Surfacing',
          'Your reviews, news and brand pages are indexed and optimised for retrieval by ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude and other AI assistants. When buyers ask an LLM about your product, StereoNET is one of the sources cited — putting your brand inside the conversation, not just on a results page.',
          1, 'ongoing', 0, 1)
      `).run(p.id, maxSort + 1);
    }
  } catch (e) { console.error("[pitch] proposal AI backfill failed:", e); }
}

// One-time backfill: insert AI Discoverability into any existing tier templates
// that don't already have it. Idempotent — keyed on the label.
function backfillAIDiscoverabilityItem() {
  try {
    const tiers = sqlite.prepare(`SELECT region, tier_key FROM pitch_tier_templates`).all() as any[];
    for (const t of tiers) {
      const exists = sqlite.prepare(`
        SELECT 1 FROM pitch_tier_template_items
         WHERE region = ? AND tier_key = ? AND label LIKE 'AI Discoverability%'
      `).get(t.region, t.tier_key);
      if (exists) continue;
      const maxSort = (sqlite.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM pitch_tier_template_items WHERE region = ? AND tier_key = ?`).get(t.region, t.tier_key) as any).m;
      sqlite.prepare(`
        INSERT INTO pitch_tier_template_items
          (region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included)
        VALUES (?, ?, ?, 'core', 'AI Discoverability & LLM Surfacing',
          'Your reviews, news and brand pages are indexed and optimised for retrieval by ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude and other AI assistants. When buyers ask an LLM about your product, StereoNET is one of the sources cited — putting your brand inside the conversation, not just on a results page.',
          1, 'ongoing', 0, 1)
      `).run(t.region, t.tier_key, maxSort + 1);
    }
    console.log("[pitch] AI Discoverability backfilled where missing");
  } catch (e) { console.error("[pitch] AI backfill failed:", e); }
}

// Canonical entitlement ordering rule (Monthly Base always first). Items not in
// this list keep their relative order after the matched ones. Idempotent.
const CANONICAL_ENTITLEMENT_ORDER: { match: RegExp; label: string }[] = [
  { match: /^.*Tier\s*—\s*Monthly Base$/i, label: "Monthly Base" },
  { match: /^Review Slots/i, label: "Review Slots" },
  { match: /^Display Advertising Banner Sets/i, label: "Display Advertising Banner Sets" },
  { match: /^Ad Weighting/i, label: "Ad Weighting" },
  { match: /^Unlimited News & PR/i, label: "Unlimited News & PR" },
  { match: /^Newsletter & Social Media/i, label: "Newsletter & Social Media" },
  { match: /^Brand & Distributor Pages/i, label: "Brand & Distributor Pages" },
  { match: /^AI Discoverability/i, label: "AI Discoverability" },
  { match: /^Commercial Classifieds Access/i, label: "Commercial Classifieds Access" },
  { match: /^Exclusive Global Sponsor Forum/i, label: "Exclusive Global Sponsor Forum" },
  { match: /^Additional Advertising Discount/i, label: "Additional Advertising Discount" },
];

function canonicalSortKey(label: string): number {
  for (let i = 0; i < CANONICAL_ENTITLEMENT_ORDER.length; i++) {
    if (CANONICAL_ENTITLEMENT_ORDER[i].match.test(label)) return i;
  }
  return 999; // unknown labels go to the bottom in their existing order
}

// One-time / idempotent: re-sort pitch_tier_template_items into canonical order
// for every (region, tier_key) group. Safe to run on every boot.
function reorderTierTemplateItemsCanonical() {
  try {
    const groups = sqlite.prepare(`SELECT DISTINCT region, tier_key FROM pitch_tier_template_items`).all() as any[];
    const upd = sqlite.prepare(`UPDATE pitch_tier_template_items SET sort_order = ? WHERE id = ?`);
    const txn = sqlite.transaction(() => {
      for (const g of groups) {
        const rows = sqlite.prepare(`SELECT id, label, sort_order FROM pitch_tier_template_items WHERE region = ? AND tier_key = ?`).all(g.region, g.tier_key) as any[];
        rows.sort((a, b) => {
          const ka = canonicalSortKey(a.label);
          const kb = canonicalSortKey(b.label);
          if (ka !== kb) return ka - kb;
          return a.sort_order - b.sort_order; // stable within unknown bucket
        });
        rows.forEach((r, i) => upd.run(i, r.id));
      }
    });
    txn();
  } catch (e) { console.error("[pitch] tier template reorder failed:", e); }
}

// One-time / idempotent: re-sort pitch_line_items for in-flight proposals
// (draft/sent/viewed/expired) into canonical order. Accepted/declined proposals
// are NOT touched — they're frozen records.
function reorderProposalLineItemsCanonical() {
  try {
    const props = sqlite.prepare(`SELECT id FROM pitch_proposals WHERE status IN ('draft', 'sent', 'viewed', 'expired')`).all() as any[];
    const upd = sqlite.prepare(`UPDATE pitch_line_items SET sort_order = ? WHERE id = ?`);
    const txn = sqlite.transaction(() => {
      for (const p of props) {
        const rows = sqlite.prepare(`SELECT id, label, sort_order FROM pitch_line_items WHERE proposal_id = ?`).all(p.id) as any[];
        rows.sort((a, b) => {
          const ka = canonicalSortKey(a.label);
          const kb = canonicalSortKey(b.label);
          if (ka !== kb) return ka - kb;
          return a.sort_order - b.sort_order;
        });
        rows.forEach((r, i) => upd.run(i, r.id));
      }
    });
    txn();
  } catch (e) { console.error("[pitch] proposal line items reorder failed:", e); }
}

// Seed the tier templates table with the hardcoded defaults the first time
// the server boots after the table is created. After that, admin edits win.
function seedTierTemplatesIfEmpty() {
  const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM pitch_tier_templates`).get() as any).n;
  if (count > 0) return;
  const txn = sqlite.transaction(() => {
    TIERS.forEach((t, idx) => {
      sqlite.prepare(`
        INSERT OR IGNORE INTO pitch_tier_templates (region, tier_key, label, sort_order, monthly_usd, description, active)
        VALUES ('global', ?, ?, ?, ?, ?, 1)
      `).run(t.key, t.label, idx, t.monthly_usd, null);
      const items = lineItemsForTier(t.key);
      const ins = sqlite.prepare(`
        INSERT INTO pitch_tier_template_items
          (region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included)
        VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((it, i) => ins.run(
        t.key, i, it.category || "core", it.label, it.description ?? null,
        it.qty ?? 1, it.unit ?? null, it.unit_price_usd ?? 0, it.included === false ? 0 : 1
      ));
    });
  });
  try { txn(); console.log("[pitch] Seeded default tier templates"); }
  catch (e) { console.error("[pitch] seed tier templates failed:", e); }
}

export function registerPitchRoutes(app: Express) {
  seedTierTemplatesIfEmpty();
  backfillAIDiscoverabilityItem();
  backfillAIDiscoverabilityProposals();
  reorderTierTemplateItemsCanonical();
  reorderProposalLineItemsCanonical();
  // Token-gated emergency grant — useful when bootstrap missed a user.
  app.post("/api/admin/diag/pitch-grant", (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const username = (req.body?.username || req.query.username) as string | undefined;
    const level = ((req.body?.level || req.query.level || "admin") as string).toLowerCase();
    if (!username) return res.status(400).json({ message: "username required" });
    if (!["none", "view", "edit", "admin"].includes(level)) return res.status(400).json({ message: "invalid level" });
    const r = sqlite.prepare(`UPDATE users SET pitch_access = ? WHERE username = ?`).run(level, username);
    res.json({ ok: true, updated: r.changes, username, level });
  });

  // Token-gated diag — force-refresh audience snapshot and return it.
  app.get("/api/admin/diag/pitch-audience", async (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    if (req.query.force === "1") audienceCache.clear();
    const regionsParam = req.query.regions as string | undefined;
    const regions = regionsParam ? regionsParam.split(",").filter(Boolean) : [];
    const data = await getAudienceSnapshot(regions);
    res.json({ ok: true, audience: data, last_error: getLastAudienceError() });
  });

  // Token-gated diag — try calling fetchGA4Overview directly with NO bot exclusion
  // so we can isolate whether the country filter is the problem.
  app.get("/api/admin/diag/pitch-ga4-raw", async (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    try {
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - 29);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const raw = await fetchGA4Overview(fmt(start), fmt(end));
      const filtered = await fetchGA4Overview(fmt(start), fmt(end), Array.isArray(BOT_COUNTRIES) ? BOT_COUNTRIES : Array.from(BOT_COUNTRIES as any));
      res.json({
        ok: true,
        date_range: { start: fmt(start), end: fmt(end) },
        bot_countries_count: Array.isArray(BOT_COUNTRIES) ? BOT_COUNTRIES.length : (BOT_COUNTRIES as any).size,
        raw_overview: raw,
        filtered_overview: filtered,
      });
    } catch (e: any) {
      res.json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Token-gated diag — read current pitch_terms_text.
  app.get("/api/admin/diag/pitch-terms", (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    res.json({ ok: true, terms_text: storage.getSetting("pitch_terms_text") || "" });
  });

  // Token-gated diag — overwrite pitch_terms_text. Body: { terms_text: string }
  app.post("/api/admin/diag/pitch-terms", (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const t = req.body?.terms_text;
    if (typeof t !== "string") return res.status(400).json({ message: "terms_text (string) required" });
    storage.setSetting("pitch_terms_text", t);
    res.json({ ok: true, bytes: t.length });
  });

  // Token-gated diag — top SC queries for a brand. ?brand=innuos&days=90
  app.get("/api/admin/diag/pitch-brand-queries", async (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const brand = String(req.query.brand || "").trim();
    if (!brand) return res.status(400).json({ message: "brand= required" });
    const days = Math.min(365, Math.max(7, Number(req.query.days || 90)));
    const end = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const rows = await fetchSCQueriesForBrand(fmt(start), fmt(end), brand, 30);
    const total_clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const total_impressions = rows.reduce((s, r) => s + r.impressions, 0);
    res.json({ ok: true, brand, days, date_range: { start: fmt(start), end: fmt(end) }, total_clicks, total_impressions, queries: rows });
  });

  // Token-gated diag — inspect current pitch_access values.
  app.get("/api/admin/diag/pitch-users", (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const rows = sqlite.prepare(`SELECT id, username, role, pitch_access, last_login FROM users ORDER BY id ASC`).all();
    res.json({ users: rows });
  });

  // List all proposals (filtered to user's access)
  app.get("/api/pitch", requirePitch("view"), (req: any, res) => {
    const lvl = req.pitchAccess;
    const meId = req.session?.username
      ? (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session.username) as any)?.id
      : null;
    const sql = (lvl === "admin" || lvl === "view")
      ? `SELECT * FROM pitch_proposals ORDER BY created_at DESC`
      : `SELECT * FROM pitch_proposals WHERE created_by = ? ORDER BY created_at DESC`;
    const rows = (lvl === "edit" && meId) ? sqlite.prepare(sql).all(meId) : sqlite.prepare(sql).all();
    // Enrich each proposal with view stats from its linked Media Kit share row.
    // Aggregates across all shares for the kit (a kit can have multiple share
    // tokens; for PITCH we only ever issue one but we max() defensively).
    const proposals = (rows as any[]).map(row2prop).map((p: any) => {
      try {
        if (!p.media_kit_id) return p;
        const stats = sqlite.prepare(`
          SELECT
            COALESCE(SUM(view_count), 0) AS view_count,
            MIN(first_viewed_at) AS first_viewed_at,
            MAX(last_viewed_at)  AS last_viewed_at
          FROM media_kit_shares
          WHERE kit_id = ?
        `).get(p.media_kit_id) as any;
        return {
          ...p,
          view_count: Number(stats?.view_count || 0),
          first_viewed_at: stats?.first_viewed_at || null,
          last_viewed_at: stats?.last_viewed_at || null,
        };
      } catch { return p; }
    });
    res.json({ proposals, my_access: lvl });
  });

  // Metadata: tiers for a given region (?region=global|anz|uk_eu|asia|na)
  // GET /api/pitch/:id/views — per-view log for a proposal's linked Media Kit
  // share, enriched with country code via ip-api.com (cached in app_settings).
  // Owner views are already excluded at write-time so this only returns real
  // prospect opens. Limited to last 200 rows.
  app.get("/api/pitch/:id/views", requirePitch("view"), async (req: any, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: "id required" });
    const prop = sqlite.prepare(`SELECT id, media_kit_id FROM pitch_proposals WHERE id = ?`).get(id) as any;
    if (!prop) return res.status(404).json({ message: "Not found" });
    if (!prop.media_kit_id) return res.json({ views: [] });
    const rows = sqlite.prepare(`
      SELECT v.id, v.viewed_at, v.ip, v.user_agent, v.is_bot, v.bot_reason, v.recipient_email
      FROM media_kit_views v
      JOIN media_kit_shares s ON s.id = v.share_id
      WHERE s.kit_id = ?
      ORDER BY v.viewed_at DESC
      LIMIT 200
    `).all(prop.media_kit_id) as any[];

    // Country lookup with persistent cache. app_settings.ip_country_cache is a
    // JSON map {ip: {cc, country, ts}}. Lookups via ip-api.com (free tier:
    // 45 req/min, no key). We only call for IPs not in cache or older than 30d.
    let cache: Record<string, { cc: string; country: string; ts: number }> = {};
    try {
      const raw = (sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'ip_country_cache'`).get() as any)?.value;
      if (raw) cache = JSON.parse(raw);
    } catch {}
    const now = Date.now();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
    const uniqueIps = Array.from(new Set(rows.map(r => r.ip).filter((x): x is string => !!x && x !== "unknown")));
    const toFetch = uniqueIps.filter(ip => !cache[ip] || (now - cache[ip].ts) > maxAgeMs);
    // Skip private / loopback ranges.
    const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc|fd)/i.test(ip);

    await Promise.all(toFetch.slice(0, 30).map(async (ip) => {
      if (isPrivate(ip)) { cache[ip] = { cc: "", country: "Local", ts: now }; return; }
      try {
        const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, { signal: AbortSignal.timeout(3000) });
        const j: any = await r.json().catch(() => ({}));
        if (j?.status === "success") {
          cache[ip] = { cc: String(j.countryCode || ""), country: String(j.country || ""), ts: now };
        } else {
          cache[ip] = { cc: "", country: "", ts: now };
        }
      } catch { cache[ip] = { cc: "", country: "", ts: now }; }
    }));
    try {
      sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('ip_country_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cache));
    } catch {}

    const views = rows.map(r => ({
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

  app.get("/api/pitch/meta", requirePitch("view"), (req, res) => {
    const region = (req.query.region as string) || "global";
    const dbTiers = sqlite.prepare(`SELECT tier_key, label, sort_order, monthly_usd, description, active FROM pitch_tier_templates WHERE region = ? AND active = 1 ORDER BY sort_order ASC`).all(region) as any[];
    res.json({
      region,
      currency: REGION_CURRENCY[region] || "USD",
      tiers: dbTiers.length > 0
        ? dbTiers.map(t => ({ key: t.tier_key, label: t.label, monthly_usd: t.monthly_usd, description: t.description }))
        : (region === "global" ? TIERS : []),
      bolt_ons: BOLT_ONS,
      source: dbTiers.length > 0 ? "db" : (region === "global" ? "hardcoded" : "empty"),
    });
  });

  // ────────── Tier templates CRUD (admin) ──────────

  // ─── Global tier inclusion rows ─────────────────────────────────────
  // The public media-kit Your Investment table renders a fixed list of inclusion
  // rows (keys: banners, ad_weighting, news_pr, etc.). This endpoint exposes
  // those rows for reordering. Order persists in app_settings:
  //   - pitch_inclusion_order          (trade audience — EXISTING, unchanged)
  //   - pitch_inclusion_order_retailer (retailer audience — new)
  // The audience-specific row catalogue lives in INCLUSION_ROWS_BY_AUDIENCE.
  const INCLUSION_ROWS = [
    { key: "banners",                 label: "Display Advertising Banner Sets" },
    { key: "ad_weighting",            label: "Ad Weighting (Campaign Power)" },
    { key: "news_pr",                 label: "Unlimited News & PR with Editorial Priority" },
    { key: "newsletter_social",      label: "Newsletter & Social Media Coverage" },
    { key: "reviews_per_year",        label: "Review Slots (per 12 months)" },
    { key: "brand_distributor_pages", label: "Brand & Distributor Pages" },
    { key: "exclusive_forum",         label: "Exclusive Global Sponsor Forum" },
    { key: "classifieds_access",      label: "Commercial Classifieds Access" },
    { key: "ai_discoverability",      label: "AI Discoverability & LLM Surfacing" },
    { key: "discount_pct",            label: "Additional Advertising Discount" },
  ];
  // Mirrors the retailer rows in client/src/pages/MediaKitPublic.tsx.
  const RETAILER_INCLUSION_ROWS = [
    { key: "store_listed",            label: "Your store listed in Find a Store page" },
    { key: "forum_access",            label: "Global Commercial Forum Access" },
    { key: "sponsor_forum",           label: "Your very own Retailer Sponsor Forum" },
    { key: "competitions",            label: "Competitions & Giveaways" },
    { key: "event_coverage",          label: "Event Coverage & Promotion" },
    { key: "display_banners",         label: "Display Advertising Banners" },
    { key: "classifieds_access",      label: "Commercial Classifieds Access" },
    { key: "discount_pct",            label: "Additional Advertising Discount" },
    { key: "ai_discoverability",      label: "AI Discoverability & LLM Surfacing" },
    { key: "newsletter_social",      label: "Newsletter & Social Media Coverage" },
  ];
  const settingKeyForAudience = (audience: string) =>
    audience === "retailer" ? "pitch_inclusion_order_retailer" : "pitch_inclusion_order";
  const rowsForAudience = (audience: string) =>
    audience === "retailer" ? RETAILER_INCLUSION_ROWS : INCLUSION_ROWS;

  /* Legacy per-tier-row endpoint kept below for diagnostic, but no longer used by the UI. */
  // GET returns the inclusion row order for the requested audience.
  // ?audience=retailer for retailer rows; default = trade.
  app.get("/api/pitch/inclusion-order", requirePitch("view"), (req: any, res) => {
    const audience = String(req.query?.audience || "trade").toLowerCase();
    const rows = rowsForAudience(audience);
    const saved = storage.getSetting(settingKeyForAudience(audience));
    let order: string[] = [];
    if (saved) {
      try { const parsed = JSON.parse(saved); if (Array.isArray(parsed)) order = parsed.filter(x => typeof x === "string"); } catch {}
    }
    const known = new Map(rows.map(r => [r.key, r.label]));
    const seen = new Set<string>();
    const list: { key: string; label: string }[] = [];
    for (const k of order) {
      if (known.has(k) && !seen.has(k)) { list.push({ key: k, label: known.get(k)! }); seen.add(k); }
    }
    for (const r of rows) {
      if (!seen.has(r.key)) list.push(r);
    }
    res.json({ inclusions: list, audience });
  });
  app.put("/api/pitch/inclusion-order", requirePitch("admin"), (req: any, res) => {
    const audience = String(req.body?.audience || req.query?.audience || "trade").toLowerCase();
    const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys.filter((x: any) => typeof x === "string") : [];
    if (!keys.length) return res.status(400).json({ message: "keys[] required" });
    storage.setSetting(settingKeyForAudience(audience), JSON.stringify(keys));
    res.json({ ok: true, audience, keys });
  });
  // Public read — used by the public kit viewer with no auth.
  app.get("/api/public/inclusion-order", (req: any, res) => {
    const audience = String(req.query?.audience || "trade").toLowerCase();
    const saved = storage.getSetting(settingKeyForAudience(audience));
    let order: string[] = [];
    if (saved) {
      try { const parsed = JSON.parse(saved); if (Array.isArray(parsed)) order = parsed.filter(x => typeof x === "string"); } catch {}
    }
    res.json({ order, audience });
  });

  app.get("/api/pitch/tier-templates/inclusions", requirePitch("view"), (_req, res) => {
    const rows = sqlite.prepare(
      `SELECT tier_key, label, sort_order, category, qty, unit, included
       FROM pitch_tier_template_items WHERE region = 'global'
       ORDER BY sort_order, label`
    ).all() as any[];
    // Normalise label: strip trailing "— <value>" so variant rows collapse into one logical row.
    // Also exclude tier-base rows ("Bronze Tier — Monthly Base" etc).
    const normalise = (label: string) => label.replace(/\s*[—–\-]\s*[^—–\-]+$/, "").trim();
    const isBase = (label: string) => /Tier\s*[—–\-]\s*Monthly Base/i.test(label);
    const variantSuffix = (label: string) => { const m = label.match(/[—–\-]\s*(.+)$/); return m ? m[1].trim() : null; };

    const byLabel = new Map<string, { label: string; sort_order: number; tiers: Record<string, any> }>();
    for (const r of rows) {
      if (isBase(r.label)) continue;
      const norm = normalise(r.label);
      const variant = variantSuffix(r.label); // e.g. "0.5x", "5%" or null if base label
      const g = byLabel.get(norm);
      const tierVal = { qty: r.qty, unit: r.unit, included: r.included, variant };
      if (g) {
        g.sort_order = Math.min(g.sort_order, r.sort_order);
        g.tiers[r.tier_key] = tierVal;
      } else {
        byLabel.set(norm, { label: norm, sort_order: r.sort_order, tiers: { [r.tier_key]: tierVal } });
      }
    }
    const inclusions = Array.from(byLabel.values()).sort((a, b) => a.sort_order - b.sort_order);
    res.json({ inclusions });
  });

  // PATCH /api/pitch/tier-templates/inclusions/reorder — body { labels: string[] } in desired order.
  // Rewrites sort_order on ALL rows (every tier_key) with the matching label, for region='global'.
  app.patch("/api/pitch/tier-templates/inclusions/reorder", requirePitch("admin"), (req, res) => {
    // Body: { labels: string[] } — normalised inclusion labels in desired order.
    // We match by LIKE so all per-tier variants (e.g. "Ad Weighting — 0.5x", "Ad Weighting — 1x") update together.
    const labels: string[] = Array.isArray(req.body?.labels) ? req.body.labels.filter((x: any) => typeof x === "string") : [];
    if (labels.length === 0) return res.status(400).json({ message: "labels[] required" });
    const updExact = sqlite.prepare(`UPDATE pitch_tier_template_items SET sort_order = ? WHERE region = 'global' AND label = ?`);
    const updLike = sqlite.prepare(`UPDATE pitch_tier_template_items SET sort_order = ? WHERE region = 'global' AND (label = ? OR label LIKE ?)`);
    const txn = sqlite.transaction((arr: string[]) => {
      arr.forEach((label, i) => {
        const sort = (i + 1) * 10;
        const likePattern = label + " — %";
        const likePatternDash = label + " - %";
        const r1 = updLike.run(sort, label, likePattern);
        // Also catch hyphen variants if em-dash didn't match
        if (r1.changes === 0) updExact.run(sort, label);
        // And ensure dash separator covered
        sqlite.prepare(`UPDATE pitch_tier_template_items SET sort_order = ? WHERE region = 'global' AND label LIKE ?`).run(sort, likePatternDash);
      });
    });
    try { txn(labels); res.json({ ok: true, updated: labels.length }); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/pitch/tiers", requirePitch("view"), (req, res) => {
    const region = (req.query.region as string) || "global";
    const tiers = sqlite.prepare(`SELECT * FROM pitch_tier_templates WHERE region = ? ORDER BY sort_order ASC`).all(region);
    const itemsByTier: Record<string, any[]> = {};
    for (const t of tiers as any[]) {
      itemsByTier[t.tier_key] = sqlite.prepare(`
        SELECT id, category, label, description, qty, unit, unit_price_usd, included, sort_order
          FROM pitch_tier_template_items WHERE tier_key = ? AND region = ?
          ORDER BY sort_order ASC, id ASC
      `).all(t.tier_key, region);
    }
    res.json({ region, currency: REGION_CURRENCY[region] || "USD", tiers, items: itemsByTier });
  });

  // Upsert tier (admin) — region-scoped, also replaces line items in one transaction
  app.post("/api/pitch/tiers/:tier_key", requirePitch("admin"), (req, res) => {
    const tier_key = req.params.tier_key;
    const region = (req.query.region as string) || (req.body?.region) || "global";
    const b = req.body || {};
    const txn = sqlite.transaction(() => {
      sqlite.prepare(`
        INSERT INTO pitch_tier_templates (region, tier_key, label, sort_order, monthly_usd, description, active, updated_at)
        VALUES (@region, @tier_key, @label, @sort_order, @monthly_usd, @description, @active, datetime('now'))
        ON CONFLICT(region, tier_key) DO UPDATE SET
          label = excluded.label,
          sort_order = excluded.sort_order,
          monthly_usd = excluded.monthly_usd,
          description = excluded.description,
          active = excluded.active,
          updated_at = datetime('now')
      `).run({
        region,
        tier_key,
        label: b.label || tier_key,
        sort_order: b.sort_order ?? 0,
        monthly_usd: b.monthly_usd ?? 0,
        description: b.description ?? null,
        active: b.active === false ? 0 : 1,
      });
      if (Array.isArray(b.items)) {
        sqlite.prepare(`DELETE FROM pitch_tier_template_items WHERE tier_key = ? AND region = ?`).run(tier_key, region);
        const ins = sqlite.prepare(`
          INSERT INTO pitch_tier_template_items
            (region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included)
          VALUES (@region, @tier_key, @sort_order, @category, @label, @description, @qty, @unit, @unit_price_usd, @included)
        `);
        b.items.forEach((it: any, i: number) => ins.run({
          region,
          tier_key,
          sort_order: i,
          category: it.category || "core",
          label: it.label || "",
          description: it.description ?? null,
          qty: it.qty ?? 1,
          unit: it.unit ?? null,
          unit_price_usd: it.unit_price_usd ?? 0,
          included: it.included === false ? 0 : 1,
        }));
      }
    });
    txn();
    res.json({ ok: true });
  });

  app.delete("/api/pitch/tiers/:tier_key", requirePitch("admin"), (req, res) => {
    const region = (req.query.region as string) || "global";
    sqlite.prepare(`DELETE FROM pitch_tier_templates WHERE tier_key = ? AND region = ?`).run(req.params.tier_key, region);
    res.json({ ok: true });
  });

  // Reload a proposal's line items from the current tier template (admin or owner).
  // Wipes existing line items and re-seeds. Used when the user changes base_tier.
  app.post("/api/pitch/:id/reload-tier", requirePitch("edit"), (req: any, res) => {
    const id = Number(req.params.id);
    const tier = (req.body?.base_tier as string) || "";
    if (!tier) return res.status(400).json({ message: "base_tier required" });
    const existing = getProposalById(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (req.pitchAccess !== "admin") {
      const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session.username) as any)?.id;
      if (existing.created_by !== meId) return res.status(403).json({ message: "Not your proposal" });
    }
    const tierRegion = pickTierRegion(existing.regions || []);
    const items = lineItemsForTierFromDB(tier, tierRegion) || lineItemsForTier(tier);
    replaceLineItems(id, items);
    sqlite.prepare(`UPDATE pitch_proposals SET base_tier = ?, updated_at = datetime('now') WHERE id = ?`).run(tier, id);
    res.json({ ok: true, proposal: getProposalById(id), line_items: getLineItems(id) });
  });

  // Create proposal (wizard output)
  // ─── Pitch → Media Kit unification helper ──────────────────────────────
  // Phase A of the PITCH ↔ Media Kit unification: when the wizard creates a
  // proposal we ALSO clone the right regional Media Kit, stamp a fully populated
  // proposal block onto it, and mint a share token. The wizard still returns
  // and stores the proposal row exactly as before — we just additionally create
  // a Media-Kit-flavoured viewing surface alongside the existing /pitch/ URL.
  // The kit + share IDs are persisted on the proposal row so the Proposals
  // list can deep-link / copy the magic link.
  function createKitFromProposal(proposalRow: any, lineItems: any[], tierRegion: string): { kit_id: number; share_id: number; share_slug: string; magic_token: string; magic_link: string } | null {
    try {
      // 1. Resolve source kit by tierRegion. "global" → canonical Trade.
      let parentKitId: number | null = null;
      if (tierRegion && tierRegion !== "global") {
        const regional = sqlite.prepare(`SELECT id FROM media_kits WHERE region = ? AND kind = 'trade' AND prospect_lead_id IS NULL AND status = 'published' LIMIT 1`).get(tierRegion) as any;
        if (regional) parentKitId = regional.id;
      }
      if (!parentKitId) {
        const canon = sqlite.prepare(`SELECT id FROM media_kits WHERE kind = 'trade' AND is_canonical = 1 LIMIT 1`).get() as any;
        if (canon) parentKitId = canon.id;
      }
      if (!parentKitId) { console.error("[pitch→kit] no parent kit"); return null; }
      const parent = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(parentKitId) as any;
      if (!parent) return null;

      // 2. Compute totals. Casual proposals total one-off line items only;
      //    regular proposals compute monthly base × contract length.
      const proposalTypeCreate = (proposalRow.proposal_type as string) || "proposal";
      const isCasualCreate = proposalTypeCreate === "casual";
      const monthly = (lineItems || []).reduce((sum: number, li: any) => {
        if (!li.included) return sum;
        const qty = Number(li.qty) || 0;
        const price = Number(li.unit_price_usd) || 0;
        const isMonthly = !li.unit || /month|ongoing|recurring/i.test(li.unit);
        return sum + (isMonthly ? qty * price : 0);
      }, 0);
      const oneOffSubtotalCreate = isCasualCreate
        ? (lineItems || []).reduce((sum: number, li: any) => {
            if (!li.included) return sum;
            return sum + (Number(li.qty) || 0) * (Number(li.unit_price_usd) || 0);
          }, 0)
        : 0;
      const discountPct = Number(proposalRow.override_discount_pct) || 0;
      const afterDiscount = monthly * (1 - discountPct / 100);
      const months = Number(proposalRow.contract_months) || 6;
      const contractTotal = isCasualCreate
        ? oneOffSubtotalCreate * (1 - discountPct / 100)
        : afterDiscount * months;
      const currency = proposalRow.currency || "USD";

      // 3. Create the kit clone. slug shape mirrors the leads customise-kit one for consistency.
      const safeCompany = String(proposalRow.client_name || "prospect").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "prospect";
      const kitSlug = `proposal-${proposalRow.id}-${safeCompany}-${Math.random().toString(36).slice(2, 7)}`;
      const kitLabel = `${parent.label} — ${proposalRow.client_name}`;
      const cloneInsert = sqlite.prepare(`
        INSERT INTO media_kits (slug, kind, region, is_canonical, parent_kit_id, label, subtitle, version_quarter, status, base_currency, tax_suffix, intro_text)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(
        kitSlug, parent.kind, parent.region, parent.id,
        kitLabel, parent.subtitle, parent.version_quarter,
        currency, parent.tax_suffix, parent.intro_text
      );
      const cloneId = Number(cloneInsert.lastInsertRowid);

      // 4. Stamp the proposal block on the clone with everything the viewer needs.
      // Region-scope labels are computed once here and again in restampKitFromProposal
      // so that prospects always see whether the campaign is Global or scoped.
      const REGION_LABELS_LOCAL: Record<string, string> = { anz: "Australia & NZ", na: "North America", "uk-eu": "UK & Europe", asia: "Southeast Asia" };
      const proposalRegions: string[] = Array.isArray(proposalRow.regions) ? proposalRow.regions : [];
      const isGlobalCreate = proposalRegions.length === 0 || proposalRegions.length === 4;
      const regionsScopeLabelCreate = isGlobalCreate ? "Global — all four regions" : proposalRegions.map((r: string) => REGION_LABELS_LOCAL[r] || r).join(" + ");
      const regionLabelsCreate = isGlobalCreate ? ["Australia & NZ", "North America", "UK & Europe", "Southeast Asia"] : proposalRegions.map((r: string) => REGION_LABELS_LOCAL[r] || r);
      const proposalBlock = {
        proposal_type: proposalTypeCreate,
        prepared_for: proposalRow.client_name,
        client_logo_url: proposalRow.client_logo_url || null,
        subtitle: proposalRow.intro_text || "",
        tier: isCasualCreate ? null : proposalRow.base_tier,
        contract_months: isCasualCreate ? null : months,
        proposed_start_date: proposalRow.proposed_start_date || null,
        monthly_subtotal: isCasualCreate ? 0 : Number(monthly.toFixed(2)),
        one_off_subtotal: isCasualCreate ? Number(oneOffSubtotalCreate.toFixed(2)) : 0,
        discount_pct: discountPct,
        monthly_total: isCasualCreate ? 0 : Number(afterDiscount.toFixed(2)),
        contract_total: Number(contractTotal.toFixed(2)),
        total_currency: currency,
        total_value: Number(contractTotal.toFixed(2)),
        total_period: isCasualCreate ? "one_off" : "month",
        regions_scope_label: regionsScopeLabelCreate,
        region_labels: regionLabelsCreate,
        is_global: isGlobalCreate,
        summary_line: isCasualCreate
          ? `Casual / Ad-hoc · ${currency} · ${regionsScopeLabelCreate}`
          : `${String(proposalRow.base_tier || "").toUpperCase()} · ${months} months · ${currency} · ${regionsScopeLabelCreate}`,
        discount_label_text: (proposalRow.discount_label_override && String(proposalRow.discount_label_override).trim())
          || (sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'pitch_discount_label_text'`).get() as any)?.value
          || "Partnership discount applied",
        valid_until: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
        notes: "",
        // Snapshot the line items so the Media Kit can render them without re-querying pitch_proposals.
        // Casual items are one-off (no pro-rate); regular items pro-rate to contract length.
        line_items_snapshot: (lineItems || []).filter((li: any) => li.included).map((li: any) =>
          isCasualCreate
            ? {
                category: li.category,
                label: li.label,
                description: li.description,
                qty: li.qty,
                unit: li.unit,
                unit_price: li.unit_price_usd,
                is_complimentary: !!li.is_complimentary,
                original_unit_price: li.original_unit_price_usd ?? null,
              }
            : proRateLineItem(li, months)
        ),
      };
      sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'proposal', 0, 1, 1, ?, datetime('now'))`).run(cloneId, JSON.stringify(proposalBlock));

      // Snapshot current tier prices into an investment block override so the
      // "Standard Rates" comparison table on this kit stays frozen at today's
      // catalog values — future catalog edits won't appear to retroactively
      // change the rates this prospect was quoted against.
      //
      // Source the prices from the SAME region as the kit (anz/uk_eu/asia/global)
      // so a regional proposal shows regional standard rates — not Global USD.
      try {
        const freezeRegionClause = tierRegion && tierRegion !== "global"
          ? `region = '${tierRegion}'`
          : `region IS NULL`;
        const tierRows = sqlite.prepare(
          `SELECT addon_key, price_value FROM media_kit_addons WHERE kind = 'tier' AND ${freezeRegionClause} AND price_value IS NOT NULL`
        ).all() as any[];
        const frozen: Record<string, number> = {};
        for (const t of tierRows) { frozen[t.addon_key] = Number(t.price_value); }
        if (Object.keys(frozen).length > 0) {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'investment', 0, 1, 1, ?, datetime('now'))`).run(cloneId, JSON.stringify({ frozen_tier_prices: frozen }));
        }
      } catch (e) { console.warn("[pitch→kit] tier price freeze failed:", e); }

      // 5. Mint the share. proposal_state starts as 'draft' — only the explicit
      //    Send + Copy Link action promotes it to 'sent' and triggers the
      //    first-view notification email. Previously we set 'sent' on create,
      //    which meant the owner's own preview opens would flip to 'viewed'
      //    and look like the prospect had read it.
      const shareSlug = `${safeCompany}-${Math.random().toString(36).slice(2, 8)}`;
      const token = require("node:crypto").randomBytes(24).toString("base64url").slice(0, 24);
      const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
      const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(proposalRow.created_by_username) as any)?.id || proposalRow.created_by || null;
      const shareInsert = sqlite.prepare(`
        INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, expires_at, created_by, proposal_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `).run(cloneId, shareSlug, token, proposalRow.client_contact_name || proposalRow.client_name, proposalRow.client_contact_email || null, proposalRow.client_name, expiry, meId);
      const shareId = Number(shareInsert.lastInsertRowid);
      return { kit_id: cloneId, share_id: shareId, share_slug: shareSlug, magic_token: token, magic_link: `https://dashboard.stereonet.com/kit/${shareSlug}?t=${token}` };
    } catch (e) {
      console.error("[pitch→kit] clone failed:", e);
      return null;
    }
  }

  // Re-stamp the linked Media Kit clone's proposal block + base_currency to
  // reflect the latest pitch_proposals values. Called from PATCH /api/pitch/:id
  // and POST /api/pitch/:id/send so edits made after the initial save (discount,
  // logo, intro, line item changes) actually propagate to the public /kit/ view.
  function restampKitFromProposal(proposalId: number, opts: { force?: boolean } = {}): { restamped: boolean } {
    try {
      const prop = sqlite.prepare(`SELECT * FROM pitch_proposals WHERE id = ?`).get(proposalId) as any;
      if (!prop || !prop.media_kit_id) return { restamped: false };
      // Never re-stamp sent proposals unless explicitly forced.
      if (prop.status === 'sent' && !opts.force) return { restamped: false };
      const items = sqlite.prepare(`SELECT * FROM pitch_line_items WHERE proposal_id = ? ORDER BY sort_order ASC, id ASC`).all(proposalId) as any[];
      const monthly = items.reduce((sum: number, li: any) => {
        if (!li.included) return sum;
        const qty = Number(li.qty) || 0;
        const price = Number(li.unit_price_usd) || 0;
        const isMonthly = !li.unit || /month|ongoing|recurring/i.test(li.unit);
        return sum + (isMonthly ? qty * price : 0);
      }, 0);
      const discountPct = Number(prop.override_discount_pct) || 0;
      const afterDiscount = monthly * (1 - discountPct / 100);
      const months = Number(prop.contract_months) || 6;
      const contractTotal = afterDiscount * months;
      const currency = prop.currency || "USD";
      // Read existing block so we preserve fields we don't manage (e.g. notes that may be edited downstream).
      const existingBlock = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'proposal'`).get(prop.media_kit_id) as any;
      let existing: any = {};
      try { existing = existingBlock ? JSON.parse(existingBlock.content_json) : {}; } catch { existing = {}; }
      const proposalBlock = {
        ...existing,
        prepared_for: prop.client_name,
        client_logo_url: prop.client_logo_url || null,
        subtitle: prop.intro_text || "",
        tier: prop.base_tier,
        contract_months: months,
        proposed_start_date: prop.proposed_start_date || null,
        monthly_subtotal: Number(monthly.toFixed(2)),
        discount_pct: discountPct,
        monthly_total: Number(afterDiscount.toFixed(2)),
        contract_total: Number(contractTotal.toFixed(2)),
        total_currency: currency,
        total_value: Number(afterDiscount.toFixed(2)),
        total_period: "month",
        summary_line: `${String(prop.base_tier || "").toUpperCase()} · ${months} months · ${currency}`,
        line_items_snapshot: items.filter((li: any) => li.included).map((li: any) => proRateLineItem(li, months)),
      };
      const json = JSON.stringify(proposalBlock);
      if (existingBlock) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE kit_id = ? AND block_key = 'proposal'`).run(json, prop.media_kit_id);
      } else {
        sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'proposal', 0, 1, 1, ?, datetime('now'))`).run(prop.media_kit_id, json);
      }
      // Also keep the kit's base_currency in step with the proposal currency.
      sqlite.prepare(`UPDATE media_kits SET base_currency = ?, updated_at = datetime('now') WHERE id = ?`).run(currency, prop.media_kit_id);
      return { restamped: true };
    } catch (e) {
      console.error("[pitch→kit] restamp failed:", e);
      return { restamped: false };
    }
  }

  // New Retailer proposal — much simpler than the trade PitchWizard.
  // Creates a synthetic Inbound Lead + a Retailer prospect kit clone in one shot,
  // returns the kit_id and magic_link so the client can open the editor.
  app.post("/api/pitch/retailer-kit", requirePitch("edit"), (req: any, res) => {
    const body = req.body || {};
    const name = String(body.client_contact_name || body.name || "").trim();
    const email = String(body.client_contact_email || body.email || "").trim();
    const company = String(body.client_name || body.company || "").trim();
    const note = String(body.intro_text || body.note || "").trim();
    if (!company) return res.status(400).json({ message: "Company name is required" });
    if (!email) return res.status(400).json({ message: "Contact email is required" });

    // 1. Find retailer master kit (global)
    const retailerMaster = sqlite.prepare(`SELECT * FROM media_kits WHERE kind = 'retailer' AND prospect_lead_id IS NULL ORDER BY is_canonical DESC, id ASC LIMIT 1`).get() as any;
    if (!retailerMaster) return res.status(500).json({ message: "Retailer master kit not found. Create one first under Media Kits." });

    try {
      // 2. Create a synthetic Inbound Lead so this prospect shows in the Leads tab
      const leadInsert = sqlite.prepare(`
        INSERT INTO pitch_inbound_leads (source, name, email, company, company_type, region, message, status, created_at, updated_at)
        VALUES ('manual', ?, ?, ?, 'retailer', 'global', ?, 'new', datetime('now'), datetime('now'))
      `).run(name || null, email, company, note || null);
      const leadId = Number(leadInsert.lastInsertRowid);

      // 3. Clone the retailer master
      const safeCompany = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "prospect";
      const cloneSlug = `prospect-${leadId}-${safeCompany}-${Math.random().toString(36).slice(2, 7)}`;
      const cloneLabel = `${retailerMaster.label} \u2014 ${company}`;
      const cloneInsert = sqlite.prepare(`
        INSERT INTO media_kits (slug, kind, region, is_canonical, parent_kit_id, label, subtitle, version_quarter, status, base_currency, tax_suffix, intro_text, prospect_lead_id)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
      `).run(
        cloneSlug, retailerMaster.kind, retailerMaster.region, retailerMaster.id,
        cloneLabel, retailerMaster.subtitle, retailerMaster.version_quarter,
        retailerMaster.base_currency, retailerMaster.tax_suffix, retailerMaster.intro_text,
        leadId
      );
      const kitId = Number(cloneInsert.lastInsertRowid);

      // 4. Insert a default proposal block on the clone
      const proposalContent = {
        prepared_for: company,
        subtitle: "",
        total_value: null,
        total_currency: retailerMaster.base_currency || "USD",
        total_period: "",
        summary_line: "",
        valid_until: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
        notes: note || "",
      };
      sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'proposal', 0, 1, 1, ?, datetime('now'))`).run(kitId, JSON.stringify(proposalContent));

      // 5. Mint a share + magic link for the prospect
      const shareSlug = `${safeCompany}-${Math.random().toString(36).slice(2, 8)}`;
      const magicToken = require("node:crypto").randomBytes(24).toString("base64url").slice(0, 24);
      const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
      const shareInsert = sqlite.prepare(`
        INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(kitId, shareSlug, magicToken, name || null, email, company, expiry);
      const shareId = Number(shareInsert.lastInsertRowid);

      // 6. Point the lead at the share
      sqlite.prepare(`UPDATE pitch_inbound_leads SET kit_share_id = ?, updated_at = datetime('now') WHERE id = ?`).run(shareId, leadId);

      return res.json({
        ok: true,
        kit_id: kitId,
        lead_id: leadId,
        share_slug: shareSlug,
        magic_token: magicToken,
        magic_link: `https://dashboard.stereonet.com/kit/${shareSlug}?t=${magicToken}`,
      });
    } catch (e: any) {
      console.error("[pitch] retailer-kit create failed:", e);
      return res.status(500).json({ message: e?.message || "Failed to create retailer kit" });
    }
  });

  app.post("/api/pitch", requirePitch("edit"), (req: any, res) => {
    const body = req.body || {};
    const required = ["client_name", "base_tier"];
    for (const k of required) {
      if (!body[k]) return res.status(400).json({ message: `Missing ${k}` });
    }
    const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session.username) as any)?.id ?? null;
    const slug = body.slug || genSlug(body.client_name);
    const magic_token = genToken(24);
    const expiresAt = body.expires_at || (() => {
      const expDaysRaw = storage.getSetting("pitch_default_expiry_days");
      const days = expDaysRaw ? Number(expDaysRaw) : 30;
      const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString();
    })();
    const result = sqlite.prepare(`
      INSERT INTO pitch_proposals (
        slug, magic_token, client_name, client_logo_url, client_contact_name,
        client_contact_email, client_region, base_tier, currency, fx_rate_to_usd, fx_rate_date,
        contract_months, override_discount_pct, pricing_posture, levers_json,
        target_monthly_usd, intro_text, competitors_json, brands_json, notify_emails_json,
        status, expires_at, created_by
      ) VALUES (
        @slug, @magic_token, @client_name, @client_logo_url, @client_contact_name,
        @client_contact_email, @client_region, @base_tier, @currency, @fx_rate_to_usd, @fx_rate_date,
        @contract_months, @override_discount_pct, @pricing_posture, @levers_json,
        @target_monthly_usd, @intro_text, @competitors_json, @brands_json, @notify_emails_json,
        'draft', @expires_at, @created_by
      )
    `).run({
      slug,
      magic_token,
      client_name: body.client_name,
      client_logo_url: body.client_logo_url ?? null,
      client_contact_name: body.client_contact_name ?? null,
      client_contact_email: body.client_contact_email ?? null,
      client_region: body.client_region ?? null,
      base_tier: body.base_tier,
      currency: body.currency || "USD",
      fx_rate_to_usd: body.fx_rate_to_usd ?? 1.0,
      fx_rate_date: body.fx_rate_date ?? new Date().toISOString().slice(0, 10),
      contract_months: body.contract_months ?? 6,
      override_discount_pct: body.override_discount_pct ?? 0,
      pricing_posture: body.pricing_posture ?? null,
      levers_json: JSON.stringify(body.levers || []),
      target_monthly_usd: body.target_monthly_usd ?? null,
      intro_text: body.intro_text ?? null,
      competitors_json: JSON.stringify(body.competitors || []),
      brands_json: JSON.stringify(body.brands || []),
      notify_emails_json: JSON.stringify(body.notify_emails || []),
      expires_at: expiresAt,
      created_by: meId,
    });
    // Set the additive columns (regions, billing, accounts contacts, start date,
    // proposal_type) in a follow-up update so existing INSERT stays stable.
    const proposalType = body.proposal_type === "casual" ? "casual" : "proposal";
    sqlite.prepare(`UPDATE pitch_proposals SET
        regions_json = ?, billing_company_name = ?, billing_address = ?,
        accounts_contacts_json = ?, audience_overrides_json = ?, proposed_start_date = ?,
        proposal_type = ?
      WHERE slug = ?
    `).run(
      JSON.stringify(body.regions || []),
      body.billing_company_name ?? null,
      body.billing_address ?? null,
      JSON.stringify(body.accounts_contacts || []),
      body.audience_overrides ? JSON.stringify(body.audience_overrides) : null,
      body.proposed_start_date ?? null,
      proposalType,
      slug
    );
    const id = Number(result.lastInsertRowid);

    // Determine the region for tier sourcing. If the proposal targets a single
    // region with its own tier set, use that region's prices + currency. Else, global.
    // Defensive: if regions[] wasn't narrowed by the wizard but client_region
    // specifies a regional focus, honour that so we don't accidentally parent
    // the kit clone from canonical Global when the client is e.g. ANZ.
    const wizardToProposalRegion: Record<string, string> = { "uk-eu": "uk_eu", "na": "na", "anz": "anz", "sea": "asia" };
    let effectiveRegions = Array.isArray(body.regions) ? [...body.regions] : [];
    if ((effectiveRegions.length === 0 || effectiveRegions.length === 4) && body.client_region && wizardToProposalRegion[body.client_region]) {
      effectiveRegions = [wizardToProposalRegion[body.client_region]];
      // Persist the narrowed list so PATCH/restamp see the same single-region targeting.
      try { sqlite.prepare(`UPDATE pitch_proposals SET regions_json = ? WHERE id = ?`).run(JSON.stringify(effectiveRegions), id); } catch {}
    }
    const tierRegion = pickTierRegion(effectiveRegions);
    const tierCurrency = REGION_CURRENCY[tierRegion] || "USD";
    // Override currency on the proposal if the wizard didn't explicitly set one
    if (!body.currency || body.currency === "USD") {
      sqlite.prepare(`UPDATE pitch_proposals SET currency = ? WHERE id = ?`).run(tierCurrency, id);
    }
    // Seed line items. Casual proposals start EMPTY — the admin picks bolt-ons.
    // Regular proposals seed from region-scoped tier template (else fallback).
    const items: LineItem[] = proposalType === "casual"
      ? (Array.isArray(body.line_items) ? body.line_items : [])
      : (Array.isArray(body.line_items) && body.line_items.length
          ? body.line_items
          : (lineItemsForTierFromDB(body.base_tier, tierRegion) || lineItemsForTier(body.base_tier)));
    replaceLineItems(id, items);

    // Auto-spawn the Media Kit flavoured view alongside the legacy /pitch/ surface.
    const persistedProposal = getProposalById(id);
    const lineItems = getLineItems(id);
    const kitResult = createKitFromProposal({ ...persistedProposal, id, created_by_username: req.session?.username || null }, lineItems, tierRegion);
    if (kitResult) {
      sqlite.prepare(`UPDATE pitch_proposals SET media_kit_id = ?, media_kit_share_id = ?, media_kit_share_slug = ?, media_kit_share_token = ? WHERE id = ?`)
        .run(kitResult.kit_id, kitResult.share_id, kitResult.share_slug, kitResult.magic_token, id);
    }

    res.json({
      id, slug, magic_token,
      proposal: getProposalById(id),
      line_items: lineItems,
      media_kit: kitResult || null,
    });
  });

  // Upload a client logo. Returns { url } that can be saved into client_logo_url.
  // Reuses the content-addressed attachments store — logos are public under /uploads/.
  app.post("/api/pitch/upload-logo", requirePitch("edit"), (req: any, res: any, next: any) => {
    logoUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "Logo exceeds 5 MB" });
        return res.status(400).json({ message: err.message || "Upload failed" });
      }
      next();
    });
  }, (req: any, res: any) => {
    const file: Express.Multer.File | undefined = req.file;
    if (!file) return res.status(400).json({ message: "file field required" });
    try {
      const { row } = saveAttachment({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        uploadedBy: req.session?.username || "pitch-admin",
      });
      res.json({ url: row.url, mime: row.mime, width: row.width, height: row.height, size_bytes: row.size_bytes });
    } catch (e: any) {
      const status = e?.status || 500;
      res.status(status).json({ message: e?.message || "Upload failed" });
    }
  });

  // Preview a proposal as a transient Media Kit. The wizard's Preview button
  // posts the in-progress form here; we synthesise a proposalRow, run the same
  // createKitFromProposal() helper used on real save, and return the /kit/ link.
  // The clone + share rows are tagged with an `internal-preview-` slug prefix
  // so a future GC sweep can drop them. Magic_token is real → public renderer
  // gates work unchanged.
  app.post("/api/pitch/preview-kit", requirePitch("edit"), async (req: any, res) => {
    const body = req.body || {};
    if (!body.client_name || !body.base_tier) return res.status(400).json({ message: "client_name and base_tier required" });

    const tierRegion = pickTierRegion(body.regions || []);
    const tierCurrency = REGION_CURRENCY[tierRegion] || "USD";
    const currency = (!body.currency || body.currency === "USD") ? tierCurrency : body.currency;

    const items: LineItem[] = Array.isArray(body.line_items) && body.line_items.length
      ? body.line_items
      : (lineItemsForTierFromDB(body.base_tier, tierRegion) || lineItemsForTier(body.base_tier));

    // Synthesise a proposalRow shape that createKitFromProposal() expects.
    // id=0 means no real pitch_proposals row exists; the clone is purely for preview.
    const previewProposal = {
      id: 0,
      client_name: `[PREVIEW] ${body.client_name}`,
      client_contact_name: body.client_contact_name ?? null,
      client_contact_email: body.client_contact_email ?? null,
      base_tier: body.base_tier,
      currency,
      contract_months: body.contract_months ?? 6,
      override_discount_pct: body.override_discount_pct ?? 0,
      intro_text: body.intro_text ?? null,
      proposed_start_date: body.proposed_start_date ?? null,
      created_by_username: req.session?.username || null,
      created_by: null,
    };

    const kitResult = createKitFromProposal(previewProposal, items, tierRegion);
    if (!kitResult) return res.status(500).json({ message: "Preview clone failed" });

    // Re-tag the share slug + kit slug with an internal-preview prefix so GC can find them.
    try {
      sqlite.prepare(`UPDATE media_kits SET slug = ? WHERE id = ?`).run(`internal-preview-${kitResult.kit_id}`, kitResult.kit_id);
      sqlite.prepare(`UPDATE media_kit_shares SET slug = ? WHERE id = ?`).run(`internal-preview-${kitResult.share_id}`, kitResult.share_id);
    } catch (e) { console.warn("[pitch preview-kit] retag failed:", e); }

    const newSlug = `internal-preview-${kitResult.share_id}`;
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = req.headers.host || "dashboard.stereonet.com";
    res.json({
      ok: true,
      preview: true,
      magic_link: `${proto}://${host}/kit/${newSlug}?t=${kitResult.magic_token}`,
      share_slug: newSlug,
      magic_token: kitResult.magic_token,
    });
  });

  // Read proposal + line items
  // We accept `next` so that non-numeric IDs (e.g. /api/pitch/settings) fall through
  // to the next matching route instead of being treated as a missing proposal.
  app.get("/api/pitch/:id", requirePitch("view"), (req, res, next) => {
    if (!/^\d+$/.test(String(req.params.id))) return next();
    const id = Number(req.params.id);
    const prop = getProposalById(id);
    if (!prop) return res.status(404).json({ message: "Not found" });
    // Enrich with view stats from media_kit_shares so the editor header pill
    // matches what the list view shows.
    let enriched: any = prop;
    try {
      if ((prop as any).media_kit_id) {
        const stats = sqlite.prepare(`
          SELECT COALESCE(SUM(view_count),0) AS view_count,
                 MIN(first_viewed_at) AS first_viewed_at,
                 MAX(last_viewed_at)  AS last_viewed_at
          FROM media_kit_shares WHERE kit_id = ?
        `).get((prop as any).media_kit_id) as any;
        enriched = {
          ...prop,
          view_count: Number(stats?.view_count || 0),
          first_viewed_at: stats?.first_viewed_at || null,
          last_viewed_at: stats?.last_viewed_at || null,
        };
      }
    } catch {}
    res.json({ proposal: enriched, line_items: getLineItems(id) });
  });

  // Update proposal fields and (optionally) line items
  app.patch("/api/pitch/:id", requirePitch("edit"), (req: any, res, next) => {
    if (!/^\d+$/.test(String(req.params.id))) return next();
    const id = Number(req.params.id);
    const existing = getProposalById(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (req.pitchAccess !== "admin") {
      const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session.username) as any)?.id;
      if (existing.created_by !== meId) return res.status(403).json({ message: "Not your proposal" });
    }
    const b = req.body || {};
    // SENT-FREEZE: once status='sent' the prospect has been quoted those exact
    // values. Refuse edits unless the caller explicitly opts in with force=true
    // (manual unlock from admin UI).
    const forceUnlock = b.force === true || b.force === "true" || req.query?.force === "1";
    if (existing.status === "sent" && !forceUnlock) {
      return res.status(409).json({
        message: "Proposal is sent and frozen. Pass force=true to override.",
        sent_frozen: true,
        sent_at: existing.sent_at,
      });
    }
    const editable = [
      "client_name", "client_logo_url", "client_contact_name", "client_contact_email",
      "client_region", "base_tier", "currency", "fx_rate_to_usd", "fx_rate_date",
      "contract_months", "override_discount_pct", "pricing_posture", "target_monthly_usd",
      "intro_text", "expires_at",
      "billing_company_name", "billing_address", "proposed_start_date",
    ];
    const sets: string[] = [];
    const params: any = { id };
    for (const k of editable) {
      if (b[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = b[k]; }
    }
    if (b.levers !== undefined)             { sets.push(`levers_json = @levers_json`); params.levers_json = JSON.stringify(b.levers); }
    if (b.competitors !== undefined)        { sets.push(`competitors_json = @competitors_json`); params.competitors_json = JSON.stringify(b.competitors); }
    if (b.brands !== undefined)             { sets.push(`brands_json = @brands_json`); params.brands_json = JSON.stringify(b.brands); }
    if (b.notify_emails !== undefined)      { sets.push(`notify_emails_json = @notify_emails_json`); params.notify_emails_json = JSON.stringify(b.notify_emails); }
    if (b.regions !== undefined)            { sets.push(`regions_json = @regions_json`); params.regions_json = JSON.stringify(b.regions); }
    if (b.accounts_contacts !== undefined)  { sets.push(`accounts_contacts_json = @accounts_contacts_json`); params.accounts_contacts_json = JSON.stringify(b.accounts_contacts); }
    if (b.additional_recipients !== undefined) { sets.push(`additional_recipients_json = @additional_recipients_json`); params.additional_recipients_json = JSON.stringify(b.additional_recipients); }
    if (b.discount_label_override !== undefined) { sets.push(`discount_label_override = @discount_label_override`); params.discount_label_override = b.discount_label_override ? String(b.discount_label_override).trim() : null; }
    if (b.proposal_type !== undefined) { sets.push(`proposal_type = @proposal_type`); params.proposal_type = (b.proposal_type === "casual") ? "casual" : "proposal"; }
    if (b.audience_overrides !== undefined) { sets.push(`audience_overrides_json = @audience_overrides_json`); params.audience_overrides_json = b.audience_overrides ? JSON.stringify(b.audience_overrides) : null; }
    sets.push(`updated_at = datetime('now')`);
    if (sets.length) {
      sqlite.prepare(`UPDATE pitch_proposals SET ${sets.join(", ")} WHERE id = @id`).run(params);
    }
    if (Array.isArray(b.line_items)) {
      replaceLineItems(id, b.line_items);
    }
    // Propagate any change to the linked Media Kit clone so the public /kit/
    // view stays in sync with the proposal as it's edited. Pass force through
    // so manual sent-proposal edits also update the public kit.
    restampKitFromProposal(id, { force: forceUnlock });
    res.json({ proposal: getProposalById(id), line_items: getLineItems(id) });
  });

  // Send: mark as sent, refresh magic_token + expiry, return shareable link
  app.post("/api/pitch/:id/send", requirePitch("edit"), async (req: any, res) => {
    const id = Number(req.params.id);
    const prop = getProposalById(id);
    if (!prop) return res.status(404).json({ message: "Not found" });
    const newToken = genToken(24);
    const expires = new Date(); expires.setDate(expires.getDate() + 30);
    sqlite.prepare(`
      UPDATE pitch_proposals
         SET magic_token = ?, status = 'sent', sent_at = datetime('now'),
             expires_at = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(newToken, expires.toISOString(), id);
    // Defensive: refresh the linked kit's proposal block right before we hand
    // out the magic link so the prospect sees the latest values even if PATCH
    // restamps were missed for some reason.
    restampKitFromProposal(id);
    // FREEZE: snapshot every inherited block on this kit so future edits to
    // the canonical Global kit (e.g. adding new sections) do NOT propagate
    // into a kit that's already been delivered to a customer.
    try {
      const kitId = (prop as any).media_kit_id || 0;
      if (kitId) {
        const r = freezeInheritedBlocksForKit(kitId);
        console.log(`[pitch send] froze inherited blocks for kit ${kitId}: frozen=${r.frozen} skipped=${r.skipped}`);
      }
    } catch (e) { console.warn("[pitch send] freeze failed:", e); }
    // Promote the linked share from draft → sent so the next view by the
    // prospect triggers the first-view notification email. (createKitFromProposal
    // intentionally leaves the share in 'draft' so owner previews don't trip it.)
    try {
      sqlite.prepare(`
        UPDATE media_kit_shares
           SET proposal_state = 'sent', sent_at = COALESCE(sent_at, datetime('now')), first_viewed_at = NULL
         WHERE id = (SELECT media_kit_share_id FROM pitch_proposals WHERE id = ?)
           AND proposal_state IN ('draft','sent')
      `).run(id);
    } catch (e) { console.warn("[pitch send] share state promotion failed:", e); }
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = req.headers.host || "dashboard.stereonet.com";
    // Prefer the Media Kit magic link (Phase B). Fall back to /pitch/ for any
    // legacy proposal rows that pre-date the unification and don't have one.
    const row = sqlite.prepare(`SELECT media_kit_share_slug, media_kit_share_token FROM pitch_proposals WHERE id = ?`).get(id) as any;
    const link = row?.media_kit_share_slug && row?.media_kit_share_token
      ? `${proto}://${host}/kit/${row.media_kit_share_slug}?t=${row.media_kit_share_token}`
      : `${proto}://${host}/pitch/${prop.slug}?t=${newToken}`;

    // Actually email the prospect. Previously /send only flipped the status
    // and returned the magic link — it never delivered the link to the
    // prospect's inbox, which is the whole point of "Send + Copy Link".
    // Mirrors the leads.ts "Send Kit" flow so the from-name, CC, BCC catch-all,
    // and editable template (`prospect_kit_delivery`) all behave the same way.
    // Build the full recipient list: primary contact + any additional_recipients
    // configured on the proposal. Each recipient gets their OWN email (separate
    // sends, not Cc) so threading / read receipts / opens are per-recipient.
    type R = { email: string; name?: string | null };
    const recipients: R[] = [];
    if (prop.client_contact_email) {
      recipients.push({ email: prop.client_contact_email, name: prop.client_contact_name || prop.client_name || null });
    }
    for (const r of ((prop as any).additional_recipients || []) as R[]) {
      if (r?.email && r.email !== prop.client_contact_email) {
        recipients.push({ email: r.email, name: r.name || prop.client_name || null });
      }
    }

    // Look up the share_id for this proposal so we can mint per-recipient
    // tokens. Each recipient gets their own unique magic link, which lets
    // us attribute opens individually instead of all opens collapsing to
    // "someone opened it".
    let shareId: number | null = null;
    try {
      const sr = sqlite.prepare(`SELECT id FROM media_kit_shares WHERE kit_id = ? ORDER BY id ASC LIMIT 1`).get((prop as any).media_kit_id || 0) as any;
      shareId = sr?.id || null;
    } catch {}

    const email_results: any[] = [];
    if (recipients.length === 0) {
      email_results.push({ sent: false, error: "No recipients on proposal" });
    } else {
      const { sendEmail, buildKitDeliveryEmail } = await import("./email");
      const sender = storage.getUserSenderInfo(req.session?.username || "");
      for (const r of recipients) {
        // Mint or reuse the per-recipient token for this share. Reusing keeps
        // the link stable if the same proposal is re-sent (Renew Expiry, etc).
        let recipientToken: string | null = null;
        if (shareId) {
          try {
            const existing = sqlite.prepare(`SELECT token FROM media_kit_share_recipients WHERE share_id = ? AND recipient_email = ?`).get(shareId, r.email) as any;
            if (existing?.token) {
              recipientToken = existing.token;
            } else {
              recipientToken = genToken(24);
              sqlite.prepare(`INSERT INTO media_kit_share_recipients (share_id, recipient_email, recipient_name, token) VALUES (?, ?, ?, ?)`)
                .run(shareId, r.email, r.name || null, recipientToken);
            }
          } catch (e: any) {
            console.warn("[pitch send] failed to mint per-recipient token:", e?.message);
          }
        }
        // Build a recipient-specific link by appending &r=<token>. The public
        // kit endpoint reads ?r= and stamps the view row with recipient_email.
        const personalLink = recipientToken ? `${link}${link.includes("?") ? "&" : "?"}r=${recipientToken}` : link;
        try {
          const tpl = buildKitDeliveryEmail({
            name: r.name || prop.client_name || "there",
            company: prop.client_name || "",
            magicLink: personalLink,
            kitLabel: "StereoNET Media Kit",
          });
          const result = await sendEmail({
            to: r.email,
            toName: r.name || undefined,
            subject: tpl.subject,
            html: tpl.html,
            fromName: sender.name || undefined,
            replyTo: sender.email || undefined,
            // Only CC the sender on the FIRST send so they get a single copy.
            cc: r === recipients[0] ? (sender.email || undefined) : undefined,
          });
          email_results.push({ sent: result.ok, error: result.error || null, to: r.email, link: personalLink });
        } catch (e: any) {
          console.error("[pitch send] email delivery threw:", e);
          email_results.push({ sent: false, error: e?.message || "unknown", to: r.email });
        }
      }
    }
    const email_status = {
      sent: email_results.some(r => r.sent),
      results: email_results,
      total: recipients.length,
      delivered: email_results.filter(r => r.sent).length,
    };

    res.json({ ok: true, link, expires_at: expires.toISOString(), email_status });
  });

  // Revoke
  app.post("/api/pitch/:id/revoke", requirePitch("edit"), (req, res) => {
    const id = Number(req.params.id);
    sqlite.prepare(`UPDATE pitch_proposals SET status = 'revoked', magic_token = ? WHERE id = ?`).run(genToken(24), id);
    res.json({ ok: true });
  });

  // Clone
  app.post("/api/pitch/:id/clone", requirePitch("edit"), (req: any, res) => {
    const id = Number(req.params.id);
    const src = getProposalById(id);
    if (!src) return res.status(404).json({ message: "Not found" });
    const meId = (sqlite.prepare(`SELECT id FROM users WHERE username = ?`).get(req.session.username) as any)?.id ?? null;
    const slug = genSlug(src.client_name + "-copy");
    const token = genToken(24);
    const expires = new Date(); expires.setDate(expires.getDate() + 30);
    const result = sqlite.prepare(`
      INSERT INTO pitch_proposals (
        slug, magic_token, client_name, client_logo_url, client_contact_name, client_contact_email,
        client_region, base_tier, currency, fx_rate_to_usd, fx_rate_date, contract_months,
        override_discount_pct, pricing_posture, levers_json, target_monthly_usd, intro_text,
        competitors_json, brands_json, notify_emails_json, status, expires_at, created_by
      )
      SELECT ?, ?, client_name || ' (copy)', client_logo_url, client_contact_name, client_contact_email,
             client_region, base_tier, currency, fx_rate_to_usd, fx_rate_date, contract_months,
             override_discount_pct, pricing_posture, levers_json, target_monthly_usd, intro_text,
             competitors_json, brands_json, notify_emails_json, 'draft', ?, ?
        FROM pitch_proposals WHERE id = ?
    `).run(slug, token, expires.toISOString(), meId, id);
    const newId = Number(result.lastInsertRowid);
    const items = getLineItems(id) as any[];
    replaceLineItems(newId, items.map(({ id: _i, proposal_id: _p, sort_order: _s, ...rest }) => rest as any));
    res.json({ id: newId, slug });
  });

  // List bolt-on add-ons available for a proposal's region.
  // ?region=anz scopes the catalogue; falls back to global rows when omitted.
  app.get("/api/pitch/addons", requirePitch("view"), (req, res) => {
    const region = (req.query.region as string) || null;
    let rows: any[];
    if (region) {
      rows = sqlite.prepare(`
        SELECT * FROM media_kit_addons
         WHERE kind = 'bolton' AND is_visible = 1
           AND (region = ? OR region IS NULL)
         ORDER BY (region IS NULL) ASC, position ASC
      `).all(region) as any[];
      // Dedupe by addon_key, preferring region-specific over global
      const seen = new Set<string>();
      rows = rows.filter(r => { if (seen.has(r.addon_key)) return false; seen.add(r.addon_key); return true; });
    } else {
      rows = sqlite.prepare(`SELECT * FROM media_kit_addons WHERE kind = 'bolton' AND region IS NULL AND is_visible = 1 ORDER BY position ASC`).all() as any[];
    }
    res.json({ addons: rows });
  });

  // Append a bolt-on as a line item on a proposal.
  app.post("/api/pitch/:id/line-items/from-addon", requirePitch("edit"), (req, res) => {
    const id = Number(req.params.id);
    const addonId = Number(req.body?.addon_id);
    const qty = Math.max(1, Number(req.body?.qty || 1));
    const prop = sqlite.prepare(`SELECT id, currency, fx_rate_to_usd FROM pitch_proposals WHERE id = ?`).get(id) as any;
    if (!prop) return res.status(404).json({ message: "Proposal not found" });
    const addon = sqlite.prepare(`SELECT * FROM media_kit_addons WHERE id = ?`).get(addonId) as any;
    if (!addon) return res.status(404).json({ message: "Addon not found" });
    // Convert price to USD for storage (PITCH stores unit_price_usd internally)
    let usdPrice = 0;
    if (addon.price_value != null && !addon.is_poa) {
      if (addon.price_currency === "USD") usdPrice = addon.price_value;
      else {
        // Naive conversion using the proposal's fx rate. The addon row's currency may not
        // match the proposal currency exactly — we treat them as same-region for now.
        usdPrice = Number(prop.fx_rate_to_usd) > 0 ? addon.price_value / Number(prop.fx_rate_to_usd) : addon.price_value;
      }
    }
    const maxSort = (sqlite.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM pitch_line_items WHERE proposal_id = ?`).get(id) as any).m;
    const suffix = addon.price_suffix || "";
    sqlite.prepare(`
      INSERT INTO pitch_line_items (proposal_id, category, label, description, qty, unit, unit_price_usd, included, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, "bolton", addon.label, addon.description || null, qty, suffix.trim() || "each", usdPrice, maxSort + 1);
    res.json({ ok: true });
  });

  // Delete (admin only). Manually cascades child rows because pitch_downloads
  // (legacy table) was created without ON DELETE CASCADE and SQLite can't add
  // it after the fact. Also tears down the linked Media Kit clone + share that
  // the wizard auto-creates so we don't leave orphan kits behind.
  app.delete("/api/pitch/:id", requirePitch("admin"), (req, res, next) => {
    if (!/^\d+$/.test(String(req.params.id))) return next();
    const id = Number(req.params.id);
    try {
      // Look up the linked media kit before we wipe the parent row.
      const row = sqlite.prepare(`SELECT media_kit_id, media_kit_share_id FROM pitch_proposals WHERE id = ?`).get(id) as any;
      const tx = sqlite.transaction(() => {
        sqlite.prepare(`DELETE FROM pitch_downloads WHERE proposal_id = ?`).run(id);
        // pitch_line_items + pitch_events cascade automatically (ON DELETE CASCADE).
        sqlite.prepare(`DELETE FROM pitch_proposals WHERE id = ?`).run(id);
        // Tear down the auto-created Media Kit clone if one exists. The kit's
        // shares cascade via ON DELETE CASCADE on media_kit_shares.kit_id.
        if (row?.media_kit_id) {
          try { sqlite.prepare(`DELETE FROM media_kits WHERE id = ?`).run(row.media_kit_id); } catch (e) { console.warn("[pitch delete] kit cleanup failed:", e); }
        } else if (row?.media_kit_share_id) {
          // Fallback: at least drop the share row.
          try { sqlite.prepare(`DELETE FROM media_kit_shares WHERE id = ?`).run(row.media_kit_share_id); } catch {}
        }
      });
      tx();
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[pitch delete] failed:", e);
      res.status(500).json({ message: e?.message || "Delete failed" });
    }
  });

  // ────────── Global PITCH settings (terms + default audience) ──────────

  const DEFAULT_WHY_TEXT = `Established in 2003, StereoNET is the No.1 hi-fi publication in Australia, the UK and across Europe, the most widely read English-language publication in Southeast Asia, and a fast-emerging force in North America. In January 2025 we were named one of the world's fastest-growing digital brands by Similarweb (Digital Top 100, Consumer Electronics).`;

  app.get("/api/pitch/settings", requirePitch("view"), (_req, res) => {
    const expDaysRaw = storage.getSetting("pitch_default_expiry_days");
    const default_expiry_days = expDaysRaw ? Number(expDaysRaw) : 30;
    res.json({
      terms_text:                storage.getSetting("pitch_terms_text") || "",
      audience_monthly_uniques:  storage.getSetting("pitch_audience_monthly_uniques") || "",
      audience_label:            storage.getSetting("pitch_audience_label") || "unique visitors / month",
      why_text:                  storage.getSetting("pitch_why_text") || DEFAULT_WHY_TEXT,
      discount_label_text:       storage.getSetting("pitch_discount_label_text") || "Partnership discount applied",
      default_expiry_days,
    });
  });

  app.post("/api/pitch/settings", requirePitch("admin"), (req: any, res) => {
    const b = req.body || {};
    // Detect changes that affect what's already stamped on the linked Media
    // Kit clones so we can fan out a re-stamp afterwards. discount_label_text
    // and terms_text are the only proposal-block-visible settings.
    const oldDiscountLabel = storage.getSetting("pitch_discount_label_text") || "";
    const oldTermsText = storage.getSetting("pitch_terms_text") || "";

    if (typeof b.terms_text === "string")               storage.setSetting("pitch_terms_text", b.terms_text);
    if (typeof b.audience_monthly_uniques === "string") storage.setSetting("pitch_audience_monthly_uniques", b.audience_monthly_uniques);
    if (typeof b.audience_label === "string")           storage.setSetting("pitch_audience_label", b.audience_label);
    if (typeof b.why_text === "string")                 storage.setSetting("pitch_why_text", b.why_text);
    if (typeof b.discount_label_text === "string")      storage.setSetting("pitch_discount_label_text", b.discount_label_text);
    if (typeof b.default_expiry_days === "number" && Number.isFinite(b.default_expiry_days) && b.default_expiry_days >= 1 && b.default_expiry_days <= 365) {
      storage.setSetting("pitch_default_expiry_days", String(Math.round(b.default_expiry_days)));
    }

    // Fan out a re-stamp to every proposal-linked kit when discount label or
    // terms text actually changed. Cheap (most users have a handful of kits)
    // and avoids the "I changed it in settings and nothing updated" surprise.
    const labelChanged = typeof b.discount_label_text === "string" && b.discount_label_text !== oldDiscountLabel;
    const termsChanged = typeof b.terms_text === "string" && b.terms_text !== oldTermsText;
    let restamped = 0;
    if (labelChanged || termsChanged) {
      try {
        const rows = sqlite.prepare(`SELECT id FROM pitch_proposals WHERE media_kit_id IS NOT NULL`).all() as any[];
        for (const r of rows) {
          if (restampKitFromProposal(r.id).restamped) restamped++;
        }
      } catch (e) {
        console.warn("[pitch settings] re-stamp fanout failed:", e);
      }
    }
    res.json({ ok: true, restamped, label_changed: labelChanged, terms_changed: termsChanged });
  });

  // Renew a proposal's expiry to (today + default_expiry_days). Admin or edit.
  app.post("/api/pitch/:id/renew-expiry", requirePitch("edit"), (req, res) => {
    const id = Number(req.params.id);
    const expDaysRaw = storage.getSetting("pitch_default_expiry_days");
    const days = expDaysRaw ? Number(expDaysRaw) : 30;
    const d = new Date(); d.setDate(d.getDate() + days);
    sqlite.prepare(`UPDATE pitch_proposals SET expires_at = ?, status = CASE WHEN status = 'expired' THEN 'sent' ELSE status END WHERE id = ?`).run(d.toISOString(), id);
    res.json({ ok: true, expires_at: d.toISOString() });
  });

  // (Public proposal access removed in Phase C — handled by /api/media-kit/public/* now.)
}
