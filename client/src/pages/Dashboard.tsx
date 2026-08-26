import { useState, useEffect, useRef, useMemo, Fragment } from "react";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RefreshCw, Newspaper, BarChart3, List, Sun, Moon,
  ExternalLink, Filter, TrendingUp, TrendingDown, Calendar, ChevronDown, Info, LogOut, Menu, X, Eye,
  Globe, Users, ArrowUpRight, ArrowDownRight, Minus, Flame, Briefcase,
  LayoutDashboard, Search, FileText, BarChart2, Server, ScrollText, Megaphone, MailOpen, Layers, Shield, Settings, ChevronRight
} from "lucide-react";
import { useHashLocation } from "wouter/use-hash-location";
import { useToast } from "@/hooks/use-toast";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  Title, Tooltip, Legend, Filler,
  type ChartOptions, type ChartData,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler);

// ─── Types ─────────────────────────────────────────────────────────────────
interface Article {
  id: number; site: string; title: string; url: string;
  publishedAt: string; publishedDate: string; contentType: string;
  categories: string; fetchedAt: string;
}
interface DailyRow {
  date: string; total: number;
  review: number; news: number; feature: number; opinion: number; unknown: number;
}
interface BreakdownRow { site: string; content_type: string; count: number; }
interface Stats {
  totalArticles: number; totalInRange: number; avgPerDay: number;
  topSite: { site: string; count: number } | null;
  typeTotals: { review: number; news: number; feature: number; opinion: number; unknown: number };
  lastRefresh: string | null; daysTracked: number;
}
interface SiteConfig { key: string; label: string; color: string; siteUrl?: string; }

// ─── Constants ──────────────────────────────────────────────────────────────
const CONTENT_TYPES = ["all", "review", "news", "feature", "opinion"] as const;
// SITE_URLS is now dynamically loaded from /api/sites — see useSites() hook below

const TYPE_COLORS: Record<string, string> = {
  review: "#e8312a",   // StereoNET red
  news:   "#f97316",   // orange
  feature:"#facc15",   // amber/gold
  opinion:"#fb923c",   // warm orange
  unknown:"#6b7280",
};
const TYPE_LABELS: Record<string, string> = {
  review: "Reviews", news: "News", feature: "Features", opinion: "Opinions", unknown: "Other",
};

function nDaysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

function relativeTime(iso: string) {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff <= 0) return "just now";
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 1440)}d ago`;
}

// ─── InfoTip ────────────────────────────────────────────────────────────────
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-center" style={{ verticalAlign: "middle" }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="ml-1.5 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Info"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute z-50 left-5 top-0 w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-xl p-3 text-xs leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

// ─── KPI Card ───────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = "text-red-400", icon: Icon }: {
  label: string; value: string | number; sub?: string; color?: string; icon: any;
}) {
  return (
    <Card data-testid={`kpi-${label.replace(/\s/g, "-").toLowerCase()}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// ─── Type Pill ──────────────────────────────────────────────────────────────
function TypePill({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
      style={{ background: `${color}20`, color }}
    >
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

// ─── Site Dot ───────────────────────────────────────────────────────────────
function SiteDot({ site, sites }: { site: string; sites: SiteConfig[] }) {
  const s = sites.find(s => s.key === site);
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: s?.color ?? "#94a3b8" }}>
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: s?.color ?? "#94a3b8" }} />
      {s?.label ?? site}
    </span>
  );
}

// ─── Daily Bar/Line Chart ────────────────────────────────────────────────────
function DailyChart({ daily, chartType, showByType, activeSite, sites }: {
  daily: DailyRow[]; chartType: "bar" | "line"; showByType: boolean;
  activeSite: string; sites: SiteConfig[];
}) {
  const labels = daily.map(d => {
    const dt = new Date(d.date + "T00:00:00");
    return dt.toLocaleDateString("en-AU", { month: "short", day: "numeric" });
  });

  const isDark = !document.documentElement.classList.contains("light");
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const labelColor = isDark ? "#94a3b8" : "#64748b";

  const siteColor = activeSite !== "all"
    ? (sites.find(s => s.key === activeSite)?.color ?? "#e8312a")
    : "#e8312a";

  const datasets = showByType
    ? (["review", "news", "feature", "opinion"] as const).map(type => ({
        label: TYPE_LABELS[type],
        data: daily.map(d => d[type] ?? 0),
        backgroundColor: `${TYPE_COLORS[type]}cc`,
        borderColor: TYPE_COLORS[type],
        borderWidth: chartType === "line" ? 2 : 0,
        borderRadius: chartType === "bar" ? 3 : 0,
        fill: chartType === "line",
        tension: 0.4,
        pointRadius: chartType === "line" ? 0 : undefined,
        pointHoverRadius: chartType === "line" ? 4 : undefined,
        stack: chartType === "bar" ? "stack" : undefined,
      }))
    : [{
        label: activeSite !== "all" ? sites.find(s => s.key === activeSite)?.label ?? "All sites" : "Total articles",
        data: daily.map(d => d.total),
        backgroundColor: chartType === "bar" ? `${siteColor}cc` : `${siteColor}20`,
        borderColor: siteColor,
        borderWidth: chartType === "line" ? 2.5 : 0,
        borderRadius: chartType === "bar" ? 4 : 0,
        fill: chartType === "line",
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
      }];

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: showByType,
        position: "top",
        labels: { color: labelColor, font: { size: 11 }, boxWidth: 12, padding: 16 },
      },
      tooltip: {
        backgroundColor: isDark ? "#1e2030" : "#ffffff",
        titleColor: isDark ? "#e2e8f0" : "#1e293b",
        bodyColor: isDark ? "#94a3b8" : "#64748b",
        borderColor: isDark ? "#334155" : "#e2e8f0",
        borderWidth: 1,
        padding: 10,
      },
    },
    scales: {
      x: {
        stacked: chartType === "bar" && showByType,
        grid: { display: false },
        ticks: { color: labelColor, font: { size: 10 }, maxTicksLimit: 15, maxRotation: 0 },
        border: { display: false },
      },
      y: {
        stacked: chartType === "bar" && showByType,
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: labelColor, font: { size: 10 }, precision: 0 },
        border: { display: false },
      },
    },
  };

  const data: ChartData<"bar"> = { labels, datasets: datasets as any };

  return chartType === "bar"
    ? <Bar data={data} options={options} />
    : <Line data={data as any} options={options as any} />;
}

