import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRealtimeEvents } from "@/hooks/useRealtime";
import { RefreshCw, Search, ExternalLink, Eye, MessageCircle, Send, Trash2, SmilePlus, Flag, CheckCircle2, X, BookCheck, Info, Pin, Ban, MoreHorizontal, Paperclip, Download, Mail, Sparkles, Star, TrendingUp, ArrowUp, MessagesSquare, Flame, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SITE_CONFIG_FALLBACK: Record<string, { label: string; color: string }> = {
  whathifi: { label: "What Hi-Fi", color: "#6366f1" },
  stereonet: { label: "StereoNET", color: "#e8312a" },
  email_pressroom: { label: "Press Inbox", color: "#a855f7" },
  // Primary-source watchers
  fcc_filings: { label: "FCC Filings", color: "#f59e0b" },
  youtube_reviewers: { label: "YouTube Reviewers", color: "#ef4444" },
  brand_press: { label: "Brand Press Portal", color: "#10b981" },
};

interface DiscoveryArticle {
  id: number;
  site: string;
  title: string;
  url: string;
  published_at: string;
  content_type: string;
  covered: boolean;
  score: number;
  siteCount: number;
  description?: string;
  attachments?: string;
  author?: string;
  // Editor-brief extensions
  summary?: string | null;
  brief_markdown?: string | null;
  hero_image_url?: string | null;
  please_write?: number;
  pinned_by?: string | null;
  suggested_word_count?: string | null;
  suggested_headlines?: string | null; // JSON
  open_questions?: string | null;      // JSON
  sources?: string | null;             // JSON
  filteredByKeyword?: string | null;   // populated server-side when title matches a saved filter keyword
  bsidedAt?: string | null;            // populated server-side when admin marked as B-Side (28d window)
  titleEn?: string | null;             // server-side cached English translation of the title (when source is non-en)
  sourceLang?: string | null;          // ISO 639-1 source language code (e.g. "de"), null for English-language sites
}

interface EditorBriefExtras {
  attachments: Array<{ id?: string; url: string; type: string; caption?: string | null; credit?: string | null; credit_url?: string | null; width?: number | null; height?: number | null }>;
  sources: Array<{ title: string; url: string }>;
  openQuestions: string[];
  suggestedHeadlines: string[];
}

function parseEditorBriefExtras(a: DiscoveryArticle): EditorBriefExtras {
  const parseJson = <T,>(s: string | null | undefined, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };
  return {
    attachments: parseJson(a.attachments as any, []),
    sources: parseJson(a.sources, []),
    openQuestions: parseJson(a.open_questions, []),
    suggestedHeadlines: parseJson(a.suggested_headlines, []),
  };
}

interface DismissedArticle {
  article_url: string;
}

interface Comment {
  id: number;
  article_id: number;
  username: string;
  comment: string;
  created_at: string;
}

interface Claim {
  article_id: number;
  username: string;
  claimed_at: string;
}

interface Reaction {
  comment_id: number;
  emoji: string;
  username: string;
}

const REACTION_EMOJIS = ["👍", "❤️", "😂", "🔥", "👀", "🎧"];

// Claim age thresholds (hours):
//   < 24h  : amber, static (normal in-progress claim)
//   24-48h : amber, FLASHING (gentle nudge — claim is dragging)
//   >= 48h : red, FLASHING (overdue — should be unblocked or escalated)
const CLAIM_WARNING_HOURS = 24;
const CLAIM_OVERDUE_HOURS = 48;
function claimHoursElapsed(claimedAt: string): number {
  return Math.max(0, Date.now() - new Date(claimedAt).getTime()) / 3_600_000;
}
function claimAgeState(claimedAt: string): "normal" | "warning" | "overdue" {
  const h = claimHoursElapsed(claimedAt);
  if (h >= CLAIM_OVERDUE_HOURS) return "overdue";
  if (h >= CLAIM_WARNING_HOURS) return "warning";
  return "normal";
}
function isClaimOverdue(claimedAt: string): boolean {
  return claimHoursElapsed(claimedAt) >= CLAIM_OVERDUE_HOURS;
}
function ClaimTimer({ claimedAt }: { claimedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - new Date(claimedAt).getTime());
  const mins = Math.floor(elapsed / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let label: string;
  if (days > 0) label = `${days}d ${hrs % 24}h`;
  else if (hrs > 0) label = `${hrs}h ${mins % 60}m`;
  else label = `${mins}m`;
  const isOverdue = hrs >= CLAIM_OVERDUE_HOURS;
  const isWarning = hrs >= CLAIM_WARNING_HOURS && !isOverdue;
  const isMedium = hrs >= 4 && !isWarning && !isOverdue;
  return (
    <span className={`text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded ${
      isOverdue ? "bg-red-600/30 text-red-200 font-semibold animate-pulse" :
      isWarning ? "bg-amber-500/30 text-amber-200 font-semibold animate-pulse" :
      isMedium ? "bg-amber-500/15 text-amber-400" :
      "bg-muted/30 text-muted-foreground"
    }`}>
      ⏱ {label}{isOverdue ? " · overdue" : isWarning ? " · dragging" : ""}
    </span>
  );
}

function relativeTime(iso: string) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const diff = Math.round((Date.now() - date.getTime()) / 60000);
  if (diff <= 0) return "just now";
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 1440)}d ago`;
}

function scoreColor(s: number) {
  if (s >= 8) return { bg: "#e8312a", text: "#fff" };
  if (s >= 6) return { bg: "#f97316", text: "#fff" };
  if (s >= 4) return { bg: "#facc15", text: "#1a1a1a" };
  return { bg: "#374151", text: "#9ca3af" };
}

const TYPE_COLORS: Record<string, string> = {
  review: "#e8312a", news: "#f97316", feature: "#facc15", opinion: "#fb923c", unknown: "#6b7280",
};

// ─── Comment Thread Component ───────────────────────────────────────────────
function CommentThread({ articleId, currentUser }: { articleId: number; currentUser: string }) {
  const [newComment, setNewComment] = useState("");
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  const qc = useQueryClient();

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["/api/comments", articleId],
    queryFn: () => apiRequest("GET", `/api/comments/${articleId}`).then(r => r.json()),
  });

  const { data: reactions = [] } = useQuery<Reaction[]>({
    queryKey: ["/api/comments/reactions", articleId],
    queryFn: () => apiRequest("GET", `/api/comments/${articleId}/reactions`).then(r => r.json()),
    enabled: comments.length > 0,
  });

  // Group reactions by comment_id → emoji → usernames
  const reactionsByComment = new Map<number, Map<string, string[]>>();
  for (const r of reactions) {
    if (!reactionsByComment.has(r.comment_id)) reactionsByComment.set(r.comment_id, new Map());
    const emojiMap = reactionsByComment.get(r.comment_id)!;
    if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, []);
    emojiMap.get(r.emoji)!.push(r.username);
  }

  const addMutation = useMutation({
    mutationFn: (comment: string) =>
      apiRequest("POST", `/api/comments/${articleId}`, { comment }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/comments", articleId] });
      qc.invalidateQueries({ queryKey: ["/api/comments/counts"] });
      setNewComment("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (commentId: number) =>
      apiRequest("DELETE", `/api/comments/${commentId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/comments", articleId] });
      qc.invalidateQueries({ queryKey: ["/api/comments/counts"] });
      qc.invalidateQueries({ queryKey: ["/api/comments/reactions", articleId] });
    },
  });

  const reactionMutation = useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      apiRequest("POST", `/api/reactions/${commentId}`, { emoji }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/comments/reactions", articleId] });
      setPickerOpenFor(null);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newComment.trim()) addMutation.mutate(newComment.trim());
  };

  return (
    <div className="mt-2 ml-6 mr-4 pb-2" onClick={e => e.stopPropagation()}>
      {/* Existing comments */}
      {isLoading ? (
        <div className="text-xs text-muted-foreground py-2">Loading comments…</div>
      ) : comments.length > 0 ? (
        <div className="space-y-3 mb-3">
          {comments.map(c => {
            const emojiMap = reactionsByComment.get(c.id);
            return (
              <div key={c.id} className="group">
                <div className="flex items-start gap-2">
                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase">
                      {c.username.charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">
                        {c.username.split("@")[0]}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{relativeTime(c.created_at)}</span>
                      {c.username === currentUser && (
                        <button
                          onClick={() => deleteMutation.mutate(c.id)}
                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-red-400 transition-all p-0.5"
                          title="Delete comment"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-foreground/80 leading-snug">{c.comment}</p>

                    {/* Reactions row */}
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      {emojiMap && Array.from(emojiMap.entries()).map(([emoji, users]) => {
                        const iMine = users.includes(currentUser);
                        return (
                          <button
                            key={emoji}
                            onClick={() => reactionMutation.mutate({ commentId: c.id, emoji })}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs transition-colors ${
                              iMine
                                ? "bg-[#6366f1]/20 border border-[#6366f1]/40"
                                : "bg-muted/40 border border-transparent hover:border-border/50"
                            }`}
                            title={users.map(u => u.split("@")[0]).join(", ")}
                          >
                            <span>{emoji}</span>
                            <span className="tabular-nums text-[10px] text-muted-foreground">{users.length}</span>
                          </button>
                        );
                      })}

                      {/* Add reaction button */}
                      <div className="relative">
                        <button
                          onClick={() => setPickerOpenFor(pickerOpenFor === c.id ? null : c.id)}
                          className="p-1 rounded-full text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/30 opacity-0 group-hover:opacity-100 transition-all"
                          title="Add reaction"
                        >
                          <SmilePlus className="w-3.5 h-3.5" />
                        </button>
                        {pickerOpenFor === c.id && (
                          <div className="absolute bottom-full left-0 mb-1 flex gap-0.5 bg-popover border border-border rounded-lg p-1 shadow-xl z-20">
                            {REACTION_EMOJIS.map(emoji => (
                              <button
                                key={emoji}
                                onClick={() => reactionMutation.mutate({ commentId: c.id, emoji })}
                                className="w-7 h-7 rounded-md hover:bg-muted/50 flex items-center justify-center text-sm transition-colors"
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* New comment input */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-[#e8312a]/15 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-[#e8312a] uppercase">
            {currentUser.charAt(0)}
          </span>
        </div>
        <input
          type="text"
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="Add a comment…"
          maxLength={1000}
          className="flex-1 text-sm bg-muted/30 border border-border/50 rounded-lg px-3 py-1.5 text-foreground placeholder:text-muted-foreground outline-none focus:border-[#e8312a]/40 transition-colors"
        />
        <button
          type="submit"
          disabled={!newComment.trim() || addMutation.isPending}
          className="p-1.5 rounded-lg text-[#e8312a] hover:bg-[#e8312a]/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

// ─── Colour helpers ───────────────────────────────────────────────────────────────
// Ensure a site colour is readable on the dark card background.
// If it's too dark (low luminance), lighten it toward white.
function readableOnDark(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.42) return hex;
  const target = 0.55;
  const t = Math.min(1, (target - lum) / (1 - lum + 0.0001));
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ─── Topic grouping helpers ────────────────────────────────────────────────
// Extract a normalised "brand + model" key from an article title so near-duplicate
// coverage of the same product can be grouped into one card.
const GROUPING_BRANDS = [
  "Beats", "Sennheiser", "Sony", "Bose", "Apple", "Samsung", "LG", "Panasonic", "TCL", "Hisense",
  "KEF", "Bowers & Wilkins", "B&W", "B&O", "Bang & Olufsen", "Sonos", "Denon", "Marantz",
  "Yamaha", "Pioneer", "NAD", "Cambridge Audio", "Arcam", "Rotel", "McIntosh",
  "Naim", "Linn", "Rega", "Pro-Ject", "Technics", "Clearaudio", "VPI", "Thorens",
  "Dynaudio", "Focal", "Klipsch", "Polk", "Wharfedale", "Mission", "Monitor Audio", "PSB",
  "Paradigm", "Revel", "JBL", "Harbeth", "Spendor", "ProAc", "Sonus Faber", "Wilson Audio",
  "Magico", "MBL", "Devialet", "Chord", "dCS", "MSB", "Esoteric", "T+A", "Hegel",
  "Bryston", "Parasound", "Benchmark", "Topping", "SMSL", "Schiit", "Audeze", "HiFiMan",
  "Dan Clark Audio", "Beyerdynamic", "Shure", "Audio-Technica", "AKG", "Grado", "Meze",
  "Campfire", "Moondrop", "Empire Ears", "64 Audio", "ZMF", "SVS", "REL", "JL Audio",
  "Perlisten", "Arendal", "Buchardt", "Genelec", "Adam Audio", "Neumann", "WiiM",
  "Eversolo", "Aurender", "Innuos", "Antipodes", "Melco", "Bluesound", "Roon",
  // Adjacent / surprise brands that can drop a hi-fi product:
  "Garmin", "DJI", "Anker", "Soundcore", "Nothing", "Google", "Amazon",
  "Microsoft", "Belkin", "Razer", "Logitech", "Steinway", "Lyngdorf",
  "Naim Mu-so", "Ruark", "Tivoli", "Geneva", "Cabasse", "Triangle",
  // Streaming / music services — needed so coordinated launch coverage
  // (e.g. Spotify Wrapped-like feature drops with 4+ sites within hours)
  // can group via the per-token fingerprint pass.
  "Spotify", "Tidal", "Qobuz", "Apple Music", "Amazon Music", "YouTube Music",
  "Deezer", "SoundCloud", "Pandora",
];
const GROUPING_BRAND_RX = new RegExp(
  `\\b(${GROUPING_BRANDS.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i"
);
// Match a model identifier: letter+digit combos, e.g. HD 480, WH-1000XM6, XM5, Reference 3, 705 S3, Q950C
const MODEL_RX = /\b([A-Z]{1,5}[- ]?\d{2,5}[A-Z0-9]*|\d{3,4}[A-Z]{1,4}|\d{1,2}[A-Z]\d+[A-Z]*)\b/;

// Stopwords — distinctive capitalised words that aren't useful for grouping
const KEYWORD_STOPWORDS = new Set([
  "A", "An", "The", "This", "That", "These", "Those", "It", "Its", "We", "Our",
  "New", "Now", "Here", "There", "What", "Why", "How", "When", "Where", "Who",
  "Review", "Reviews", "News", "Best", "Top", "Better", "Good", "Great",
  "Audio", "Sound", "Music", "Speaker", "Speakers", "Headphone", "Headphones",
  "Review", "Edition", "Special", "Limited", "Amp", "Amps", "Amplifier",
  "Turntable", "DAC", "Streamer", "Soundbar", "Home", "Theater", "Theatre",
  "Hi", "Fi", "HiFi", "HiEnd", "Avenue", "Way", "Day", "Week", "Year", "Years",
  "Up", "Out", "In", "On", "Off", "For", "To", "With", "And", "Or", "But",
  "Brings", "Launches", "Unveils", "Reveals", "Announces", "Debuts", "Teams",
  "Colour", "Color", "Colours", "Colors", "Stealth", "Stealthy",
]);

// Pull distinctive keywords from a title: capitalised 4+ char words that aren't stopwords.
// Used as a fallback when no brand/model is detected — e.g. "Jennie", "Kanye", "Taylor".
function extractKeywords(title: string): string[] {
  const matches = title.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || [];
  return matches
    .map(w => w.trim())
    .filter(w => w.length >= 4 && !KEYWORD_STOPWORDS.has(w))
    .map(w => w.toLowerCase());
}

// Group near-duplicate coverage of the same product.
//
// Rewritten Apr 2026: strict brand+model signature only. The previous
// implementation merged on shared keywords (e.g. "headphones", "OLED",
// "turntable"), which over-grouped wildly — every Sennheiser piece collapsed
// onto every other Sennheiser piece, every OLED piece onto every other OLED.
//
// New rules:
//  1. Title must contain BOTH a recognised brand AND a model code to group.
//  2. Two articles group only when both brand AND normalised model match
//     exactly. "Sennheiser HD 480" ≠ "Sennheiser HD 660 S2".
//  3. Articles without a model code never participate in grouping (they
//     stay flat as singletons).
//  4. Falls back to no grouping for unidentifiable titles — better to under-
//     group than over-group.
// Normalise a title into content tokens for similarity grouping. Strips
// punctuation, lowercases, removes the trailing site-attribution suffix
// (" - Gear Patrol", " | What Hi-Fi?"), drops stopwords and the brand itself,
// and collapses whitespace. The result is a sequence of substantive content
// words ready for n-gram fingerprinting.
function normaliseTitleTokens(title: string, brand: string | null): string[] {
  let t = title;
  // Drop everything from the last " - " or " | " onwards — that's typically
  // the syndicating site (e.g. "... - Gear Patrol", "... | Stereophile").
  t = t.replace(/\s+[\-|—]\s+[^\-|—]+$/, "");
  // Strip possessive 's so "Sony's" ≡ "Sony".
  t = t.replace(/[\u2019']s\b/g, "");
  // Lowercase, strip non-alphanumeric except spaces.
  t = t.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const brandLower = brand ? brand.toLowerCase() : "";
  const tokens = t.split(/\s+/).filter(w => w.length > 0);
  // Reuse KEYWORD_STOPWORDS but case-insensitive comparison.
  const stop = new Set([...KEYWORD_STOPWORDS].map(s => s.toLowerCase()));
  return tokens.filter(w => w.length >= 3 && !stop.has(w) && w !== brandLower);
}

// Build STABLE fingerprint keys from a normalised title's content tokens.
// Returns multiple keys: one for each distinctive content token. Two articles
// share a key if they share the same brand AND any one of those distinctive
// tokens. The grouper merges any pair that shares ANY key, so a candidate with
// {garmin, primacy, luxury} groups with another that has {garmin, primacy,
// system} via the shared `tf:garmin:primacy` key.
//
// This is more permissive than fixed-position fingerprinting and catches the
// Garmin Primacy launch case where syndicated coverage uses wildly different
// lead phrasing but shares 1-2 product-name tokens.
//
// To avoid false positives on common brands (Sony, LG, Samsung) where many
// unrelated stories run in parallel, we ONLY emit fingerprint keys for tokens
// that are not in the EXTRA_BRAND_NOISE set ("new", "premium", "luxury",
// "system", etc — token additions on top of the base stopwords).
const FP_NOISE = new Set([
  "premium", "luxury", "flagship", "new", "latest", "first", "system",
  "systems", "line", "range", "series", "model", "models", "product",
  "products", "launch", "launches", "announce", "announces", "unveils",
  "unveil", "reveals", "reveal", "debut", "debuts", "updates", "update",
  "version", "models", "price", "pricing", "now", "available", "sale",
  "deal", "discount", "five", "star", "super", "yes", "one", "just",
  "has", "have", "had", "will", "with", "from", "that", "this", "its",
  "who", "why", "how", "can", "all", "are", "its", "top", "big", "old",
  "get", "got", "out", "off", "hi", "fi", "wireless", "audio", "sound",
  "music", "home", "the", "and", "for", "buy", "buying", "sell", "selling",
  "gear", "brand", "company", "makers", "maker", "reviewer", "writer",
  "editor", "premium", "luxury", "high", "low", "best", "worst", "better",
  "good", "great", "poor", "bad", "affordable", "cheap", "expensive",
  "costly", "value", "money", "cost", "more", "less", "few", "some", "any",
  "every", "each", "both", "either", "neither", "none", "per", "watt",
  "watts", "hour", "hours", "minute", "minutes", "second", "seconds",
  "day", "days", "week", "weeks", "month", "months", "year", "years",
]);
function titleFingerprintKeys(brand: string, tokens: string[]): string[] {
  const distinctive = tokens.filter(w => !FP_NOISE.has(w));
  if (distinctive.length === 0) return [];
  const b = brand.toLowerCase();
  // Emit one key per distinctive token — two titles share a key if they
  // share the brand AND any single distinctive content token.
  return distinctive.map(t => `tf:${b}:${t}`);
}

function extractGroupKeys(title: string): { keys: string[]; label: string } {
  const keys: string[] = [];
  const brandMatch = title.match(GROUPING_BRAND_RX);
  const modelMatch = title.match(MODEL_RX);
  const brand = brandMatch ? brandMatch[1] : null;
  const model = modelMatch ? modelMatch[1].toUpperCase().replace(/[- ]/g, "") : null;

  // Distinctive model = ≥5 chars with letter+digit, OR ≥6 chars. Filters out
  // generic codes like "S5", "M3", "X1" that collide across brands.
  const isDistinctiveModel = !!model && (
    (model.length >= 5 && /[A-Z]/.test(model) && /\d/.test(model)) || model.length >= 6
  );

  // Primary signature: brand + model (both required). This is the same
  // signature used by the "already covered" pill, so behaviour is consistent.
  if (brand && isDistinctiveModel) {
    keys.push(`bm:${brand.toLowerCase()}:${model}`);
  }
  // Secondary fallback: model-only, but ONLY when distinctive. Catches cases
  // where one title says "Sennheiser" and another says "Sennheiser's" or where
  // brand isn't cleanly extracted.
  if (isDistinctiveModel) {
    keys.push(`m:${model}`);
  }
  // Tertiary fallback: per-token fingerprint match for stories with no model
  // code. Required: a recognised brand. Emits one key per distinctive content
  // token; two titles group if they share the brand AND any token. This is
  // tolerant of headlines with very different framings of the same news (e.g.
  // Garmin Primacy launch coverage where one site says "Garmin Launches JL
  // Audio Primacy Luxury Home Audio System" and another says "Garmin
  // redefines luxury home audio with revolutionary new Primacy system").
  if (brand && !isDistinctiveModel) {
    const tokens = normaliseTitleTokens(title, brand);
    const fps = titleFingerprintKeys(brand, tokens);
    keys.push(...fps);
  }

  let label = "";
  if (brand && isDistinctiveModel) label = `${brand} ${modelMatch![1]}`;
  else if (isDistinctiveModel) label = modelMatch![1];
  else if (brand) label = brand;

  return { keys, label };
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function Discovery() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());
  // Track which brief articles we've already auto-expanded once, so that if the
  // user manually collapses a brief it stays collapsed on subsequent re-renders.
  const autoExpandedBriefs = useRef<Set<number>>(new Set());
  const [confirmDismiss, setConfirmDismiss] = useState<number | null>(null);
  const [confirmIrrelevant, setConfirmIrrelevant] = useState<number | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);
  // Persist sub-tab across reloads so refreshing on Filters or Dismissed stays put.
  const [subTab, setSubTabRaw] = useState<"active" | "dismissed" | "written" | "trending" | "filters" | "bsides">(() => {
    try {
      const v = localStorage.getItem("discovery.subTab");
      if (v === "active" || v === "dismissed" || v === "written" || v === "trending" || v === "filters" || v === "bsides") return v;
    } catch {}
    return "active";
  });
  const setSubTab = (v: "active" | "dismissed" | "written" | "trending" | "filters" | "bsides") => {
    setSubTabRaw(v);
    try { localStorage.setItem("discovery.subTab", v); } catch {}
  };
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const [confirmBulkDismiss, setConfirmBulkDismiss] = useState(false);
  const [openPressId, setOpenPressId] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Claimed articles render collapsed by default to save space; per-row expand state.
  const [expandedClaims, setExpandedClaims] = useState<Set<number>>(new Set());
  const toggleClaimExpanded = (id: number) => {
    setExpandedClaims(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // Default ON now that grouping uses strict brand+model matching (Apr 2026 rewrite).
  // Persisted to localStorage so the user's preference survives reloads.
  const [groupingEnabled, setGroupingEnabledRaw] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("discovery.groupingEnabled");
      if (v === "0") return false;
      if (v === "1") return true;
    } catch {}
    return true;
  });
  const setGroupingEnabled = (v: boolean | ((prev: boolean) => boolean)) => {
    setGroupingEnabledRaw(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem("discovery.groupingEnabled", next ? "1" : "0"); } catch {}
      return next;
    });
  };
  const [hideDeals, setHideDeals] = useState(true);
  const { toast } = useToast();
  const qc = useQueryClient();

  // Realtime: refresh caches when any user changes the state of an article.
  useRealtimeEvents(
    ["article.new", "article.claimed", "article.unclaimed", "article.dismissed",
     "article.undismissed", "article.written", "article.pinned", "article.unpinned",
     "trending.dismissed", "trending.covered", "top-picks.regenerated"],
    (event, _data) => {
      // Invalidate everything relevant; React Query will refetch lazily.
      if (event.startsWith("article.")) {
        qc.invalidateQueries({ queryKey: ["/api/articles"] });
        qc.invalidateQueries({ queryKey: ["/api/claims"] });
        qc.invalidateQueries({ queryKey: ["/api/dismissals"] });
        qc.invalidateQueries({ queryKey: ["/api/written"] });
        qc.invalidateQueries({ queryKey: ["/api/pins"] });
      }
      if (event.startsWith("trending.")) {
        qc.invalidateQueries({ queryKey: ["/api/trending"] });
      }
      if (event === "top-picks.regenerated") {
        qc.invalidateQueries({ queryKey: ["/api/top-picks"] });
      }
    }
  );

  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    clearTimeout((window as any).__searchTimer);
    (window as any).__searchTimer = setTimeout(() => setDebouncedSearch(val), 300);
  }, []);

  // Current user
  const { data: me } = useQuery<{ username: string; role: string }>({
    queryKey: ["/api/admin/me"],
    queryFn: () => apiRequest("GET", "/api/admin/me").then(r => r.json()),
    staleTime: 300000,
  });

  // Dynamic site config
  const { data: sitesData = [] } = useQuery<{ key: string; label: string; color: string }[]>({
    queryKey: ["/api/sites"],
    queryFn: () => apiRequest("GET", "/api/sites").then(r => r.json()),
    staleTime: Infinity,
  });
  const SITE_CONFIG: Record<string, { label: string; color: string }> = {};
  for (const s of sitesData) { SITE_CONFIG[s.key] = { label: s.label, color: s.color }; }
  Object.assign(SITE_CONFIG, SITE_CONFIG_FALLBACK);

  const { data: articles = [], isLoading } = useQuery<DiscoveryArticle[]>({
    queryKey: ["/api/discovery", debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "300" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return apiRequest("GET", `/api/discovery?${params}`).then(r => r.json());
    },
    refetchInterval: 60000,
  });

  // ─── Learning system: site health pills + hot-story clusters ──────────────
  const { data: siteHealthData } = useQuery<{ ok: boolean; sites: Array<{ site: string; articles_30d: number; dismissed_30d: number; kept_30d: number; dismissal_ratio: number; health: string }> }>({
    queryKey: ["/api/discovery-learning/site-health"],
    queryFn: () => apiRequest("GET", "/api/discovery-learning/site-health").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60_000,
  });
  const siteHealthMap: Record<string, { health: string; ratio: number; articles_30d: number; dismissed_30d: number }> = {};
  for (const s of (siteHealthData?.sites || [])) {
    siteHealthMap[s.site] = { health: s.health, ratio: s.dismissal_ratio, articles_30d: s.articles_30d, dismissed_30d: s.dismissed_30d };
  }

  const { data: hotStoriesData } = useQuery<{ ok: boolean; clusters: Array<{ id: number; brand: string; product: string; site_count: number; first_seen_at: string; last_seen_at: string; articles: Array<{ id: number; site: string; title: string; url: string; published_at: string }> }> }>({
    queryKey: ["/api/discovery-learning/hot-stories"],
    queryFn: () => apiRequest("GET", "/api/discovery-learning/hot-stories").then(r => r.json()),
    refetchInterval: 3 * 60 * 1000,
    staleTime: 60_000,
  });
  const dismissHotStoryMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/discovery-learning/hot-stories/${id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/discovery-learning/hot-stories"] }),
  });

  // Auto-expand newly-arrived editor briefs so the writer sees the full angle,
  // sources and open questions inline without having to click. Each brief is
  // only auto-expanded once (tracked in autoExpandedBriefs) so manually
  // collapsing stays collapsed across refetches.
  useEffect(() => {
    if (!articles.length) return;
    const toAdd: number[] = [];
    for (const a of articles) {
      const isBrief = !!a.brief_markdown
        || a.site === "editor-brief"
        || a.site === "task-agent"
        || a.site === "task-agent-debug"
        || a.content_type === "editor_brief";
      if (isBrief && !autoExpandedBriefs.current.has(a.id)) {
        autoExpandedBriefs.current.add(a.id);
        toAdd.push(a.id);
      }
    }
    if (toAdd.length > 0) {
      setExpandedComments(prev => {
        const next = new Set(prev);
        for (const id of toAdd) next.add(id);
        return next;
      });
    }
  }, [articles]);

  // Hit counts
  const { data: hitCounts = {} } = useQuery<Record<string, { hits: number; image?: string }>>({
    queryKey: ["/api/hit-counts"],
    queryFn: () => apiRequest("GET", "/api/hit-counts").then(r => r.json()),
  });

  // Dismissals (global)
  const { data: dismissals = [] } = useQuery<{ article_id: number; username: string; dismissed_at: string }[]>({
    queryKey: ["/api/dismissals"],
    queryFn: () => apiRequest("GET", "/api/dismissals").then(r => r.json()),
  });
  const dismissedMap = new Map(dismissals.map(d => [d.article_id, d]));
  const dismissedSet = new Set(dismissals.map(d => d.article_id));

  // Optimistic dismiss — article disappears immediately, server roundtrip is async.
  // Prevents the 300-800ms perceived lag on Cloudflare→Synology.
  const dismissMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("POST", `/api/dismissals/${articleId}`).then(r => r.json()),
    onMutate: async (articleId: number) => {
      await qc.cancelQueries({ queryKey: ["/api/dismissals"] });
      const previous = qc.getQueryData<any[]>(["/api/dismissals"]) ?? [];
      const optimistic = [
        ...previous,
        { article_id: articleId, username: "__optimistic__", dismissed_at: new Date().toISOString() },
      ];
      qc.setQueryData(["/api/dismissals"], optimistic);
      setConfirmDismiss(null);
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/dismissals"], ctx.previous);
      toast({ title: "Dismiss failed", description: "Article restored. Try again.", variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/dismissals"] });
    },
  });

  const bulkDismissMutation = useMutation({
    mutationFn: async (articleIds: number[]) => {
      await Promise.all(articleIds.map(id =>
        apiRequest("POST", `/api/dismissals/${id}`).then(r => r.json())
      ));
    },
    onMutate: async (articleIds: number[]) => {
      await qc.cancelQueries({ queryKey: ["/api/dismissals"] });
      const previous = qc.getQueryData<any[]>(["/api/dismissals"]) ?? [];
      const now = new Date().toISOString();
      const optimistic = [
        ...previous,
        ...articleIds.map(id => ({ article_id: id, username: "__optimistic__", dismissed_at: now })),
      ];
      qc.setQueryData(["/api/dismissals"], optimistic);
      setBulkSelected(new Set());
      setBulkMode(false);
      setConfirmBulkDismiss(false);
      return { previous };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/dismissals"], ctx.previous);
      toast({ title: "Bulk dismiss failed", description: "Articles restored. Try again.", variant: "destructive" });
    },
    onSuccess: () => {
      toast({ title: "Articles dismissed" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/dismissals"] });
    },
  });

  const undismissMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("DELETE", `/api/dismissals/${articleId}`).then(r => r.json()),
    onMutate: async (articleId: number) => {
      await qc.cancelQueries({ queryKey: ["/api/dismissals"] });
      const previous = qc.getQueryData<any[]>(["/api/dismissals"]) ?? [];
      qc.setQueryData(["/api/dismissals"], previous.filter(d => d.article_id !== articleId));
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/dismissals"], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["/api/dismissals"] }),
  });

  const irrelevantMutation = useMutation({
    mutationFn: ({ articleId, title, site }: { articleId: number; title: string; site: string }) =>
      apiRequest("POST", `/api/irrelevant/${articleId}`, { title, site }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/dismissals"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Marked irrelevant", description: "The system is learning from your feedback" });
    },
  });

  // Written articles
  const { data: writtenList = [] } = useQuery<{ article_id: number; username: string; claimed_at: string }[]>({
    queryKey: ["/api/written"],
    queryFn: () => apiRequest("GET", "/api/written").then(r => r.json()),
  });
  const writtenMap = new Map(writtenList.map(w => [w.article_id, w]));
  const writtenSet = new Set(writtenList.map(w => w.article_id));

  const markWrittenMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("POST", `/api/claims/${articleId}/written`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/claims"] });
      qc.invalidateQueries({ queryKey: ["/api/written"] });
    },
  });

  // Pins (admin)
  const { data: pins = [] } = useQuery<{ article_id: number; note: string; pinned_by: string; pinned_at: string }[]>({
    queryKey: ["/api/pins"],
    queryFn: () => apiRequest("GET", "/api/pins").then(r => r.json()),
  });
  const pinMap = new Map(pins.map(p => [p.article_id, p]));

  const pinMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("POST", `/api/pins/${articleId}`, { note: "Please Write" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/pins"] }),
  });

  const unpinMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("DELETE", `/api/pins/${articleId}`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/pins"] }),
  });

  const isAdmin = me?.role === "admin";

  // Comment counts (for badge display)
  const { data: commentCounts = [] } = useQuery<{ article_id: number; count: number }[]>({
    queryKey: ["/api/comments/counts"],
    queryFn: () => apiRequest("GET", "/api/comments/counts").then(r => r.json()),
  });
  const commentCountMap = new Map(commentCounts.map(c => [c.article_id, c.count]));

  // Claims
  const { data: claims = [] } = useQuery<Claim[]>({
    queryKey: ["/api/claims"],
    queryFn: () => apiRequest("GET", "/api/claims").then(r => r.json()),
  });
  const claimMap = new Map(claims.map(c => [c.article_id, c]));

  const claimMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("POST", `/api/claims/${articleId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/claims"] });
    },
    onError: (err: any) => toast({ title: err.message || "Claim failed", variant: "destructive" }),
  });

  const unclaimMutation = useMutation({
    mutationFn: (articleId: number) =>
      apiRequest("DELETE", `/api/claims/${articleId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/claims"] });
    },
  });

  // Mark as B-Side (admin only). Server returns ok; we invalidate the discovery
  // query so the row's bsidedAt field updates and it disappears from Active.
  const bsideMutation = useMutation({
    mutationFn: (articleId: number) => apiRequest("POST", `/api/bsides/${articleId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Moved to B-Sides" });
    },
    onError: (err: any) => toast({ title: err.message || "B-Side failed", variant: "destructive" }),
  });
  // Restore a B-Side back into Active (admin only).
  const unbsideMutation = useMutation({
    mutationFn: (articleId: number) => apiRequest("DELETE", `/api/bsides/${articleId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Restored to Active" });
    },
  });

  const toggleComments = (articleId: number) => {
    setExpandedComments(prev => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  };

  // ── Deals / affiliate-marketing filter ──
  // Articles whose titles look like deals/discounts/lowest-price round-ups get filtered out of Active.
  // Calibrated against WhatHiFi affiliate output (April 2026 sample, 22 confirmed deal titles, 0 false
  // positives across 58 editorial titles). Covers: deal/bargain/discount/sale/clearance words; lowest/
  // knockdown/crashed/budget/affordable/remarkable price phrasing; save $/£/€ amounts; X% off; currency
  // "X off"; "for just/only/under $£€X"; "for less"; "hits just $X"; shopping verbs (snap up, grab, hurry,
  // quick); BFCM / Prime Day / Amazon deal; urgency closers ("before it's too late"); "best deals/savings";
  // "already on sale"; currency "discount on"; "big/huge saving on".
  const DEALS_RX = new RegExp(
    [
      String.raw`\b(deal(?:s)?|bargain|discount(?:ed|s)?|sale|cheap(?:est|er)?|markdown|clearance|on\s+sale)\b`,
      String.raw`\b(lowest[- ](?:price|ever)|lowest[- ]ever\s+price|new\s+lowest\s+price|best[- ]price|price[- ]drop|price[- ]crash|crashed\s+to|knockdown\s+price|budget\s+price|affordable\s+price|remarkable\s+price|half[- ]price)\b`,
      String.raw`\bsave\s+(?:up\s+to\s+)?[\$£€]?\d`,
      String.raw`\b\d{1,3}\s*%\s*off\b`,
      String.raw`[\$£€]\d[\d,\.]*\s+off\b`,
      String.raw`\bfor\s+(?:just\s+|only\s+|under\s+)?[\$£€]\d`,
      String.raw`\bfor\s+less!?\b`,
      String.raw`\bhits\s+(?:just\s+)?[\$£€]\d`,
      String.raw`\b(snap\s+up|grab\s+the|don'?t\s+miss|hurry|quick!)\b`,
      String.raw`\b(prime\s+day|black\s+friday|cyber\s+monday|amazon\s+deal|boxing\s+day\s+sale)\b`,
      String.raw`\bbefore\s+(?:it'?s\s+too\s+late|they'?re\s+gone)\b`,
      String.raw`\b(best\s+(?:deals|savings|discounts)|huge\s+(?:savings|discount)|massive\s+(?:price|saving|discount))\b`,
      String.raw`\balready\s+on\s+sale\b`,
      String.raw`\b\d[\d,\.]*\s+discount\s+on\b`,
      String.raw`\b(?:a|big|huge|massive)\s+saving\s+on\b`,
    ].join('|'),
    'i'
  );
  const isDealsArticle = (a: { title: string }) => DEALS_RX.test(a.title);

  // Active: not dismissed, not written, not auto-filtered by saved keyword.
  // Order: pinned first (admin priority) → claimed next → everything else by time (newest first).
  // Covered items are styled grey but appear in their natural chronological position.
  // B-Side articles are hidden from Active too (they live only in the B-Sides tab
  // until 28d expiry, after which the server stops returning their bsidedAt and
  // they reappear in Active automatically).
  const allActive = articles.filter(a =>
    !dismissedSet.has(a.id)
    && !writtenSet.has(a.id)
    && !a.filteredByKeyword
    && !a.bsidedAt
    && (!hideDeals || !isDealsArticle(a))
  );
  const pinnedArticles = allActive.filter(a => pinMap.has(a.id));
  const claimedArticles = allActive.filter(a => claimMap.has(a.id) && !pinMap.has(a.id));
  const remaining = allActive.filter(a => !pinMap.has(a.id) && !claimMap.has(a.id));
  const activeArticles = [...pinnedArticles, ...claimedArticles, ...remaining];

  // Dismissed tab — includes both explicit dismissals and keyword-filtered rows
  const dismissedArticles = articles.filter(a => dismissedSet.has(a.id) || !!a.filteredByKeyword);

  // Written tab
  const writtenArticles = articles.filter(a => writtenSet.has(a.id));

  // B-Sides tab — articles flagged as low-priority by an admin (28d window;
  // server filters out anything older). Sorted newest-marked first.
  const bsidedArticles = articles
    .filter(a => !!a.bsidedAt)
    .sort((a, b) => (b.bsidedAt || "").localeCompare(a.bsidedAt || ""));

  const displayArticlesRaw =
    subTab === "active" ? activeArticles :
    subTab === "dismissed" ? dismissedArticles :
    subTab === "written" ? writtenArticles :
    subTab === "bsides" ? bsidedArticles :
    [];

  // ── Build groups of near-duplicate coverage (same brand+model) ──
  // Only group within Active tab; Dismissed/Written stay flat.
  // A group with only one article shows normally. A group with 2+ articles collapses
  // the extras behind an expand toggle on the lead article.
  const groupInfo = (() => {
    if (!groupingEnabled || subTab !== "active") {
      return {
        articles: displayArticlesRaw,
        groupKeyFor: new Map<number, string>(),
        groupMembers: new Map<string, typeof displayArticlesRaw>(),
        groupLabel: new Map<string, string>(),
      };
    }
    // Pin/claim articles are NOT grouped — they show individually regardless.
    // Algorithm: each article produces multiple possible keys. Any two articles sharing
    // at least one key are union-find merged into the same group.
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
      return parent.get(id)!;
    };
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // Articles considered for grouping (not pinned/claimed)
    const groupables: typeof displayArticlesRaw = [];
    const articleKeys = new Map<number, { keys: string[]; label: string }>();
    for (const a of displayArticlesRaw) {
      if (pinMap.has(a.id) || claimMap.has(a.id)) continue;
      const info = extractGroupKeys(a.title);
      if (info.keys.length === 0) continue;
      groupables.push(a);
      articleKeys.set(a.id, info);
      parent.set(a.id, a.id);
    }

    // For each key, union all articles that emit it
    const keyIndex = new Map<string, number[]>();
    for (const a of groupables) {
      const keys = articleKeys.get(a.id)!.keys;
      for (const k of keys) {
        if (!keyIndex.has(k)) keyIndex.set(k, []);
        keyIndex.get(k)!.push(a.id);
      }
    }
    for (const ids of keyIndex.values()) {
      for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    }

    // Brand-cluster pass: for articles with a recognised brand AND no
    // distinctive model code, union all same-brand articles whose published_at
    // values fall within a 48-hour window of each other. This catches launch
    // bursts where coverage uses wildly different headline framings (e.g. the
    // Garmin Primacy launch, where each site picks a different angle and no
    // single content token appears in all of them).
    //
    // Safe because per-token grouping has already merged tightly-related
    // articles, and the model-code check excludes routine product reviews
    // (Sony WF-1000XM6 review vs WH-1000XM6 review will both have model codes
    // and so won't bucket together via this pass).
    const BRAND_CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1000;
    // Brands that get such heavy daily coverage (multiple unrelated stories per
    // day) that pure brand+time clustering would mis-merge unrelated stories.
    // For these, we rely solely on per-token fingerprint matching.
    const HIGH_VOLUME_BRANDS = new Set([
      "sony", "samsung", "lg", "apple", "bose", "sonos", "jbl", "beats",
      "sennheiser", "bowers & wilkins", "b&w", "yamaha", "denon", "marantz",
      "hisense", "tcl", "panasonic", "klipsch", "focal",
      // Streaming services run heavy daily news flow — only cluster them via
      // per-token fingerprint, not via blind 48h brand-cluster fallback.
      "apple music", "amazon music", "youtube music",
    ]);
    const brandClusters = new Map<string, { id: number; ts: number }[]>();
    for (const a of groupables) {
      const info = articleKeys.get(a.id)!;
      // Only cluster brand-without-model articles — detected by absence of any
      // "bm:" or "m:" key in the article's key list.
      const hasModel = info.keys.some(k => k.startsWith("bm:") || k.startsWith("m:"));
      if (hasModel) continue;
      // Find a `tf:<brand>:` prefix to identify the brand. If none, skip.
      const tfKey = info.keys.find(k => k.startsWith("tf:"));
      if (!tfKey) continue;
      const brand = tfKey.split(":")[1];
      if (!brand || HIGH_VOLUME_BRANDS.has(brand)) continue;
      const ts = a.published_at ? new Date(a.published_at).getTime() : Date.now();
      if (!brandClusters.has(brand)) brandClusters.set(brand, []);
      brandClusters.get(brand)!.push({ id: a.id, ts });
    }
    // Cap cluster size at 8 — if a brand has more than 8 articles in 48h with
    // no model codes, something else is going on (e.g. brand mentioned in many
    // unrelated round-ups) and we shouldn't aggressively merge.
    const BRAND_CLUSTER_MAX_SIZE = 8;
    for (const [_brand, members] of brandClusters) {
      if (members.length < 2 || members.length > BRAND_CLUSTER_MAX_SIZE) continue;
      // Sort by timestamp and union consecutive entries within 48h.
      members.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < members.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
          if (members[i].ts - members[j].ts <= BRAND_CLUSTER_WINDOW_MS) {
            union(members[i].id, members[j].id);
            break;
          }
        }
      }
    }

    // Collect groups by root
    const byRoot = new Map<number, typeof displayArticlesRaw>();
    for (const a of groupables) {
      const root = find(a.id);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push(a);
    }

    // Build group metadata keyed by a synthetic string (rootId — numeric)
    const groups = new Map<string, typeof displayArticlesRaw>();
    const groupLabels = new Map<string, string>();
    const keyByArticleId = new Map<number, string>();
    for (const [root, members] of byRoot) {
      if (members.length < 2) continue; // singletons not really grouped
      const groupKey = `g:${root}`;
      groups.set(groupKey, members);
      // Use the lead (first) article's label if it has one, otherwise any member's
      const lead = members[0];
      const label = articleKeys.get(lead.id)?.label
        || members.map(m => articleKeys.get(m.id)?.label).find(Boolean)
        || "";
      groupLabels.set(groupKey, label);
      for (const m of members) keyByArticleId.set(m.id, groupKey);
    }

    // Render order: emit lead of each group at the first member's position; skip non-leads
    const orderedArticles: typeof displayArticlesRaw = [];
    const seenGroups = new Set<string>();
    for (const a of displayArticlesRaw) {
      const key = keyByArticleId.get(a.id);
      if (!key) { orderedArticles.push(a); continue; } // ungrouped or singleton
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      orderedArticles.push(groups.get(key)![0]); // lead
    }
    return {
      articles: orderedArticles,
      groupKeyFor: keyByArticleId,
      groupMembers: groups,
      groupLabel: groupLabels,
    };
  })();
  const displayArticles = groupInfo.articles;

  const newestTime = articles.length > 0 ? articles[0].published_at : null;
  const lastRefreshStr = newestTime ? relativeTime(newestTime) : "Never";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur px-6 py-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <h1 className="font-display text-lg text-foreground shrink-0 leading-none">
              Discovery
              <span className="ml-2 text-[10px] font-editorial text-muted-foreground/80 tracking-normal">the signal, ahead of the story</span>
            </h1>
            <div className="flex items-center gap-2 flex-1 min-w-0 pl-3 border-l border-border/60">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search articles..."
                value={search}
                onChange={e => handleSearch(e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs text-muted-foreground">
              {activeArticles.length} active · {dismissedArticles.length} dismissed · {writtenArticles.length} written
            </span>
            <button
              onClick={() => setGroupingEnabled(v => !v)}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors ${
                groupingEnabled
                  ? "bg-blue-500/15 text-blue-300 border-blue-500/30 hover:bg-blue-500/25"
                  : "bg-muted/30 text-muted-foreground border-border/40 hover:bg-muted/50"
              }`}
              title="Group near-duplicate coverage of the same product"
            >
              Group duplicates {groupingEnabled ? "on" : "off"}
            </button>
            <button
              onClick={() => setHideDeals(v => !v)}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors ${
                hideDeals
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25"
                  : "bg-muted/30 text-muted-foreground border-border/40 hover:bg-muted/50"
              }`}
              title="Hide deals, discounts, and lowest-price articles from Active"
            >
              Hide deals {hideDeals ? "on" : "off"}
            </button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="w-3 h-3" />
              Updated {lastRefreshStr} · auto
            </span>
          </div>
        </div>
        {/* Sub tabs + bulk mode */}
        <div className="flex items-center gap-1">
          {([
            { key: "active" as const, label: "Active", count: activeArticles.length as number | null },
            { key: "dismissed" as const, label: "Dismissed", count: dismissedArticles.length as number | null },
            { key: "written" as const, label: "Written", count: writtenArticles.length as number | null },
            { key: "bsides" as const, label: "B-Sides", count: bsidedArticles.length as number | null },
            { key: "filters" as const, label: "Filters", count: null },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                subTab === tab.key
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              }`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className={`ml-1.5 tabular-nums ${subTab === tab.key ? "text-foreground/60" : "text-muted-foreground/60"}`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
          {/* Separator + prominent Trending tab */}
          <div className="w-px h-5 bg-border mx-1" />
          <button
            onClick={() => setSubTab("trending")}
            className={`group inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all border ${
              subTab === "trending"
                ? "bg-gradient-to-r from-orange-500/30 to-amber-500/20 text-orange-100 border-orange-500/60 shadow-sm shadow-orange-500/20"
                : "bg-orange-500/10 text-orange-300 border-orange-500/40 hover:bg-orange-500/20 hover:text-orange-200 hover:border-orange-500/60"
            }`}
            title="What the audio community is talking about right now"
          >
            <Flame className={`w-3.5 h-3.5 ${subTab === "trending" ? "text-orange-300" : "text-orange-400"}`} />
            Trending & Emerging
          </button>

          {/* Bulk mode controls */}
          <div className="ml-auto flex items-center gap-2">
            {bulkMode ? (
              <>
                <span className="text-[11px] text-muted-foreground">
                  {bulkSelected.size} selected
                </span>
                {bulkSelected.size > 0 && (
                  confirmBulkDismiss ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-red-400">Dismiss {bulkSelected.size} for all?</span>
                      <button
                        onClick={() => bulkDismissMutation.mutate([...bulkSelected])}
                        disabled={bulkDismissMutation.isPending}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setConfirmBulkDismiss(false)}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded bg-muted/50 text-muted-foreground"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmBulkDismiss(true)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                    >
                      Dismiss Selected
                    </button>
                  )
                )}
                <button
                  onClick={() => {
                    const allIds = displayArticles.map(a => a.id);
                    if (bulkSelected.size === allIds.length) {
                      setBulkSelected(new Set());
                    } else {
                      setBulkSelected(new Set(allIds));
                    }
                  }}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground border border-border/30 hover:text-foreground transition-colors"
                >
                  {bulkSelected.size === displayArticles.length ? "Deselect All" : "Select All"}
                </button>
                <button
                  onClick={() => { setBulkMode(false); setBulkSelected(new Set()); setConfirmBulkDismiss(false); }}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground border border-border/30 hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              subTab === "active" && (
                <button
                  onClick={() => setBulkMode(true)}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground border border-border/30 hover:text-foreground transition-colors"
                >
                  Bulk Dismiss
                </button>
              )
            )}
          </div>
        </div>
      </header>

      {/* Article list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2" onClick={(e) => { if ((e.target as HTMLElement).closest('[data-menu]')) return; setMenuOpenFor(null); setConfirmDismiss(null); setConfirmIrrelevant(null); }}>
        {subTab === "trending" ? (
          <TrendingTab />
        ) : subTab === "filters" ? (
          <FilterKeywordsTab />
        ) : <>
        {subTab === "active" && (() => {
          // Primary Sources lane — signals from FCC / gold-standard reviewers / brand press portals
          // that arrived BEFORE any publisher covered the story. Not dismissed, not covered, not claimed.
          const primarySources = allActive
            .filter(a => (a as any).is_primary_source)
            .slice(0, 6);
          if (primarySources.length === 0) return null;
          return (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2 pl-1">
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#e8312a]/40 to-transparent" />
                <span className="font-display text-[11px] tracking-[0.2em] uppercase text-[#e8312a]">⚡ Primary Sources  </span>
                <span className="font-editorial text-[10px] text-muted-foreground/70 lowercase tracking-normal">before anyone else covers it</span>
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#e8312a]/40 to-transparent" />
              </div>
              <div className="grid gap-1.5">
                {primarySources.map(a => {
                  const s = SITE_CONFIG[a.site];
                  const color = readableOnDark(s?.color ?? "#e8312a");
                  const label = s?.label ?? a.site;
                  const t = relativeTime(a.published_at);
                  return (
                    <a
                      key={`primary-${a.id}`}
                      href={a.url}
                      target="_blank"
                      rel="noopener"
                      className="primary-lane-card rounded-md pl-3 pr-3 py-2 flex items-center gap-3 group"
                      title={`${label} · primary-source signal`}
                    >
                      <span className="font-display text-[10px] tracking-widest text-[#e8312a]/80 uppercase shrink-0 w-14">Signal</span>
                      <span className="text-sm font-medium text-foreground truncate flex-1 group-hover:text-[#e8312a] transition-colors">
                        {a.titleEn || a.title}
                      </span>
                      <span className="text-xs font-semibold shrink-0" style={{ color }}>{label}</span>
                      {t && <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{t}</span>}
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {subTab === "active" && (hotStoriesData?.clusters?.length ?? 0) > 0 && (
          <div className="mb-3 space-y-2">
            {hotStoriesData!.clusters.slice(0, 3).map(cluster => (
              <div key={cluster.id} className="rounded-md border border-red-500/40 bg-red-500/10 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <Flame className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">Hot Story</span>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/20 text-red-200">{cluster.site_count} sites in 24h</span>
                        <span className="text-xs font-semibold text-foreground truncate">{cluster.brand || cluster.product}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground truncate">
                        {cluster.articles.slice(0, 3).map((a, i) => (
                          <span key={a.id}>
                            {i > 0 ? " · " : ""}
                            <a href={a.url} target="_blank" rel="noopener" className="hover:text-foreground underline underline-offset-2">{SITE_CONFIG[a.site]?.label ?? a.site}</a>
                          </span>
                        ))}
                        {cluster.articles.length > 3 ? ` · +${cluster.articles.length - 3} more` : ""}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => dismissHotStoryMutation.mutate(cluster.id)}
                    className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-border/50 bg-background/50 hover:bg-background text-muted-foreground hover:text-foreground"
                    title="Dismiss this cluster — already covered or not relevant"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {subTab === "active" && <TopPicksPanel articles={articles} />}
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
        ) : articles.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No articles found. Feeds auto-refresh every 15 minutes.
          </div>
        ) : (
          <div className="stagger-reveal space-y-2">
          {displayArticles.map(article => {
            const site = SITE_CONFIG[article.site];
            const rawSiteColor = site?.color ?? "#6b7280";
            const siteColor = readableOnDark(rawSiteColor);
            const siteLabel = site?.label ?? article.site;
            const timeStr = relativeTime(article.published_at);
            const typeColor = TYPE_COLORS[article.content_type] ?? TYPE_COLORS.unknown;
            const commentCount = commentCountMap.get(article.id) || 0;
            const isExpanded = expandedComments.has(article.id);
            const claim = claimMap.get(article.id);
            const isClaimed = !!claim;
            const isMyClam = claim?.username === me?.username;
            const isDismissed = dismissedSet.has(article.id);
            const isWritten = writtenSet.has(article.id);
            const dismissInfo = dismissedMap.get(article.id);
            const writtenInfo = writtenMap.get(article.id);
            const pin = pinMap.get(article.id);
            const isPinned = !!pin;
            // An article is a brief if it carries a brief_markdown body, OR the site is
            // an editor/task-agent feed, OR it was flagged content_type=editor_brief.
            // Briefs auto-expand on first render so the writer sees the full angle,
            // sources, and open questions without having to hunt for the expand icon.
            const isBrief = !!article.brief_markdown
              || article.site === "editor-brief"
              || article.site === "task-agent"
              || article.site === "task-agent-debug"
              || article.content_type === "editor_brief";
            // Grouping: does this article lead a group of 2+?
            const groupKey = groupInfo.groupKeyFor.get(article.id);
            const groupMembers = groupKey ? (groupInfo.groupMembers.get(groupKey) || []) : [];
            const isGroupLead = groupMembers.length >= 2;
            const groupLabel = groupKey ? groupInfo.groupLabel.get(groupKey) : undefined;
            const groupIsExpanded = groupKey ? expandedGroups.has(groupKey) : false;
            const groupExtras = isGroupLead ? groupMembers.slice(1) : [];

            return (
              <div key={article.id} className={`rounded-lg border transition-colors ${
                isPinned
                  ? "border-[#e8312a]/40 bg-[#e8312a]/5 ring-1 ring-[#e8312a]/20"
                  : isClaimed
                    ? "border-amber-500/40 bg-amber-500/5"
                    : commentCount > 0 && !article.covered
                      ? "border-[#e8312a]/30 bg-[#e8312a]/[0.03] border-l-4 border-l-[#e8312a]"
                      : article.covered ? "border-border/30 bg-transparent opacity-90" : "border-border/60 bg-card"
              }`}>
                {/* Comments banner — only on rows with comments, NOT pinned/claimed (those have their own banners) */}
                {commentCount > 0 && !isPinned && !isClaimed && !isExpanded && !article.covered && (
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleComments(article.id); }}
                    className="w-full flex items-center justify-between gap-3 px-5 py-2 bg-gradient-to-r from-[#e8312a]/15 via-[#e8312a]/10 to-[#e8312a]/5 border-b border-[#e8312a]/30 hover:from-[#e8312a]/25 hover:via-[#e8312a]/15 transition-colors group"
                  >
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <MessageCircle className="w-4 h-4 text-[#e8312a]" />
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#e8312a] rounded-full ring-2 ring-background animate-pulse" />
                      </div>
                      <span className="text-xs font-bold text-[#e8312a]">
                        {commentCount} comment{commentCount !== 1 ? "s" : ""} on this article
                      </span>
                    </div>
                    <span className="text-[10px] font-semibold text-[#e8312a]/70 group-hover:text-[#e8312a]">
                      Click to read →
                    </span>
                  </button>
                )}

                {/* Pin banner */}
                {isPinned && subTab === "active" && (
                  <div className="flex items-center justify-between px-5 py-2 bg-[#e8312a]/10 border-b border-[#e8312a]/20">
                    <div className="flex items-center gap-2">
                      <Pin className="w-3.5 h-3.5 text-[#e8312a]" />
                      <span className="text-xs font-bold text-[#e8312a]">
                        {pin!.note}
                      </span>
                      <span className="text-[10px] text-[#e8312a]/60">
                        — {pin!.pinned_by.split("@")[0]}
                      </span>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); unpinMutation.mutate(article.id); }}
                        className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground/70 border border-border/30 hover:text-foreground hover:bg-muted/50 transition-colors"
                      >
                        Unpin
                      </button>
                    )}
                  </div>
                )}

                {/* Claimed banner. Click anywhere on the banner (except the action buttons)
                    to toggle the claimed article's expanded body. Defaults to collapsed
                    so claimed work-in-progress doesn't dominate Active. */}
                {isClaimed && subTab === "active" && (() => {
                  const claimExpanded = expandedClaims.has(article.id);
                  // Banner colour and animation by claim age:
                  //   normal (<24h)  — amber, static
                  //   warning (24-48h) — amber, FLASHING
                  //   overdue (>=48h)  — red, FLASHING
                  const ageState = claimAgeState(claim!.claimed_at);
                  const overdue = ageState === "overdue";
                  const warning = ageState === "warning";
                  return (
                    <div
                      className={`flex items-center justify-between gap-3 px-5 py-2 border-b cursor-pointer transition-colors ${
                        overdue
                          ? "bg-red-600/20 border-red-500/40 hover:bg-red-600/30 animate-pulse"
                          : warning
                          ? "bg-amber-500/20 border-amber-500/40 hover:bg-amber-500/30 animate-pulse"
                          : "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15"
                      }`}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleClaimExpanded(article.id); }}
                      title={claimExpanded ? "Collapse" : "Expand to see details"}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {claimExpanded
                          ? <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${overdue ? "text-red-300" : "text-amber-400"}`} />
                          : <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${overdue ? "text-red-300" : "text-amber-400"}`} />}
                        <Flag className={`w-3.5 h-3.5 shrink-0 ${overdue ? "text-red-300" : "text-amber-400"}`} />
                        <span className={`text-xs font-semibold shrink-0 ${overdue ? "text-red-200" : warning ? "text-amber-200" : "text-amber-300"}`}>
                          Claimed by {claim!.username.split("@")[0]}
                        </span>
                        <ClaimTimer claimedAt={claim!.claimed_at} />
                        {!claimExpanded && (
                          <span className={`text-xs truncate ml-1 ${overdue ? "text-red-100/80" : warning ? "text-amber-100/85" : "text-amber-100/70"}`}>
                            · {article.title}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); markWrittenMutation.mutate(article.id); }}
                          className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Mark as Published
                        </button>
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); unclaimMutation.mutate(article.id); }}
                          className="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground/70 border border-border/30 hover:text-foreground hover:bg-muted/50 transition-colors"
                        >
                          Unclaim
                        </button>
                      </div>
                    </div>
                  );
                })()}
                {isDismissed && subTab === "dismissed" && (
                  <div className="flex items-center justify-between px-5 py-2 bg-red-500/5 border-b border-red-500/15">
                    <span className="text-xs text-red-400/70">
                      Dismissed by {dismissInfo?.username.split("@")[0]}
                    </span>
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); undismissMutation.mutate(article.id); }}
                      className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground/70 border border-border/30 hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                )}
                {isWritten && subTab === "written" && (
                  <div className="flex items-center justify-between px-5 py-2 bg-emerald-500/5 border-b border-emerald-500/15">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-xs text-emerald-400/70">
                        Written by {writtenInfo?.username.split("@")[0]}
                      </span>
                    </div>
                  </div>
                )}

                {/* Claimed rows render collapsed by default — banner only.
                    Body is rendered when not claimed, claimed and expanded,
                    or in any tab other than active. */}
                {(isClaimed && subTab === "active" && !expandedClaims.has(article.id)) ? null : (
                <a
                  href={article.site === "email_pressroom" ? "#" : article.url}
                  target={article.site === "email_pressroom" ? undefined : "_blank"}
                  rel="noopener noreferrer"
                  className="block group"
                  title={article.site === "email_pressroom" ? "Click to view email body & attachments" : (article.covered ? "Already covered on StereoNET" : undefined)}
                  onClick={(e) => {
                    if (article.site === "email_pressroom") {
                      e.preventDefault();
                      setOpenPressId(article.id);
                    }
                  }}
                >
                  <div className="flex items-center gap-4 px-5 py-4">
                    {/* Bulk select checkbox */}
                    {bulkMode && subTab === "active" && (
                      <label className="shrink-0 flex items-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelected.has(article.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            setBulkSelected(prev => {
                              const next = new Set(prev);
                              if (next.has(article.id)) next.delete(article.id);
                              else next.add(article.id);
                              return next;
                            });
                          }}
                          className="w-4 h-4 rounded border-border/50 bg-muted accent-[#e8312a] cursor-pointer"
                        />
                      </label>
                    )}

                    {/* Coloured left accent bar */}
                    <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: siteColor, minHeight: 20 }} />

                    {/* Hero thumbnail for editor briefs & any article with hero_image_url */}
                    {article.hero_image_url && (
                      <a
                        href={article.hero_image_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 block"
                      >
                        <img
                          src={article.hero_image_url}
                          alt=""
                          loading="lazy"
                          className="w-20 h-20 object-cover rounded-md border border-border/40"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      </a>
                    )}

                    {/* Main content */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-[17px] font-semibold leading-snug mb-2 ${
                        article.covered ? "text-muted-foreground" : "text-foreground group-hover:text-[#e8312a]"
                      } transition-colors`}
                      title={article.titleEn ? article.title : undefined}
                      >
                        {article.titleEn || article.title}
                        {article.sourceLang && article.titleEn && (
                          <span
                            className="ml-2 align-middle text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border/40 font-mono"
                            title={`Translated from ${article.sourceLang.toUpperCase()} — hover the title to see the original`}
                          >
                            {article.sourceLang.toUpperCase()} → EN
                          </span>
                        )}
                        {article.sourceLang && !article.titleEn && (
                          <span
                            className="ml-2 align-middle text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300/80 border border-amber-500/30 font-mono"
                            title="Translating in the background… refresh in a moment"
                          >
                            {article.sourceLang.toUpperCase()}
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-3 flex-wrap">
                        {(article as any).is_primary_source && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/40 uppercase tracking-wider" title="Primary source — this signal came from FCC filings, gold-standard reviewers, or direct manufacturer press portals BEFORE any publisher covered it">
                            ⚡ Primary source
                          </span>
                        )}
                        <span className="text-sm font-semibold" style={{ color: siteColor }}>{siteLabel}</span>
                        {(() => {
                          const h = siteHealthMap[article.site];
                          if (!h || h.health === "unknown") return null;
                          const style = h.health === "green" ? "bg-green-500/15 text-green-300 border-green-500/30" : h.health === "amber" ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-red-500/15 text-red-300 border-red-500/30";
                          return (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${style}`} title={`${h.dismissed_30d}/${h.articles_30d} articles dismissed in the last 30 days (${Math.round(h.ratio * 100)}%)`}>
                              {Math.round(h.ratio * 100)}%
                            </span>
                          );
                        })()}
                        {timeStr && <span className="text-sm text-muted-foreground">{timeStr}</span>}
                        {isBrief && (
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleComments(article.id); }}
                            className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                              isExpanded
                                ? "bg-purple-500/40 text-purple-100 border-purple-400"
                                : "bg-purple-500/20 text-purple-300 border-purple-500/40 hover:bg-purple-500/30 hover:text-purple-200"
                            }`}
                            title={isExpanded ? "Collapse brief" : "Expand brief"}
                          >
                            EDITOR BRIEF {isExpanded ? "▴" : "▾"}
                          </button>
                        )}
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full"
                          style={{ background: typeColor + "25", color: typeColor }}
                        >
                          {article.content_type === "editor_brief" ? "brief" : article.content_type}
                        </span>
                        {article.covered && (
                          <span className="text-xs text-muted-foreground border border-muted-foreground/25 px-2 py-0.5 rounded-full">
                            already covered
                          </span>
                        )}
                        {article.filteredByKeyword && (
                          <span
                            className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full border bg-amber-500/15 text-amber-300 border-amber-500/30"
                            title={`Hidden by saved filter keyword: "${article.filteredByKeyword}"`}
                          >
                            FILTERED: {article.filteredByKeyword}
                          </span>
                        )}
                        {article.bsidedAt && (
                          <span
                            className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full border bg-purple-500/15 text-purple-300 border-purple-500/30"
                            title={`B-Side since ${new Date(article.bsidedAt).toLocaleDateString("en-AU")} — auto-removed after 28 days`}
                          >
                            B-SIDE
                          </span>
                        )}
                        {(() => {
                          if (!article.attachments) return null;
                          try {
                            const atts = JSON.parse(article.attachments);
                            if (!Array.isArray(atts) || atts.length === 0) return null;
                            return (
                              <span className="text-xs text-purple-400 border border-purple-400/30 bg-purple-400/10 px-2 py-0.5 rounded-full flex items-center gap-1">
                                📎 {atts.length} attachment{atts.length !== 1 ? "s" : ""}
                              </span>
                            );
                          } catch { return null; }
                        })()}
                      </div>
                      {/* Description snippet for press releases */}
                      {article.site === "email_pressroom" && article.description && (
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-2">
                          {article.description}
                        </p>
                      )}
                      {/* Summary for editor briefs (always shown, inline) */}
                      {article.summary && (
                        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                          {article.summary}
                        </p>
                      )}
                    </div>

                    {/* Right side: compact action bar */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Hit count */}
                      {(() => {
                        const slug = article.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
                        const lastSeg = slug.split("/").pop() || slug;
                        const hc = hitCounts[article.url] ?? hitCounts[slug] ?? hitCounts[lastSeg];
                        return hc?.hits != null ? (
                          <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#e8312a]/10 text-[#e8312a]" title="Page views">
                            <Eye className="w-3 h-3" />
                            <span className="text-xs font-bold tabular-nums">{hc.hits.toLocaleString()}</span>
                          </div>
                        ) : null;
                      })()}

                      {/* Comment */}
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleComments(article.id); }}
                        className={`relative flex items-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                          isExpanded
                            ? "bg-[#e8312a]/20 text-[#e8312a] border-[#e8312a]/50 shadow-[0_0_0_2px_rgba(232,49,42,0.15)]"
                            : commentCount > 0
                              ? "bg-[#e8312a] text-white border-[#e8312a] font-bold shadow-[0_2px_8px_rgba(232,49,42,0.35)] hover:bg-[#d12822] hover:border-[#d12822]"
                              : "text-muted-foreground/50 border-transparent hover:text-[#e8312a] hover:bg-[#e8312a]/10"
                        }`}
                        title={`${commentCount} comment${commentCount !== 1 ? "s" : ""}`}
                      >
                        <MessageCircle className="w-4 h-4" />
                        {commentCount > 0 && (
                          <>
                            <span className="text-[11px] font-bold tabular-nums">{commentCount}</span>
                            {!isExpanded && (
                              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#e8312a] rounded-full ring-2 ring-background animate-pulse" />
                            )}
                          </>
                        )}
                      </button>

                      {/* Claim — always visible on active unclaimed */}
                      {subTab === "active" && !isClaimed && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); claimMutation.mutate(article.id); }}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors text-[11px] font-semibold"
                          title="I will write this up"
                        >
                          <Flag className="w-3.5 h-3.5" />
                          Claim
                        </button>
                      )}

                      {/* Dismiss — always visible on active, no confirmation, optimistic */}
                      {subTab === "active" && !isClaimed && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismissMutation.mutate(article.id); }}
                          disabled={dismissMutation.isPending && dismissMutation.variables === article.id}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 active:bg-red-500/30 active:scale-95 transition-all duration-100 text-[11px] font-semibold disabled:opacity-50 disabled:cursor-wait"
                          title="Dismiss for all users"
                        >
                          <X className="w-3.5 h-3.5" />
                          Dismiss
                        </button>
                      )}

                      {/* B-Sides tab: admin-only restore button on each row */}
                      {subTab === "bsides" && isAdmin && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); unbsideMutation.mutate(article.id); }}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors text-[11px] font-semibold"
                          title="Restore to Active"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Restore
                        </button>
                      )}

                      {/* Overflow menu for secondary actions */}
                      {subTab === "active" && !isClaimed && (
                        <OverflowMenuWrapper
                          open={menuOpenFor === article.id}
                          onToggle={() => { setMenuOpenFor(menuOpenFor === article.id ? null : article.id); setConfirmDismiss(null); setConfirmIrrelevant(null); }}
                        >
                              {/* Please Write — admin only */}
                              {isAdmin && !isPinned && (
                                <button
                                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); pinMutation.mutate(article.id); setMenuOpenFor(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[#e8312a] hover:bg-[#e8312a]/15 transition-colors border-b border-border/20"
                                >
                                  <Pin className="w-3.5 h-3.5" /> Please Write
                                </button>
                              )}
                              {/* Covered — hidden if already covered */}
                              {!article.covered && !isWritten && (
                                <button
                                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); markWrittenMutation.mutate(article.id); setMenuOpenFor(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-emerald-400 hover:bg-emerald-500/15 transition-colors border-b border-border/20"
                                >
                                  <BookCheck className="w-3.5 h-3.5" /> Already Covered
                                </button>
                              )}
                              {/* B-Side — admin-only low-priority watch list (28d) */}
                              {isAdmin && !article.bsidedAt && (
                                <button
                                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); bsideMutation.mutate(article.id); setMenuOpenFor(null); }}
                                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-purple-400 hover:bg-purple-500/15 transition-colors border-b border-border/20"
                                  title="Move to B-Sides for later (auto-removed after 28 days)"
                                >
                                  <Star className="w-3.5 h-3.5" /> B-Side
                                </button>
                              )}
                              {/* Irrelevant */}
                              {confirmIrrelevant === article.id ? (
                                <div className="px-3 py-2 space-y-1">
                                  <div className="text-[10px] text-orange-400 font-medium">Mark irrelevant &amp; train filter?</div>
                                  <div className="flex gap-1">
                                    <button onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); irrelevantMutation.mutate({ articleId: article.id, title: article.title, site: article.site }); setMenuOpenFor(null); setConfirmIrrelevant(null); }} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-orange-500/20 text-orange-400">Yes</button>
                                    <button onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmIrrelevant(null); }} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-muted/50 text-muted-foreground">No</button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmIrrelevant(article.id); }}
                                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground hover:bg-muted/30 hover:text-orange-400 transition-colors"
                                >
                                  <Ban className="w-3.5 h-3.5" /> Irrelevant
                                </button>
                              )}
                        </OverflowMenuWrapper>
                      )}

                      {/* Score */}
                      <div className="relative group/score flex flex-col items-center gap-0.5">
                        <span
                          className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-black cursor-help"
                          style={{ background: scoreColor(article.score).bg, color: scoreColor(article.score).text }}
                        >
                          {article.score}
                        </span>
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider">score</span>
                        <div className="absolute bottom-full right-0 mb-2 px-3 py-2 rounded-lg bg-popover border border-border text-xs text-popover-foreground shadow-xl w-52 leading-relaxed pointer-events-none opacity-0 group-hover/score:opacity-100 transition-opacity z-20">
                          <div className="font-semibold mb-1">Relevance Score: {article.score}/10</div>
                          <div>{article.siteCount} site{article.siteCount !== 1 ? "s" : ""} covered this topic. Higher = more industry interest.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </a>
                )}

                {/* Editor-brief detail panel and comment thread are suppressed when
                    the row is a collapsed-claimed row, even if isExpanded is true
                    (auto-expand for editor briefs runs on first render and would
                    otherwise leak the brief panel through the claim collapse). */}
                {isExpanded && !(isClaimed && subTab === "active" && !expandedClaims.has(article.id)) && (article.brief_markdown || article.summary || article.sources || article.open_questions || article.suggested_headlines || article.attachments) && (
                  <EditorBriefDetail article={article} />
                )}

                {/* Expanded comment thread */}
                {isExpanded && !(isClaimed && subTab === "active" && !expandedClaims.has(article.id)) && me?.username && (
                  <div className="border-t border-border/30">
                    <CommentThread articleId={article.id} currentUser={me.username} />
                  </div>
                )}

                {/* Group footer: "N more covering [Product]" */}
                {isGroupLead && (
                  <div className="border-t border-border/30">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setExpandedGroups(prev => {
                          const n = new Set(prev);
                          if (n.has(groupKey!)) n.delete(groupKey!); else n.add(groupKey!);
                          return n;
                        });
                      }}
                      className="w-full flex items-center justify-between px-5 py-2 text-[11px] text-muted-foreground hover:bg-muted/20 transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-blue-500/15 text-blue-300 font-bold text-[10px]">
                          +{groupExtras.length}
                        </span>
                        <span>
                          more covering <span className="font-semibold text-foreground">{groupLabel}</span>
                          <span className="ml-2 text-muted-foreground/70">
                            {Array.from(new Set(groupExtras.map(a => SITE_CONFIG[a.site]?.label ?? a.site))).slice(0, 4).join(" · ")}
                            {new Set(groupExtras.map(a => a.site)).size > 4 ? "…" : ""}
                          </span>
                        </span>
                      </span>
                      <span className="text-blue-300 font-semibold">
                        {groupIsExpanded ? "Hide" : "Show"}
                      </span>
                    </button>
                    {groupIsExpanded && (
                      <div className="bg-muted/10 border-t border-border/20 divide-y divide-border/20">
                        {groupExtras.map(extra => {
                          const es = SITE_CONFIG[extra.site];
                          const eColor = readableOnDark(es?.color ?? "#6b7280");
                          const eLabel = es?.label ?? extra.site;
                          return (
                            <a
                              key={extra.id}
                              href={extra.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`flex items-center gap-3 px-5 py-2 hover:bg-muted/30 transition-colors ${extra.covered ? "opacity-60" : ""}`}
                            >
                              <span
                                className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{ background: `${eColor}20`, color: eColor }}
                              >
                                {eLabel}
                              </span>
                              <span className="flex-1 min-w-0 text-[13px] text-foreground/90 truncate group-hover:text-foreground">
                                {extra.title}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {relativeTime(extra.published_at)}
                              </span>
                              <button
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismissMutation.mutate(extra.id); }}
                                disabled={dismissMutation.isPending && dismissMutation.variables === extra.id}
                                title="Dismiss"
                                className="shrink-0 p-1 rounded text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        )}
        </>}
      </div>

      {/* Press release viewer modal */}
      {openPressId !== null && (
        <PressReleaseModal id={openPressId} onClose={() => setOpenPressId(null)} />
      )}
    </div>
  );
}

