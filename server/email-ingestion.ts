// Microsoft Graph email ingestion for press@stereonet.com
// Polls the shared mailbox, ingests emails as articles, saves attachments

import { storage, sqlite } from "./storage";
import fs from "fs";
import path from "path";
import { cfg } from "./config";

// Read config at call time so Admin UI edits take effect without restart.
function getTenantId()     { return cfg("MSGRAPH_TENANT_ID"); }
function getClientId()     { return cfg("MSGRAPH_CLIENT_ID"); }
function getClientSecret() { return cfg("MSGRAPH_CLIENT_SECRET"); }
function getMailbox()      { return cfg("PRESS_MAILBOX", "press@stereonet.com"); }
const PROCESSED_CATEGORY = "Dashboard-Processed";

// Attachments saved in persistent data volume (survives container rebuilds).
// Served via Express at /press-attachments/... (see routes.ts).
// Pulse: data directory defaults next to the SQLite file. Live DB filename retained.
const DATA_DIR = process.env.DATA_DIR || path.dirname(process.env.DB_PATH || "./cadence_tracker.db");
export const ATTACHMENTS_DIR = path.join(DATA_DIR, "press-attachments");

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const TENANT_ID = getTenantId();
  const CLIENT_ID = getClientId();
  const CLIENT_SECRET = getClientSecret();
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Microsoft Graph credentials not configured (MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, MSGRAPH_CLIENT_SECRET)");
  }

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph token fetch failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return cachedToken.token;
}

interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  hasAttachments: boolean;
  categories: string[];
  webLink: string;
}

async function fetchMessages(sinceDate: string, pageSize = 50): Promise<GraphMessage[]> {
  const token = await getAccessToken();
  const filter = `receivedDateTime ge ${sinceDate}`;
  const select = "id,subject,bodyPreview,body,from,receivedDateTime,hasAttachments,categories,webLink";
  const MAILBOX = getMailbox();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/Inbox/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=${pageSize}&$orderby=receivedDateTime desc`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph fetch messages failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.value || [];
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentId?: string;
  contentBytes?: string;
}

async function fetchAttachments(messageId: string): Promise<GraphAttachment[]> {
  const token = await getAccessToken();
  const MAILBOX = getMailbox();
  // Don't use $select here — contentId and contentBytes are only on fileAttachment,
  // not the base attachment type, and selecting them causes a 400.
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}/attachments`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`[email-ingest] failed to fetch attachments for ${messageId}`);
    return [];
  }
  const data = await res.json();
  return data.value || [];
}

// Debug: fetch raw attachments as returned by Graph for a given messageId.
export async function debugFetchRawAttachments(messageId: string): Promise<any> {
  const token = await getAccessToken();
  const MAILBOX = getMailbox();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}/attachments`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  return { status: res.status, body: body.length > 5000 ? body.slice(0, 5000) + "\u2026" : body };
}

// Remove the Dashboard-Processed category from all messages in the inbox.
// Useful when ingestion errored after categories were applied — lets us re-ingest.
export async function resetProcessedCategory(): Promise<{ reset: number }> {
  const token = await getAccessToken();
  const MAILBOX = getMailbox();
  let url: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/Inbox/messages?$select=id,categories&$filter=categories/any(c:c eq '${PROCESSED_CATEGORY}')&$top=100`;
  let reset = 0;
  while (url) {
    const res: any = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`reset fetch failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    for (const msg of (data.value || [])) {
      const filtered = (msg.categories || []).filter((c: string) => c !== PROCESSED_CATEGORY);
      const patchUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${msg.id}`;
      const patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ categories: filtered }),
      });
      if (patchRes.ok) reset++;
    }
    url = data["@odata.nextLink"] || null;
  }
  return { reset };
}

