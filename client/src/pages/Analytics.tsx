import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Users, Activity, Eye, Clock, TrendingDown, UserPlus,
  MousePointerClick, Search, Globe, BarChart2,
  TrendingUp, Minus, Info, MapPin, Monitor, Smartphone, Tablet, Tag,
  Image, Newspaper, Compass, Sparkles, Shield, Cloud, Server, Zap,
} from "lucide-react";
import { Line, Bar, Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  Title, Tooltip, Legend, Filler, ArcElement,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler, ArcElement);

// ─── Types ──────────────────────────────────────────────────────────────────
interface OverviewData {
  activeUsers: number;
  sessions: number;
  pageviews: number;
  avgSessionDuration: number;
  bounceRate: number;
  newUsers: number;
}
interface OverviewResponse { current: OverviewData | null; prior: OverviewData | null; }
interface DailyRow { date: string; users: number; sessions: number; pageviews: number; }
interface TopPage { path: string; pageviews: number; users: number; }
interface SourceRow { channel: string; sessions: number; users: number; }
interface CountryRow { country: string; users: number; }
interface RegionRow { region: string; users: number; sessions: number; }
interface DeviceRow { device: string; users: number; sessions: number; pageviews: number; }
interface SearchQuery { query: string; clicks: number; impressions: number; ctr: number; position: number; }
interface SearchPage { page: string; clicks: number; impressions: number; ctr: number; position: number; }
interface SearchDaily { date: string; clicks: number; impressions: number; ctr: number; position: number; }
interface SCDeviceRow { device: string; clicks: number; impressions: number; ctr: number; position: number; }
interface SCAppearanceRow { appearance: string; clicks: number; impressions: number; ctr: number; position: number; }
interface SCTypeRow { type: string; clicks: number; impressions: number; ctr: number; position: number; }

// ─── Helpers ────────────────────────────────────────────────────────────────
function nDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function today(): string { return new Date().toISOString().slice(0, 10); }
function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0m 0s";
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
function shortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
function truncatePath(path: string, max = 40): string {
  if (path.length <= max) return path;
  return "…" + path.slice(-(max - 1));
}
function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
function formatAppearanceName(raw: string): string {
  // Convert SCREAMING_SNAKE to Title Case
  return raw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\bRichresult\b/i, "Rich Result");
}

const CHART_GRID = "rgba(255,255,255,0.05)";
const TICK_COLOR = "rgba(255,255,255,0.4)";
const DATE_RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "28d", days: 28 },
  { label: "90d", days: 90 },
];

const REGION_COLORS: Record<string, string> = {
  "Americas": "#e8312a",
  "UK & Europe": "#6366f1",
  "Australia/NZ/Pacific": "#eab308",
  "Asia": "#22c55e",
  "Middle East": "#f97316",
  "Africa": "#14b8a6",
  // Legacy fallbacks
  "North America": "#e8312a", "UK/Europe": "#6366f1", "Australia/NZ": "#eab308", "Other": "#6b7280",
};
const REGION_ICONS: Record<string, string> = {
  "Americas": "🌎",
  "UK & Europe": "🇬🇧",
  "Australia/NZ/Pacific": "🇦🇺",
  "Asia": "🌏",
  "Middle East": "🕌",
  "Africa": "🏝️",
  // Legacy fallbacks
  "North America": "🇺🇸", "UK/Europe": "🇬🇧", "Australia/NZ": "🇦🇺", "Other": "🌍",
};
const DEVICE_COLORS: Record<string, string> = {
  desktop: "#6366f1", mobile: "#e8312a", tablet: "#eab308",
  DESKTOP: "#6366f1", MOBILE: "#e8312a", TABLET: "#eab308",
};
const DEVICE_ICONS: Record<string, any> = {
  desktop: <Monitor className="w-4 h-4" />, mobile: <Smartphone className="w-4 h-4" />, tablet: <Tablet className="w-4 h-4" />,
  DESKTOP: <Monitor className="w-4 h-4" />, MOBILE: <Smartphone className="w-4 h-4" />, TABLET: <Tablet className="w-4 h-4" />,
};
const SEARCH_TYPE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  web: { label: "Web Search", icon: <Search className="w-4 h-4" />, color: "#e8312a" },
  image: { label: "Image Search", icon: <Image className="w-4 h-4" />, color: "#22c55e" },
  news: { label: "Google News", icon: <Newspaper className="w-4 h-4" />, color: "#6366f1" },
  discover: { label: "Discover", icon: <Compass className="w-4 h-4" />, color: "#f97316" },
};

// ─── Tooltip component ──────────────────────────────────────────────────────
function KpiTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block ml-1">
      <Info
        className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(s => !s)}
      />
      {show && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg bg-popover border border-border text-xs text-popover-foreground shadow-xl w-56 leading-relaxed pointer-events-none">
          {text}
        </span>
      )}
    </span>
  );
}

