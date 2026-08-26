// ─── SendGrid transactional email helper ────────────────────────────────────
// Uses SendGrid Web API v3 directly. API key + sender are stored in app_settings
// so they can be rotated/updated without redeploying.
//
// To configure:
//   - Set app_settings 'sendgrid_api_key' to the SendGrid API key
//   - Set app_settings 'sendgrid_from_email' (default: admin@stereonet.com)
//   - Set app_settings 'sendgrid_from_name'  (default: StereoNET)
//   - Set app_settings 'sendgrid_notify_to'  (default: marcrushton@stereonet.com)

import { storage } from "./storage";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

interface SendArgs {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  cc?: string | string[]; // optional CC recipients (single or array)
  bcc?: string | string[]; // optional BCC recipients (single or array)
  fromName?: string; // override the From display name (e.g. the human sender's name)
  // When true, BCC marcrushton@stereonet.com (or sendgrid_notify_to) on this send.
  // Defaults to true. Set false for notify-fan-out sends that already include him.
  bccCatchAll?: boolean;
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean; error?: string }> {
  const apiKey = storage.getSetting("sendgrid_api_key");
  if (!apiKey) {
    console.log("[email] No sendgrid_api_key configured — skipping send to", args.to);
    return { ok: false, error: "no_api_key" };
  }
  const fromEmail = storage.getSetting("sendgrid_from_email") || "admin@stereonet.com";
  const defaultFromName = storage.getSetting("sendgrid_from_name") || "StereoNET";
  const catchAll = (storage.getSetting("sendgrid_notify_to") || "marcrushton@stereonet.com").trim();
  // From-name policy: always use the brand name ("StereoNET" by default).
  // The individual sender still appears via Reply-To + CC so replies route
  // back to them. Previously we used "<sender> (StereoNET)" but it read
  // too personal and not enough brand.
  const fromName = defaultFromName;
  const replyTo = args.replyTo || catchAll;

  const toLower = args.to.trim().toLowerCase();
  const dedupe = (list: (string | undefined | null)[]) => Array.from(new Set(
    list
      .map(e => String(e || "").trim())
      .filter(e => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.toLowerCase() !== toLower)
  ));

  const ccRaw = Array.isArray(args.cc) ? args.cc : (args.cc ? [args.cc] : []);
  const ccList = dedupe(ccRaw);

  const bccRaw = Array.isArray(args.bcc) ? args.bcc : (args.bcc ? [args.bcc] : []);
  // Default behaviour: every outbound mail is BCC'd to the catch-all address
  // (marcrushton@) so there's a single audit trail. Opt-out via bccCatchAll:false.
  const wantsCatchAll = args.bccCatchAll !== false;
  if (wantsCatchAll) bccRaw.push(catchAll);
  // Also strip anything already in CC to avoid dup deliveries.
  const ccLowers = new Set(ccList.map(e => e.toLowerCase()));
  const bccList = dedupe(bccRaw).filter(e => !ccLowers.has(e.toLowerCase()));

  const personalization: any = { to: [{ email: args.to, name: args.toName }] };
  if (ccList.length) personalization.cc = ccList.map(email => ({ email }));
  if (bccList.length) personalization.bcc = bccList.map(email => ({ email }));

  const body = {
    personalizations: [personalization],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: replyTo },
    subject: args.subject,
    content: [
      { type: "text/plain", value: args.text || stripHtml(args.html) },
      { type: "text/html", value: args.html },
    ],
  };

  try {
    const resp = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (resp.ok || resp.status === 202) {
      console.log(`[email] Sent to ${args.to}: ${args.subject}`);
      return { ok: true };
    }
    const errText = await resp.text();
    console.error(`[email] SendGrid error ${resp.status}: ${errText}`);
    return { ok: false, error: `SendGrid ${resp.status}` };
  } catch (e: any) {
    console.error("[email] send failed:", e?.message || e);
    return { ok: false, error: e?.message || "send_failed" };
  }
}

