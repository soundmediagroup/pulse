/**
 * File attachment storage.
 *
 * Design:
 *   - Files are content-addressed by SHA-256. Same bytes → same file path → same ID.
 *     Re-uploading a file is a no-op that returns the existing record.
 *   - Files live on the Synology volume at PULSE_UPLOADS_DIR (default /volume1/pulse/uploads).
 *     Sharded by YYYY/MM so no single directory grows unbounded.
 *   - A metadata row in the `attachments` table carries dimensions, caption, credit etc.
 *   - Public URL is served under /uploads/YYYY/MM/<sha>.<ext> by a static route.
 *
 * Accepts: JPEG, PNG, WebP, GIF, PDF. Max 25 MB per file.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sqlite } from "./storage";

export const UPLOADS_DIR = process.env.PULSE_UPLOADS_DIR || "/volume1/pulse/uploads";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
  "application/pdf": "pdf",
};

export interface AttachmentRow {
  id: string;
  sha256: string;
  storage_path: string;
  url: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  original_name: string | null;
  caption: string | null;
  credit: string | null;
  credit_url: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function shortId(): string {
  return "att_" + crypto.randomBytes(8).toString("hex");
}

// Returns width/height for an image buffer using minimal parsing.
// Avoids pulling in a heavy image dependency.
function readImageDimensions(buf: Buffer, mime: string): { width: number | null; height: number | null } {
  try {
    if (mime === "image/png") {
      // IHDR is at offset 16
      if (buf.length >= 24 && buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    } else if (mime === "image/jpeg") {
      // Scan JPEG markers for SOF0/SOF2
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          return { width, height };
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    } else if (mime === "image/gif") {
      if (buf.length >= 10 && buf.slice(0, 3).toString() === "GIF") {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
    } else if (mime === "image/webp") {
      // VP8/VP8L/VP8X chunk at offset 12
      if (buf.length >= 30 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
        const chunk = buf.slice(12, 16).toString();
        if (chunk === "VP8 ") {
          return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        } else if (chunk === "VP8L") {
          const b = buf.slice(21, 25);
          return { width: (((b[1] & 0x3f) << 8) | b[0]) + 1, height: (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) + 1 };
        } else if (chunk === "VP8X") {
          return { width: ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) & 0xffffff) + 1, height: ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) & 0xffffff) + 1 };
        }
      }
    }
  } catch {}
  return { width: null, height: null };
}

export interface SaveArgs {
  buffer: Buffer;
  mime: string;
  originalName?: string;
  caption?: string;
  credit?: string;
  creditUrl?: string;
  uploadedBy?: string;
}

export interface SaveResult {
  row: AttachmentRow;
  deduped: boolean;
}

/**
 * Save an uploaded file. If content already exists, returns the existing record
 * (deduped:true) without writing anything.
 */
export function saveAttachment(args: SaveArgs): SaveResult {
  if (!ALLOWED_MIMES.has(args.mime)) {
    throw Object.assign(new Error(`unsupported mime: ${args.mime}`), { status: 415 });
  }
  if (args.buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`file exceeds ${MAX_UPLOAD_BYTES} bytes`), { status: 413 });
  }
  const sha256 = crypto.createHash("sha256").update(args.buffer).digest("hex");

  // Existing?
  const existing = sqlite.prepare(
    `SELECT * FROM attachments WHERE sha256 = ?`
  ).get(sha256) as AttachmentRow | undefined;
  if (existing) {
    // Backfill caption/credit if empty and caller provided new values
    const updates: string[] = [];
    const params: any[] = [];
    if (args.caption && !existing.caption)     { updates.push("caption = ?");     params.push(args.caption); }
    if (args.credit && !existing.credit)       { updates.push("credit = ?");      params.push(args.credit); }
    if (args.creditUrl && !existing.credit_url){ updates.push("credit_url = ?");  params.push(args.creditUrl); }
    if (updates.length) {
      params.push(existing.id);
      sqlite.prepare(`UPDATE attachments SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return { row: { ...existing, caption: args.caption ?? existing.caption, credit: args.credit ?? existing.credit, credit_url: args.creditUrl ?? existing.credit_url }, deduped: true };
    }
    return { row: existing, deduped: true };
  }

  const ext = MIME_TO_EXT[args.mime];
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm   = String(now.getUTCMonth() + 1).padStart(2, "0");
  const relDir = path.join(yyyy, mm);
  const absDir = path.join(UPLOADS_DIR, relDir);
  ensureDir(absDir);

  const filename = `${sha256}.${ext}`;
  const storagePath = path.join(absDir, filename);
  const url = `/uploads/${relDir}/${filename}`;

  fs.writeFileSync(storagePath, args.buffer);

  const { width, height } = readImageDimensions(args.buffer, args.mime);
  const id = shortId();
  const uploadedAt = new Date().toISOString();

  sqlite.prepare(`
    INSERT INTO attachments (id, sha256, storage_path, url, mime, size_bytes, width, height, original_name, caption, credit, credit_url, uploaded_at, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, sha256, storagePath, url, args.mime, args.buffer.length,
    width, height,
    args.originalName || null,
    args.caption || null,
    args.credit || null,
    args.creditUrl || null,
    uploadedAt,
    args.uploadedBy || null,
  );

  return {
    row: {
      id, sha256, storage_path: storagePath, url,
      mime: args.mime, size_bytes: args.buffer.length,
      width, height,
      original_name: args.originalName || null,
      caption: args.caption || null,
      credit: args.credit || null,
      credit_url: args.creditUrl || null,
      uploaded_at: uploadedAt,
      uploaded_by: args.uploadedBy || null,
    },
    deduped: false,
  };
}

export function getAttachmentById(id: string): AttachmentRow | null {
  return (sqlite.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow) || null;
}

/** Serialise a subset of the row for API responses. */
export function serialiseAttachment(row: AttachmentRow): any {
  return {
    id: row.id,
    url: row.url,
    type: row.mime.startsWith("image/") ? "image" : row.mime === "application/pdf" ? "pdf" : "file",
    mime: row.mime,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    caption: row.caption,
    credit: row.credit,
    credit_url: row.credit_url,
  };
}

/**
 * Delete attachment rows (and their files) that are older than `olderThanDays` and
 * not referenced by any article. Called by a nightly cron.
 */
export function pruneOrphanedAttachments(olderThanDays = 7): { deleted: number } {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  const candidates = sqlite.prepare(
    `SELECT * FROM attachments WHERE uploaded_at < ?`
  ).all(cutoff) as AttachmentRow[];

  let deleted = 0;
  for (const row of candidates) {
    // Is the URL or id referenced anywhere in articles?
    const usage = sqlite.prepare(`
      SELECT 1 FROM articles
      WHERE hero_image_url = ? OR attachments LIKE ? OR attachments LIKE ?
      LIMIT 1
    `).get(row.url, `%"${row.id}"%`, `%${row.url}%`);
    if (usage) continue;

    try { fs.unlinkSync(row.storage_path); } catch {}
    sqlite.prepare(`DELETE FROM attachments WHERE id = ?`).run(row.id);
    deleted++;
  }
  return { deleted };
}