// ─── Trend badge ────────────────────────────────────────────────────────────
function TrendBadge({ current, prior, invert = false }: { current: number; prior: number; invert?: boolean }) {
  if (!prior || prior === 0) return null;
  const pctChange = ((current - prior) / prior) * 100;
  const absChange = Math.abs(pctChange);
  if (absChange < 0.5) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground ml-1">
        <Minus className="w-3 h-3" />
        <span>{absChange.toFixed(1)}%</span>
      </span>
    );
  }
  const isUp = pctChange > 0;
  const isPositive = invert ? !isUp : isUp;
  const color = isPositive ? "text-emerald-400" : "text-red-400";
  const Icon = isUp ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] ${color} ml-1`}>
      <Icon className="w-3 h-3" />
      <span>{absChange.toFixed(1)}%</span>
    </span>
  );
}

const KPI_TOOLTIPS: Record<string, string> = {
  "Active Users": "Users who had an engaged session or visited the site. Not the same as unique users — GA4 counts users who triggered any event, including returning visitors within the period.",
  "Sessions": "Total number of visits. A session starts when a user opens the site and ends after 30 minutes of inactivity or at midnight.",
  "Pageviews": "Total number of pages viewed, including repeated views of the same page by the same user.",
  "Avg Session Duration": "Average time users spend per session. Only counts engaged sessions where the site was in the foreground.",
  "Bounce Rate": "Percentage of sessions that were not engaged — the user left within 10 seconds, viewed only one page, or triggered no conversion events.",
  "New Users": "First-time visitors who have never been seen before by GA4 (based on device/browser cookie).",
};

// ─── Component ──────────────────────────────────────────────────────────────
export default function Analytics() {
  const [dateRange, setDateRange] = useState("90");
  const days = parseInt(dateRange, 10);
  const { startDate, endDate } = useMemo(() => ({ startDate: nDaysAgo(days), endDate: today() }), [days]);
  const { priorStart, priorEnd } = useMemo(() => ({ priorStart: nDaysAgo(days * 2), priorEnd: nDaysAgo(days + 1) }), [days]);

  // Bot filtering now happens upstream at the Cloudflare edge (firewall rules + bot management),
  // so the in-app bot-country exclusion is no longer needed.
  const qp = `?startDate=${startDate}&endDate=${endDate}`;
  const qpFull = `${qp}&priorStart=${priorStart}&priorEnd=${priorEnd}`;

  // ── Data queries ──────────────────────────────────────────────────────────
  const { data: overviewResp, isLoading: overviewLoading } = useQuery<OverviewResponse>({
    queryKey: ["/api/analytics/overview", startDate, endDate, priorStart, priorEnd],
    queryFn: () => apiRequest("GET", `/api/analytics/overview${qpFull}`).then(r => r.json()),
  });
  const overview = overviewResp?.current ?? null;
  const priorOverview = overviewResp?.prior ?? null;

  const { data: daily = [], isLoading: dailyLoading } = useQuery<DailyRow[]>({
    queryKey: ["/api/analytics/daily", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/daily${qp}`).then(r => r.json()),
  });
  const { data: topPages = [] } = useQuery<TopPage[]>({
    queryKey: ["/api/analytics/top-pages", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/top-pages${qp}`).then(r => r.json()),
  });
  const { data: sources = [] } = useQuery<SourceRow[]>({
    queryKey: ["/api/analytics/sources", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/sources${qp}`).then(r => r.json()),
  });
  const { data: countries = [] } = useQuery<CountryRow[]>({
    queryKey: ["/api/analytics/countries", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/countries${qp}`).then(r => r.json()),
  });
  const { data: regions = [] } = useQuery<RegionRow[]>({
    queryKey: ["/api/analytics/regions", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/regions${qp}`).then(r => r.json()),
  });
  const { data: devices = [] } = useQuery<DeviceRow[]>({
    queryKey: ["/api/analytics/devices", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/devices${qp}`).then(r => r.json()),
  });
  const { data: searchQueries = [] } = useQuery<SearchQuery[]>({
    queryKey: ["/api/analytics/search-queries", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-queries${qp}`).then(r => r.json()),
  });
  const { data: searchPages = [] } = useQuery<SearchPage[]>({
    queryKey: ["/api/analytics/search-pages", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-pages${qp}`).then(r => r.json()),
  });
  const { data: searchDaily = [] } = useQuery<SearchDaily[]>({
    queryKey: ["/api/analytics/search-daily", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-daily${qp}`).then(r => r.json()),
  });
  const { data: scDevices = [] } = useQuery<SCDeviceRow[]>({
    queryKey: ["/api/analytics/search-devices", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-devices${qp}`).then(r => r.json()),
  });
  const { data: scAppearance = [] } = useQuery<SCAppearanceRow[]>({
    queryKey: ["/api/analytics/search-appearance", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-appearance${qp}`).then(r => r.json()),
  });

  // Classifieds + community stats. The endpoint derives new-ad windows from
  // forum_stats snapshots (no external DB) and also surfaces the rich latest
  // snapshot fields (active_ads, total_sales_14d, total_ads_value, topics,
  // posts) that previously lived in the Dashboard's Community & Classifieds card.
  const { data: classifieds } = useQuery<{
    ads?: {
      active?: number | null;
      total?: number | null;
      successful_sales?: number | null;
      total_sales_14d?: string | null;
      total_ads_value?: string | null;
      active_delta_hourly?: number | null;
      successful_sales_delta_hourly?: number | null;
      new_1d?: number | null; prev_1d?: number | null;
      new_7d?: number | null; prev_7d?: number | null;
      new_30d?: number | null; prev_30d?: number | null;
      fetched_at?: string;
    };
    forum?: { total_topics?: string | null; total_posts?: string | null; total_members?: string | null };
  }>({
    queryKey: ["/api/analytics/classifieds"],
    queryFn: () => apiRequest("GET", "/api/analytics/classifieds").then(r => r.json()),
    refetchInterval: 5 * 60_000,
  });
  const { data: scTypes = [] } = useQuery<SCTypeRow[]>({
    queryKey: ["/api/analytics/search-types", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/search-types${qp}`).then(r => r.json()),
  });

  // ─── Chart data ───────────────────────────────────────────────────────────
  const trafficChartData = useMemo(() => ({
    labels: daily.map(d => shortDate(d.date)),
    datasets: [
      { label: "Users", data: daily.map(d => d.users), borderColor: "#e8312a", backgroundColor: "rgba(232,49,42,0.08)", pointRadius: 2, tension: 0.3, fill: false, borderWidth: 2 },
      { label: "Sessions", data: daily.map(d => d.sessions), borderColor: "#eab308", backgroundColor: "rgba(234,179,8,0.08)", pointRadius: 2, tension: 0.3, fill: false, borderWidth: 2 },
      { label: "Pageviews", data: daily.map(d => d.pageviews), borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.08)", pointRadius: 2, tension: 0.3, fill: false, borderWidth: 2 },
    ],
  }), [daily]);

  const lineOpts = useMemo(() => ({
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "top" as const, labels: { color: TICK_COLOR, boxWidth: 12, padding: 16, font: { size: 11 } } },
      tooltip: { mode: "index" as const, intersect: false },
    },
    scales: {
      x: { grid: { color: CHART_GRID }, ticks: { color: TICK_COLOR, maxTicksLimit: 10, font: { size: 10 } }, border: { color: CHART_GRID } },
      y: { grid: { color: CHART_GRID }, ticks: { color: TICK_COLOR, font: { size: 10 } }, border: { color: CHART_GRID } },
    },
  }), []);

  const sourcesChartData = useMemo(() => {
    const sorted = [...sources].sort((a, b) => b.sessions - a.sessions).slice(0, 8);
    const CC: Record<string, string> = { "Organic Search": "#e8312a", Direct: "#eab308", Social: "#6366f1", Referral: "#22c55e", Email: "#f97316", "Paid Search": "#a855f7", Display: "#06b6d4", "Organic Social": "#ec4899" };
    return {
      labels: sorted.map(s => s.channel),
      datasets: [{ label: "Sessions", data: sorted.map(s => s.sessions), backgroundColor: sorted.map(s => (CC[s.channel] || "#6b7280") + "cc"), borderColor: sorted.map(s => CC[s.channel] || "#6b7280"), borderWidth: 1, borderRadius: 4 }],
    };
  }, [sources]);

  const hBarOpts = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, indexAxis: "y" as const,
    plugins: { legend: { display: false }, tooltip: { mode: "index" as const, intersect: false } },
    scales: {
      x: { grid: { color: CHART_GRID }, ticks: { color: TICK_COLOR, font: { size: 10 } }, border: { color: CHART_GRID } },
      y: { grid: { display: false }, ticks: { color: TICK_COLOR, font: { size: 11 } }, border: { color: "transparent" } },
    },
  }), []);

  const searchChartData = useMemo(() => ({
    labels: searchDaily.map(d => shortDate(d.date)),
    datasets: [
      { label: "Clicks", data: searchDaily.map(d => d.clicks), borderColor: "#e8312a", backgroundColor: "rgba(232,49,42,0.08)", pointRadius: 2, tension: 0.3, fill: false, borderWidth: 2, yAxisID: "y" },
      { label: "Impressions", data: searchDaily.map(d => d.impressions), borderColor: "#6366f1", backgroundColor: "rgba(99,102,241,0.08)", pointRadius: 2, tension: 0.3, fill: false, borderWidth: 2, yAxisID: "y1" },
    ],
  }), [searchDaily]);

  const dualAxisOpts = useMemo(() => ({
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "top" as const, labels: { color: TICK_COLOR, boxWidth: 12, padding: 16, font: { size: 11 } } },
      tooltip: { mode: "index" as const, intersect: false },
    },
    scales: {
      x: { grid: { color: CHART_GRID }, ticks: { color: TICK_COLOR, maxTicksLimit: 10, font: { size: 10 } }, border: { color: CHART_GRID } },
      y: { type: "linear" as const, position: "left" as const, grid: { color: CHART_GRID }, ticks: { color: "#e8312a", font: { size: 10 } }, border: { color: CHART_GRID } },
      y1: { type: "linear" as const, position: "right" as const, grid: { drawOnChartArea: false }, ticks: { color: "#6366f1", font: { size: 10 } }, border: { color: "transparent" } },
    },
  }), []);

  // Device donut chart for GA4
  const deviceDonutData = useMemo(() => {
    if (!devices.length) return null;
    return {
      labels: devices.map(d => d.device.charAt(0).toUpperCase() + d.device.slice(1)),
      datasets: [{
        data: devices.map(d => d.sessions),
        backgroundColor: devices.map(d => (DEVICE_COLORS[d.device] || "#6b7280") + "cc"),
        borderColor: devices.map(d => DEVICE_COLORS[d.device] || "#6b7280"),
        borderWidth: 2,
        hoverOffset: 4,
      }],
    };
  }, [devices]);

  const donutOpts = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, cutout: "65%",
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: any) => {
            const total = ctx.dataset.data.reduce((a: number, b: number) => a + b, 0);
            const pct = ((ctx.raw / total) * 100).toFixed(1);
            return `${ctx.label}: ${ctx.raw.toLocaleString()} (${pct}%)`;
          },
        },
      },
    },
  }), []);

  const maxCountryUsers = useMemo(() => countries.reduce((max, c) => Math.max(max, c.users), 0), [countries]);
  const totalRegionUsers = useMemo(() => regions.reduce((sum, r) => sum + r.users, 0), [regions]);
  const totalDeviceSessions = useMemo(() => devices.reduce((sum, d) => sum + d.sessions, 0), [devices]);

  // ─── KPI cards config ─────────────────────────────────────────────────────
  const kpis = [
    { label: "Active Users", value: overviewLoading ? "—" : (overview?.activeUsers ?? 0).toLocaleString(), icon: <Users className="w-4 h-4" />, color: "#e8312a", current: overview?.activeUsers ?? 0, prior: priorOverview?.activeUsers ?? 0, invert: false },
    { label: "Sessions", value: overviewLoading ? "—" : (overview?.sessions ?? 0).toLocaleString(), icon: <Activity className="w-4 h-4" />, color: "#eab308", current: overview?.sessions ?? 0, prior: priorOverview?.sessions ?? 0, invert: false },
    { label: "Pageviews", value: overviewLoading ? "—" : (overview?.pageviews ?? 0).toLocaleString(), icon: <Eye className="w-4 h-4" />, color: "#22c55e", current: overview?.pageviews ?? 0, prior: priorOverview?.pageviews ?? 0, invert: false },
    { label: "Avg Session Duration", value: overviewLoading ? "—" : formatDuration(overview?.avgSessionDuration ?? 0), icon: <Clock className="w-4 h-4" />, color: "#6366f1", current: overview?.avgSessionDuration ?? 0, prior: priorOverview?.avgSessionDuration ?? 0, invert: false },
    { label: "Bounce Rate", value: overviewLoading ? "—" : `${((overview?.bounceRate ?? 0) * 100).toFixed(1)}%`, icon: <TrendingDown className="w-4 h-4" />, color: "#f97316", current: overview?.bounceRate ?? 0, prior: priorOverview?.bounceRate ?? 0, invert: true },
    { label: "New Users", value: overviewLoading ? "—" : (overview?.newUsers ?? 0).toLocaleString(), icon: <UserPlus className="w-4 h-4" />, color: "#06b6d4", current: overview?.newUsers ?? 0, prior: priorOverview?.newUsers ?? 0, invert: false },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="p-3 sm:p-6 pb-16 mx-auto space-y-5" style={{ maxWidth: "1400px" }}>

        {/* ═══════════════════════════════════════════════════════════════════
            HEADER + DATE RANGE
        ═══════════════════════════════════════════════════════════════════ */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#e8312a]/10 flex items-center justify-center">
              <BarChart2 className="w-5 h-5 text-[#e8312a]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">Web Analytics</h1>
              <p className="text-xs text-muted-foreground">{startDate} → {endDate}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-xl">
              {DATE_RANGES.map(({ label, days: d }) => (
                <button key={label} onClick={() => setDateRange(String(d))}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${dateRange === String(d) ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* What this means — 30-day plain-English analysis */}
        <AnalyticsSummaryCard />

        {/* ═══════════════════════════════════════════════════════════════════
            KPI ROW
        ═══════════════════════════════════════════════════════════════════ */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {kpis.map(kpi => (
            <Card key={kpi.label} className="bg-card border-border/50">
              <CardContent className="p-4">
                <div className="w-8 h-8 rounded-md flex items-center justify-center mb-3" style={{ background: kpi.color + "1a", color: kpi.color }}>
                  {kpi.icon}
                </div>
                <div className="text-2xl font-bold text-foreground tabular-nums leading-none mb-1">
                  {kpi.value}
                  {!overviewLoading && priorOverview && <TrendBadge current={kpi.current} prior={kpi.prior} invert={kpi.invert} />}
                </div>
                <div className="text-xs text-muted-foreground flex items-center">
                  {kpi.label}
                  <KpiTooltip text={KPI_TOOLTIPS[kpi.label] || kpi.label} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            NEW CLASSIFIEDS ADS — new ads posted in the StereoNET classifieds
            forum across 1d / 7d / 30d, with trend arrows comparing against the
            prior period of equal length. Data lives on the forum side; we
            proxy + cache through /api/analytics/classifieds.
            ══════════════════════════════════════════════════════════════════ */}
        {classifieds?.ads && (() => {
          const ads = classifieds.ads;
          const forum = classifieds.forum || {};
          const fmt = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString();
          const newAdWindows = [
            { label: "1 Day",   current: ads.new_1d,  prior: ads.prev_1d },
            { label: "7 Days",  current: ads.new_7d,  prior: ads.prev_7d },
            { label: "30 Days", current: ads.new_30d, prior: ads.prev_30d },
          ] as Array<{ label: string; current: number | null | undefined; prior: number | null | undefined }>;
          // Hourly delta arrow next to Active Ads, mirroring the old Dashboard card.
          const adsDelta = ads.active_delta_hourly;
          const salesDelta = ads.successful_sales_delta_hourly;
          const deltaTag = (d: number | null | undefined) => {
            if (d == null || d === 0) return null;
            const up = d > 0;
            return <span className={`text-xs font-bold tabular-nums ${up ? "text-green-400" : "text-red-400"}`}>{up ? "▲" : "▼"}{Math.abs(d)}</span>;
          };
          return (
            <Card className="bg-card border-border/50">
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Tag className="w-4 h-4 text-[#22c55e]" />
                  Community &amp; Classifieds
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4 pt-2 space-y-4">
                {/* Top: 5-up KPI strip mirroring the old Dashboard card. */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Active Ads</div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-xl font-bold text-foreground tabular-nums">{fmt(ads.active)}</span>
                      {deltaTag(adsDelta)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Total Ads</div>
                    <div className="text-xl font-bold text-foreground tabular-nums">{fmt(ads.total)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Successful Sales</div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-xl font-bold text-foreground tabular-nums">{fmt(ads.successful_sales)}</span>
                      {deltaTag(salesDelta)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Sales (14d)</div>
                    <div className="text-xl font-bold text-[#eab308]">{ads.total_sales_14d ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Total Ads Value</div>
                    <div className="text-xl font-bold text-foreground">{ads.total_ads_value ?? "—"}</div>
                  </div>
                </div>

                {/* New-ads windows row: 1d / 7d / 30d with trend arrows. */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">New Ads</div>
                  <div className="grid grid-cols-3 gap-3">
                    {newAdWindows.map(w => (
                      <div key={w.label} className="flex flex-col gap-1.5 p-3 rounded-md bg-background/40 border border-border/40">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{w.label}</div>
                        <div className="text-2xl font-bold tabular-nums leading-none flex items-center gap-1.5">
                          {fmt(w.current)}
                          {w.current != null && w.prior != null && <TrendBadge current={w.current} prior={w.prior} />}
                        </div>
                        <div className="text-[10px] text-muted-foreground">prior {w.label.toLowerCase()}: <span className="tabular-nums">{fmt(w.prior)}</span></div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Forum totals strip at the bottom — same shape as the old card. */}
                {(forum.total_topics || forum.total_posts || forum.total_members) && (
                  <div className="flex gap-6 text-xs text-muted-foreground border-t border-border/40 pt-3">
                    {forum.total_topics && <span>Topics: <span className="text-foreground font-medium">{forum.total_topics}</span></span>}
                    {forum.total_posts && <span>Posts: <span className="text-foreground font-medium">{forum.total_posts}</span></span>}
                    {forum.total_members && <span>Members: <span className="text-foreground font-medium">{forum.total_members}</span></span>}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}

        {/* ══════════════════════════════════════════════════════════════════
            CLOUDFLARE EDGE ROW — traffic seen at the CDN before reaching the origin
            ══════════════════════════════════════════════════════════════════ */}
        <CloudflareEdgeRow startDate={startDate} endDate={endDate} />

        {/* ═══════════════════════════════════════════════════════════════════
            REGIONS + DEVICES (side by side)
        ═══════════════════════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Regions — 3 cols */}
          <Card className="bg-card border-border/50 lg:col-span-3">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground" /> Regions
              </CardTitle>
            </CardHeader>
            <CardContent>
              {regions.length === 0 ? (
                <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {[...regions].sort((a, b) => b.users - a.users).map(r => {
                    const pct = totalRegionUsers > 0 ? (r.users / totalRegionUsers) * 100 : 0;
                    const color = REGION_COLORS[r.region] || "#6b7280";
                    return (
                      <div key={r.region} className="rounded-lg p-3 border border-border/30" style={{ background: color + "0d" }}>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-sm">{REGION_ICONS[r.region] || "🌍"}</span>
                          <span className="text-[11px] font-semibold text-foreground truncate">{r.region}</span>
                        </div>
                        <div className="text-lg font-bold text-foreground tabular-nums">{formatNum(r.users)}</div>
                        <div className="text-[10px] text-muted-foreground mb-1.5">{pct.toFixed(1)}% of traffic</div>
                        <div className="w-full bg-muted/40 rounded-full h-1 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Devices — 2 cols */}
          <Card className="bg-card border-border/50 lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Monitor className="w-4 h-4 text-muted-foreground" /> Devices
              </CardTitle>
            </CardHeader>
            <CardContent>
              {devices.length === 0 ? (
                <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
              ) : (
                <div className="flex items-center gap-4">
                  {/* Donut */}
                  <div className="w-28 h-28 shrink-0">
                    {deviceDonutData && <Doughnut data={deviceDonutData} options={donutOpts} />}
                  </div>
                  {/* Legend */}
                  <div className="flex-1 space-y-2">
                    {devices.map(d => {
                      const pct = totalDeviceSessions > 0 ? (d.sessions / totalDeviceSessions) * 100 : 0;
                      const color = DEVICE_COLORS[d.device] || "#6b7280";
                      return (
                        <div key={d.device} className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: color + "1a", color }}>
                            {DEVICE_ICONS[d.device] || <Monitor className="w-3 h-3" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-foreground capitalize">{d.device.toLowerCase()}</span>
                              <span className="text-xs tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                            </div>
                            <div className="w-full bg-muted/40 rounded-full h-1 overflow-hidden mt-0.5">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                            </div>
                          </div>
                          <span className="text-xs tabular-nums text-foreground font-medium w-12 text-right">{formatNum(d.sessions)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            TRAFFIC OVER TIME
        ═══════════════════════════════════════════════════════════════════ */}
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" /> Traffic Over Time
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyLoading ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
            ) : daily.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
            ) : (
              <div className="h-64"><Line data={trafficChartData} options={lineOpts} /></div>
            )}
          </CardContent>
        </Card>

        {/* ═══════════════════════════════════════════════════════════════════
            SOURCES + COUNTRIES
        ═══════════════════════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" /> Traffic Sources
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sources.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="h-48"><Bar data={sourcesChartData} options={hBarOpts} /></div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" /> Top Countries
              </CardTitle>
            </CardHeader>
            <CardContent>
              {countries.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {countries.slice(0, 15).map(c => {
                    const pct = maxCountryUsers > 0 ? (c.users / maxCountryUsers) * 100 : 0;
                    return (
                      <div key={c.country} className="flex items-center gap-2">
                        <span className="text-xs text-foreground w-28 shrink-0 truncate" title={c.country}>{c.country}</span>
                        <div className="flex-1 bg-muted/40 rounded-full h-1.5 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "#e8312a" }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground w-14 text-right shrink-0">{c.users.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            TOP PAGES (GA4)
        ═══════════════════════════════════════════════════════════════════ */}
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" /> Top Pages
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {topPages.length === 0 ? (
              <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Page</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Pageviews</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Users</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topPages.slice(0, 20).map((p, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 text-foreground font-mono" title={p.path}>{truncatePath(p.path)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{p.pageviews.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{p.users.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ═══════════════════════════════════════════════════════════════════
            SEARCH PERFORMANCE SECTION
        ═══════════════════════════════════════════════════════════════════ */}
        <div className="flex items-center gap-3 pt-4">
          <div className="w-10 h-10 rounded-lg bg-[#6366f1]/10 flex items-center justify-center">
            <Search className="w-5 h-5 text-[#6366f1]" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">Search Performance</h2>
            <p className="text-xs text-muted-foreground">Google Search Console data</p>
          </div>
        </div>

        {/* ── Search Type KPI Cards (Web / Image / News / Discover) ───── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(scTypes as SCTypeRow[]).map(st => {
            const cfg = SEARCH_TYPE_CONFIG[st.type] || { label: st.type, icon: <Search className="w-4 h-4" />, color: "#6b7280" };
            return (
              <Card key={st.type} className="bg-card border-border/50">
                <CardContent className="p-4">
                  <div className="w-8 h-8 rounded-md flex items-center justify-center mb-3" style={{ background: cfg.color + "1a", color: cfg.color }}>
                    {cfg.icon}
                  </div>
                  <div className="text-lg font-bold text-foreground tabular-nums leading-none mb-0.5">
                    {formatNum(st.clicks)} <span className="text-xs font-normal text-muted-foreground">clicks</span>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums mb-1">
                    {formatNum(st.impressions)} impr · {(st.ctr * 100).toFixed(1)}% CTR
                  </div>
                  <div className="text-xs font-medium text-foreground">{cfg.label}</div>
                </CardContent>
              </Card>
            );
          })}
          {scTypes.length === 0 && (
            <div className="col-span-4 text-sm text-muted-foreground text-center py-6">Loading search type data…</div>
          )}
        </div>

        {/* ── Clicks & Impressions chart ─────────────────────────────────── */}
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <MousePointerClick className="w-4 h-4 text-muted-foreground" /> Clicks &amp; Impressions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {searchDaily.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
            ) : (
              <div className="h-64"><Line data={searchChartData} options={dualAxisOpts} /></div>
            )}
          </CardContent>
        </Card>

        {/* ── Search Devices + Search Appearance ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Search Devices */}
          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-muted-foreground" /> Search by Device
              </CardTitle>
            </CardHeader>
            <CardContent>
              {scDevices.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="space-y-3">
                  {scDevices.map(d => {
                    const totalClicks = scDevices.reduce((s, x) => s + x.clicks, 0);
                    const pct = totalClicks > 0 ? (d.clicks / totalClicks) * 100 : 0;
                    const color = DEVICE_COLORS[d.device] || "#6b7280";
                    return (
                      <div key={d.device} className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: color + "1a", color }}>
                          {DEVICE_ICONS[d.device] || <Monitor className="w-3.5 h-3.5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs font-medium text-foreground capitalize">{d.device.toLowerCase()}</span>
                            <span className="text-xs tabular-nums text-foreground font-medium">{d.clicks.toLocaleString()} clicks</span>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
                            <span>{d.impressions.toLocaleString()} impr</span>
                            <span>{(d.ctr * 100).toFixed(1)}% CTR</span>
                            <span>Pos {d.position.toFixed(1)}</span>
                          </div>
                          <div className="w-full bg-muted/40 rounded-full h-1 overflow-hidden mt-1">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Search Appearance */}
          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-muted-foreground" /> Search Appearance
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {scAppearance.length === 0 ? (
                <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Appearance</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Clicks</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Impr</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">CTR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scAppearance.map((a, i) => (
                        <tr key={i} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-2 text-foreground">{formatAppearanceName(a.appearance)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{a.clicks.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{a.impressions.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{(a.ctr * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Search Queries + Search Pages ──────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Search className="w-4 h-4 text-muted-foreground" /> Top Search Queries
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {searchQueries.length === 0 ? (
                <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Query</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Clicks</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Impr</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">CTR</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Pos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchQueries.slice(0, 20).map((q, i) => (
                        <tr key={i} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-2 text-foreground max-w-[180px] truncate" title={q.query}>{q.query}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{q.clicks.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{q.impressions.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{(q.ctr * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{q.position.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Eye className="w-4 h-4 text-muted-foreground" /> Top Pages (Search)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {searchPages.length === 0 ? (
                <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">No data available</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="text-left px-4 py-2 font-medium text-muted-foreground">Page</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Clicks</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Impr</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">CTR</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Pos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchPages.slice(0, 20).map((p, i) => (
                        <tr key={i} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-2 text-foreground font-mono max-w-[180px] truncate" title={p.page}>{truncatePath(p.page, 36)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.clicks.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.impressions.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{(p.ctr * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.position.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}

// ─── Cloudflare Edge Row ─────────────────────────────────────────────────────
// Pulls zone-level analytics from Cloudflare's GraphQL Analytics API, summed
// over the active date range, and shows alongside the GA4 KPIs.
type CFZoneResponse = {
  ok: boolean;
  configured: boolean;
  summary?: { requests: number; pageViews: number; uniques: number; bytes: number; threats: number; cachedRequests: number; cachedBytes: number };
  daily?: { date: string; requests: number; pageViews: number; uniques: number; bytes: number; threats: number }[];
  error?: string;
};

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}
function formatNumAU(n: number): string {
  return new Intl.NumberFormat("en-AU").format(Math.round(n || 0));
}

function CloudflareEdgeRow({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { data, isLoading } = useQuery<CFZoneResponse>({
    queryKey: ["/api/analytics/cloudflare/zone", startDate, endDate],
    queryFn: () => apiRequest("GET", `/api/analytics/cloudflare/zone?startDate=${startDate}&endDate=${endDate}`).then(r => r.json()),
  });

  if (isLoading) {
    return (
      <Card className="bg-card border-border/50">
        <CardContent className="p-4 text-xs text-muted-foreground">Loading Cloudflare edge stats…</CardContent>
      </Card>
    );
  }

  if (!data?.ok) {
    if (data && data.configured === false) {
      return (
        <Card className="bg-card border-border/50">
          <CardContent className="p-4 text-xs text-muted-foreground flex items-center gap-2">
            <Cloud className="w-4 h-4 text-orange-400" />
            Cloudflare token/zone not configured. Add them in Admin to see edge stats.
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="bg-card border-border/50">
        <CardContent className="p-4 text-xs text-muted-foreground">Cloudflare edge stats unavailable{data?.error ? ` — ${data.error}` : ""}.</CardContent>
      </Card>
    );
  }

  const s = data.summary!;
  const cachedPct = s.requests > 0 ? Math.round((s.cachedRequests / s.requests) * 100) : 0;
  const cards = [
    { label: "Edge Requests", value: formatNumAU(s.requests), icon: <Server className="w-4 h-4" />, color: "#f97316", tip: "Total HTTP requests served at the Cloudflare edge for stereonet.com (includes assets, API, and proxied origin hits)." },
    { label: "Edge Page Views", value: formatNumAU(s.pageViews), icon: <Eye className="w-4 h-4" />, color: "#3b82f6", tip: "HTML page views measured at the edge. Higher than GA4 because it includes pre-consent and ad-blocked visitors." },
    { label: "Unique Visitors", value: formatNumAU(s.uniques), icon: <Users className="w-4 h-4" />, color: "#10b981", tip: "Unique visitors (by IP) seen at the edge over the period." },
    { label: "Threats Blocked", value: formatNumAU(s.threats), icon: <Shield className="w-4 h-4" />, color: "#ef4444", tip: "Bad bots, abusive IPs, and security challenges Cloudflare stopped before they reached the origin." },
    { label: "Bandwidth", value: formatBytes(s.bytes), icon: <Zap className="w-4 h-4" />, color: "#a855f7", tip: "Total bytes served from the edge over the period." },
    { label: "Cache Hit Ratio", value: cachedPct + "%", icon: <Cloud className="w-4 h-4" />, color: "#06b6d4", tip: "Percentage of requests served from Cloudflare's cache rather than the origin. 0% indicates HTML is not currently cached." },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Cloud className="w-4 h-4 text-orange-400" />
        <h2 className="text-sm font-semibold text-foreground">Cloudflare Edge</h2>
        <span className="text-xs text-muted-foreground">Traffic seen at the CDN before reaching the origin</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map(c => (
          <Card key={c.label} className="bg-card border-border/50">
            <CardContent className="p-4">
              <div className="w-8 h-8 rounded-md flex items-center justify-center mb-3" style={{ background: c.color + "1a", color: c.color }}>
                {c.icon}
              </div>
              <div className="text-2xl font-bold text-foreground tabular-nums leading-none mb-1">{c.value}</div>
              <div className="text-xs text-muted-foreground flex items-center">
                {c.label}
                <KpiTooltip text={c.tip} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── 30-day narrative summary card ─────────────────────────────────────────
type SummaryResponse = {
  ok: boolean;
  paragraph?: string;
  headline?: string;
  period?: { startDate: string; endDate: string };
  kpis?: {
    activeUsers: { cur: number; prior: number; deltaPct: number };
    pageviews: { cur: number; prior: number; deltaPct: number };
    sessions: { cur: number; prior: number; deltaPct: number };
    newUsers: { cur: number; prior: number; deltaPct: number };
    bounceRate: { cur: number; prior: number; deltaPp: number };
    avgSessionDuration: { cur: number; prior: number; deltaPct: number };
  };
  winners?: { sources: any[]; pages: any[]; countries: any[] };
  losers?: { sources: any[]; pages: any[] };
  error?: string;
};

function AnalyticsSummaryCard() {
  const { data, isLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/analytics/summary"],
    queryFn: () => apiRequest("GET", "/api/analytics/summary").then(r => r.json()),
  });

  if (isLoading) {
    return (
      <Card className="bg-card border-border/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="w-4 h-4 text-[#e8312a]" />
            Analysing the last 30 days…
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data?.ok || !data.paragraph) {
    return null;
  }

  // Split the narrative into 2-3 sentence groups so it reads in chunks.
  const sentences = data.paragraph.split(/(?<=\.) /);
  const groups: string[][] = [];
  for (let i = 0; i < sentences.length; i += 2) groups.push(sentences.slice(i, i + 2));

  return (
    <Card className="bg-card border-l-4 border-l-[#e8312a] border-y-border/50 border-r-border/50">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-[#e8312a]/10 text-[#e8312a] flex items-center justify-center flex-shrink-0 mt-0.5">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-2">
              <h2 className="text-sm font-bold text-foreground">What this means</h2>
              <span className="text-xs text-muted-foreground">
                {data.period ? `${data.period.startDate} → ${data.period.endDate} vs prior 30 days` : "Last 30 days vs prior 30 days"}
              </span>
            </div>
            <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
              {groups.map((g, i) => (
                <p key={i}>{g.join(" ")}</p>
              ))}
            </div>
            {(data.winners?.sources?.length || data.losers?.sources?.length) ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                {data.winners?.sources?.length ? (
                  <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 p-3">
                    <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                      <TrendingUp className="w-3 h-3" /> Winning sources
                    </div>
                    <ul className="text-xs text-foreground/80 space-y-1">
                      {data.winners.sources.slice(0, 3).map((s: any) => (
                        <li key={s.key} className="flex justify-between gap-2">
                          <span className="truncate">{s.key}</span>
                          <span className="tabular-nums text-emerald-400">+{formatNumAU(s.delta)} ({s.deltaPct >= 0 ? "+" : ""}{s.deltaPct}%)</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {data.losers?.sources?.length ? (
                  <div className="rounded-md bg-orange-500/5 border border-orange-500/20 p-3">
                    <div className="text-[11px] font-semibold text-orange-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                      <TrendingDown className="w-3 h-3" /> Fading sources
                    </div>
                    <ul className="text-xs text-foreground/80 space-y-1">
                      {data.losers.sources.slice(0, 3).map((s: any) => (
                        <li key={s.key} className="flex justify-between gap-2">
                          <span className="truncate">{s.key}</span>
                          <span className="tabular-nums text-orange-400">−{formatNumAU(Math.abs(s.delta))} ({s.deltaPct}%)</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