function stripHtml(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Templates ──────────────────────────────────────────────────────────────
// StereoNET newsletter brand — dark theme, red accent, real logo image.
// Outer page #1A1A1A, card #222222, accent #E31E24, body text #CCCCCC, headings #FFFFFF.
const LOGO_URL = "https://www.stereonet.com/assets/images/2025-StereoNET-Logo.png";
const baseStyles = `
  body { margin: 0; padding: 0; background: #1A1A1A; font-family: Arial, Helvetica, sans-serif; color: #CCCCCC; -webkit-font-smoothing: antialiased; }
  table { border-collapse: collapse; }
  img { border: 0; outline: none; text-decoration: none; display: block; }
  a { color: #E31E24; }
  .wrap { width: 100%; background: #1A1A1A; padding: 24px 0; }
  .card { max-width: 600px; margin: 0 auto; background: #222222; }
  .card-inner { padding: 32px; }
  .header { padding: 24px 32px; border-bottom: 1px solid #2E2E2E; }
  .logo-img { height: 40px; width: auto; display: block; }
  .pill { display: inline-block; background: #E31E24; color: #FFFFFF; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 10px; border-radius: 2px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; line-height: 1.25; color: #FFFFFF; font-family: Arial, Helvetica, sans-serif; }
  h2 { font-size: 18px; font-weight: 700; margin: 24px 0 8px; color: #FFFFFF; font-family: Arial, Helvetica, sans-serif; }
  p { font-size: 15px; line-height: 1.6; margin: 12px 0; color: #CCCCCC; font-family: Arial, Helvetica, sans-serif; }
  strong { color: #FFFFFF; }
  .btn { display: inline-block; background: #E31E24; color: #FFFFFF !important; text-decoration: none; font-weight: 700; padding: 14px 28px; border-radius: 2px; margin: 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; }
  .btn:hover { background: #c41a1f; }
  .meta { font-size: 13px; color: #999999; font-family: Arial, Helvetica, sans-serif; }
  .meta strong { color: #FFFFFF; }
  table.meta-table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
  table.meta-table td { padding: 10px 12px; border-bottom: 1px solid #2E2E2E; color: #CCCCCC; font-family: Arial, Helvetica, sans-serif; vertical-align: top; }
  table.meta-table td.k { color: #999999; width: 40%; }
  blockquote { border-left: 3px solid #E31E24; padding: 4px 0 4px 16px; margin: 16px 0; color: #BBBBBB; font-family: Arial, Helvetica, sans-serif; font-style: italic; }
  .footer { background: #1A1A1A; padding: 24px 32px; text-align: center; font-family: Arial, Helvetica, sans-serif; }
  .footer .logo-img { margin: 0 auto 12px; height: 28px; }
  .footer p { font-size: 12px; color: #AAAAAA; margin: 4px 0; line-height: 1.5; }
  .footer a { color: #AAAAAA; text-decoration: none; }
  @media only screen and (max-width: 620px) {
    .card-inner { padding: 24px 20px !important; }
    .header { padding: 18px 20px !important; }
    h1 { font-size: 20px !important; }
  }
`;

export function buildProspectKitEmail(args: {
  name: string;
  company: string;
}): { subject: string; html: string } {
  const firstName = args.name.split(/\s+/)[0] || args.name;
  const subject = `We've received your StereoNET advertising enquiry`;
  const body = `<h1>Thanks, ${escapeHtml(firstName)}.</h1>
<p>We've received your advertising enquiry from <strong>${escapeHtml(args.company)}</strong>.</p>
<p>Our team will review your request and get in touch within one business day with a Media Kit tailored to your brand and the opportunities you've expressed interest in.</p>
<p>If anything is urgent in the meantime, simply reply to this email — it goes straight to our team.</p>
<p class="meta">Speak soon,<br><strong>The StereoNET Team</strong></p>`;
  return { subject, html: wrapInShell(body) };
}

export function buildAdminNotifyEmail(args: {
  name: string;
  company: string;
  email: string;
  companyType?: string | null;
  role?: string | null;
  country?: string | null;
  region: string;
  message?: string | null;
  interests: string[];
  magicLink: string;
  leadId: number;
  kitLabel: string;
}): { subject: string; html: string } {
  const subject = `New media kit request: ${args.company} (${args.region.toUpperCase()})`;
  const interestLabels: Record<string, string> = {
    news: "News & PR coverage",
    reviews: "Editorial reviews",
    banners: "Display banners",
    forum: "Forum sponsorship",
    newsletter: "Newsletter & EDM",
    social: "Social campaigns",
    classifieds: "Classifieds",
    brand: "Brand or distributor package",
    ai: "AI discoverability",
    other: "Other",
  };
  const interestList = args.interests.length
    ? `<ul>${args.interests.map(i => `<li>${escapeHtml(interestLabels[i] || i)}</li>`).join("")}</ul>`
    : "<em>None specified</em>";
  const dashboardLink = `https://dashboard.stereonet.com/pitch?tab=leads`;

  const body = `<div style="margin:0 0 16px"><span class="pill">PULSE Inbound Lead</span></div>
<h1>New Media Kit request from ${escapeHtml(args.company)}</h1>
<p>${escapeHtml(args.name)} at ${escapeHtml(args.company)} just requested a Media Kit through the advertising page.</p>
<table class="meta-table">
  <tr><td class="k">Name</td><td>${escapeHtml(args.name)}</td></tr>
  <tr><td class="k">Company</td><td>${escapeHtml(args.company)}</td></tr>
  ${args.companyType ? `<tr><td class="k">Type</td><td>${escapeHtml(args.companyType.charAt(0).toUpperCase() + args.companyType.slice(1))}</td></tr>` : ""}
  ${args.role ? `<tr><td class="k">Role</td><td>${escapeHtml(args.role)}</td></tr>` : ""}
  <tr><td class="k">Email</td><td><a href="mailto:${escapeHtml(args.email)}">${escapeHtml(args.email)}</a></td></tr>
  ${args.country ? `<tr><td class="k">Country</td><td>${escapeHtml(args.country)}</td></tr>` : ""}
  <tr><td class="k">Region routed to</td><td>${escapeHtml(args.region.toUpperCase())} &middot; ${escapeHtml(args.kitLabel)}</td></tr>
  <tr><td class="k">Interested in</td><td>${interestList}</td></tr>
  ${args.message ? `<tr><td class="k">Message</td><td>${escapeHtml(args.message).replace(/\n/g, "<br>")}</td></tr>` : ""}
</table>
<p><a href="${args.magicLink}" class="btn">View Their Kit &rarr;</a></p>
<p class="meta">Lead #${args.leadId} &middot; <a href="${dashboardLink}">Manage in PULSE</a></p>`;
  return { subject, html: wrapInShell(body) };
}

// ─── Kit delivery (sent manually from PULSE Leads page) ─────────────────────
export function buildKitDeliveryEmail(args: {
  name: string;
  company: string;
  magicLink: string;
  kitLabel: string;
}): { subject: string; html: string } {
  return renderTemplate(EMAIL_TEMPLATES.prospect_kit_delivery, {
    name: args.name,
    first_name: args.name.split(/\s+/)[0] || args.name,
    company: args.company,
    kit_label: args.kitLabel,
    magic_link: args.magicLink,
  });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ─── Editable email templates ─────────────────────────────────────────
// Admins can override the subject + HTML body of any template from PITCH Settings → Email Templates.
// Tokens like {{name}} are replaced with the values passed in. Token values are HTML-escaped
// unless the token is registered as 'raw' (e.g. {{interests_html}} for pre-rendered fragments).
//
// Override storage: app_settings keys 'email_tpl.<key>.subject' and 'email_tpl.<key>.html'.
// If either is missing/empty, the hardcoded default for that field is used.

export interface TemplateDef {
  key: string;
  label: string;
  description: string;
  // Tokens listed in the editor UI as click-to-insert chips.
  tokens: { token: string; description: string }[];
  // Defaults used when no override exists.
  default_subject: string;
  default_html: string;
}

const RAW_TOKEN_SUFFIX = "_html"; // tokens ending with _html are inserted unescaped

export function renderTemplate(def: TemplateDef, vars: Record<string, any>): { subject: string; html: string } {
  const { storage } = require("./storage");
  const subjectOverride = String(storage.getSetting(`email_tpl.${def.key}.subject`) || "").trim();
  const htmlOverride = String(storage.getSetting(`email_tpl.${def.key}.html`) || "").trim();
  const subject = applyTokens(subjectOverride || def.default_subject, vars, /*allowRaw*/ false);
  const bodyTemplate = htmlOverride || def.default_html;
  // If the body override is missing the <html>/<style> wrapper, wrap it in our standard shell.
  const looksLikeFullDoc = /<html|<!doctype/i.test(bodyTemplate);
  const body = applyTokens(bodyTemplate, vars, /*allowRaw*/ true);
  const html = looksLikeFullDoc ? body : wrapInShell(body);
  return { subject, html };
}

function applyTokens(tpl: string, vars: Record<string, any>, allowRaw: boolean): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name) => {
    const v = vars[name];
    if (v == null) return "";
    if (allowRaw && name.endsWith(RAW_TOKEN_SUFFIX)) return String(v);
    return escapeHtml(String(v));
  });
}

