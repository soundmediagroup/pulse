import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { FileText, ExternalLink, Calendar, Eye, Users, User, TrendingUp, Flame, Clock } from "lucide-react";

// Thumbnail with automatic og:image fallback fetch for new articles
function ArticleThumbnail({ image, url }: { image?: string; url: string }) {
  const [resolvedImage, setResolvedImage] = useState<string | undefined>(image);

  useEffect(() => {
    if (image) { setResolvedImage(image); return; }
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/og-image?url=${encodeURIComponent(url)}`, { credentials: "include" });
        const data = await r.json();
        if (!cancelled && data.image) setResolvedImage(data.image);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [image, url]);

  if (resolvedImage) {
    return (
      <img
        src={resolvedImage}
        alt=""
        loading="lazy"
        className="w-36 h-24 sm:w-48 sm:h-32 object-cover rounded-xl bg-muted shrink-0"
        onError={() => setResolvedImage(undefined)}
      />
    );
  }
  return (
    <div className="w-36 h-24 sm:w-48 sm:h-32 rounded-xl bg-muted/50 flex items-center justify-center shrink-0">
      <FileText className="w-8 h-8 text-muted-foreground/20" />
    </div>
  );
}

interface MyArticle {
  title: string;
  url: string;
  published_date: string;
  type: string | null;
  brands: string | null;
  author?: string;
}

const TYPE_COLORS: Record<string, string> = {
  review: "#ef4444",
  news: "#f59e0b",
  feature: "#22c55e",
  opinion: "#a855f7",
};

type ViewMode = "recent" | "popular";
type PopularPeriod = "today" | "week" | "month" | "year";

function daysSince(dateStr: string): number {
  // Compare calendar dates in local timezone
  const parts = dateStr.split("-").map(Number);
  const pubDate = new Date(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = today.getTime() - pubDate.getTime();
  return Math.max(0, Math.round(diffMs / 86400000));
}

function daysSinceForVpd(dateStr: string): number {
  // For views-per-day calc, minimum 1 to avoid division by zero
  return Math.max(1, daysSince(dateStr));
}

function relativeDate(dateStr: string): string {
  const diff = daysSince(dateStr);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) return `${Math.floor(diff / 7)} weeks ago`;
  const parts = dateStr.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function formatHits(n: number): string {
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString();
}

function dateForPeriod(period: PopularPeriod): string {
  const now = new Date();
  switch (period) {
    case "today": return now.toISOString().slice(0, 10);
    case "week": { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); }
    case "month": { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }
    case "year": return `${now.getFullYear()}-01-01`;
  }
}

function trendingBg(vpd: number, avgVpd: number): string {
  if (vpd <= 0 || avgVpd <= 0) return "transparent";
  const ratio = vpd / avgVpd;
  if (ratio >= 3) return "rgba(34, 197, 94, 0.12)";
  if (ratio >= 2) return "rgba(34, 197, 94, 0.08)";
  if (ratio >= 1.5) return "rgba(34, 197, 94, 0.05)";
  if (ratio < 0.3) return "rgba(239, 68, 68, 0.10)";
  if (ratio < 0.5) return "rgba(239, 68, 68, 0.06)";
  return "transparent";
}

export default function MyArticles() {
  const [showAll, setShowAll] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("recent");
  const [popularPeriod, setPopularPeriod] = useState<PopularPeriod>("week");

  const { data: myArticles = [], isLoading: myLoading } = useQuery<MyArticle[]>({
    queryKey: ["/api/my-articles"],
    queryFn: () => apiRequest("GET", "/api/my-articles").then(r => r.json()),
  });

  const { data: allArticles = [], isLoading: allLoading } = useQuery<MyArticle[]>({
    queryKey: ["/api/stereonet-articles"],
    queryFn: () => apiRequest("GET", "/api/stereonet-articles").then(r => r.json()),
  });

  const articles = showAll ? allArticles : myArticles;
  const isLoading = showAll ? allLoading : myLoading;

  const { data: myStats } = useQuery<{ author: string } | null>({
    queryKey: ["/api/author-stats"],
    queryFn: () => apiRequest("GET", "/api/author-stats").then(r => r.json()),
  });

  const { data: hitCounts = {} } = useQuery<Record<string, { hits: number; image?: string }>>({
    queryKey: ["/api/hit-counts"],
    queryFn: () => apiRequest("GET", "/api/hit-counts").then(r => r.json()),
  });

  function getHitData(url: string) {
    const slug = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
    const lastSeg = slug.split("/").pop() || slug;
    return hitCounts[url] ?? hitCounts[slug] ?? hitCounts[lastSeg];
  }

  // Enrich articles with hit data and vpd
  const enriched = useMemo(() => articles.map(a => {
    const hc = getHitData(a.url);
    const vpd = hc?.hits ? hc.hits / daysSinceForVpd(a.published_date) : 0;
    return { ...a, hc, vpd };
  }), [articles, hitCounts]);

  const avgVpd = enriched.length > 0
    ? enriched.reduce((sum, a) => sum + a.vpd, 0) / enriched.length
    : 0;
  const trendingThreshold = Math.max(avgVpd * 1.5, 10);

  // Filter and sort based on view mode
  const displayArticles = useMemo(() => {
    if (viewMode === "recent") return enriched;

    const cutoff = dateForPeriod(popularPeriod);
    const filtered = enriched.filter(a => a.published_date >= cutoff);
    return [...filtered].sort((a, b) => {
      const aHits = a.hc?.hits || 0;
      const bHits = b.hc?.hits || 0;
      return bHits - aHits;
    });
  }, [enriched, viewMode, popularPeriod]);

  // Group by month for recent view
  const grouped = useMemo(() => {
    const map = new Map<string, typeof displayArticles>();
    for (const a of displayArticles) {
      const d = new Date(a.published_date + "T00:00:00Z");
      const key = d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return map;
  }, [displayArticles]);

  const popularPeriods: { key: PopularPeriod; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "year", label: "This Year" },
  ];

  function renderArticle(article: typeof displayArticles[0], rank?: number) {
    const isTrending = article.vpd >= trendingThreshold;
    const isHot = article.vpd >= trendingThreshold * 2;
    const bg = trendingBg(article.vpd, avgVpd);

    return (
      <a
        key={article.url}
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-5 p-4 sm:p-5 rounded-2xl transition-all group border border-border/50 hover:border-border"
        style={{ background: bg }}
      >
        {/* Rank for popular view */}
        {rank != null && (
          <div className={`text-3xl font-black tabular-nums shrink-0 w-10 text-center ${
            rank <= 3 ? "text-[#eab308]" : "text-muted-foreground/30"
          }`}>
            {rank}
          </div>
        )}

        {/* Thumbnail */}
        <ArticleThumbnail image={article.hc?.image} url={article.url} />

        {/* Content */}
        <div className="min-w-0 flex-1 py-1">
          <div className="flex items-start gap-2">
            <h3 className="text-base sm:text-xl font-bold text-foreground group-hover:text-[#eab308] transition-colors line-clamp-2 flex-1 leading-snug">
              {article.title}
            </h3>
            <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0 mt-1 opacity-0 group-hover:opacity-60 transition-opacity" />
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-2.5 mt-2 flex-wrap">
            {showAll && article.author && (
              <span className="text-xs font-semibold text-[#eab308]">{article.author}</span>
            )}
            <span className="text-xs text-muted-foreground">{relativeDate(article.published_date)}</span>
            {article.type && (
              <span
                className="px-2 py-0.5 rounded text-[11px] font-medium"
                style={{
                  background: (TYPE_COLORS[article.type] || "#6b7280") + "20",
                  color: TYPE_COLORS[article.type] || "#6b7280",
                }}
              >
                {article.type}
              </span>
            )}
            {(isTrending || isHot) && (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${
                isHot ? "bg-green-500/15 text-green-400" : "bg-green-500/10 text-green-400"
              }`}>
                {isHot ? <Flame className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                {isHot ? "Hot" : "Trending"}
              </span>
            )}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4 mt-3">
            {article.hc?.hits != null && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#e8312a]/10 text-[#e8312a]">
                <Eye className="w-4 h-4" />
                <span className="text-base font-bold tabular-nums">{formatHits(article.hc.hits)}</span>
                <span className="text-[10px] font-normal opacity-60 ml-0.5">views</span>
              </div>
            )}
            {article.vpd > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50">
                <TrendingUp className="w-5 h-5 text-muted-foreground" />
                <span className="text-xl font-bold tabular-nums text-foreground">{Math.round(article.vpd)}</span>
                <span className="text-xs text-muted-foreground">views/day</span>
              </div>
            )}
          </div>
        </div>
      </a>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="p-3 sm:p-6 pb-16 mx-auto space-y-5" style={{ maxWidth: "1400px" }}>

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#eab308]/10 flex items-center justify-center">
              <FileText className="w-5 h-5 text-[#eab308]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">
                {showAll ? "All StereoNET Articles" : myStats?.author ? `${myStats.author}'s Articles` : "My Articles"}
              </h1>
              <p className="text-xs text-muted-foreground">
                {displayArticles.length} article{displayArticles.length !== 1 ? "s" : ""}
                {avgVpd > 0 && ` · avg ${Math.round(avgVpd)} views/day`}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAll(!showAll)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              showAll
                ? "bg-[#e8312a]/10 text-[#e8312a]"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {showAll ? <User className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
            {showAll ? "Show Mine" : "Show All Authors"}
          </button>
        </div>

        {/* View mode tabs */}
        <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-xl w-fit">
          <button
            onClick={() => setViewMode("recent")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              viewMode === "recent" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Clock className="w-4 h-4" />
            Recent
          </button>
          <button
            onClick={() => setViewMode("popular")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              viewMode === "popular" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Flame className="w-4 h-4" />
            Popular
          </button>
        </div>

        {/* Popular period sub-tabs */}
        {viewMode === "popular" && (
          <div className="flex items-center gap-1">
            {popularPeriods.map(p => (
              <button
                key={p.key}
                onClick={() => setPopularPeriod(p.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  popularPeriod === p.key
                    ? "bg-[#eab308]/10 text-[#eab308]"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading...</div>
        ) : displayArticles.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {viewMode === "popular" ? `No articles published ${popularPeriod === "today" ? "today" : `this ${popularPeriod}`}.` : "No articles found for your account."}
              </p>
            </CardContent>
          </Card>
        ) : viewMode === "popular" ? (
          /* Popular view — flat ranked list */
          <div className="space-y-2">
            {displayArticles.map((article, i) => renderArticle(article, i + 1))}
          </div>
        ) : (
          /* Recent view — grouped by month */
          [...grouped.entries()].map(([month, monthArticles]) => (
            <div key={month}>
              <div className="flex items-center gap-2 mb-3 px-1">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground">{month}</h2>
                <span className="text-xs text-muted-foreground/60">({monthArticles.length})</span>
              </div>
              <div className="space-y-2">
                {monthArticles.map(article => renderArticle(article))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