async function markProcessed(messageId: string, existingCategories: string[]) {
  const token = await getAccessToken();
  const MAILBOX = getMailbox();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}`;
  const newCategories = [...new Set([...existingCategories, PROCESSED_CATEGORY])];
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ categories: newCategories }),
  });
  if (!res.ok) {
    console.error(`[email-ingest] failed to mark ${messageId} as processed: ${res.status}`);
  }
}

// Strip HTML to plain text for content preview
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract first URL from email body (often the "read more" link in press releases)
function extractUrlFromBody(body: string): string | null {
  const match = body.match(/https?:\/\/[^\s<>"]+/);
  return match ? match[0] : null;
}

// Ensure the email_pressroom site exists in tracked_sites
function ensurePressroomSite() {
  const sites = storage.getSites();
  if (!sites.find((s: any) => s.site_key === "email_pressroom")) {
    storage.addSite(
      "email_pressroom",
      "Press Inbox",
      "mailto:press@stereonet.com",
      "mailto:press@stereonet.com",
      "#a855f7"
    );
    console.log("[email-ingest] Created email_pressroom site");
  }
}

// Diagnostic helper — returns the raw list of inbox messages in the window, with
// the fields the ingester uses for its skip decisions, so we can see why a given
// email was ingested or not.
export async function peekInbox(sinceDays: number): Promise<Array<{
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  categories: string[];
  alreadyProcessed: boolean;
  wouldSkip: string | null;
  hasAttachments: boolean;
}>> {
  if (!getTenantId() || !getClientId() || !getClientSecret()) {
    return [];
  }
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  const messages = await fetchMessages(since.toISOString(), 100);
  return messages.map(m => {
    const alreadyProcessed = (m.categories || []).includes(PROCESSED_CATEGORY);
    const subject = (m.subject || "").trim();
    let wouldSkip: string | null = null;
    if (alreadyProcessed) wouldSkip = "already marked processed";
    else if (!subject || subject.length < 5) wouldSkip = "subject too short";
    return {
      id: m.id,
      subject: subject || "(empty)",
      from: `${m.from?.emailAddress?.name || "?"} <${m.from?.emailAddress?.address || "?"}>`,
      receivedAt: m.receivedDateTime,
      categories: m.categories || [],
      alreadyProcessed,
      wouldSkip,
      hasAttachments: !!m.hasAttachments,
    };
  });
}

export async function ingestEmails(options: { sinceDays?: number } = {}) {
  const sinceDays = options.sinceDays ?? 30;
  if (!getTenantId() || !getClientId() || !getClientSecret()) {
    console.log("[email-ingest] Microsoft Graph credentials not configured, skipping");
    return { processed: 0, skipped: 0, errors: 0 };
  }

  ensurePressroomSite();

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - sinceDays);
  const sinceIso = sinceDate.toISOString();

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: string[] = [];

  try {
    const messages = await fetchMessages(sinceIso, 100);
    console.log(`[email-ingest] Found ${messages.length} messages since ${sinceIso}`);

    for (const msg of messages) {
      try {
        if (msg.categories.includes(PROCESSED_CATEGORY)) {
          skipped++;
          continue;
        }

        const subject = (msg.subject || "").trim();
        if (!subject || subject.length < 5) {
          skipped++;
          continue;
        }

        // Extract body text
        const bodyText = msg.body.contentType === "html"
          ? htmlToText(msg.body.content)
          : (msg.body.content || msg.bodyPreview || "");

        // Article URL points to internal press-release viewer (modal opens on click)
        // We still extract any URL from the body for reference, but the main link
        // opens our own viewer so users can see the email body + attachments.
        const articleUrl = `#press/${msg.id}`;

        // Download attachments — including inline images, which we save separately
        // and use to rewrite cid: references in the body HTML. Some senders leave
        // hasAttachments=false even when there are inline images, so we also fetch
        // whenever the body contains cid: references.
        let attachmentInfo: { name: string; url: string; size: number }[] = [];
        const inlineMap: Record<string, string> = {}; // contentId → served url
        let bodyHtmlRaw = msg.body.contentType === "html" ? (msg.body.content || "") : "";
        const hasCidRefs = /src\s*=\s*["']cid:/i.test(bodyHtmlRaw);
        if (msg.hasAttachments || hasCidRefs) {
          const attachments = await fetchAttachments(msg.id);
          if (!fs.existsSync(ATTACHMENTS_DIR)) {
            fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
          }
          const msgDir = path.join(ATTACHMENTS_DIR, msg.id);
          if (!fs.existsSync(msgDir)) fs.mkdirSync(msgDir, { recursive: true });

          for (const att of attachments) {
            if (!att.contentBytes) continue;
            const safeName = (att.name || `inline-${att.id}`).replace(/[^a-zA-Z0-9._-]/g, "_");
            // Ensure inline images get a file extension if name is missing one
            let finalName = safeName;
            if (att.isInline && !/\.[a-zA-Z0-9]+$/.test(finalName)) {
              const ext = (att.contentType || "").split("/")[1] || "bin";
              finalName = `${safeName}.${ext}`;
            }
            const filePath = path.join(msgDir, finalName);
            fs.writeFileSync(filePath, Buffer.from(att.contentBytes, "base64"));
            const servedUrl = `/press-attachments/${msg.id}/${finalName}`;

            if (att.isInline) {
              // Map cid reference for body rewrite. contentId is typically wrapped in <>.
              if (att.contentId) {
                const cid = att.contentId.replace(/^<|>$/g, "");
                inlineMap[cid] = servedUrl;
                inlineMap[att.contentId] = servedUrl;
              }
              continue; // don't list inline images as downloadable attachments
            }

            attachmentInfo.push({
              name: att.name,
              url: servedUrl,
              size: att.size,
            });
          }
        }

        // Rewrite cid: references in the body HTML to local URLs.
        let bodyHtml = bodyHtmlRaw;
        if (Object.keys(inlineMap).length > 0) {
          bodyHtml = bodyHtml.replace(/src\s*=\s*["']cid:([^"']+)["']/gi, (match, cid) => {
            const url = inlineMap[cid] || inlineMap[`<${cid}>`];
            return url ? `src="${url}"` : match;
          });
        }

        // Insert article
        const fromName = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
        const fromEmail = msg.from?.emailAddress?.address || "";
        const snippet = bodyText.length > 500 ? bodyText.slice(0, 500) + "\u2026" : bodyText;
        const articleBrands = JSON.stringify([]);

        // Check if already ingested via message_id
        const existing = sqlite.prepare(`SELECT id FROM articles WHERE message_id = ?`).get(msg.id);
        if (existing) {
          skipped++;
          await markProcessed(msg.id, msg.categories);
          continue;
        }

        try {
          sqlite.prepare(`
            INSERT INTO articles (site, title, url, published_at, published_date, content_type, categories, fetched_at, author, brands, description, attachments, message_id, body_html, sender_name, sender_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            "email_pressroom",
            subject,
            articleUrl,
            msg.receivedDateTime,
            msg.receivedDateTime.slice(0, 10),
            "press_release",
            JSON.stringify(["press release"]),
            new Date().toISOString(),
            fromName,
            articleBrands,
            snippet,
            JSON.stringify(attachmentInfo),
            msg.id,
            bodyHtml,
            fromName,
            fromEmail,
          );
          processed++;
        } catch (e: any) {
          if (e.message && e.message.includes("UNIQUE constraint")) {
            skipped++;
          } else {
            console.log(`[email-ingest] Insert failed for \"${subject}\": ${e.message}`);
            errorDetails.push(`Insert failed for "${subject}": ${e.message}`);
            errors++;
          }
        }

        await markProcessed(msg.id, msg.categories);
      } catch (e: any) {
        console.error(`[email-ingest] Error processing message ${msg.id}: ${e.message}`);
        errorDetails.push(`Msg ${msg.id} ("${(msg.subject || "").slice(0, 60)}"): ${e.message}`);
        errors++;
      }
    }
  } catch (e: any) {
    console.error(`[email-ingest] Fatal error: ${e.message}`);
    errorDetails.push(`Fatal: ${e.message}${e.stack ? "\n" + e.stack.split("\n").slice(0, 3).join("\n") : ""}`);
    errors++;
  }

  console.log(`[email-ingest] Done: ${processed} processed, ${skipped} skipped, ${errors} errors`);
  return { processed, skipped, errors, errorDetails };
}