// ─── Press release modal ────────────────────────────────────────────────
// ─── Trending & Emerging tab (Reddit hot posts) ──────────────────────────────────
function EditorBriefDetail({ article }: { article: DiscoveryArticle }) {
  const extras = parseEditorBriefExtras(article);
  const hasAttachments = extras.attachments.length > 0;
  const hasHeadlines = extras.suggestedHeadlines.length > 0;
  const hasQuestions = extras.openQuestions.length > 0;
  const hasSources = extras.sources.length > 0;
  return (
    <div className="border-t border-border/30 bg-muted/10 px-5 py-4 space-y-4">
      {article.brief_markdown && (
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Brief</h4>
          <div className="text-sm leading-relaxed text-foreground/90">
            <LightweightMarkdown source={article.brief_markdown} />
          </div>
        </section>
      )}
      {article.suggested_word_count && (
        <section className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/80">Suggested length:</span> {article.suggested_word_count} words
        </section>
      )}
      {hasHeadlines && (
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Suggested headlines</h4>
          <ul className="space-y-1">
            {extras.suggestedHeadlines.map((h, i) => (
              <li key={i} className="text-sm text-foreground/90 flex gap-2">
                <span className="text-muted-foreground shrink-0">{i + 1}.</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasQuestions && (
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Open questions</h4>
          <ul className="space-y-1 list-disc pl-5">
            {extras.openQuestions.map((q, i) => (
              <li key={i} className="text-sm text-foreground/90">{q}</li>
            ))}
          </ul>
        </section>
      )}
      {hasSources && (
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Sources</h4>
          <ul className="space-y-1 list-disc pl-5">
            {extras.sources.map((s, i) => (
              <li key={i} className="text-sm">
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline">{s.title}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasAttachments && (
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Attachments</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {extras.attachments.map((att, i) => (
              <a
                key={i}
                href={att.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md border border-border/40 bg-card/50 overflow-hidden hover:border-[#e8312a]/40 transition-colors"
              >
                {att.type === "image" ? (
                  <img src={att.url} alt={att.caption || ""} loading="lazy" className="w-full h-32 object-cover" />
                ) : (
                  <div className="h-32 flex items-center justify-center bg-muted/30 text-muted-foreground text-xs">
                    {att.type === "pdf" ? "PDF" : (att.type || "file").toUpperCase()}
                  </div>
                )}
                {(att.caption || att.credit) && (
                  <div className="p-2 text-[11px] leading-relaxed">
                    {att.caption && <div className="text-foreground/90">{att.caption}</div>}
                    {att.credit && (
                      <div className="text-muted-foreground mt-0.5">
                        Credit: {att.credit_url ? (
                          <a href={att.credit_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-blue-400 hover:underline">{att.credit}</a>
                        ) : att.credit}
                      </div>
                    )}
                  </div>
                )}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LightweightMarkdown({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let listItems: JSX.Element[] = [];
  let listType: "ul" | "ol" | null = null;
  let paraLines: string[] = [];

  function inline(s: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > lastIdx) parts.push(s.slice(lastIdx, m.index));
      const tok = m[0];
      if (tok.startsWith("**"))      parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) parts.push(<code key={key++} className="px-1 py-0.5 rounded bg-muted/40 text-xs">{tok.slice(1, -1)}</code>);
      else if (tok.startsWith("[")) {
        const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (lm) parts.push(<a key={key++} href={lm[2]} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{lm[1]}</a>);
      } else                         parts.push(<em key={key++}>{tok.slice(1, -1)}</em>);
      lastIdx = m.index + tok.length;
    }
    if (lastIdx < s.length) parts.push(s.slice(lastIdx));
    return parts;
  }

  const flushList = () => {
    if (listItems.length) {
      const Tag = listType === "ol" ? "ol" : "ul";
      blocks.push(
        <Tag key={`list-${blocks.length}`} className={`${listType === "ol" ? "list-decimal" : "list-disc"} pl-6 space-y-0.5 my-2`}>
          {listItems}
        </Tag>
      );
      listItems = [];
      listType = null;
    }
  };
  const flushPara = () => {
    if (paraLines.length) {
      blocks.push(<p key={`para-${blocks.length}`} className="my-2 leading-relaxed">{inline(paraLines.join(" "))}</p>);
      paraLines = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const li = line.match(/^\s*[-*]\s+(.+)$/);
    const oli = line.match(/^\s*\d+\.\s+(.+)$/);
    if (h2) { flushPara(); flushList(); blocks.push(<h3 key={blocks.length} className="text-base font-bold text-foreground mt-3 mb-1">{h2[1]}</h3>); continue; }
    if (h3) { flushPara(); flushList(); blocks.push(<h4 key={blocks.length} className="text-sm font-semibold text-foreground mt-2 mb-1">{h3[1]}</h4>); continue; }
    if (li) { flushPara(); if (listType && listType !== "ul") flushList(); listType = "ul"; listItems.push(<li key={listItems.length}>{inline(li[1])}</li>); continue; }
    if (oli) { flushPara(); if (listType && listType !== "ol") flushList(); listType = "ol"; listItems.push(<li key={listItems.length}>{inline(oli[1])}</li>); continue; }
    flushList();
    paraLines.push(line);
  }
  flushPara();
  flushList();

  return <>{blocks}</>;
}

function SignalBadge({ signal }: { signal: "breaking" | "leak" | "rumour" }) {
  const cfg = signal === "leak"     ? { label: "LEAK",     cls: "bg-red-500/20 text-red-300 border-red-500/40" }
           : signal === "breaking" ? { label: "BREAKING", cls: "bg-orange-500/20 text-orange-300 border-orange-500/40" }
           :                         { label: "RUMOUR",   cls: "bg-purple-500/20 text-purple-300 border-purple-500/40" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border ${cfg.cls} text-[9px] font-bold tracking-wider shrink-0`}>
      {cfg.label}
    </span>
  );
}

// Title-keyword filters management tab. Admins can add/remove keywords here;
// any article whose title contains the keyword (whole-word, case-insensitive)
// is auto-hidden from Active and surfaced in Dismissed with a small badge.
function FilterKeywordsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newKeyword, setNewKeyword] = useState("");
  const { data: keywords = [], isLoading } = useQuery<{ id: number; keyword: string; created_at: string; created_by: string | null }[]>({
    queryKey: ["/api/filter-keywords"],
    queryFn: () => apiRequest("GET", "/api/filter-keywords").then(r => r.json()),
  });
  const addMut = useMutation({
    mutationFn: (keyword: string) => apiRequest("POST", "/api/filter-keywords", { keyword }).then(async r => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || `Failed (${r.status})`);
      }
      return r.json();
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/filter-keywords"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      setNewKeyword("");
      toast({ title: "Keyword added" });
    },
    onError: (e: any) => toast({ title: "Could not add", description: e.message, variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/filter-keywords/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/filter-keywords"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Keyword removed" });
    },
  });
  return (
    <div className="max-w-2xl mx-auto py-2 space-y-4">
      <div className="rounded-lg border border-border/40 bg-card/40 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold mb-1">Title keyword filters</h3>
          <p className="text-xs text-muted-foreground">
            Articles whose titles contain any of these keywords (whole-word, case-insensitive) are auto-hidden from Active and shown in Dismissed.
          </p>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); const k = newKeyword.trim(); if (k) addMut.mutate(k); }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            placeholder="Add keyword (e.g. axpona, munich high end, ces 2026)"
            maxLength={100}
            className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
          <button
            type="submit"
            disabled={!newKeyword.trim() || addMut.isPending}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </form>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-4 text-center">Loading...</div>
        ) : keywords.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border/40 rounded-md">
            No filter keywords yet. Add one above.
          </div>
        ) : (
          <ul className="space-y-1">
            {keywords.map(k => (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-md border border-border/30 bg-muted/20">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{k.keyword}</span>
                  <span className="text-[10px] text-muted-foreground">
                    Added {new Date(k.created_at).toLocaleDateString()} {k.created_by ? `by ${k.created_by}` : ""}
                  </span>
                </div>
                <button
                  onClick={() => { if (confirm(`Remove filter keyword "${k.keyword}"?`)) delMut.mutate(k.id); }}
                  className="text-[11px] font-medium px-2 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrendingTab() {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Local set of just-dismissed IDs — filtered out immediately on click
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(new Set());

  const dismissMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", "/api/trending/dismiss", { id }).then(r => r.json()),
  });
  const coveredMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", "/api/trending/covered", { id }).then(r => r.json()),
  });

  const [forceKey, setForceKey] = useState(0);
  const { data, isLoading, isFetching, refetch } = useQuery<{
    posts: Array<{
      id: string;
      title: string;
      url: string;
      permalink: string;
      subreddit: string;
      score: number;
      numComments: number;
      createdAt: string;
      author: string;
      thumbnail: string | null;
      selftext: string;
      signal?: "breaking" | "leak" | "rumour" | null;
      signalReason?: string;
    }>;
    cachedAt: string | null;
  }>({
    queryKey: ["/api/trending", forceKey],
    queryFn: () => apiRequest("GET", forceKey > 0 ? `/api/trending?force=1` : `/api/trending`).then(r => r.json()),
    refetchInterval: 30 * 60 * 1000,
  });

  const forceRefresh = () => { setForceKey(k => k + 1); };

  const [subFilter, setSubFilter] = useState<string>("all");
  const posts = (data?.posts || []).filter(p => !localDismissed.has(p.id));
  const subs = Array.from(new Set(posts.map(p => p.subreddit)));
  const filtered = subFilter === "all" ? posts : posts.filter(p => p.subreddit === subFilter);

  const relTime = (iso: string) => {
    const d = new Date(iso).getTime();
    const diffH = Math.round((Date.now() - d) / 3600000);
    if (diffH < 1) return `${Math.round((Date.now() - d) / 60000)}m`;
    if (diffH < 24) return `${diffH}h`;
    return `${Math.round(diffH / 24)}d`;
  };

  const cachedAt = data?.cachedAt ? new Date(data.cachedAt) : null;
  const ageMin = cachedAt ? Math.round((Date.now() - cachedAt.getTime()) / 60000) : 0;

  const proxied = (u: string | null) => u ? `/api/reddit-image?url=${encodeURIComponent(u)}` : null;
  const externalHost = (p: { url: string; permalink: string }) => {
    if (!p.url || p.url === p.permalink || p.url.includes("reddit.com")) return null;
    try {
      return new URL(p.url).hostname.replace("www.", "");
    } catch {
      return null;
    }
  };
  const formatScore = (s: number) => s >= 1000 ? `${(s / 1000).toFixed(1)}k` : String(s);

  const handleDismiss = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Optimistic: mark locally so it disappears immediately
    setLocalDismissed(prev => { const n = new Set(prev); n.add(id); return n; });
    dismissMutation.mutate(id);
    toast({ title: "Dismissed", description: "Won't show again" });
  };

  const handleCovered = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLocalDismissed(prev => { const n = new Set(prev); n.add(id); return n; });
    coveredMutation.mutate(id);
    toast({ title: "Marked as covered", description: "StereoNET has written about this" });
  };

  return (
    <div className="space-y-2">
      {/* Slim header */}
      <div className="flex items-center justify-between gap-3 flex-wrap pb-1">
        <div className="flex items-center gap-2 min-w-0">
          <Flame className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-sm font-semibold text-foreground">Trending & Emerging</span>
          <span className="text-[10px] text-muted-foreground truncate">
            Product news, launches, leaks & rumours from Reddit · {filtered.length} posts{cachedAt ? ` · cached ${ageMin}m ago` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={subFilter}
            onChange={e => setSubFilter(e.target.value)}
            className="text-xs bg-muted border border-border rounded-md px-2 py-1 text-foreground outline-none"
          >
            <option value="all">All subs</option>
            {subs.map(s => <option key={s} value={s}>r/{s}</option>)}
          </select>
          <button
            onClick={forceRefresh}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-muted hover:bg-muted/70 text-foreground disabled:opacity-50"
            title="Force refresh from Reddit"
          >
            <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading trending posts…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">No trending posts</div>
      ) : (
        <div className="space-y-2">
          {/* Heads-Up banner — surfaces leak / breaking / rumour posts at the top */}
          {(() => {
            const signals = filtered.filter(p => p.signal);
            if (signals.length === 0) return null;
            const topSignals = signals.slice(0, 3);
            return (
              <div className="relative rounded-lg border border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-orange-500/5 to-transparent p-3 mb-2">
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wide">
                    Heads-Up
                  </span>
                  <span className="text-xs text-muted-foreground">{signals.length} potential {signals.length === 1 ? "lead" : "leads"} detected</span>
                </div>
                <div className="space-y-1.5">
                  {topSignals.map(p => (
                    <a
                      key={`signal-${p.id}`}
                      href={p.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-amber-500/10 transition-colors group"
                    >
                      <SignalBadge signal={p.signal!} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-foreground group-hover:text-amber-300 transition-colors leading-snug">
                          {p.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          r/{p.subreddit} · {relTime(p.createdAt)} ago · {p.numComments} comments
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}
          {filtered.map(post => (
            <a
              key={post.id}
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-border bg-card hover:bg-muted/20 hover:border-orange-500/30 transition-colors px-4 py-3 group"
            >
              <div className="flex gap-4 items-start">
                {/* Upvote score */}
                <div className="flex flex-col items-center justify-center shrink-0 w-10 text-center pt-1">
                  <ArrowUp className="w-4 h-4 text-orange-400" />
                  <span className="text-sm font-bold text-foreground tabular-nums">{formatScore(post.score)}</span>
                </div>
                {/* Thumbnail */}
                {post.thumbnail ? (
                  <img
                    src={proxied(post.thumbnail) || ""}
                    alt=""
                    data-fallback={post.thumbnail}
                    className="w-20 h-20 object-cover rounded-md shrink-0 bg-muted"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      const img = e.currentTarget as HTMLImageElement;
                      const fb = img.getAttribute("data-fallback");
                      if (fb && img.src !== fb) { img.src = fb; return; }
                      img.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-20 h-20 rounded-md shrink-0 bg-muted/50 flex items-center justify-center">
                    <Flame className="w-6 h-6 text-orange-500/30" />
                  </div>
                )}
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                    <span className="font-semibold text-orange-400">r/{post.subreddit}</span>
                    <span>·</span>
                    <span>u/{post.author}</span>
                    <span>·</span>
                    <span>{relTime(post.createdAt)} ago</span>
                    {externalHost(post) && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1 truncate max-w-[200px]">
                          <ExternalLink className="w-3 h-3" />
                          {externalHost(post)}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="text-[15px] font-semibold text-foreground group-hover:text-orange-400 transition-colors line-clamp-2 leading-snug">
                    {post.signal && <span className="inline-block mr-1.5 align-middle"><SignalBadge signal={post.signal} /></span>}
                    {post.title}
                  </div>
                  {post.selftext && (
                    <div className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{post.selftext}</div>
                  )}
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MessagesSquare className="w-3 h-3" />
                      {post.numComments} comments
                    </span>
                  </div>
                </div>
                {/* Action buttons */}
                <div className="shrink-0 flex items-center gap-1.5 self-center">
                  <button
                    onClick={(e) => handleCovered(e, post.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors"
                    title="StereoNET has already covered this"
                  >
                    <BookCheck className="w-3 h-3" />
                    Covered
                  </button>
                  <button
                    onClick={(e) => handleDismiss(e, post.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors"
                    title="Dismiss — won't appear again"
                  >
                    <X className="w-3 h-3" />
                    Dismiss
                  </button>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Top Picks panel ─────────────────────────────────────────────────────
function TopPicksPanel({ articles }: { articles: any[] }) {
  const [expanded, setExpanded] = useState(true);

  const { data } = useQuery<{
    enabled: boolean;
    date?: string | null;
    generatedAt?: string | null;
    examined?: number;
    picks?: Array<{ articleId: number; title: string; site: string; rationale: string; angle: string; score: number }>;
  }>({
    queryKey: ["/api/top-picks"],
    queryFn: () => apiRequest("GET", "/api/top-picks").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000,
  });

  if (!data?.enabled || !data?.picks || data.picks.length === 0) return null;

  const articleMap = new Map(articles.map(a => [a.id, a]));
  const visiblePicks = data.picks.filter(p => articleMap.has(p.articleId));
  if (visiblePicks.length === 0) return null;

  const generatedAt = data.generatedAt ? new Date(data.generatedAt) : null;
  const ageMins = generatedAt ? Math.round((Date.now() - generatedAt.getTime()) / 60000) : 0;
  const ageLabel = ageMins < 60 ? `${ageMins}m ago` : ageMins < 1440 ? `${Math.round(ageMins / 60)}h ago` : `${Math.round(ageMins / 1440)}d ago`;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.04] to-orange-500/[0.04] overflow-hidden mb-4">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-amber-500/5 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-foreground">Top Picks Today</span>
          <span className="text-[10px] text-muted-foreground">AI-curated · {visiblePicks.length} pick{visiblePicks.length === 1 ? "" : "s"} · updated {ageLabel}</span>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-border/40">
          {visiblePicks.map((pick, i) => {
            const art = articleMap.get(pick.articleId);
            if (!art) return null;
            return (
              <div key={pick.articleId} className="px-5 py-3.5 flex gap-4">
                <div className="shrink-0 w-7 h-7 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center text-sm font-bold">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <a
                    href={art.site === "email_pressroom" ? "#" : art.url}
                    target={art.site === "email_pressroom" ? undefined : "_blank"}
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-foreground hover:text-amber-400 transition-colors"
                  >
                    {pick.title}
                  </a>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {pick.site} · score {pick.score}/10
                  </div>
                  <p className="text-xs text-foreground/85 mt-2 leading-relaxed">
                    {pick.rationale}
                  </p>
                  <div className="mt-2 flex items-start gap-1.5 text-xs">
                    <Star className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-foreground/70 italic">{pick.angle}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Overflow menu that auto-positions based on available space ─────────────────────────────────────
function OverflowMenuWrapper({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open || !btnRef.current) { setPosition(null); return; }
    const rect = btnRef.current.getBoundingClientRect();
    const menuHeight = 140; // approx, 2-3 items
    const menuWidth = 192; // w-48
    const vh = window.innerHeight;
    const openUp = rect.bottom + menuHeight + 8 > vh;
    const top = openUp ? rect.top - menuHeight - 4 : rect.bottom + 4;
    const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
    setPosition({ top, left: Math.max(8, left) });
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
        className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && position && (
        <div
          data-menu
          className="fixed w-48 rounded-lg bg-popover border border-border shadow-2xl py-1 overflow-hidden"
          style={{ top: position.top, left: position.left, zIndex: 9999 }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function PressReleaseModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useQuery<{
    id: number;
    title: string;
    receivedAt: string;
    bodyHtml: string;
    bodyText: string;
    senderName: string;
    senderEmail: string;
    attachments: { name: string; url: string; size: number }[];
  }>({
    queryKey: ["/api/press-release", id],
    queryFn: () => apiRequest("GET", `/api/press-release/${id}`).then(r => r.json()),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fmtSize = (bytes: number) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-purple-400 mb-1">
              <Mail className="w-3 h-3" />
              Press Inbox
            </div>
            <h2 className="text-lg font-semibold text-foreground leading-snug mb-2">
              {data?.title || "Loading\u2026"}
            </h2>
            {data && (
              <div className="text-xs text-muted-foreground">
                From {data.senderName}{data.senderEmail ? ` <${data.senderEmail}>` : ""}
                {" \u00b7 "}
                {new Date(data.receivedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Attachments */}
        {data && data.attachments.length > 0 && (
          <div className="px-6 py-3 border-b border-border bg-purple-500/5">
            <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
              <Paperclip className="w-3.5 h-3.5" />
              Attachments ({data.attachments.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {data.attachments.map((att, i) => (
                <a
                  key={i}
                  href={att.url}
                  download={att.name}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-purple-500/10 hover:bg-purple-500/20 border border-purple-400/30 text-xs text-foreground transition-colors"
                >
                  <Download className="w-3.5 h-3.5 text-purple-400" />
                  <span className="font-medium">{att.name}</span>
                  {att.size > 0 && (
                    <span className="text-muted-foreground">{fmtSize(att.size)}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading && (
            <div className="text-sm text-muted-foreground">Loading email\u2026</div>
          )}
          {data && data.bodyHtml ? (
            <div
              className="press-email-body text-sm"
              dangerouslySetInnerHTML={{ __html: data.bodyHtml }}
            />
          ) : data && data.bodyText ? (
            <pre className="text-sm whitespace-pre-wrap font-sans">{data.bodyText}</pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
