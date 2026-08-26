// Inbound Leads ─── Admin API for managing pitch_inbound_leads.
// Access piggy-backs on pitch_access (view+ to see, edit+ to update/send).

import type { Express, Request, Response, NextFunction } from "express";
import { sqlite, storage } from "./storage";
import { cfg } from "./config";

type Level = "view" | "edit" | "admin";
const LEVELS: Record<Level, number> = { view: 1, edit: 2, admin: 3 };

function pitchLevelFor(req: any): Level | null {
  if (!req.session?.authenticated) return null;
  const row = sqlite.prepare(
    `SELECT COALESCE(pitch_access, 'none') AS lvl, role FROM users WHERE username = ?`
  ).get(req.session.username) as any;
  if (!row) return null;
  if (row.role === "admin") return "admin";
  if (row.lvl === "none") return null;
  return row.lvl as Level;
}

function requireLevel(min: Level) {
  return (req: any, res: Response, next: NextFunction) => {
    const lvl = pitchLevelFor(req);
    if (!lvl || LEVELS[lvl] < LEVELS[min]) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    next();
  };
}

const ALLOWED_STATUS = new Set(["new", "contacted", "qualified", "won", "lost"]);
const ALLOWED_REGIONS = new Set(["anz", "uk_eu", "na", "asia", "global"]);

