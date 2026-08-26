import { Switch, Route, Router, Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "./pages/Dashboard";
import Discovery from "./pages/Discovery";
import Admin from "./pages/Admin";
import Redline from "./pages/Redline";
import MyArticles from "./pages/MyArticles";
import Sites from "./pages/Sites";
import Analytics from "./pages/Analytics";
import Pitch from "./pages/Pitch";
import Leads from "./pages/Leads";
import Retailers from "./pages/Retailers";
// PitchPublic was retired in the PITCH ↔ Media Kit unification — the
// /pitch/<slug> public viewer is gone; new proposals are viewed under
// /kit/<slug>?t=... via MediaKitPublic, which handles the full Investment
// + Acceptance flow stamped by the wizard.
import MediaKits from "./pages/MediaKits";
import MediaKitPublic from "./pages/MediaKitPublic";
import NotFound from "./pages/not-found";
import NotificationBell from "./components/NotificationBell";
import PresenceAvatars from "./components/PresenceAvatars";
import { Trophy, ArrowLeftCircle } from "lucide-react";

function nDaysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

function TabNav() {
  const [loc] = useHashLocation();
  // Check if user is admin
  const qc = useQueryClient();
  const { data: me } = useQuery<{ username: string; role: string; redline_access: number; impersonating: string | null }>({
    queryKey: ["/api/admin/me"],
    queryFn: () => apiRequest("GET", "/api/admin/me").then(r => r.json()),
    staleTime: 300000,
  });

  const hasRedline = me?.role === "admin" || me?.redline_access === 1;
  const isLoggedIn = !!me?.username;

  const returnToAdmin = async () => {
    await apiRequest("POST", "/api/admin/return");
    qc.invalidateQueries();
    window.location.hash = "/admin";
  };
  const tabs = [
    { path: "/", label: "Dashboard" },
    { path: "/discovery", label: "Article Discovery" },
    ...(isLoggedIn ? [{ path: "/my-articles", label: "My Articles" }] : []),
    ...(isLoggedIn ? [{ path: "/analytics", label: "Analytics" }] : []),
    ...(isLoggedIn ? [{ path: "/sites", label: "Sites" }] : []),
    ...(hasRedline ? [{ path: "/redline", label: "Redline" }] : []),
    ...(isLoggedIn ? [{ path: "/pitch", label: "PITCH" }] : []),
    ...(isLoggedIn ? [{ path: "/retailers", label: "Retailers" }] : []),
    ...(me?.role === "admin" ? [{ path: "/admin", label: "Admin" }] : []),
  ];

  // 48hr top authors for marquee
  const from48h = nDaysAgo(1);
  const { data: authors48h = [] } = useQuery<{ author: string; count: number }[]>({
    queryKey: ["/api/authors-marquee", from48h],
    queryFn: () => {
      const params = new URLSearchParams({ fromDate: from48h, toDate: today() });
      return apiRequest("GET", `/api/authors?${params}`).then(r => r.json());
    },
    refetchInterval: 120000,
  });

  const championQuotes = [
    "Champions aren't made in gyms. Champions are made from something they have deep inside them.",
    "A champion is someone who gets up when they can't.",
    "The only way to prove you're a good sport is to lose.",
    "Hard work beats talent when talent doesn't work hard.",
    "Winners never quit and quitters never win.",
    "The more difficult the victory, the greater the happiness in winning.",
    "It's not whether you get knocked down, it's whether you get up.",
    "Don't count the days, make the days count.",
    "Pressure is a privilege.",
    "Be the hardest worker in the room.",
    "Excellence is not a singular act, but a habit.",
    "The champion mindset: every article is a statement.",
    "First to publish, first to lead.",
    "Content is king. Consistency is queen.",
  ];
  const randomQuote = championQuotes[Math.floor(Date.now() / 60000) % championQuotes.length];

  const topAuthor = authors48h.length > 0 ? authors48h[0] : null;
  const marqueeText = topAuthor
    ? `\u{1F3C6} #1 ${topAuthor.author} (${topAuthor.count} article${topAuthor.count !== 1 ? "s" : ""} in 48h) \u{1F3C6}   \u2014   \u201C${randomQuote}\u201D`
    : "";

  return (
    <div className="border-b border-border bg-[hsl(var(--sidebar-background))]">
      {/* Marquee */}
      {marqueeText && (
        <div className="overflow-hidden bg-[#e8312a]/10 border-b border-[#e8312a]/20">
          <div className="animate-marquee whitespace-nowrap py-2 text-sm font-semibold">
            <span className="text-[#eab308]">Top Author (48h):</span>
            <span className="text-foreground ml-3">{marqueeText}</span>
            <span className="text-muted-foreground mx-12">|</span>
            <span className="text-[#eab308]">Top Author (48h):</span>
            <span className="text-foreground ml-3">{marqueeText}</span>
          </div>
        </div>
      )}
      {/* Impersonation banner */}
      {me?.impersonating && (
        <div className="bg-[#eab308] px-4 py-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-black">
            Viewing as <strong>{me.username.split('@')[0]}</strong>
          </span>
          <button
            onClick={returnToAdmin}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-black/20 text-black text-xs font-medium hover:bg-black/30 transition-colors"
          >
            <ArrowLeftCircle className="w-3.5 h-3.5" />
            Return to Admin
          </button>
        </div>
      )}
      {/* Tabs + version */}
      <div className="flex items-center">
        {tabs.map(t => (
          <Link key={t.path} href={t.path}
            className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              loc === t.path
                ? "border-[#e8312a] text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-1 pr-2">
          <PresenceAvatars />
          <NotificationBell />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // PITCH public client-facing route lives at path /pitch/:slug (not hash).
  // Detect it BEFORE mounting the admin shell so we can render a clean,
  // chrome-free, branded proposal page for the client.
  // (PitchPublic removed — see header comment.)
  const isPublicKit = typeof window !== "undefined" && /^\/kit\/[^/?#]+/.test(window.location.pathname);
  if (isPublicKit) {
    return (
      <QueryClientProvider client={queryClient}>
        <MediaKitPublic />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <div className="flex flex-col h-screen bg-background">
          <TabNav />
          <div className="flex-1 overflow-hidden">
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/discovery" component={Discovery} />
              <Route path="/analytics" component={Analytics} />
              <Route path="/sites" component={Sites} />
              <Route path="/my-articles" component={MyArticles} />
              <Route path="/redline" component={Redline} />
              <Route path="/pitch" component={Pitch} />
              <Route path="/leads" component={Leads} />
              <Route path="/retailers" component={Retailers} />
              <Route path="/media-kits" component={MediaKits} />
              <Route path="/admin" component={Admin} />
              <Route component={NotFound} />
            </Switch>
          </div>
        </div>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}