// ─── Per-site breakdown chart ───────────────────────────────────────────────
function SiteBreakdownChart({ breakdown, sites }: { breakdown: BreakdownRow[]; sites: SiteConfig[] }) {
  const isDark = !document.documentElement.classList.contains("light");
  const labelColor = isDark ? "#94a3b8" : "#64748b";
  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";

  const siteKeys = sites.map(s => s.key);
  const types = ["review", "news", "feature", "opinion"];

  const datasets = types.map(type => ({
    label: TYPE_LABELS[type],
    data: siteKeys.map(site => {
      const row = breakdown.find(b => b.site === site && b.content_type === type);
      return row?.count ?? 0;
    }),
    backgroundColor: `${TYPE_COLORS[type]}cc`,
    borderColor: TYPE_COLORS[type],
    borderWidth: 0,
    borderRadius: 3,
    stack: "stack",
  }));

  const options: ChartOptions<"bar"> = {
    responsive: true, maintainAspectRatio: false,
    indexAxis: "y" as const,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: true, position: "top",
        labels: { color: labelColor, font: { size: 11 }, boxWidth: 12, padding: 16 },
      },
      tooltip: {
        backgroundColor: isDark ? "#1e2030" : "#ffffff",
        titleColor: isDark ? "#e2e8f0" : "#1e293b",
        bodyColor: isDark ? "#94a3b8" : "#64748b",
        borderColor: isDark ? "#334155" : "#e2e8f0",
        borderWidth: 1, padding: 10,
      },
    },
    scales: {
      x: {
        stacked: true, beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: labelColor, font: { size: 10 }, precision: 0 },
        border: { display: false },
      },
      y: {
        stacked: true,
        grid: { display: false },
        ticks: {
          color: labelColor, font: { size: 11 },
          callback: (_val: any, idx: number) => sites[idx]?.label ?? siteKeys[idx],
        },
        border: { display: false },
      },
    },
  };

  return <Bar data={{ labels: siteKeys, datasets }} options={options} />;
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeSite, setActiveSite] = useState("all");
  const [activeType, setActiveType] = useState("all");
  const [chartType, setChartType] = useState<"bar" | "line">("bar");
  const [showByType, setShowByType] = useState(false);
  const [dateRange, setDateRange] = useState(7);
  const [authorChartType, setAuthorChartType] = useState<"bar" | "line">("bar");
  const [heatmapView, setHeatmapView] = useState<"combined" | "persite">("combined");
  const [topicsFilter, setTopicsFilter] = useState<"overlap" | "exclusive">("overlap");
  const [authorPeriod, setAuthorPeriod] = useState<3 | 7 | 14 | 30>(30);
  const [isDark, setIsDark] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    document.documentElement.classList.toggle("light", !isDark);
  }, [isDark]);

  const fromDate = nDaysAgo(dateRange - 1);
  const toDate = today();
  // Scorecard: last 30 days vs prior 30 days
  const scorecardCurrentFrom = nDaysAgo(29);
  const scorecardCurrentTo = today();
  const scorecardPreviousFrom = nDaysAgo(59);
  const scorecardPreviousTo = nDaysAgo(30);

  const siteParam = activeSite !== "all" ? activeSite : undefined;
  const typeParam = activeType !== "all" ? activeType : undefined;

  const { data: sitesRaw = [] } = useQuery<SiteConfig[]>({
    queryKey: ["/api/sites"],
    queryFn: () => apiRequest("GET", "/api/sites").then(r => r.json()),
    staleTime: Infinity,
  });

  // Current user — used to gate the sidebar navigation links.
  const { data: me } = useQuery<{ username: string; role: string; redline_access: number; impersonating: string | null }>({
    queryKey: ["/api/admin/me"],
    queryFn: () => apiRequest("GET", "/api/admin/me").then(r => r.json()),
    staleTime: 300000,
  });

  const [hashLoc] = useHashLocation();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sites = [...sitesRaw].sort((a, b) => a.label.localeCompare(b.label));

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["/api/stats", activeSite, activeType, fromDate, toDate],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate, toDate });
      if (siteParam) params.set("site", siteParam);
      if (typeParam) params.set("contentType", typeParam);
      return apiRequest("GET", `/api/stats?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const { data: daily = [], isLoading: dailyLoading } = useQuery<DailyRow[]>({
    queryKey: ["/api/daily", activeSite, activeType, fromDate, toDate],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate, toDate });
      if (siteParam) params.set("site", siteParam);
      if (typeParam) params.set("contentType", typeParam);
      return apiRequest("GET", `/api/daily?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const { data: breakdown = [] } = useQuery<BreakdownRow[]>({
    queryKey: ["/api/breakdown", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/breakdown?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  // 48hr top author for marquee
  const author48hFrom = nDaysAgo(1);
  const { data: authors48h = [] } = useQuery<{ author: string; count: number }[]>({
    queryKey: ["/api/authors", author48hFrom, toDate],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate: author48hFrom, toDate });
      return apiRequest("GET", `/api/authors?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const authorFromDate = nDaysAgo(authorPeriod - 1);
  const { data: authors = [] } = useQuery<{ author: string; count: number }[]>({
    queryKey: ["/api/authors", authorFromDate, toDate],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate: authorFromDate, toDate });
      return apiRequest("GET", `/api/authors?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  // Hit counts
  const { data: hitCounts = {} } = useQuery<Record<string, { hits: number; image?: string }>>({
    queryKey: ["/api/hit-counts"],
    queryFn: () => apiRequest("GET", "/api/hit-counts").then(r => r.json()),
  });

  // Personal stats for logged-in user
  const { data: myStats } = useQuery<{ author: string; thisWeek: number; thisMonth: number; allTime: number; rank: number; totalAuthors: number; streak: number; firstMoverPct: number; latestArticle: { title: string; url: string; published_date: string } | null } | null>({
    queryKey: ["/api/author-stats"],
    queryFn: () => apiRequest("GET", "/api/author-stats").then(r => r.json()),
    refetchInterval: 120000,
  });

  // Author streaks for all authors
  const { data: authorStreaks = [] } = useQuery<{ author: string; streak: number }[]>({
    queryKey: ["/api/author-streaks"],
    queryFn: () => apiRequest("GET", "/api/author-streaks").then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: firstMover } = useQuery<{ score: number; firstCount: number; totalTopics: number; topics: { brand: string; firstSite: string; firstDate: string; stereonetDate: string | null; daysBehind: number; jointFirst: boolean; siteCount: number }[] }>({
    queryKey: ["/api/firstmover", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/firstmover?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: velocityData = [] } = useQuery<{ site: string; avgPerDay: number; total: number; gap: number }[]>({
    queryKey: ["/api/velocity", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/velocity?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: scorecard } = useQuery<any>({
    queryKey: ["/api/scorecard", scorecardCurrentFrom, scorecardCurrentTo, scorecardPreviousFrom, scorecardPreviousTo],
    queryFn: () => {
      const params = new URLSearchParams({ currentFrom: scorecardCurrentFrom, currentTo: scorecardCurrentTo, previousFrom: scorecardPreviousFrom, previousTo: scorecardPreviousTo });
      return apiRequest("GET", `/api/scorecard?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const { data: heatmapData = [] } = useQuery<{ site: string; dow: number; count: number }[]>({
    queryKey: ["/api/heatmap", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/heatmap?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: todData = [] } = useQuery<{ site: string; hour: number; count: number }[]>({
    queryKey: ["/api/timeofday", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/timeofday?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: authorWeekly = [] } = useQuery<{ author: string; week: string; count: number }[]>({
    queryKey: ["/api/authors/weekly", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/authors/weekly?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: brandsData = [] } = useQuery<{ brand: string; total: number; sites: string }[]>({
    queryKey: ["/api/brands", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/brands?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: topicsData = [] } = useQuery<{ brand: string; sites: string; site_count: number; article_count: number; stereonet_only: number }[]>({
    queryKey: ["/api/topics", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/topics?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  // Most-viewed StereoNET article in the last 48 hours by hit-count growth.
  // Refreshes every 5 minutes so the card stays current as views accumulate.
  const { data: mostViewed } = useQuery<{
    article: { id: number; title: string; url: string; author: string | null; published_date: string; brands: string | null; content_type: string | null };
    hits: number;
    deltaHits: number;
    image: string | null;
  } | null>({
    queryKey: ["/api/most-viewed-48h"],
    queryFn: () => apiRequest("GET", `/api/most-viewed-48h`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });

  // Commercial Activity card: /advertising hits, leads, proposals sent across 7/14/30 day windows.
  const { data: commercialActivity } = useQuery<{
    ok: boolean;
    windows: Array<{ days: number; advertising_hits: number; leads: number; proposals_sent: number }>;
  } | null>({
    queryKey: ["/api/dashboard/commercial-activity"],
    queryFn: () => apiRequest("GET", "/api/dashboard/commercial-activity").then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });

  const { data: forumStats } = useQuery<{ current: any; previous: any } | null>({
    queryKey: ["/api/forum-stats"],
    queryFn: async () => {
      const data = await apiRequest("GET", "/api/forum-stats").then(r => r.json());
      // If no data yet, try fetching via server proxy (avoids CORS + Cloudflare)
      if (!data || !data.current) {
        try {
          const proxyRes = await fetch("/api/forum-proxy");
          if (proxyRes.ok) {
            const html = await proxyRes.text();
            // Positional parsing: extract numbers in order from each section
            const adsIdx = html.indexOf("Ads Statistics");
            const forumIdx = html.indexOf("Forum Statistics");

            const stats: any = {
              active_ads: 0, total_ads: 0, successful_sales: 0,
              clearance_rate: "N/A", total_sales_14d: "$0",
              total_ads_value: "$0", total_topics: "0", total_posts: "0",
            };

            if (adsIdx > -1) {
              const endIdx = forumIdx > adsIdx ? forumIdx : adsIdx + 3000;
              const chunk = html.substring(adsIdx, endIdx).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
              const allVals: string[] = [];
              const rx = /(\$[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?)/g;
              let mm;
              while ((mm = rx.exec(chunk)) !== null) {
                if (mm[1] === "14" || /^20\d{2}$/.test(mm[1])) continue;
                allVals.push(mm[1]);
              }
              if (allVals.length >= 1) stats.active_ads = parseInt(allVals[0].replace(/[$,]/g, "")) || 0;
              if (allVals.length >= 2) stats.total_ads = parseInt(allVals[1].replace(/[$,]/g, "")) || 0;
              if (allVals.length >= 3) stats.successful_sales = parseInt(allVals[2].replace(/[$,]/g, "")) || 0;
              const dollarVals = allVals.filter(v => v.startsWith("$"));
              if (dollarVals.length >= 1) stats.total_sales_14d = dollarVals[0];
              if (dollarVals.length >= 2) stats.total_ads_value = dollarVals[1];
            }

            if (forumIdx > -1) {
              const chunk = html.substring(forumIdx, forumIdx + 2000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
              const rx = /(\d[\d,]*(?:\.\d+)?[km])/gi;
              const fVals: string[] = [];
              let mm;
              while ((mm = rx.exec(chunk)) !== null) {
                fVals.push(mm[1]);
              }
              if (fVals.length >= 1) stats.total_topics = fVals[0];
              if (fVals.length >= 2) stats.total_posts = fVals[1];
            }

            if (stats.active_ads > 0) {
              await apiRequest("POST", "/api/forum-stats", stats);
              return apiRequest("GET", "/api/forum-stats").then(r => r.json());
            }
          }
        } catch {}

        // Second fallback: fetch directly from browser (bypasses Cloudflare for real browsers)
        try {
          const directRes = await fetch("https://www.stereonet.com/forums/", { mode: "cors" });
          if (directRes.ok) {
            const html = await directRes.text();
            if (html.includes("Ads Statistics")) {
              const adsIdx = html.indexOf("Ads Statistics");
              const forumIdx = html.indexOf("Forum Statistics");
              const stats2: any = {
                active_ads: 0, total_ads: 0, successful_sales: 0,
                clearance_rate: "N/A", total_sales_14d: "$0",
                total_ads_value: "$0", total_topics: "0", total_posts: "0",
              };
              if (adsIdx > -1) {
                const endIdx = forumIdx > adsIdx ? forumIdx : adsIdx + 3000;
                const chunk = html.substring(adsIdx, endIdx).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
                const allVals: string[] = [];
                const rx = /(\$\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?)/g;
                let mm;
                while ((mm = rx.exec(chunk)) !== null) {
                  if (mm[1] === "14" || /^20\d{2}$/.test(mm[1])) continue;
                  allVals.push(mm[1]);
                }
                if (allVals.length >= 1) stats2.active_ads = parseInt(allVals[0].replace(/[$,]/g, "")) || 0;
                if (allVals.length >= 2) stats2.total_ads = parseInt(allVals[1].replace(/[$,]/g, "")) || 0;
                if (allVals.length >= 3) stats2.successful_sales = parseInt(allVals[2].replace(/[$,]/g, "")) || 0;
                const dollarVals = allVals.filter(v => v.startsWith("$"));
                if (dollarVals.length >= 1) stats2.total_sales_14d = dollarVals[0];
                if (dollarVals.length >= 2) stats2.total_ads_value = dollarVals[1];
              }
              if (forumIdx > -1) {
                const chunk = html.substring(forumIdx, forumIdx + 2000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
                const rx = /(\d[\d,]*(?:\.\d+)?[km])/gi;
                const fVals: string[] = [];
                let mm;
                while ((mm = rx.exec(chunk)) !== null) {
                  fVals.push(mm[1]);
                }
                if (fVals.length >= 1) stats2.total_topics = fVals[0];
                if (fVals.length >= 2) stats2.total_posts = fVals[1];
              }
              if (stats2.active_ads > 0) {
                await apiRequest("POST", "/api/forum-stats", stats2);
                return apiRequest("GET", "/api/forum-stats").then(r => r.json());
              }
            }
          }
        } catch {}
      }
      return data;
    },
    refetchInterval: 3600000, // hourly
  });

  const { data: contentGaps = [] } = useQuery<{ brand: string; competitorReviews: { site: string; title: string; date: string; url: string }[]; siteCount: number }[]>({
    queryKey: ["/api/content-gaps", fromDate, toDate],
    queryFn: () => apiRequest("GET", `/api/content-gaps?fromDate=${fromDate}&toDate=${toDate}`).then(r => r.json()),
    refetchInterval: 120000,
  });

  const { data: articles = [], isLoading: articlesLoading } = useQuery<Article[]>({
    queryKey: ["/api/articles", activeSite, activeType, fromDate, toDate],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate, toDate, limit: "150" });
      if (siteParam) params.set("site", siteParam);
      if (typeParam) params.set("contentType", typeParam);
      return apiRequest("GET", `/api/articles?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const lastRefreshStr = stats?.lastRefresh ? relativeTime(stats.lastRefresh) : "Never";

  // Fill gaps in daily data with zeros
  // Compute WoW from daily data grouped by site (using breakdown as proxy)
  const siteWoW = useMemo(() => {
    const result: Record<string, { current: number; previous: number; pct: number }> = {};
    if (daily.length >= 14) {
      const mid = Math.floor(daily.length / 2);
      const prevHalf = daily.slice(0, mid).reduce((s, d) => s + d.total, 0);
      const currHalf = daily.slice(mid).reduce((s, d) => s + d.total, 0);
      const pct = prevHalf > 0 ? Math.round(((currHalf - prevHalf) / prevHalf) * 100) : 0;
      result[activeSite] = { current: currHalf, previous: prevHalf, pct };
    }
    return result;
  }, [daily, activeSite]);

  // ─── Author weekly chart data ──────────────────────────────────────────────────
  const authorWeeklyChartData = useMemo(() => {
    const weeks = [...new Set(authorWeekly.map(r => r.week))].sort();
    const authorNames = [...new Set(authorWeekly.map(r => r.author))];
    const AUTHOR_COLORS = ["#e8312a","#f97316","#facc15","#fb923c","#ef4444","#f59e0b","#dc2626","#ea580c"];
    const datasets = authorNames.map((author, i) => {
      const weekMap = new Map(authorWeekly.filter(r => r.author === author).map(r => [r.week, r.count]));
      return {
        label: author,
        data: weeks.map(w => weekMap.get(w) ?? 0),
        backgroundColor: AUTHOR_COLORS[i % AUTHOR_COLORS.length] + "cc",
        borderColor: AUTHOR_COLORS[i % AUTHOR_COLORS.length],
        borderWidth: 2,
        fill: false,
        tension: 0.3,
      };
    });
    return { labels: weeks.map(w => w.replace(/^\d{4}-/, "")), datasets };
  }, [authorWeekly]);

  const filledDaily = useMemo(() => {
    const map = new Map(daily.map(d => [d.date, d]));
    const result: DailyRow[] = [];
    for (let i = dateRange - 1; i >= 0; i--) {
      const d = nDaysAgo(i);
      result.push(map.get(d) ?? { date: d, total: 0, review: 0, news: 0, feature: 0, opinion: 0, unknown: 0 });
    }
    return result;
  }, [daily, dateRange]);

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* ── Mobile overlay ── */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* ── Sidebar ── */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col border-r border-border bg-[hsl(var(--sidebar-background))] overflow-y-auto transition-transform duration-200 lg:static lg:w-48 lg:translate-x-0 lg:shrink-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`} style={{ overscrollBehavior: "contain" }}>
        {/* Logo */}
        <div className="border-b border-[hsl(var(--sidebar-border))]" style={{ padding: "12px 14px" }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="178 420 1520 380" style={{ width: "100%", height: 38, display: "block" }} aria-label="StereoNET">
            <g fill="#fff">
              <path d="M281.8,569.7l-.4-11.3c0-2.7-.2-5.3-.6-8-.4-2.7-1.1-5.4-2.2-8.3-1.1-2.9-2.7-5.1-4.8-6.9-2.1-1.7-4.6-2.6-7.6-2.6-4.9,0-8.7,1.4-11.2,4.2-2.6,2.8-3.9,6.7-3.9,11.8,0,10.6,4.3,19,12.8,25.3l44,32.2c8.8,6.5,16.3,13.3,22.7,20.5,6.4,7.2,11.2,13.7,14.5,19.6,3.3,5.9,5.9,12.2,7.8,19,1.9,6.8,3.1,12.3,3.5,16.5.4,4.2.6,9,.6,14.3,0,28.5-8,50.1-24.1,64.8-16.1,14.7-38,22-65.6,22.1-58.9,0-88.4-29.9-88.5-89.9l.4-23.7h71.3c0,0,.4,35,.4,35,0,4.8.6,8.7,1.7,11.8,1.1,3.1,2.7,5.3,4.7,6.7,2,1.3,3.8,2.2,5.5,2.6,1.7.4,3.5.6,5.7.6,9.6,0,14.3-7.8,14.3-23.3,0-4,0-6.9-.2-8.7-.1-1.8-.6-4.4-1.5-8-.9-3.5-2.3-6.6-4.2-9.3-1.9-2.7-4.7-5.9-8.4-9.7-3.7-3.8-8.3-7.9-13.8-12.1l-38.1-29.2c-8.2-6.4-14.9-12.6-20-18.6-5.1-6-8.8-12.4-11.2-19.1-2.3-6.7-3.8-12.7-4.5-18.1-.7-5.4-1-12.3-1-20.8,0-15.3,4.4-28.5,13.1-39.6,8.7-11.2,19.7-19.3,32.7-24.5,13.1-5.2,27.2-7.8,42.5-7.8,28,0,49.5,7.1,64.4,21.2,14.9,14.2,22.4,36.1,22.5,65.7v5.6s-73.3,0-73.3,0Z"/>
              <path d="M368.1,428.7h69.3v63.4h12.7v54.3h-12.7l.2,168c0,2.5,0,4.5.2,6,.1,1.5.4,3,.8,4.7.4,1.7,1.2,2.9,2.3,3.6,1.1.7,2.6,1.1,4.3,1.1,1.7,0,3.5-.3,5.2-.8v48.6c-10,3.5-22.7,5.2-38,5.2-7.7,0-14.3-1-19.8-3.1-5.5-2.1-9.8-4.6-12.8-7.6-3.1-3-5.5-6.8-7.3-11.5-1.8-4.7-2.9-9.1-3.4-13.2-.5-4.1-.7-8.8-.7-14.1l-.2-186.7h-10.9v-54.3h10.9v-63.5Z"/>
              <path d="M543.9,782.7c-10.6,0-20.2-1.1-28.9-3.3-8.6-2.2-15.9-5-21.8-8.5-5.9-3.5-11-8-15.3-13.3-4.3-5.4-7.7-10.8-10.3-16.4-2.5-5.6-4.6-11.9-6.1-19.1-1.5-7.2-2.5-13.8-3-19.9-.5-6.1-.7-12.9-.7-20.3v-120c-.2-27.5,7.7-48.5,23.4-63,15.7-14.5,37.7-21.8,66-21.9,57.3,0,86,28.2,86.1,84.7v21.7c0,26.9-.2,45.5-.7,55.5h-103.5v41.9c0,1.3,0,3.5,0,6.5s0,5.3,0,6.9c0,4.8.2,8.9.6,12.2.4,3.4,1.1,6.8,2.2,10.3,1.1,3.5,2.8,6.2,5.3,8,2.5,1.8,5.5,2.7,9.3,2.7,3.8,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.6,5.1-11.7,1-5.1,1.6-9.7,1.9-13.6.3-4,.4-9,.4-14.9,0-11.7-.2-18-.4-19.1h70.9v16.8c0,16.6-1.2,30.7-3.7,42.4-2.5,11.7-7,22.2-13.4,31.6-6.4,9.4-15.6,16.4-27.5,21-11.9,4.7-26.9,7-44.8,7ZM546.4,530.4c-3.7,0-6.8,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.8-.4,4.1-.6,9-.6,14.8,0,2.8,0,7,.2,12.5.1,5.6.2,9.8.2,12.5h33.4v-31.1c0-21.5-5.3-32.2-16-32.2Z"/>
              <path d="M640.6,779l-.3-298.6h71.3v33.2c4-13.7,9.5-23.2,16.7-28.7,7.2-5.4,16.2-8.2,27.3-8.2,13.3,0,25,4.1,35,12.2,10.1,8.2,15.2,20,15.2,35.5v99.9h-69.6v-71.5c0-3.6-.2-6.6-.6-9.1-.3-2.5-1.4-4.8-3.2-7.1-1.8-2.3-4.4-3.4-7.7-3.4-3.5,0-6.5,1.5-9.2,4.6-2.7,3.1-4,7.2-4,12.5l.2,228.3h-71.3Z"/>
              <path d="M890.1,782.3c-10.6,0-20.2-1.1-28.9-3.3-8.6-2.2-15.9-5-21.8-8.5-5.9-3.5-11-8-15.3-13.3-4.3-5.4-7.7-10.8-10.3-16.4-2.5-5.6-4.6-11.9-6.1-19.1-1.5-7.2-2.5-13.8-3-19.9-.5-6.1-.7-12.9-.7-20.3v-120c-.2-27.5,7.7-48.5,23.4-63,15.7-14.5,37.7-21.8,66-21.9,57.3,0,86,28.2,86.1,84.7v21.7c0,26.9-.2,45.5-.7,55.5h-103.5v41.9c0,1.3,0,3.5,0,6.5s0,5.3,0,6.9c0,4.8.2,8.9.6,12.2.4,3.4,1.1,6.8,2.2,10.3,1.1,3.5,2.8,6.2,5.3,8,2.5,1.8,5.5,2.7,9.3,2.7,3.8,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.6,5.1-11.8,1-5.1,1.6-9.7,1.9-13.6.3-4,.4-9,.4-14.9,0-11.7-.1-18-.4-19.1h70.9v16.8c0,16.6-1.2,30.7-3.7,42.4-2.5,11.7-7,22.2-13.4,31.6-6.4,9.4-15.6,16.4-27.6,21-11.9,4.7-26.9,7-44.8,7ZM892.6,530.1c-3.7,0-6.8,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.8-.4,4.1-.6,9-.6,14.8,0,2.8,0,7,.2,12.5.1,5.6.2,9.8.2,12.5h33.4v-31.1c0-21.5-5.3-32.2-16-32.2Z"/>
              <path d="M1075.4,782.1c-59.5,0-89.2-30.9-89.3-92.9v-119.8c-.2-28.5,7.8-51.2,23.7-67.9,15.9-16.7,37.7-25.1,65.3-25.2,27.7,0,49.6,8.3,65.5,25,15.9,16.7,23.9,39.3,24,67.9v119.8c.2,31.2-7.4,54.5-22.6,69.9-15.2,15.4-37.4,23.1-66.6,23.2ZM1058.4,558v145.9c.2,8,1.7,13.8,4.8,17.4,3.1,3.6,7.1,5.5,12.1,5.5,4.9,0,8.9-1.8,12-5.5,3.1-3.7,4.7-9.5,4.7-17.4v-145.9c-.2-17.4-5.7-26.1-16.9-26.1-11.1,0-16.7,8.7-16.7,26.1Z"/>
              <path d="M1172.2,780.7l-.3-300.7h71.7v34.4c2.9-13,8.4-22.5,16.3-28.7,7.9-6.1,17.6-9.2,28.9-9.2,18.8,0,33.5,5.9,43.9,17.7,10.4,11.8,15.7,30,15.7,54.6l.2,231.8h-70.7l-.3-224.3c0-6.3-1.3-11.8-3.8-16.6-2.5-4.8-6.6-7.2-12.2-7.2-3.5,0-6.4,1-8.8,2.9-2.4,1.9-4.2,4.1-5.3,6.6-1.1,2.5-2,5.7-2.7,9.7-.7,4-1,7.1-1.1,9.2,0,2.1-.1,4.9,0,8.4l.2,211.4h-71.7Z"/>
              <path d="M1441,784c-10.7,0-20.4-1.1-29.1-3.3-8.7-2.2-16-5.1-21.9-8.6-6-3.5-11.1-8-15.4-13.4-4.3-5.4-7.8-10.9-10.3-16.5-2.5-5.6-4.6-12-6.1-19.2-1.5-7.2-2.6-13.9-3-20-.5-6.1-.7-13-.7-20.4v-120.8c-.2-27.6,7.7-48.8,23.5-63.4,15.8-14.6,37.9-22,66.4-22,57.7,0,86.6,28.4,86.6,85.2v21.8c0,27.1-.2,45.7-.7,55.9h-104.2v42.2c0,1.3,0,3.5,0,6.5s-.1,5.3,0,6.9c0,4.8.2,8.9.6,12.3.4,3.4,1.1,6.9,2.2,10.4,1.1,3.5,2.9,6.2,5.3,8,2.5,1.8,5.6,2.7,9.3,2.7,3.9,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.7,5.1-11.8,1-5.1,1.6-9.7,1.9-13.7.3-4,.4-9,.4-15,0-11.8-.1-18.2-.4-19.2h71.3v16.9c0,16.7-1.2,30.9-3.8,42.7-2.5,11.8-7,22.3-13.5,31.8-6.5,9.4-15.7,16.5-27.7,21.2-12,4.7-27,7-45.1,7.1ZM1443.5,530.2c-3.7,0-6.9,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.9-.4,4.1-.6,9.1-.6,14.9,0,2.8,0,7,.2,12.6.1,5.6.2,9.8.2,12.6h33.7v-31.3c0-21.6-5.4-32.5-16.1-32.4Z"/>
              <path d="M1544.4,427.5h69.7v63.8h12.8v54.7h-12.8l.2,169.1c0,2.5,0,4.5.2,6,.1,1.5.4,3,.8,4.7.4,1.7,1.2,2.9,2.3,3.6,1.1.7,2.6,1.1,4.3,1.1,1.7,0,3.5-.3,5.2-.8v48.9c-10.1,3.5-22.8,5.2-38.2,5.3-7.7,0-14.4-1-19.9-3.1-5.5-2.1-9.9-4.6-12.9-7.6-3.1-3-5.5-6.9-7.3-11.6-1.8-4.7-2.9-9.2-3.4-13.3-.5-4.1-.7-8.9-.7-14.2l-.2-187.9h-11v-54.7h11v-63.9Z"/>
            </g>
            <path fill="#fff" d="M1674.5,449.6c0,3.2-.6,6.2-1.8,9-1.2,2.8-2.8,5.2-4.9,7.3-2.1,2.1-4.5,3.7-7.3,4.9-2.8,1.2-5.8,1.8-9,1.8s-6.4-.6-9.2-1.7c-2.8-1.2-5.2-2.7-7.2-4.7-2-2-3.6-4.4-4.7-7.2-1.1-2.8-1.7-5.8-1.7-9.1s.6-6.2,1.8-9c1.2-2.8,2.8-5.2,4.9-7.2,2.1-2.1,4.5-3.7,7.3-4.8,2.8-1.2,5.8-1.8,9.1-1.8s6.4.6,9.2,1.7c2.8,1.1,5.2,2.7,7.2,4.7,2,2,3.6,4.4,4.7,7.2,1.1,2.8,1.7,5.8,1.7,9.1Z"/>
          </svg>
        </div>

        {/* Navigation — mirrors the top TabNav but vertical for desktop sidebar.
            Sites/Type/Date filters moved into the collapsible Filters disclosure below. */}
        <nav className="px-2 pt-3 pb-1">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-2 mb-2">Navigate</div>
          {(() => {
            const isLoggedIn = !!me?.username;
            const isAdmin = me?.role === "admin";
            const hasRedline = isAdmin || me?.redline_access === 1;
            const navItems = [
              { hash: "/",          label: "Dashboard",        icon: LayoutDashboard, show: true },
              { hash: "/discovery", label: "Article Discovery", icon: Search,          show: true },
              { hash: "/my-articles", label: "My Articles",     icon: FileText,        show: isLoggedIn },
              { hash: "/analytics", label: "Analytics",         icon: BarChart2,       show: isLoggedIn },
              { hash: "/sites",     label: "Sites",             icon: Server,          show: isLoggedIn },
              { hash: "/redline",   label: "Redline",           icon: ScrollText,      show: hasRedline },
              { hash: "/pitch",     label: "PITCH",             icon: Megaphone,       show: isLoggedIn },
              { hash: "/leads",     label: "Leads",             icon: MailOpen,        show: isLoggedIn },
              { hash: "/media-kits", label: "Media Kits",       icon: Layers,          show: isLoggedIn },
              { hash: "/admin",     label: "Admin",             icon: Shield,          show: isAdmin },
            ];
            return navItems.filter(n => n.show).map(item => {
              const Icon = item.icon;
              const isActive = hashLoc === item.hash || (item.hash === "/" && (hashLoc === "" || hashLoc === "/"));
              return (
                <a
                  key={item.hash}
                  href={`#${item.hash}`}
                  data-testid={`nav-btn-${item.hash}`}
                  onClick={() => setSidebarOpen(false)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-all mb-0.5 ${
                    isActive
                      ? "bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-accent-foreground))]"
                      : "text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent)/50)] hover:text-[hsl(var(--sidebar-accent-foreground))]"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-left leading-tight">{item.label}</span>
                </a>
              );
            });
          })()}
        </nav>

        {/* Filters — collapsible disclosure covering Sites, Type and Date Range.
            Collapsed by default because the Sites filter in particular was almost never used. */}
        <div className="px-2 pt-3 pb-1">
          <button
            onClick={() => setFiltersOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="flex items-center gap-1.5"><Filter className="w-3 h-3" /> Filters{(activeSite !== "all" || activeType !== "all" || dateRange !== 30) && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-[#e8312a]/20 text-[#e8312a] text-[9px] normal-case tracking-normal font-bold">on</span>}</span>
            <ChevronRight className={`w-3 h-3 transition-transform ${filtersOpen ? "rotate-90" : ""}`} />
          </button>
          {filtersOpen && (
            <div className="mt-2 space-y-3">
              {/* Date range first — the most-used filter */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-2 mb-1">Date Range</div>
                <div className="px-2">
                  <select
                    value={dateRange}
                    onChange={(e) => { setDateRange(Number(e.target.value)); }}
                    className="w-full px-2.5 py-2 rounded-md text-sm font-medium bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-accent-foreground))] border border-border cursor-pointer"
                  >
                    <option value={1}>24 Hours</option>
                    <option value={2}>48 Hours</option>
                    <option value={3}>3 Days</option>
                    <option value={7}>7 Days</option>
                    <option value={14}>14 Days</option>
                    <option value={30}>30 Days</option>
                    <option value={90}>90 Days</option>
                  </select>
                </div>
              </div>
              {/* Type filter */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-2 mb-1">Type</div>
                <div className="px-2">
                  <select
                    value={activeType}
                    onChange={(e) => setActiveType(e.target.value as any)}
                    className="w-full px-2.5 py-2 rounded-md text-sm font-medium bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-accent-foreground))] border border-border cursor-pointer"
                  >
                    {CONTENT_TYPES.map(type => (
                      <option key={type} value={type}>{type === "all" ? "All Types" : TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Sites filter — collapsed into a select to save space */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-2 mb-1">Site</div>
                <div className="px-2">
                  <select
                    value={activeSite}
                    onChange={(e) => setActiveSite(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-md text-sm font-medium bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-accent-foreground))] border border-border cursor-pointer"
                  >
                    <option value="all">All Sites</option>
                    {sites.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom controls */}
        <div className="mt-auto px-3 py-4 border-t border-[hsl(var(--sidebar-border))] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3" />
              Updated {lastRefreshStr} · auto
            </span>
            <button
              data-testid="button-theme"
              onClick={() => setIsDark(!isDark)}
              className="p-1 rounded hover:bg-[hsl(var(--sidebar-accent))] transition-colors text-muted-foreground hover:text-foreground"
            >
              {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        {/* Version + Logout */}
        <div className="mt-auto px-4 py-3 border-t border-[hsl(var(--sidebar-border))]">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-muted-foreground font-mono">{import.meta.env.VITE_BUILD_VERSION}</div>
            <form method="POST" action="/logout">
              <button type="submit" className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                <LogOut className="w-3 h-3" />
                Sign out
              </button>
            </form>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Built {(() => {
              const parts = new Intl.DateTimeFormat("en-AU", {
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: false,
                timeZone: "Australia/Sydney",
              }).formatToParts(new Date(import.meta.env.VITE_BUILD_DATE));
              const g = (t: string) => parts.find(p => p.type === t)?.value || "";
              return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")} AEST`;
            })()}
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
        {/* Header */}
        <header className="sticky top-0 z-10 flex items-center justify-between px-3 sm:px-6 py-3 bg-background/95 backdrop-blur border-b border-border gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              className="lg:hidden p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1
                className="truncate flex items-baseline gap-2 text-foreground"
                style={{ fontFamily: "'Cabinet Grotesk', Inter, system-ui, sans-serif" }}
              >
                <span
                  className="text-2xl sm:text-3xl font-black tracking-[0.18em] uppercase bg-gradient-to-r from-[#e8312a] via-[#ff5c52] to-[#eab308] bg-clip-text text-transparent"
                  style={{ WebkitBackgroundClip: "text", lineHeight: 1 }}
                >
                  Pulse
                </span>
                <span className="text-xs sm:text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                  Dashboard
                </span>
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#e8312a]/15 text-[#e8312a] border border-[#e8312a]/30 shrink-0 translate-y-[-2px] tabular-nums"
                  title={(import.meta as any).env?.VITE_BUILD_DATE ? `Built ${(() => {
                    const parts = new Intl.DateTimeFormat("en-AU", {
                      day: "2-digit", month: "2-digit", year: "numeric",
                      hour: "2-digit", minute: "2-digit", hour12: false,
                      timeZone: "Australia/Sydney",
                    }).formatToParts(new Date((import.meta as any).env.VITE_BUILD_DATE));
                    const g = (t: string) => parts.find(p => p.type === t)?.value || "";
                    return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")} AEST`;
                  })()}` : undefined}
                >
                  {(import.meta as any).env?.VITE_BUILD_VERSION || "dev"}
                </span>
              </h1>
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate mt-0.5">
                StereoNET · {activeSite === "all" ? "All sites" : sites.find(s => s.key === activeSite)?.label ?? activeSite}
                {activeType !== "all" ? ` · ${TYPE_LABELS[activeType]}` : ""}
                {" · "} {dateRange <= 2 ? `${dateRange * 24} hours` : `Last ${dateRange} days`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <a
              href="https://www.stereonet.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Visit Website
            </a>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 pulse-dot" />
              <span className="hidden sm:inline">Live</span>
            </span>
            <Badge variant="outline" className="text-[10px] sm:text-xs tabular-nums">
              {stats?.totalInRange ?? "–"} articles
            </Badge>
          </div>
        </header>

        <div className="p-3 sm:p-5 pb-16 space-y-4 sm:space-y-5">
          {/* ── Personal Stats ── */}
          {myStats && (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              {/* Personal scorecard */}
              <Card className="border border-[#eab308]/30 bg-gradient-to-br from-[#eab308]/10 to-[#f97316]/5 lg:col-span-2">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Your scorecard</div>
                      <div className="text-lg font-bold text-foreground">{myStats.author}</div>
                    </div>
                    <InfoTip text="Your personal writing stats on StereoNET. Articles published by week/month/all-time, your rank against other authors in the last 30 days, consecutive-day writing streak, and how often you're the first StereoNET writer to cover a brand." />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Week</div>
                      <div className="text-2xl font-black text-[#eab308] leading-tight">{myStats.thisWeek}</div>
                      <div className="text-[9px] text-muted-foreground">articles</div>
                    </div>
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Month</div>
                      <div className="text-2xl font-black text-foreground leading-tight">{myStats.thisMonth}</div>
                      <div className="text-[9px] text-muted-foreground">articles</div>
                    </div>
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">All-Time</div>
                      <div className="text-2xl font-black text-foreground leading-tight">{myStats.allTime}</div>
                      <div className="text-[9px] text-muted-foreground">articles</div>
                    </div>
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Rank</div>
                      <div className="text-2xl font-black text-foreground leading-tight">
                        #{myStats.rank}<span className="text-sm font-normal text-muted-foreground">/{myStats.totalAuthors}</span>
                      </div>
                      <div className="text-[9px] text-muted-foreground">vs other authors (30d)</div>
                    </div>
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Streak</div>
                      <div className="text-2xl font-black leading-tight">
                        {myStats.streak > 0 ? (
                          <span className={myStats.streak >= 10 ? "text-[#e8312a]" : myStats.streak >= 5 ? "text-[#f97316]" : "text-[#eab308]"}>
                            {myStats.streak}<span className="text-sm font-normal">d</span> {myStats.streak >= 10 ? "⚡" : myStats.streak >= 5 ? "🔥" : ""}
                          </span>
                        ) : <span className="text-muted-foreground">0<span className="text-sm font-normal">d</span></span>}
                      </div>
                      <div className="text-[9px] text-muted-foreground">days in a row</div>
                    </div>
                    <div className="rounded-md bg-background/40 p-2.5 text-center">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">First Mover</div>
                      <div className={`text-2xl font-black leading-tight ${myStats.firstMoverPct >= 50 ? "text-green-400" : myStats.firstMoverPct >= 25 ? "text-[#eab308]" : "text-muted-foreground"}`}>{myStats.firstMoverPct}<span className="text-sm font-normal">%</span></div>
                      <div className="text-[9px] text-muted-foreground">first on shared topics</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
              {/* Latest article card */}
              {myStats.latestArticle && (() => {
                const slug = myStats.latestArticle!.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
                const lastSeg = slug.split("/").pop() || slug;
                const hc = hitCounts[myStats.latestArticle!.url] ?? hitCounts[slug] ?? hitCounts[lastSeg];
                const hits = hc?.hits;
                const image = hc?.image;
                // Compute days since published + views/day rate
                const pubDate = new Date(myStats.latestArticle.published_date);
                const daysSince = Math.max(1, Math.round((Date.now() - pubDate.getTime()) / (86400000)));
                const viewsPerDay = hits != null ? Math.round(hits / daysSince) : null;
                return (
                  <Card className="border border-[#eab308]/30 bg-gradient-to-r from-[#eab308]/5 to-transparent lg:col-span-3 overflow-hidden">
                    <a
                      href={myStats.latestArticle.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-full group"
                    >
                      {image && (
                        <div className="hidden sm:block w-48 lg:w-56 shrink-0 relative">
                          <img src={image} alt="" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-background/60" />
                        </div>
                      )}
                      <div className="flex-1 p-5 flex flex-col gap-4">
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#eab308]" />
                            Your latest article
                            <span className="text-muted-foreground/60">· {myStats.latestArticle.published_date}</span>
                          </div>
                          <h3 className="text-base sm:text-lg font-bold text-foreground group-hover:text-[#eab308] transition-colors line-clamp-2">
                            {myStats.latestArticle.title}
                          </h3>
                        </div>
                        <div className="flex items-end gap-6 flex-wrap">
                          {hits != null ? (
                            <>
                              <div>
                                <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Total views</div>
                                <div className="text-3xl sm:text-4xl font-black text-[#e8312a] leading-none tabular-nums">
                                  {hits.toLocaleString()}
                                </div>
                              </div>
                              {viewsPerDay != null && (
                                <div>
                                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Views / day</div>
                                  <div className="text-2xl font-black text-foreground leading-none tabular-nums">
                                    {viewsPerDay.toLocaleString()}
                                  </div>
                                </div>
                              )}
                              <div>
                                <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Age</div>
                                <div className="text-2xl font-black text-muted-foreground leading-none tabular-nums">
                                  {daysSince}<span className="text-sm font-normal">d</span>
                                </div>
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Fetching view stats…</span>
                          )}
                          <a
                            href="#/my-articles"
                            onClick={(e) => e.stopPropagation()}
                            className="ml-auto text-xs font-semibold text-[#eab308] hover:text-[#eab308]/80 transition-colors self-end"
                          >
                            All articles →
                          </a>
                        </div>
                      </div>
                    </a>
                  </Card>
                );
              })()}
            </div>
          )}

          {/* ── Velocity Gap (moved to top-2 position per editorial request, May 2026) ── */}
          {velocityData.length > 0 && (() => {
            const snAvg = velocityData.length > 0
              ? Math.round((velocityData.reduce((s, r) => s + r.avgPerDay + r.gap, 0) / velocityData.length) * 10) / 10
              : 0;
            const maxVal = Math.max(snAvg, ...velocityData.map(r => r.avgPerDay), 1);
            const sortedCompetitors = [...velocityData].sort((a, b) => b.avgPerDay - a.avgPerDay);
            const snPct = Math.min(100, (snAvg / maxVal) * 100);
            return (
              <Card className="overflow-hidden">
                <CardHeader className="pb-3 pt-4 px-5">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-[#eab308]" />
                      Velocity Gap
                      <InfoTip text="Compares StereoNET's average articles per day against each competitor in the selected date range. The reference line marks StereoNET's pace. Competitors to the LEFT of the line publish less than StereoNET (green). Competitors to the RIGHT publish more (red)." />
                    </CardTitle>
                    <div className="flex items-center gap-2 text-xs">
                      <div className="w-2.5 h-2.5 rounded-sm" style={{ background: "#eab308" }} />
                      <span className="text-muted-foreground">StereoNET reference</span>
                      <span className="font-bold text-[#eab308] ml-1">{snAvg.toFixed(1)}/day</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-5 pb-4 space-y-1">
                  {sortedCompetitors.map(row => {
                    const siteLabel = sites.find(s => s.key === row.site)?.label ?? row.site;
                    const siteColor = sites.find(s => s.key === row.site)?.color ?? "#6b7280";
                    const siteUrl = sites.find(s => s.key === row.site)?.siteUrl || "";
                    const ahead = row.gap >= 0;
                    const widthPct = Math.min(100, (row.avgPerDay / maxVal) * 100);
                    return (
                      <div key={row.site} className="grid grid-cols-[140px_60px_1fr_70px] items-center gap-3 py-1 px-1 rounded hover:bg-muted/20 transition-colors">
                        <a href={siteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-foreground hover:underline min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: siteColor }} />
                          <span className="truncate">{siteLabel}</span>
                          <ExternalLink className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                        </a>
                        <span className="text-xs text-muted-foreground tabular-nums">{row.avgPerDay.toFixed(1)}/day</span>
                        <div className="relative h-2.5 bg-muted/40 rounded-full overflow-visible">
                          <div className="absolute left-0 top-0 h-full rounded-full transition-all" style={{ width: `${widthPct}%`, background: ahead ? "#22c55e" : "#e8312a", opacity: 0.85 }} />
                          <div className="absolute top-[-4px] bottom-[-4px] w-[2px] pointer-events-none" style={{ left: `calc(${snPct}% - 1px)`, background: "repeating-linear-gradient(to bottom, #eab308 0, #eab308 3px, transparent 3px, transparent 6px)" }} title={`StereoNET: ${snAvg.toFixed(1)}/day`} />
                        </div>
                        <span className={`text-xs font-bold tabular-nums text-right shrink-0 ${ahead ? "text-green-400" : "text-red-400"}`}>
                          {ahead ? "+" : "−"}{Math.abs(row.gap).toFixed(1)}/day
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-4 pt-3 mt-2 border-t border-border/40 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500/80" />StereoNET publishes more</span>
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500/80" />Competitor publishes more</span>
                    <span className="flex items-center gap-1.5 ml-auto"><span className="w-2 h-[10px]" style={{ background: "repeating-linear-gradient(to bottom, #eab308 0, #eab308 3px, transparent 3px, transparent 6px)" }} />StereoNET pace</span>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Commercial Activity + Most Viewed (side-by-side from md+) ──
              Two narrow cards that look better in one row than stacked. The row is
              only rendered when at least one of the two cards has data. */}
          {((commercialActivity?.windows && commercialActivity.windows.length > 0) || (mostViewed && mostViewed.article)) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {commercialActivity?.windows && commercialActivity.windows.length > 0 && (() => {
            const rows = [
              { key: "advertising_hits", label: "Advertising page hits", help: "GET requests to /advertising (bots filtered, same-IP 60s deduped)." },
              { key: "leads",            label: "Leads",                 help: "Inbound leads submitted via the /advertising Request-a-Media-Kit form." },
              { key: "proposals_sent",   label: "Proposals sent",        help: "PITCH proposals that were Sent in the window." },
            ] as const;
            return (
              <Card className="overflow-hidden">
                <CardHeader className="pb-3 pt-4 px-5">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-[#22c55e]" />
                    Commercial Activity
                    <InfoTip text="How the commercial funnel is moving. Counts /advertising landing-page hits, inbound leads, and PITCH proposals sent within each rolling window." />
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-5 pb-4">
                  <div className="grid grid-cols-[1fr_repeat(3,minmax(0,80px))] gap-x-4 gap-y-1 items-center">
                    <div />
                    {commercialActivity.windows.map(w => (
                      <div key={`h-${w.days}`} className="text-[10px] text-muted-foreground uppercase tracking-wider text-right tabular-nums">{w.days}d</div>
                    ))}
                    {rows.map(r => (
                      <Fragment key={r.key}>
                        <div className="text-xs text-foreground flex items-center gap-1.5 py-2 border-t border-border/40">
                          <span>{r.label}</span>
                          <InfoTip text={r.help} />
                        </div>
                        {commercialActivity.windows.map(w => (
                          <div key={`${r.key}-${w.days}`} className="text-base font-bold text-foreground tabular-nums text-right py-2 border-t border-border/40">
                            {((w as any)[r.key] as number).toLocaleString()}
                          </div>
                        ))}
                      </Fragment>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Most Viewed (last 48h) ──
              StereoNET’s top article by view-count growth in the last 48 hours.
              Auto-refreshes every 5 minutes. Click to open the article. */}
          {mostViewed && mostViewed.article && (() => {
            const a = mostViewed.article;
            const hits = mostViewed.hits;
            const delta = mostViewed.deltaHits;
            const image = mostViewed.image;
            // Days since publication, used for views-per-day rate.
            const pubDate = new Date(a.published_date);
            const daysSince = Math.max(1, Math.round((Date.now() - pubDate.getTime()) / 86400000));
            const viewsPerDay = Math.round(hits / daysSince);
            return (
              <Card className="border border-[#e8312a]/30 bg-gradient-to-r from-[#e8312a]/8 to-transparent overflow-hidden">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-full group"
                >
                  {image && (
                    <div className="hidden sm:block w-48 lg:w-56 shrink-0 relative">
                      <img src={image} alt="" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent to-background/60" />
                    </div>
                  )}
                  <div className="flex-1 p-5 flex flex-col gap-4">
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-2">
                        <Flame className="w-3.5 h-3.5 text-[#e8312a]" />
                        Most viewed · last 48 hours
                        {a.author && <span className="text-muted-foreground/60">· {a.author}</span>}
                        <span className="text-muted-foreground/60">· {a.published_date}</span>
                      </div>
                      <h3 className="text-base sm:text-lg font-bold text-foreground group-hover:text-[#e8312a] transition-colors line-clamp-2">
                        {a.title}
                      </h3>
                    </div>
                    <div className="flex items-end gap-6 flex-wrap">
                      <div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Total views</div>
                        <div className="text-3xl sm:text-4xl font-black text-[#e8312a] leading-none tabular-nums">
                          {hits.toLocaleString()}
                        </div>
                      </div>
                      {delta > 0 && (
                        <div>
                          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Views in 48h</div>
                          <div className="text-2xl font-black text-foreground leading-none tabular-nums">
                            +{delta.toLocaleString()}
                          </div>
                        </div>
                      )}
                      <div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Views / day</div>
                        <div className="text-2xl font-black text-muted-foreground leading-none tabular-nums">
                          {viewsPerDay.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Age</div>
                        <div className="text-2xl font-black text-muted-foreground leading-none tabular-nums">
                          {daysSince}<span className="text-sm font-normal">d</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </a>
              </Card>
            );
          })()}
          </div>
          )}

          {/* ── First Mover Score + Scorecard (side by side from md+) ── */}
          {(firstMover && firstMover.totalTopics > 0 || scorecard) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {firstMover && firstMover.totalTopics > 0 && (() => {
            const score = firstMover.score;
            // Small-sample guard: for short windows with < 5 shared topics the score is
            // statistically noisy — show a neutral "Awaiting data" state instead of 0% red.
            const lowSample = firstMover.totalTopics < 5;
            const scoreColor = lowSample ? "#6366f1" : score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#e8312a";
            const scoreLabel = lowSample ? "Small sample" : score >= 70 ? "Leading" : score >= 40 ? "Competitive" : "Following";
            return (
              <Card className="overflow-hidden" style={{ borderColor: scoreColor + "50" }}>
                <CardHeader className="pb-2 pt-4 px-5">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" style={{ color: scoreColor }} />
                    First Mover Score
                    <span className="text-xs font-normal text-muted-foreground">how often StereoNET publishes first on shared topics</span>
                    <InfoTip text="How often StereoNET publishes first on topics covered by multiple sites. Each brand/product in article titles is tracked. When 2+ sites cover the same topic, whoever publishes first wins. Same day = joint first. Score = (first or joint-first wins) ÷ total shared topics × 100. A higher score means you're leading the industry conversation." />
                  </CardTitle>
                </CardHeader>
                <div style={{ background: scoreColor, height: 3, width: `${score}%`, transition: "width 1s ease" }} />
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-6 flex-wrap">
                    {/* Big score */}
                    <div className="flex items-baseline gap-3">
                      <span style={{ fontSize: 56, fontWeight: 900, lineHeight: 1, color: scoreColor, fontVariantNumeric: "tabular-nums" }}>{score}</span>
                      <span className="text-3xl font-bold text-muted-foreground">%</span>
                      <div>
                        <div className="text-lg font-bold" style={{ color: scoreColor }}>{scoreLabel}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{firstMover.firstCount} of {firstMover.totalTopics} shared topics</div>
                        <div className="text-xs text-muted-foreground">first or joint first</div>
                      </div>
                    </div>
                    {/* Topic breakdown table */}
                    <div className="flex-1 max-h-48 overflow-y-auto">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Topic breakdown</div>
                      <div className="space-y-1">
                        {firstMover.topics.slice(0, 20).map(t => (
                          <div key={t.brand} className="flex items-center gap-2 text-xs">
                            <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              t.jointFirst ? "bg-green-500/20 text-green-400" : t.daysBehind <= 2 ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"
                            }`}>
                              {t.jointFirst ? "FIRST" : `+${t.daysBehind}d`}
                            </span>
                            <span className="font-medium truncate flex-1">{t.brand}</span>
                            <span className="text-muted-foreground shrink-0">{t.siteCount} sites</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {scorecard && (
            <Card className="border border-[#e8312a]/30 bg-[#e8312a]/5">
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <span style={{ color: "#e8312a" }}>●</span> StereoNET Scorecard
                    <InfoTip text="Compares StereoNET's publishing output over the last 30 days vs the prior 30 days. Shows total articles, content type breakdown, average per day, and share of voice (StereoNET's percentage of all articles published across all 13 tracked sites). Trend arrows show ▲/▼ vs the prior period — shown only when prior period data is reliable." />
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Last 30 days vs prior 30 days</span>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {([
                    { label: "Articles", cur: scorecard.current.total, prev: scorecard.previous.total },
                    { label: "Reviews", cur: scorecard.current.review, prev: scorecard.previous.review },
                    { label: "News", cur: scorecard.current.news, prev: scorecard.previous.news },
                    { label: "Features", cur: scorecard.current.feature, prev: scorecard.previous.feature },
                    { label: "Opinions", cur: scorecard.current.opinion, prev: scorecard.previous.opinion },
                    { label: "Avg/Day", cur: scorecard.current.avgPerDay, prev: scorecard.previous.avgPerDay },
                    { label: "Share of Voice", cur: scorecard.shareOfVoice.current + "%", prev: scorecard.shareOfVoice.previous + "%", noArrow: true, noisy: Math.abs(scorecard.shareOfVoice.current - scorecard.shareOfVoice.previous) > 20 },
                  ] as any[]).map((m: any) => {
                    const diff = typeof m.cur === "number" && typeof m.prev === "number" ? m.cur - m.prev : 0;
                    const rawPct = typeof m.prev === "number" && m.prev > 0 ? Math.round((diff / m.prev) * 100) : 0;
                    const pct = Math.min(rawPct, 999);
                    // Show "prior data limited" when prior period has very little data or change is implausibly large
                    const priorTooLow = typeof m.prev === "number" && m.prev < 3 && m.label !== "Avg/Day";
                    const noisy = (typeof m.prev === "number" && m.prev === 0) || priorTooLow || Math.abs(rawPct) > 150;
                    const up = diff > 0;
                    const same = diff === 0;
                    return (
                      <div key={m.label} className="bg-card rounded-lg p-3">
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{m.label}</div>
                        <div className="text-xl font-bold text-foreground">{m.cur}</div>
                        {!m.noArrow && !noisy && (
                          <div className={`text-xs mt-0.5 font-medium ${same ? "text-muted-foreground" : up ? "text-green-400" : "text-red-400"}`}>
                            {same ? "—" : (up ? "▲" : "▼")} {same ? "" : Math.abs(pct) + "% vs prior"}
                          </div>
                        )}
                        {!m.noArrow && noisy && <div className="text-xs mt-0.5 text-muted-foreground opacity-50">prior data limited</div>}
                        {m.noArrow && !m.noisy && <div className="text-xs text-muted-foreground mt-0.5">prev: {m.prev}</div>}
                        {m.noisy && <div className="text-xs text-muted-foreground mt-0.5 opacity-50">prior data limited</div>}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
            </div>
          )}

          {/* ── Audience by Region ── */}
          <AudienceRegionsCard />

          {/* ── StereoNET Scorecard ── (now inside the grid above) */}
          {scorecard && false && (
            <Card className="border border-[#e8312a]/30 bg-[#e8312a]/5">
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <span style={{ color: "#e8312a" }}>●</span> StereoNET Scorecard
                    <InfoTip text="Compares StereoNET's publishing output over the last 30 days vs the prior 30 days. Shows total articles, content type breakdown, average per day, and share of voice (StereoNET's percentage of all articles published across all 13 tracked sites). Trend arrows show ▲/▼ vs the prior period — shown only when prior period data is reliable." />
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">Last 30 days vs prior 30 days</span>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  {([
                    { label: "Articles", cur: scorecard.current.total, prev: scorecard.previous.total },
                    { label: "Reviews", cur: scorecard.current.review, prev: scorecard.previous.review },
                    { label: "News", cur: scorecard.current.news, prev: scorecard.previous.news },
                    { label: "Features", cur: scorecard.current.feature, prev: scorecard.previous.feature },
                    { label: "Opinions", cur: scorecard.current.opinion, prev: scorecard.previous.opinion },
                    { label: "Avg/Day", cur: scorecard.current.avgPerDay, prev: scorecard.previous.avgPerDay },
                    { label: "Share of Voice", cur: scorecard.shareOfVoice.current + "%", prev: scorecard.shareOfVoice.previous + "%", noArrow: true, noisy: Math.abs(scorecard.shareOfVoice.current - scorecard.shareOfVoice.previous) > 20 },
                  ] as any[]).map((m: any) => {
                    const diff = typeof m.cur === "number" && typeof m.prev === "number" ? m.cur - m.prev : 0;
                    const rawPct = typeof m.prev === "number" && m.prev > 0 ? Math.round((diff / m.prev) * 100) : 0;
                    const pct = Math.min(rawPct, 999);
                    // Mark as noisy if prior is 0 (no baseline) or swing > 500%
                    const noisy = (typeof m.prev === "number" && m.prev === 0) || Math.abs(rawPct) > 500;
                    const up = diff > 0;
                    const same = diff === 0;
                    return (
                      <div key={m.label} className="bg-card rounded-lg p-3">
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{m.label}</div>
                        <div className="text-xl font-bold text-foreground">{m.cur}</div>
                        {!m.noArrow && !noisy && (
                          <div className={`text-xs mt-0.5 font-medium ${same ? "text-muted-foreground" : up ? "text-green-400" : "text-red-400"}`}>
                            {same ? "—" : (up ? "▲" : "▼")} {same ? "" : Math.abs(pct) + "% vs prior"}
                          </div>
                        )}
                        {!m.noArrow && noisy && (
                          <div className="text-xs mt-0.5 text-muted-foreground opacity-50">prior data limited</div>
                        )}
                        {m.noArrow && !m.noisy && <div className="text-xs text-muted-foreground mt-0.5">prev: {m.prev}</div>}
                        {m.noisy && <div className="text-xs text-muted-foreground mt-0.5 opacity-50">prior data limited</div>}
                      </div>
                    );
                  })}
                </div>

              </CardContent>
            </Card>
          )}

          {/* ── Top Authors ── */}
          <Card className="border border-[#e8312a]/30">
            <CardHeader className="pb-3 pt-4 px-5">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-bold text-foreground flex items-center gap-2">
                  <Newspaper className="w-5 h-5 text-red-400" />
                  Top Authors
                  <InfoTip text="Ranks StereoNET writers by article count in the selected period. Data comes from the RSS feed's author byline — articles without attribution are not counted." />
                </CardTitle>
                <div className="flex rounded-md overflow-hidden border border-border text-xs">
                  {([3, 7, 14, 30] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setAuthorPeriod(p)}
                      className={`px-2.5 py-1.5 transition-colors font-medium ${
                        authorPeriod === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p}d
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {authors.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No author data yet — articles will appear automatically once fetched.
                </p>
              ) : (
                <div className="space-y-3">
                  {authors.map((row, i) => {
                    const max = authors[0]?.count ?? 1;
                    const pct = Math.round((row.count / max) * 100);
                    const isTop = i === 0;
                    const streak = authorStreaks.find(s => s.author === row.author)?.streak ?? 0;
                    // Weekly data for sparkline
                    const weeklyForAuthor = authorWeekly.filter(w => w.author === row.author);
                    const weeks = [...new Set(authorWeekly.map(w => w.week))].sort();
                    const sparkData = weeks.map(w => weeklyForAuthor.find(ww => ww.week === w)?.count ?? 0);
                    const sparkMax = Math.max(...sparkData, 1);
                    return (
                      <div key={row.author} className={`flex items-center gap-4`}>
                        <span className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm ${
                          isTop ? "bg-[#e8312a] text-white" : "bg-muted text-muted-foreground"
                        }`}>{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 truncate">
                              <span className={`font-semibold truncate ${isTop ? "text-lg text-foreground" : "text-sm text-foreground"}`}>{row.author}</span>
                              {streak > 0 && (
                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                  streak >= 10 ? "bg-[#e8312a]/20 text-[#e8312a]" : streak >= 5 ? "bg-[#f97316]/20 text-[#f97316]" : "bg-muted text-muted-foreground"
                                }`}>
                                  {streak}d{streak >= 10 ? " ⚡" : streak >= 5 ? " 🔥" : ""}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              {/* Sparkline */}
                              {sparkData.length > 1 && (
                                <svg width="48" height="16" className="shrink-0">
                                  {sparkData.map((v, j) => (
                                    <rect
                                      key={j}
                                      x={j * (48 / sparkData.length)}
                                      y={16 - (v / sparkMax) * 16}
                                      width={Math.max(1, 48 / sparkData.length - 1)}
                                      height={(v / sparkMax) * 16}
                                      fill={isTop ? "#e8312a" : "#6b7280"}
                                      opacity={0.7}
                                    />
                                  ))}
                                </svg>
                              )}
                              <span className={`tabular-nums font-bold ${isTop ? "text-2xl text-[#e8312a]" : "text-base text-muted-foreground"}`}>{row.count}</span>
                            </div>
                          </div>
                          <div className="bg-muted rounded-full h-2 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: isTop ? "#e8312a" : "#6b7280" }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Community & Classifieds block moved to the Analytics page —
              merged into the New Classifieds Ads card so all forum + classifieds
              stats live in one place. */}

          {/* ── Content Gap Detector / Review Gaps (removed per editorial request, May 2026) ── */}
          {false && contentGaps.length > 0 && (
            <Card className="border border-amber-500/30">
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/20 flex items-center justify-center text-amber-400 text-xs font-black">!</span>
                    Review Gaps
                    <InfoTip text="Products reviewed by 2 or more competitor sites but not yet reviewed by StereoNET. These are direct assignment opportunities -- your competitors have covered them and you haven't. Ranked by number of competitor reviews." />
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">{contentGaps.length} products to consider</span>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="space-y-3 max-h-80 overflow-y-auto">
                  {contentGaps.map((gap, i) => (
                    <div key={gap.brand} className="flex items-start gap-3">
                      <span className="text-xs text-muted-foreground w-5 text-right shrink-0 mt-1">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-bold text-amber-400">{gap.brand}</span>
                          <span className="text-[11px] text-muted-foreground">{gap.siteCount} competitor{gap.siteCount !== 1 ? 's' : ''} reviewed</span>
                        </div>
                        <div className="space-y-0.5">
                          {gap.competitorReviews.slice(0, 4).map((r, j) => {
                            const siteColor = sites.find(s => s.key === r.site)?.color ?? "#6b7280";
                            const siteLabel = sites.find(s => s.key === r.site)?.label ?? r.site;
                            return (
                              <a key={j} href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs hover:text-foreground transition-colors group">
                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: siteColor }} />
                                <span style={{ color: siteColor }} className="shrink-0 font-medium">{siteLabel}</span>
                                <span className="text-muted-foreground truncate group-hover:text-foreground">{r.title}</span>
                                <span className="text-muted-foreground shrink-0">{r.date}</span>
                              </a>
                            );
                          })}
                          {gap.competitorReviews.length > 4 && (
                            <span className="text-[10px] text-muted-foreground">+{gap.competitorReviews.length - 4} more</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── KPI Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {statsLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}><CardContent className="p-4"><Skeleton className="h-14 w-full" /></CardContent></Card>
              ))
            ) : (
              <>
                <KpiCard label="Total Articles" value={stats?.totalInRange ?? "–"} sub={dateRange <= 2 ? `last ${dateRange * 24} hours` : `last ${dateRange} days`} icon={Newspaper} color="text-red-400" />
                <KpiCard label="Avg Per Day" value={(stats as any)?.snAvgPerDay ?? "–"} sub="StereoNET only" icon={TrendingUp} color="text-orange-400" />
                <KpiCard
                  label="Most Active"
                  value={
                    activeSite !== "all"
                      ? (sites.find(s => s.key === activeSite)?.label ?? activeSite)
                      : (stats?.topSite ? (sites.find(s => s.key === stats.topSite!.site)?.label ?? stats.topSite.site) : "–")
                  }
                  sub={
                    activeSite !== "all"
                      ? `${stats?.totalInRange ?? 0} articles`
                      : (stats?.topSite ? `${stats.topSite.count} articles` : undefined)
                  }
                  icon={BarChart3}
                  color="text-orange-400"
                />
                <KpiCard label="Days Tracked" value={stats?.daysTracked ?? "–"} sub={`${fromDate} → ${toDate}`} icon={Calendar} color="text-orange-400" />
              </>
            )}
          </div>

          {/* ── Type totals pills ── */}
          {!statsLoading && stats?.typeTotals && (
            <div className="flex items-center gap-2 flex-wrap fade-up">
              <span className="text-xs text-muted-foreground">Breakdown:</span>
              {(["review", "news", "feature", "opinion"] as const).map(type => (
                <button
                  key={type}
                  data-testid={`type-pill-${type}`}
                  onClick={() => setActiveType(activeType === type ? "all" : type)}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium transition-all border ${
                    activeType === type ? "border-current" : "border-transparent"
                  }`}
                  style={{ background: `${TYPE_COLORS[type]}18`, color: TYPE_COLORS[type] }}
                >
                  {TYPE_LABELS[type]}
                  <span className="opacity-70 tabular-nums">{stats.typeTotals[type]}</span>
                </button>
              ))}
            </div>
          )}

          {/* ── WoW Trend ── */}
          {siteWoW[activeSite] && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-orange-400" />
                  Publishing Trend
                  <InfoTip text="Compares the first half of your selected date range against the second half. A positive % means publishing output is accelerating in the more recent period. Negative means it's slowing down. Requires at least 14 days selected to show." />
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="flex items-center gap-6">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Recent half of range</div>
                    <div className="text-2xl font-bold">{siteWoW[activeSite].current}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Earlier half</div>
                    <div className="text-2xl font-bold text-muted-foreground">{siteWoW[activeSite].previous}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Trend</div>
                    <div className={`text-2xl font-bold ${siteWoW[activeSite].pct > 0 ? "text-green-400" : siteWoW[activeSite].pct < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                      {siteWoW[activeSite].pct > 0 ? "▲" : siteWoW[activeSite].pct < 0 ? "▼" : "—"} {Math.abs(siteWoW[activeSite].pct)}%
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Heatmap ── */}
          {heatmapData.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-orange-400" />
                    Day-of-Week Publishing Patterns
                    <InfoTip text="Shows how many articles are published on each day of the week across all tracked sites. Combined view shows total industry output per day. Per Site view shows a heatmap row per publication — darker colour means more articles published on that day. Useful for spotting weekday vs weekend publishing patterns." />
                  </CardTitle>
                  <div className="flex rounded-md overflow-hidden border border-border text-xs">
                    {(["combined", "persite"] as const).map(v => (
                      <button key={v} onClick={() => setHeatmapView(v)}
                        className={`px-2 py-1 transition-colors ${heatmapView === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                        {v === "combined" ? "Combined" : "Per Site"}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                {(() => {
                  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                  if (heatmapView === "combined") {
                    const totals = DAYS.map((_, dow) => heatmapData.filter(r => r.dow === dow).reduce((s, r) => s + r.count, 0));
                    const max = Math.max(...totals, 1);
                    return (
                      <div className="flex gap-2">
                        {DAYS.map((day, dow) => (
                          <div key={day} className="flex-1 flex flex-col items-center gap-1">
                            <div className="w-full rounded" style={{ height: 80, background: `rgba(232,49,42,${0.15 + 0.85 * totals[dow] / max})` }} title={`${totals[dow]} articles`} />
                            <span className="text-[10px] text-muted-foreground">{day}</span>
                            <span className="text-xs font-medium">{totals[dow]}</span>
                          </div>
                        ))}
                      </div>
                    );
                  } else {
                    const siteKeys = [...new Set(heatmapData.map(r => r.site))];
                    return (
                      <div className="space-y-3 overflow-x-auto">
                        {siteKeys.map(sk => {
                          const siteLabel = sites.find(s => s.key === sk)?.label ?? sk;
                          const siteColor = sites.find(s => s.key === sk)?.color ?? "#e8312a";
                          const rows = DAYS.map((_, dow) => heatmapData.find(r => r.site === sk && r.dow === dow)?.count ?? 0);
                          const max = Math.max(...rows, 1);
                          return (
                            <div key={sk} className="flex items-center gap-2">
                              <span className="text-xs w-28 shrink-0 truncate" style={{ color: siteColor }}>{siteLabel}</span>
                              <div className="flex gap-1 flex-1">
                                {DAYS.map((day, dow) => (
                                  <div key={day} className="flex-1 rounded" style={{ height: 20, background: `${siteColor}${Math.round(40 + 180 * rows[dow] / max).toString(16).padStart(2,"0")}` }} title={`${day}: ${rows[dow]}`} />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                        <div className="flex gap-1 pl-30">
                          {DAYS.map(d => <div key={d} className="flex-1 text-center text-[9px] text-muted-foreground">{d}</div>)}
                        </div>
                      </div>
                    );
                  }
                })()}
              </CardContent>
            </Card>
          )}

          {/* ── Daily chart ── */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-red-400" />
                  Articles per Day
                </CardTitle>
                <div className="flex items-center gap-1.5">
                  {/* Chart type toggle */}
                  <div className="flex rounded-md border border-border overflow-hidden">
                    {(["bar", "line"] as const).map(ct => (
                      <button
                        key={ct}
                        data-testid={`chart-type-${ct}`}
                        onClick={() => setChartType(ct)}
                        className={`px-3 py-1 text-xs font-medium transition-colors capitalize ${
                          chartType === ct
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {ct}
                      </button>
                    ))}
                  </div>
                  {/* Break by type toggle */}
                  <button
                    data-testid="toggle-by-type"
                    onClick={() => setShowByType(!showByType)}
                    className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border transition-colors ${
                      showByType
                        ? "bg-primary/20 border-primary/50 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Filter className="w-3 h-3" />
                    By type
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-56" data-testid="daily-chart">
                {dailyLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <DailyChart
                    daily={filledDaily}
                    chartType={chartType}
                    showByType={showByType}
                    activeSite={activeSite}
                    sites={sites}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Per-site breakdown bar chart ── */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-5">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-orange-400" />
                Site Breakdown by Content Type
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-96" data-testid="breakdown-chart">
                {breakdown.length > 0 ? (
                  <SiteBreakdownChart breakdown={breakdown} sites={sites} />
                ) : (
                  <Skeleton className="h-full w-full" />
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Author Output Over Time ── */}
          {authorWeekly.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-orange-400" />
                    StereoNET Author Output Over Time
                    <InfoTip text="Shows each StereoNET writer's weekly article count. Stacked bar view shows total team output with each author's share colour-coded. Line view tracks individual writers over time. Data comes from the RSS feed's author field — articles without a byline aren't counted. Feeds auto-refresh every 15 minutes." />
                  </CardTitle>
                  <div className="flex rounded-md overflow-hidden border border-border text-xs">
                    {(["bar", "line"] as const).map(v => (
                      <button key={v} onClick={() => setAuthorChartType(v)}
                        className={`px-2 py-1 transition-colors capitalize ${authorChartType === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                        {v === "bar" ? "Bar" : "Line"}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="h-56">
                  {authorChartType === "bar"
                    ? <Bar data={authorWeeklyChartData} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#94a3b8", font: { size: 11 } } } }, scales: { x: { stacked: true, ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { display: false } }, y: { stacked: true, ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.06)" } } } }} />
                    : <Line data={authorWeeklyChartData} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#94a3b8", font: { size: 11 } } } }, scales: { x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.06)" } } } }} />
                  }
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Brand Coverage (removed per editorial request, May 2026) ── */}
          {false && brandsData.length > 0 && (() => {
            // Partition: brands StereoNET covers vs hot brands we're missing
            const covered = brandsData.filter(r => "stereonet" in JSON.parse(r.sites)).slice(0, 10);
            const gaps = brandsData.filter(r => !("stereonet" in JSON.parse(r.sites)) && JSON.parse(r.sites) && Object.keys(JSON.parse(r.sites)).length >= 2).slice(0, 10);
            const maxTotal = Math.max(1, ...brandsData.slice(0, 20).map(r => r.total));
            return (
              <Card>
                <CardHeader className="pb-2 pt-4 px-5">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-red-400" />
                    Brand Coverage
                    <span className="text-xs font-normal text-muted-foreground">who StereoNET is covering vs industry gaps</span>
                    <InfoTip text="Left column: brands StereoNET has covered in this date range, ranked by how widely the industry is also discussing them. Right column: brands multiple competitors are covering but StereoNET hasn't — potential gaps. Brand names are extracted automatically from article titles." />
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-5 pb-5">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* StereoNET's coverage */}
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="w-2 h-2 rounded-full bg-[#e8312a]" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          StereoNET is covering
                        </span>
                      </div>
                      <div className="space-y-2">
                        {covered.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic">No covered brands yet in this range</div>
                        ) : covered.map(row => {
                          const sitesObj: Record<string, number> = JSON.parse(row.sites);
                          const otherSites = Object.keys(sitesObj).filter(k => k !== "stereonet").length;
                          return (
                            <div key={row.brand} className="group">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-sm font-medium text-foreground truncate">{row.brand}</span>
                                <span className="text-[10px] text-muted-foreground shrink-0">{otherSites === 0 ? "exclusive" : `+${otherSites} competitor${otherSites === 1 ? "" : "s"}`}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full bg-[#e8312a]" style={{ width: `${Math.round((row.total / maxTotal) * 100)}%` }} />
                                </div>
                                <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right">{row.total}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* Gaps */}
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Coverage gaps (2+ competitors, not on StereoNET)
                        </span>
                      </div>
                      <div className="space-y-2">
                        {gaps.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic">No significant gaps detected 🎉</div>
                        ) : gaps.map(row => {
                          const sitesObj: Record<string, number> = JSON.parse(row.sites);
                          const siteCount = Object.keys(sitesObj).length;
                          return (
                            <div key={row.brand}>
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-sm font-medium text-foreground truncate">{row.brand}</span>
                                <span className="text-[10px] text-amber-400 shrink-0">{siteCount} competitors</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.round((row.total / maxTotal) * 100)}%` }} />
                                </div>
                                <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right">{row.total}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Topic Overlap + Exclusives (hidden — rolled into Brand Coverage) ── */}
          {false && topicsData.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Filter className="w-4 h-4 text-orange-400" />
                    Topic Coverage
                    <InfoTip text="Two views: Industry Overlap shows brands/products covered by 2 or more publications — where the whole industry is focused. StereoNET Only shows brands covered exclusively by StereoNET — potential exclusives, niche expertise, or topics competitors haven't noticed yet. Coloured dots show which sites covered each topic." />
                  </CardTitle>
                  <div className="flex rounded-md overflow-hidden border border-border text-xs">
                    {(["overlap", "exclusive"] as const).map(v => (
                      <button key={v} onClick={() => setTopicsFilter(v)}
                        className={`px-2 py-1 transition-colors ${topicsFilter === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                        {v === "overlap" ? "Industry Overlap" : "StereoNET Only"}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                  {topicsData
                    .filter(r => topicsFilter === "exclusive" ? r.stereonet_only === 1 : r.site_count > 1)
                    .slice(0, 40)
                    .map((row, i) => {
                      const siteKeys = row.sites.split(",");
                      return (
                        <div key={row.brand} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
                          <span className="text-sm font-medium flex-1 truncate">{row.brand}</span>
                          {topicsFilter === "overlap" && (
                            <span className="text-xs text-muted-foreground shrink-0">{row.site_count} sites</span>
                          )}
                          <span className="text-xs tabular-nums text-muted-foreground w-8 text-right shrink-0">{row.article_count} arts</span>
                          <div className="flex gap-0.5 shrink-0">
                            {siteKeys.map(sk => (
                              <span key={sk} className="w-1.5 h-1.5 rounded-full" style={{ background: sites.find(s => s.key === sk)?.color ?? "#6b7280" }} title={sk} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
                {topicsFilter === "overlap" && (
                  <p className="text-xs text-muted-foreground mt-2">Brands covered by 2+ publications in this date range.</p>
                )}
                {topicsFilter === "exclusive" && (
                  <p className="text-xs text-muted-foreground mt-2">Brands only StereoNET is covering — potential exclusives or niche coverage.</p>
                )}
              </CardContent>
            </Card>
          )}


        </div>
      </main>
    </div>
  );
}

// ─── Audience by Region (this month vs last month) ───────────────────────────────────
function AudienceRegionsCard() {
  // Brisbane-anchored date strings for GA4 API (UTC but close enough)
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthAgoIso = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const prevMonthStart = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const prevMonthEnd = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);

  const { data: current, isLoading: loadingCurrent } = useQuery<{ region: string; users: number; sessions: number }[]>({
    queryKey: ["/api/analytics/regions", "this-month", monthAgoIso, todayIso],
    queryFn: () => apiRequest("GET", `/api/analytics/regions?startDate=${monthAgoIso}&endDate=${todayIso}`).then(r => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  const { data: previous } = useQuery<{ region: string; users: number; sessions: number }[]>({
    queryKey: ["/api/analytics/regions", "last-month", prevMonthStart, prevMonthEnd],
    queryFn: () => apiRequest("GET", `/api/analytics/regions?startDate=${prevMonthStart}&endDate=${prevMonthEnd}`).then(r => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  // Combine target regions (take any that exist in current data; fallback to known set)
  const TARGETS = [
    { key: "Americas", icon: "\ud83c\udf0e", color: "#e8312a" },
    { key: "UK & Europe", icon: "\ud83c\uddec\ud83c\udde7", color: "#6366f1" },
    { key: "Asia", icon: "\ud83c\udf0f", color: "#22c55e" },
    { key: "Australia/NZ/Pacific", icon: "\ud83c\udde6\ud83c\uddfa", color: "#eab308" },
  ];

  const currentMap = new Map((current || []).map(r => [r.region, r.users]));
  const prevMap = new Map((previous || []).map(r => [r.region, r.users]));
  const totalCurrent = (current || []).reduce((s, r) => s + r.users, 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-sky-400" />
            Audience by Region
            <span className="text-xs font-normal text-muted-foreground">monthly unique users · vs prior 30 days</span>
          </CardTitle>
          {totalCurrent > 0 && (
            <div className="text-xs text-muted-foreground">
              Total <span className="font-bold text-foreground tabular-nums">{totalCurrent.toLocaleString()}</span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {loadingCurrent ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {TARGETS.map(t => {
              const curr = currentMap.get(t.key) || 0;
              const prev = prevMap.get(t.key) || 0;
              const deltaPct = prev > 0 ? Math.round(((curr - prev) / prev) * 100) : null;
              const up = deltaPct != null && deltaPct > 2;
              const down = deltaPct != null && deltaPct < -2;
              const flat = deltaPct != null && !up && !down;
              const trendColor = up ? "#22c55e" : down ? "#e8312a" : "#6b7280";
              return (
                <div
                  key={t.key}
                  className="relative rounded-lg border border-border bg-gradient-to-br from-muted/30 to-transparent p-4 overflow-hidden"
                >
                  <div className="absolute top-0 left-0 h-[3px]" style={{ background: t.color, width: `${Math.max(5, Math.round((curr / Math.max(1, totalCurrent)) * 100))}%` }} />
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg leading-none">{t.icon}</span>
                      <span className="text-xs font-semibold text-foreground uppercase tracking-wide">{t.key.replace(" & ", "/")}</span>
                    </div>
                  </div>
                  <div className="text-2xl sm:text-3xl font-black text-foreground tabular-nums leading-none mb-2">
                    {curr.toLocaleString()}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    {deltaPct == null ? (
                      <span className="text-muted-foreground italic">no prior data</span>
                    ) : (
                      <>
                        {up && <ArrowUpRight className="w-3.5 h-3.5" style={{ color: trendColor }} />}
                        {down && <ArrowDownRight className="w-3.5 h-3.5" style={{ color: trendColor }} />}
                        {flat && <Minus className="w-3.5 h-3.5" style={{ color: trendColor }} />}
                        <span className="font-semibold tabular-nums" style={{ color: trendColor }}>
                          {deltaPct > 0 ? "+" : ""}{deltaPct}%
                        </span>
                        <span className="text-muted-foreground">vs prior 30d</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