export function registerLeadsRoutes(app: Express) {
  // ─── List leads ─────────────────────────────────────────────────────────
  app.get("/api/leads", requireLevel("view"), (req, res) => {
    const status = String(req.query.status || "").trim();
    const search = String(req.query.search || "").trim();
    const companyType = String(req.query.company_type || "").trim();
    const region = String(req.query.region || "").trim();

    const where: string[] = [];
    const params: any[] = [];
    if (status && ALLOWED_STATUS.has(status)) {
      where.push("l.status = ?"); params.push(status);
    }
    if (companyType) {
      where.push("l.company_type = ?"); params.push(companyType);
    }
    if (region) {
      where.push("l.region = ?"); params.push(region);
    }
    if (search) {
      where.push("(LOWER(l.name) LIKE ? OR LOWER(l.company) LIKE ? OR LOWER(l.email) LIKE ?)");
      const s = `%${search.toLowerCase()}%`;
      params.push(s, s, s);
    }

    const sql = `
      SELECT
        l.id, l.source, l.name, l.company, l.company_type, l.role, l.country, l.region,
        l.email, l.message, l.interests_json, l.status, l.kit_share_id,
        l.assigned_to, l.created_at, l.updated_at,
        s.slug AS kit_slug, s.magic_token AS kit_token, s.view_count AS kit_views,
        s.last_viewed_at AS kit_last_viewed,
        k.label AS kit_label, k.region AS kit_region
      FROM pitch_inbound_leads l
      LEFT JOIN media_kit_shares s ON s.id = l.kit_share_id
      LEFT JOIN media_kits k ON k.id = s.kit_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY l.created_at DESC
      LIMIT 500
    `;
    const rows = sqlite.prepare(sql).all(...params) as any[];

    // Counts by status (for sidebar badges)
    const counts = sqlite.prepare(
      `SELECT status, COUNT(*) AS cnt FROM pitch_inbound_leads GROUP BY status`
    ).all() as any[];

    res.json({
      leads: rows.map(r => ({
        ...r,
        interests: r.interests_json ? safeJsonParse(r.interests_json) : [],
        magic_link: r.kit_slug && r.kit_token
          ? `https://dashboard.stereonet.com/kit/${r.kit_slug}?t=${r.kit_token}`
          : null,
      })),
      counts: counts.reduce((acc: any, r: any) => ({ ...acc, [r.status]: r.cnt }), {}),
    });
  });

  // ─── Single lead detail ─────────────────────────────────────────────────
  app.get("/api/leads/:id", requireLevel("view"), (req, res) => {
    const id = Number(req.params.id);
    const row = sqlite.prepare(`
      SELECT
        l.*,
        s.slug AS kit_slug, s.magic_token AS kit_token, s.view_count AS kit_views,
        s.last_viewed_at AS kit_last_viewed, s.expires_at AS kit_expires,
        k.label AS kit_label, k.region AS kit_region
      FROM pitch_inbound_leads l
      LEFT JOIN media_kit_shares s ON s.id = l.kit_share_id
      LEFT JOIN media_kits k ON k.id = s.kit_id
      WHERE l.id = ?
    `).get(id) as any;
    if (!row) return res.status(404).json({ message: "Lead not found" });

    res.json({
      ...row,
      interests: row.interests_json ? safeJsonParse(row.interests_json) : [],
      magic_link: row.kit_slug && row.kit_token
        ? `https://dashboard.stereonet.com/kit/${row.kit_slug}?t=${row.kit_token}`
        : null,
    });
  });

  // ─── Update lead (status, notes, assignment) ────────────────────────────
  app.patch("/api/leads/:id", requireLevel("edit"), (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const editable = ["status", "notes", "assigned_to"];
    const sets: string[] = [];
    const params: any[] = [];

    if ("status" in body) {
      const status = String(body.status || "").trim();
      if (!ALLOWED_STATUS.has(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      sets.push("status = ?"); params.push(status);
    }
    if ("notes" in body) {
      sets.push("notes = ?"); params.push(String(body.notes || "") || null);
    }
    if ("assigned_to" in body) {
      const v = body.assigned_to == null ? null : Number(body.assigned_to);
      sets.push("assigned_to = ?"); params.push(v);
    }
    if ("region" in body) {
      const r = String(body.region || "").trim().toLowerCase();
      if (r && !ALLOWED_REGIONS.has(r)) return res.status(400).json({ message: "Invalid region" });
      sets.push("region = ?"); params.push(r || null);
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    sets.push("updated_at = datetime('now')");
    params.push(id);

    const r = sqlite.prepare(`UPDATE pitch_inbound_leads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (r.changes === 0) return res.status(404).json({ message: "Lead not found" });

    const updated = sqlite.prepare(`SELECT * FROM pitch_inbound_leads WHERE id = ?`).get(id);
    res.json(updated);
  });

  // ─── Manually send the Media Kit to the prospect ────────────────────────
  // Fires the "Your Media Kit is ready" email (with magic link) on demand.
  app.post("/api/leads/:id/send-kit", requireLevel("edit"), async (req, res) => {
    const id = Number(req.params.id);
    const row = sqlite.prepare(`
      SELECT
        l.id, l.name, l.email, l.company,
        s.slug AS kit_slug, s.magic_token AS kit_token,
        k.label AS kit_label
      FROM pitch_inbound_leads l
      LEFT JOIN media_kit_shares s ON s.id = l.kit_share_id
      LEFT JOIN media_kits k ON k.id = s.kit_id
      WHERE l.id = ?
    `).get(id) as any;
    if (!row) return res.status(404).json({ message: "Lead not found" });
    if (!row.email) return res.status(400).json({ message: "Lead has no email address" });
    if (!row.kit_slug || !row.kit_token) {
      return res.status(400).json({ message: "Lead has no associated Media Kit share" });
    }

    const magicLink = `https://dashboard.stereonet.com/kit/${row.kit_slug}?t=${row.kit_token}`;
    try {
      const { sendEmail, buildKitDeliveryEmail } = await import("./email");
      const tpl = buildKitDeliveryEmail({
        name: row.name || "there",
        company: row.company || "",
        magicLink,
        kitLabel: row.kit_label || "StereoNET Media Kit",
      });
      // Send From the user who clicked Send Kit (display name) and CC them so
      // they have a copy of what the prospect received. marcrushton@ is BCC'd
      // automatically by sendEmail.
      const sender = storage.getUserSenderInfo(req.session?.username || "");
      const result = await sendEmail({
        to: row.email,
        toName: row.name,
        subject: tpl.subject,
        html: tpl.html,
        fromName: sender.name || undefined,
        replyTo: sender.email || undefined,
        cc: sender.email || undefined,
      });
      if (!result.ok) {
        return res.status(500).json({ message: `Email failed: ${result.error || "unknown"}` });
      }
      // Bump status to 'contacted' if still 'new'
      sqlite.prepare(`
        UPDATE pitch_inbound_leads
        SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(id);
      // Flip the share's proposal_state from draft to sent, log the event.
      // Resolve share_id from the row's kit_slug.
      const shareRow = sqlite.prepare(`SELECT id, proposal_state FROM media_kit_shares WHERE slug = ?`).get(row.kit_slug) as any;
      if (shareRow) {
        sqlite.prepare(`UPDATE media_kit_shares SET proposal_state = 'sent', sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?`).run(shareRow.id);
        sqlite.prepare(`INSERT INTO proposal_events (share_id, event_type, actor_name, message) VALUES (?, 'sent', ?, ?)`)
          .run(shareRow.id, req.session?.username || "system", `Kit sent to ${row.email}`);
        // FREEZE the kit so future Global edits don't change what the prospect
        // has already been emailed. Idempotent — only inherited blocks get
        // snapshotted; already-overridden blocks pass through unchanged.
        try {
          const share = sqlite.prepare(`SELECT kit_id FROM media_kit_shares WHERE id = ?`).get(shareRow.id) as any;
          if (share?.kit_id) {
            const { freezeInheritedBlocksForKit } = require("./pitch");
            freezeInheritedBlocksForKit(share.kit_id);
          }
        } catch (e) { console.warn("[leads send-kit] freeze failed:", e); }
      }
      res.json({ ok: true, magic_link: magicLink, sent_to: row.email });
    } catch (e: any) {
      console.error("[leads] send-kit failed:", e);
      res.status(500).json({ message: e?.message || "Send failed" });
    }
  });

  // ─── Customise (clone) the kit for this prospect ──────────────────────
  // Creates a fresh kit row owned by this lead, copies all effective blocks from
  // the parent regional kit so they're editable, mints a new share token, and
  // updates the lead to point at the new clone. Idempotent: if a clone already
  // exists for this lead, returns it.
  // Admin-only — cloning a kit for a prospect is a customisation operation.
  app.post("/api/leads/:id/customise-kit", requireLevel("admin"), (req, res) => {
    const id = Number(req.params.id);
    const lead = sqlite.prepare(`SELECT * FROM pitch_inbound_leads WHERE id = ?`).get(id) as any;
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    // 1. If a clone already exists for this lead, return it (don't double-clone)
    //    UNLESS the caller is explicitly asking to switch audience (Trade <-> Retailer)
    //    or passed force_rebuild=1 — in which case we delete the old clone and rebuild.
    const requestedAudienceForExisting = String((req.body && req.body.audience) || (req.query && req.query.audience) || "").trim().toLowerCase();
    const forceRebuild = String((req.body && req.body.force_rebuild) || (req.query && req.query.force_rebuild) || "").trim() === "1";
    const existingClone = sqlite.prepare(`SELECT * FROM media_kits WHERE prospect_lead_id = ? LIMIT 1`).get(id) as any;
    if (existingClone) {
      const audienceMismatch = (requestedAudienceForExisting === "retailer" || requestedAudienceForExisting === "trade") && requestedAudienceForExisting !== String(existingClone.kind || "").toLowerCase();
      if (!audienceMismatch && !forceRebuild) {
        const existingShare = sqlite.prepare(`SELECT slug, magic_token FROM media_kit_shares WHERE kit_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(existingClone.id) as any;
        return res.json({
          kit_id: existingClone.id,
          slug: existingClone.slug,
          share_slug: existingShare?.slug,
          magic_token: existingShare?.magic_token,
          was_existing: true,
        });
      }
      // Audience switch (or forced rebuild): delete the old clone, its blocks, and revoke its shares.
      try {
        sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ?`).run(existingClone.id);
        sqlite.prepare(`UPDATE media_kit_shares SET status = 'revoked' WHERE kit_id = ?`).run(existingClone.id);
        sqlite.prepare(`DELETE FROM media_kits WHERE id = ?`).run(existingClone.id);
      } catch (e) {
        console.error("[leads] failed to rebuild clone:", e);
        return res.status(500).json({ message: "Failed to rebuild existing clone" });
      }
    }

    // 2. Find the source kit — prefer the regional kit the lead was originally routed to.
    // If the lead already has a share, use that share's kit as the parent. Otherwise
    // resolve from region. Fall back to canonical Trade.
    let parentKitId: number | null = null;
    // Read the audience override up-front so it takes precedence over any
    // auto-assigned share kit (which was created at inbound time before the
    // admin had a chance to pick Trade vs Retailer).
    const requestedAudienceEarly = String((req.body && req.body.audience) || (req.query && req.query.audience) || "").trim().toLowerCase();
    if (requestedAudienceEarly !== "retailer" && requestedAudienceEarly !== "trade") {
      if (lead.kit_share_id) {
        const parentShare = sqlite.prepare(`SELECT kit_id FROM media_kit_shares WHERE id = ?`).get(lead.kit_share_id) as any;
        if (parentShare) parentKitId = parentShare.kit_id;
      }
    }
    // Allow caller to override the source audience (body.audience: 'trade' | 'retailer')
    // and the source region (body.region or ?region=).
    // Audience=retailer sources from the global retailer master kit (no region filter).
    // Audience=trade (default) falls back to the lead's stored region, then canonical Trade.
    const requestedAudience = String((req.body && req.body.audience) || (req.query && req.query.audience) || "").trim().toLowerCase();
    const audience = requestedAudience === "retailer" ? "retailer" : "trade";
    const requestedRegion = String((req.body && req.body.region) || (req.query && req.query.region) || "").trim().toLowerCase();
    const sourceRegion = ALLOWED_REGIONS.has(requestedRegion) ? requestedRegion : null;

    if (audience === "retailer") {
      // Retailer kit is global (one master). Ignore region picker.
      const retailerMaster = sqlite.prepare(`SELECT id FROM media_kits WHERE kind = 'retailer' AND prospect_lead_id IS NULL ORDER BY is_canonical DESC, id ASC LIMIT 1`).get() as any;
      if (retailerMaster) parentKitId = retailerMaster.id;
    } else {
      // Trade flow (unchanged behaviour)
      if (sourceRegion) {
        const overrideKit = sqlite.prepare(`SELECT id FROM media_kits WHERE region = ? AND kind = 'trade' AND prospect_lead_id IS NULL LIMIT 1`).get(sourceRegion) as any;
        if (overrideKit) parentKitId = overrideKit.id;
      }
      if (!parentKitId && lead.region) {
        const regionalKit = sqlite.prepare(`SELECT id FROM media_kits WHERE region = ? AND kind = 'trade' AND prospect_lead_id IS NULL LIMIT 1`).get(lead.region) as any;
        if (regionalKit) parentKitId = regionalKit.id;
      }
      if (!parentKitId) {
        const canon = sqlite.prepare(`SELECT id FROM media_kits WHERE kind = 'trade' AND is_canonical = 1 LIMIT 1`).get() as any;
        if (canon) parentKitId = canon.id;
      }
    }
    if (!parentKitId) {
      return res.status(500).json({ message: "Could not find a source kit to clone" });
    }

    const parent = sqlite.prepare(`SELECT * FROM media_kits WHERE id = ?`).get(parentKitId) as any;
    if (!parent) return res.status(500).json({ message: "Parent kit missing" });

    // 3. Create the clone
    const safeCompany = String(lead.company || lead.name || "prospect").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "prospect";
    const slug = `prospect-${id}-${safeCompany}-${Math.random().toString(36).slice(2, 7)}`;
    const label = `${parent.label} — ${lead.company || lead.name || `Lead #${id}`}`;

    const cloneInsert = sqlite.prepare(`
      INSERT INTO media_kits (slug, kind, region, is_canonical, parent_kit_id, label, subtitle, version_quarter, status, base_currency, tax_suffix, intro_text, prospect_lead_id)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      slug, parent.kind, parent.region, parent.id,
      label, parent.subtitle, parent.version_quarter,
      parent.base_currency, parent.tax_suffix, parent.intro_text,
      id
    );
    const cloneId = Number(cloneInsert.lastInsertRowid);

    // 4. Only materialise the 'proposal' block on the clone. All other blocks remain inherited
    //    live from the parent (and the parent's parent), so master edits flow through automatically.
    //    The admin can still override any individual block on the clone via the editor;
    //    those overrides get edited_at set so the Sync-from-master action preserves them.
    const proposalContent = {
      prepared_for: lead.company || lead.name || "",
      subtitle: "",
      total_value: null,
      total_currency: parent.base_currency || "USD",
      total_period: "",
      summary_line: "",
      valid_until: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
      notes: "",
    };
    try {
      sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json, edited_at) VALUES (?, 'proposal', 0, 1, 1, ?, datetime('now'))`).run(cloneId, JSON.stringify(proposalContent));
    } catch (e) {
      console.error("[leads] failed to insert proposal block:", e);
    }

    // 5. Mint a new share pointing at the clone
    const shareSlug = `${safeCompany}-${Math.random().toString(36).slice(2, 8)}`;
    const token = require("node:crypto").randomBytes(24).toString("base64url").slice(0, 24);
    const expiry = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();
    const shareInsert = sqlite.prepare(`
      INSERT INTO media_kit_shares (kit_id, slug, magic_token, prospect_name, prospect_email, prospect_company, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cloneId, shareSlug, token, lead.name, lead.email, lead.company, expiry);
    const newShareId = Number(shareInsert.lastInsertRowid);

    // 6. Repoint the lead at the new share. Revoke the old auto-created share so it 404s.
    if (lead.kit_share_id) {
      sqlite.prepare(`UPDATE media_kit_shares SET status = 'revoked' WHERE id = ?`).run(lead.kit_share_id);
    }
    sqlite.prepare(`UPDATE pitch_inbound_leads SET kit_share_id = ?, updated_at = datetime('now') WHERE id = ?`).run(newShareId, id);

    res.json({
      kit_id: cloneId,
      slug,
      share_slug: shareSlug,
      magic_token: token,
      magic_link: `https://dashboard.stereonet.com/kit/${shareSlug}?t=${token}`,
      was_existing: false,
    });
  });

  // ─── Diagnostic: test the lead-notification fan-out (admin or deploy token) ──
  app.post("/api/admin/diag/test-lead-notify", async (req: any, res) => {
    const token = req.headers["x-deploy-token"] || req.query.token;
    if (token !== cfg("DEPLOY_TOKEN", "sn-d3pl0y-x7Km9Rp4Wq2Yf8Bv") && req.session?.role !== "admin") {
      return res.status(403).json({ message: "Admin or deploy token required" });
    }
    const region = String(req.query.region || req.body?.region || "anz").toLowerCase();
    const users = sqlite.prepare(`SELECT id, username, email, notify_regions FROM users WHERE email IS NOT NULL AND email != '' AND notify_regions IS NOT NULL AND notify_regions != ''`).all() as any[];
    const recipients = new Set<string>();
    const matched: any[] = [];
    for (const u of users) {
      const csv = String(u.notify_regions || "").toLowerCase();
      const match = csv === "all" || csv.split(",").map((s: string) => s.trim()).includes(region);
      if (match) { recipients.add(String(u.email).trim()); matched.push({ username: u.username, email: u.email, notify_regions: u.notify_regions }); }
    }
    recipients.add("marcrushton@stereonet.com");
    const apiKey = storage.getSetting("sendgrid_api_key") || null;
    const apiKeyPresent = !!apiKey;
    const fromEmail = storage.getSetting("sendgrid_from_email") || "admin@stereonet.com";

    let sendResult: any = null;
    if (req.query.send === "1" || req.body?.send === true) {
      try {
        const { sendEmail } = await import("./email");
        const subject = `[PULSE diag] Lead notification fan-out test (region=${region})`;
        const html = `<p>This is a test of the lead-notification fan-out for region <strong>${region}</strong>.</p><p>Recipients computed: ${Array.from(recipients).join(", ")}</p><p>If you received this, SendGrid is delivering correctly.</p>`;
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

    res.json({
      region,
      apiKeyPresent,
      fromEmail,
      matched_users: matched,
      recipients: Array.from(recipients),
      sendResult,
    });
  });

  // ─── Re-parent a prospect clone to a different regional master ─────────────
  // Preserves the personalised 'proposal' block. Drops every other override so the
  // clone re-inherits live from the newly-chosen region.
  // Admin-only — switching the source region of a prospect's kit is a customisation operation.
  app.post("/api/leads/:id/switch-kit-region", requireLevel("admin"), (req, res) => {
    const id = Number(req.params.id);
    const targetRegion = String(req.body?.region || "").trim().toLowerCase();
    if (!ALLOWED_REGIONS.has(targetRegion)) return res.status(400).json({ message: "Invalid region" });
    const lead = sqlite.prepare(`SELECT id, kit_share_id FROM pitch_inbound_leads WHERE id = ?`).get(id) as any;
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const clone = sqlite.prepare(`SELECT id, region, parent_kit_id FROM media_kits WHERE prospect_lead_id = ? LIMIT 1`).get(id) as any;
    if (!clone) return res.status(400).json({ message: "No prospect clone exists yet — click Customise Media Kit first." });
    const newMaster = sqlite.prepare(`SELECT id, base_currency, tax_suffix, kind FROM media_kits WHERE region = ? AND kind = 'trade' AND prospect_lead_id IS NULL LIMIT 1`).get(targetRegion) as any;
    if (!newMaster) return res.status(400).json({ message: `No regional master found for ${targetRegion}` });

    // 1. Drop every override on the clone EXCEPT 'proposal' (preserves the personalised header).
    const dropped = sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ? AND block_key != 'proposal'`).run(clone.id);
    // 2. Re-parent. Also align currency / tax_suffix to the new master (sensible default; admin can edit later).
    sqlite.prepare(`UPDATE media_kits SET region = ?, parent_kit_id = ?, base_currency = ?, tax_suffix = ?, updated_at = datetime('now') WHERE id = ?`).run(targetRegion, newMaster.id, newMaster.base_currency, newMaster.tax_suffix, clone.id);
    // 3. Clear per-kit addon order override — the new region may have a different addon set / order.
    sqlite.prepare(`UPDATE media_kits SET addon_order_override_json = NULL WHERE id = ?`).run(clone.id);

    res.json({ ok: true, clone_id: clone.id, new_parent_kit_id: newMaster.id, region: targetRegion, blocks_reverted: dropped.changes });
  });

  // ─── Sync a prospect clone back to its master kit ─────────────────────
  // Drops all overrides on the clone EXCEPT:
  //   - the 'proposal' block (always preserved — it's the personalised header)
  //   - blocks the admin has actively edited (edited_at IS NOT NULL)
  // After this, the clone re-inherits live from the parent regional kit.
  // Admin-only — re-syncing the clone from the master overrides any edits.
  app.post("/api/leads/:id/sync-kit-from-master", requireLevel("admin"), (req, res) => {
    const id = Number(req.params.id);
    const lead = sqlite.prepare(`SELECT * FROM pitch_inbound_leads WHERE id = ?`).get(id) as any;
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const clone = sqlite.prepare(`SELECT id FROM media_kits WHERE prospect_lead_id = ? LIMIT 1`).get(id) as any;
    if (!clone) return res.status(404).json({ message: "No prospect clone for this lead" });

    const force = req.body?.force === true || req.query?.force === "1";

    // Find override rows we want to drop
    const overrides = sqlite.prepare(`SELECT block_key, edited_at FROM media_kit_blocks WHERE kit_id = ?`).all(clone.id) as any[];
    const preserved: string[] = [];
    const dropped: string[] = [];
    const dropStmt = sqlite.prepare(`DELETE FROM media_kit_blocks WHERE kit_id = ? AND block_key = ?`);
    for (const o of overrides) {
      if (o.block_key === "proposal") { preserved.push(o.block_key); continue; }
      // If the admin edited this block (edited_at set), preserve unless force.
      // Note: legacy clones from the old customise-kit step have edited_at NULL
      // because they were INSERTed before the edited_at column existed — those are safe to drop.
      if (o.edited_at && !force) { preserved.push(o.block_key); continue; }
      dropStmt.run(clone.id, o.block_key);
      dropped.push(o.block_key);
    }
    res.json({ ok: true, clone_id: clone.id, dropped, preserved });
  });

  // ─── Activity timeline (proposal events) for a lead ─────────────────────
  app.get("/api/leads/:id/events", requireLevel("view"), (req, res) => {
    const id = Number(req.params.id);
    const lead = sqlite.prepare(`SELECT kit_share_id FROM pitch_inbound_leads WHERE id = ?`).get(id) as any;
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (!lead.kit_share_id) return res.json({ events: [] });
    const rows = sqlite.prepare(`SELECT id, event_type, actor_name, actor_email, ip, message, created_at FROM proposal_events WHERE share_id = ? ORDER BY created_at DESC, id DESC`).all(lead.kit_share_id) as any[];
    res.json({ events: rows });
  });

  // ─── Backfill: add 'proposal' block to existing prospect clones missing one ─
  // Idempotent. Called automatically when listing leads.
  function backfillProposalBlocks() {
    const prospectKits = sqlite.prepare(`SELECT k.id, k.base_currency, l.company, l.name FROM media_kits k JOIN pitch_inbound_leads l ON l.id = k.prospect_lead_id`).all() as any[];
    const insertBlock = sqlite.prepare(`INSERT INTO media_kit_blocks (kit_id, block_key, position, is_override, is_visible, content_json) VALUES (?, 'proposal', 0, 0, 1, ?)`);
    let added = 0;
    for (const k of prospectKits) {
      const exists = sqlite.prepare(`SELECT 1 FROM media_kit_blocks WHERE kit_id = ? AND block_key = 'proposal'`).get(k.id);
      if (exists) continue;
      const content = {
        prepared_for: k.company || k.name || "",
        subtitle: "",
        total_value: null,
        total_currency: k.base_currency || "USD",
        total_period: "",
        summary_line: "",
        valid_until: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
        notes: "",
      };
      try {
        insertBlock.run(k.id, JSON.stringify(content));
        added++;
      } catch (e) {
        console.error(`[leads] backfill proposal block failed for kit ${k.id}:`, e);
      }
    }
    if (added > 0) console.log(`[leads] Backfilled 'proposal' block on ${added} existing prospect clones`);
  }
  // Run once on first request (cheap, idempotent)
  let backfilled = false;
  app.use("/api/leads", (_req, _res, next) => {
    if (!backfilled) { try { backfillProposalBlocks(); } catch {} backfilled = true; }
    next();
  });

  // ─── Delete a lead (admin only) ─────────────────────────────────────────
  app.delete("/api/leads/:id", requireLevel("admin"), (req, res) => {
    const id = Number(req.params.id);
    const r = sqlite.prepare(`DELETE FROM pitch_inbound_leads WHERE id = ?`).run(id);
    if (r.changes === 0) return res.status(404).json({ message: "Lead not found" });
    res.json({ ok: true });
  });
}

function safeJsonParse(s: string | null): any[] {
  if (!s) return [];
  try { return JSON.parse(s); } catch { return []; }
}