function wrapInShell(innerHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StereoNET</title><style>${baseStyles}</style></head><body>
<div class="wrap">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#222222">
      <tr><td class="header" style="padding:24px 32px;border-bottom:1px solid #2E2E2E">
        <a href="https://www.stereonet.com"><img src="${LOGO_URL}" alt="StereoNET" class="logo-img" height="40" style="height:40px;width:auto;display:block;border:0"></a>
      </td></tr>
      <tr><td class="card-inner" style="padding:32px;background:#222222;color:#CCCCCC">${innerHtml}</td></tr>
    </table>
    <table role="presentation" class="footer" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
      <tr><td align="center" style="padding:24px 32px;text-align:center">
        <a href="https://www.stereonet.com"><img src="${LOGO_URL}" alt="StereoNET" height="28" style="height:28px;width:auto;display:block;margin:0 auto 12px;border:0"></a>
        <p style="font-size:12px;color:#AAAAAA;margin:4px 0;font-family:Arial,Helvetica,sans-serif">Where hi-fi, home cinema, and headphone enthusiasts connect.</p>
        <p style="font-size:12px;color:#AAAAAA;margin:4px 0;font-family:Arial,Helvetica,sans-serif"><a href="https://www.stereonet.com" style="color:#AAAAAA;text-decoration:none">www.stereonet.com</a></p>
        <p style="font-size:12px;color:#888888;margin:8px 0 0;font-family:Arial,Helvetica,sans-serif">© 2026 Sound Media International Pty Ltd. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr></table>
</div>
</body></html>`;
}

// Registry of all editable templates. Add new ones here.
export const EMAIL_TEMPLATES: Record<string, TemplateDef> = {
  prospect_form_receipt: {
    key: "prospect_form_receipt",
    label: "Prospect — form receipt",
    description: "Sent to the prospect immediately after they submit the /advertising request-a-media-kit form.",
    tokens: [
      { token: "name", description: "Their full name" },
      { token: "first_name", description: "Their first name" },
      { token: "company", description: "Their company" },
    ],
    default_subject: `We've received your StereoNET advertising enquiry`,
    default_html: `<h1>Thanks, {{first_name}}.</h1>
<p>We've received your advertising enquiry from <strong>{{company}}</strong>.</p>
<p>Our team will review your request and get in touch within one business day with a Media Kit tailored to your brand and the opportunities you've expressed interest in.</p>
<p>If anything is urgent in the meantime, simply reply to this email — it goes straight to our team.</p>
<p class="meta">Speak soon,<br><strong>The StereoNET Team</strong></p>`,
  },
  prospect_kit_delivery: {
    key: "prospect_kit_delivery",
    label: "Prospect — Media Kit delivery",
    description: "Sent when you click 'Send Kit Now' on a lead, delivering their personalised magic link.",
    tokens: [
      { token: "name", description: "Their full name" },
      { token: "first_name", description: "Their first name" },
      { token: "company", description: "Their company" },
      { token: "kit_label", description: "Region kit label (e.g. StereoNET ANZ Trade Media Kit)" },
      { token: "magic_link", description: "Their personalised magic link URL" },
    ],
    default_subject: `Your StereoNET Media Kit is ready`,
    default_html: `<h1>Your Media Kit is ready, {{first_name}}.</h1>
<p>Thanks again for your interest in advertising with StereoNET. Below is your personalised <strong>{{kit_label}}</strong>, prepared for <strong>{{company}}</strong>.</p>
<p>It includes our latest audience data, pricing, ad placements, and partnership options.</p>
<p><a href="{{magic_link}}" class="btn">Open My Media Kit &rarr;</a></p>
<p class="meta">If the button doesn't work, copy and paste this URL into your browser:<br><a href="{{magic_link}}">{{magic_link}}</a></p>
<p class="meta">This link is unique to you and expires in 30 days. Reply to this email anytime to discuss next steps.</p>`,
  },
  admin_new_lead: {
    key: "admin_new_lead",
    label: "Admin — new lead notification",
    description: "Sent to every PULSE user whose notify regions match the lead's region (plus the fallback) when a new lead arrives via /advertising.",
    tokens: [
      { token: "name", description: "Prospect's name" },
      { token: "company", description: "Prospect's company" },
      { token: "email", description: "Prospect's email" },
      { token: "company_type", description: "Manufacturer / Distributor / Retailer / Other" },
      { token: "role", description: "Their role (if provided)" },
      { token: "country", description: "Their country (if provided)" },
      { token: "region", description: "Region routed to (uppercased: ANZ / UK_EU / etc.)" },
      { token: "kit_label", description: "Region kit label" },
      { token: "message", description: "Their message (if provided)" },
      { token: "interests_html", description: "Their interests as a pre-rendered HTML list (raw, not escaped)" },
      { token: "magic_link", description: "Their personalised magic link URL" },
      { token: "lead_id", description: "Lead ID" },
      { token: "dashboard_link", description: "Link back to PULSE → Inbound Leads" },
    ],
    default_subject: `New media kit request: {{company}} ({{region}})`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">PULSE Inbound Lead</span></div>
<h1>New Media Kit request from {{company}}</h1>
<p>{{name}} at {{company}} just requested a Media Kit through the advertising page.</p>
<table class="meta-table">
  <tr><td class="k">Name</td><td>{{name}}</td></tr>
  <tr><td class="k">Company</td><td>{{company}}</td></tr>
  <tr><td class="k">Type</td><td>{{company_type}}</td></tr>
  <tr><td class="k">Role</td><td>{{role}}</td></tr>
  <tr><td class="k">Email</td><td><a href="mailto:{{email}}">{{email}}</a></td></tr>
  <tr><td class="k">Country</td><td>{{country}}</td></tr>
  <tr><td class="k">Region routed to</td><td>{{region}} &middot; {{kit_label}}</td></tr>
  <tr><td class="k">Interested in</td><td>{{interests_html}}</td></tr>
  <tr><td class="k">Message</td><td>{{message}}</td></tr>
</table>
<p><a href="{{magic_link}}" class="btn">View Their Kit &rarr;</a></p>
<p class="meta">Lead #{{lead_id}} &middot; <a href="{{dashboard_link}}">Manage in PULSE</a></p>`,
  },
  admin_proposal_accepted: {
    key: "admin_proposal_accepted",
    label: "Admin — proposal accepted",
    description: "Fired when a prospect clicks Accept on their personalised kit.",
    tokens: [
      { token: "name", description: "Name they entered when accepting" },
      { token: "email", description: "Email they entered when accepting" },
      { token: "company", description: "Their company" },
      { token: "accepted_at", description: "Timestamp" },
      { token: "dashboard_link", description: "Link to PITCH dashboard" },
    ],
    default_subject: `Proposal accepted by {{name}} — {{company}}`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">Proposal Accepted</span></div>
<h1>Proposal accepted</h1>
<p><strong>{{name}}</strong> from <strong>{{company}}</strong> has accepted the proposal.</p>
<p>Email: <a href="mailto:{{email}}">{{email}}</a></p>
<p>Time: {{accepted_at}}</p>
<p><a href="{{dashboard_link}}" class="btn">Open PITCH &rarr;</a></p>`,
  },
  admin_proposal_changes: {
    key: "admin_proposal_changes",
    label: "Admin — changes requested",
    description: "Fired when a prospect clicks Request Changes or Talk to Us.",
    tokens: [
      { token: "name", description: "Name they entered" },
      { token: "email", description: "Email they entered" },
      { token: "company", description: "Their company" },
      { token: "message", description: "Their message" },
      { token: "dashboard_link", description: "Link to PITCH dashboard" },
    ],
    default_subject: `Changes requested by {{name}} — {{company}}`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">Changes Requested</span></div>
<h1>Changes requested</h1>
<p><strong>{{name}}</strong> from <strong>{{company}}</strong> has requested changes:</p>
<blockquote>{{message}}</blockquote>
<p>Email: <a href="mailto:{{email}}">{{email}}</a></p>
<p><a href="{{dashboard_link}}" class="btn">Open PITCH &rarr;</a></p>`,
  },
  admin_share_first_viewed: {
    key: "admin_share_first_viewed",
    label: "Sender — prospect opened the kit",
    description: "Fires the first time a prospect opens their personalised Media Kit link. Sent to the user who created the share so they know their prospect engaged.",
    tokens: [
      { token: "sender_first_name", description: "First name of the sender (recipient of this notification)" },
      { token: "prospect_name", description: "Name on the share" },
      { token: "prospect_company", description: "Company on the share" },
      { token: "prospect_email", description: "Email on the share" },
      { token: "kit_label", description: "The Media Kit that was opened" },
      { token: "viewed_at_aest", description: "Local time the prospect first opened the kit (AEST)" },
      { token: "ip", description: "IP address the request came from" },
      { token: "dashboard_link", description: "Link back to the kit in PITCH" },
    ],
    default_subject: `{{prospect_company}} just opened your Media Kit`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">Kit Opened</span></div>
<h1>Your prospect just opened the kit</h1>
<p>Hi {{sender_first_name}},</p>
<p><strong>{{prospect_name}}</strong> from <strong>{{prospect_company}}</strong> just opened <strong>{{kit_label}}</strong> for the first time. Now is a great moment for a follow-up.</p>
<table class="meta-table">
  <tr><td class="k">Prospect</td><td>{{prospect_name}} — {{prospect_company}}</td></tr>
  <tr><td class="k">Email</td><td><a href="mailto:{{prospect_email}}">{{prospect_email}}</a></td></tr>
  <tr><td class="k">Opened</td><td>{{viewed_at_aest}} (AEST)</td></tr>
  <tr><td class="k">IP</td><td>{{ip}}</td></tr>
</table>
<p><a href="{{dashboard_link}}" class="btn">Open in PITCH &rarr;</a></p>
<p class="meta">You're receiving this because you created the share. Manage your notification preferences in PITCH Settings.</p>`,
  },
  admin_proposal_requested: {
    key: "admin_proposal_requested",
    label: "Admin — proposal requested",
    description: "Fired when a kit recipient clicks Request Proposal on their personalised kit and submits their tier/bolt-on selections.",
    tokens: [
      { token: "name", description: "Name they entered" },
      { token: "email", description: "Email they entered" },
      { token: "company", description: "Their company" },
      { token: "tier", description: "The tier/package they selected" },
      { token: "boltons_html", description: "Bolt-ons they ticked as a pre-rendered HTML list (raw, not escaped)" },
      { token: "message", description: "Any additional notes they typed" },
      { token: "kit_label", description: "The kit they were viewing" },
      { token: "dashboard_link", description: "Link to PITCH dashboard" },
    ],
    default_subject: `Proposal requested by {{name}} — {{company}}`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">Proposal Requested</span></div>
<h1>{{name}} wants a proposal</h1>
<p><strong>{{name}}</strong> from <strong>{{company}}</strong> has reviewed the <strong>{{kit_label}}</strong> media kit and is ready to talk packages.</p>
<table class="meta-table">
  <tr><td class="k">Tier of interest</td><td><strong>{{tier}}</strong></td></tr>
  <tr><td class="k">Bolt-ons</td><td>{{boltons_html}}</td></tr>
  <tr><td class="k">Email</td><td><a href="mailto:{{email}}">{{email}}</a></td></tr>
  <tr><td class="k">Their notes</td><td>{{message}}</td></tr>
</table>
<p><a href="{{dashboard_link}}" class="btn">Open PITCH &rarr;</a></p>`,
  },
  admin_proposal_declined: {
    key: "admin_proposal_declined",
    label: "Admin — proposal declined",
    description: "Fired when a prospect clicks Decline on their personalised kit.",
    tokens: [
      { token: "name", description: "Name they entered" },
      { token: "email", description: "Email they entered" },
      { token: "company", description: "Their company" },
      { token: "reason", description: "Reason they gave (optional)" },
      { token: "dashboard_link", description: "Link to PITCH dashboard" },
    ],
    default_subject: `Proposal declined — {{company}}`,
    default_html: `<div style="margin:0 0 16px"><span class="pill">Proposal Declined</span></div>
<h1>Proposal declined</h1>
<p><strong>{{name}}</strong> from <strong>{{company}}</strong> has declined the proposal.</p>
<p>Reason:</p>
<blockquote>{{reason}}</blockquote>
<p>Email: <a href="mailto:{{email}}">{{email}}</a></p>
<p><a href="{{dashboard_link}}" class="btn">Open PITCH &rarr;</a></p>`,
  },
};
