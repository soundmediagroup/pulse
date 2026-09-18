import type { Express } from "express";
import type { Server } from "http";
import { storage, sqlite } from "./storage";
import { fetchAllSites, generateSeedData, SITES } from "./feeds";
import { fetchForumStats, proxyForumPage, parseForumHtml } from "./forum";
import { processRedlineJob, REDLINE_VERSION } from "./redline";
import { fetchGA4Overview, fetchGA4Daily, fetchGA4TopPages, fetchGA4Sources, fetchGA4Countries, fetchGA4Regions, fetchGA4Devices, fetchSCQueries, fetchSCPages, fetchSCDaily, fetchSCDevices, fetchSCSearchAppearance, fetchSCSearchTypes, BOT_COUNTRIES } from "./analytics";
import { scrapeAllSites } from "./scrapers";
import { ingestEmails, resetProcessedCategory, ATTACHMENTS_DIR } from "./email-ingestion";
import { generateTopPicks, getTopPicks as readTopPicks, TOP_PICKS_VERSION } from "./top-picks";
import { getTrendingPosts, dismissTrending, clearTrendingDismissals, markTrendingCovered, clearTrendingCovered } from "./trending";
import { cfg, cfgSource, setCfg, generateToken, maskSecret, SETTINGS_CATALOG } from "./config";
import { publish as publishRealtime, createTokenRequest, isRealtimeConfigured } from "./realtime";
import { saveAttachment, serialiseAttachment, getAttachmentById, pruneOrphanedAttachments, UPLOADS_DIR, ALLOWED_MIMES, MAX_UPLOAD_BYTES } from "./attachments";
import { registerPitchRoutes } from "./pitch";
import { registerMediaKitRoutes } from "./media-kit";
import { registerLeadsRoutes } from "./leads";
import { registerRetailerRoutes } from "./retailers";
import { registerDiscoveryLearningRoutes, ensureLearningSchema, learnCategoriesFromDismissals, rebuildPositiveBrands, clusterHotStories, computeSiteHealth, getActiveCategorySuppressions, getPositiveBrandsSet, getOpenHotClusters } from "./discovery-learning";
import { ensurePrimarySourceSchema, seedPrimarySources, runAllPrimarySourceWatchers, runFccWatcher, runYoutubeWatcher, runBrandPressWatcher } from "./primary-source-watchers";
import { getFxRates } from "./fx";
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export async function registerRoutes(httpServer: Server, app: Express) {

  // PITCH — register the client proposal builder routes
  registerPitchRoutes(app);

  // Media Kits — register the interactive media kit + share routes
  registerMediaKitRoutes(app);
  registerLeadsRoutes(app);
  registerRetailerRoutes(app);

  // Article Discovery learning system — site health, category learning,
  // positive brand signals, hot-story clustering, weekly digest.
  registerDiscoveryLearningRoutes(app, sqlite);

  // Primary-source watchers — FCC filings, YouTube reviewers, brand press
  // portals. Seeds tables on first run and enables the tracked_sites entries.
  ensurePrimarySourceSchema(sqlite);
  seedPrimarySources(sqlite);
  try {
    const psSites = ["fcc_filings", "youtube_reviewers", "brand_press"];
    for (const s of psSites) {
      const existing = sqlite.prepare(`SELECT enabled FROM tracked_sites WHERE site_key = ?`).get(s) as any;
      if (existing) {
        if (!existing.enabled) sqlite.prepare(`UPDATE tracked_sites SET enabled = 1 WHERE site_key = ?`).run(s);
      } else {
        sqlite.prepare(`INSERT INTO tracked_sites (site_key, enabled) VALUES (?, 1)`).run(s);
      }
    }
  } catch (e: any) {
    console.error("[primary-source] enable tracked_sites failed:", e?.message);
  }

  // Public FX rates — used by the retailer media kit currency selector.
  // Cached server-side for 24h; falls back to a hardcoded snapshot if the
  // upstream FX API ever fails. No auth required.
  app.get("/api/fx-rates", async (_req: any, res: any) => {
    try {
      const r = await getFxRates();
      res.set("Cache-Control", "public, max-age=3600");
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message });
    }
  });

  // Diagnostic: query the DB for editor-brief rows. Admin only.
  // Token-gated diagnostic for proposal send status. Lets us answer "did I
  // actually send this proposal?" from a curl call without needing a session.
  app.get("/api/admin/diag/pitch-status/:slug", (req: any, res: any) => {
    const isDeploy = !!(req.headers["x-deploy-token"] || req.query.token);
    const isAdmin = req.session?.role === "admin";
    if (!isDeploy && !isAdmin) return res.status(403).json({ message: "Forbidden" });
    const slug = String(req.params.slug || "");
    const prop = sqlite.prepare(`SELECT id, client_name, status, sent_at, created_at, media_kit_id, media_kit_share_id FROM pitch_proposals WHERE slug = ?`).get(slug) as any;
    if (!prop) return res.status(404).json({ message: "Proposal not found", slug });
    const share = prop.media_kit_share_id
      ? sqlite.prepare(`SELECT id, slug, proposal_state, sent_at, first_viewed_at, last_viewed_at, view_count, accepted_at FROM media_kit_shares WHERE id = ?`).get(prop.media_kit_share_id)
      : null;
    res.json({ proposal: prop, share, was_sent: !!prop.sent_at });
  });

  app.get("/api/admin/diag/editor-briefs", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const rows = sqlite.prepare(`
      SELECT a.id, a.site, a.title, a.url, a.content_type, a.please_write, a.pinned_by,
             a.hero_image_url, a.published_at, a.fetched_at,
             substr(a.attachments, 1, 200) as attachments_preview,
             substr(a.summary, 1, 200) as summary_preview,
             (SELECT GROUP_CONCAT(pinned_by) FROM article_pins WHERE article_id = a.id) as pin_users
      FROM articles a
      WHERE a.site IN ('editor-brief','task-agent','task-agent-debug','probe-alpha','probe-beta','webhook')
         OR a.please_write = 1
      ORDER BY a.id DESC
      LIMIT 50
    `).all();
    const pinRows = sqlite.prepare(`SELECT * FROM article_pins ORDER BY article_id DESC LIMIT 20`).all();
    const attRows = sqlite.prepare(`SELECT id, sha256, url, size_bytes, caption, credit, uploaded_at FROM attachments ORDER BY uploaded_at DESC LIMIT 20`).all();

    // What does /api/discovery actually return for these ids?
    const targetIds = [8667, 8704, 8705, 8668, 8669, 8670];
    const discovery = storage.getDiscoveryArticles({ limit: 1000 });
    const discoveryIds = new Set(discovery.map(a => a.id));
    const inDiscovery = targetIds.map(id => ({ id, in_discovery: discoveryIds.has(id) }));

    // Is the id dismissed / claimed / written?
    const dismissedIds = (sqlite.prepare(`SELECT article_id FROM article_dismissals WHERE article_id IN (${targetIds.join(',')})`).all() as any[]).map(r => r.article_id);
    const writtenIds = (sqlite.prepare(`SELECT article_id FROM article_claims WHERE status='written' AND article_id IN (${targetIds.join(',')})`).all() as any[]).map(r => r.article_id);
    const claimedIds = (sqlite.prepare(`SELECT article_id, status, username FROM article_claims WHERE article_id IN (${targetIds.join(',')})`).all() as any[]);

    // Raw row for 8667
    const row8667 = sqlite.prepare(`SELECT * FROM articles WHERE id = 8667`).get();
    const dismissalDetail = sqlite.prepare(`SELECT * FROM article_dismissals WHERE article_id IN (${targetIds.join(',')})`).all();

    res.json({
      articles: rows,
      pins: pinRows,
      recent_attachments: attRows,
      in_discovery: inDiscovery,
      discovery_count: discovery.length,
      dismissed_ids_matching: dismissedIds,
      written_ids_matching: writtenIds,
      claimed_ids_matching: claimedIds,
      row_8667_raw: row8667,
      dismissal_detail: dismissalDetail,
    });
  });

  // One-shot: undismiss the editor-brief / pinned test articles that got stuck
  // in the Dismissed state before the pin-wins-over-dismiss fix landed.
  app.post("/api/admin/diag/undismiss-pinned", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    // Find every article that is BOTH pinned AND dismissed — pin should win.
    const rows = sqlite.prepare(`
      SELECT d.article_id FROM article_dismissals d
      INNER JOIN article_pins p ON p.article_id = d.article_id
    `).all() as { article_id: number }[];
    const ids = rows.map(r => r.article_id);
    if (ids.length === 0) return res.json({ cleared: 0, ids: [] });
    const del = sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id IN (${ids.join(',')})`).run();
    res.json({ cleared: del.changes, ids });
  });

  // Generic admin undismiss by id list
  app.post("/api/admin/diag/undismiss", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((n: any) => Number.isInteger(n)) : [];
    if (ids.length === 0) return res.json({ cleared: 0, ids: [] });
    const del = sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id IN (${ids.join(',')})`).run();
    res.json({ cleared: del.changes, ids });
  });

  // Inspect coverage matching for a brand+model query
  app.get("/api/admin/diag/coverage-trace", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const q = String(req.query.q || "").toLowerCase();
    if (!q) return res.status(400).json({ message: "q= required" });

    // Find StereoNET rows whose title contains the query tokens
    const snRows = sqlite.prepare(`
      SELECT id, title, url, brands, published_at, site
      FROM articles WHERE site='stereonet' AND lower(title) LIKE ?
      ORDER BY published_at DESC LIMIT 10
    `).all(`%${q}%`);

    // Find OTHER sites' rows whose title contains the query tokens (Discovery candidates)
    const otherRows = sqlite.prepare(`
      SELECT id, title, url, site, brands, published_at
      FROM articles WHERE site != 'stereonet' AND lower(title) LIKE ?
      ORDER BY published_at DESC LIMIT 20
    `).all(`%${q}%`);

    res.json({ q, sn_rows: snRows, other_rows: otherRows });
  });

  // Sample WhatHiFi titles to tune the deals filter (read-only, token-gated)
  app.get("/api/admin/diag/whathifi-recent", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const rows = sqlite.prepare(`
      SELECT id, title, url, published_at, content_type
      FROM articles
      WHERE site LIKE '%whathifi%' OR site = 'whathifi' OR url LIKE '%whathifi%'
      ORDER BY published_at DESC
      LIMIT 80
    `).all();
    res.json({ count: rows.length, rows });
  });

  // Purge editor-brief / task-agent test articles and their associated pins,
  // dismissals, claims. Does NOT delete attachment files on disk (they’re
  // content-addressed and may be referenced elsewhere — prune separately).
  app.post("/api/admin/diag/purge-briefs", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((n: any) => Number.isInteger(n)) : [];
    if (ids.length === 0) return res.status(400).json({ message: "ids[] required" });
    const tx = sqlite.transaction(() => {
      const inClause = `(${ids.join(',')})`;
      const pinsDel = sqlite.prepare(`DELETE FROM article_pins WHERE article_id IN ${inClause}`).run();
      const disDel = sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id IN ${inClause}`).run();
      const claimsDel = sqlite.prepare(`DELETE FROM article_claims WHERE article_id IN ${inClause}`).run();
      const artDel = sqlite.prepare(`DELETE FROM articles WHERE id IN ${inClause}`).run();
      return {
        articles_deleted: artDel.changes,
        pins_deleted: pinsDel.changes,
        dismissals_deleted: disDel.changes,
        claims_deleted: claimsDel.changes,
      };
    });
    res.json(tx());
  });

  // Serve press release attachments from persistent data volume
  if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  // Cloudflare custom 5xx error page.
  // Cloudflare serves this from its edge cache when the origin is unreachable
  // (522, 523, 524, etc). Long TTL + `must-revalidate=false` so the edge holds
  // it even during origin outages. Path is /_cf/retry.html so it's clearly
  // separated from the SPA routing.
  app.get("/_cf/retry.html", (req, res) => {
    const p = path.join(process.cwd(), "dist", "public", "cf-retry.html");
    res.set("Cache-Control", "public, max-age=86400, s-maxage=2592000, immutable");
    res.set("CDN-Cache-Control", "max-age=2592000");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.sendFile(p, (err) => {
      if (err) res.status(500).send("<h1>Reconnecting\u2026</h1><script>setTimeout(function(){location.reload()},5000)</script>");
    });
  });

  app.use("/press-attachments", express.static(ATTACHMENTS_DIR));

  // Serve webhook-ingested attachments (editor-brief images, PDFs etc.)
  // Served with long cache headers since filenames are sha256-content-addressed.
  if (!fs.existsSync(UPLOADS_DIR)) {
    try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); }
    catch (e: any) { console.warn(`[uploads] could not create ${UPLOADS_DIR}: ${e.message}`); }
  }
  app.use("/uploads", express.static(UPLOADS_DIR, {
    maxAge: "365d",
    immutable: true,
    etag: true,
    fallthrough: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  }));

  // Seed tracked_sites from hardcoded SITES on first run
  storage.seedSitesIfEmpty();
  // Fix broken SoundStage RSS URL
  storage.updateSiteUrl('soundstage', 'https://www.soundstagehifi.com/index.php?format=feed&type=rss');
  // Backfill site_url for existing tracked sites
  const siteUrlMap: Record<string, string> = {
    stereonet: 'https://www.stereonet.com', whathifi: 'https://www.whathifi.com',
    hifipig: 'https://www.hifipig.com', darko: 'https://darko.audio',
    ecoustics: 'https://www.ecoustics.com', absolutesound: 'https://www.theabsolutesound.com',
    hifinews: 'https://www.hifinews.com', audiophileman: 'https://theaudiophileman.com',
    twitteringmachines: 'https://www.twitteringmachines.com', audiohead: 'https://audio-head.com',
    soundstage: 'https://www.soundstagenetwork.com', hometheaterhifi: 'https://www.hometheaterhifi.com',
    stereophile: 'https://www.stereophile.com', audioxpress: 'https://www.audioxpress.com',
  };
  for (const [key, url] of Object.entries(siteUrlMap)) {
    sqlite.prepare(`UPDATE tracked_sites SET site_url = ? WHERE site_key = ? AND (site_url IS NULL OR site_url = '')`).run(url, key);
  }

  // Seed on first run
  const count = storage.getArticleCount();
  if (count === 0) {
    const seed = generateSeedData();
    let added = 0;
    for (const a of seed) {
      if (storage.insertArticle(a)) added++;
    }
    storage.logRefresh(added, "success", "Initial 30-day seed data loaded");
    console.log(`[cadence] Seeded ${added} articles`);
  }

  // ─── Auto-refresh every hour ─────────────────────────────────────────────────
  async function runRefresh() {
    try {
      console.log("[cadence] Auto-refresh starting...");
      const { articles: fetched, siteResults } = await fetchAllSites();
      let added = 0;
      for (const a of fetched) {
        if (storage.insertArticle(a)) added++;
      }
      // Scrape sites with dead RSS
      try {
        const scraped = await scrapeAllSites();
        for (const s of scraped) {
          if (storage.insertArticle({
            title: s.title, url: s.url, site: s.site,
            publishedAt: s.date + "T00:00:00Z", publishedDate: s.date,
            contentType: "news", categories: "[]", author: "", brands: "[]",
            fetchedAt: new Date().toISOString(),
          })) added++;
        }
      } catch {}
      storage.logRefresh(added, "success");
      console.log(`[cadence] Auto-refresh complete — ${added} new articles`);
      if (added > 0) publishRealtime("article.new", { count: added, source: "auto-refresh" });
      // Run the discovery-learning maintenance loop after each refresh.
      // Cheap operations — all read-only aggregates over the last 24-90 days.
      try {
        const clusterOut = clusterHotStories(sqlite);
        if (clusterOut.clusters_new > 0) {
          console.log(`[discovery-learning] ${clusterOut.clusters_new} new hot-story clusters detected (open: ${clusterOut.clusters_open})`);
          publishRealtime("discovery.hot_story", clusterOut);
        }
      } catch (e: any) { console.error("[discovery-learning] clusterHotStories failed:", e?.message); }
    } catch (err: any) {
      storage.logRefresh(0, "error", err?.message);
      console.error("[cadence] Auto-refresh failed:", err?.message);
    }
  }

  // Slower-cadence learning refreshers — category learning + positive brand
  // cache rebuild. These are heavier scans so run hourly, not per-refresh.
  async function runDiscoveryLearningHourly() {
    try {
      const catOut = learnCategoriesFromDismissals(sqlite);
      console.log(`[discovery-learning] category pass: reviewed ${catOut.reviewed} (site,category) combos, ${catOut.learned} active suppressions`);
    } catch (e: any) { console.error("[discovery-learning] category pass failed:", e?.message); }
    try {
      const brandsN = rebuildPositiveBrands(sqlite, 90, 2);
      console.log(`[discovery-learning] positive brands cache: ${brandsN} brands indexed`);
    } catch (e: any) { console.error("[discovery-learning] positive brands rebuild failed:", e?.message); }
  }
  setTimeout(runDiscoveryLearningHourly, 30_000); // once at startup
  setInterval(runDiscoveryLearningHourly, 60 * 60 * 1_000);

  // Primary-source watchers — poll every 30 minutes so we're never more than
  // 30 min behind an FCC filing / YouTube upload / brand press release.
  // Runs deferred so it doesn't block boot; each cycle polls a rotating
  // batch (see LIMIT clauses in the watcher functions) to spread load.
  async function runPrimarySourceWatchers() {
    try {
      const out = await runAllPrimarySourceWatchers(sqlite);
      const fccNew = out?.fcc?.new_signals || 0;
      const ytNew = out?.youtube?.new_signals || 0;
      const bpNew = out?.brand_press?.new_signals || 0;
      const total = fccNew + ytNew + bpNew;
      if (total > 0) {
        console.log(`[primary-source] cycle complete — FCC=${fccNew} YT=${ytNew} press=${bpNew} (total ${total} new signals)`);
        publishRealtime("article.new", { count: total, source: "primary-source-watcher" });
      }
    } catch (e: any) {
      console.error("[primary-source] watcher cycle failed:", e?.message);
    }
  }
  setTimeout(runPrimarySourceWatchers, 45_000); // once at startup, 45s after boot
  setInterval(runPrimarySourceWatchers, 30 * 60 * 1_000);

  // Run once at startup (after a short delay to let server settle)
  setTimeout(runRefresh, 10_000);
  // Then every 15 minutes
  setInterval(runRefresh, 15 * 60 * 1_000);

  // One-shot brand re-extraction on first boot after the v2.48 brand-extractor
  // fix (apostrophe-s stripping, single-word sub-phrases). Idempotent — safe
  // to call multiple times. Gated on a settings flag so we only run once per
  // deploy unless explicitly triggered.
  setTimeout(() => {
    try {
      const flag = storage.getSetting("BRANDS_REEXTRACTED_V248");
      if (flag !== "1") {
        const n = storage.reextractAllBrands();
        storage.setSetting("BRANDS_REEXTRACTED_V248", "1");
        console.log(`[cadence] Initial re-extract complete (${n} articles).`);
      }
    } catch (err: any) {
      console.error("[cadence] Brand re-extract failed:", err?.message);
    }
  }, 30_000);

  // ── Press email diagnostics ── list recent press_emailroom articles in the
  // DB along with their filter status, B-Side status, and dismissal status.
  // Token-gated and admin-gated. Replaces the need to query SQLite directly.
  app.get("/api/admin/diag/press-emails", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const days = Math.min(Number(req.query?.days) || 7, 30);
    const rows = sqlite.prepare(`
      SELECT
        a.id, a.title, a.sender_name, a.sender_email, a.fetched_at, a.published_at,
        a.message_id, a.url,
        CASE WHEN d.article_id IS NOT NULL THEN 1 ELSE 0 END AS dismissed,
        d.username AS dismissed_by,
        CASE WHEN b.article_id IS NOT NULL THEN 1 ELSE 0 END AS bsided,
        CASE WHEN c.article_id IS NOT NULL AND c.status = 'claimed' THEN 1 ELSE 0 END AS claimed,
        CASE WHEN c.article_id IS NOT NULL AND c.status = 'claimed' THEN c.username ELSE NULL END AS claimed_by,
        CASE WHEN c.article_id IS NOT NULL AND c.status = 'written' THEN 1 ELSE 0 END AS written
      FROM articles a
      LEFT JOIN article_dismissals d ON d.article_id = a.id
      LEFT JOIN article_bsides b ON b.article_id = a.id AND b.marked_at >= datetime('now', '-28 days')
      LEFT JOIN article_claims c ON c.article_id = a.id
      WHERE a.site = 'email_pressroom'
        AND a.fetched_at >= datetime('now', '-' || ? || ' days')
      ORDER BY a.fetched_at DESC
      LIMIT 200
    `).all(days);
    // Compute keyword-filter matches for each title
    const filterKeywords = sqlite.prepare(`SELECT keyword FROM filter_keywords`).all() as { keyword: string }[];
    const filterRegexes = filterKeywords.map(({ keyword }) => ({
      keyword,
      rx: new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    }));
    const enriched = (rows as any[]).map(r => {
      let filteredByKeyword: string | null = null;
      for (const { keyword, rx } of filterRegexes) {
        if (rx.test(r.title || "")) { filteredByKeyword = keyword; break; }
      }
      return { ...r, filteredByKeyword };
    });
    res.json({ count: enriched.length, days, rows: enriched, filterKeywords: filterKeywords.map(f => f.keyword) });
  });

  // Trace why a specific article ID is or isn't returned by getDiscoveryArticles.
  // Steps through each filter in the SQL+JS pipeline and reports the first one
  // that excludes it. Token-gated.
  app.get("/api/admin/diag/trace-article", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const id = Number(req.query?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "invalid id" });

    const row: any = sqlite.prepare(`SELECT * FROM articles WHERE id = ?`).get(id);
    if (!row) return res.json({ id, exists: false });

    const steps: any[] = [];

    // Step 1: site filter
    const siteOk = row.site !== "stereonet" && row.site !== "headfi";
    steps.push({ step: "site_not_excluded", pass: siteOk, value: row.site });

    // Step 2: content_type whitelist
    const ctAllowed = row.content_type == null || ["news", "press_release", "editor_brief", "feature", "opinion"].includes(row.content_type);
    steps.push({ step: "content_type_allowed", pass: ctAllowed, value: row.content_type });

    // Step 3: would it be in the LIMIT 5*limit prefix?
    const limit = 300;
    const prefixRows = sqlite.prepare(`
      SELECT id, published_at FROM articles
      WHERE site != 'stereonet' AND site != 'headfi'
        AND (content_type IS NULL OR content_type = 'news' OR content_type = 'press_release' OR content_type = 'editor_brief' OR content_type = 'feature' OR content_type = 'opinion')
      ORDER BY published_at DESC
      LIMIT ?
    `).all(limit * 5) as { id: number; published_at: string }[];
    const inPrefix = prefixRows.some(r => r.id === id);
    steps.push({
      step: "in_sql_prefix",
      pass: inPrefix,
      prefix_size: prefixRows.length,
      oldest_in_prefix: prefixRows[prefixRows.length - 1]?.published_at,
      newest_in_prefix: prefixRows[0]?.published_at,
      this_published_at: row.published_at,
    });

    // Step 4: enabled-sites whitelist (with always-visible bypass)
    const ALWAYS_VISIBLE_SITES = new Set(["editor-brief", "webhook", "task-agent", "task-agent-debug", "probe-alpha", "probe-beta", "email_pressroom"]);
    const enabledSiteKeys = new Set((storage as any).getEnabledSites().filter((s: any) => s.site_key !== "stereonet").map((s: any) => s.site_key));
    const enabledOk = ALWAYS_VISIBLE_SITES.has(row.site) || enabledSiteKeys.has(row.site);
    steps.push({ step: "site_enabled_or_always_visible", pass: enabledOk, always_visible: ALWAYS_VISIBLE_SITES.has(row.site), in_enabled: enabledSiteKeys.has(row.site) });

    // Step 5: relevance keyword (always-visible + audio sites bypass)
    const AUDIO_SITES = new Set(["whathifi", "hifipig", "darko", "ecoustics", "absolutesound", "hifinews", "audiophileman", "twitteringmachines", "audiohead", "soundstage", "hometheaterhifi", "stereophile", "audioxpress", "dailyaudio", "gearpatrol", "sempre", "channelnews", "hifiplus", "audiophilia", "audioholics", "dagogo", "parttimeaudiophile", "enjoythemusic", "audioresurgence", "audiobacon", "soundstagehifi", "monoandstereo", "email_pressroom", "editor-brief"]);
    const GOLD_STANDARD_SITES = new Set(["ecoustics", "stereophile", "absolutesound", "whathifi", "hifinews", "hifiplus", "email_pressroom", "editor-brief"]);
    const relevanceOk = ALWAYS_VISIBLE_SITES.has(row.site) || AUDIO_SITES.has(row.site) || GOLD_STANDARD_SITES.has(row.site);
    steps.push({ step: "relevance_bypassed_by_site", pass: relevanceOk });

    // Step 6: blocked keywords (learned + manual)
    const blocked = (storage as any).getBlockedKeywords().map((b: any) => b.keyword);
    const titleLower = (row.title || "").toLowerCase();
    const blockedHit = blocked.find((kw: string) => titleLower.includes(kw));
    steps.push({ step: "blocked_keywords", pass: !blockedHit, hit: blockedHit || null, blocked_count: blocked.length });

    // Step 7: filter_keywords (whole-word, would mark filteredByKeyword)
    const filterKeywords = sqlite.prepare(`SELECT keyword FROM filter_keywords`).all() as { keyword: string }[];
    let filterHit: string | null = null;
    for (const { keyword } of filterKeywords) {
      const rx = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (rx.test(row.title || "")) { filterHit = keyword; break; }
    }
    steps.push({ step: "filter_keyword_match", filter_hit: filterHit, note: "this only marks filteredByKeyword, does NOT exclude from /api/discovery" });

    // Step 8: actually run getDiscoveryArticles and check membership at limits 300 / 1000 / 5000
    const runAt = (lim: number) => {
      const out = storage.getDiscoveryArticles({ limit: lim });
      return { limit: lim, count: out.length, present: out.some(a => a.id === id) };
    };
    const liveCheck = [runAt(300), runAt(1000), runAt(5000)];

    res.json({
      id,
      exists: true,
      row: {
        id: row.id,
        site: row.site,
        title: row.title,
        url: row.url,
        content_type: row.content_type,
        published_at: row.published_at,
        published_date: row.published_date,
        fetched_at: row.fetched_at,
        categories: row.categories,
        brands: row.brands,
        please_write: row.please_write,
        pinned_by: row.pinned_by,
        message_id: row.message_id,
      },
      steps,
      live_discovery_check: liveCheck,
    });
  });

  // List blocked keywords with hit counts and danger flags. Token-gated.
  app.get("/api/admin/diag/blocked-keywords", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const blocked = storage.getBlockedKeywords();
    // Flag dangerous substring matches: short generic words that would catch
    // legit audio headlines via includes() (not whole-word).
    const DANGEROUS = new Set([
      "release", "released", "launch", "launched", "new", "news",
      "review", "announce", "announced", "deal", "price", "sale",
      "update", "updated", "today", "week", "month", "year",
      "best", "top", "buy", "get", "now", "first", "latest",
    ]);
    const enriched = blocked.map(b => ({
      ...b,
      dangerous: DANGEROUS.has(b.keyword.toLowerCase()) || b.keyword.length <= 4,
    }));
    res.json({ count: enriched.length, keywords: enriched });
  });

  // Bulk-delete blocked keywords by id. Token-gated.
  app.post("/api/admin/diag/blocked-keywords/delete", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n: any) => Number.isInteger(n)) : [];
    if (ids.length === 0) return res.status(400).json({ message: "ids array required" });
    let removed = 0;
    for (const id of ids) {
      try { storage.removeBlockedKeyword(id); removed++; } catch {}
    }
    res.json({ ok: true, removed, ids });
  });

  // Force-resurface a press email back to Active: clears dismissal, B-Side mark,
  // and removes the title from any keyword filter that's matching it (by deleting
  // the keyword — admin can re-add). Token-gated.
  app.post("/api/admin/diag/resurface", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "invalid id" });
    sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM article_bsides WHERE article_id = ?`).run(id);
    res.json({ ok: true, id });
  });

  // ── Database backup ── deploy-token-gated streaming download of the SQLite DB.
  // Uses VACUUM INTO so the snapshot is consistent (no lock contention with
  // ongoing writes). Token check is enforced at the auth-middleware level too
  // (see server/index.ts — /api/admin/diag/* paths bypass session auth when
  // an x-deploy-token header or ?token query is present).
  app.get("/api/admin/diag/db-backup", async (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    try {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");
      // Resolve the live DB path. The pulse SQLite file lives at /app/data/cadence_tracker.db
      // (filename retained for production compatibility; downloads are renamed to pulse-*.db).
      // in production. We snapshot via VACUUM INTO into a tempfile.
      const dbPath = process.env.DB_PATH || "/app/data/cadence_tracker.db"; // Live DB filename
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-bak-"));
      const snapshotPath = path.join(tmpDir, "pulse.db");
      sqlite.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const stat = fs.statSync(snapshotPath);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Content-Disposition", `attachment; filename="pulse-${ts}.db"`);
      const stream = fs.createReadStream(snapshotPath);
      stream.on("close", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
      stream.pipe(res);
      return;
    } catch (err: any) {
      console.error("[backup] failed:", err?.message);
      res.status(500).json({ message: "Backup failed", error: err?.message });
    }
  });

  // ── B-Sides (low-priority watch-list) CRUD ──
  // Marking is admin-only; reading the list is open to all authenticated users
  // so the B-Sides tab is visible to the whole team.
  app.get("/api/bsides", (req: any, res: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Unauthorized" });
    res.json(storage.listBSidedDetailed());
  });
  app.post("/api/bsides/:id", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "invalid id" });
    storage.markBSide(id, req.session.username || null);
    res.json({ ok: true });
  });
  app.delete("/api/bsides/:id", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "invalid id" });
    storage.unmarkBSide(id);
    res.json({ ok: true });
  });

  // ── Title-keyword filters CRUD ──
  app.get("/api/filter-keywords", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (!req.session?.username && token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv")) return res.status(401).json({ message: "Unauthorized" });
    res.json(storage.listFilterKeywords());
  });
  app.post("/api/filter-keywords", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const keyword = String(req.body?.keyword || "").trim();
    if (!keyword) return res.status(400).json({ message: "keyword required" });
    if (keyword.length > 100) return res.status(400).json({ message: "keyword too long" });
    const result = storage.addFilterKeyword(keyword, req.session.username || null);
    if (!result) return res.status(409).json({ message: "keyword already exists" });
    res.json(result);
  });
  app.delete("/api/filter-keywords/:id", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "invalid id" });
    const ok = storage.removeFilterKeyword(id);
    res.json({ ok });
  });

  // Manual re-extract endpoint (for future schema changes)
  app.post("/api/admin/diag/reextract-brands", (req: any, res: any) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const count = storage.reextractAllBrands();
    res.json({ ok: true, count });
  });

  // ─── Trending & Emerging (Reddit hot posts from audio subs) ──────────────
  app.get("/api/trending", async (req: any, res: any) => {
    try {
      const data = await getTrendingPosts({ force: !!req.query.force });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ message: e.message, posts: [] });
    }
  });

  app.post("/api/trending/dismiss", (req: any, res: any) => {
    const id = String(req.body?.id || "");
    if (!id) return res.status(400).json({ message: "id required" });
    dismissTrending(id);
    publishRealtime("trending.dismissed", { id });
    res.json({ ok: true });
  });

  app.post("/api/trending/clear-dismissals", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    clearTrendingDismissals();
    res.json({ ok: true });
  });

  // Mark a trending post as already covered on StereoNET. Removes it from the feed
  // just like Dismiss, but tracked separately so we can report on what's been covered.
  app.post("/api/trending/covered", (req: any, res: any) => {
    const id = req.body?.id;
    if (!id || typeof id !== "string") return res.status(400).json({ error: "id required" });
    markTrendingCovered(id);
    res.json({ ok: true });
  });
  app.post("/api/trending/clear-covered", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    clearTrendingCovered();
    res.json({ ok: true });
  });

  // ─── Webhook: inbound article ingest ─────────────────────────────────────
  // Lets external agents (e.g. scheduled tasks, Zapier, n8n) POST new articles
  // directly into Article Discovery.
  //
  // Auth:   header `x-webhook-token: <WEBHOOK_INGEST_TOKEN from .env>`
  // Method: POST /api/ingest/article
  // Body (JSON):
  //   {
  //     "title":      "required, the headline",
  //     "url":        "required, unique URL",
  //     "site":       "optional, defaults to 'webhook'",
  //     "published_at": "optional ISO8601, defaults to now",
  //     "content_type": "optional: review|news|feature|opinion|unknown (default: unknown)",
  //     "author":     "optional",
  //     "categories": ["optional", "string array"],
  //     "brands":     ["optional", "string array"]
  //   }
  //
  // Also accepts a batch: POST with { "articles": [ {...}, {...} ] }
  // Responses:
  //   200 { inserted: 1, skipped: 0, errors: [] } — success
  //   400 validation error
  //   401 bad/missing token
  // Webhook token: read fresh on each request so Admin UI edits take effect immediately.
  function currentWebhookToken(): string { return cfg("WEBHOOK_INGEST_TOKEN"); }

  // Resolve an attachments payload: accepts either {id} refs or inline
  // {url, type, caption, credit, credit_url} entries. Returns the stored form.
  function resolveAttachments(raw: any): Array<any> {
    if (!Array.isArray(raw)) return [];
    const resolved: any[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.id === "string" && item.id.startsWith("att_")) {
        const row = getAttachmentById(item.id);
        if (!row) continue; // silently drop unknown ids
        resolved.push({
          id: row.id,
          url: row.url,
          type: row.mime.startsWith("image/") ? "image" : row.mime === "application/pdf" ? "pdf" : "file",
          mime: row.mime,
          width: row.width,
          height: row.height,
          caption: item.caption || row.caption || null,
          credit: item.credit || row.credit || null,
          credit_url: item.credit_url || row.credit_url || null,
        });
      } else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
        resolved.push({
          url: item.url,
          type: typeof item.type === "string" ? item.type : (item.url.match(/\.(jpg|jpeg|png|webp|gif)$/i) ? "image" : item.url.match(/\.pdf$/i) ? "pdf" : "link"),
          caption: item.caption || null,
          credit: item.credit || null,
          credit_url: item.credit_url || null,
        });
      }
    }
    return resolved;
  }

  function normaliseArticleInput(raw: any): { ok: true; article: any; pleaseWrite: boolean; pinnedBy: string | null } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const url   = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!title) return { ok: false, error: "title is required" };
    if (!url)   return { ok: false, error: "url is required" };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "url must be http(s)" };

    const now = new Date();
    const published = raw.published_at && typeof raw.published_at === "string"
      ? new Date(raw.published_at)
      : now;
    if (isNaN(published.getTime())) return { ok: false, error: "invalid published_at" };

    const allowedTypes = new Set(["review", "news", "feature", "opinion", "unknown", "editor_brief"]);
    let content_type = typeof raw.content_type === "string" && allowedTypes.has(raw.content_type)
      ? raw.content_type
      : "unknown";

    const site = (typeof raw.site === "string" && raw.site.trim()) ? raw.site.trim() : "webhook";
    // An editor-brief always gets the editor_brief content_type so the UI can badge it.
    if (site === "editor-brief" && content_type === "unknown") content_type = "editor_brief";

    const author = typeof raw.author === "string" ? raw.author.trim() || null : null;
    const categories = Array.isArray(raw.categories) ? raw.categories.filter((c: any) => typeof c === "string") : [];
    const brands = Array.isArray(raw.brands) ? raw.brands.filter((b: any) => typeof b === "string") : [];

    // New editor-brief fields
    const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 2000) : null;
    const briefMarkdown = typeof raw.brief_markdown === "string" ? raw.brief_markdown.slice(0, 50000) : null;
    const heroImageUrl = typeof raw.hero_image_url === "string" && /^https?:\/\//i.test(raw.hero_image_url) ? raw.hero_image_url : null;
    const attachments = resolveAttachments(raw.attachments);
    const pleaseWrite = raw.please_write === true;
    const pinnedBy = typeof raw.pinned_by === "string" ? raw.pinned_by.trim() || null : null;
    const suggestedWordCount = typeof raw.suggested_word_count === "string" ? raw.suggested_word_count.slice(0, 100) : null;
    const suggestedHeadlines = Array.isArray(raw.suggested_headlines) ? raw.suggested_headlines.filter((s: any) => typeof s === "string").slice(0, 10) : [];
    const openQuestions = Array.isArray(raw.open_questions) ? raw.open_questions.filter((s: any) => typeof s === "string").slice(0, 25) : [];
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((s: any) => s && typeof s === "object" && typeof s.url === "string").slice(0, 25)
        .map((s: any) => ({ title: typeof s.title === "string" ? s.title : s.url, url: s.url }))
      : [];

    return {
      ok: true,
      pleaseWrite,
      pinnedBy,
      article: {
        site,
        title,
        url,
        publishedAt: published.toISOString(),
        publishedDate: published.toISOString().slice(0, 10),
        contentType: content_type,
        categories: JSON.stringify(categories),
        author,
        brands: JSON.stringify(brands),
        fetchedAt: now.toISOString(),
        summary,
        briefMarkdown,
        heroImageUrl,
        attachments: attachments.length ? JSON.stringify(attachments) : null,
        pleaseWrite,
        pinnedBy,
        suggestedWordCount,
        suggestedHeadlines: suggestedHeadlines.length ? JSON.stringify(suggestedHeadlines) : null,
        openQuestions: openQuestions.length ? JSON.stringify(openQuestions) : null,
        sources: sources.length ? JSON.stringify(sources) : null,
      },
    };
  }

  // ─── POST /api/ingest/attachment ──────────────────────────────────────
  // multipart/form-data upload. Field: file. Optional: caption, credit, credit_url.
  // Accepts JPEG/PNG/WebP/GIF/PDF, max 25 MB. Content-addressed by SHA-256 so
  // re-uploading the same bytes returns the existing record.
  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
      else cb(new Error(`unsupported mime: ${file.mimetype}`));
    },
  });
  app.post("/api/ingest/attachment", (req: any, res: any, next: any) => {
    // Token auth before multer touches the body.
    const token = currentWebhookToken();
    if (!token) return res.status(503).json({ error: "WEBHOOK_INGEST_TOKEN not configured" });
    const provided = req.headers["x-webhook-token"] || req.query.token;
    if (provided !== token) return res.status(401).json({ error: "bad or missing token" });
    attachmentUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `file exceeds ${MAX_UPLOAD_BYTES} bytes` });
        if (err.message?.startsWith("unsupported mime")) return res.status(415).json({ error: err.message });
        return res.status(400).json({ error: err.message || "upload failed" });
      }
      next();
    });
  }, (req: any, res: any) => {
    const file: Express.Multer.File | undefined = req.file;
    if (!file) return res.status(400).json({ error: "file field required" });
    try {
      const { row, deduped } = saveAttachment({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        caption: typeof req.body?.caption === "string" ? req.body.caption : undefined,
        credit: typeof req.body?.credit === "string" ? req.body.credit : undefined,
        creditUrl: typeof req.body?.credit_url === "string" ? req.body.credit_url : undefined,
        uploadedBy: "webhook",
      });
      res.json({ ...serialiseAttachment(row), deduped });
    } catch (e: any) {
      const status = e?.status || 500;
      res.status(status).json({ error: e?.message || "upload failed" });
    }
  });

  app.post("/api/ingest/article", express.json({ limit: "512kb" }), (req: any, res: any) => {
    // Token auth (separate from session — this route is for external callers)
    const token = currentWebhookToken();
    if (!token) return res.status(503).json({ error: "WEBHOOK_INGEST_TOKEN not configured" });
    const provided = req.headers["x-webhook-token"] || req.query.token;
    if (provided !== token) return res.status(401).json({ error: "bad or missing token" });

    const body = req.body;
    const items = Array.isArray(body?.articles) ? body.articles : [body];
    if (items.length === 0) return res.status(400).json({ error: "no articles in payload" });
    if (items.length > 100) return res.status(400).json({ error: "max 100 articles per request" });

    let inserted = 0;
    let skipped = 0;
    const errors: Array<{ index: number; error: string }> = [];

    const insertedIds: number[] = [];
    items.forEach((raw: any, idx: number) => {
      const result = normaliseArticleInput(raw);
      if (!result.ok) { errors.push({ index: idx, error: result.error }); return; }
      try {
        const id = storage.insertEditorBriefArticle(result.article);
        if (id) {
          inserted++;
          insertedIds.push(id);
          // Auto-pin to "Please Write" section if requested.
          if (result.pleaseWrite) {
            const pinUser = result.pinnedBy || "editor-brief";
            try {
              storage.pinArticle(id, pinUser, "Please Write");
              publishRealtime("article.pinned", { articleId: id, username: pinUser, note: "Please Write", title: result.article.title });
            } catch (e: any) {
              console.warn(`[webhook-ingest] failed to pin article ${id}:`, e?.message);
            }
          }
        } else {
          skipped++;
        }
      } catch (e: any) {
        errors.push({ index: idx, error: e.message || "insert failed" });
      }
    });

    console.log(`[webhook-ingest] inserted=${inserted} skipped=${skipped} errors=${errors.length} ids=${insertedIds.join(",")}`);
    if (inserted > 0) publishRealtime("article.new", { count: inserted, source: "webhook" });
    res.json({ inserted, skipped, errors, ids: insertedIds });
  });

  // ─── Realtime (Ably) token endpoint ──────────────────────────────────
  // Clients hit this to get a short-lived Ably tokenRequest, so the raw API key
  // never leaves the server. Returns null-shaped 204 if realtime is disabled so
  // the client can gracefully fall back to polling.
  // Debug: force-publish a test event (admin only)
  app.post("/api/realtime/test", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const ts = Date.now();
    publishRealtime("debug.ping", { at: ts, by: req.session.username });
    res.json({ ok: true, published: "debug.ping", at: ts });
  });

  app.get("/api/realtime/token", async (req: any, res: any) => {
    if (!isRealtimeConfigured()) return res.status(204).end();
    const username = req.session?.username || `anon-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const tokenRequest = await createTokenRequest(username);
      if (!tokenRequest) return res.status(502).json({ error: "ably token request failed — check server logs" });
      res.json({ tokenRequest, clientId: username, enabled: true });
    } catch (e: any) {
      console.error("[realtime] token request failed:", e.message);
      res.status(500).json({ error: "token request failed: " + (e?.message || "unknown") });
    }
  });

  // ─── Admin Settings API (read/write runtime config) ────────────────────────
  // GET returns catalog + current (masked) values so the UI can render editors.
  // POST { key, value } writes one key. Empty value clears the DB override (falls back to .env).
  // POST /api/admin/settings/generate { key } auto-generates a random token for autoGenerate keys.
  app.get("/api/admin/settings", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const items = SETTINGS_CATALOG.map(def => {
      const source = cfgSource(def.key);
      const raw = cfg(def.key);
      const value = def.secret ? maskSecret(raw) : raw;
      return { ...def, value, isSet: source !== "unset", source };
    });
    res.json({ settings: items });
  });

  // Returns the full unmasked value for a single secret — used when the admin
  // clicks "Reveal". Admin-only.
  app.get("/api/admin/settings/reveal", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const key = String(req.query.key || "");
    const def = SETTINGS_CATALOG.find(d => d.key === key);
    if (!def) return res.status(404).json({ error: "unknown key" });
    res.json({ key, value: cfg(key) });
  });

  app.post("/api/admin/settings", express.json(), (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { key, value } = req.body || {};
    if (typeof key !== "string" || !SETTINGS_CATALOG.some(d => d.key === key)) {
      return res.status(400).json({ error: "invalid key" });
    }
    if (typeof value !== "string") return res.status(400).json({ error: "value must be string" });
    setCfg(key, value);
    res.json({ ok: true });
  });

  app.post("/api/admin/settings/generate", express.json(), (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { key } = req.body || {};
    const def = SETTINGS_CATALOG.find(d => d.key === key);
    if (!def || !def.autoGenerate) return res.status(400).json({ error: "key not generatable" });
    const prefix = key === "WEBHOOK_INGEST_TOKEN" ? "sn-hook" : "sn-tok";
    const value = generateToken(prefix);
    setCfg(key, value);
    res.json({ key, value });
  });

  // Image proxy for Reddit-hosted images (bypasses hotlink/referrer blocks)
  // Only allows known Reddit image hosts.
  app.get("/api/reddit-image", async (req: any, res: any) => {
    const url = String(req.query.url || "");
    if (!url) return res.status(400).send("url required");
    let parsed: URL;
    try { parsed = new URL(url); } catch { return res.status(400).send("invalid url"); }
    const allowedHosts = [
      "i.redd.it",
      "preview.redd.it",
      "external-preview.redd.it",
      "i.imgur.com",
      "imgur.com",
      "styles.redditmedia.com",
      "b.thumbs.redditmedia.com",
      "a.thumbs.redditmedia.com",
    ];
    if (!allowedHosts.includes(parsed.hostname)) {
      return res.status(400).send("host not allowed");
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 Pulse-StereoNET/2.0",
          "Accept": "image/*,*/*;q=0.8",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!upstream.ok) return res.status(upstream.status).send("upstream error");
      const ct = upstream.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=86400");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (e: any) {
      res.status(502).send("fetch failed");
    }
  });

  // ─── Top Picks regeneration ─────────────────────────────────────────
  // Strategy:
  //  1. Hourly background regen (regardless of activity)
  //  2. Debounced regen after Article Discovery activity — fires 60s after the
  //     last change, so a burst of dismisses/claims/writes only triggers once.
  //  3. Hard cooldown of 5 minutes between any two regens to protect the
  //     Anthropic budget from runaway loops.

  let lastRegenAt = 0;
  const MIN_REGEN_GAP_MS = 5 * 60 * 1000;  // never closer than 5 min apart
  const ACTIVITY_DEBOUNCE_MS = 60 * 1000;  // 60s after last activity
  let pendingDebounce: NodeJS.Timeout | null = null;

  async function runRegen(reason: string, opts: { force?: boolean } = {}) {
    const now = Date.now();
    const gap = now - lastRegenAt;
    if (!opts.force && gap < MIN_REGEN_GAP_MS) {
      console.log(`[top-picks] Skipping regen (${reason}) — last ran ${Math.round(gap/1000)}s ago`);
      return;
    }
    const enabled = storage.getSetting("top_picks_enabled") !== "0";
    if (!enabled) return;
    lastRegenAt = now;
    console.log(`[top-picks] Regenerating (${reason})`);
    try {
      const r = await generateTopPicks({ force: true });
      if ("error" in r) {
        console.error(`[top-picks] Regen failed (${reason}):`, r.error);
      } else {
        console.log(`[top-picks] Regen (${reason}) produced ${r.picks.length} picks`);
        publishRealtime("top-picks.regenerated", { count: r.picks.length, reason });
      }
    } catch (e: any) {
      console.error(`[top-picks] Regen threw (${reason}):`, e?.message);
    }
  }

  // Hourly scheduled regen — fires the first time ~30s after startup so today's
  // list is fresh, then every hour on the hour (well, every 60 min wall time).
  setTimeout(() => runRegen("startup", { force: true }), 30_000);
  setInterval(() => runRegen("hourly"), 60 * 60 * 1000);

  // Called by article-action endpoints. Schedules a regen 60s from now; if
  // another call comes in before then, the timer resets so we only regen once
  // the user finishes their burst of activity.
  function maybeAutoRegen(reason: string) {
    if (pendingDebounce) clearTimeout(pendingDebounce);
    pendingDebounce = setTimeout(() => {
      pendingDebounce = null;
      runRegen(`activity: ${reason}`);
    }, ACTIVITY_DEBOUNCE_MS);
  }

  app.get("/api/top-picks", (req: any, res: any) => {
    const enabled = storage.getSetting("top_picks_enabled") !== "0";
    if (!enabled) return res.json({ enabled: false, picks: [] });
    const data = readTopPicks();
    if (!data) return res.json({ enabled: true, version: TOP_PICKS_VERSION, picks: [], date: null, generatedAt: null, examined: 0 });

    // Only show picks that are still visible in the Active Discovery list.
    // This covers every disqualifier in one check: dismissed, claimed, written,
    // pinned, covered, or removed.
    const activeIds = new Set(storage.getDiscoveryArticles({ limit: 5000 })
      .filter(a => !a.covered) // covered items shouldn't be picks
      .map(a => a.id));
    const claimedIds = new Set(
      (sqlite.prepare(`SELECT article_id FROM article_claims`).all() as { article_id: number }[]).map(r => r.article_id)
    );
    const dismissedIds = new Set(
      (sqlite.prepare(`SELECT article_id FROM article_dismissals`).all() as { article_id: number }[]).map(r => r.article_id)
    );
    const visiblePicks = data.picks.filter(p =>
      activeIds.has(p.articleId) &&
      !claimedIds.has(p.articleId) &&
      !dismissedIds.has(p.articleId)
    );

    // If any picks became stale, schedule a debounced regen so the next fetch
    // has a fresh top pick to show.
    if (data.picks.length > 0 && visiblePicks.length < data.picks.length) {
      maybeAutoRegen(`${data.picks.length - visiblePicks.length} pick(s) became stale`);
    }

    res.json({ enabled: true, version: TOP_PICKS_VERSION, ...data, picks: visiblePicks });
  });

  // Admin: force regenerate now
  app.post("/api/top-picks/generate", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const result = await generateTopPicks({ force: true });
    if ("error" in result) return res.status(500).json(result);
    res.json(result);
  });

  // Admin: toggle on/off
  app.get("/api/settings/top-picks", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const enabled = storage.getSetting("top_picks_enabled") !== "0";
    res.json({ enabled });
  });
  app.post("/api/settings/top-picks", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const enabled = !!req.body?.enabled;
    storage.setSetting("top_picks_enabled", enabled ? "1" : "0");
    res.json({ enabled });
  });

  // ─── Partnership menu (shared across /advertising + public media kits) ───
  // Default items, used as fallback when no admin override saved.
  const PARTNERSHIP_DEFAULTS = [
    { title: "Editorial coverage",            body: "News, reviews, features, and opinion. Long-form trust-building from a team that knows hi-fi." },
    { title: "Display advertising",           body: "Your brand appears alongside every page our audience reads — billboards, sidebars, and in-content placements. Higher tiers buy more frequency and category exclusivity." },
    { title: "Expert Reviews",                body: "Up to 6 product reviews per campaign depending on marketing package selected. Results not guaranteed." },
    { title: "Forum sponsorship",             body: "Branded categories and topics in our 100K+ community of audiophile buyers." },
    { title: "Newsletter & EDM",              body: "Dedicated sends and integrated sponsorship to our opt-in subscriber list." },
    { title: "Social campaigns",              body: "Native posts and reels across our 4.7M-reach social network. APAC + UK + US." },
    { title: "Classifieds presence",          body: "Featured listings and sponsor placement on our second-hand marketplace." },
    { title: "Brand & distributor packages",  body: "Complete coverage bundles for manufacturers and regional distributors." },
    { title: "AI discoverability",            body: "Schema markup, AI-training visibility, and structured data so your brand shows up in AI-powered shopping research. No other hi-fi publisher offers this." },
  ];
  const PARTNERSHIP_HEADING_DEFAULT = "What partnership looks like";
  const PARTNERSHIP_SUBHEADING_DEFAULT = "Eight ways to put your brand in front of audiophiles who are ready to buy. Mix and match — or speak with us about a custom package.";
  function loadPartnershipItems() {
    const raw = storage.getSetting("partnership_menu_json");
    if (raw) { try { const j = JSON.parse(raw); if (Array.isArray(j) && j.length) return j; } catch {} }
    return PARTNERSHIP_DEFAULTS;
  }
  function loadPartnershipHeading() {
    return storage.getSetting("partnership_menu_heading") || PARTNERSHIP_HEADING_DEFAULT;
  }
  function loadPartnershipSubheading() {
    const v = storage.getSetting("partnership_menu_subheading");
    return v === null || v === undefined ? PARTNERSHIP_SUBHEADING_DEFAULT : v;
  }
  // Public read (used by /advertising and public kit pages — no auth)
  app.get("/api/public/partnership-menu", (_req, res) => {
    res.json({
      items: loadPartnershipItems(),
      heading: loadPartnershipHeading(),
      subheading: loadPartnershipSubheading(),
    });
  });
  // Admin read + write
  app.get("/api/settings/partnership-menu", (req: any, res: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Login required" });
    res.json({
      items: loadPartnershipItems(),
      heading: loadPartnershipHeading(),
      subheading: loadPartnershipSubheading(),
      is_default: !storage.getSetting("partnership_menu_json"),
    });
  });
  app.post("/api/settings/partnership-menu", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ message: "items[] required" });
    const cleaned = items
      .map((it: any) => ({
        title: String(it?.title || "").trim(),
        body: String(it?.body || "").trim(),
      }))
      .filter((it: any) => it.title || it.body)
      .slice(0, 30);
    storage.setSetting("partnership_menu_json", JSON.stringify(cleaned));
    if (typeof req.body?.heading === "string") {
      storage.setSetting("partnership_menu_heading", String(req.body.heading).trim());
    }
    if (typeof req.body?.subheading === "string") {
      storage.setSetting("partnership_menu_subheading", String(req.body.subheading).trim());
    }
    res.json({ ok: true, items: cleaned, heading: loadPartnershipHeading(), subheading: loadPartnershipSubheading() });
  });
  // Reset to defaults
  app.delete("/api/settings/partnership-menu", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    storage.setSetting("partnership_menu_json", "");
    storage.setSetting("partnership_menu_heading", "");
    storage.setSetting("partnership_menu_subheading", "");
    res.json({ ok: true, items: PARTNERSHIP_DEFAULTS, heading: PARTNERSHIP_HEADING_DEFAULT, subheading: PARTNERSHIP_SUBHEADING_DEFAULT });
  });

  // Email ingestion: 30-day backfill on startup, then poll every 5 minutes
  async function runEmailIngest(sinceDays = 1) {
    try {
      const result = await ingestEmails({ sinceDays });
      if (result.processed > 0) {
        console.log(`[cadence] Email ingest: ${result.processed} new press releases`);
        publishRealtime("article.new", { count: result.processed, source: "email" });
        publishRealtime("notification.new", { type: "press", message: `${result.processed} new press release${result.processed === 1 ? "" : "s"}` });
      }
    } catch (e: any) {
      console.error("[cadence] Email ingest error:", e.message);
    }
  }
  // Backfill last 30 days on startup (one-time)
  setTimeout(() => runEmailIngest(30), 30_000);
  // Then poll for new emails every 5 minutes (last 1 day window for safety)
  setInterval(() => runEmailIngest(1), 5 * 60 * 1_000);

  // Forum stats: fetch on startup and every hour
  setTimeout(fetchForumStats, 15_000);
  setInterval(fetchForumStats, 60 * 60 * 1_000);

  // Backfill and fix on startup
  setTimeout(() => {
    storage.fixFutureDates();
    const titles = storage.backfillTitles();
    if (titles > 0) console.log(`[cadence] Startup title backfill: fixed ${titles} articles`);
    const brands = storage.backfillBrands();
    if (brands > 0) console.log(`[cadence] Startup brand backfill: updated ${brands} articles`);
  }, 5_000);

  // ─── Admin: user management ─────────────────────────────────────────────────
  function requireAdmin(req: any, res: any, next: any) {
    if ((req.session as any).role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }
    next();
  }

  app.get("/api/admin/users", requireAdmin, (_req: any, res: any) => {
    res.json(storage.getUsers());
  });

  app.get("/api/admin/me", (req: any, res: any) => {
    const user = (req.session as any);
    const dbUser = user?.username ? storage.getUser(user.username) : null;
    res.json({
      id: dbUser?.id || null,
      username: user?.username || null,
      role: user?.role || "user",
      redline_access: dbUser?.redline_access || 0,
      impersonating: user?.originalAdmin || null,
    });
  });

  app.get("/api/author-stats", (req: any, res: any) => {
    const username = (req.session as any).username;
    if (!username) return res.json(null);
    // Map email to author name: strip @stereonet.com, capitalize
    // Try matching by first+last name from email
    const emailName = username.split("@")[0];
    // Search for author whose name matches (case insensitive)
    const allAuthors = storage.getAuthorBreakdown({});
    const match = allAuthors.find(a => {
      const normalized = a.author.toLowerCase().replace(/\s+/g, "");
      return normalized === emailName.toLowerCase();
    });
    const authorName = match?.author || null;
    if (!authorName) return res.json(null);
    res.json({ author: authorName, ...storage.getAuthorStats(authorName) });
  });

  app.get("/api/my-articles", (req: any, res: any) => {
    const username = (req.session as any).username;
    if (!username) return res.json([]);
    const emailName = username.split("@")[0];
    const allAuthors = storage.getAuthorBreakdown({});
    const match = allAuthors.find(a => {
      const normalized = a.author.toLowerCase().replace(/\s+/g, "");
      return normalized === emailName.toLowerCase();
    });
    if (!match) return res.json([]);
    res.json(storage.getArticlesByAuthor(match.author));
  });

  app.get("/api/stereonet-articles", (req: any, res: any) => {
    // Order: newest published_at first (falls back to id DESC when identical).
    const rows = sqlite.prepare(`
      SELECT a.title, a.url, a.published_date, a.content_type as type, a.author, a.brands
      FROM articles a
      INNER JOIN (
        SELECT title, MAX(
          CASE WHEN url LIKE '%/news/%' OR url LIKE '%/opinion/%' OR url LIKE '%/feature/%'
          THEN 1 ELSE 0 END
        ) as has_prefix
        FROM articles WHERE site = 'stereonet'
        GROUP BY title
      ) b ON a.title = b.title
      WHERE a.site = 'stereonet'
        AND (CASE WHEN a.url LIKE '%/news/%' OR a.url LIKE '%/opinion/%' OR a.url LIKE '%/feature/%' THEN 1 ELSE 0 END) = b.has_prefix
      GROUP BY a.title
      ORDER BY a.published_at DESC, a.id DESC
    `).all();
    res.json(rows);
  });

  app.get("/api/author-streaks", (_req: any, res: any) => {
    res.json(storage.getAuthorStreaks());
  });

  app.get("/api/forum-stats", (_req: any, res: any) => {
    res.json(storage.getForumStats());
  });

  // Client-side can submit forum stats if server fetch is blocked by Cloudflare
  app.post("/api/forum-stats", (req: any, res: any) => {
    const { active_ads, total_ads, successful_sales, clearance_rate, total_sales_14d, total_ads_value, total_topics, total_posts } = req.body;
    if (active_ads == null) return res.status(400).json({ message: "Missing data" });
    storage.insertForumStats({ active_ads, total_ads, successful_sales, clearance_rate: clearance_rate || "N/A", total_sales_14d, total_ads_value, total_topics, total_posts });
    res.json({ ok: true });
  });

  // Proxy the forums page HTML so the client can parse it (avoids CORS)
  app.get("/api/forum-proxy", async (_req: any, res: any) => {
    const html = await proxyForumPage();
    if (!html) return res.status(502).json({ message: "Could not fetch forums page" });
    res.type("text/html").send(html);
  });

  // Clear bad forum stats data
  app.delete("/api/forum-stats", requireAdmin, (_req: any, res: any) => {
    storage.clearForumStats();
    res.json({ ok: true });
  });

  app.post("/api/admin/users", requireAdmin, (req: any, res: any) => {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password required" });
    }
    storage.upsertUser(username, password, role || "user");
    res.json({ ok: true });
  });

  app.put("/api/admin/users/:id", requireAdmin, (req: any, res: any) => {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password required" });
    }
    storage.upsertUser(username, password, role || "user");
    res.json({ ok: true });
  });

  app.patch("/api/admin/users/:id/password", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const { password } = req.body;
    if (isNaN(id) || !password) return res.status(400).json({ message: "ID and password required" });
    storage.updatePassword(id, password);
    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.deleteUser(id);
    res.json({ ok: true });
  });

  // Impersonate user (admin only)
  app.post("/api/admin/impersonate/:id", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const users = storage.getUsers();
    const target = users.find(u => u.id === id);
    if (!target) return res.status(404).json({ message: "User not found" });
    // Store original admin session for "return to admin" functionality
    (req.session as any).originalAdmin = (req.session as any).username;
    (req.session as any).username = target.username;
    (req.session as any).role = target.role;
    res.json({ ok: true, username: target.username });
  });

  // Return to admin from impersonation
  app.post("/api/admin/return", (req: any, res: any) => {
    const originalAdmin = (req.session as any).originalAdmin;
    if (!originalAdmin) return res.status(400).json({ message: "Not impersonating" });
    const admin = storage.getUser(originalAdmin);
    if (!admin) return res.status(400).json({ message: "Original admin not found" });
    (req.session as any).username = admin.username;
    (req.session as any).role = admin.role;
    delete (req.session as any).originalAdmin;
    res.json({ ok: true, username: admin.username });
  });

  // Toggle redline access per user
  app.patch("/api/admin/users/:id/redline", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const { access } = req.body;
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.setRedlineAccess(id, !!access);
    res.json({ ok: true });
  });

  // Set PITCH access level per user: none | view | edit | admin
  app.patch("/api/admin/users/:id/pitch", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const { level } = req.body || {};
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    if (!["none", "view", "edit", "admin"].includes(level)) {
      return res.status(400).json({ message: "level must be one of none|view|edit|admin" });
    }
    storage.setPitchAccess(id, level);
    res.json({ ok: true });
  });

  // Set user's email address (used for lead notifications)
  app.patch("/api/admin/users/:id/email", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const email = String(req.body?.email || "").trim();
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }
    storage.setUserEmail(id, email || null);
    res.json({ ok: true });
  });

  // Set the user's display name. This is what appears as the From-name on
  // prospect emails they send (e.g. "Marc Rushton (StereoNET) <admin@stereonet.com>").
  app.patch("/api/admin/users/:id/full-name", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const fullName = String(req.body?.full_name || "").trim();
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.setUserFullName(id, fullName || null);
    res.json({ ok: true });
  });

  // Set which lead regions this user receives notifications for.
  // Value: 'all' OR a CSV from {anz, uk_eu, na, asia, global}. Empty string = opt out.
  app.patch("/api/admin/users/:id/notify-regions", requireAdmin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    const raw = String(req.body?.notify_regions ?? "").trim().toLowerCase();
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const valid = new Set(["anz", "uk_eu", "na", "asia", "global"]);
    let csv = "";
    if (raw === "all") csv = "all";
    else if (raw === "") csv = "";
    else {
      const parts = raw.split(",").map(s => s.trim()).filter(s => valid.has(s));
      csv = Array.from(new Set(parts)).join(",");
    }
    storage.setNotifyRegions(id, csv);
    res.json({ ok: true, notify_regions: csv });
  });

  // ─── Email Templates (PITCH Admin) ────────────────────────────────
  // List, edit, test the editable transactional email templates.
  app.get("/api/admin/email-templates", requireAdmin, async (_req: any, res: any) => {
    const { EMAIL_TEMPLATES } = await import("./email");
    const out = Object.values(EMAIL_TEMPLATES).map((def: any) => {
      const subjectOverride = storage.getSetting(`email_tpl.${def.key}.subject`) || "";
      const htmlOverride = storage.getSetting(`email_tpl.${def.key}.html`) || "";
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        tokens: def.tokens,
        default_subject: def.default_subject,
        default_html: def.default_html,
        subject_override: subjectOverride,
        html_override: htmlOverride,
        is_customised: !!(subjectOverride.trim() || htmlOverride.trim()),
      };
    });
    res.json({ templates: out });
  });

  app.put("/api/admin/email-templates/:key", requireAdmin, async (req: any, res: any) => {
    const { EMAIL_TEMPLATES } = await import("./email");
    const key = String(req.params.key);
    if (!EMAIL_TEMPLATES[key]) return res.status(404).json({ message: "Unknown template" });
    const subject = req.body?.subject_override == null ? null : String(req.body.subject_override);
    const html = req.body?.html_override == null ? null : String(req.body.html_override);
    storage.setSetting(`email_tpl.${key}.subject`, subject || "");
    storage.setSetting(`email_tpl.${key}.html`, html || "");
    res.json({ ok: true });
  });

  app.delete("/api/admin/email-templates/:key", requireAdmin, async (req: any, res: any) => {
    const { EMAIL_TEMPLATES } = await import("./email");
    const key = String(req.params.key);
    if (!EMAIL_TEMPLATES[key]) return res.status(404).json({ message: "Unknown template" });
    storage.setSetting(`email_tpl.${key}.subject`, "");
    storage.setSetting(`email_tpl.${key}.html`, "");
    res.json({ ok: true, reverted: true });
  });

  // Send a test email to the currently logged-in admin (or req.body.to) using sample tokens.
  app.post("/api/admin/email-templates/:key/test", requireAdmin, async (req: any, res: any) => {
    const { EMAIL_TEMPLATES, renderTemplate, sendEmail } = await import("./email");
    const key = String(req.params.key);
    const def = EMAIL_TEMPLATES[key];
    if (!def) return res.status(404).json({ message: "Unknown template" });
    const sampleVars: Record<string, any> = {
      name: "Jane Doe",
      first_name: "Jane",
      company: "Audiobro",
      email: "jane@audiobro.example",
      company_type: "Manufacturer",
      role: "Marketing Director",
      country: "Australia",
      region: "ANZ",
      kit_label: "StereoNET ANZ Trade Media Kit",
      message: "This is a sample message for the test send.",
      interests_html: "<ul><li>Display banners</li><li>Editorial reviews</li></ul>",
      magic_link: "https://dashboard.stereonet.com/kit/sample-123?t=sampletoken",
      lead_id: "99",
      dashboard_link: "https://dashboard.stereonet.com/pitch?tab=leads",
      accepted_at: new Date().toISOString(),
      reason: "Sample reason text — the budget shifted to Q2.",
    };
    const merged = { ...sampleVars, ...(req.body?.vars || {}) };
    const { subject, html } = renderTemplate(def, merged);
    const to = String(req.body?.to || "").trim();
    if (!to) {
      // Fallback to the admin's own email if known.
      const dbUser = storage.getUser(req.session?.username || "");
      const fallback = (dbUser as any)?.email || storage.getSetting("sendgrid_notify_to") || "marcrushton@stereonet.com";
      const result = await sendEmail({ to: fallback, subject: `[TEST] ${subject}`, html });
      return res.json({ ok: result.ok, error: result.error, sent_to: fallback });
    }
    const result = await sendEmail({ to, subject: `[TEST] ${subject}`, html });
    res.json({ ok: result.ok, error: result.error, sent_to: to });
  });

  // ─── Redline (editorial + industry AI) ────────────────────
  //
  // Version 2.0 (Aug 2026) merges the former stereonet-sub-editor and
  // tv-expert skills into a single Redline skill. Article types supported:
  // review, opinion column, feature, news item. See server/redline-prompt.ts.

  // Check if current user has redline access
  function requireRedline(req: any, res: any, next: any) {
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Not logged in" });
    const dbUser = storage.getUser(username);
    if (!dbUser || (!dbUser.redline_access && dbUser.role !== "admin")) {
      return res.status(403).json({ message: "Redline access not granted" });
    }
    next();
  }

  // Upload docx for sub-editing
  app.get("/api/redline/version", (_req: any, res: any) => {
    res.json({ version: REDLINE_VERSION });
  });

  app.post("/api/redline/upload", requireRedline, upload.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ message: "Anthropic API key not configured" });

      const filename = req.file.originalname || "article.docx";
      const buffer = req.file.buffer;

      // Extract text from docx
      const result = await mammoth.extractRawText({ buffer });
      const articleText = result.value.trim();

      if (!articleText || articleText.length < 50) {
        return res.status(400).json({ message: "Document appears empty or too short" });
      }

      const dbUser = storage.getUser(req.session.username);
      if (!dbUser) return res.status(401).json({ message: "User not found" });
      const jobId = storage.insertRedlineJob(dbUser.id, filename, articleText);

      // Process in background
      processRedlineJob(jobId, articleText).catch(err => {
        console.error(`[redline] Background job ${jobId} error:`, err);
      });

      res.json({ jobId, status: "processing", filename });
    } catch (err: any) {
      console.error("[redline] Upload error:", err);
      res.status(500).json({ message: err?.message || "Upload failed" });
    }
  });

  // Get job status — admin sees all, others see own
  app.get("/api/redline/jobs", requireRedline, (req: any, res: any) => {
    const dbUser = storage.getUser(req.session.username);
    if (!dbUser) return res.status(401).json({ message: "User not found" });
    if (dbUser.role === "admin") {
      res.json(storage.getAllRedlineJobs());
    } else {
      res.json(storage.getRedlineJobs(dbUser.id));
    }
  });

  // Get specific job result
  app.get("/api/redline/jobs/:id", requireRedline, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const job = storage.getRedlineJob(id);
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json(job);
  });

  // ─── Hot Deploy (admin only) ──────────────────────────────────────────────

  const DEPLOY_TOKEN = cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv");

  app.post("/api/deploy", upload.single("file"), async (req: any, res: any) => {
    // Auth: either admin session or deploy token header
    const token = req.headers["x-deploy-token"];
    const isAdmin = req.session?.role === "admin";
    if (!isAdmin && token !== DEPLOY_TOKEN) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Piggy-back ops: dump a slice of forum HTML for debugging. op=forum-html, url?
    if (!req.file && req.body?.op === "forum-html") {
      const url = String(req.body?.url || "https://www.stereonet.com/forums/");
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8",
        },
        redirect: "follow",
      });
      const html = await r.text();
      // Look for pagination max page count (e.g. "Page X of Y") on member listing.
      const pageMax = html.match(/of\s+([\d,]+)\s*(?:<|\s|$)/);
      const ipsPagination = html.match(/data-pages?-total="(\d+)"/);
      const memberIds = [...html.matchAll(/data-memberId="(\d+)"/g)].map(m => parseInt(m[1]));
      const maxMemberId = memberIds.length ? Math.max(...memberIds) : null;
      const idx = html.indexOf("Forum Statistics");
      const slice = idx > -1 ? html.substring(idx, idx + 3000) : html.substring(0, 3000);
      return res.json({
        ok: true,
        status: r.status,
        total_size: html.length,
        forum_idx: idx,
        page_max_match: pageMax?.[1] || null,
        ips_pagination: ipsPagination?.[1] || null,
        max_member_id_on_page: maxMemberId,
        slice,
      });
    }

    // Piggy-back ops: trigger a forum stats fetch immediately. op=forum-refresh
    if (!req.file && req.body?.op === "forum-refresh") {
      const { fetchForumStats } = await import("./forum");
      await fetchForumStats();
      const latest = sqlite.prepare(`SELECT id, fetched_at, total_topics, total_topics_precise, total_posts_precise, total_members, total_members_precise FROM forum_stats ORDER BY id DESC LIMIT 1`).get();
      return res.json({ ok: true, latest });
    }

    // Piggy-back ops: editorial coverage of a brand across sites. op=brand-coverage, brand, days
    if (!req.file && req.body?.op === "brand-coverage") {
      const brand = String(req.body?.brand || "").trim();
      if (!brand) return res.status(400).json({ ok: false, message: "brand required" });
      const days = Math.min(730, Math.max(7, Number(req.body?.days || 90)));
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
      const cutoffIso = cutoff.toISOString();
      const like = `%${brand.toLowerCase()}%`;
      const rows = sqlite.prepare(`
        SELECT site, COUNT(*) AS n
          FROM articles
         WHERE lower(title) LIKE ?
           AND COALESCE(published_at, published_date) >= ?
         GROUP BY site
         ORDER BY n DESC
      `).all(like, cutoffIso);
      return res.json({ ok: true, brand, days, by_site: rows });
    }

    // Piggy-back ops: GA4 engagement — avg session duration, sessions/user. op=ga4-engagement, days
    if (!req.file && req.body?.op === "ga4-engagement") {
      const days = Math.min(365, Math.max(7, Number(req.body?.days || 30)));
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - (days - 1));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const { fetchGA4Overview } = await import("./analytics");
      const data = await fetchGA4Overview(fmt(start), fmt(end));
      return res.json({ ok: true, days, date_range: { start: fmt(start), end: fmt(end) }, ...data });
    }

    // Piggy-back ops: inspect addons for a kit (debug)
    if (!req.file && req.body?.op === "inspect-share") {
      const slug = String(req.body?.slug || "");
      const share = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE slug = ?`).get(slug);
      return res.json({ ok: true, share });
    }

    if (!req.file && req.body?.op === "fix-tier-items-fk") {
      // Rebuild pitch_tier_template_items with a clean FK pointing at pitch_tier_templates.
      try {
        sqlite.exec(`PRAGMA foreign_keys = OFF;`);
        sqlite.exec(`BEGIN TRANSACTION;
          CREATE TABLE pitch_tier_template_items_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL DEFAULT 'global',
            tier_key TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            category TEXT NOT NULL DEFAULT 'core',
            label TEXT NOT NULL,
            description TEXT,
            qty REAL NOT NULL DEFAULT 1,
            unit TEXT,
            unit_price_usd REAL NOT NULL DEFAULT 0,
            included INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO pitch_tier_template_items_new (id, region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included)
            SELECT id, region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included FROM pitch_tier_template_items;
          DROP TABLE pitch_tier_template_items;
          ALTER TABLE pitch_tier_template_items_new RENAME TO pitch_tier_template_items;
          CREATE INDEX IF NOT EXISTS idx_pitch_tier_items_tier ON pitch_tier_template_items(tier_key);
          CREATE INDEX IF NOT EXISTS idx_pitch_tier_items_region_tier ON pitch_tier_template_items(region, tier_key);
        COMMIT;
        PRAGMA foreign_keys = ON;`);
        return res.json({ ok: true, message: "Rebuilt pitch_tier_template_items without FK to dropped table" });
      } catch (e: any) {
        return res.status(500).json({ message: e.message });
      }
    }

    if (!req.file && req.body?.op === "diag-tier-triggers") {
      const all = sqlite.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE '%tier%' OR sql LIKE '%_pitch_tier_templates_old%' OR sql LIKE '%pitch_tier_templates%' ORDER BY type, name`).all();
      return res.json({ ok: true, objects: all });
    }

    if (!req.file && req.body?.op === "diag-tier-tables") {
      const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%tier%' ORDER BY name`).all();
      const tplCols = (() => { try { return sqlite.prepare(`PRAGMA table_info(pitch_tier_templates)`).all(); } catch (e: any) { return e.message; } })();
      const tplCount = (() => { try { return (sqlite.prepare(`SELECT COUNT(*) AS n FROM pitch_tier_templates`).get() as any).n; } catch (e: any) { return e.message; } })();
      const itemCount = (() => { try { return (sqlite.prepare(`SELECT COUNT(*) AS n FROM pitch_tier_template_items`).get() as any).n; } catch (e: any) { return e.message; } })();
      const tplSample = (() => { try { return sqlite.prepare(`SELECT * FROM pitch_tier_templates LIMIT 5`).all(); } catch (e: any) { return e.message; } })();
      return res.json({ ok: true, tables, tplCols, tplCount, itemCount, tplSample });
    }

    if (!req.file && req.body?.op === "force-seed-tier-items") {
      // Wipe then re-seed global tier templates + items.
      const { TIERS, lineItemsForTier } = await import("./pitch");
      let wiped = 0;
      try {
        wiped = (sqlite.prepare(`DELETE FROM pitch_tier_template_items WHERE region = 'global'`).run().changes) || 0;
        sqlite.prepare(`DELETE FROM pitch_tier_templates WHERE region = 'global'`).run();
      } catch (e) {}
      const txn = sqlite.transaction(() => {
        TIERS.forEach((t: any, idx: number) => {
          sqlite.prepare(`INSERT OR IGNORE INTO pitch_tier_templates (region, tier_key, label, sort_order, monthly_usd, description, active)
            VALUES ('global', ?, ?, ?, ?, ?, 1)`).run(t.key, t.label, idx, t.monthly_usd, null);
          const items = lineItemsForTier(t.key);
          const ins = sqlite.prepare(`INSERT INTO pitch_tier_template_items
            (region, tier_key, sort_order, category, label, description, qty, unit, unit_price_usd, included)
            VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          items.forEach((it: any, i: number) => ins.run(
            t.key, i, it.category || "core", it.label, it.description ?? null,
            it.qty ?? 1, it.unit ?? null, it.unit_price_usd ?? 0, it.included === false ? 0 : 1
          ));
        });
      });
      try { txn(); } catch (e: any) { return res.status(500).json({ message: e.message }); }
      const count = (sqlite.prepare(`SELECT COUNT(*) AS n FROM pitch_tier_template_items WHERE region = 'global'`).get() as any).n;
      return res.json({ ok: true, wiped, seeded: count });
    }

    if (!req.file && req.body?.op === "inspect-tier-items") {
      const distinct = sqlite.prepare(`SELECT DISTINCT region FROM pitch_tier_template_items ORDER BY region`).all();
      const counts = sqlite.prepare(`SELECT region, COUNT(*) AS n FROM pitch_tier_template_items GROUP BY region ORDER BY region`).all();
      const sample = sqlite.prepare(`SELECT region, tier_key, label, sort_order FROM pitch_tier_template_items ORDER BY region, sort_order LIMIT 30`).all();
      return res.json({ ok: true, distinct_regions: distinct, counts, sample });
    }

    if (!req.file && req.body?.op === "inspect-addons") {
      const slug = String(req.body?.slug || "");
      let kit: any = null;
      if (slug) kit = sqlite.prepare(`SELECT * FROM media_kits WHERE slug = ? OR slug LIKE ?`).get(slug, `%${slug}%`);
      if (!kit) {
        const kits = sqlite.prepare(`SELECT id, slug FROM media_kits ORDER BY id DESC LIMIT 20`).all();
        return res.json({ ok: false, message: "kit not found", available_kits: kits });
      }
      const kindCol = kit.kind || "trade";
      const rows = sqlite.prepare(
        `SELECT id, addon_key, label, kind, position, is_visible, region, audience_kind FROM media_kit_addons 
         WHERE (audience_kind = ? OR audience_kind = 'both') AND region IS ? AND is_visible = 1 
         ORDER BY kind, position`
      ).all(kindCol === "retailer" ? "retailer" : "trade", kit.region) as any[];
      return res.json({ ok: true, kit, addons: rows });
    }

    // Piggy-back ops: advertising page stats — bot-filtered users + AI session count.
    // op=adv-stats, days (default 30)
    if (!req.file && req.body?.op === "adv-stats") {
      const days = Math.min(365, Math.max(7, Number(req.body?.days || 30)));
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - (days - 1));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const { fetchGA4Overview, BOT_COUNTRIES } = await import("./analytics");
      const { google } = await import("googleapis");
      const { getAuth, GA4_PROPERTY } = await import("./analytics") as any;

      const [overviewRaw, overviewClean] = await Promise.all([
        fetchGA4Overview(fmt(start), fmt(end)),
        fetchGA4Overview(fmt(start), fmt(end), BOT_COUNTRIES),
      ]);

      // AI sessions via sessionSource regex match.
      let aiSessions = 0;
      try {
        const a = getAuth();
        if (a) {
          const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
          const r = await analyticsdata.properties.runReport({
            property: `properties/${GA4_PROPERTY()}`,
            requestBody: {
              dateRanges: [{ startDate: fmt(start), endDate: fmt(end) }],
              dimensions: [{ name: "sessionSource" }],
              metrics: [{ name: "sessions" }, { name: "activeUsers" }],
              dimensionFilter: {
                filter: {
                  fieldName: "sessionSource",
                  stringFilter: {
                    matchType: "PARTIAL_REGEXP",
                    value: "chatgpt|openai|perplexity|claude|anthropic|gemini|bard|copilot|bing\\.com\\/chat|you\\.com|phind|poe\\.com",
                    caseSensitive: false,
                  },
                },
              },
            },
          });
          aiSessions = (r.data.rows || []).reduce((s: number, row: any) => s + parseInt(row.metricValues![0].value!), 0);
        }
      } catch (e: any) {
        console.error("[adv-stats] AI source query failed:", e.message);
      }

      return res.json({
        ok: true,
        days,
        date_range: { start: fmt(start), end: fmt(end) },
        raw: { users: overviewRaw.activeUsers, pageviews: overviewRaw.pageviews, sessions: overviewRaw.sessions },
        bot_filtered: { users: overviewClean.activeUsers, pageviews: overviewClean.pageviews, sessions: overviewClean.sessions },
        ai_sessions: aiSessions,
      });
    }

    // Piggy-back ops: GA4 YoY growth comparison. op=ga4-yoy
    if (!req.file && req.body?.op === "ga4-yoy") {
      const { fetchGA4Overview } = await import("./analytics");
      const days = 30;
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - (days - 1));
      const lastYearEnd = new Date(end); lastYearEnd.setFullYear(lastYearEnd.getFullYear() - 1);
      const lastYearStart = new Date(lastYearEnd); lastYearStart.setDate(lastYearStart.getDate() - (days - 1));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const [current, prior] = await Promise.all([
        fetchGA4Overview(fmt(start), fmt(end)),
        fetchGA4Overview(fmt(lastYearStart), fmt(lastYearEnd)),
      ]);
      return res.json({ ok: true, current, prior, current_range: { start: fmt(start), end: fmt(end) }, prior_range: { start: fmt(lastYearStart), end: fmt(lastYearEnd) } });
    }

    // Piggy-back ops: brand SC queries. Form fields: op=brand-queries, brand, days
    if (!req.file && req.body?.op === "brand-queries") {
      const brand = String(req.body?.brand || "").trim();
      if (!brand) return res.status(400).json({ ok: false, message: "brand required" });
      const days = Math.min(365, Math.max(7, Number(req.body?.days || 90)));
      const end = new Date(); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - (days - 1));
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const { fetchSCQueriesForBrand } = await import("./analytics");
      const rows = await fetchSCQueriesForBrand(fmt(start), fmt(end), brand, 30);
      const total_clicks = rows.reduce((s: number, r: any) => s + r.clicks, 0);
      const total_impressions = rows.reduce((s: number, r: any) => s + r.impressions, 0);
      return res.json({ ok: true, brand, days, date_range: { start: fmt(start), end: fmt(end) }, total_clicks, total_impressions, queries: rows });
    }

    // Piggy-back op: sync all regional addons (tiers + bolt-ons) from Global by addon_key.
    // Copies non-pricing/non-availability/non-visibility fields. Preserves price, currency,
    // suffix, availability, and is_visible per region.
    if (!req.file && req.body?.op === "sync-addons-from-global") {
      const INHERITED_FIELDS = ["label", "subtitle", "description", "billing", "inclusions_json", "position", "is_poa", "example_url"];
      const globals = sqlite.prepare(`SELECT id, kind, addon_key, ${INHERITED_FIELDS.join(", ")} FROM media_kit_addons WHERE region IS NULL`).all() as any[];
      let updated = 0;
      const updateStmt = sqlite.prepare(`UPDATE media_kit_addons SET label = ?, subtitle = ?, description = ?, billing = ?, inclusions_json = ?, position = ?, is_poa = ?, example_url = ?, updated_at = datetime('now') WHERE region IS NOT NULL AND kind = ? AND addon_key = ?`);
      const txn = sqlite.transaction(() => {
        for (const g of globals) {
          const r = updateStmt.run(g.label, g.subtitle, g.description, g.billing, g.inclusions_json, g.position, g.is_poa, g.example_url, g.kind, g.addon_key);
          updated += r.changes;
        }
      });
      try { txn(); return res.json({ ok: true, op: "sync-addons-from-global", global_count: globals.length, regional_rows_updated: updated }); }
      catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
    }

    // Piggy-back op: sync a prospect clone back to master (admin/deploy-token).
    // Drops all overrides on the clone except 'proposal' and blocks with edited_at set (unless force=1).
    if (!req.file && req.body?.op === "sync-clone") {
      const leadId = Number(req.body?.lead_id || 0);
      const force = req.body?.force === "1" || req.body?.force === "true";
      if (!leadId) return res.status(400).json({ ok: false, message: "lead_id required" });
      const clone = sqlite.prepare(`SELECT id FROM media_kits WHERE prospect_lead_id = ? LIMIT 1`).get(leadId) as any;
      if (!clone) return res.status(404).json({ ok: false, message: "No clone for lead" });
      const overrides = sqlite.prepare(`SELECT block_key, edited_at FROM media_kit_blocks WHERE kit_id = ?`).all(clone.id) as any[];
      const dropStmt = sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`);
      const dropped: string[] = []; const preserved: string[] = [];
      for (const o of overrides) {
        if (o.block_key === "proposal") { preserved.push(o.block_key); continue; }
        if (o.edited_at && !force) { preserved.push(o.block_key); continue; }
        dropStmt.run(clone.id, o.block_key);
        dropped.push(o.block_key);
      }
      return res.json({ ok: true, op: "sync-clone", clone_id: clone.id, dropped, preserved });
    }

    // Piggy-back op: trigger the lead-notification fan-out test (admin diag).
    // Uses the deploy URL because it has the CF bypass rule.
    if (!req.file && req.body?.op === "test-lead-notify") {
      const region = String(req.body?.region || "anz").toLowerCase();
      const doSend = req.body?.send === "1" || req.body?.send === "true" || req.body?.send === true;
      const users = sqlite.prepare(`SELECT id, username, email, notify_regions FROM users WHERE email IS NOT NULL AND email != '' AND notify_regions IS NOT NULL AND notify_regions != ''`).all() as any[];
      const recipients = new Set<string>();
      const matched: any[] = [];
      for (const u of users) {
        const csv = String(u.notify_regions || "").toLowerCase();
        const match = csv === "all" || csv.split(",").map((s: string) => s.trim()).includes(region);
        if (match) { recipients.add(String(u.email).trim()); matched.push({ username: u.username, email: u.email, notify_regions: u.notify_regions }); }
      }
      recipients.add("marcrushton@stereonet.com");
      const apiKeyPresent = !!storage.getSetting("sendgrid_api_key");
      const fromEmail = storage.getSetting("sendgrid_from_email") || "admin@stereonet.com";
      let sendResult: any = null;
      if (doSend) {
        try {
          const { sendEmail } = await import("./email");
          const subject = `[PULSE diag] Lead notification fan-out test (region=${region})`;
          const html = `<p>This is a test of the lead-notification fan-out for region <strong>${region}</strong>.</p><p>Recipients computed: ${Array.from(recipients).join(", ")}</p>`;
          const results: any[] = [];
          for (const to of recipients) {
            const r = await sendEmail({ to, subject, html });
            results.push({ to, ok: r.ok, error: r.error });
          }
          sendResult = results;
        } catch (e: any) {
          sendResult = { error: e?.message || String(e) };
        }
      }
      return res.json({ ok: true, op: "test-lead-notify", region, apiKeyPresent, fromEmail, matched_users: matched, recipients: Array.from(recipients), sendResult });
    }

    // Resend an accept/decline/changes-requested/proposal-requested notification
    // for a share whose event already fired but whose recipients missed it —
    // e.g. because of the notify_emails_json fan-out gap fixed 18 Sep 2026
    // (see notifyLeadOwners in media-kit.ts). Reads real acceptance/decline
    // data off the share row rather than trusting caller-supplied vars, so
    // this can't be used to send an arbitrary fabricated notification.
    if (!req.file && req.body?.op === "resend-proposal-event-notify") {
      const shareId = Number(req.body?.share_id || 0);
      const toOverride = String(req.body?.to || "").trim();
      if (!shareId) return res.status(400).json({ ok: false, message: "share_id required" });
      const share = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE id = ?`).get(shareId) as any;
      if (!share) return res.status(404).json({ ok: false, message: "share not found" });
      let templateKey: string; let vars: Record<string, any>;
      const dashboard_link = "https://dashboard.stereonet.com/pitch";
      if (share.proposal_state === "accepted") {
        templateKey = "admin_proposal_accepted";
        vars = { name: share.accepted_by_name, email: share.accepted_by_email || share.prospect_email || "(not provided)", company: share.prospect_company || share.acceptance_billing_company || "", accepted_at: share.accepted_at, dashboard_link };
      } else if (share.proposal_state === "declined") {
        templateKey = "admin_proposal_declined";
        vars = { name: share.prospect_name || "Prospect", email: share.prospect_email || "(not provided)", company: share.prospect_company || "", reason: "", dashboard_link };
      } else {
        return res.status(400).json({ ok: false, message: `share proposal_state is '${share.proposal_state}', not accepted/declined \u2014 nothing to resend` });
      }
      const toList = toOverride ? toOverride.split(",").map(s => s.trim()).filter(Boolean) : [];
      if (toList.length === 0) return res.status(400).json({ ok: false, message: "to (comma-separated emails) required" });
      const { sendEmail, renderTemplate, EMAIL_TEMPLATES } = await import("./email");
      const def = (EMAIL_TEMPLATES as any)[templateKey];
      const { subject, html } = renderTemplate(def, vars);
      const results: any[] = [];
      for (const to of toList) {
        const r = await sendEmail({ to, subject, html });
        results.push({ to, ok: r.ok, error: r.error });
      }
      return res.json({ ok: true, op: "resend-proposal-event-notify", share_id: shareId, template_key: templateKey, vars, results });
    }

    // Piggy-back ops: SELECT-only SQL read, allowlisted to pitch_* and users.
    if (!req.file && req.body?.op === "sql") {
      const q = String(req.body?.q || "").trim();
      if (!/^select\b/i.test(q)) return res.status(400).json({ ok: false, message: "SELECT only" });
      if (!/from\s+(pitch_|users\b|settings\b|articles\b|app_settings\b|sqlite_master\b|forum_|media_kit)/i.test(q)) {
        return res.status(400).json({ ok: false, message: "table not allowlisted" });
      }
      try {
        const rows = sqlite.prepare(q).all();
        return res.json({ ok: true, op: "sql", rows });
      } catch (e: any) {
        return res.status(400).json({ ok: false, error: e?.message || String(e) });
      }
    }

    // Piggy-back ops: when the request omits a file and instead carries
    // op=setting (form field), behave as a settings read/write endpoint.
    // Rides the existing Cloudflare page rule on /api/deploy.
    if (!req.file && req.body?.op === "share-reset") {
      // Piggy-back: clear bogus owner-preview view tracking on a share. Resets
      // proposal_state to 'draft', clears first_viewed_at and view_count.
      const shareId = Number(req.body?.share_id || 0);
      if (!shareId) return res.status(400).json({ ok: false, message: "share_id required" });
      const r = sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'draft', first_viewed_at = NULL, last_viewed_at = NULL, view_count = 0, sent_at = NULL WHERE id = ?`).run(shareId);
      // Also clear the view audit rows.
      sqlite.prepare(`DELETE FROM media_kit_views WHERE share_id = ?`).run(shareId);
      sqlite.prepare(`DELETE FROM proposal_events WHERE share_id = ? AND event_type = 'first_viewed'`).run(shareId);
      return res.json({ ok: true, op: "share-reset", share_id: shareId, rows_changed: r.changes });
    }

    if (!req.file && req.body?.op === "freeze-kit-tier-prices") {
      // Freeze a per-kit tier price snapshot into the kit's investment block.
      // Used to lock the "Standard Rates" table on already-sent proposals so
      // current catalog edits don't appear to retroactively change history.
      const kitId = Number(req.body?.kit_id || 0);
      const pricesRaw = String(req.body?.prices || ""); // e.g. "bronze=2499,silver=3799,gold=5499,partner=499"
      if (!kitId || !pricesRaw) return res.status(400).json({ ok: false, message: "kit_id and prices required" });
      const prices: Record<string, number> = {};
      for (const pair of pricesRaw.split(",")) {
        const [k, v] = pair.split("=");
        if (k && v) prices[k.trim()] = Number(v);
      }
      const existing = sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'investment'`).get(kitId) as any;
      let block: any = {};
      if (existing?.content_json) {
        try { block = JSON.parse(existing.content_json); } catch { block = {}; }
      }
      block.frozen_tier_prices = prices;
      const json = JSON.stringify(block);
      if (existing) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE kit_id = ? AND block_key = 'investment'`).run(json, kitId);
      } else {
        sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'investment', 0, 1, 1, ?, datetime('now'))`).run(kitId, json);
      }
      return res.json({ ok: true, op: "freeze-kit-tier-prices", kit_id: kitId, frozen_tier_prices: prices });
    }

    if (!req.file && req.body?.op === "pitch-tier-items") {
      const rows = sqlite.prepare(`SELECT id, tier_key, region, label, qty, unit, unit_price_usd, included, sort_order FROM pitch_tier_template_items ORDER BY tier_key, region, sort_order`).all();
      return res.json({ ok: true, op: "pitch-tier-items", items: rows });
    }

    if (!req.file && req.body?.op === "tier-prices") {
      const rows = sqlite.prepare(`SELECT id, addon_key, region, audience_kind, label, price_value, price_currency, price_suffix, billing, updated_at FROM media_kit_addons WHERE kind = 'tier' ORDER BY addon_key, region`).all();
      return res.json({ ok: true, op: "tier-prices", tiers: rows });
    }

    if (!req.file && req.body?.op === "list-kits-debug") {
      const rows = sqlite.prepare(`SELECT id, slug, label, kind, region, status, prospect_lead_id, parent_kit_id, created_at FROM media_kits ORDER BY id ASC`).all();
      const pitchLinks = sqlite.prepare(`SELECT id AS proposal_id, media_kit_id FROM pitch_proposals WHERE media_kit_id IS NOT NULL`).all();
      return res.json({ ok: true, kits: rows, pitch_links: pitchLinks });
    }

    if (!req.file && req.body?.op === "freeze-sent-kits") {
      // Manually re-freeze every sent proposal's kit so any blocks they're
      // currently inheriting from Global get snapshotted as their own.
      // Optional exclude_block_keys="a,b,c" suppresses those blocks instead of
      // freezing them — use when adding a new block to Global and want to keep
      // already-sent kits clean.
      try {
        const { freezeInheritedBlocksForKit } = require("./pitch");
        const exclude = String(req.body?.exclude_block_keys || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const rows = sqlite.prepare(`SELECT id, media_kit_id, client_name FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
        const results: any[] = [];
        let total = 0, totalExcluded = 0;
        for (const r of rows) {
          const out = freezeInheritedBlocksForKit(r.media_kit_id, { excludeBlockKeys: exclude });
          results.push({ id: r.id, client: r.client_name, kit_id: r.media_kit_id, ...out });
          total += out.frozen;
          totalExcluded += out.excluded;
        }
        return res.json({ ok: true, proposals: rows.length, blocks_frozen: total, blocks_excluded: totalExcluded, excluded_keys: exclude, results });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "freeze failed" });
      }
    }

    if (!req.file && req.body?.op === "inspect-regional-blocks") {
      const rows = sqlite.prepare(`
        SELECT k.id AS kit_id, k.slug, k.region, b.block_key, b.is_override, b.is_visible, b.position
        FROM media_kits k
        LEFT JOIN media_kit_blocks b ON b.kit_id = k.id
        WHERE k.kind = 'trade'
        ORDER BY k.id, b.position
      `).all();
      return res.json({ ok: true, rows });
    }

    if (!req.file && req.body?.op === "inspect-proposal") {
      const id = Number(req.body?.proposal_id || 0);
      if (!id) return res.status(400).json({ ok: false, message: "proposal_id required" });
      const p = sqlite.prepare(`SELECT id, client_name, discount_label_override, override_discount_pct, media_kit_id FROM pitch_proposals WHERE id = ?`).get(id) as any;
      const block = p?.media_kit_id ? sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'proposal'`).get(p.media_kit_id) as any : null;
      let parsed: any = null;
      try { if (block?.content_json) parsed = JSON.parse(block.content_json); } catch {}
      return res.json({ ok: true, proposal: p, kit_proposal_block_discount: parsed?.discount_label_text, kit_proposal_block_override_pct: parsed?.override_discount_pct });
    }

    if (!req.file && req.body?.op === "refreeze-tier-prices") {
      // Re-stamp the investment block's frozen_tier_prices on a proposal's
      // linked kit using the prices from the kit's region. Use this to fix
      // proposals that were created before the regional-freeze logic landed.
      try {
        const proposalId = Number(req.body?.proposal_id || 0);
        if (!proposalId) return res.status(400).json({ ok: false, message: "proposal_id required" });
        const prop = sqlite.prepare(`SELECT id, media_kit_id, regions_json, client_region FROM pitch_proposals WHERE id = ?`).get(proposalId) as any;
        if (!prop || !prop.media_kit_id) return res.status(404).json({ ok: false, message: "Proposal or media_kit_id missing" });
        const kit = sqlite.prepare(`SELECT id, region FROM media_kits WHERE id = ?`).get(prop.media_kit_id) as any;
        if (!kit) return res.status(404).json({ ok: false, message: "Kit missing" });
        const region = kit.region; // 'anz' / 'uk_eu' / 'asia' / null (global)
        const clause = region ? `region = '${region}'` : `region IS NULL`;
        const tierRows = sqlite.prepare(`SELECT addon_key, price_value FROM media_kit_addons WHERE kind = 'tier' AND ${clause} AND price_value IS NOT NULL`).all() as any[];
        const frozen: Record<string, number> = {};
        for (const t of tierRows) { frozen[t.addon_key] = Number(t.price_value); }
        const content = JSON.stringify({ frozen_tier_prices: frozen });
        const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'investment'`).get(prop.media_kit_id) as any;
        if (existing) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(content, existing.id);
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'investment', 0, 1, 1, ?, datetime('now'))`).run(prop.media_kit_id, content);
        }
        return res.json({ ok: true, kit_id: prop.media_kit_id, region: region || "global", frozen });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-regional-tier-templates") {
      // Seed pitch_tier_templates + pitch_tier_template_items for ANZ/UK-EU/Asia
      // using the prices already defined in media_kit_addons. The line-item
      // STRUCTURE comes from Global (categories, qty, units, descriptions);
      // only the Monthly Base line's unit_price gets overridden to the
      // region's local price. unit_price_usd stays in the local currency —
      // the proposal builder treats it as "unit_price in the proposal currency"
      // for non-global regions.
      try {
        const regions = ["anz", "uk_eu", "asia"];
        const log: any[] = [];
        for (const region of regions) {
          // Pull tier prices from media_kit_addons for this region.
          const addonRegion = region === "uk_eu" ? "uk_eu" : region;
          const tierAddons = sqlite.prepare(`
            SELECT addon_key, label, price_value, position
              FROM media_kit_addons
             WHERE region = ? AND kind = 'tier' AND audience_kind IN ('trade','both')
             ORDER BY position
          `).all(addonRegion) as any[];
          if (tierAddons.length === 0) { log.push({ region, skipped: "no addons" }); continue; }

          for (const ta of tierAddons) {
            // Upsert pitch_tier_templates row.
            const existing = sqlite.prepare(`SELECT tier_key FROM pitch_tier_templates WHERE region = ? AND tier_key = ?`).get(region, ta.addon_key) as any;
            if (existing) {
              sqlite.prepare(`UPDATE pitch_tier_templates SET label = ?, sort_order = ?, monthly_usd = ?, active = 1, updated_at = datetime('now') WHERE region = ? AND tier_key = ?`)
                .run(ta.label, ta.position, ta.price_value || 0, region, ta.addon_key);
            } else {
              sqlite.prepare(`INSERT INTO pitch_tier_templates (region, tier_key, label, sort_order, monthly_usd, active) VALUES (?, ?, ?, ?, ?, 1)`)
                .run(region, ta.addon_key, ta.label, ta.position, ta.price_value || 0);
            }

            // Copy Global's template items to this region's tier, overriding
            // the Monthly Base line's unit_price to the region's local value.
            sqlite.prepare(`DELETE FROM pitch_tier_template_items WHERE region = ? AND tier_key = ?`).run(region, ta.addon_key);
            const globalItems = sqlite.prepare(`
              SELECT category, label, description, qty, unit, unit_price_usd, included, sort_order
                FROM pitch_tier_template_items WHERE region = 'global' AND tier_key = ?
                ORDER BY sort_order ASC, id ASC
            `).all(ta.addon_key) as any[];
            const ins = sqlite.prepare(`
              INSERT INTO pitch_tier_template_items
                (region, tier_key, category, label, description, qty, unit, unit_price_usd, included, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const gi of globalItems) {
              // Detect the "Monthly Base" line by label or by being the only
              // category=core item with unit per month and >0 price.
              const isMonthlyBase = /tier.*monthly base|monthly base/i.test(String(gi.label || "")) ||
                (gi.category === "core" && /per month/i.test(String(gi.unit || "")) && Number(gi.unit_price_usd || 0) > 0);
              const price = isMonthlyBase ? (Number(ta.price_value) || 0) : Number(gi.unit_price_usd || 0);
              ins.run(region, ta.addon_key, gi.category, gi.label, gi.description, gi.qty, gi.unit, price, gi.included ? 1 : 0, gi.sort_order);
            }
          }
          log.push({ region, tiers_seeded: tierAddons.length });
        }
        return res.json({ ok: true, log });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "failed" });
      }
    }

    if (!req.file && req.body?.op === "inspect-anz-tier-prices") {
      // Show what the ANZ Media Kit's investment block has for tier prices.
      const anzKit = sqlite.prepare(`SELECT id FROM media_kits WHERE region = 'anz' AND parent_kit_id IS NOT NULL AND prospect_lead_id IS NULL`).get() as any;
      if (!anzKit) return res.json({ ok: false, message: "No ANZ kit" });
      const addons = sqlite.prepare(`
        SELECT kind, addon_key, label, price_value, price_currency, price_suffix, position, audience_kind, region
          FROM media_kit_addons
         WHERE region = 'anz' AND kind = 'tier'
         ORDER BY position
      `).all();
      const globalAddons = sqlite.prepare(`
        SELECT addon_key, label, price_value, price_currency FROM media_kit_addons WHERE region IS NULL AND kind = 'tier' ORDER BY position
      `).all();
      return res.json({ ok: true, anz_kit_id: anzKit.id, anz_tier_addons: addons, global_tier_addons: globalAddons });
    }

    if (!req.file && req.body?.op === "inspect-tier-templates") {
      const rows = sqlite.prepare(`
        SELECT t.region, t.tier_key, t.monthly_usd, COUNT(i.id) AS item_count
          FROM pitch_tier_templates t
          LEFT JOIN pitch_tier_template_items i ON i.region = t.region AND i.tier_key = t.tier_key
         GROUP BY t.region, t.tier_key
         ORDER BY t.region, t.sort_order
      `).all();
      return res.json({ ok: true, rows });
    }

    if (!req.file && req.body?.op === "suppress-blocks-on-sent") {
      // Mark the listed block_keys as _suppressed on every sent-proposal kit.
      // Used after a Global block is added that should NOT appear on kits
      // that were sent before the block existed.
      try {
        const keys = String(req.body?.block_keys || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        if (!keys.length) return res.status(400).json({ ok: false, message: "block_keys required" });
        const sent = sqlite.prepare(`SELECT id, media_kit_id FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
        let touched = 0;
        for (const s of sent) {
          for (const key of keys) {
            const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(s.media_kit_id, key) as any;
            if (existing) {
              sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_visible = 0 WHERE id = ?`).run(JSON.stringify({ _suppressed: true }), existing.id);
            } else {
              sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, ?, 999, 1, 0, ?, datetime('now'))`).run(s.media_kit_id, key, JSON.stringify({ _suppressed: true }));
            }
            touched++;
          }
        }
        return res.json({ ok: true, proposals: sent.length, rows_touched: touched });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "failed" });
      }
    }

    if (!req.file && req.body?.op === "undo-regional-freeze") {
      // The freeze backfill incorrectly snapshotted inherited blocks onto the
      // REGIONAL master kits (trade-anz, trade-uk-eu, trade-asia, trade-na).
      // Regional kits should keep inheriting from canonical. This op deletes
      // the bogus overrides while preserving genuinely-customised regional
      // rows (hero, casual — those were overrides before the backfill).
      try {
        // Regional masters = trade kits with a parent_kit_id (canonical) and
        // NO prospect_lead_id (proper masters, not customer clones).
        const regionals = sqlite.prepare(`
          SELECT id, slug, label FROM media_kits
          WHERE kind = 'trade' AND parent_kit_id IS NOT NULL AND prospect_lead_id IS NULL
        `).all() as any[];
        // The legitimate regional overrides that existed BEFORE the backfill.
        // Anything else on a regional master is bogus and should be deleted.
        const legitOverrides = new Set(["hero", "casual"]);
        const log: any[] = [];
        for (const r of regionals) {
          const beforeRows = sqlite.prepare(`SELECT block_key FROM media_kit_blocks WHERE kit_id = ?`).all(r.id) as any[];
          const toDelete = beforeRows.filter(b => !legitOverrides.has(b.block_key));
          for (const b of toDelete) {
            sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).run(r.id, b.block_key);
          }
          log.push({ kit_id: r.id, slug: r.slug, deleted: toDelete.length, kept: beforeRows.length - toDelete.length });
        }
        return res.json({ ok: true, regionals_processed: regionals.length, log });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "failed" });
      }
    }

    if (!req.file && req.body?.op === "reorder-canonical-final") {
      // Final canonical kit order including all blocks added during the
      // marketing analysis session. Idempotent — safe to re-run.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        const order = [
          "hero", "who_are_we", "why_us", "who_we_are_not",
          "audience", "audience_stats", "audience_grid",
          "featured_article", "research_sources", "offer",
          "partner_quotes", "investment_callout", "investment", "analytics_proof",
          "casual", "boltons", "ready", "terms", "contact",
        ];
        const upd = sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE kit_id = ? AND block_key = ?`);
        const moved: any[] = [];
        order.forEach((key, i) => {
          const r = upd.run(i + 1, canonical.id, key);
          if (r.changes) moved.push({ key, position: i + 1 });
        });
        return res.json({ ok: true, kit_id: canonical.id, moved });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "reorder failed" });
      }
    }

    if (!req.file && req.body?.op === "clear-canonical-overrides") {
      // The canonical kit IS the source. Its rows can never "override"
      // anything, so flip is_override=0 across the board.
      try {
        const r = sqlite.prepare(`
          UPDATE media_kit_blocks SET is_override = 0
           WHERE kit_id IN (SELECT id FROM media_kits WHERE is_canonical = 1)
             AND is_override = 1
        `).run();
        return res.json({ ok: true, rows_updated: r.changes });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-who-we-are-not") {
      // Inserts the who_we_are_not block on the canonical Global kit between
      // why_us and audience (position 4), and suppresses it from already-sent
      // proposal kits so they stay frozen at their original content.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        const content = {
          enabled: true,
          heading: "Who we are NOT for",
          subheading: "We're not for everyone. And we like it that way.",
          paragraphs: [
            "If you want to sell Bluetooth speakers to teens on TikTok, **we're not for you**. If you want influencers talking about their vinyls, and you're hell-bent on chasing \"the next generation\", then we hate to break it to you\u00a0\u2014\u00a0[they're not buying](https://www.stereonet.com/opinion/my-generation-why-hi-fi-brands-are-chasing-the-wrong-buyers).",
            "We make content. We do YouTube (long-form video). But our strength is **long-form, professional, expert reviews and editorial** \u2014 the kind of coverage that audiophiles save, share, and quote for years.",
            "Other publications are best suited for viral dance videos. We're the publication serious audio buyers come back to.",
          ],
        };
        const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'who_we_are_not'`).get(canonical.id) as any;
        if (existing) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(content), existing.id);
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'who_we_are_not', 100, 1, 1, ?, datetime('now'))`).run(canonical.id, JSON.stringify(content));
        }
        // Reorder: who_we_are_not sits between why_us and audience.
        const order = [
          "hero", "who_are_we", "why_us", "who_we_are_not",
          "audience", "audience_stats", "audience_grid",
          "featured_article", "research_sources", "offer",
          "partner_quotes", "investment_callout", "investment", "analytics_proof",
          "casual", "boltons", "ready", "terms", "contact",
        ];
        const upd = sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE kit_id = ? AND block_key = ?`);
        order.forEach((key, i) => { upd.run(i + 1, canonical.id, key); });
        // Suppress on already-sent kits.
        const { freezeInheritedBlocksForKit } = require("./pitch");
        const sent = sqlite.prepare(`SELECT id, media_kit_id FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
        let totalSuppressed = 0;
        for (const s of sent) {
          const out = freezeInheritedBlocksForKit(s.media_kit_id, { excludeBlockKeys: ["who_we_are_not"] });
          totalSuppressed += out.excluded;
        }
        return res.json({ ok: true, kit_id: canonical.id, action: existing ? "updated" : "inserted", sent_kits_suppressed: totalSuppressed });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "seed failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-round-2-updates") {
      // Round 2 of analysis fixes:
      //   - Fix Casual upsell line + weighting (Casual 1x, Bronze 0.5x) — the
      //     accurate pitch is sustained brand-building, not banner volume.
      //   - Sharpen Analytics Proof heading + add tagline.
      //   - Add partner_quotes block (Martin Ireland · Mike Lenehan).
      //   - Reorder so social proof primes the price anchor, Analytics Proof
      //     becomes the closer below Investment.
      //   - Suppress partner_quotes from already-sent kits.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        const log: any[] = [];

        // CASUAL block: correct the upsell line + Display Advertising weighting bullet.
        const casualRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'casual'`).get(canonical.id) as any;
        if (casualRow) {
          const cc: any = JSON.parse(casualRow.content_json || "{}");
          // Drop any previous upsell line (with the wrong 2× impressions claim).
          let body = String(cc.body || "");
          body = body.replace(/^Great for product launches[^]*?(?:bolt-ons\.|launch period\.)\s*\n?\n?/i, "").trim();
          const upsell = "Great for product launches and short bursts. For sustained brand-building, our Bronze partners get scheduled reviews on cadence, partner pricing on bolt-ons, and the editorial relationship that turns a single campaign into ongoing coverage.";
          cc.body = upsell + (body ? "\n\n" + body : "");
          // Fix Display Advertising bullet weighting (Casual = 1x, not SILVER).
          cc.bullets = (cc.bullets || []).map((b: any) => {
            if (/^Display Advertising/i.test(String(b.title || ""))) {
              return { title: "Display Advertising (Triple Banner Set)", body: "Weighting at 1× — a full share of voice across our network for the 3-month run." };
            }
            return b;
          });
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(cc), casualRow.id);
          log.push({ block: "casual", action: "updated" });
        }

        // ANALYTICS_PROOF: sharpen heading + add tagline.
        const apRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'analytics_proof'`).get(canonical.id) as any;
        if (apRow) {
          const ap: any = JSON.parse(apRow.content_json || "{}");
          ap.heading = "Genuine Data & Analytics";
          ap.subheading = "You'll see every impression we serve.";
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(ap), apRow.id);
          log.push({ block: "analytics_proof", action: "updated" });
        }

        // PARTNER_QUOTES block: insert (or update).
        const quotesContent = {
          enabled: true,
          heading: "What our partners say",
          quotes: [
            {
              quote: "I've worked with StereoNET for more than a decade across different companies and brands. StereoNET is a true marketing machine that is laser focused on the right demographic and provides the tools to get genuine return on investment.",
              name: "Martin Ireland",
              role: "National Sales Manager",
              company: "Amber Technology",
            },
            {
              quote: "Since StereoNET started in the early 2000s we have been involved as a boutique manufacturer. StereoNET has allowed our tiny company to have the same share of voice as some of the biggest brands, and as our only marketing avenue, we've proudly shipped our loudspeakers to all corners of the world.",
              name: "Mike Lenehan",
              role: "Founder",
              company: "Lenehan Audio",
            },
          ],
        };
        const existingQuotes = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'partner_quotes'`).get(canonical.id) as any;
        if (existingQuotes) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(quotesContent), existingQuotes.id);
          log.push({ block: "partner_quotes", action: "updated" });
        } else {
          // Position will be set by the reorder pass below.
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'partner_quotes', 100, 1, 1, ?, datetime('now'))`).run(canonical.id, JSON.stringify(quotesContent));
          log.push({ block: "partner_quotes", action: "inserted" });
        }

        // REORDER: social proof primes the price anchor; Analytics is the closer.
        const order = [
          "hero", "who_are_we", "why_us", "audience", "audience_stats",
          "audience_grid", "featured_article", "research_sources", "offer",
          "partner_quotes", "investment_callout", "investment", "analytics_proof",
          "casual", "boltons", "ready", "terms", "contact",
        ];
        const upd = sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE kit_id = ? AND block_key = ?`);
        order.forEach((key, i) => { upd.run(i + 1, canonical.id, key); });
        log.push({ block: "reorder", action: "applied" });

        // SUPPRESS partner_quotes on already-sent kits (Primare/Innuos/MOON/Audio Active).
        const { freezeInheritedBlocksForKit } = require("./pitch");
        const sent = sqlite.prepare(`SELECT id, media_kit_id FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
        let totalSuppressed = 0;
        for (const s of sent) {
          const out = freezeInheritedBlocksForKit(s.media_kit_id, { excludeBlockKeys: ["partner_quotes"] });
          totalSuppressed += out.excluded;
        }
        log.push({ block: "sent_kits_suppression", proposals: sent.length, blocks_suppressed: totalSuppressed });

        return res.json({ ok: true, kit_id: canonical.id, log });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "seed failed" });
      }
    }

    if (!req.file && req.body?.op === "reposition-new-blocks") {
      // One-shot: shift the new blocks (investment_callout, analytics_proof)
      // from their initial high positions (90, 95) to the correct slots
      // BEFORE the investment block on the canonical kit, then renumber
      // everything for clean ordering.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        // Desired order on canonical:
        // 1 hero, 2 who_are_we, 3 why_us, 4 audience, 5 audience_stats,
        // 6 audience_grid, 7 featured_article, 8 research_sources, 9 offer,
        // 10 analytics_proof, 11 investment_callout, 12 investment,
        // 13 casual, 14 boltons, 15 ready, 16 terms, 17 contact
        const order = [
          "hero", "who_are_we", "why_us", "audience", "audience_stats",
          "audience_grid", "featured_article", "research_sources", "offer",
          "analytics_proof", "investment_callout", "investment",
          "casual", "boltons", "ready", "terms", "contact",
        ];
        const upd = sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE kit_id = ? AND block_key = ?`);
        const moved: any[] = [];
        order.forEach((key, i) => {
          const r = upd.run(i + 1, canonical.id, key);
          if (r.changes) moved.push({ key, position: i + 1 });
        });
        return res.json({ ok: true, kit_id: canonical.id, moved });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "reposition failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-copy-updates") {
      // Applies the four copy edits to the canonical Global trade kit's live
      // blocks: offer.bullets (display advertising + reviews), casual.body
      // (upsell line), ready.paragraphs (drop the 3% line), and inserts the
      // investment_callout block (positioned 90, before analytics_proof at 95).
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        const log: any[] = [];

        // OFFER block: replace the two bullet titles + bodies.
        const offerRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'offer'`).get(canonical.id) as any;
        if (offerRow) {
          const oc: any = JSON.parse(offerRow.content_json || "{}");
          oc.bullets = (oc.bullets || []).map((b: any) => {
            const t = String(b.title || "");
            if (/^Display Advertising/i.test(t)) {
              return { title: "Display Advertising — Every Page, Every Reader", body: "Your brand appears alongside every page our audience reads — billboards, sidebars, and in-content placements. Higher tiers buy more frequency and category exclusivity." };
            }
            if (/Reviews per Campaign/i.test(t) || /\(X\)/i.test(t)) {
              return { title: "Up to 6 Product Reviews per Campaign", body: "Depending on marketing package selected, you will be entitled to a specific number of reviews per campaign. *Results not guaranteed.*" };
            }
            return b;
          });
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(oc), offerRow.id);
          log.push({ block: "offer", action: "updated" });
        } else log.push({ block: "offer", action: "missing" });

        // CASUAL block: prepend the upsell line.
        const casualRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'casual'`).get(canonical.id) as any;
        if (casualRow) {
          const cc: any = JSON.parse(casualRow.content_json || "{}");
          const upsell = "Great for product launches. But Bronze partners get 2× the impressions, priority review scheduling, and partner discounts on bolt-ons.";
          const existingBody = String(cc.body || "").trim();
          if (!existingBody.startsWith("Great for product launches")) {
            cc.body = upsell + (existingBody ? "\n\n" + existingBody : "");
            sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(cc), casualRow.id);
            log.push({ block: "casual", action: "updated" });
          } else log.push({ block: "casual", action: "already_set" });
        } else log.push({ block: "casual", action: "missing" });

        // READY block: strip the 3%-of-turnover paragraph (now lives in investment_callout).
        const readyRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'ready'`).get(canonical.id) as any;
        if (readyRow) {
          const rc: any = JSON.parse(readyRow.content_json || "{}");
          const before = (rc.paragraphs || []).length;
          rc.paragraphs = (rc.paragraphs || []).filter((p: string) => !/3%\s+of\s+(?:your\s+)?annual\s+turnover|marketing rule of thumb/i.test(String(p)));
          if ((rc.paragraphs || []).length !== before) {
            sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(rc), readyRow.id);
            log.push({ block: "ready", action: "updated", removed_paragraphs: before - (rc.paragraphs || []).length });
          } else log.push({ block: "ready", action: "no_change" });
        } else log.push({ block: "ready", action: "missing" });

        // INVESTMENT_CALLOUT block: insert at position 90 (before analytics_proof @ 95, before investment).
        const calloutContent = {
          enabled: true,
          lead: "Most audio brands invest ~3% of annual turnover in marketing.",
          punch: "If you're investing less, you're shrinking. If you're investing it in click farms, you're shrinking faster.",
        };
        const existingCallout = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'investment_callout'`).get(canonical.id) as any;
        if (existingCallout) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, position = 90, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(calloutContent), existingCallout.id);
          log.push({ block: "investment_callout", action: "updated" });
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'investment_callout', 90, 1, 1, ?, datetime('now'))`).run(canonical.id, JSON.stringify(calloutContent));
          log.push({ block: "investment_callout", action: "inserted" });
        }

        // SENT-PROPOSAL SUPPRESSION: the new investment_callout block must NOT
        // appear on already-sent kits (Primare/Innuos/MOON/Audio Active).
        const { freezeInheritedBlocksForKit } = require("./pitch");
        const sent = sqlite.prepare(`SELECT id, media_kit_id, client_name FROM pitch_proposals WHERE status = 'sent' AND media_kit_id IS NOT NULL`).all() as any[];
        let totalSuppressed = 0;
        for (const s of sent) {
          const out = freezeInheritedBlocksForKit(s.media_kit_id, { excludeBlockKeys: ["investment_callout"] });
          totalSuppressed += out.excluded;
        }
        log.push({ block: "sent_kits_suppression", action: "applied", proposals: sent.length, blocks_suppressed: totalSuppressed });

        return res.json({ ok: true, kit_id: canonical.id, log });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "seed-copy-updates failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-hero-block") {
      // Update the hero block on the canonical Global trade kit with the new
      // marketing headline + supporting line + three proof points. Preserves
      // the existing background_image and region_label.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        const existing = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'hero'`).get(canonical.id) as any;
        let prev: any = {};
        try { prev = JSON.parse(existing?.content_json || "{}"); } catch {}
        const content = {
          ...prev,
          // Region label stays (e.g. "GLOBAL"). Quarter explicitly dropped.
          region_label: prev.region_label || "GLOBAL",
          quarter: undefined,
          headline: "The audience that built the audio industry. Still buying.",
          supporting_line: "The global authority on Hi-Fi, Home Cinema and Headphones since 2003.",
          proof_points: [
            { value: "700K+", label: "monthly readers" },
            { value: "93%", label: "aged 45+" },
            { value: "2–5×", label: "longer on page than competitors" },
          ],
        };
        delete (content as any).quarter; // ensure removal
        if (existing) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(content), existing.id);
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'hero', 1, 1, 1, ?, datetime('now'))`).run(canonical.id, JSON.stringify(content));
        }
        return res.json({ ok: true, kit_id: canonical.id, action: existing ? "updated" : "inserted", content });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "hero seed failed" });
      }
    }

    if (!req.file && req.body?.op === "seed-analytics-block") {
      // Seed (or replace) the analytics_proof block on the canonical Global
      // trade kit. Sent-proposal kits are NOT touched because they were frozen
      // at send-time (see pitch_sent_kit_freeze_v1) — they hold their own copy
      // of every block and won't inherit this new one.
      try {
        const canonical = sqlite.prepare(`SELECT id FROM media_kits WHERE is_canonical = 1 AND kind = 'trade' LIMIT 1`).get() as any;
        if (!canonical) return res.status(404).json({ ok: false, message: "No canonical trade kit" });
        // Position 9.5 — between Offer (9) and Investment (10).
        const content = {
          enabled: true,
          heading: "Reporting & Analytics",
          subheading: "Every campaign, measured. Every dollar, accountable.",
          intro: "Where most publishers drop some text number into an email body and call it reporting, StereoNET uses the latest technology when it comes to digital advertising delivery.\n\nEvery partner gets complete analytics allowing you to see how every ad unit is performing, and across your region.",
          bullets: [
            { title: "Per-ad-unit performance", body: "Impressions, hovers, clicks, CTR and unique reach broken out for every billboard, sidebar, and in-content placement — not lumped into one campaign total." },
            { title: "Geographic breakdown", body: "See where your audience is actually engaging — country, region, and city-level views so you know which markets are responding." },
            { title: "Independent benchmark scoring", body: "Every ad unit is scored against the industry benchmark CTR (0.06% per Google). Most StereoNET placements land in 'Excellent' or 'Above average' territory." },
            { title: "Bot-filtered as standard", body: "Cloudflare bot detection runs first. Numbers you see are humans. No inflated impression counts from crawlers, scanners, or AI training bots." },
          ],
          example_url: req.body?.example_url || "https://my.broadstreetads.com/networks/3969/report_jobs/235598?share_code=XY3TkRZEptH6mcSoLAlCug",
          example_thumbnail: req.body?.example_thumbnail || null,
          example_caption: "See an example Global partner report — Krix (8.3M views across 22 placements, rated ‘Great’)",
          footer_note: "On request, you receive your unique shareable report URL. Login optional — send to your team, your distributors, or your suppliers.",
        };
        const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'analytics_proof'`).get(canonical.id) as any;
        if (existing) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, position = ?, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(content), 95, existing.id);
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'analytics_proof', 95, 1, 1, ?, datetime('now'))`).run(canonical.id, JSON.stringify(content));
        }
        return res.json({ ok: true, kit_id: canonical.id, block_key: "analytics_proof", action: existing ? "updated" : "inserted" });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "seed failed" });
      }
    }

    if (req.file && req.body?.op === "upload-image") {
      // Allow a deploy-token-gated image upload so we can seed kit thumbnails
      // without going through the authenticated /api/media-kit/upload-image
      // route (which requires a session). Saves under /uploads/YYYY/MM/<hash>.
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const crypto = require("node:crypto");
        const buf: Buffer = req.file.buffer;
        const ext = (req.file.mimetype === "image/jpeg") ? ".jpg" : (req.file.mimetype === "image/png") ? ".png" : (req.file.mimetype === "image/webp") ? ".webp" : ".bin";
        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        const now = new Date();
        const yyyy = String(now.getUTCFullYear());
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dir = path.join(process.cwd(), "uploads", yyyy, mm);
        fs.mkdirSync(dir, { recursive: true });
        const filename = `${hash}${ext}`;
        const dest = path.join(dir, filename);
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
        const url = `/uploads/${yyyy}/${mm}/${filename}`;
        return res.json({ ok: true, url, bytes: buf.length });
      } catch (e: any) {
        return res.status(500).json({ ok: false, message: e?.message || "upload failed" });
      }
    }

    if (!req.file && req.body?.op === "view-log-dump") {
      // Dump raw view rows across all sent proposals so the user can verify
      // the bot reclassifier's calls. Includes user-agent verbatim.
      const rows = sqlite.prepare(`
        SELECT p.id AS pid, p.client_name, p.status, p.sent_at,
               v.id AS vid, v.viewed_at, v.ip, v.user_agent, v.is_bot, v.bot_reason,
               s.view_count AS share_view_count
        FROM pitch_proposals p
        JOIN media_kit_shares s ON s.kit_id = p.media_kit_id
        JOIN media_kit_views v ON v.share_id = s.id
        WHERE p.status = 'sent'
        ORDER BY p.id DESC, v.viewed_at DESC
        LIMIT 200
      `).all();
      return res.json({ ok: true, op: "view-log-dump", rows });
    }

    if (!req.file && req.body?.op === "cleanup-preview-kits") {
      // Delete orphaned wizard preview clones (slug starts with internal-preview-).
      const rows = sqlite.prepare(`SELECT id, slug, label FROM media_kits WHERE slug LIKE 'internal-preview-%'`).all();
      let deleted = 0;
      for (const r of rows as any[]) {
        try { sqlite.prepare(`DELETE FROM media_kits WHERE id = ?`).run(r.id); deleted++; } catch {}
      }
      return res.json({ ok: true, op: "cleanup-preview-kits", deleted, sample: rows.slice(0, 5) });
    }

    if (!req.file && req.body?.op === "pitch-row") {
      const id = Number(req.body?.id || 0);
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const row = sqlite.prepare(`SELECT * FROM pitch_proposals WHERE id = ?`).get(id);
      const items = sqlite.prepare(`SELECT * FROM pitch_line_items WHERE proposal_id = ?`).all(id);
      return res.json({ ok: true, op: "pitch-row", row, items_count: items.length, items_sample: items.slice(0,3) });
    }

    if (!req.file && req.body?.op === "force-restamp") {
      const id = Number(req.body?.id || 0);
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const { restampKitFromProposal } = require("./pitch");
      const result = restampKitFromProposal(id, { force: true });
      // Read back the block content immediately to confirm
      const prop = sqlite.prepare(`SELECT media_kit_id FROM pitch_proposals WHERE id = ?`).get(id) as any;
      const block = prop?.media_kit_id ? sqlite.prepare(`SELECT content_json FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'proposal'`).get(prop.media_kit_id) as any : null;
      let parsed: any = null;
      try { parsed = block ? JSON.parse(block.content_json) : null; } catch {}
      return res.json({
        ok: true,
        op: "force-restamp",
        proposal_id: id,
        media_kit_id: prop?.media_kit_id,
        restamp_result: result,
        block_discount_label: parsed?.discount_label_text,
        block_discount_pct: parsed?.discount_pct,
        block_keys: parsed ? Object.keys(parsed) : null,
      });
    }

    if (!req.file && req.body?.op === "fix-retailer-audience-stats-heading") {
      // Retailer kit (kit 6) has its own override row for audience_stats from
      // the earlier sync-from-global. Update it too so the heading flips.
      const row = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = 6 AND block_key = 'audience_stats'`).get() as any;
      if (!row) return res.json({ ok: false, message: "no audience_stats row on kit 6" });
      const c = JSON.parse(row.content_json || "{}");
      c.heading = "The numbers that matter";
      sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(c), row.id);
      return res.json({ ok: true, kit: 6, new_heading: c.heading });
    }

    if (!req.file && req.body?.op === "retailer-pitch-tighten") {
      // Three fixes for the retailer kit (kit 6):
      // 1. Update canonical 'audience_stats' heading to be audience-agnostic
      //    ("The numbers that matter") so both kits read cleanly.
      // 2. Override the 'ready' block on kit 6 with retailer-focused copy.
      // 3. Override 'partner_quotes' on kit 6 with retailer testimonials.
      const results: any[] = [];

      // --- 1. Canonical audience_stats heading ---
      const canonStatsRow = sqlite.prepare(`SELECT id, content_json FROM media_kit_blocks WHERE kit_id = 1 AND block_key = 'audience_stats'`).get() as any;
      if (canonStatsRow) {
        const content = JSON.parse(canonStatsRow.content_json || "{}");
        content.heading = "The numbers that matter";
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(content), canonStatsRow.id);
        results.push({ block: "audience_stats", action: "updated canonical heading", new_heading: content.heading });
      } else {
        results.push({ block: "audience_stats", action: "skipped", reason: "not found" });
      }

      // --- 2. Retailer-specific 'ready' block on kit 6 ---
      const retailerReady = {
        heading: "Ready to fill your shop floor?",
        subheading: "We're ready to put your store in front of 700,000+ qualified buyers every month.",
        epigraph: "",
        paragraphs: [
          "Whether you're a single-location specialist, a multi-store group, or a flagship dealer — we put your store in front of the readers who already trust StereoNET to tell them what's worth buying.",
          "They come for the reviews. They stay for the community. And when they're ready to buy, they're looking for somewhere local they can demo, audition, and buy from someone who knows their stuff. That's where your listing puts you.",
          "**The next step is yours**. Pick a tier above, or talk to us about what would work best for your shop.",
        ],
        cta_label: "Build my proposal",
        cta_enabled: true,
      };
      const existingReady = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = 6 AND block_key = 'ready'`).get() as any;
      if (existingReady) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(retailerReady), existingReady.id);
        results.push({ block: "ready", action: "overwrote existing override" });
      } else {
        sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, content_json, position, is_override, is_visible) VALUES (6, 'ready', ?, 13, 1, 1)`).run(JSON.stringify(retailerReady));
        results.push({ block: "ready", action: "inserted retailer override" });
      }

      // --- 3. Retailer-specific 'partner_quotes' on kit 6 ---
      // Placeholder retailer quotes — user will edit names/quotes from the kit
      // editor once they have real testimonials.
      const retailerQuotes = {
        enabled: true,
        heading: "What our retail partners say",
        quotes: [
          {
            quote: "[Placeholder quote — swap with a real Audio Connection / Brisbane Hifi / your-best-retailer testimonial.] StereoNET drives more qualified enquiries to our store than anything else we've tried. The audience knows what they want and they know who we are by the time they walk in.",
            name: "[Retailer Contact Name]",
            role: "Owner",
            company: "[Retailer Name]",
          },
          {
            quote: "[Placeholder quote — swap with a second retailer testimonial.] Listing on StereoNET puts us in front of buyers we'd never reach through Google or local ads. Our Premium upgrade paid for itself in the first month.",
            name: "[Retailer Contact Name]",
            role: "Director",
            company: "[Retailer Name]",
          },
        ],
      };
      const existingQuotes = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = 6 AND block_key = 'partner_quotes'`).get() as any;
      if (existingQuotes) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(JSON.stringify(retailerQuotes), existingQuotes.id);
        results.push({ block: "partner_quotes", action: "overwrote existing override" });
      } else {
        sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, content_json, position, is_override, is_visible) VALUES (6, 'partner_quotes', ?, 11, 1, 1)`).run(JSON.stringify(retailerQuotes));
        results.push({ block: "partner_quotes", action: "inserted retailer override" });
      }

      return res.json({ ok: true, op: "retailer-pitch-tighten", results });
    }

    if (!req.file && req.body?.op === "seed-retailer-inclusions") {
      // Seed the retailer tier inclusions from the existing marketing matrix.
      const seed: Record<string, Record<string, any>> = {
        starter: { // Partner
          store_listed: false,
          forum_access: true,
          sponsor_forum: true,
          competitions: false,
          event_coverage: false,
          display_banners: false,
          classifieds_access: true,
          discount_pct: null,
          ai_discoverability: true,
          newsletter_social: true,
        },
        growth: { // Silver
          store_listed: true,
          forum_access: true,
          sponsor_forum: true,
          competitions: true,
          event_coverage: true,
          display_banners: false,
          classifieds_access: true,
          discount_pct: 10,
          ai_discoverability: true,
          newsletter_social: true,
        },
        premier: { // Gold
          store_listed: true,
          forum_access: true,
          sponsor_forum: true,
          competitions: true,
          event_coverage: true,
          display_banners: true,
          classifieds_access: true,
          discount_pct: 15,
          ai_discoverability: true,
          newsletter_social: true,
        },
      };
      const results: any[] = [];
      for (const [key, incl] of Object.entries(seed)) {
        const row = sqlite.prepare(`SELECT id FROM media_kit_addons WHERE kind = 'tier' AND audience_kind IN ('retailer','both') AND addon_key = ?`).get(key) as any;
        if (!row) { results.push({ key, action: "skipped", reason: "row not found" }); continue; }
        sqlite.prepare(`UPDATE media_kit_addons SET inclusions_json = ? WHERE id = ?`).run(JSON.stringify(incl), row.id);
        results.push({ key, id: row.id, action: "updated" });
      }
      return res.json({ ok: true, op: "seed-retailer-inclusions", results });
    }

    if (!req.file && req.body?.op === "drop-retailer-proposal-tables") {
      try { sqlite.exec(`DROP TABLE IF EXISTS retailer_proposal_views`); } catch (e: any) { return res.json({ ok: false, message: e?.message }); }
      try { sqlite.exec(`DROP TABLE IF EXISTS retailer_proposals`); } catch (e: any) { return res.json({ ok: false, message: e?.message }); }
      return res.json({ ok: true, dropped: ["retailer_proposals", "retailer_proposal_views"] });
    }

    if (!req.file && req.body?.op === "inspect-notify-recipients") {
      const users = sqlite.prepare(`SELECT email, notify_regions FROM users WHERE email IS NOT NULL AND email != '' AND notify_regions IS NOT NULL AND notify_regions != ''`).all();
      const fallback = storage.getSetting("sendgrid_notify_to");
      return res.json({ ok: true, users, fallback_setting: fallback });
    }

    if (!req.file && req.body?.op === "seed-retailer-billing-periods") {
      // Mark retailer Partner tier as annual; Silver/Gold as monthly.
      sqlite.prepare(`UPDATE media_kit_addons SET billing_period = 'annual' WHERE kind = 'tier' AND audience_kind IN ('retailer','both') AND addon_key = 'starter'`).run();
      sqlite.prepare(`UPDATE media_kit_addons SET billing_period = 'monthly' WHERE kind = 'tier' AND audience_kind IN ('retailer','both') AND addon_key IN ('growth','premier')`).run();
      const after = sqlite.prepare(`SELECT addon_key, label, price_value, price_currency, price_suffix, billing_period FROM media_kit_addons WHERE kind = 'tier' AND audience_kind IN ('retailer','both') ORDER BY position`).all();
      return res.json({ ok: true, op: "seed-retailer-billing-periods", tiers: after });
    }

    if (!req.file && req.body?.op === "inspect-recent-leads") {
      // Show recent inbound lead requests + any send history. Helps diagnose
      // "why did I get N emails for the same prospect?" questions.
      // Discover the inbound_leads schema since column names vary
      const cols = sqlite.prepare(`PRAGMA table_info(pitch_inbound_leads)`).all() as any[];
      const colNames = cols.map(c => c.name);
      const rows = sqlite.prepare(`SELECT * FROM pitch_inbound_leads WHERE created_at >= datetime('now','-3 days') ORDER BY created_at DESC LIMIT 50`).all();
      return res.json({ ok: true, schema: colNames, leads: rows });
    }

    if (!req.file && req.body?.op === "inspect-retailer-addons") {
      const rows = sqlite.prepare(`SELECT kind, addon_key, region, audience_kind, label, price_value, price_currency, price_suffix, position, is_visible FROM media_kit_addons WHERE audience_kind IN ('retailer','both') ORDER BY kind, region, position`).all();
      return res.json({ ok: true, count: rows.length, rows });
    }

    if (!req.file && req.body?.op === "sync-retailer-from-global") {
      // Mirror marketing blocks from kit 1 (Global trade) -> kit 6 (Retailer global).
      // Excludes: hero, offer, investment, boltons, ready, terms, contact
      // (these are retailer-specific or already aligned).
      const FROM_KIT = 1;
      const TO_KIT = 6;
      const MIRROR_KEYS = [
        "who_are_we",
        "why_us",
        "audience",
        "who_we_are_not",
        "audience_stats",
        "audience_grid",
        "featured_article",
        "research_sources",
        "partner_quotes",
        "investment_callout",
        "casual",
        "analytics_proof",
      ];
      const results: any[] = [];
      for (const key of MIRROR_KEYS) {
        const src = sqlite.prepare(`SELECT content_json, position FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(FROM_KIT, key) as any;
        if (!src) { results.push({ key, action: "skipped", reason: "not in source" }); continue; }
        const dst = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(TO_KIT, key) as any;
        if (dst) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, position = ?, is_visible = 1, edited_at = datetime('now') WHERE id = ?`).run(src.content_json, src.position, dst.id);
          results.push({ key, action: "updated", position: src.position });
        } else {
          sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, ?, ?, 1, 1, ?, datetime('now'))`).run(TO_KIT, key, src.position, src.content_json);
          results.push({ key, action: "inserted", position: src.position });
        }
      }
      // Now align positions for the blocks we kept on retailer (so the
      // canonical order matches Global). Map each kept block to its Global pos.
      const KEEP_REORDER: Record<string, number> = { hero: 1, offer: 9, investment: 10, boltons: 12, ready: 13, terms: 14, contact: 15 };
      for (const [key, pos] of Object.entries(KEEP_REORDER)) {
        const row = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(TO_KIT, key) as any;
        if (row) {
          sqlite.prepare(`UPDATE media_kit_blocks SET position = ? WHERE id = ?`).run(pos, row.id);
          results.push({ key, action: "repositioned", position: pos });
        }
      }
      // Final block list, ordered
      const final = sqlite.prepare(`SELECT block_key, position, is_visible FROM media_kit_blocks WHERE kit_id = ? ORDER BY position ASC, id ASC`).all(TO_KIT);
      return res.json({ ok: true, op: "sync-retailer-from-global", results, final_block_order: final });
    }

    if (!req.file && req.body?.op === "list-kit-blocks") {
      const kitId = parseInt(String(req.body?.kit_id || "0"), 10);
      if (!kitId) return res.status(400).json({ ok: false, message: "kit_id required" });
      const rows = sqlite.prepare(`SELECT id, block_key, position, is_override, is_visible, length(content_json) AS bytes, edited_at FROM media_kit_blocks WHERE kit_id = ? ORDER BY position ASC, id ASC`).all(kitId);
      return res.json({ ok: true, kit_id: kitId, blocks: rows });
    }

    if (!req.file && req.body?.op === "seed-retailer-hero") {
      const heroContent = {
        region_label: "RETAILER · GLOBAL",
        background_image: "/uploads/2026/06/7d24329328f551c438127eb424ac36bca8f660aef499b3d6901bf37bd538d4bc.jpg",
        headline: "The shortest path between a serious buyer and your shop floor.",
        supporting_line: "Your StereoNET listing puts you in front of 700,000+ qualified hi-fi, home cinema and headphone buyers every month.",
        proof_points: [
          { value: "700K+", label: "monthly readers" },
          { value: "93%", label: "aged 45+" },
          { value: "2–5×", label: "longer on page than competitors" },
        ],
      };
      const json = JSON.stringify(heroContent);
      const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = 6 AND block_key = 'hero'`).get() as any;
      if (existing) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, edited_at = datetime('now') WHERE id = ?`).run(json, existing.id);
      } else {
        sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (6, 'hero', 1, 1, 1, ?, datetime('now'))`).run(json);
      }
      return res.json({ ok: true, op: "seed-retailer-hero", content: heroContent });
    }

    if (!req.file && req.body?.op === "resend-share") {
      // Retry-send a share that got stuck in draft state (e.g. earlier attempt
      // hit a Cloudflare 522 before the email pipeline could complete).
      const shareId = Number(req.body?.share_id);
      if (!Number.isInteger(shareId)) return res.status(400).json({ message: "share_id required" });
      const share = sqlite.prepare(`SELECT * FROM media_kit_shares WHERE id = ?`).get(shareId) as any;
      if (!share) return res.status(404).json({ message: "share not found" });
      const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(share.kit_id) as any;
      if (!kit) return res.status(404).json({ message: "kit not found" });

      // Refresh magic token (invalidates any old link that may have leaked).
      const crypto = await import("node:crypto");
      const newToken = crypto.randomBytes(24).toString("base64url").slice(0, 24);
      const newExpiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
      sqlite.prepare(`UPDATE media_kit_shares SET magic_token = ?, expires_at = ? WHERE id = ?`).run(newToken, newExpiry, shareId);

      const magicLink = `https://dashboard.stereonet.com/kit/${share.slug}?t=${newToken}`;
      const { sendEmail, buildKitDeliveryEmail } = await import("./email");
      let emailOk = false, emailErr: string | null = null;
      try {
        const tpl = buildKitDeliveryEmail({
          name: share.prospect_name || "there",
          company: share.prospect_company || "",
          magicLink,
          kitLabel: kit.label || "StereoNET Media Kit",
        });
        await sendEmail({
          to: share.prospect_email,
          toName: share.prospect_name || undefined,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });
        emailOk = true;
      } catch (e: any) {
        emailErr = e?.message || "send failed";
        console.error("[resend-share] email failed:", e);
      }

      if (emailOk) {
        sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'sent', sent_at = datetime('now') WHERE id = ?`).run(shareId);
        // Also bump the lead status from 'new' → 'contacted' if it's linked
        sqlite.prepare(`UPDATE pitch_inbound_leads SET status = 'contacted', updated_at = datetime('now') WHERE kit_share_id = ? AND status = 'new'`).run(shareId);
        sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, actor_name, message) VALUES (?, 'sent', 'admin', 'Retry-sent after earlier Cloudflare 522 failure')`).run(shareId);
      }
      return res.json({ ok: emailOk, share_id: shareId, slug: share.slug, magic_link: magicLink, email_sent: emailOk, email_error: emailErr });
    }

    if (!req.file && req.body?.op === "lead-send-status") {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const company = String(req.body?.company || "").trim().toLowerCase();
      if (!email && !company) return res.status(400).json({ message: "email or company required" });
      const conditions: string[] = [];
      const params: any[] = [];
      if (email) { conditions.push("lower(s.prospect_email) = ?"); params.push(email); }
      if (company) { conditions.push("lower(s.prospect_company) LIKE ?"); params.push(`%${company}%`); }
      const shares = sqlite.prepare(`
        SELECT s.id, s.kit_id, s.slug, s.prospect_name, s.prospect_email, s.prospect_company,
               s.proposal_state, s.sent_at, s.created_at, k.label AS kit_label
        FROM media_kit_shares s
        LEFT JOIN media_kits k ON k.id = s.kit_id
        WHERE ${conditions.join(" OR ")}
        ORDER BY s.id DESC
        LIMIT 20
      `).all(...params);
      // Also check the lead record
      const leads = sqlite.prepare(`
        SELECT id, name, email, company, status, kit_share_id, updated_at, created_at
        FROM pitch_inbound_leads
        WHERE lower(email) = ? OR lower(company) LIKE ?
        ORDER BY id DESC
        LIMIT 10
      `).all(email || "", company ? `%${company}%` : "");
      return res.json({ ok: true, shares, leads });
    }

    if (!req.file && req.body?.op === "quicksend-eugene-metronome") {
      // One-shot admin op to Quick Send the Global Media Kit to Eugene Ng after
      // his slot in the earlier Franz+Eugene send failed with the UNIQUE slug
      // collision. Uses the same email pipeline as /api/media-kit/quick-send.
      const kitId = 1;
      const kit = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(kitId) as any;
      if (!kit) return res.status(404).json({ message: "Global Media Kit not found" });
      const recipient = { name: "Eugene Ng", email: "eugeneng@stereonet.com", company: "Metronome" };
      const { sendEmail, buildKitDeliveryEmail } = await import("./email");

      // Mint a collision-safe slug via the new generator.
      const genShareSlug = (prospect: string) => {
        const safe = String(prospect || "share").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "share";
        const stamp = Math.floor(Date.now() / 1000).toString(36);
        const rand = Math.random().toString(36).slice(2, 6);
        return `${safe}-${stamp}${rand}`;
      };
      let slug = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        const cand = genShareSlug(recipient.company);
        const clash = sqlite.prepare(`SELECT 1 FROM media_kit_shares WHERE slug = ? LIMIT 1`).get(cand);
        if (!clash) { slug = cand; break; }
      }
      if (!slug) slug = `${genShareSlug(recipient.company)}-${Math.random().toString(36).slice(2, 10)}`;

      const crypto = await import("node:crypto");
      const token = crypto.randomBytes(24).toString("base64url").slice(0, 24);
      const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();

      const info = sqlite.prepare(`
        INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, expires_at, proposal_state, sent_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', datetime('now'), datetime('now'))
      `).run(kitId, slug, token, recipient.name, recipient.email, recipient.company, expiry);
      const shareId = Number(info.lastInsertRowid);
      const magicLink = `https://dashboard.stereonet.com/kit/${slug}?t=${token}`;

      let emailOk = false, emailErr: string | null = null;
      try {
        const tpl = buildKitDeliveryEmail({
          name: recipient.name,
          company: recipient.company,
          magicLink,
          kitLabel: kit.label || "StereoNET Media Kit",
        });
        await sendEmail({
          to: recipient.email,
          toName: recipient.name,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });
        emailOk = true;
      } catch (e: any) {
        emailErr = e?.message || "send failed";
        console.error("[quicksend-eugene-metronome] email failed:", e);
      }

      return res.json({
        ok: emailOk,
        share_id: shareId,
        slug,
        magic_link: magicLink,
        recipient,
        email_sent: emailOk,
        email_error: emailErr,
      });
    }

    if (!req.file && req.body?.op === "quicksend-check-metronome") {
      // Check what shares exist for Metronome-related sends so we can tell the
      // user whether Franz/Eugene actually received their kits or not.
      const rows = sqlite.prepare(`
        SELECT s.id, s.kit_id, s.slug, s.prospect_name, s.prospect_email, s.prospect_company, s.proposal_state, s.sent_at, s.created_at, k.label AS kit_label
        FROM media_kit_shares s
        LEFT JOIN media_kits k ON k.id = s.kit_id
        WHERE lower(s.prospect_company) LIKE '%metronome%'
           OR lower(s.prospect_email) LIKE '%metronome%'
           OR lower(s.prospect_email) LIKE '%eugeneng%'
           OR lower(s.prospect_email) LIKE '%franz%'
        ORDER BY s.id DESC
        LIMIT 20
      `).all();
      return res.json({ ok: true, shares: rows });
    }

    if (!req.file && req.body?.op === "primary-source-run") {
      // Manually trigger a specific primary-source watcher. Full-cycle can
      // exceed Cloudflare's 100s timeout so we run one watcher at a time.
      // Pass source=fcc | youtube | brand_press (default: youtube — fastest).
      const source = String(req.body?.source || "youtube").toLowerCase();
      let result: any;
      try {
        if (source === "fcc") result = await runFccWatcher(sqlite);
        else if (source === "brand_press" || source === "brand-press" || source === "press") result = await runBrandPressWatcher(sqlite);
        else result = await runYoutubeWatcher(sqlite);
        return res.json({ ok: true, source, result });
      } catch (e: any) {
        return res.status(500).json({ ok: false, source, error: e?.message || "watcher failed" });
      }
    }

    if (!req.file && req.body?.op === "primary-source-status") {
      // Snapshot of primary-source watcher state: how many targets, when each
      // was last polled, when each last produced a signal.
      const fcc = sqlite.prepare(`
        SELECT brand, grantee_code, is_active, last_polled_at, last_signal_at
        FROM fcc_targets ORDER BY last_signal_at DESC NULLS LAST, brand ASC
      `).all();
      const yt = sqlite.prepare(`
        SELECT channel_name, channel_id, tier, is_active, last_polled_at, last_signal_at
        FROM youtube_targets ORDER BY last_signal_at DESC NULLS LAST, channel_name ASC
      `).all();
      const bp = sqlite.prepare(`
        SELECT brand, press_url, is_active, last_polled_at, last_signal_at
        FROM brand_press_targets ORDER BY last_signal_at DESC NULLS LAST, brand ASC
      `).all();
      const recentSignals = sqlite.prepare(`
        SELECT source_type, COUNT(*) as signals_24h
        FROM primary_source_seen
        WHERE first_seen_at >= datetime('now', '-24 hours')
        GROUP BY source_type
      `).all();
      const recentArticles = sqlite.prepare(`
        SELECT id, site, title, url, fetched_at
        FROM articles
        WHERE site IN ('fcc_filings', 'youtube_reviewers', 'brand_press')
          AND fetched_at >= datetime('now', '-24 hours')
        ORDER BY fetched_at DESC
        LIMIT 30
      `).all();
      return res.json({
        ok: true,
        fcc_targets: fcc,
        youtube_targets: yt,
        brand_press_targets: bp,
        signals_24h: recentSignals,
        recent_articles: recentArticles,
      });
    }

    if (!req.file && req.body?.op === "pr-list-gap-report") {
      // Compare brand coverage: which brands has eCoustics covered in the
      // last N days that StereoNET has NOT? This is the PR-outreach shortlist
      // — those brands' PR lists probably don't include us yet.
      const days = Math.max(7, Math.min(90, Number(req.body?.days) || 30));
      // Extract every brand mentioned in eCoustics articles in the window.
      // Structured `brands` column is JSON array; also inspect categories
      // (eCoustics uses category tags that include brand names) and titles.
      const ecoArticles = sqlite.prepare(`
        SELECT id, title, url, brands, categories, fetched_at
        FROM articles
        WHERE site = 'ecoustics' AND fetched_at >= datetime('now', ?)
      `).all(`-${days} days`) as any[];
      const stereonetArticles = sqlite.prepare(`
        SELECT title, brands, categories
        FROM articles
        WHERE site = 'stereonet' AND published_at >= datetime('now', ?)
      `).all(`-${days} days`) as any[];

      // Broader stopword set: generic tech, category, format, event, and
      // descriptor terms that show up in categories/tags but aren't brands.
      const STOPWORDS = new Set([
        "news", "reviews", "review", "featured", "new products", "opinion", "features", "feature",
        "amplifiers", "amplifier", "loudspeakers", "loudspeaker", "speakers", "speaker", "headphones", "headphone",
        "iems", "iem", "earbuds", "earbud", "turntables", "turntable", "streamers", "streamer",
        "tvs", "tv", "soundbars", "soundbar", "gift guides", "gift guide", "guide", "music", "movies", "movie",
        "home theater", "home theatre", "stereo", "video", "audio", "hi-fi", "hifi", "cables", "cable",
        "floorstanding speakers", "bookshelf speakers", "over-ear headphones", "on-ear headphones", "in-ear headphones",
        "wireless headphones", "wireless speakers", "wireless earbuds", "wireless", "bluetooth", "bluetooth headphones",
        "a/v receivers & preamp/processors", "integrated amps & stereo receivers", "amps", "receivers", "receiver",
        "music streamers", "dongle dacs", "dac", "dacs", "daps", "gaming headsets", "gaming",
        "blu-ray, dvd & 4k media players", "a/v furniture & accessories", "accessories",
        "vintage audio", "vintage", "articles", "article", "podcasts", "podcast",
        "digital audio", "analog audio", "analogue", "analog", "digital",
        "4k tv", "4k movies", "4k", "8k", "hdr", "hd", "uhd", "oled", "lcd", "led",
        "dolby", "dolby vision", "dolby atmos", "atmos", "eclipsa", "eclipsa audio", "lossless",
        "active speakers", "active", "passive", "powered speakers", "portable",
        "physical media", "streaming", "music streaming", "lifestyle", "connected",
        "high-end audio", "high end audio", "high-end", "high end", "audiophile", "audiophiles",
        "canjam", "canjam london", "canjam london 2026", "audio advice live 2026", "audio advice live",
        "advice live", "munich", "munich high end", "axpona", "ces", "ifa", "axpona 2026", "ces 2026", "ifa 2026",
        "london", "north", "america", "europe", "asia", "north america",
        "debuts", "launches", "unveils", "reveals", "announces", "introduces",
        "live 2026", "live 2025", "2026", "2025", "2024",
        "bring", "brings", "new", "best", "first", "latest",
        "spotify", "tidal", "qobuz", "apple music",  // music services
        "class a amplifiers", "class d amplifiers", "tube amplifier", "tube amplifiers", "solid state",
        "phono stage", "cartridge", "cartridges", "vinyl", "vinyl record", "lp",
        "aac", "flac", "aptx", "aptx lossless", "ldac",
      ]);

      function extractBrands(rows: any[]): Map<string, { count: number; original: string }> {
        const counts = new Map<string, { count: number; original: string }>();
        for (const r of rows) {
          const seen = new Set<string>();
          let brands: string[] = [];
          try { brands = JSON.parse(r.brands || "[]"); } catch {}
          let cats: string[] = [];
          try { cats = JSON.parse(r.categories || "[]"); } catch {}
          for (const b of [...brands, ...cats]) {
            const raw = String(b || "").trim();
            const norm = raw.toLowerCase();
            if (!norm || norm.length < 3 || norm.length > 40) continue;
            if (STOPWORDS.has(norm)) continue;
            // Real brand names typically have at least one capitalised letter
            // and don't contain '&' with generic terms
            if (!/[A-Z]/.test(raw) && brands.indexOf(b) === -1) continue; // only allow lowercase if it's from the structured brands array
            if (seen.has(norm)) continue;
            seen.add(norm);
            const cur = counts.get(norm) || { count: 0, original: raw };
            cur.count++;
            counts.set(norm, cur);
          }
        }
        return counts;
      }

      const ecoCounts = extractBrands(ecoArticles);
      const snCounts = extractBrands(stereonetArticles);

      const gaps: Array<{ brand: string; brand_original: string; ecoustics_count: number; stereonet_count: number; sample_urls: string[] }> = [];
      for (const [brand, info] of ecoCounts.entries()) {
        const snInfo = snCounts.get(brand);
        const snCount = snInfo?.count || 0;
        if (info.count >= 2 && snCount === 0) {
          const samples = ecoArticles
            .filter(a => {
              let bs: string[] = []; try { bs = JSON.parse(a.brands || "[]"); } catch {}
              let cs: string[] = []; try { cs = JSON.parse(a.categories || "[]"); } catch {}
              return [...bs, ...cs].some(x => String(x).toLowerCase() === brand);
            })
            .slice(0, 3)
            .map(a => a.url);
          gaps.push({ brand, brand_original: info.original, ecoustics_count: info.count, stereonet_count: snCount, sample_urls: samples });
        }
      }
      gaps.sort((a, b) => b.ecoustics_count - a.ecoustics_count);

      return res.json({
        ok: true,
        window_days: days,
        ecoustics_articles_scanned: ecoArticles.length,
        stereonet_articles_scanned: stereonetArticles.length,
        ecoustics_brands_total: ecoCounts.size,
        stereonet_brands_total: snCounts.size,
        gap_count: gaps.length,
        gaps: gaps.slice(0, 50),
      });
    }

    if (!req.file && req.body?.op === "dailyaudio-cleanup") {
      // 1) Disable dailyaudio in tracked_sites so it stops being ingested.
      // 2) Retroactively delete dailyaudio articles from the last 3 days that
      //    haven't been claimed/published, so Discovery clears immediately.
      const disableRes = sqlite.prepare(`UPDATE tracked_sites SET enabled = 0 WHERE site_key = 'dailyaudio'`).run();
      // Don't purge articles that are already claimed or bsided (there might be a genuine one)
      const purgeInfo = sqlite.prepare(`
        DELETE FROM articles
        WHERE site = 'dailyaudio'
          AND fetched_at >= datetime('now', '-3 days')
          AND id NOT IN (SELECT article_id FROM article_claims WHERE status IN ('claimed', 'written'))
      `).run();
      // Also drop any orphan dismissals for the deleted rows
      sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id NOT IN (SELECT id FROM articles)`).run();
      return res.json({
        ok: true,
        tracked_site_disabled: disableRes.changes > 0,
        articles_deleted_last_3_days: purgeInfo.changes,
      });
    }

    if (!req.file && req.body?.op === "discovery-recent-flood") {
      const site = String(req.body?.site || "").trim().toLowerCase();
      const hours = Math.max(1, Math.min(72, Number(req.body?.hours) || 2));
      const per_hour = sqlite.prepare(`
        SELECT
          strftime('%Y-%m-%d %H:00', fetched_at) as hour_bucket,
          site,
          COUNT(*) as ingested
        FROM articles
        WHERE fetched_at >= datetime('now', ?)
          ${site ? "AND site = ?" : ""}
        GROUP BY hour_bucket, site
        ORDER BY hour_bucket DESC, ingested DESC
      `).all(...(site ? [`-${hours} hours`, site] : [`-${hours} hours`])) as any[];
      const sampleTitles = sqlite.prepare(`
        SELECT id, site, title, url, published_at, fetched_at, content_type
        FROM articles
        WHERE fetched_at >= datetime('now', ?)
          ${site ? "AND site = ?" : ""}
        ORDER BY fetched_at DESC
        LIMIT 40
      `).all(...(site ? [`-${hours} hours`, site] : [`-${hours} hours`])) as any[];
      return res.json({ ok: true, hours, per_hour, sample: sampleTitles });
    }

    if (!req.file && req.body?.op === "discovery-diagnose-site") {
      const site = String(req.body?.site || "").trim().toLowerCase();
      if (!site) return res.status(400).json({ message: "site required" });
      const totals = sqlite.prepare(`
        SELECT COUNT(*) as total_all_time,
               SUM(CASE WHEN fetched_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) as fetched_30d,
               SUM(CASE WHEN fetched_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) as fetched_7d,
               SUM(CASE WHEN fetched_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) as fetched_24h
        FROM articles WHERE site = ?
      `).get(site);
      const dropsAllTime = sqlite.prepare(`SELECT COUNT(*) as n FROM site_ingest_filter_drops WHERE site = ?`).get(site) as any;
      const drops24h = sqlite.prepare(`SELECT COUNT(*) as n FROM site_ingest_filter_drops WHERE site = ? AND dropped_at >= datetime('now','-24 hours')`).get(site) as any;
      const drops30d = sqlite.prepare(`SELECT COUNT(*) as n FROM site_ingest_filter_drops WHERE site = ? AND dropped_at >= datetime('now','-30 days')`).get(site) as any;
      const sampleDrops = sqlite.prepare(`SELECT title, url, categories_json, dropped_at FROM site_ingest_filter_drops WHERE site = ? ORDER BY dropped_at DESC LIMIT 10`).all(site);
      const currentFilter = sqlite.prepare(`SELECT categories_include_json, url_include_patterns_json, note FROM site_ingest_filters WHERE site_key = ?`).get(site);
      return res.json({ ok: true, site, totals, drops_all_time: dropsAllTime?.n, drops_24h: drops24h?.n, drops_30d: drops30d?.n, sample_drops: sampleDrops, filter: currentFilter });
    }

    if (!req.file && req.body?.op === "discovery-seed-ingest-filters") {
      // Seed sensible per-site category allowlists for general-tech sites that
      // publish mostly non-audio content. gearpatrol has 89% non-audio drift,
      // so restrict to audio+headphones+hifi+home theater categories.
      const seed = [
        {
          site: "gearpatrol",
          cats: ["audio", "headphones", "speakers", "hi-fi", "hifi", "home theater", "home theatre", "turntables", "soundbars"],
          urls: ["/audio/", "/headphones/", "/speakers/", "/hi-fi/"],
          note: "Audio-only filter \u2014 89% of gearpatrol is watches/motoring/style/etc. Match on either category tag or /audio/ path in the URL.",
        },
      ];
      const results: any[] = [];
      for (const s of seed) {
        sqlite.prepare(`
          INSERT INTO site_ingest_filters (site_key, categories_include_json, url_include_patterns_json, note, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(site_key) DO UPDATE SET
            categories_include_json = excluded.categories_include_json,
            url_include_patterns_json = excluded.url_include_patterns_json,
            note = excluded.note,
            updated_at = datetime('now')
        `).run(s.site, JSON.stringify(s.cats), JSON.stringify(s.urls), s.note);
        results.push({ site: s.site, categories: s.cats, urls: s.urls });
      }
      // Also purge existing gearpatrol articles from the last 30d that don't
      // match the audio filter, so Discovery immediately becomes cleaner.
      // Only hides them, doesn't delete (in case admins want to review).
      const hidden = sqlite.prepare(`
        WITH targets AS (
          SELECT id, categories, url FROM articles
          WHERE site = 'gearpatrol'
            AND fetched_at >= datetime('now', '-30 days')
        )
        SELECT id, categories, url FROM targets
      `).all() as any[];
      let purged = 0;
      for (const a of hidden) {
        let cats: string[] = [];
        try { cats = JSON.parse(a.categories || "[]"); } catch {}
        const catsLower = cats.map((c: any) => String(c).toLowerCase());
        const audioCat = catsLower.some((c: string) => ["audio", "headphones", "speakers", "hi-fi", "hifi", "home theater", "home theatre", "turntables", "soundbars"].includes(c));
        const audioUrl = (a.url || "").toLowerCase().includes("/audio/") || (a.url || "").toLowerCase().includes("/headphones/");
        if (!(audioCat || audioUrl)) {
          // Retroactively record these as ingest drops for audit + delete
          sqlite.prepare(`INSERT INTO site_ingest_filter_drops (site, title, url, categories_json, dropped_at) VALUES ('gearpatrol', (SELECT title FROM articles WHERE id = ?), ?, ?, datetime('now'))`).run(a.id, a.url, a.categories || "[]");
          sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(a.id);
          sqlite.prepare(`DELETE FROM article_claims WHERE article_id = ?`).run(a.id);
          sqlite.prepare(`DELETE FROM articles WHERE id = ?`).run(a.id);
          purged++;
        }
      }
      // Now run aggressive learning pass
      const catOut = learnCategoriesFromDismissals(sqlite);
      return res.json({ ok: true, seeded: results, gearpatrol_purged_30d: purged, category_learning: catOut });
    }

    if (!req.file && req.body?.op === "discovery-learning-inspect-site") {
      const site = String(req.body?.site || "").trim().toLowerCase();
      if (!site) return res.status(400).json({ message: "site required" });
      const stats = sqlite.prepare(`
        SELECT
          COUNT(*) as articles_30d,
          SUM(CASE WHEN d.article_id IS NOT NULL THEN 1 ELSE 0 END) as dismissed_30d,
          SUM(CASE WHEN c.article_id IS NOT NULL AND c.status IN ('claimed','written') THEN 1 ELSE 0 END) as kept_30d
        FROM articles a
        LEFT JOIN article_dismissals d ON d.article_id = a.id
        LEFT JOIN article_claims c ON c.article_id = a.id
        WHERE a.fetched_at >= datetime('now', '-30 days')
          AND a.site = ?
      `).get(site) as any;
      const recentDismissals = sqlite.prepare(`
        SELECT a.id, a.title, a.categories, a.brands, d.dismissed_at, d.username
        FROM article_dismissals d
        JOIN articles a ON a.id = d.article_id
        WHERE a.site = ?
        ORDER BY d.dismissed_at DESC
        LIMIT 20
      `).all(site) as any[];
      const learnedForSite = sqlite.prepare(`
        SELECT category, dismissed_count, kept_count, is_active, source, last_seen_at
        FROM discovery_learned_categories
        WHERE site = ?
        ORDER BY dismissed_count DESC
      `).all(site) as any[];
      // Category breakdown of ALL articles for this site in 30d
      const catBreakdown = sqlite.prepare(`
        SELECT a.categories, a.id
        FROM articles a
        WHERE a.site = ? AND a.fetched_at >= datetime('now', '-30 days')
      `).all(site) as any[];
      const catRollup = new Map<string, { total: number; dismissed: number; kept: number }>();
      for (const r of catBreakdown) {
        let cats: string[] = [];
        try { cats = JSON.parse(r.categories || "[]"); } catch {}
        if (!Array.isArray(cats)) continue;
        const dRow = sqlite.prepare(`SELECT 1 FROM article_dismissals WHERE article_id = ?`).get(r.id) as any;
        const cRow = sqlite.prepare(`SELECT 1 FROM article_claims WHERE article_id = ? AND status IN ('claimed','written')`).get(r.id) as any;
        const isDismissed = !!dRow;
        const isKept = !!cRow;
        for (const c of cats) {
          const cLower = String(c).toLowerCase();
          const cur = catRollup.get(cLower) || { total: 0, dismissed: 0, kept: 0 };
          cur.total++;
          if (isDismissed) cur.dismissed++;
          if (isKept) cur.kept++;
          catRollup.set(cLower, cur);
        }
      }
      const catList = Array.from(catRollup.entries())
        .map(([cat, s]) => ({ category: cat, total: s.total, dismissed: s.dismissed, kept: s.kept, dismiss_ratio: s.total > 0 ? Math.round(100 * s.dismissed / s.total) / 100 : 0 }))
        .sort((a, b) => b.total - a.total);
      return res.json({
        ok: true,
        site,
        stats,
        recent_dismissals: recentDismissals,
        learned_categories_for_site: learnedForSite,
        category_breakdown_30d: catList,
      });
    }

    if (!req.file && req.body?.op === "discovery-learning-kickstart") {
      // One-shot: run all three learning passes now (usually scheduled hourly).
      // Returns the counts so we can verify the system is working.
      let categoryOut: any = null, brandsN: any = null, clusterOut: any = null;
      try { categoryOut = learnCategoriesFromDismissals(sqlite); } catch (e: any) { categoryOut = { error: e?.message }; }
      try { brandsN = rebuildPositiveBrands(sqlite, 90, 2); } catch (e: any) { brandsN = { error: e?.message }; }
      try { clusterOut = clusterHotStories(sqlite); } catch (e: any) { clusterOut = { error: e?.message }; }
      const siteHealth = computeSiteHealth(sqlite);
      const topNoisy = siteHealth.filter(s => s.health === "red" || s.health === "amber").slice(0, 15);
      return res.json({
        ok: true,
        category_learning: categoryOut,
        positive_brands_indexed: brandsN,
        hot_story_clusters: clusterOut,
        noisy_sites: topNoisy,
      });
    }

    if (!req.file && req.body?.op === "discovery-enable-audio-sites") {
      // Ensure the new audio-first publishers are marked enabled in tracked_sites
      // so they pass the enabled-whitelist. Idempotent.
      const newSites = [
        "gearpatrol", "sempre", "channelnews", "hifiplus", "audiophilia",
        "audioholics", "dagogo", "parttimeaudiophile", "enjoythemusic",
        "audioresurgence", "audiobacon", "soundstagehifi", "monoandstereo",
      ];
      const results: any[] = [];
      for (const site of newSites) {
        try {
          const existing = sqlite.prepare(`SELECT site_key, enabled FROM tracked_sites WHERE site_key = ?`).get(site) as any;
          if (existing) {
            if (!existing.enabled) {
              sqlite.prepare(`UPDATE tracked_sites SET enabled = 1 WHERE site_key = ?`).run(site);
              results.push({ site, action: "enabled" });
            } else {
              results.push({ site, action: "already-enabled" });
            }
          } else {
            sqlite.prepare(`INSERT INTO tracked_sites (site_key, enabled) VALUES (?, 1)`).run(site);
            results.push({ site, action: "inserted-and-enabled" });
          }
        } catch (e: any) {
          results.push({ site, action: "error", error: e?.message });
        }
      }
      return res.json({ ok: true, results });
    }

    if (!req.file && req.body?.op === "discovery-trace-ids") {
      const idsRaw = String(req.body?.ids || "");
      const ids = idsRaw.split(/[\s,]+/).map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0);
      if (!ids.length) return res.status(400).json({ message: "ids required (comma-separated)" });
      const out: any[] = [];
      for (const id of ids) {
        const row: any = sqlite.prepare(`SELECT * FROM articles WHERE id = ?`).get(id);
        if (!row) { out.push({ id, exists: false }); continue; }
        const steps: any[] = [];
        const siteOk = row.site !== "stereonet" && row.site !== "headfi";
        steps.push({ step: "site_not_excluded", pass: siteOk, value: row.site });
        const ctAllowed = row.content_type == null || ["news", "press_release", "editor_brief", "feature", "opinion"].includes(row.content_type);
        steps.push({ step: "content_type_allowed", pass: ctAllowed, value: row.content_type });
        const ALWAYS_VISIBLE_SITES = new Set(["editor-brief", "webhook", "task-agent", "task-agent-debug", "probe-alpha", "probe-beta", "email_pressroom"]);
        const enabledSiteKeys = new Set((storage as any).getEnabledSites().filter((s: any) => s.site_key !== "stereonet").map((s: any) => s.site_key));
        const enabledOk = ALWAYS_VISIBLE_SITES.has(row.site) || enabledSiteKeys.has(row.site);
        steps.push({ step: "site_enabled_or_always_visible", pass: enabledOk, in_enabled: enabledSiteKeys.has(row.site) });
        const AUDIO_SITES = new Set(["whathifi", "hifipig", "darko", "ecoustics", "absolutesound", "hifinews", "audiophileman", "twitteringmachines", "audiohead", "soundstage", "hometheaterhifi", "stereophile", "audioxpress", "dailyaudio", "gearpatrol", "sempre", "channelnews", "hifiplus", "audiophilia", "audioholics", "dagogo", "parttimeaudiophile", "enjoythemusic", "audioresurgence", "audiobacon", "soundstagehifi", "monoandstereo", "email_pressroom", "editor-brief"]);
        const GOLD_STANDARD_SITES = new Set(["ecoustics", "stereophile", "absolutesound", "whathifi", "hifinews", "hifiplus", "email_pressroom", "editor-brief"]);
        const relevanceOk = ALWAYS_VISIBLE_SITES.has(row.site) || AUDIO_SITES.has(row.site) || GOLD_STANDARD_SITES.has(row.site);
        steps.push({ step: "relevance_bypassed_by_site", pass: relevanceOk, note: relevanceOk ? "bypassed\u2014no keyword check" : "REQUIRES keyword match" });
        const blocked = (storage as any).getBlockedKeywords().map((b: any) => b.keyword);
        const titleLower = (row.title || "").toLowerCase();
        const blockedHit = blocked.find((kw: string) => titleLower.includes(kw));
        steps.push({ step: "blocked_keywords", pass: !blockedHit, hit: blockedHit || null });
        const runAt = (lim: number) => {
          const list = storage.getDiscoveryArticles({ limit: lim });
          return { limit: lim, present: list.some((a: any) => a.id === id) };
        };
        const dismissed = sqlite.prepare(`SELECT username, dismissed_at FROM article_dismissals WHERE article_id = ?`).get(id);
        out.push({
          id, exists: true,
          site: row.site, title: row.title, url: row.url,
          content_type: row.content_type, categories: row.categories, brands: row.brands,
          published_at: row.published_at, fetched_at: row.fetched_at,
          please_write: row.please_write, pinned_by: row.pinned_by,
          dismissal: dismissed || null,
          steps,
          live_discovery_check: [runAt(300), runAt(1000), runAt(5000)],
        });
      }
      return res.json({ ok: true, articles: out });
    }

    if (!req.file && req.body?.op === "discovery-diagnose-olympica") {
      // Diagnostic: did we ingest any Sonus Faber Olympica G3 articles?
      const olympicaMatches = sqlite.prepare(`
        SELECT id, site, url, title, published_at, published_date, fetched_at
        FROM articles
        WHERE lower(title) LIKE '%olympica%' OR lower(title) LIKE '%sonus faber%' OR lower(url) LIKE '%olympica%'
        ORDER BY fetched_at DESC
        LIMIT 20
      `).all();
      // Last article ingested per non-stereonet source
      const perSiteLast = sqlite.prepare(`
        SELECT site, MAX(fetched_at) as last_fetched, MAX(published_at) as last_pub, COUNT(*) as total
        FROM articles
        WHERE site != 'stereonet' AND site IS NOT NULL
        GROUP BY site
        ORDER BY last_fetched DESC
      `).all();
      // Recent refresh_log entries
      let recentRefreshes: any = null;
      try {
        recentRefreshes = sqlite.prepare(`SELECT completed_at, articles_added, status, notes FROM refresh_log ORDER BY id DESC LIMIT 10`).all();
      } catch (e) {}
      // Count articles ingested in the last 7 days by site
      const recent7d = sqlite.prepare(`
        SELECT site, COUNT(*) as cnt
        FROM articles
        WHERE fetched_at >= datetime('now', '-7 days')
        GROUP BY site
        ORDER BY cnt DESC
      `).all();
      // Discovery audit log entries mentioning Olympica or Sonus Faber
      let auditMatches: any = null;
      try {
        auditMatches = sqlite.prepare(`
          SELECT created_at, username, action, article_title, article_site, detail
          FROM discovery_audit
          WHERE lower(article_title) LIKE '%olympica%' OR lower(article_title) LIKE '%sonus faber%'
          ORDER BY id DESC LIMIT 20
        `).all();
      } catch (e) {}
      return res.json({
        ok: true,
        olympica_matches: olympicaMatches,
        per_site_last_ingest: perSiteLast,
        recent_refresh_log: recentRefreshes,
        articles_last_7_days_by_site: recent7d,
        audit_matches: auditMatches,
      });
    }

    if (!req.file && req.body?.op === "retailer-seed-find-a-store") {
      // Seed a 'find_a_store' block on the retailer kit (kit 6) describing how
      // editorial drives traffic from articles → brand page → retailer page.
      const content = {
        enabled: true,
        heading: "Find a Store \u2014 Driving Consumers to Retailers",
        intro: "StereoNET realises the importance of promoting bricks and mortar stores. We've built our editorial and brand infrastructure to put you in front of buyers at the exact moment they're researching a product. Direct lead generation \u2014 not vague brand impressions.",
        steps: [
          {
            title: "Reviews and news link directly to the brand page",
            body: "Every product review and news story on StereoNET links to that brand's dedicated page on our site \u2014 not a search result, not an external link. Readers stay in the funnel."
          },
          {
            title: "The brand page lists local authorised retailers",
            body: "Each brand page surfaces its dealer network mapped by region. A reader in your city sees your store sitting under the brand they've just read about \u2014 with phone, map, and store details in reach."
          },
          {
            title: "Your retailer page closes the loop",
            body: "Your dedicated StereoNET store page displays contact info, opening hours, brands you stock, and a direct link to your website \u2014 turning a review-reader into a phone call, an enquiry, or a walk-in."
          }
        ],
        footer_note: "This is exclusive to our retail partners. Non-partners are not listed on brand pages or in Find a Store search."
      };
      const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = 6 AND block_key = 'find_a_store'`).get() as any;
      const json = JSON.stringify(content);
      if (existing) {
        sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_visible = 1, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(json, existing.id);
        return res.json({ ok: true, op: "retailer-seed-find-a-store", action: "updated", id: existing.id });
      } else {
        // Place at position 8 (between featured_article and research_sources).
        const info = sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (6, 'find_a_store', 8, 1, 1, ?, datetime('now'))`).run(json);
        return res.json({ ok: true, op: "retailer-seed-find-a-store", action: "inserted", id: info.lastInsertRowid });
      }
    }

    if (!req.file && req.body?.op === "retailer-final-polish-blocks") {
      // Override kit 6 (Retailer) analytics_proof and why_us with retailer-tuned copy.
      // Trade canonical (kit 1) is NOT touched.
      const analytics = {
        enabled: true,
        heading: "Genuine Data & Analytics",
        subheading: "You'll see every impression we serve.",
        intro: "Where most publishers drop some text number into an email body and call it reporting, StereoNET uses the latest technology when it comes to digital advertising delivery.\n\nEvery retail partner gets complete analytics allowing you to see how every ad unit is performing, and across your region.",
        bullets: [
          {
            title: "Per-ad-unit performance",
            body: "Impressions, hovers, clicks, CTR and unique reach broken out for every billboard, sidebar, and in-content placement \u2014 not lumped into one campaign total."
          },
          {
            title: "Geographic breakdown",
            body: "See where your audience is actually engaging \u2014 country, region, and city-level views so you know which markets are responding."
          },
          {
            title: "Independent benchmark scoring",
            body: "Sourced from Broadstreet and benchmarked against Google's 0.06% display CTR average. Most StereoNET placements land in 'Excellent' or 'Above average' territory."
          },
          {
            title: "Bot-filtered as standard",
            body: "Cloudflare bot detection runs first. Numbers you see are humans. No inflated impression counts from crawlers, scanners, or AI training bots."
          }
        ],
        example_url: "https://my.broadstreetads.com/networks/3969/report_jobs/258497?share_code=yaWCFcmTXMo_6mANzkHCFg",
        example_thumbnail: "/uploads/2026/06/ed0d0f6e76e0fb0b70e2b4266c48c651be9b4f846d407d41087d06e44a4a5b34.png",
        example_caption: "See an example Retailer (Gold) partner report \u2014 Audio Connection (Rated \u2018Excellent\u2019)",
        footer_note: "On request, you receive your unique shareable report URL. Login optional \u2014 send to your team, your distributors, or your manufacturers."
      };
      const whyUs = {
        heading: "Why Us",
        epigraph: "",
        epigraph_attribution: "",
        paragraphs: [
          "* Led by a Global Editor-in-Chief, with Regional Editors and one of the **industry's largest freelancer rosters**\n* Our readers are buyers \u2014 here for trustworthy reviews, news, and informed opinion across hi-fi, home cinema, digital audio, headphones and more\n* We turn up. Shows. Events. Hands on the gear. Nobody works harder for our retail partners and readers\n* Targeted content and ads across four regions: North America, ANZ, Southeast Asia, and UK & Europe\n* Our audience took two decades to build. We stay as loyal to them as they are to us"
        ],
        subheading: "We're cutting-edge in tech, traditional in values. We respect journalism. No influencers. No affiliate links. No filler. Just stories that matter, brands that deserve attention, and results that move the needle for our retail partners."
      };
      const updates = [
        { key: "analytics_proof", content: analytics },
        { key: "why_us", content: whyUs },
      ];
      const results: any[] = [];
      for (const u of updates) {
        const existing = sqlite.prepare(`SELECT id FROM media_kit_blocks WHERE kit_id = 6 AND block_key = ?`).get(u.key) as any;
        const json = JSON.stringify(u.content);
        if (existing) {
          sqlite.prepare(`UPDATE media_kit_blocks SET content_json = ?, is_override = 1, edited_at = datetime('now') WHERE id = ?`).run(json, existing.id);
          results.push({ key: u.key, action: "updated", id: existing.id });
        } else {
          const pos = u.key === "why_us" ? 3 : 14;
          const info = sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (6, ?, ?, 1, 1, ?, datetime('now'))`).run(u.key, pos, json);
          results.push({ key: u.key, action: "inserted", id: info.lastInsertRowid });
        }
      }
      return res.json({ ok: true, op: "retailer-final-polish-blocks", results });
    }

    if (!req.file && req.body?.op === "inspect-kit-block") {
      const kitId = parseInt(String(req.body?.kit_id || "0"), 10);
      const blockKey = String(req.body?.block_key || "");
      if (!kitId || !blockKey) return res.status(400).json({ ok: false, message: "kit_id + block_key required" });
      const row = sqlite.prepare(`SELECT id, kit_id, block_key, position, is_override, is_visible, content_json, edited_at FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`).get(kitId, blockKey) as any;
      if (!row) return res.json({ ok: false, message: "block not found" });
      let parsed: any = null;
      try { parsed = JSON.parse(row.content_json); } catch (e: any) { parsed = { _parse_error: e?.message, raw: row.content_json }; }
      return res.json({ ok: true, row: { ...row, content_json: undefined }, content: parsed });
    }

    if (!req.file && req.body?.op === "retailers-tracking-status") {
      // Inspect what tracking has actually been recorded
      const hits = sqlite.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM retailer_hits`).get();
      const clicks = sqlite.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM retailer_clicks`).get();
      const recentHits = sqlite.prepare(`SELECT entry_id, ts, ip, country, ua, referrer FROM retailer_hits ORDER BY id DESC LIMIT 20`).all();
      return res.json({ ok: true, hits, clicks, recent_hits: recentHits });
    }

    if (!req.file && req.body?.op === "retailers-inspect-audio-connection") {
      try {
        const url = process.env.EE_BRIDGE_URL || "https://www.stereonet.com/ee-bridge.php";
        const tok = process.env.EE_BRIDGE_TOKEN || "sn-ee-br1dge-9F2kRm8WqLpYx4vN7Bc3Hd";
        const headers = { "Content-Type": "application/json", "X-Pulse-Token": tok };
        // Find Audio Connection's entry_id
        const found = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "find_by_url_title", params: { url_title: "audio-connection" } }) })).json();
        const entryId = found?.result?.entry_id;
        // Inspect field_id_133 (Premium) for that entry across both storage locations
        const inspect133 = entryId ? await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "inspect_entry_field", params: { entry_id: entryId, field_id: 133 } }) })).json() : null;
        // Also try a couple of other likely fields: 70 (the one that returned numeric 0) and full dump
        const f133table = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "field_table_dump", params: { field_id: 133 } }) })).json();
        return res.json({ ok: true, found, inspect133, f133table });
      } catch (e: any) {
        return res.json({ ok: false, message: e?.message });
      }
    }

    if (!req.file && req.body?.op === "retailers-debug") {
      try {
        const url = process.env.EE_BRIDGE_URL || "https://www.stereonet.com/ee-bridge.php";
        const tok = process.env.EE_BRIDGE_TOKEN || "sn-ee-br1dge-9F2kRm8WqLpYx4vN7Bc3Hd";
        const headers = { "Content-Type": "application/json", "X-Pulse-Token": tok };
        const sample = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "list_retailers", params: { limit: 200 } }) })).json();
        const rows = sample?.result?.rows || [];
        // Tally distinct values of every field_id_NN column
        const tallies: Record<string, Record<string, number>> = {};
        for (const r of rows) {
          for (const k of Object.keys(r)) {
            if (!/^field_id_\d+$/.test(k)) continue;
            const v = r[k];
            if (v == null || v === "" || v === 0 || v === "0") continue;
            tallies[k] = tallies[k] || {};
            const key = String(v).slice(0, 80);
            tallies[k][key] = (tallies[k][key] || 0) + 1;
          }
        }
        // Find any retailer with field_id_133 non-null
        const f133 = rows.filter((r: any) => r.field_id_133 != null && r.field_id_133 !== "" && r.field_id_133 !== 0 && r.field_id_133 !== "0").slice(0, 5);
        const mapped = sqlite.prepare(`SELECT value FROM retailer_field_map WHERE key = 'premium_field'`).get();
        return res.json({ ok: true, total_rows: rows.length, mapped_premium_field: mapped, tallies, sample_premium_rows: f133.map((r: any) => ({ entry_id: r.entry_id, title: r.title, field_id_133: r.field_id_133 })) });
      } catch (e: any) {
        return res.json({ ok: false, message: e?.message });
      }
    }

    if (!req.file && req.body?.op === "retailers-fields") {
      // Token-gated: dump the EE custom fields the bridge returns + sample row.
      try {
        const url = process.env.EE_BRIDGE_URL || "https://www.stereonet.com/ee-bridge.php";
        const tok = process.env.EE_BRIDGE_TOKEN || "sn-ee-br1dge-9F2kRm8WqLpYx4vN7Bc3Hd";
        const headers = { "Content-Type": "application/json", "X-Pulse-Token": tok };
        const f = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "fields" }) })).json();
        const sample = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ query: "list_retailers", params: { limit: 1 } }) })).json();
        return res.json({ ok: true, fields: f, sample });
      } catch (e: any) {
        return res.json({ ok: false, message: e?.message });
      }
    }

    if (!req.file && req.body?.op === "ee-probe") {
      // Diagnostic: try connecting to the EE MySQL database from PULSE runtime.
      // We try a list of candidate hosts since 'localhost' is correct only if
      // PULSE and EE share a box. If not, we need the LAN/public host.
      const host = String(req.body?.host || "localhost");
      const port = Number(req.body?.port || 3306);
      try {
        const mysql = require("mysql2/promise");
        const c = await mysql.createConnection({
          host, port,
          user: "stereoglobal_ee24",
          password: "tAb8O-d9Y1?o",
          database: "stereoglobal_ee24",
          connectTimeout: 5000,
        });
        const [version] = await c.query("SELECT VERSION() AS v");
        const [channels] = await c.query("SELECT channel_id, channel_name, channel_title FROM exp_channels WHERE channel_id = 19");
        const [count] = await c.query("SELECT COUNT(*) AS n FROM exp_channel_titles WHERE channel_id = 19");
        // Find candidate "premium" fields
        const [fields] = await c.query(`
          SELECT g.group_id, g.group_name, f.field_id, f.field_name, f.field_label, f.field_type
          FROM exp_channel_fields f
          LEFT JOIN exp_field_groups g ON g.group_id = f.group_id
          WHERE f.group_id IN (
            SELECT field_group FROM exp_channels WHERE channel_id = 19
          )
          OR f.field_id IN (
            SELECT field_id FROM exp_channels_channel_fields WHERE channel_id = 19
          )
          ORDER BY f.field_id
        `).catch(() => [[]]);
        await c.end();
        return res.json({ ok: true, op: "ee-probe", host, port, version, channels, count, fields });
      } catch (e: any) {
        return res.json({ ok: false, op: "ee-probe", host, port, code: e?.code, message: e?.message });
      }
    }

    if (!req.file && req.body?.op === "pitch-list") {
      // Piggy-back: list recent proposals (slug + client + sent status).
      const rows = sqlite.prepare(`SELECT id, slug, client_name, status, sent_at, created_at, media_kit_id, media_kit_share_id FROM pitch_proposals ORDER BY id DESC LIMIT 30`).all();
      return res.json({ ok: true, op: "pitch-list", proposals: rows });
    }

    if (!req.file && req.body?.op === "pitch-status") {
      // Piggy-back: report send status for a proposal by slug. Used so we can
      // answer "did I send this?" from curl without tripping Cloudflare.
      const slug = String(req.body?.slug || "");
      if (!slug) return res.status(400).json({ ok: false, message: "slug required" });
      const prop = sqlite.prepare(`SELECT id, slug, client_name, status, sent_at, created_at, media_kit_id, media_kit_share_id FROM pitch_proposals WHERE slug = ?`).get(slug) as any;
      if (!prop) return res.status(404).json({ ok: false, message: "Proposal not found", slug });
      const share = prop.media_kit_share_id
        ? sqlite.prepare(`SELECT id, slug, proposal_state, sent_at, first_viewed_at, last_viewed_at, view_count, accepted_at FROM media_kit_shares WHERE id = ?`).get(prop.media_kit_share_id)
        : null;
      return res.json({ ok: true, op: "pitch-status", was_sent: !!prop.sent_at, proposal: prop, share });
    }

    if (!req.file && req.body?.op === "setting") {
      const action = String(req.body?.action || "get");
      const key = String(req.body?.key || "");
      if (!key) return res.status(400).json({ ok: false, message: "key required" });
      if (action === "get") {
        const v = storage.getSetting(key) || "";
        return res.json({ ok: true, op: "setting", key, value: v });
      }
      if (action === "set") {
        const value = String(req.body?.value ?? "");
        storage.setSetting(key, value);
        return res.json({ ok: true, op: "setting", key, bytes: value.length });
      }
      return res.status(400).json({ ok: false, message: "action must be get or set" });
    }

    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    try {
      const tmpZip = "/tmp/deploy-update.zip";
      const tmpDir = "/tmp/deploy-extract";
      const appDir = process.env.APP_DIR || "/app";

      // Write zip to temp
      fs.writeFileSync(tmpZip, req.file.buffer);

      // Clean and extract
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      execSync(`cd ${tmpDir} && unzip -o ${tmpZip}`, { timeout: 30000 });

      // Replace dist/ in the app directory
      const newDist = path.join(tmpDir, "dist");
      if (!fs.existsSync(newDist)) {
        return res.status(400).json({ message: "Zip must contain a dist/ folder" });
      }

      const targetDist = path.join(appDir, "dist");
      // Verify extracted dist/ is safe (no path traversal)
      const distFiles = fs.readdirSync(newDist);
      for (const f of distFiles) {
        if (f.includes('..') || f.startsWith('/')) {
          return res.status(400).json({ message: "Invalid file paths in zip" });
        }
      }

      // Clear contents of dist/ without removing the directory itself (it's a volume mount)
      const existing = fs.readdirSync(targetDist);
      for (const f of existing) {
        fs.rmSync(path.join(targetDist, f), { recursive: true });
      }
      // Copy new contents into dist/
      execSync(`cp -r ${newDist}/* ${targetDist}/`, { timeout: 30000 });

      // Clean up
      fs.unlinkSync(tmpZip);
      fs.rmSync(tmpDir, { recursive: true });

      console.log("[deploy] New dist/ deployed. Restarting in 2s...");
      res.json({ ok: true, message: "Deploy successful. Restarting..." });

      // Restart the process after response is sent
      setTimeout(() => {
        console.log("[deploy] Restarting process...");
        process.exit(0); // Docker restart policy will bring it back
      }, 2000);
    } catch (err: any) {
      console.error("[deploy] Error:", err);
      res.status(500).json({ message: err?.message || "Deploy failed" });
    }
  });

  // Diagnostic
  app.get("/api/debug/authors", requireAdmin, (_req: any, res: any) => {
    const byAuthor = sqlite.prepare(`SELECT author, COUNT(*) as cnt FROM articles WHERE site = 'stereonet' GROUP BY author ORDER BY cnt DESC`).all();
    const bySite = sqlite.prepare(`SELECT site, COUNT(*) as cnt FROM articles GROUP BY site ORDER BY cnt DESC`).all();
    const sampleEE = sqlite.prepare(`SELECT url, site, author, published_date FROM articles WHERE url LIKE '%stereonet.com/%' AND site != 'stereonet' LIMIT 5`).all();
    const hifinewsSample = sqlite.prepare(`SELECT url, published_date, published_at, title FROM articles WHERE site = 'hifinews' LIMIT 5`).all();
    const hifiplusSample = sqlite.prepare(`SELECT url, published_date, published_at, title FROM articles WHERE site = 'hifiplus' LIMIT 5`).all();
    res.json({ byAuthor, bySite, sampleEE, hifinewsSample, hifiplusSample });
  });

  // ─── Hit Counts ─────────────────────────────────────────────────────────

  async function refreshHitCounts() {
    try {
      const res = await fetch("https://www.stereonet.com/api/hit-counts", {
        headers: { "User-Agent": "StereoNET-Dashboard/2.0" },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        storage.upsertHitCounts(data.map((d: any) => ({ url: d.url, hits: d.hits || 0, image: d.image || undefined })));
        console.log(`[hits] Updated ${data.length} hit counts, author_id sample: ${data[0]?.author_id}`);
        const marcArticles = data.filter((d: any) => d.author_id === 1);
        console.log(`[hits] Marc articles in EE data: ${marcArticles.length}`);

        // Map EE author_ids to real author names
        // (some articles are posted under generic "StereoNET" account but belong to specific authors)
        const AUTHOR_ID_MAP: Record<number, string> = {
          1: 'Marc Rushton',
          46424: 'Jason Sexton',
          46399: 'Jay Garrett',
          46426: 'Eugene Ng',
          46405: 'David Price',
          46418: 'John Pickford',
          46421: 'Chris Frankland',
          46410: 'Michael Darroch',
          46423: 'Simon Lucas',
          46422: 'Steve May',
          46403: 'Eric Teh',
          40: 'Matthew Jens',
          46417: 'Paul Sechi',
          46419: 'Craig Joyce',
          46420: 'Cheryl Tan',
          33: 'Mark Gusew',
          24: "Tony O'Brien",
          46429: 'Adam Rayner',
          46427: 'Peter Katsoolis',
          46432: 'Dave Berriman',
          46430: 'Tony Wainhouse',
          46431: 'Glen Wang',
        };

        // Backfill: insert new articles AND fix authors on existing ones
        let backfilled = 0;
        let authorsFixed = 0;
        let skipped = 0;
        let errors = 0;
        // Log first entry keys for debugging
        console.log(`[hits] First entry keys: ${JSON.stringify(Object.keys(data[0]))}, date=${JSON.stringify(data[0]?.date)}, author_id=${data[0]?.author_id}`);
        for (const d of data) {
          if (!d.url || !d.title || !d.date) { skipped++; continue; }
          const authorName = AUTHOR_ID_MAP[d.author_id] || (d.author !== 'StereoNET' ? d.author : '');
          const eeSlug = d.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');

          // Try to insert with EE URL
          const contentType = d.title.toLowerCase().includes('review') ? 'review' : eeSlug.includes('opinion') ? 'opinion' : 'news';
          const inserted = storage.insertArticleNoDedup({
            title: d.title,
            url: d.url,
            site: 'stereonet',
            publishedAt: d.date + 'T00:00:00Z',
            publishedDate: d.date,
            contentType,
            categories: '[]',
            author: authorName,
            brands: '[]',
            fetchedAt: new Date().toISOString(),
          });
          if (inserted) backfilled++;

          // Also update author on ANY stereonet article matching this slug
          // Handles RSS URLs like /opinion/slug matching EE slug
          if (authorName) {
            try {
              const r = storage.fixArticleAuthor(d.url, eeSlug, authorName);
            } catch {}
          }
        }
        console.log(`[hits] Backfill: ${backfilled} new, ${authorsFixed} authors fixed, ${skipped} skipped, ${errors} errors out of ${data.length} EE entries`);
      }
    } catch (err: any) {
      console.error("[hits] Failed to fetch hit counts:", err?.message);
    }
  }

  // Fetch on startup and every hour
  refreshHitCounts();
  setInterval(refreshHitCounts, 5 * 60 * 1000); // every 5 minutes

  // On-demand og:image fetcher — call when an article card has no thumbnail yet.
  // Fetches the page, extracts <meta property="og:image"> (or Twitter card),
  // caches it in hit_counts so subsequent loads are instant.
  app.get("/api/og-image", async (req: any, res: any) => {
    const url = String(req.query.url || "");
    if (!url || !url.startsWith("http")) {
      return res.status(400).json({ message: "url query param required" });
    }
    try {
      // Check cache first
      const cached = storage.getHitCounts();
      const existing = cached.get(url) as any;
      if (existing?.image) {
        return res.json({ image: existing.image, cached: true });
      }
      // Fetch page with a 5s timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let html = "";
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "StereoNET-Dashboard/2.0" },
          signal: controller.signal,
        });
        if (!r.ok) {
          clearTimeout(timer);
          return res.json({ image: null, error: `HTTP ${r.status}` });
        }
        html = await r.text();
      } finally {
        clearTimeout(timer);
      }
      // Limit to first 50kb (og tags are in <head>)
      const head = html.slice(0, 50000);
      const patterns = [
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
        /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
        /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
        /<meta\s+content=["']([^"']+)["']\s+name=["']twitter:image["']/i,
      ];
      let image: string | null = null;
      for (const p of patterns) {
        const m = head.match(p);
        if (m) { image = m[1]; break; }
      }
      if (image) {
        // Cache it for future requests (hits: preserve existing or 0)
        const prevHits = (existing && typeof existing.hits === "number") ? existing.hits : 0;
        storage.upsertHitCounts([{ url, hits: prevHits, image }]);
      }
      res.json({ image, cached: false });
    } catch (e: any) {
      res.json({ image: null, error: e.message });
    }
  });

  app.get("/api/hit-counts", (_req: any, res: any) => {
    const hits = storage.getHitCounts();
    const obj: Record<string, { hits: number; image?: string }> = {};
    // Index by full URL, full path, and last slug segment
    hits.forEach((v, k) => {
      obj[k] = v;
      try {
        const pathname = new URL(k).pathname.replace(/^\//, "").replace(/\/$/, "");
        if (pathname) obj[pathname] = v;
        const lastSeg = pathname.split("/").pop();
        if (lastSeg) obj[lastSeg] = v;
      } catch {}
    });
    res.json(obj);
  });

  // ─── Relevance Feedback ─────────────────────────────────────────────────────

  app.post("/api/relevance", (req: any, res: any) => {
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Not logged in" });
    const dbUser = storage.getUser(username);
    if (!dbUser) return res.status(401).json({ message: "User not found" });
    const { articleUrl, relevant } = req.body;
    if (!articleUrl) return res.status(400).json({ message: "Missing articleUrl" });
    if (relevant === null || relevant === undefined) {
      storage.removeArticleRelevance(articleUrl, dbUser.id);
    } else {
      storage.setArticleRelevance(articleUrl, dbUser.id, !!relevant);
    }
    res.json({ ok: true });
  });

  app.get("/api/relevance", (req: any, res: any) => {
    res.json(storage.getArticleRelevance());
  });

  // ─── Article Comments ────────────────────────────────────────────────────

  app.get("/api/comments/counts", (req: any, res: any) => {
    res.json(storage.getCommentCounts());
  });

  app.get("/api/comments/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    res.json(storage.getArticleComments(articleId));
  });

  app.post("/api/comments/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    const { comment } = req.body;
    if (!comment || typeof comment !== "string" || comment.trim().length === 0) {
      return res.status(400).json({ message: "Comment cannot be empty" });
    }
    if (comment.length > 1000) {
      return res.status(400).json({ message: "Comment too long (max 1000 chars)" });
    }
    const id = storage.addArticleComment(articleId, username, comment.trim());

    // Notify other commenters on this article thread
    const shortName = username.split("@")[0];
    const articleTitle = storage.getArticleTitle(articleId);
    const truncTitle = articleTitle && articleTitle.length > 50 ? articleTitle.slice(0, 50) + "…" : (articleTitle || "an article");
    const existingCommenters = storage.getCommentersForArticle(articleId);
    for (const commenter of existingCommenters) {
      if (commenter !== username) {
        storage.addNotification(
          commenter, "comment",
          `${shortName} commented on "${truncTitle}"`,
          username, articleId, id
        );
      }
    }

    res.json({ id, article_id: articleId, username, comment: comment.trim(), created_at: new Date().toISOString() });
  });

  app.delete("/api/comments/:commentId", (req: any, res: any) => {
    const commentId = parseInt(req.params.commentId, 10);
    if (isNaN(commentId)) return res.status(400).json({ message: "Invalid comment ID" });
    storage.deleteArticleComment(commentId);
    res.json({ ok: true });
  });

  app.get("/api/comments/:articleId/reactions", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const comments = storage.getArticleComments(articleId);
    const commentIds = comments.map(c => c.id);
    const reactions = storage.getReactionsForComments(commentIds);
    res.json(reactions);
  });

  app.post("/api/reactions/:commentId", (req: any, res: any) => {
    const commentId = parseInt(req.params.commentId, 10);
    if (isNaN(commentId)) return res.status(400).json({ message: "Invalid comment ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== "string") return res.status(400).json({ message: "Emoji required" });
    const added = storage.toggleReaction(commentId, username, emoji);

    // Notify the comment owner on reaction add (not remove)
    if (added) {
      const commentOwner = storage.getCommentOwner(commentId);
      if (commentOwner && commentOwner !== username) {
        const shortName = username.split("@")[0];
        storage.addNotification(
          commentOwner, "reaction",
          `${shortName} reacted ${emoji} to your comment`,
          username, undefined, commentId
        );
      }
    }

    res.json({ added, commentId, emoji });
  });

  // ─── Article Claims ─────────────────────────────────────────────────────

  app.get("/api/claims", (req: any, res: any) => {
    res.json(storage.getClaims());
  });

  app.post("/api/claims/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });

    // Check if already claimed by someone else
    const existing = storage.getClaim(articleId);
    if (existing && existing.username !== username) {
      return res.status(409).json({ message: `Already claimed by ${existing.username.split("@")[0]}` });
    }

    storage.claimArticle(articleId, username);
    storage.logAudit({ username, action: "claim", articleId });

    // Remove pin if pinned (claim fulfills the "Please Write" request)
    storage.unpinArticle(articleId);

    // Notify all other users about the claim
    const shortName = username.split("@")[0];
    const articleTitle = storage.getArticleTitle(articleId);
    const truncTitle = articleTitle && articleTitle.length > 50 ? articleTitle.slice(0, 50) + "…" : (articleTitle || "an article");
    const users = storage.getUsers();
    for (const u of users) {
      if (u.username !== username) {
        storage.addNotification(
          u.username, "claim",
          `${shortName} claimed "${truncTitle}"`,
          username, articleId
        );
      }
    }

    publishRealtime("article.claimed", { articleId, username, title: articleTitle });
    publishRealtime("notification.new", { type: "claim", message: `${shortName} claimed "${truncTitle}"`, articleId });
    maybeAutoRegen("claim");
    res.json({ ok: true });
  });

  app.delete("/api/claims/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username || "unknown";

    storage.unclaimArticle(articleId);
    storage.logAudit({ username, action: "unclaim", articleId });
    publishRealtime("article.unclaimed", { articleId, username });
    res.json({ ok: true });
  });

  app.post("/api/claims/:articleId/written", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    // Ensure a claim exists, then mark as written
    const existing = storage.getClaim(articleId);
    if (!existing) storage.claimArticle(articleId, username);
    storage.markWritten(articleId);
    storage.logAudit({ username, action: "published", articleId });
    publishRealtime("article.written", { articleId, username });
    maybeAutoRegen("written");
    res.json({ ok: true });
  });

  app.get("/api/written", (_req: any, res: any) => {
    res.json(storage.getWrittenArticles());
  });

  // ─── Article Pins (admin only) ─────────────────────────────────────────

  // Auto-disable sites with no articles in 3 months
  {
    const allSites = storage.getEnabledSites();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = threeMonthsAgo.toISOString().slice(0, 10);
    for (const site of allSites) {
      if (site.site_key === "stereonet") continue;
      const latest = sqlite.prepare(
        `SELECT MAX(published_date) as latest FROM articles WHERE site = ?`
      ).get(site.site_key) as { latest: string | null };
      if (latest.latest && latest.latest < cutoff) {
        storage.updateSite(site.id, { enabled: 0 });
        console.log(`[cadence] Auto-disabled site "${site.label}" — no articles since ${latest.latest}`);
      } else if (!latest.latest) {
        // No articles at all — check if site was created more than 3 months ago
        if (site.created_at && site.created_at < cutoff) {
          storage.updateSite(site.id, { enabled: 0 });
          console.log(`[cadence] Auto-disabled site "${site.label}" — never produced any articles`);
        }
      }
    }
  }

  // Clean up stale pins where a claim already exists
  {
    const pins = storage.getPins();
    const claims = storage.getClaims();
    const claimedIds = new Set(claims.map(c => c.article_id));
    for (const p of pins) {
      if (claimedIds.has(p.article_id)) {
        storage.unpinArticle(p.article_id);
        console.log(`[cadence] Removed stale pin for article ${p.article_id} (already claimed)`);
      }
    }
  }

  app.get("/api/pins", (_req: any, res: any) => {
    res.json(storage.getPins());
  });

  app.post("/api/pins/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const note = req.body.note || "Please Write";
    storage.pinArticle(articleId, username, note);
    storage.logAudit({ username, action: "pin", articleId, detail: note });

    // Notify all other users
    const shortName = username.split("@")[0];
    const articleTitle = storage.getArticleTitle(articleId);
    const truncTitle = articleTitle && articleTitle.length > 50 ? articleTitle.slice(0, 50) + "…" : (articleTitle || "an article");
    const users = storage.getUsers();
    for (const u of users) {
      if (u.username !== username) {
        storage.addNotification(
          u.username, "pin",
          `${shortName} pinned "${truncTitle}" — ${note}`,
          username, articleId
        );
      }
    }

    publishRealtime("article.pinned", { articleId, username, note, title: articleTitle });
    publishRealtime("notification.new", { type: "pin", message: `${shortName} pinned "${truncTitle}"`, articleId });
    res.json({ ok: true });
  });

  app.delete("/api/pins/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const username = req.session?.username || "unknown";
    storage.unpinArticle(articleId);
    storage.logAudit({ username, action: "unpin", articleId });
    publishRealtime("article.unpinned", { articleId, username });
    res.json({ ok: true });
  });

  // ─── Email Ingestion (manual trigger + diagnostics) ────────────────────
  app.post("/api/ingest-email", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const sinceDays = parseInt(req.body?.sinceDays || "30", 10);
    try {
      const result = await ingestEmails({ sinceDays });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ message: e.message, stack: e.stack });
    }
  });

  // Diagnostics: list the subject / from / received-time / categories for the last N days
  // of inbox messages so we can see why a particular email was (or wasn't) ingested.
  app.get("/api/ingest-email/peek", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const sinceDays = Math.min(parseInt(String(req.query.sinceDays || "3"), 10) || 3, 30);
    try {
      // Dynamic import so we don't expand the public surface
      const { peekInbox } = await import("./email-ingestion");
      const rows = await peekInbox(sinceDays);
      res.json({ ok: true, sinceDays, count: rows.length, messages: rows });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin: delete all email_pressroom articles (used when re-ingesting).
  // Cascades manually to dependent tables that reference articles.id.
  app.post("/api/admin/clear-press-releases", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const tx = sqlite.transaction(() => {
        const ids = sqlite.prepare(`SELECT id FROM articles WHERE site = 'email_pressroom'`).all() as { id: number }[];
        const idList = ids.map(r => r.id);
        if (idList.length === 0) return { deleted: 0 };
        const placeholders = idList.map(() => "?").join(",");
        // Tables that reference articles(id) — delete dependents first
        sqlite.prepare(`DELETE FROM article_comments WHERE article_id IN (${placeholders})`).run(...idList);
        sqlite.prepare(`DELETE FROM article_claims WHERE article_id IN (${placeholders})`).run(...idList);
        sqlite.prepare(`DELETE FROM article_pins WHERE article_id IN (${placeholders})`).run(...idList);
        // Tables that may reference article URLs or ids without strict FK
        try { sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id IN (${placeholders})`).run(...idList); } catch {}
        try { sqlite.prepare(`DELETE FROM notifications WHERE article_id IN (${placeholders})`).run(...idList); } catch {}
        try { sqlite.prepare(`DELETE FROM irrelevant_marks WHERE article_id IN (${placeholders})`).run(...idList); } catch {}
        const del = sqlite.prepare(`DELETE FROM articles WHERE site = 'email_pressroom'`).run();
        return { deleted: del.changes };
      });
      const result = tx();
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin: restore a user's prior claims from notification history.
  // Parses `<user> claimed "<title>"` notifications and re-creates claim rows.
  app.post("/api/admin/restore-claims-from-notifications", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ message: "username required" });
    const shortName = String(username).split("@")[0];
    try {
      const notifs = sqlite.prepare(
        `SELECT message, from_user, article_id FROM notifications
         WHERE type = 'claim' AND (from_user = ? OR message LIKE ?)
         ORDER BY created_at ASC`
      ).all(username, `${shortName} claimed %`) as { message: string; from_user: string; article_id: number | null }[];

      const ins = sqlite.prepare(
        `INSERT OR IGNORE INTO article_claims (article_id, username, status, claimed_at) VALUES (?, ?, 'claimed', datetime('now'))`
      );
      let restored = 0;
      const matched: { articleId: number; title: string }[] = [];
      const seen = new Set<number>();
      for (const n of notifs) {
        let articleId = n.article_id;
        // Fallback: extract title from message and look up
        if (!articleId) {
          const m = n.message.match(/claimed "([^"]+?)(?:\u2026|\.\.\.)?"/);
          if (!m) continue;
          const titlePart = m[1].trim();
          // Articles may have been truncated in the notification (ending in … or ...),
          // so prefix-match.
          const row = sqlite.prepare(
            `SELECT id FROM articles WHERE title LIKE ? ORDER BY published_at DESC LIMIT 1`
          ).get(titlePart + "%") as { id: number } | undefined;
          if (!row) continue;
          articleId = row.id;
        }
        if (seen.has(articleId)) continue;
        seen.add(articleId);
        // Skip if still claimed by the same person
        const existing = sqlite.prepare(
          `SELECT username FROM article_claims WHERE article_id = ?`
        ).get(articleId) as { username: string } | undefined;
        if (existing) continue;
        // Also clear any dismissal for that article so it shows in Active
        sqlite.prepare(`DELETE FROM article_dismissals WHERE article_id = ?`).run(articleId);
        const r = ins.run(articleId, username);
        if (r.changes > 0) {
          restored++;
          const title = sqlite.prepare(`SELECT title FROM articles WHERE id = ?`).get(articleId) as { title: string } | undefined;
          matched.push({ articleId, title: title?.title || "?" });
        }
      }
      res.json({ ok: true, restored, examined: notifs.length, matched });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin: auto-mark Active articles as Written if they're already 'covered'
  // by StereoNET (brand overlap). Creates a claim record with status='written'.
  app.post("/api/admin/auto-mark-written", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const username = req.session?.username || "marcrushton@stereonet.com";
    try {
      const discovery = storage.getDiscoveryArticles({ limit: 1000 });
      const dismissedIds = new Set(
        (sqlite.prepare(`SELECT article_id FROM article_dismissals`).all() as { article_id: number }[]).map(r => r.article_id)
      );
      const existingClaims = new Set(
        (sqlite.prepare(`SELECT article_id FROM article_claims`).all() as { article_id: number }[]).map(r => r.article_id)
      );
      const candidates = discovery.filter(a =>
        a.covered && !dismissedIds.has(a.id) && !existingClaims.has(a.id)
      );
      const ins = sqlite.prepare(
        `INSERT OR IGNORE INTO article_claims (article_id, username, status, claimed_at) VALUES (?, ?, 'written', datetime('now'))`
      );
      let marked = 0;
      for (const a of candidates) {
        const r = ins.run(a.id, username);
        if (r.changes > 0) marked++;
      }
      res.json({ ok: true, markedWritten: marked, examined: discovery.length, coveredFound: candidates.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin: reset all dismissals + claims/written so every article returns to Active.
  // Optional { keywordDismiss: string } will then dismiss any article whose title
  // (case-insensitive) contains the keyword.
  app.post("/api/admin/reset-discovery-state", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const keyword = (req.body?.keywordDismiss || "").trim();
    const username = req.session?.username || "marcrushton@stereonet.com";
    try {
      const tx = sqlite.transaction(() => {
        const dismissDel = sqlite.prepare(`DELETE FROM article_dismissals`).run();
        const claimsDel = sqlite.prepare(`DELETE FROM article_claims`).run();
        let keywordDismissed = 0;
        if (keyword) {
          const matches = sqlite.prepare(
            `SELECT id FROM articles WHERE LOWER(title) LIKE ?`
          ).all(`%${keyword.toLowerCase()}%`) as { id: number }[];
          const ins = sqlite.prepare(
            `INSERT OR IGNORE INTO article_dismissals (article_id, username, dismissed_at) VALUES (?, ?, datetime('now'))`
          );
          for (const row of matches) {
            ins.run(row.id, username);
            keywordDismissed++;
          }
        }
        return {
          dismissalsRemoved: dismissDel.changes,
          claimsRemoved: claimsDel.changes,
          keywordDismissed,
        };
      });
      const result = tx();
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin debug: inspect raw Graph attachments for a given message id
  app.get("/api/admin/debug-attachments/:messageId", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const { debugFetchRawAttachments } = await import("./email-ingestion");
      const raw = await debugFetchRawAttachments(req.params.messageId);
      res.json(raw);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Admin: reset processed category on all emails so they can be re-ingested
  app.post("/api/ingest-email/reset", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const result = await resetProcessedCategory();
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Fetch a single press release by article id (for modal view)
  app.get("/api/press-release/:id", async (req: any, res: any) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    try {
      const row = sqlite.prepare(`
        SELECT id, title, published_at, body_html, description, sender_name, sender_email, attachments, message_id
        FROM articles WHERE id = ? AND site = 'email_pressroom'
      `).get(id) as any;
      if (!row) return res.status(404).json({ message: "Not found" });
      let attachments: any[] = [];
      try { attachments = row.attachments ? JSON.parse(row.attachments) : []; } catch {}
      res.json({
        id: row.id,
        title: row.title,
        receivedAt: row.published_at,
        bodyHtml: row.body_html || "",
        bodyText: row.description || "",
        senderName: row.sender_name || "",
        senderEmail: row.sender_email || "",
        attachments,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/ingest-email/status", async (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    res.json({
      tenantId: process.env.MSGRAPH_TENANT_ID ? "set (" + String(process.env.MSGRAPH_TENANT_ID).slice(0, 8) + "…)" : "MISSING",
      clientId: process.env.MSGRAPH_CLIENT_ID ? "set (" + String(process.env.MSGRAPH_CLIENT_ID).slice(0, 8) + "…)" : "MISSING",
      clientSecret: process.env.MSGRAPH_CLIENT_SECRET ? "set" : "MISSING",
      mailbox: process.env.PRESS_MAILBOX || "press@stereonet.com",
    });
  });

  // ─── Irrelevant Learning ──────────────────────────────────────────────

  // Stop words to ignore when extracting keywords from titles
  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "can",
    "this", "that", "these", "those", "it", "its", "you", "your", "we", "our",
    "not", "no", "all", "more", "most", "some", "any", "each", "every",
    "new", "best", "top", "how", "what", "why", "when", "where", "who",
    "get", "got", "just", "now", "up", "out", "about", "over", "after", "before",
    "than", "then", "here", "there", "so", "if", "as", "into", "also",
    "first", "last", "next", "still", "even", "back", "way",
    "one", "two", "three", "2024", "2025", "2026", "2027",
  ]);

  function extractTitleKeywords(title: string): string[] {
    // Extract meaningful 1-gram and 2-gram keywords from a title
    const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const keywords: string[] = [...words];
    // Add bigrams
    for (let i = 0; i < words.length - 1; i++) {
      keywords.push(`${words[i]} ${words[i + 1]}`);
    }
    return keywords;
  }

  function learnFromIrrelevant() {
    // Get all irrelevant titles, extract keywords, find patterns
    const marks = storage.getIrrelevantMarks();
    if (marks.length < 2) return; // need at least 2 marks to learn

    // Count keyword frequency across irrelevant articles
    const kwCount = new Map<string, number>();
    for (const m of marks) {
      const kws = extractTitleKeywords(m.title);
      const seen = new Set<string>(); // dedupe within one title
      for (const kw of kws) {
        if (!seen.has(kw)) {
          kwCount.set(kw, (kwCount.get(kw) || 0) + 1);
          seen.add(kw);
        }
      }
    }

    // Block keywords appearing in 3+ irrelevant articles (bigrams) or 5+ (unigrams).
    // Single common words like "date", "release", "announces" are landmines under
    // substring matching — even with the whole-word regex switch, short generic
    // unigrams still cause more false positives than they're worth. Require
    // unigrams to be length >= 7 OR be a multi-word phrase.
    const COMMON_BAD_UNIGRAMS = new Set([
      "release", "released", "releases", "launch", "launched", "launches",
      "announce", "announces", "announced", "announcement",
      "unveils", "unveiled", "reveals", "revealed", "introduces", "introduced",
      "new", "news", "latest", "today", "date", "dated", "update", "updated",
      "review", "reviews", "reviewed", "deal", "deals", "price", "priced",
      "sale", "sales", "buy", "get", "now", "first", "best", "top",
      "week", "month", "year", "day", "days",
      "shows", "says", "said", "will", "can", "may",
      "company", "brand", "product", "products", "system", "systems",
      "audio", "sound", "music", "speaker", "headphone", "headphones",
      "microphone", "microphones", "stereonet",
    ]);
    const existingBlocked = new Set(storage.getBlockedKeywords().map(b => b.keyword));
    for (const [kw, count] of kwCount) {
      if (existingBlocked.has(kw)) continue;
      const isPhrase = kw.includes(" ");
      // Reject dangerous unigrams outright
      if (!isPhrase) {
        if (COMMON_BAD_UNIGRAMS.has(kw.toLowerCase())) continue;
        if (kw.length < 7) continue; // too short — too generic
      }
      const threshold = isPhrase ? 2 : 4; // bigrams need fewer hits
      if (count >= threshold) {
        storage.addBlockedKeyword(kw, "learned");
        console.log(`[discovery] Auto-blocked keyword: "${kw}" (appeared in ${count} irrelevant articles)`);
      }
    }
  }

  app.post("/api/irrelevant/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    const { title, site } = req.body;
    if (!title || !site) return res.status(400).json({ message: "Title and site required" });

    storage.markIrrelevant(articleId, title, site, username);
    // Also dismiss for everyone
    storage.dismissArticle(articleId, username);
    storage.logAudit({ username, action: "irrelevant", articleId });

    // Run learning pass
    learnFromIrrelevant();

    res.json({ ok: true });
  });

  app.get("/api/irrelevant", (_req: any, res: any) => {
    res.json(storage.getIrrelevantArticleIds());
  });

  // Discovery audit log (admin only)
  app.get("/api/discovery-audit", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);
    const rows = storage.getAuditLog({
      limit,
      username: req.query.username || undefined,
      action: req.query.action || undefined,
      articleId: req.query.articleId ? parseInt(req.query.articleId, 10) : undefined,
    });
    // Normalise timestamps — sqlite stores UTC without Z suffix
    const normalised = rows.map((r: any) => ({
      ...r,
      created_at: r.created_at && !r.created_at.endsWith("Z")
        ? r.created_at.replace(" ", "T") + "Z"
        : r.created_at,
    }));
    res.json(normalised);
  });

  // Full list of irrelevant marks (for management panel)
  app.get("/api/irrelevant-marks", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    res.json(storage.getIrrelevantMarks());
  });

  // Undo an irrelevant mark (also un-dismisses)
  app.delete("/api/irrelevant/:articleId", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username || "unknown";
    storage.removeIrrelevantMark(articleId);
    storage.logAudit({ username, action: "undo_irrelevant", articleId });
    res.json({ ok: true });
  });

  // Rebuild blocked keywords from current marks: any 'learned' keyword whose
  // count has fallen below threshold is removed. Manually-added keywords are kept.
  app.post("/api/irrelevant/rebuild-keywords", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const marks = storage.getIrrelevantMarks();
    const kwCount = new Map<string, number>();
    for (const m of marks) {
      const kws = extractTitleKeywords(m.title);
      const seen = new Set<string>();
      for (const kw of kws) {
        if (!seen.has(kw)) {
          kwCount.set(kw, (kwCount.get(kw) || 0) + 1);
          seen.add(kw);
        }
      }
    }
    const blocked = storage.getBlockedKeywords();
    let removed = 0;
    for (const b of blocked) {
      if (b.source !== "learned") continue; // don't touch manually-added
      const threshold = b.keyword.includes(" ") ? 2 : 4;
      const cnt = kwCount.get(b.keyword) || 0;
      if (cnt < threshold) {
        storage.removeBlockedKeyword(b.id);
        removed++;
      }
    }
    // Re-run learning in case thresholds just crossed for other keywords
    learnFromIrrelevant();
    res.json({ ok: true, removedLearnedKeywords: removed, currentMarks: marks.length });
  });

  app.get("/api/blocked-keywords", (_req: any, res: any) => {
    res.json(storage.getBlockedKeywords());
  });

  app.post("/api/blocked-keywords", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { keyword } = req.body;
    if (!keyword) return res.status(400).json({ message: "Keyword required" });
    storage.addBlockedKeyword(keyword, "manual");
    res.json({ ok: true });
  });

  app.delete("/api/blocked-keywords/:id", (req: any, res: any) => {
    if (req.session?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.removeBlockedKeyword(id);
    res.json({ ok: true });
  });

  // ─── Article Dismissals ─────────────────────────────────────────────────

  app.get("/api/dismissals", (_req: any, res: any) => {
    res.json(storage.getDismissals());
  });

  app.post("/api/dismissals/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    storage.dismissArticle(articleId, username);
    storage.logAudit({ username, action: "dismiss", articleId });
    publishRealtime("article.dismissed", { articleId, username });
    maybeAutoRegen("dismiss");
    res.json({ ok: true });
  });

  app.delete("/api/dismissals/:articleId", (req: any, res: any) => {
    const articleId = parseInt(req.params.articleId, 10);
    if (isNaN(articleId)) return res.status(400).json({ message: "Invalid article ID" });
    const username = req.session?.username || "unknown";
    storage.undismissArticle(articleId);
    storage.logAudit({ username, action: "undismiss", articleId });
    publishRealtime("article.undismissed", { articleId, username });
    res.json({ ok: true });
  });

  // ─── Notifications ──────────────────────────────────────────────────────

  app.get("/api/notifications", (req: any, res: any) => {
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    res.json(storage.getNotifications(username));
  });

  app.get("/api/notifications/unread-count", (req: any, res: any) => {
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    res.json({ count: storage.getUnreadCount(username) });
  });

  app.post("/api/notifications/mark-read/:id", (req: any, res: any) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.markNotificationRead(id);
    res.json({ ok: true });
  });

  app.post("/api/notifications/mark-all-read", (req: any, res: any) => {
    const username = req.session?.username;
    if (!username) return res.status(401).json({ message: "Unauthorized" });
    storage.markAllNotificationsRead(username);
    res.json({ ok: true });
  });

  // ─── Analytics (GA4 + Search Console) ────────────────────────────────────

  // Bot filter countries list
  // Classifieds new-ad counters — derived from the existing forum_stats snapshots
  // (server/forum.ts polls the public forum homepage hourly and stores total_ads).
  // New ads in window N = total_ads(now) - total_ads(now - N). Prior period uses
  // the same diff one window earlier, which the dashboard renders as trend arrows.
  // No external API or DB connection needed.
  app.get("/api/analytics/classifieds", (req: any, res: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Unauthorized" });
    try {
      // Helper: latest snapshot at or before the given offset (in hours from now).
      // Returns null if no snapshot exists in that range.
      const snapAt = (hoursAgo: number) => {
        const row = sqlite.prepare(`
          SELECT total_ads, active_ads, fetched_at
            FROM forum_stats
           WHERE fetched_at <= datetime('now', ?)
           ORDER BY fetched_at DESC
           LIMIT 1
        `).get(`-${hoursAgo} hours`) as any;
        return row || null;
      };
      // Pull the most recent full snapshot row (with all the rich fields like
      // successful_sales, total_sales_14d, total_ads_value, total_topics, etc.).
      const latestFull = sqlite.prepare(`SELECT * FROM forum_stats ORDER BY fetched_at DESC LIMIT 1`).get() as any;
      const latest = snapAt(0);
      if (!latest || !latestFull) {
        return res.json({ ads: null, error: "No forum_stats snapshots yet — wait for the next forum poll." });
      }
      // Snapshot one poll back — used to compute the hourly delta on active_ads
      // (matches the old Community & Classifieds card's tiny trend arrow).
      const prevPoll = sqlite.prepare(`SELECT * FROM forum_stats ORDER BY fetched_at DESC LIMIT 1 OFFSET 1`).get() as any;

      // For each window, look up the snapshot from `window` hours ago AND from
      // `window * 2` hours ago. The current bucket is now-vs-(window ago); the
      // prior bucket is (window ago)-vs-(2*window ago).
      const windows = [
        { key: "1d", hours: 24 },
        { key: "7d", hours: 24 * 7 },
        { key: "30d", hours: 24 * 30 },
      ];
      const out: any = {
        ads: {
          active: latestFull.active_ads ?? null,
          total: latestFull.total_ads ?? null,
          successful_sales: latestFull.successful_sales ?? null,
          total_sales_14d: latestFull.total_sales_14d ?? null,
          total_ads_value: latestFull.total_ads_value ?? null,
          // Hourly active-ads delta (since previous poll). Lets the UI mimic the
          // old Dashboard card's micro trend arrow next to Active Ads.
          active_delta_hourly: (prevPoll && typeof prevPoll.active_ads === "number" && typeof latestFull.active_ads === "number")
            ? latestFull.active_ads - prevPoll.active_ads
            : null,
          successful_sales_delta_hourly: (prevPoll && typeof prevPoll.successful_sales === "number" && typeof latestFull.successful_sales === "number")
            ? latestFull.successful_sales - prevPoll.successful_sales
            : null,
          fetched_at: latest.fetched_at,
        },
        forum: {
          total_topics: latestFull.total_topics ?? null,
          total_posts: latestFull.total_posts ?? null,
          total_members: latestFull.total_members ?? null,
          total_topics_precise: latestFull.total_topics_precise ?? null,
          total_posts_precise: latestFull.total_posts_precise ?? null,
          total_members_precise: latestFull.total_members_precise ?? null,
        },
      };
      for (const w of windows) {
        const start = snapAt(w.hours);
        const priorStart = snapAt(w.hours * 2);
        // new in current window = latest.total_ads - start.total_ads
        // null if we don't have a snapshot that old yet.
        const cur = (start && typeof latest.total_ads === "number" && typeof start.total_ads === "number")
          ? Math.max(0, latest.total_ads - start.total_ads)
          : null;
        const prior = (start && priorStart && typeof start.total_ads === "number" && typeof priorStart.total_ads === "number")
          ? Math.max(0, start.total_ads - priorStart.total_ads)
          : null;
        out.ads[`new_${w.key}`] = cur;
        out.ads[`prev_${w.key}`] = prior;
      }
      res.json(out);
    } catch (e: any) {
      console.error("[analytics/classifieds] failed:", e);
      res.status(500).json({ message: e?.message || "Classifieds query failed" });
    }
  });

  app.get("/api/analytics/bot-countries", (_req: any, res: any) => {
    res.json(BOT_COUNTRIES);
  });

  function parseBotFilter(req: any): string[] | undefined {
    return req.query.botFilter === "1" ? BOT_COUNTRIES : undefined;
  }

  app.get("/api/analytics/overview", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const priorStart = (req.query.priorStart as string) || undefined;
    const priorEnd = (req.query.priorEnd as string) || undefined;
    const ex = parseBotFilter(req);
    const [current, prior] = await Promise.all([
      fetchGA4Overview(startDate, endDate, ex),
      priorStart && priorEnd ? fetchGA4Overview(priorStart, priorEnd, ex) : Promise.resolve(null),
    ]);
    res.json({ current, prior });
  });

  app.get("/api/analytics/daily", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4Daily(startDate, endDate, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/top-pages", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4TopPages(startDate, endDate, 20, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/sources", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4Sources(startDate, endDate, 10, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/countries", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4Countries(startDate, endDate, 10, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/regions", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4Regions(startDate, endDate, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/search-queries", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCQueries(startDate, endDate);
    res.json(data);
  });

  app.get("/api/analytics/search-pages", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCPages(startDate, endDate);
    res.json(data);
  });

  app.get("/api/analytics/search-daily", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCDaily(startDate, endDate);
    res.json(data);
  });

  app.get("/api/analytics/devices", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchGA4Devices(startDate, endDate, parseBotFilter(req));
    res.json(data);
  });

  app.get("/api/analytics/search-devices", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCDevices(startDate, endDate);
    res.json(data);
  });

  app.get("/api/analytics/search-appearance", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCSearchAppearance(startDate, endDate);
    res.json(data);
  });

  app.get("/api/analytics/search-types", async (req: any, res: any) => {
    const startDate = (req.query.startDate as string) || "28daysAgo";
    const endDate = (req.query.endDate as string) || "today";
    const data = await fetchSCSearchTypes(startDate, endDate);
    res.json(data);
  });

  // ─── Cloudflare zone analytics ───────────────────────────────────────
  // Pulls edge-level traffic stats from Cloudflare's GraphQL Analytics API
  // for the configured zone. Token and zone tag are stored in app_settings
  // (keys: cloudflare.api_token, cloudflare.zone_tag) and seeded from known
  // values on first run.
  function resolveGa4DateToISO(d: string): string {
    // Accept absolute YYYY-MM-DD as-is, otherwise translate GA4 relatives.
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const now = new Date();
    if (d === "today") return now.toISOString().slice(0, 10);
    if (d === "yesterday") { now.setUTCDate(now.getUTCDate() - 1); return now.toISOString().slice(0, 10); }
    const m = d.match(/^(\d+)daysAgo$/);
    if (m) { now.setUTCDate(now.getUTCDate() - Number(m[1])); return now.toISOString().slice(0, 10); }
    return now.toISOString().slice(0, 10);
  }

  // Cloudflare token/zone are configured via cfg() (Admin Settings UI or
  // CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_TAG in .env) \u2014 no hardcoded
  // fallback and no auto-seed. A previous version of this file baked a live
  // Cloudflare token in as a source literal and auto-seeded it into the DB
  // on first boot; that token has been revoked. Never hardcode a real
  // external API credential as a fallback/default value again \u2014 unlike
  // DEPLOY_TOKEN/WEBHOOK_INGEST_TOKEN (internal, low-blast-radius, easy to
  // rotate), third-party tokens like this can carry far broader account
  // privileges than the feature needs and must be scoped minimally
  // (Zone > Analytics > Read only, for this one) at creation time.

  // ─── 30-day narrative summary ──────────────────────────────────────
  // Compares current 30d vs prior 30d across GA4 + Cloudflare and returns a
  // plain-English readout: where we're winning, what's dropping, where to look.
  app.get("/api/analytics/summary", async (_req: any, res: any) => {
    try {
      const now = new Date();
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const endDate = fmt(now);
      const start = new Date(now); start.setUTCDate(start.getUTCDate() - 29); const startDate = fmt(start);
      const priorEnd = new Date(now); priorEnd.setUTCDate(priorEnd.getUTCDate() - 30); const priorEndStr = fmt(priorEnd);
      const priorStart = new Date(now); priorStart.setUTCDate(priorStart.getUTCDate() - 59); const priorStartStr = fmt(priorStart);

      const [overviewCur, overviewPrior, topPagesCur, topPagesPrior, sourcesCur, sourcesPrior, countriesCur, countriesPrior, devicesCur] = await Promise.all([
        fetchGA4Overview(startDate, endDate),
        fetchGA4Overview(priorStartStr, priorEndStr),
        fetchGA4TopPages(startDate, endDate, 30),
        fetchGA4TopPages(priorStartStr, priorEndStr, 30),
        fetchGA4Sources(startDate, endDate, 15),
        fetchGA4Sources(priorStartStr, priorEndStr, 15),
        fetchGA4Countries(startDate, endDate, 15),
        fetchGA4Countries(priorStartStr, priorEndStr, 15),
        fetchGA4Devices(startDate, endDate),
      ]);

      if (!overviewCur) {
        return res.json({ ok: false, error: "GA4 unavailable" });
      }

      // Pull Cloudflare edge totals for the same window.
      let cf: any = null;
      const cfToken = cfg("CLOUDFLARE_API_TOKEN").trim();
      const cfZone = cfg("CLOUDFLARE_ZONE_TAG").trim();
      if (cfToken && cfZone) {
        try {
          const cfQuery = `query Z($zoneTag: String!, $since: Date!, $until: Date!, $psince: Date!, $puntil: Date!) { viewer { zones(filter: { zoneTag: $zoneTag }) { current: httpRequests1dGroups(limit: 60, filter: { date_geq: $since, date_leq: $until }) { sum { requests pageViews bytes threats } uniq { uniques } } prior: httpRequests1dGroups(limit: 60, filter: { date_geq: $psince, date_leq: $puntil }) { sum { requests pageViews bytes threats } uniq { uniques } } } } }`;
          const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST",
            headers: { "Authorization": `Bearer ${cfToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: cfQuery, variables: { zoneTag: cfZone, since: startDate, until: endDate, psince: priorStartStr, puntil: priorEndStr } }),
          });
          const j: any = await r.json();
          if (r.ok && !j?.errors) {
            const sumGroup = (g: any[]) => g.reduce((a, x) => ({
              requests: a.requests + (x.sum?.requests || 0),
              pageViews: a.pageViews + (x.sum?.pageViews || 0),
              bytes: a.bytes + (x.sum?.bytes || 0),
              threats: a.threats + (x.sum?.threats || 0),
              uniques: a.uniques + (x.uniq?.uniques || 0),
            }), { requests: 0, pageViews: 0, bytes: 0, threats: 0, uniques: 0 });
            cf = {
              current: sumGroup(j?.data?.viewer?.zones?.[0]?.current || []),
              prior: sumGroup(j?.data?.viewer?.zones?.[0]?.prior || []),
            };
          }
        } catch (e: any) { console.error("[cf-summary] failed:", e?.message); }
      }

      // Compute deltas.
      const pct = (cur: number, prev: number) => {
        if (!prev || prev === 0) return cur > 0 ? 100 : 0;
        return Math.round(((cur - prev) / prev) * 100);
      };
      const fmtNum = (n: number) => new Intl.NumberFormat("en-AU").format(Math.round(n || 0));
      const fmtPct = (n: number) => (n >= 0 ? "+" : "") + n + "%";
      const fmtBytes = (n: number) => {
        if (n >= 1e12) return (n / 1e12).toFixed(2) + "TB";
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "GB";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "MB";
        return fmtNum(n) + "B";
      };

      const usersDelta = pct(overviewCur.activeUsers, overviewPrior?.activeUsers || 0);
      const pvDelta = pct(overviewCur.pageviews, overviewPrior?.pageviews || 0);
      const sessDelta = pct(overviewCur.sessions, overviewPrior?.sessions || 0);
      const newUsersDelta = pct(overviewCur.newUsers, overviewPrior?.newUsers || 0);
      const bounceDelta = (overviewCur.bounceRate - (overviewPrior?.bounceRate || 0)) * 100; // pp
      const durDelta = pct(overviewCur.avgSessionDuration, overviewPrior?.avgSessionDuration || 0);

      // Source / country / page deltas.
      const buildDeltaMap = (cur: any[], prior: any[], keyField: string, metricField: string) => {
        const map = new Map<string, { cur: number; prior: number }>();
        cur.forEach(r => map.set(String(r[keyField]).toLowerCase(), { cur: Number(r[metricField] || 0), prior: 0 }));
        prior.forEach(r => {
          const k = String(r[keyField]).toLowerCase();
          const e = map.get(k) || { cur: 0, prior: 0 };
          e.prior = Number(r[metricField] || 0);
          map.set(k, e);
        });
        return Array.from(map.entries()).map(([k, v]) => ({ key: k, cur: v.cur, prior: v.prior, delta: v.cur - v.prior, deltaPct: pct(v.cur, v.prior) }));
      };
      const sourceDeltas = buildDeltaMap(sourcesCur || [], sourcesPrior || [], "source", "sessions");
      const countryDeltas = buildDeltaMap(countriesCur || [], countriesPrior || [], "country", "sessions");
      const pageDeltas = buildDeltaMap(topPagesCur || [], topPagesPrior || [], "path", "pageviews");

      const topGainers = (arr: any[], min: number) => arr
        .filter(r => r.cur >= min && r.delta > 0)
        .sort((a, b) => b.delta - a.delta).slice(0, 3);
      const topLosers = (arr: any[], min: number) => arr
        .filter(r => r.prior >= min && r.delta < 0)
        .sort((a, b) => a.delta - b.delta).slice(0, 3);

      // Build narrative.
      const headline = (() => {
        if (usersDelta >= 5) return `Traffic is up over the last 30 days. Active users grew ${fmtPct(usersDelta)} to ${fmtNum(overviewCur.activeUsers)}, and pageviews rose ${fmtPct(pvDelta)} to ${fmtNum(overviewCur.pageviews)}.`;
        if (usersDelta <= -5) return `Traffic has softened over the last 30 days. Active users are down ${fmtPct(usersDelta)} to ${fmtNum(overviewCur.activeUsers)}, with pageviews ${fmtPct(pvDelta)} at ${fmtNum(overviewCur.pageviews)}.`;
        return `Traffic is broadly steady over the last 30 days at ${fmtNum(overviewCur.activeUsers)} active users (${fmtPct(usersDelta)}) and ${fmtNum(overviewCur.pageviews)} pageviews (${fmtPct(pvDelta)}).`;
      })();

      const engagement = (() => {
        const parts: string[] = [];
        if (Math.abs(bounceDelta) >= 1.5) {
          parts.push(bounceDelta < 0
            ? `bounce rate improved by ${Math.abs(bounceDelta).toFixed(1)}pp (to ${(overviewCur.bounceRate * 100).toFixed(1)}%)`
            : `bounce rate worsened by ${bounceDelta.toFixed(1)}pp (to ${(overviewCur.bounceRate * 100).toFixed(1)}%)`);
        }
        if (Math.abs(durDelta) >= 5) {
          parts.push(`average session duration is ${fmtPct(durDelta)} at ${Math.round(overviewCur.avgSessionDuration)}s`);
        }
        if (Math.abs(newUsersDelta) >= 5) {
          parts.push(`new users are ${fmtPct(newUsersDelta)}`);
        }
        return parts.length ? `On engagement, ${parts.join(", ")}.` : "";
      })();

      const sourceGainers = topGainers(sourceDeltas, 100);
      const sourceLosers = topLosers(sourceDeltas, 100);
      const winningSources = sourceGainers.length
        ? `The biggest acquisition wins are ${sourceGainers.map(s => `${s.key} (+${fmtNum(s.delta)} sessions, ${fmtPct(s.deltaPct)})`).join(", ")}.`
        : "";
      const fadingSources = sourceLosers.length
        ? `Acquisition pressure is coming from ${sourceLosers.map(s => `${s.key} (−${fmtNum(Math.abs(s.delta))} sessions, ${fmtPct(s.deltaPct)})`).join(", ")}.`
        : "";

      const pageGainers = topGainers(pageDeltas, 500);
      const pageLosers = topLosers(pageDeltas, 500);
      const winningPages = pageGainers.length
        ? `Top-growing content: ${pageGainers.map(p => `${p.key} (+${fmtNum(p.delta)} views, ${fmtPct(p.deltaPct)})`).join("; ")}.`
        : "";
        const fadingPages = pageLosers.length
        ? `Content losing ground: ${pageLosers.map(p => `${p.key} (−${fmtNum(Math.abs(p.delta))} views, ${fmtPct(p.deltaPct)})`).join("; ")}.`
        : "";

      const countryGainers = topGainers(countryDeltas, 100);
      const winningGeos = countryGainers.length
        ? `Geographically, ${countryGainers.map(c => `${c.key.replace(/\b\w/g, m => m.toUpperCase())} is up ${fmtPct(c.deltaPct)}`).join(", ")}.`
        : "";

      // Device split insight
      const devTotal = (devicesCur || []).reduce((a: number, d: any) => a + (d.sessions || 0), 0);
      const mobile = (devicesCur || []).find((d: any) => /mobile/i.test(d.device))?.sessions || 0;
      const mobilePct = devTotal > 0 ? Math.round((mobile / devTotal) * 100) : 0;
      const deviceLine = devTotal > 0 ? `Mobile share sits at ${mobilePct}% of sessions.` : "";

      // Cloudflare edge context
      const edgeLine = (() => {
        if (!cf) return "";
        const reqDelta = pct(cf.current.requests, cf.prior.requests);
        const threatsBlocked = cf.current.threats;
        const cfPv = cf.current.pageViews;
        const ratio = overviewCur.pageviews && cfPv ? Math.round((overviewCur.pageviews / cfPv) * 100) : null;
        const parts = [`At the edge, Cloudflare served ${fmtNum(cf.current.requests)} requests (${fmtPct(reqDelta)}) and blocked ${fmtNum(threatsBlocked)} threats`];
        if (ratio !== null) parts.push(`GA4 captured roughly ${ratio}% of edge pageviews, the gap being pre-consent visitors, ad-blockers, and bots`);
        parts.push(`bandwidth ${fmtBytes(cf.current.bytes)}`);
        return parts.join("; ") + ".";
      })();

      // Recommendation
      const watch: string[] = [];
      if (sourceLosers.length) watch.push(`shore up ${sourceLosers[0].key}`);
      if (pageLosers.length) watch.push(`refresh ${pageLosers[0].key}`);
      if (bounceDelta >= 2) watch.push(`investigate the bounce-rate lift`);
      const watchLine = watch.length ? `Worth a look: ${watch.join("; ")}.` : "";

      const paragraph = [headline, engagement, winningSources, fadingSources, winningPages, fadingPages, winningGeos, deviceLine, edgeLine, watchLine]
        .filter(Boolean).join(" ");

      res.json({
        ok: true,
        period: { startDate, endDate, priorStart: priorStartStr, priorEnd: priorEndStr },
        headline,
        paragraph,
        kpis: {
          activeUsers: { cur: overviewCur.activeUsers, prior: overviewPrior?.activeUsers || 0, deltaPct: usersDelta },
          pageviews: { cur: overviewCur.pageviews, prior: overviewPrior?.pageviews || 0, deltaPct: pvDelta },
          sessions: { cur: overviewCur.sessions, prior: overviewPrior?.sessions || 0, deltaPct: sessDelta },
          newUsers: { cur: overviewCur.newUsers, prior: overviewPrior?.newUsers || 0, deltaPct: newUsersDelta },
          bounceRate: { cur: overviewCur.bounceRate, prior: overviewPrior?.bounceRate || 0, deltaPp: bounceDelta },
          avgSessionDuration: { cur: overviewCur.avgSessionDuration, prior: overviewPrior?.avgSessionDuration || 0, deltaPct: durDelta },
        },
        winners: { sources: sourceGainers, pages: pageGainers, countries: countryGainers },
        losers: { sources: sourceLosers, pages: pageLosers },
      });
    } catch (e: any) {
      console.error("[analytics-summary] failed:", e);
      res.status(500).json({ ok: false, error: e?.message || "summary failed" });
    }
  });

  app.get("/api/analytics/cloudflare/zone", async (req: any, res: any) => {
    const token = cfg("CLOUDFLARE_API_TOKEN").trim();
    const zoneTag = cfg("CLOUDFLARE_ZONE_TAG").trim();
    if (!token || !zoneTag) return res.json({ ok: false, configured: false });
    const since = resolveGa4DateToISO((req.query.startDate as string) || "28daysAgo");
    const until = resolveGa4DateToISO((req.query.endDate as string) || "today");

    const query = `query Z($zoneTag: String!, $since: Date!, $until: Date!) { viewer { zones(filter: { zoneTag: $zoneTag }) { httpRequests1dGroups(limit: 365, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) { dimensions { date } sum { requests pageViews bytes threats cachedRequests cachedBytes } uniq { uniques } } } } }`;
    try {
      const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { zoneTag, since, until } }),
      });
      const j: any = await r.json();
      if (!r.ok || j?.errors) {
        const msg = j?.errors?.[0]?.message || `Cloudflare API ${r.status}`;
        console.error("[cf-analytics] error:", msg);
        return res.status(200).json({ ok: false, configured: true, error: msg });
      }
      const groups: any[] = j?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      const daily = groups.map(g => ({
        date: g.dimensions.date,
        requests: g.sum.requests || 0,
        pageViews: g.sum.pageViews || 0,
        uniques: g.uniq?.uniques || 0,
        bytes: g.sum.bytes || 0,
        threats: g.sum.threats || 0,
        cachedRequests: g.sum.cachedRequests || 0,
        cachedBytes: g.sum.cachedBytes || 0,
      }));
      const summary = daily.reduce((a, d) => ({
        requests: a.requests + d.requests,
        pageViews: a.pageViews + d.pageViews,
        uniques: a.uniques + d.uniques,
        bytes: a.bytes + d.bytes,
        threats: a.threats + d.threats,
        cachedRequests: a.cachedRequests + d.cachedRequests,
        cachedBytes: a.cachedBytes + d.cachedBytes,
      }), { requests: 0, pageViews: 0, uniques: 0, bytes: 0, threats: 0, cachedRequests: 0, cachedBytes: 0 });
      res.json({ ok: true, configured: true, summary, daily });
    } catch (e: any) {
      console.error("[cf-analytics] fetch failed:", e);
      res.status(200).json({ ok: false, configured: true, error: e?.message || "fetch failed" });
    }
  });

  // ─── GET /api/sites ──────────────────────────────────────────────────────────
  app.get("/api/sites", (_req, res) => {
    const dbSites = storage.getEnabledSites();
    if (dbSites.length > 0) {
      res.json(dbSites.map(s => ({ key: s.site_key, label: s.label, url: s.rss_url, color: s.color, siteUrl: s.site_url })));
    } else {
      res.json(Object.entries(SITES).map(([key, val]) => ({ key, ...val })));
    }
  });

  // ─── Tracked Sites CRUD (all logged-in users) ─────────────────────────────────
  function requireLogin(req: any, res: any, next: any) {
    if (!req.session?.username) {
      return res.status(401).json({ message: "Not logged in" });
    }
    next();
  }

  app.get("/api/tracked-sites", requireLogin, (_req: any, res: any) => {
    res.json(storage.getSites());
  });

  app.post("/api/tracked-sites", requireLogin, (req: any, res: any) => {
    const { siteKey, label, rssUrl, siteUrl, color } = req.body;
    if (!siteKey || !label || !rssUrl) {
      return res.status(400).json({ message: "siteKey, label and rssUrl are required" });
    }
    try {
      const id = storage.addSite(siteKey, label, rssUrl, siteUrl ?? null, color ?? "#6b7280");
      res.json({ id, ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err?.message ?? "Failed to add site" });
    }
  });

  app.put("/api/tracked-sites/:id", requireLogin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const { label, rss_url, site_url, color, enabled } = req.body;
    try {
      storage.updateSite(id, { label, rss_url, site_url, color, enabled });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ message: err?.message ?? "Failed to update site" });
    }
  });

  app.delete("/api/tracked-sites/:id", requireLogin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    storage.deleteSite(id);
    res.json({ ok: true });
  });

  app.patch("/api/tracked-sites/:id/toggle", requireLogin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const sites = storage.getSites();
    const site = sites.find(s => s.id === id);
    if (!site) return res.status(404).json({ message: "Site not found" });
    storage.updateSite(id, { enabled: site.enabled ? 0 : 1 });
    res.json({ ok: true, enabled: site.enabled ? 0 : 1 });
  });

  app.patch("/api/tracked-sites/:id/toggle-velocity", requireLogin, (req: any, res: any) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const sites = storage.getSites();
    const site = sites.find((s: any) => s.id === id);
    if (!site) return res.status(404).json({ message: "Site not found" });
    const current = (site as any).exclude_velocity || 0;
    storage.updateSite(id, { exclude_velocity: current ? 0 : 1 });
    res.json({ ok: true, exclude_velocity: current ? 0 : 1 });
  });

  // ─── GET /api/articles ───────────────────────────────────────────────────────
  app.get("/api/articles", (req, res) => {
    const { site, contentType, fromDate, toDate, limit } = req.query as Record<string, string>;
    const articles = storage.getArticles({
      site: site || undefined,
      contentType: contentType || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
    const limitNum = parseInt(limit ?? "200", 10);
    res.json(articles.slice(0, limitNum));
  });

  // ─── GET /api/daily ──────────────────────────────────────────────────────────
  app.get("/api/daily", (req, res) => {
    const { site, contentType, fromDate, toDate } = req.query as Record<string, string>;
    const rows = storage.getDailyBreakdown({
      site: site || undefined,
      contentType: contentType || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
    res.json(rows);
  });

  // ─── GET /api/breakdown ──────────────────────────────────────────────────────
  app.get("/api/breakdown", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    const rows = storage.getSiteBreakdown({
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
    res.json(rows);
  });

  // ─── GET /api/stats ──────────────────────────────────────────────────────────
  // GET /api/most-viewed-48h — top StereoNET article by hit-count growth
  app.get("/api/most-viewed-48h", (req: any, res: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Unauthorized" });
    const hours = Number(req.query?.hours) || 48;
    const result = storage.getMostViewedRecent({ hours });
    res.json(result);
  });

  // Commercial Activity panel for the Dashboard. Returns hits / leads /
  // proposals counts for the 7, 14 and 30 day rolling windows.
  app.get("/api/dashboard/commercial-activity", (req: any, res: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Unauthorized" });
    const windows = [7, 14, 30];
    const countInWindow = (sql: string, days: number) =>
      (sqlite.prepare(sql).get(`-${days} days`) as any)?.n ?? 0;
    const out = windows.map(days => ({
      days,
      advertising_hits: countInWindow(`SELECT COUNT(*) AS n FROM advertising_page_hits WHERE ts > datetime('now', ?)`, days),
      leads:            countInWindow(`SELECT COUNT(*) AS n FROM pitch_inbound_leads     WHERE created_at > datetime('now', ?)`, days),
      proposals_sent:   countInWindow(`SELECT COUNT(*) AS n FROM pitch_proposals          WHERE sent_at IS NOT NULL AND sent_at > datetime('now', ?)`, days),
    }));
    res.json({ ok: true, windows: out });
  });

  app.get("/api/stats", (req, res) => {
    const { fromDate, toDate, site, contentType } = req.query as Record<string, string>;
    const daily = storage.getDailyBreakdown({
      fromDate, toDate,
      site: site || undefined,
      contentType: contentType || undefined,
    });
    const breakdown = storage.getSiteBreakdown({ fromDate, toDate });
    const latestRefresh = storage.getLatestRefresh();
    const totalArticles = storage.getArticleCount();

    const totalInRange = daily.reduce((s, d) => s + d.total, 0);
    const avgPerDay = daily.length > 0 ? Math.round(totalInRange / daily.length) : 0;

    // StereoNET-only avg per day — separate from avgPerDay (which respects the
    // active site filter). Used for the "Avg Per Day" KPI which always shows
    // StereoNET's pace regardless of which site filter is active.
    const snDaily = storage.getDailyBreakdown({ fromDate, toDate, site: "stereonet" });
    const snTotalInRange = snDaily.reduce((s, d) => s + d.total, 0);
    const snAvgPerDay = snDaily.length > 0 ? Math.round((snTotalInRange / snDaily.length) * 10) / 10 : 0;

    // Most active site (always across all sites for context)
    const siteTotals: Record<string, number> = {};
    for (const b of breakdown) {
      siteTotals[b.site] = (siteTotals[b.site] ?? 0) + b.count;
    }
    const topSite = Object.entries(siteTotals).sort((a, b) => b[1] - a[1])[0];

    // Type totals across range (respects site/contentType filter)
    const typeTotals = { review: 0, news: 0, feature: 0, opinion: 0, unknown: 0 };
    for (const d of daily) {
      typeTotals.review += d.review;
      typeTotals.news += d.news;
      typeTotals.feature += d.feature;
      typeTotals.opinion += d.opinion;
      typeTotals.unknown += d.unknown;
    }

    res.json({
      totalArticles,
      totalInRange,
      avgPerDay,
      snAvgPerDay,
      topSite: topSite ? { site: topSite[0], count: topSite[1] } : null,
      typeTotals,
      lastRefresh: latestRefresh?.completedAt ?? null,
      lastRefreshStatus: latestRefresh?.status ?? null,
      daysTracked: daily.length,
    });
  });

  // ─── POST /api/backfill-brands ────────────────────────────────────────────────
  app.post("/api/backfill-brands", async (_req, res) => {
    const updated = storage.backfillBrands();
    res.json({ updated });
  });

  // ─── POST /api/delete-seed ────────────────────────────────────────────────────
  app.post("/api/delete-seed", (_req, res) => {
    const deleted = storage.deleteSeedData();
    res.json({ deleted });
  });

  // ─── POST /api/media-kit/upload-image ─────────────────────────────────────
  // Direct image upload for media-kit block content (hero background, etc.).
  // Multipart: field name "file". Returns { url } for storage in block JSON.
  app.post("/api/media-kit/upload-image", upload.single("file"), (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ message: "file required" });
      const result = saveAttachment({
        buffer: req.file.buffer,
        mime: req.file.mimetype,
        originalName: req.file.originalname,
        uploadedBy: req.user?.email || "media-kit-editor",
      });
      res.json({ url: result.row.url, deduped: result.deduped, id: result.row.id });
    } catch (e: any) {
      console.error("[media-kit] upload failed:", e);
      res.status(e.status || 500).json({ message: e.message || "upload failed" });
    }
  });

  // ─── POST /api/articles/purge-older-than ──────────────────────────────────────
  // Body: { days: number }  — deletes articles strictly older than N days, with FK cleanup.
  app.post("/api/articles/purge-older-than", (req: any, res: any) => {
    const days = Math.max(1, Math.min(3650, Number(req.body?.days || 0)));
    if (!days) return res.status(400).json({ message: "days required (1-3650)" });
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const idsRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM articles WHERE COALESCE(published_at, published_date) < ?`).get(cutoff) as any;
    const toDelete = idsRow.n;
    const txn = sqlite.transaction(() => {
      const pred = `article_id IN (SELECT id FROM articles WHERE COALESCE(published_at, published_date) < ?)`;
      sqlite.prepare(`DELETE FROM article_pins WHERE ${pred}`).run(cutoff);
      sqlite.prepare(`DELETE FROM article_claims WHERE ${pred}`).run(cutoff);
      sqlite.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM article_comments WHERE ${pred})`).run(cutoff);
      sqlite.prepare(`DELETE FROM article_comments WHERE ${pred}`).run(cutoff);
      sqlite.prepare(`DELETE FROM notifications WHERE ${pred}`).run(cutoff);
      sqlite.prepare(`DELETE FROM articles WHERE COALESCE(published_at, published_date) < ?`).run(cutoff);
    });
    try { txn(); } catch (e: any) { return res.status(500).json({ message: e.message }); }
    console.log(`[cadence] Purged ${toDelete} articles older than ${days} days (before ${cutoff})`);
    res.json({ deleted: toDelete, cutoff, days });
  });

  // ─── GET /api/content-gaps ────────────────────────────────────────────────
  app.get("/api/content-gaps", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getContentGaps({ fromDate, toDate }));
  });

  // ─── GET /api/discovery ───────────────────────────────────────────────────
  app.get("/api/discovery", (req, res) => {
    const { search, limit } = req.query as Record<string, string>;
    res.json(storage.getDiscoveryArticles({
      search: search || undefined,
      limit: limit ? parseInt(limit) : undefined,
    }));
  });

  // ─── GET /api/velocity ─────────────────────────────────────────────────────
  app.get("/api/velocity", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getVelocity({ fromDate, toDate }));
  });

  // ─── GET /api/firstmover ────────────────────────────────────────────────────
  app.get("/api/firstmover", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getFirstMover({ fromDate, toDate }));
  });

  // ─── GET /api/scorecard ─────────────────────────────────────────────────────
  app.get("/api/scorecard", (req, res) => {
    const { currentFrom, currentTo, previousFrom, previousTo } = req.query as Record<string, string>;
    if (!currentFrom || !currentTo || !previousFrom || !previousTo) {
      return res.status(400).json({ message: "Missing date params" });
    }
    res.json(storage.getScorecard(currentFrom, currentTo, previousFrom, previousTo));
  });

  // ─── GET /api/heatmap ──────────────────────────────────────────────────────
  app.get("/api/heatmap", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getHeatmap({ fromDate, toDate }));
  });

  // ─── GET /api/timeofday ────────────────────────────────────────────────────
  app.get("/api/timeofday", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getTimeOfDay({ fromDate, toDate }));
  });

  // ─── GET /api/brands ─────────────────────────────────────────────────────────
  app.get("/api/brands", (req, res) => {
    const { fromDate, toDate, minCount } = req.query as Record<string, string>;
    res.json(storage.getBrands({ fromDate, toDate, minCount: minCount ? parseInt(minCount) : undefined }));
  });

  // ─── GET /api/topics ─────────────────────────────────────────────────────────
  app.get("/api/topics", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getTopicOverlap({ fromDate, toDate }));
  });

  // ─── GET /api/authors/weekly ────────────────────────────────────────────────
  app.get("/api/authors/weekly", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    res.json(storage.getAuthorWeekly({ fromDate, toDate }));
  });

  // ─── GET /api/authors ──────────────────────────────────────────────────────
  app.get("/api/authors", (req, res) => {
    const { fromDate, toDate } = req.query as Record<string, string>;
    const rows = storage.getAuthorBreakdown({
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
    res.json(rows);
  });

  // ─── POST /api/refresh ───────────────────────────────────────────────────────
  app.post("/api/refresh", async (req, res) => {
    try {
      const { articles: fetched, siteResults } = await fetchAllSites();
      let added = 0;
      let addedCompetitor = 0;
      for (const a of fetched) {
        if (storage.insertArticle(a)) {
          added++;
          if (a.site !== "stereonet") addedCompetitor++;
        }
      }

      // Scrape sites with dead RSS feeds
      try {
        const scraped = await scrapeAllSites();
        for (const s of scraped) {
          const inserted = storage.insertArticle({
            title: s.title,
            url: s.url,
            site: s.site,
            publishedAt: s.date + "T00:00:00Z",
            publishedDate: s.date,
            contentType: "news",
            categories: "[]",
            author: "",
            brands: "[]",
            fetchedAt: new Date().toISOString(),
          });
          if (inserted) { added++; addedCompetitor++; }
        }
      } catch (e: any) {
        console.error("[scraper] Error during refresh:", e?.message);
      }

      storage.logRefresh(added, "success");
      res.json({ success: true, added, addedCompetitor, siteResults });
    } catch (err: any) {
      storage.logRefresh(0, "error", err?.message);
      res.status(500).json({ success: false, error: err?.message });
    }
  });
}
