// Media Kit public viewer — token-gated, no app chrome.
// Visual style mirrors PitchPublic.tsx.
import React, { useEffect, useState, createContext, useContext } from "react";

type Block = { block_key: string; position: number; is_visible: number; content: any };
type Addon = {
  id: number; kind: "tier" | "bolton"; addon_key: string; label: string;
  subtitle: string | null; description: string | null;
  price_value: number | null; price_currency: string; price_suffix: string | null;
  billing_period?: "monthly" | "annual" | "one_off" | null;
  billing: string; inclusions: any; availability: string; is_poa: number;
  example_url?: string | null;
};
type Kit = {
  id: number; kind: "trade" | "retailer"; region: string | null; label: string;
  subtitle: string | null; version_quarter: string | null; base_currency: string;
  tax_suffix: string | null;
};
type ProposalScope = {
  tier_key: string | null;
  tier: Addon | null;
  bolton_keys: string[];
  boltons: Array<Addon & { quantity?: number }>;
  auto_total: boolean;
  computed_total: number | null;
};

type Payload = {
  kit: Kit;
  blocks: Block[];
  addons: { tiers: Addon[]; boltons: Addon[] };
  proposalScope?: ProposalScope | null;
  settings?: { terms_text?: string };
  share: {
    share_id?: number;
    prospect_name: string | null;
    prospect_email?: string | null;
    prospect_company: string | null;
    expires_at: string | null;
    proposal_state?: "draft" | "sent" | "viewed" | "accepted" | "declined" | "changes_requested";
    accepted_at?: string | null;
    accepted_by_name?: string | null;
  };
};

const INCLUSION_LABELS: Record<string, string> = {
  banners: "Display Banner Sets",
  ad_weighting: "Ad Weighting (Campaign Power)",
  reviews_per_year: "Review Slots",
  discount_pct: "Additional Advertising Discount",
  news_pr: "Unlimited News & PR with Editorial Priority",
  newsletter_social: "Newsletter & Social Media Coverage",
  brand_distributor_pages: "Brand & Distributor Pages",
  exclusive_forum: "Exclusive Global Sponsor Forum",
  classifieds_access: "Commercial Classifieds Access",
  ai_discoverability: "AI Discoverability & LLM Surfacing",
};

export default function MediaKitPublic() {
  const path = window.location.pathname;
  const slug = path.replace(/^\/kit\//, "").split("/")[0];
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t") || "";

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.body.classList.add("kit-public-body");
    return () => document.body.classList.remove("kit-public-body");
  }, []);

  useEffect(() => {
    if (!slug || !token) { setError("Invalid link. Please check the URL or contact your StereoNET representative."); setLoading(false); return; }
    fetch(`/api/media-kit/public/${slug}?t=${encodeURIComponent(token)}`, { credentials: "omit" })
      .then(async r => {
        if (!r.ok) { const j = await r.json().catch(() => ({} as any)); throw new Error(j.message || `Error ${r.status}`); }
        return r.json();
      })
      .then((j: Payload) => setData(j))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Time-on-page + scroll-depth beacon
  useEffect(() => {
    if (!data) return;
    const start = Date.now();
    let maxScroll = 0;
    const onScroll = () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0) {
        const pct = Math.round((window.scrollY / h) * 100);
        if (pct > maxScroll) maxScroll = Math.min(100, pct);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    const send = () => {
      const seconds = Math.round((Date.now() - start) / 1000);
      const url = `/api/media-kit/public/${slug}/ping?t=${encodeURIComponent(token)}`;
      const body = JSON.stringify({ time_on_page_seconds: seconds, scroll_depth_pct: maxScroll });
      try {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon?.(url, blob) ||
          fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", send);
    window.addEventListener("beforeunload", send);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", send); window.removeEventListener("beforeunload", send); send(); };
  }, [data]);

  if (loading) return <KitShell><p className="muted">Loading media kit…</p></KitShell>;
  if (error) return <KitShell><div className="error-state"><h1>Unable to load this kit</h1><p>{error}</p></div></KitShell>;
  if (!data) return null;

  const { kit, blocks, addons, share } = data;
  const isRetailerKit = kit.kind === "retailer";
  const proposalScope: ProposalScope | null = (data as any).proposalScope || null;
  const termsText: string = (data as any).settings?.terms_text || "";
  // A block is hidden if is_visible=0 OR if its content has _suppressed:true
  // (the latter is used by freezeInheritedBlocksForKit to permanently hide
  // an inherited block on a sent-proposal kit).
  const visible = blocks.filter(b => b.is_visible !== 0 && !(b.content && b.content._suppressed));
  const get = (key: string) => visible.find(b => b.block_key === key)?.content;

  const offerContent = get("offer") || {};
  const bs = (offerContent.broadstreet || {}) as { enabled?: boolean; masthead_enabled?: boolean; billboard_zone?: string; hpu_zone?: string; mrec_zone?: string; masthead_zone?: string };
  const bsEnabled = !!bs.enabled && !!(bs.billboard_zone || bs.hpu_zone || bs.mrec_zone || bs.masthead_zone);

  return (
    <CurrencyProvider kit={kit} isRetailerKit={isRetailerKit}>
    <KitShell>
      <style>{globalCss}</style>
      <style>{richProposalCss}</style>
      <style>{printCss}</style>
      <div className="kit-root">
        {/* Floating Download PDF button. Hidden in print so it doesn't end up
            on the saved PDF. window.print() triggers the @media print rules
            which force dark backgrounds, hide CTAs, and tighten margins. */}
        <button
          type="button"
          className="kit-pdf-btn no-print"
          onClick={() => {
            // Hint the browser to use the Letter-ish portrait layout we styled.
            const prev = document.title;
            try {
              const company = share?.prospect_company || kit.label || "StereoNET Media Kit";
              document.title = `${company} — StereoNET Media Kit`;
            } catch {}
            window.print();
            setTimeout(() => { try { document.title = prev; } catch {} }, 1000);
          }}
          title="Save this page as a PDF (use your browser's Save as PDF option)"
        >
          ↓ Download PDF
        </button>
        {bsEnabled && bs.masthead_zone && <MastheadToggle zoneId={bs.masthead_zone} />}
        {isRetailerKit && <CurrencySelectorBar />}
        <Hero kit={kit} share={share} content={get("hero")} hasProposal={!!get("proposal") || !!share?.prospect_company} />
        {(get("proposal") || share?.prospect_company) && (
          <Section>
            <ProposalBlock
              content={get("proposal") || { prepared_for: share?.prospect_company || share?.prospect_name || "" }}
              share={share}
              kit={kit}
              slug={slug}
              token={token}
              scope={proposalScope}
              tiers={addons.tiers}
              boltons={addons.boltons}
              termsText={termsText}
            />
          </Section>
        )}
        {get("who_are_we") && <Section><WhoAreWe content={get("who_are_we")} /></Section>}
        {get("why_us") && <Section alt><WhyUs content={get("why_us")} /></Section>}
        {get("audience") && <Section><Audience content={get("audience")} kit={kit} /></Section>}
        <Section alt><AudienceStats content={get("audience_stats") || {}} /></Section>
        {get("audience_grid") && <Section alt><AudienceGrid content={get("audience_grid")} /></Section>}
        {get("audience_grid") && get("featured_article") && get("featured_article").enabled !== false && (
          <SectionConnector label="Here's why these numbers matter for your brand" />
        )}
        {get("featured_article") && get("featured_article").enabled !== false && (
          <Section><FeaturedArticle content={get("featured_article")} /></Section>
        )}
        {get("find_a_store") && (get("find_a_store").enabled !== false) && (
          <Section alt><FindAStore content={get("find_a_store")} /></Section>
        )}
        <Section alt><ResearchSources content={get("research_sources") || {}} /></Section>
        {get("offer") && <Section alt><Offer content={get("offer")} /></Section>}
        {get("offer") && bsEnabled && (
          <Section><BannerExamples content={get("banner_examples") || {}} broadstreet={bs} /></Section>
        )}
        {get("who_we_are_not") && (get("who_we_are_not").enabled !== false) && (
          <Section alt><WhoWeAreNot content={get("who_we_are_not")} /></Section>
        )}
        {get("partner_quotes") && (get("partner_quotes").enabled !== false) && (
          <Section alt><PartnerQuotes content={get("partner_quotes")} /></Section>
        )}
        {get("investment_callout") && get("investment_callout").enabled !== false && (
          <Section><InvestmentCallout content={get("investment_callout")} /></Section>
        )}

        {get("investment") && addons.tiers.length > 0 && (
          <Section><Investment content={get("investment")} tiers={addons.tiers} kit={kit} scope={proposalScope} hasProposal={!!get("proposal") || !!share?.prospect_company} share={share} slug={slug} token={token} /></Section>
        )}
        {get("analytics_proof") && (get("analytics_proof").enabled !== false) && (
          <Section alt><AnalyticsProof content={get("analytics_proof")} /></Section>
        )}
        {/* Casual / Ad-hoc block: hidden by default on personalised PITCH
            proposal clones (which already have a tailored line items + boltons
            quote). Editors can force it back on by setting `hide_on_proposal:
            false` in the casual block. */}
        {get("casual")?.enabled !== false && get("casual") && !(
          (!!get("proposal") || !!share?.prospect_company) && get("casual")?.hide_on_proposal !== false
        ) && <Section alt><Casual content={get("casual")} /></Section>}
        {/* Retailer kits don't sell bolt-ons — only show this block on trade kits. */}
        {!isRetailerKit && get("boltons") && addons.boltons.length > 0 && (
          <Section><Boltons content={get("boltons")} boltons={addons.boltons} scope={proposalScope} /></Section>
        )}
        {get("ready") && <Section alt><Ready content={get("ready")} share={share} hasProposal={!!get("proposal") || !!share?.prospect_company} /></Section>}
        {get("terms") && <Section><Terms content={get("terms")} /></Section>}
        {get("contact") && <Footer content={get("contact")} kit={kit} share={share} />}
      </div>
    </KitShell>
    </CurrencyProvider>
  );
}

function KitShell({ children }: { children: any }) { return <div>{children}</div>; }

// ─── Inline markdown ────────────────────────────────────────────────────────
// Inlined StereoNET wordmark as a data URI — keeps the logo working for
// anonymous viewers without depending on a Cloudflare allow-list rule for the
// `/stereonet-logo.svg` asset path.
const STEREONET_LOGO_DATA_URI = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjEyMCAzODAgMTU4MCA0NjAiPgogIDwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAyOS43LjAsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiAyLjEuMSBCdWlsZCAxMzgpICAtLT4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLnN0MCB7CiAgICAgICAgZmlsbDogI2ZmZjsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPGc+CiAgICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMjgxLjgsNTY5LjdsLS40LTExLjNjMC0yLjctLjItNS4zLS42LTgtLjQtMi43LTEuMS01LjQtMi4yLTguMy0xLjEtMi45LTIuNy01LjEtNC44LTYuOS0yLjEtMS43LTQuNi0yLjYtNy42LTIuNi00LjksMC04LjcsMS40LTExLjIsNC4yLTIuNiwyLjgtMy45LDYuNy0zLjksMTEuOCwwLDEwLjYsNC4zLDE5LDEyLjgsMjUuM2w0NCwzMi4yYzguOCw2LjUsMTYuMywxMy4zLDIyLjcsMjAuNSw2LjQsNy4yLDExLjIsMTMuNywxNC41LDE5LjYsMy4zLDUuOSw1LjksMTIuMiw3LjgsMTksMS45LDYuOCwzLjEsMTIuMywzLjUsMTYuNS40LDQuMi42LDksLjYsMTQuMywwLDI4LjUtOCw1MC4xLTI0LjEsNjQuOC0xNi4xLDE0LjctMzgsMjItNjUuNiwyMi4xLTU4LjksMC04OC40LTI5LjktODguNS04OS45bC40LTIzLjdoNzEuM2MwLDAsLjQsMzUsLjQsMzUsMCw0LjguNiw4LjcsMS43LDExLjgsMS4xLDMuMSwyLjcsNS4zLDQuNyw2LjcsMiwxLjMsMy44LDIuMiw1LjUsMi42LDEuNy40LDMuNS42LDUuNy42LDkuNiwwLDE0LjMtNy44LDE0LjMtMjMuMywwLTQsMC02LjktLjItOC43LS4xLTEuOC0uNi00LjQtMS41LTgtLjktMy41LTIuMy02LjYtNC4yLTkuMy0xLjktMi43LTQuNy01LjktOC40LTkuNy0zLjctMy44LTguMy03LjktMTMuOC0xMi4xbC0zOC4xLTI5LjJjLTguMi02LjQtMTQuOS0xMi42LTIwLTE4LjYtNS4xLTYtOC44LTEyLjQtMTEuMi0xOS4xLTIuMy02LjctMy44LTEyLjctNC41LTE4LjEtLjctNS40LTEtMTIuMy0xLTIwLjgsMC0xNS4zLDQuNC0yOC41LDEzLjEtMzkuNiw4LjctMTEuMiwxOS43LTE5LjMsMzIuNy0yNC41LDEzLjEtNS4yLDI3LjItNy44LDQyLjUtNy44LDI4LDAsNDkuNSw3LjEsNjQuNCwyMS4yLDE0LjksMTQuMiwyMi40LDM2LjEsMjIuNSw2NS43djUuNnMtNzMuMywwLTczLjMsMFoiLz4KICAgIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0zNjguMSw0MjguN2g2OS4zYzAsMCwwLDYzLjQsMCw2My40aDEyLjdzMCw1NC4zLDAsNTQuM2gtMTIuN3MuMiwxNjgsLjIsMTY4YzAsMi41LDAsNC41LjIsNiwuMSwxLjUuNCwzLC44LDQuNy40LDEuNywxLjIsMi45LDIuMywzLjYsMS4xLjcsMi42LDEuMSw0LjMsMS4xLDEuNywwLDMuNS0uMyw1LjItLjh2NDguNmMtMTAsMy41LTIyLjcsNS4yLTM4LDUuMi03LjcsMC0xNC4zLTEtMTkuOC0zLjEtNS41LTIuMS05LjgtNC42LTEyLjgtNy42LTMuMS0zLTUuNS02LjgtNy4zLTExLjUtMS44LTQuNy0yLjktOS4xLTMuNC0xMy4yLS41LTQuMS0uNy04LjgtLjctMTQuMWwtLjItMTg2LjdoLTEwLjlzMC01NC4zLDAtNTQuM2gxMC45czAtNjMuNSwwLTYzLjVaIi8+CiAgICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNNTQzLjksNzgyLjdjLTEwLjYsMC0yMC4yLTEuMS0yOC45LTMuMy04LjYtMi4yLTE1LjktNS0yMS44LTguNS01LjktMy41LTExLTgtMTUuMy0xMy4zLTQuMy01LjQtNy43LTEwLjgtMTAuMy0xNi40LTIuNS01LjYtNC42LTExLjktNi4xLTE5LjEtMS41LTcuMi0yLjUtMTMuOC0zLTE5LjktLjUtNi4xLS43LTEyLjktLjctMjAuM3YtMTIwYy0uMi0yNy41LDcuNy00OC41LDIzLjQtNjMsMTUuNy0xNC41LDM3LjctMjEuOCw2Ni0yMS45LDU3LjMsMCw4NiwyOC4yLDg2LjEsODQuN3YyMS43YzAsMjYuOS0uMiw0NS41LS43LDU1LjVoLTEwMy41YzAsLjEsMCw0MS45LDAsNDEuOSwwLDEuMywwLDMuNSwwLDYuNSwwLDMsMCw1LjMsMCw2LjksMCw0LjguMiw4LjkuNiwxMi4yLjQsMy40LDEuMSw2LjgsMi4yLDEwLjMsMS4xLDMuNSwyLjgsNi4yLDUuMyw4LDIuNSwxLjgsNS41LDIuNyw5LjMsMi43LDMuOCwwLDctMS40LDkuNC00LjEsMi40LTIuNyw0LjEtNi42LDUuMS0xMS43LDEtNS4xLDEuNi05LjcsMS45LTEzLjYuMy00LC40LTksLjQtMTQuOSwwLTExLjctLjItMTgtLjQtMTkuMWg3MC45YzAsMCwwLDE2LjgsMCwxNi44LDAsMTYuNi0xLjIsMzAuNy0zLjcsNDIuNC0yLjUsMTEuNy03LDIyLjItMTMuNCwzMS42LTYuNCw5LjQtMTUuNiwxNi40LTI3LjUsMjEtMTEuOSw0LjctMjYuOSw3LTQ0LjgsN1pNNTQ2LjQsNTMwLjRjLTMuNywwLTYuOCwxLTkuNCwyLjktMi41LDEuOS00LjQsNC44LTUuNiw4LjctMS4yLDMuOS0yLDcuOC0yLjQsMTEuOC0uNCw0LjEtLjYsOS0uNiwxNC44LDAsMi44LDAsNywuMiwxMi41LjEsNS42LjIsOS44LjIsMTIuNWgzMy40czAtMzEuMSwwLTMxLjFjMC0yMS41LTUuMy0zMi4yLTE2LTMyLjJaIi8+CiAgICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNNjQwLjYsNzc5bC0uMy0yOTguNmg3MS4zYzAsMCwwLDMzLjIsMCwzMy4yLDQtMTMuNyw5LjUtMjMuMiwxNi43LTI4LjcsNy4yLTUuNCwxNi4yLTguMiwyNy4zLTguMiwxMy4zLDAsMjUsNC4xLDM1LDEyLjIsMTAuMSw4LjIsMTUuMiwyMCwxNS4yLDM1LjV2OTkuOWMuMSwwLTY5LjYsMC02OS42LDB2LTcxLjVjMC0zLjYtLjItNi42LS42LTkuMS0uMy0yLjUtMS40LTQuOC0zLjItNy4xLTEuOC0yLjMtNC40LTMuNC03LjctMy40LTMuNSwwLTYuNSwxLjUtOS4yLDQuNi0yLjcsMy4xLTQsNy4yLTQsMTIuNWwuMiwyMjguM2gtNzEuM1oiLz4KICAgIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik04OTAuMSw3ODIuM2MtMTAuNiwwLTIwLjItMS4xLTI4LjktMy4zLTguNi0yLjItMTUuOS01LTIxLjgtOC41LTUuOS0zLjUtMTEtOC0xNS4zLTEzLjMtNC4zLTUuNC03LjctMTAuOC0xMC4zLTE2LjQtMi41LTUuNi00LjYtMTEuOS02LjEtMTkuMS0xLjUtNy4yLTIuNS0xMy44LTMtMTkuOS0uNS02LjEtLjctMTIuOS0uNy0yMC4zdi0xMjBjLS4yLTI3LjUsNy43LTQ4LjUsMjMuNC02MywxNS43LTE0LjUsMzcuNy0yMS44LDY2LTIxLjksNTcuMywwLDg2LDI4LjIsODYuMSw4NC43djIxLjdjMCwyNi45LS4yLDQ1LjUtLjcsNTUuNWgtMTAzLjVjMCwuMSwwLDQxLjksMCw0MS45LDAsMS4zLDAsMy41LDAsNi41LDAsMywwLDUuMywwLDYuOSwwLDQuOC4yLDguOS42LDEyLjIuNCwzLjQsMS4xLDYuOCwyLjIsMTAuMywxLjEsMy41LDIuOCw2LjIsNS4zLDgsMi41LDEuOCw1LjUsMi43LDkuMywyLjcsMy44LDAsNy0xLjQsOS40LTQuMSwyLjQtMi43LDQuMS02LjYsNS4xLTExLjgsMS01LjEsMS42LTkuNywxLjktMTMuNi4zLTQsLjQtOSwuNC0xNC45LDAtMTEuNy0uMS0xOC0uNC0xOS4xaDcwLjljMCwwLDAsMTYuOCwwLDE2LjgsMCwxNi42LTEuMiwzMC43LTMuNyw0Mi40LTIuNSwxMS43LTcsMjIuMi0xMy40LDMxLjYtNi40LDkuNC0xNS42LDE2LjQtMjcuNiwyMS0xMS45LDQuNy0yNi45LDctNDQuOCw3Wk04OTIuNiw1MzAuMWMtMy43LDAtNi44LDEtOS40LDIuOS0yLjUsMS45LTQuNCw0LjgtNS42LDguNy0xLjIsMy45LTIsNy44LTIuNCwxMS44LS40LDQuMS0uNiw5LS42LDE0LjgsMCwyLjgsMCw3LC4yLDEyLjUuMSw1LjYuMiw5LjguMiwxMi41aDMzLjRzMC0zMS4xLDAtMzEuMWMwLTIxLjUtNS4zLTMyLjItMTYtMzIuMloiLz4KICAgIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xMDc1LjQsNzgyLjFjLTU5LjUsMC04OS4yLTMwLjktODkuMy05Mi45di0xMTkuOGMtLjItMjguNSw3LjgtNTEuMiwyMy43LTY3LjksMTUuOS0xNi43LDM3LjctMjUuMSw2NS4zLTI1LjIsMjcuNywwLDQ5LjYsOC4zLDY1LjUsMjUsMTUuOSwxNi43LDIzLjksMzkuMywyNCw2Ny45djExOS44Yy4yLDMxLjItNy40LDU0LjUtMjIuNiw2OS45LTE1LjIsMTUuNC0zNy40LDIzLjEtNjYuNiwyMy4yWk0xMDU4LjQsNTU4djE0NS45Yy4yLDgsMS43LDEzLjgsNC44LDE3LjQsMy4xLDMuNiw3LjEsNS41LDEyLjEsNS41LDQuOSwwLDguOS0xLjgsMTItNS41LDMuMS0zLjcsNC43LTkuNSw0LjctMTcuNHYtMTQ1LjljLS4yLTE3LjQtNS43LTI2LjEtMTYuOS0yNi4xLTExLjEsMC0xNi43LDguNy0xNi43LDI2LjFaIi8+CiAgICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTE3Mi4yLDc4MC43bC0uMy0zMDAuN2g3MS43YzAsMCwwLDM0LjQsMCwzNC40LDIuOS0xMyw4LjQtMjIuNSwxNi4zLTI4LjcsNy45LTYuMSwxNy42LTkuMiwyOC45LTkuMiwxOC44LDAsMzMuNSw1LjksNDMuOSwxNy43LDEwLjQsMTEuOCwxNS43LDMwLDE1LjcsNTQuNmwuMiwyMzEuOGgtNzAuN2MwLDAtLjMtMjI0LjMtLjMtMjI0LjMsMC02LjMtMS4zLTExLjgtMy44LTE2LjYtMi41LTQuOC02LjYtNy4yLTEyLjItNy4yLTMuNSwwLTYuNCwxLTguOCwyLjktMi40LDEuOS00LjIsNC4xLTUuMyw2LjYtMS4xLDIuNS0yLDUuNy0yLjcsOS43LS43LDQtMSw3LjEtMS4xLDkuMiwwLDIuMS0uMSw0LjksMCw4LjRsLjIsMjExLjRoLTcxLjdaIi8+CiAgICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTQ0MSw3ODRjLTEwLjcsMC0yMC40LTEuMS0yOS4xLTMuMy04LjctMi4yLTE2LTUuMS0yMS45LTguNi02LTMuNS0xMS4xLTgtMTUuNC0xMy40LTQuMy01LjQtNy44LTEwLjktMTAuMy0xNi41LTIuNS01LjYtNC42LTEyLTYuMS0xOS4yLTEuNS03LjItMi42LTEzLjktMy0yMC0uNS02LjEtLjctMTMtLjctMjAuNHYtMTIwLjhjLS4yLTI3LjYsNy43LTQ4LjgsMjMuNS02My40LDE1LjgtMTQuNiwzNy45LTIyLDY2LjQtMjIsNTcuNywwLDg2LjYsMjguNCw4Ni42LDg1LjJ2MjEuOGMwLDI3LjEtLjIsNDUuNy0uNyw1NS45aC0xMDQuMmMwLC4xLDAsNDIuMiwwLDQyLjIsMCwxLjMsMCwzLjUsMCw2LjUsMCwzLS4xLDUuMywwLDYuOSwwLDQuOC4yLDguOS42LDEyLjMuNCwzLjQsMS4xLDYuOSwyLjIsMTAuNCwxLjEsMy41LDIuOSw2LjIsNS4zLDgsMi41LDEuOCw1LjYsMi43LDkuMywyLjcsMy45LDAsNy0xLjQsOS40LTQuMSwyLjQtMi43LDQuMS02LjcsNS4xLTExLjgsMS01LjEsMS42LTkuNywxLjktMTMuNy4zLTQsLjQtOSwuNC0xNSwwLTExLjgtLjEtMTguMi0uNC0xOS4yaDcxLjNjMCwwLDAsMTYuOSwwLDE2LjksMCwxNi43LTEuMiwzMC45LTMuOCw0Mi43LTIuNSwxMS44LTcsMjIuMy0xMy41LDMxLjgtNi41LDkuNC0xNS43LDE2LjUtMjcuNywyMS4yLTEyLDQuNy0yNyw3LTQ1LjEsNy4xWk0xNDQzLjUsNTMwLjJjLTMuNywwLTYuOSwxLTkuNCwyLjktMi41LDEuOS00LjQsNC44LTUuNiw4LjctMS4yLDMuOS0yLDcuOC0yLjQsMTEuOS0uNCw0LjEtLjYsOS4xLS42LDE0LjksMCwyLjgsMCw3LC4yLDEyLjYuMSw1LjYuMiw5LjguMiwxMi42aDMzLjdzMC0zMS4zLDAtMzEuM2MwLTIxLjYtNS40LTMyLjUtMTYuMS0zMi40WiIvPgogICAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTE1NDQuNCw0MjcuNWg2OS43YzAsMCwwLDYzLjgsMCw2My44aDEyLjhzMCw1NC43LDAsNTQuN2gtMTIuOHMuMiwxNjkuMS4yLDE2OS4xYzAsMi41LDAsNC41LjIsNiwuMSwxLjUuNCwzLC44LDQuNy40LDEuNywxLjIsMi45LDIuMywzLjYsMS4xLjcsMi42LDEuMSw0LjMsMS4xLDEuNywwLDMuNS0uMyw1LjItLjh2NDguOWMtMTAuMSwzLjUtMjIuOCw1LjItMzguMiw1LjMtNy43LDAtMTQuNC0xLTE5LjktMy4xLTUuNS0yLjEtOS45LTQuNi0xMi45LTcuNi0zLjEtMy01LjUtNi45LTcuMy0xMS42LTEuOC00LjctMi45LTkuMi0zLjQtMTMuMy0uNS00LjEtLjctOC45LS43LTE0LjJsLS4yLTE4Ny45aC0xMXMwLTU0LjcsMC01NC43aDExczAtNjMuOSwwLTYzLjlaIi8+CiAgPC9nPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xNjc0LjUsNDQ5LjZjMCwzLjItLjYsNi4yLTEuOCw5LTEuMiwyLjgtMi44LDUuMi00LjksNy4zLTIuMSwyLjEtNC41LDMuNy03LjMsNC45LTIuOCwxLjItNS44LDEuOC05LDEuOHMtNi40LS42LTkuMi0xLjdjLTIuOC0xLjItNS4yLTIuNy03LjItNC43LTItMi0zLjYtNC40LTQuNy03LjItMS4xLTIuOC0xLjctNS44LTEuNy05LjFzLjYtNi4yLDEuOC05YzEuMi0yLjgsMi44LTUuMiw0LjktNy4yLDIuMS0yLjEsNC41LTMuNyw3LjMtNC44LDIuOC0xLjIsNS44LTEuOCw5LjEtMS44czYuNC42LDkuMiwxLjdjMi44LDEuMSw1LjIsMi43LDcuMiw0LjcsMiwyLDMuNiw0LjQsNC43LDcuMiwxLjEsMi44LDEuNyw1LjgsMS43LDkuMVpNMTY2OS4zLDQ1MGMwLTIuOC0uNC01LjMtMS4zLTcuNi0uOS0yLjMtMi4xLTQuMi0zLjctNS44LTEuNi0xLjYtMy40LTIuOS01LjYtMy43LTIuMS0uOS00LjUtMS4zLTctMS4zcy01LjEuNS03LjMsMS40LTQsMi4yLTUuNiwzLjljLTEuNiwxLjYtMi44LDMuNS0zLjYsNS43LS44LDIuMi0xLjMsNC41LTEuMyw2LjlzLjQsNS4yLDEuMyw3LjVjLjksMi4zLDIuMSw0LjIsMy43LDUuOCwxLjYsMS42LDMuNCwyLjksNS42LDMuOCwyLjEuOSw0LjUsMS4zLDcsMS4zczUuMS0uNSw3LjMtMS40YzIuMi0xLDQuMS0yLjIsNS42LTMuOSwxLjUtMS42LDIuNy0zLjUsMy42LTUuNy44LTIuMiwxLjMtNC41LDEuMy02LjlaTTE2NjIuMyw0NjAuN2MwLC4yLDAsLjMsMCwuNCwwLC4xLS4yLjItLjQuM3MtLjYuMS0xLC4xYy0uNCwwLTEsMC0xLjgsMHMtMS4yLDAtMS42LDBjLS40LDAtLjctLjEtMS0uMi0uMywwLS40LS4yLS42LS40LS4xLS4yLS4yLS40LS4zLS43bC0xLjItNGMtLjUtMS40LTEtMi41LTEuNy0zLS42LS42LTEuNi0uOC0yLjktLjhoLTEuNnY4LjJjMCwuNC0uMi43LS41LjktLjMuMi0xLjEuMi0yLjMuMnMtMiwwLTIuNC0uMmMtLjQtLjItLjYtLjQtLjYtLjl2LTIxYzAtLjkuMi0xLjUuNi0yLC40LS41LDEuMS0uNywxLjktLjdoNi43YzEuNiwwLDIuOS4xLDQuMS40LDEuMi4zLDIuMi43LDMsMS4zLjguNiwxLjUsMS4zLDEuOSwyLjIuNC45LjYsMS45LjYsMy4xLDAsMS45LS41LDMuMy0xLjUsNC40LTEsMS0yLjQsMS44LTQuMSwyLjIuOS4zLDEuOC44LDIuNiwxLjYuOC43LDEuNSwxLjksMi4xLDMuM2wxLjQsMy44Yy4zLjkuNCwxLjUuNCwxLjdaTTE2NTUuMSw0NDQuNWMwLS40LDAtLjgtLjItMS4yLS4xLS40LS4zLS43LS43LTEtLjMtLjMtLjgtLjUtMS4zLS43LS41LS4yLTEuMi0uMi0yLjEtLjJoLTIuN3Y2LjZoMi42YzEuNiwwLDIuOC0uMywzLjQtLjkuNi0uNi45LTEuNC45LTIuNVoiLz4KPC9zdmc+";

function renderInline(text: string): any[] {
  const out: any[] = [];
  const boldParts = (text || "").split(/(\*\*[^*]+\*\*)/g);
  let k = 0;
  for (const p of boldParts) {
    if (p.startsWith("**") && p.endsWith("**")) { out.push(<strong key={k++}>{p.slice(2, -2)}</strong>); continue; }
    const italicParts = p.split(/(\*[^*\n]+\*)/g);
    for (const ip of italicParts) {
      if (ip.length > 2 && ip.startsWith("*") && ip.endsWith("*")) out.push(<em key={k++}>{ip.slice(1, -1)}</em>);
      else if (ip) out.push(<span key={k++}>{ip}</span>);
    }
  }
  return out;
}

// Render an array of paragraph strings, grouping consecutive lines that
// start with "- " or "* " into a single <ul>. A paragraph string can itself
// contain multiple lines separated by \n — each line is treated independently
// so an editor can mix bullets and prose inside one textarea entry.
function renderParagraphs(paragraphs: string[]): any[] {
  const out: any[] = [];
  let bullets: string[] = [];
  let key = 0;
  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    out.push(
      <ul key={`ul-${key++}`} className="mk-bullets">
        {items.map((b, i) => <li key={i}>{renderInline(b)}</li>)}
      </ul>
    );
  };
  for (const raw of paragraphs || []) {
    const lines = String(raw || "").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m) {
        bullets.push(m[1]);
      } else {
        flushBullets();
        if (line.trim()) out.push(<p key={`p-${key++}`}>{renderInline(line)}</p>);
      }
    }
    // End of textarea entry — still flush before the next entry so adjacent
    // bullet-only entries combine into a single list visually.
  }
  flushBullets();
  return out;
}

// ─── Proposal block: prepared-for + total + summary + CTAs (Accept / Request changes / Talk to us)
function ProposalBlock({ content, share, kit, slug, token, scope, tiers, boltons, termsText }: { content: any; share: any; kit: Kit; slug: string; token: string; scope?: ProposalScope | null; tiers: Addon[]; boltons: Addon[]; termsText?: string }) {
  const c = content || {};
  const preparedFor = c.prepared_for || share?.prospect_company || share?.prospect_name || "";
  const subtitle = c.subtitle || "";
  // When auto_total is on AND we have a computed scope total, prefer it. Otherwise fall back to manual total_value.
  const useAuto = scope?.auto_total && scope?.computed_total != null;
  const totalValue = useAuto ? scope!.computed_total : c.total_value;
  const totalCurrency = scope?.tier?.price_currency || scope?.boltons?.[0]?.price_currency || c.total_currency || kit.base_currency || "USD";
  const totalPeriod = c.total_period || "";
  const summaryLine = c.summary_line || "";
  const validUntil = c.valid_until || "";
  const notes = c.notes || "";

  const state = (share?.proposal_state || "draft") as string;
  const ctaActive = state === "sent" || state === "viewed" || state === "changes_requested";
  const accepted = state === "accepted";
  const declined = state === "declined";

  const fmtTotal = () => {
    if (totalValue == null || totalValue === "") return null;
    const num = Number(totalValue);
    if (!isFinite(num)) return String(totalValue);
    return new Intl.NumberFormat("en-US", { style: "currency", currency: String(totalCurrency).toUpperCase(), maximumFractionDigits: 0 }).format(num);
  };
  const fmtDate = (iso: string) => {
    if (!iso) return "";
    try {
      const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
      return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
    } catch { return iso; }
  };

  const [modal, setModal] = useState<null | "request">(null);
  const [busy, setBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function submitAction(kind: "accept" | "request-changes" | "decline", payload: any) {
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await fetch(`/api/media-kit/public/${slug}/${kind}?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(payload || {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `Error ${r.status}`);
      if (kind === "accept") setDoneMsg("Thank you. Your acceptance has been recorded and our team will be in touch shortly.");
      else if (kind === "request-changes") setDoneMsg("Thanks. We have received your message and will be in touch soon.");
      else setDoneMsg("Thanks for letting us know.");
      setModal(null);
    } catch (e: any) {
      setErrMsg(e?.message || "Something went wrong. Please try again or email us directly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="proposal-block">
      <div className="proposal-head">
        <div className="proposal-label">Personalised Proposal</div>
        {c.client_logo_url && (
          <div className="proposal-client-logo">
            <img src={c.client_logo_url} alt={preparedFor || "Client logo"} loading="lazy" />
          </div>
        )}
        {preparedFor && <h2 className="proposal-prepared">Prepared for <span className="accent">{preparedFor}</span></h2>}
        {subtitle && (
          <div className="proposal-subtitle">
            {/* Custom intro paragraph — supports newlines + light markdown
                (**bold**, *italic*, - bullets). Editors expect blank lines
                between paragraphs to render as paragraph breaks. */}
            {renderParagraphs(subtitle.split(/\n{2,}/))}
          </div>
        )}
        {/* Campaign region scope — surfaces "Global — all four regions" or the
            specific regional mix so the prospect knows what coverage their
            spend buys. */}
        {Array.isArray(c.region_labels) && c.region_labels.length > 0 && (
          <div className={`proposal-regions ${c.is_global ? "proposal-regions-global" : ""}`}>
            <span className="proposal-regions-label">Campaign coverage</span>
            <div className="proposal-regions-chips">
              {c.is_global && <span className="proposal-regions-banner">Global — all four regions</span>}
              {c.region_labels.map((r: string) => (
                <span key={r} className="proposal-region-chip">{r}</span>
              ))}
            </div>
          </div>
        )}
      </div>
      {(fmtTotal() || summaryLine || validUntil || scope?.tier || (scope?.boltons?.length || 0) > 0) && (
        <div className="proposal-summary">
          {fmtTotal() && (
            <div className="proposal-total">
              <div className="proposal-total-label">Your investment</div>
              <div className="proposal-total-value">{fmtTotal()}{totalPeriod ? <span className="proposal-total-period"> {totalPeriod}</span> : null}</div>
            </div>
          )}
          {(scope?.tier || (scope?.boltons?.length || 0) > 0 || summaryLine) && (
            <div className="proposal-summary-line">
              {scope?.tier && <div><strong>Your package:</strong> {scope.tier.label}</div>}
              {scope?.boltons && scope.boltons.length > 0 && (
                <div>
                  <strong>Plus:</strong>{" "}
                  {scope.boltons.map((b, i) => (
                    <span key={b.addon_key}>
                      {(b.quantity && b.quantity > 1) ? `${b.quantity}× ` : ""}{b.label}
                      {i < scope.boltons!.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </div>
              )}
              {summaryLine && <div className="text-muted">{summaryLine}</div>}
            </div>
          )}
          {validUntil && <div className="proposal-valid">Valid until {fmtDate(validUntil)}</div>}
        </div>
      )}
      {notes && <div className="proposal-notes">{notes.split(/\n+/).map((p: string, i: number) => <p key={i}>{p}</p>)}</div>}

      {accepted && (
        <div className="proposal-status accepted">
          <div className="proposal-status-title">Proposal accepted</div>
          {share?.accepted_by_name && <div className="proposal-status-sub">Accepted by {share.accepted_by_name}{share.accepted_at ? ` on ${fmtDate(share.accepted_at)}` : ""}. Our team will be in touch.</div>}
        </div>
      )}
      {declined && (
        <div className="proposal-status declined">
          <div className="proposal-status-title">This proposal has been declined</div>
          <div className="proposal-status-sub">If this was a mistake, please contact us and we will reopen it.</div>
        </div>
      )}
      {/* If the proposal block has rich wizard-stamped fields, render the full
          Investment / Discount / Acceptance flow regardless of share state —
          owners need to preview the layout while the share is still 'draft',
          and prospects need it once it's 'sent'/'viewed'. The Accept/Decline
          buttons inside RichProposalDetail are themselves gated on `ctaActive`. */}
      {!doneMsg && c.monthly_subtotal != null && (
        <RichProposalDetail
          c={c}
          share={share}
          slug={slug}
          token={token}
          termsText={termsText || ""}
          busy={busy}
          errMsg={errMsg}
          ctaActive={ctaActive}
          setBusy={setBusy}
          setErrMsg={setErrMsg}
          setDoneMsg={setDoneMsg}
          onAccepted={() => submitAction("accept", {})}
        />
      )}
      {ctaActive && !doneMsg && c.monthly_subtotal == null && (
        <div className="proposal-ctas">
          <button className="cta-primary" onClick={() => setModal("request")} disabled={busy}>Request Proposal</button>
        </div>
      )}
      {doneMsg && <div className="proposal-status accepted"><div className="proposal-status-title">{doneMsg}</div></div>}

      {modal === "request" && (
        <RequestProposalModal
          tiers={tiers}
          boltons={boltons}
          defaultName={share?.prospect_name || ""}
          defaultEmail={share?.prospect_email || ""}
          defaultCompany={share?.prospect_company || ""}
          busy={busy}
          error={errMsg}
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            setBusy(true); setErrMsg(null);
            try {
              const r = await fetch(`/api/media-kit/public/${slug}/request-proposal?t=${encodeURIComponent(token)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(v),
              });
              const j = await r.json();
              if (!r.ok) throw new Error(j?.message || `Request failed (${r.status})`);
              setModal(null);
              setDoneMsg("Thanks. Your proposal request is on its way to our team and we will follow up by email within one business day.");
            } catch (e: any) {
              setErrMsg(e?.message || "Something went wrong");
            } finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

// ─── Request Proposal modal: tier picker + bolt-on checkboxes + notes ───────────────────────────
function RequestProposalModal(props: {
  tiers: Addon[];
  boltons: Addon[];
  defaultName?: string;
  defaultEmail?: string;
  defaultCompany?: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (v: { name: string; email: string; company: string; tier: string; boltons: string[]; message: string }) => void;
}) {
  const [name, setName] = useState(props.defaultName || "");
  const [email, setEmail] = useState(props.defaultEmail || "");
  const [company, setCompany] = useState(props.defaultCompany || "");
  const [tier, setTier] = useState("");
  const [selectedBoltons, setSelectedBoltons] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const visibleTiers = (props.tiers || []).filter(t => t.is_visible !== 0);
  const visibleBoltons = (props.boltons || []).filter(b => b.is_visible !== 0);
  const canSubmit = name.trim().length > 0 && email.trim().length > 0 && tier.trim().length > 0;
  const toggleBolton = (label: string) => {
    setSelectedBoltons(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]);
  };
  return (
    <div className="proposal-modal-backdrop" onClick={props.onClose}>
      <div className="proposal-modal request-proposal-modal" onClick={e => e.stopPropagation()}>
        <div className="proposal-modal-head">
          <h3>Request your proposal</h3>
          <button className="proposal-modal-close" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <p className="proposal-modal-intro">Tell us which package fits best and any bolt-ons you would like included. We will follow up with a formal proposal tailored to your selections.</p>
        <div className="rp-body">
          <div className="rp-section">
            <div className="rp-section-title">Which package interests you?</div>
            <div className="rp-options">
              {visibleTiers.length === 0 && <div className="rp-empty">(No packages have been published on this kit yet.)</div>}
              {visibleTiers.map((t: any) => {
                const checked = tier === t.label;
                return (
                  <label key={t.id} className={`rp-row${checked ? " rp-row-selected" : ""}`}>
                    <input type="radio" name="tier" value={t.label} checked={checked} onChange={() => setTier(t.label)} />
                    <span className="rp-row-body">
                      <span className="rp-row-title">{t.label}</span>
                      {t.price_value != null && (
                        <span className="rp-row-meta">{(t.price_currency || "").toUpperCase()} {Number(t.price_value).toLocaleString()}{t.price_suffix ? " " + t.price_suffix : ""}</span>
                      )}
                      {t.description && <span className="rp-row-desc">{t.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          {visibleBoltons.length > 0 && (
            <div className="rp-section">
              <div className="rp-section-title">Optional bolt-ons</div>
              <div className="rp-options">
                {visibleBoltons.map((b: any) => {
                  const checked = selectedBoltons.includes(b.label);
                  return (
                    <label key={b.id} className={`rp-row${checked ? " rp-row-selected" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleBolton(b.label)} />
                      <span className="rp-row-body">
                        <span className="rp-row-title">{b.label}</span>
                        {b.price_value != null && (
                          <span className="rp-row-meta">{(b.price_currency || "").toUpperCase()} {Number(b.price_value).toLocaleString()}{b.price_suffix ? " " + b.price_suffix : ""}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="rp-section">
            <div className="rp-section-title">Anything else we should know?</div>
            <textarea className="rp-textarea" rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Timing, campaign goals, products you want to feature, questions for us…" />
          </div>
          <div className="rp-grid-2">
            <div className="rp-field">
              <label className="rp-field-label">Your name</label>
              <input className="rp-input" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="rp-field">
              <label className="rp-field-label">Your email</label>
              <input className="rp-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
          </div>
          <div className="rp-field">
            <label className="rp-field-label">Company</label>
            <input className="rp-input" type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Your company" />
          </div>
        </div>
        {props.error && <div className="proposal-modal-error">{props.error}</div>}
        <div className="proposal-modal-actions">
          <button className="cta-tertiary" onClick={props.onClose} disabled={props.busy}>Cancel</button>
          <button className="cta-primary" disabled={!canSubmit || props.busy} onClick={() => props.onSubmit({ name: name.trim(), email: email.trim(), company: company.trim(), tier, boltons: selectedBoltons, message: message.trim() })}>
            {props.busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProposalModal(props: {
  title: string; intro: string; submitLabel: string;
  requireName?: boolean; requireMessage?: boolean; showEmail?: boolean;
  busy?: boolean; error?: string | null;
  defaultName?: string;
  defaultEmail?: string;
  onClose: () => void;
  onSubmit: (v: { name: string; email: string; message: string }) => void;
}) {
  const [name, setName] = useState(props.defaultName || "");
  const [email, setEmail] = useState(props.defaultEmail || "");
  const [message, setMessage] = useState("");
  const canSubmit = (!props.requireName || name.trim().length > 0) && (!props.requireMessage || message.trim().length > 0);
  return (
    <div className="proposal-modal-backdrop" onClick={props.onClose}>
      <div className="proposal-modal" onClick={e => e.stopPropagation()}>
        <div className="proposal-modal-head">
          <h3>{props.title}</h3>
          <button className="proposal-modal-close" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <p className="proposal-modal-intro">{props.intro}</p>
        <div className="proposal-modal-fields">
          {props.requireName && (
            <label>
              <span>Your name</span>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" autoFocus />
            </label>
          )}
          {props.showEmail && (
            <label>
              <span>Your email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
            </label>
          )}
          {props.requireMessage && (
            <label>
              <span>Message</span>
              <textarea rows={4} value={message} onChange={e => setMessage(e.target.value)} placeholder="What would you like to discuss?" />
            </label>
          )}
        </div>
        {props.error && <div className="proposal-modal-error">{props.error}</div>}
        <div className="proposal-modal-actions">
          <button className="cta-tertiary" onClick={props.onClose} disabled={props.busy}>Cancel</button>
          <button className="cta-primary" disabled={!canSubmit || props.busy} onClick={() => props.onSubmit({ name: name.trim(), email: email.trim(), message: message.trim() })}>
            {props.busy ? "Sending…" : props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sections ───────────────────────────────────────────────────────────────
function Section({ children, alt }: { children: any; alt?: boolean }) {
  return <section className={`section ${alt ? "section-alt" : ""}`}><div className="section-inner">{children}</div></section>;
}

function Hero({ kit, share, content, hasProposal }: { kit: Kit; share: any; content: any; hasProposal?: boolean }) {
  const cur = useCurrency();
  const c = content || {};
  const bg = c.background_image && String(c.background_image).trim();
  const heroStyle: React.CSSProperties = bg
    ? {
        backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.75) 100%), url("${bg}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }
    : {};
  return (
    <section className="hero" style={heroStyle}>
      <div className="hero-inner">
        <div className="brand-row">
          <div className="brand">
            <img src={STEREONET_LOGO_DATA_URI} alt="StereoNET" className="brand-logo" />
            <span className="brand-pitch">MEDIA KIT</span>
          </div>
        </div>
        {/* Prepared-for headline: shown on the screen only when there's no
            proposal block beneath (that block already has "Prepared for…"),
            but ALWAYS shown in print so the saved PDF's cover has the prospect
            name centred on page 1. */}
        {share?.prospect_company && (
          <h1 className={`hero-title ${hasProposal ? "print-only" : ""}`} data-prospect={share.prospect_company}>Prepared for {share.prospect_company}</h1>
        )}
        <div className="hero-meta">
          <span className="region-chip">{c.region_label || (kit.region || "GLOBAL").toUpperCase()}</span>
          <span>·</span>
          <span>{kit.kind === "retailer" ? `${cur.display} ${cur.taxSuffix}` : `${kit.base_currency} ${kit.tax_suffix || ""}`}</span>
        </div>
        {share?.prospect_name && (
          <p className={`hero-personal ${hasProposal ? "print-only" : ""}`}>For the attention of {share.prospect_name}</p>
        )}
        {/* Marketing headline + supporting line. Editable via the hero block
            (content.headline, content.supporting_line). Falls back to the
            current copy so existing kits don't go blank. */}
        {(c.headline || c.supporting_line) && (
          <div className="hero-pitch">
            {c.headline && <h2 className="hero-headline">{c.headline}</h2>}
            {c.supporting_line && <p className="hero-supporting">{c.supporting_line}</p>}
          </div>
        )}
        {/* Three numeric proof points stamped onto the hero. */}
        {Array.isArray(c.proof_points) && c.proof_points.length > 0 && (
          <div className="hero-proof">
            {c.proof_points.map((p: any, i: number) => (
              <div key={i} className="hero-proof-tile">
                <div className="hero-proof-num">{p.value}</div>
                <div className="hero-proof-lbl">{p.label}</div>
              </div>
            ))}
          </div>
        )}
        {/* Print-only date stamp on the cover */}
        <p className="print-only hero-date">{new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</p>
      </div>
    </section>
  );
}

function WhoAreWe({ content }: { content: any }) {
  return (
    <>
      <h2>{content.heading || "Who Are We"}</h2>
      {content.subheading && <p className="section-sub">{content.subheading}</p>}
      {content.epigraph && <blockquote>{content.epigraph}<cite>{content.epigraph_attribution}</cite></blockquote>}
      {renderParagraphs(content.paragraphs || [])}
    </>
  );
}

function WhyUs({ content }: { content: any }) { return <WhoAreWe content={{ ...content, heading: content.heading || "Why Us" }} />; }

function Audience({ content, kit }: { content: any; kit: Kit }) {
  const split = content.region_split || [];
  return (
    <>
      <h2>{content.heading || "We Found The Buyers"}</h2>
      {content.subheading && <p className="section-sub orange-sub">{content.subheading}</p>}
      <div className="audience-grid">
        {split.map((r: any, i: number) => (
          <div key={i} className="audience-card">
            <div className="audience-pct">{r.pct?.toFixed?.(2) || r.pct}%</div>
            <div className="audience-label">{r.region}</div>
            <div className="audience-bar"><div className="audience-bar-fill" style={{ width: `${Math.min(100, r.pct)}%` }} /></div>
          </div>
        ))}
      </div>
      <p className="muted small mt-3">Through the use of our intelligent geo-routing scripts, global readers are shown only region-specific and relevant advertising and content.</p>
    </>
  );
}

// Shared audience-stats block: matches /advertising page styling. Hardcoded numbers
// (per user instruction). Uses kit-page CSS variables so it inherits the dark theme.
function AudienceStats({ content }: { content: any }) {
  const c = content || {};
  const heading = c.heading || "The numbers brands want to see";
  const subheading = c.subheading || "verified audience and AI visibility";
  const footnote = c.footnote || "Actual human traffic only — bots filtered. Source data: Google Analytics 4 (audience), Cloudflare (AI bot traffic).";
  return (
    <div className="audstats">
      <h2>{heading}</h2>
      <p className="section-sub orange-sub">{subheading}</p>

      <div className="audstats-row">
        <div className="audstats-row-label">Audience Quality</div>
        <div className="audstats-grid">
          <div className="audstats-card">
            <div className="audstats-num">590K+<sup>*</sup></div>
            <div className="audstats-label">Monthly Human Visitors</div>
            <div className="audstats-sub">Bots removed · GA4 verified</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">1.3M+</div>
            <div className="audstats-label">Human Page Views / Month</div>
            <div className="audstats-sub">Bots removed · GA4 verified</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">86%</div>
            <div className="audstats-label">In Hobby 20+ Years</div>
            <div className="audstats-sub">StereoNET Reader Survey</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">#11</div>
            <div className="audstats-label">Similarweb Global Rank</div>
            <div className="audstats-sub">Consumer Electronics</div>
          </div>
        </div>
      </div>

      <div className="audstats-row">
        <div className="audstats-row-label">AI Visibility</div>
        <div className="audstats-grid">
          <div className="audstats-card">
            <div className="audstats-num">2M+</div>
            <div className="audstats-label">AI Crawls / Month</div>
            <div className="audstats-sub">GPTBot, ClaudeBot, PerplexityBot, Amazonbot et al.</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">170K+</div>
            <div className="audstats-label">ChatGPT-User Hits / Month</div>
            <div className="audstats-sub">Real-time AI lookups citing StereoNET</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">11K+</div>
            <div className="audstats-label">PerplexityBot Crawls / Month</div>
            <div className="audstats-sub">Plus dedicated grounding traffic</div>
          </div>
          <div className="audstats-card">
            <div className="audstats-num">1.8K+</div>
            <div className="audstats-label">Click-throughs from AI Chats</div>
            <div className="audstats-sub">Humans arriving via ChatGPT, Perplexity, Claude…</div>
          </div>
        </div>
      </div>

      <p className="audstats-footnote"><sup>*</sup> {footnote}</p>
    </div>
  );
}

function AudienceGrid({ content }: { content: any }) {
  // Hide tiles that duplicate the AudienceStats block above (monthly readers / pageviews / hobby-years).
  const allTiles = (content.tiles || []) as { label: string; value: string; note?: string }[];
  const duplicatePatterns = [
    /monthly\s+readers?/i,
    /monthly\s+(unique\s+)?visitors?/i,
    /monthly\s+page\s*views?/i,
    /page\s*views?\s*\/\s*month/i,
    /audience\s+in\s+hobby/i,
    /in\s+hobby/i,
  ];
  const tiles = allTiles.filter(t => !duplicatePatterns.some(rx => rx.test(t.label || "")));
  return (
    <>
      <h2>{content.heading || "Our Audience"}</h2>
      {content.subheading && <p className="section-sub orange-sub">{content.subheading}</p>}
      <div className="ag-grid">
        {tiles.map((t, i) => (
          <div key={i} className="ag-tile">
            <div className="ag-value">{t.value}</div>
            <div className="ag-label">{t.label}</div>
            {t.note && <div className="ag-note">{t.note}</div>}
          </div>
        ))}
      </div>
      {content.footer_note && <p className="muted small mt-3 ag-source">{content.footer_note}</p>}
    </>
  );
}

function SectionConnector({ label }: { label: string }) {
  return (
    <div className="sc-wrap" aria-hidden={false}>
      <div className="sc-line" />
      <div className="sc-pill">{label}</div>
      <div className="sc-arrow">↓</div>
    </div>
  );
}

// ─── Broadstreet live-ads integration ────────────────────────────────────────
// Re-inject the Broadstreet init script every time we need to scan for new <ins>
// elements. The script is small (~1.5KB), idempotent on the server, and the
// browser caches it. This is more reliable than calling window.broadstreet.refresh()
// because the public API surface of init-2.min.js isn't documented/stable.
let _bsScanTimer: ReturnType<typeof setTimeout> | null = null;
function triggerBroadstreetScan() {
  // Debounce — multiple <BroadstreetAd> mounts batch into ONE scan.
  if (_bsScanTimer) clearTimeout(_bsScanTimer);
  _bsScanTimer = setTimeout(() => {
    _bsScanTimer = null;
    const existing = document.getElementById("broadstreet-init-script");
    if (existing) existing.remove();
    const s = document.createElement("script");
    s.id = "broadstreet-init-script";
    s.src = "https://cdn.broadstreetads.com/init-2.min.js";
    s.async = true;
    document.head.appendChild(s);
  }, 200);
}

function BroadstreetLoader() {
  // Mounted at app shell. Initial scan on first paint.
  useEffect(() => {
    triggerBroadstreetScan();
  }, []);
  return null;
}

function BroadstreetAd({ zoneId, label }: { zoneId: string; label?: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    triggerBroadstreetScan();
    // On unmount, clear anything Broadstreet injected into our wrapper.
    return () => {
      if (ref.current) {
        // Remove any iframes / divs Broadstreet appended outside of React's control.
        ref.current.querySelectorAll("iframe, div[id^='street-'], div[id^='broadstreet-']").forEach(el => el.remove());
      }
    };
  }, [zoneId]);
  if (!zoneId) return null;
  return (
    <div className="bs-ad-wrap" ref={ref}>
      {label && <div className="bs-ad-label">{label}</div>}
      {/* Broadstreet ins tag — do not modify attribute structure */}
      <ins
        // @ts-ignore — data-* attrs typed loosely
        data-type="broadstreet"
        data-zone-id={zoneId}
        data-click-url-empty=""
      />
    </div>
  );
}

// One-shot masthead reveal — once opened, stays open. No close button.
function MastheadToggle({ zoneId }: { zoneId: string }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const rowRef = React.useRef<HTMLDivElement | null>(null);

  const open = () => {
    const host = hostRef.current;
    if (host && host.dataset.open !== "1") {
      host.dataset.open = "1";
      host.style.display = "block";
      host.innerHTML = `
        <div class="bs-masthead">
          <div class="bs-ad-wrap">
            <ins data-type="broadstreet" data-zone-id="${zoneId}" data-click-url-empty=""></ins>
          </div>
        </div>
      `;
      triggerBroadstreetScan();
    }
    // Hide the toggle row after open so the masthead just stays.
    if (rowRef.current) rowRef.current.style.display = "none";
  };

  return (
    <div className="bs-masthead-block">
      <div
        ref={hostRef}
        className="bs-masthead-wrap"
        data-open="0"
        style={{ display: "none" }}
      />
      <div ref={rowRef} className="bs-masthead-toggle-row">
        <button
          className="bs-masthead-toggle"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}
          type="button"
        >
          <span className="bs-toggle-dot" />
          <span>Preview the StereoNET masthead ad</span>
        </button>
      </div>
    </div>
  );
}

function FeaturedArticle({ content }: { content: any }) {
  return (
    <div className="fa-card">
      <div className="fa-left">
        {content.eyebrow && <div className="fa-eyebrow">{content.eyebrow}</div>}
        <h3 className="fa-headline">{content.headline}</h3>
        {content.pull_quote && (
          <blockquote className="fa-quote">
            <span className="fa-quote-mark">“</span>
            {content.pull_quote}
            <span className="fa-quote-mark">”</span>
          </blockquote>
        )}
        {content.intro_paragraph && <p className="fa-intro">{content.intro_paragraph}</p>}
        <div className="fa-meta">
          {content.author && <span><strong>{content.author}</strong>{content.author_role ? ` — ${content.author_role}` : ""}</span>}
          {content.published && <span className="fa-meta-divider">· {content.published}</span>}
        </div>
        {content.url && (
          <a href={content.url} target="_blank" rel="noopener noreferrer" className="fa-cta">
            {content.cta_label || "Read the article"} →
          </a>
        )}
      </div>
    </div>
  );
}

// Find a Store / Driving Consumers to Retailers — retailer-kit-only block.
// Renders a 3-step explainer of how editorial drives traffic from StereoNET
// articles → brand pages → retailer storefronts. Content-driven so admins can
// tweak heading, intro, steps, and optional pull-quote/footer.
function FindAStore({ content }: { content: any }) {
  const c = content || {};
  const heading = c.heading || "Find a Store \u2014 Driving Consumers to Retailers";
  const intro = c.intro || "StereoNET realises the importance of promoting bricks and mortar stores. Here's how we link the reader and potential customer directly to you \u2014 direct lead generation.";
  const steps: Array<{ title: string; body: string }> = Array.isArray(c.steps) && c.steps.length ? c.steps : [
    { title: "Published news or review links directly to brand page", body: "Every review and news story on StereoNET links straight to the relevant brand page \u2014 not a generic search result." },
    { title: "Brand page displays local retailers", body: "Each brand page lists its authorised dealers, mapped by region. The reader sees you alongside the brand they've just been reading about." },
    { title: "Retailer page displays contact info and store details", body: "Your dedicated store page shows opening hours, contact details, brands you stock, and a direct website link \u2014 turning interest into a phone call or visit." },
  ];
  const footer = c.footer_note || "";
  return (
    <div className="fas-block">
      <div className="fas-head">
        <h2 className="section-heading">{heading}</h2>
        <p className="fas-intro">{intro}</p>
      </div>
      <div className="fas-steps">
        {steps.map((s, i) => (
          <div key={i} className="fas-step">
            <div className="fas-step-num">{i + 1}</div>
            <div className="fas-step-body">
              <div className="fas-step-title">{s.title}</div>
              <div className="fas-step-text">{s.body}</div>
            </div>
          </div>
        ))}
      </div>
      {footer && <p className="fas-footer">{footer}</p>}
    </div>
  );
}

function ResearchSources(_props: { content: any }) {
  // Synced with /advertising page — same data, same copy.
  const sources: { name: string; pct: number; highlight?: boolean }[] = [
    { name: "Hi-fi websites & online publications", pct: 20, highlight: true },
    { name: "Forums & online communities",          pct: 17, highlight: true },
    { name: "YouTube channels / video reviews",     pct: 12 },
    { name: "Hi-fi shops & dealer demos",           pct: 12 },
    { name: "Manufacturer websites",                pct: 9 },
    { name: "Friends, family, colleagues",          pct: 6 },
    { name: "Print magazines",                      pct: 4 },
    { name: "Measurements sites (ASR etc.)",        pct: 4 },
    { name: "AI tools (ChatGPT, Perplexity)",       pct: 2 },
    { name: "Reddit",                               pct: 1 },
    { name: "Social media (IG, TikTok, FB, X)",     pct: 1 },
  ];
  const maxPct = Math.max(...sources.map(s => s.pct));
  return (
    <>
      <h2>Where audiophiles <span className="accent">actually research purchases</span></h2>
      <p className="section-sub orange-sub">Print collapsed. Reddit and AI didn't register. Our audience comes to hi-fi websites and forums — <strong className="accent-strong">and we own both</strong>.</p>
      <div className="rs-highlight">
        <div className="rs-highlight-pct">37%</div>
        <div className="rs-highlight-label">of audiophiles rely on hi-fi websites + forums as their primary purchase research source</div>
      </div>
      <div className="rs-bars">
        {sources.map((s, i) => (
          <div key={i} className={`rs-row ${s.highlight ? "rs-row-hl" : ""}`}>
            <div className="rs-name">{s.name}</div>
            <div className="rs-track">
              <div className="rs-fill" style={{ width: `${(s.pct / maxPct) * 100}%` }} />
            </div>
            <div className="rs-pct">{s.pct}%</div>
          </div>
        ))}
      </div>
      <p className="muted small mt-3 ag-source">StereoNET Reader Survey, May 2026. n=540 active forum members. Question: “Today, when researching a hi-fi purchase, which sources do you rely on most?”</p>
    </>
  );
}

// Hardcoded fallback if the public settings endpoint isn't reachable.
const PARTNERSHIP_DEFAULTS: { title: string; body: string }[] = [
  { title: "Editorial coverage",            body: "News, reviews, features, and opinion. Long-form trust-building from a team that knows hi-fi." },
  { title: "Display advertising",           body: "Weighting depends on marketing package selected." },
  { title: "Expert Reviews",                body: "Up to (X) Reviews per campaign depending on marketing package selected. Results not guaranteed." },
  { title: "Forum sponsorship",             body: "Branded categories and topics in our 100K+ community of audiophile buyers." },
  { title: "Newsletter & EDM",              body: "Dedicated sends and integrated sponsorship to our opt-in subscriber list." },
  { title: "Social campaigns",              body: "Native posts and reels across our 4.7M-reach social network. APAC + UK + US." },
  { title: "Classifieds presence",          body: "Featured listings and sponsor placement on our second-hand marketplace." },
  { title: "Brand & distributor packages",  body: "Complete coverage bundles for manufacturers and regional distributors." },
  { title: "AI discoverability",            body: "Schema markup, AI-training visibility, and structured data so your brand shows up in AI-powered shopping research. No other hi-fi publisher offers this." },
];

// AnalyticsProof: "what your monthly report looks like". Pitches the
// transparency of our reporting (no naming the underlying ad-server). Renders
// a heading + intro + bullet list of metrics + an optional thumbnail link to
// a real example report.
// Pull-quote style callout that anchors price-to-revenue. Placed immediately
// before the Investment table so the 3%-of-turnover frame is the last thing
// the prospect reads before seeing the tier prices.
// WhoWeAreNot: the qualifying-by-disqualifying block. Tells the wrong buyers
// to walk so the right ones lean in. Paragraphs support **bold** markdown and
// inline [link text](url) syntax so the Marc-Rushton article link can be
// embedded mid-sentence.
function WhoWeAreNot({ content }: { content: any }) {
  const c = content || {};
  const heading = c.heading || "Who we are NOT for";
  const subheading = c.subheading || "";
  const paragraphs: string[] = Array.isArray(c.paragraphs) ? c.paragraphs : [];
  const renderInline = (text: string) => {
    // Replace [label](url) with anchors, then **bold** with <strong>.
    const parts: any[] = [];
    let i = 0;
    const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > i) parts.push(text.slice(i, m.index));
      if (m[1] && m[2]) {
        parts.push(<a key={`a${key++}`} href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--orange, #e8312a)", textDecoration: "underline", textUnderlineOffset: 3 }}>{m[1]}</a>);
      } else if (m[3]) {
        parts.push(<strong key={`b${key++}`}>{m[3]}</strong>);
      }
      i = re.lastIndex;
    }
    if (i < text.length) parts.push(text.slice(i));
    return parts;
  };
  return (
    <div className="kit-block">
      <h2 className="kit-h2">{heading}</h2>
      {subheading && <p className="kit-sub">{subheading}</p>}
      <div style={{
        maxWidth: 820,
        padding: "28px 28px",
        borderLeft: "4px solid var(--orange, #e8312a)",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "0 12px 12px 0",
        marginTop: 18,
      }}>
        {paragraphs.map((p, i) => (
          <p key={i} style={{
            fontSize: "clamp(1rem, 1.3vw, 1.15rem)",
            lineHeight: 1.6,
            color: "#e4e4e7",
            margin: i === paragraphs.length - 1 ? 0 : "0 0 16px",
          }}>{renderInline(p)}</p>
        ))}
      </div>
    </div>
  );
}

// PartnerQuotes: social-proof block. Renders 1-N quotes with name + role.
// Designed to sit just before the Investment Callout so brands see real-brand
// trust BEFORE they see your prices.
function PartnerQuotes({ content }: { content: any }) {
  const c = content || {};
  const heading = c.heading || "What our partners say";
  const subheading = c.subheading || "";
  const quotes: Array<{ quote: string; name: string; role?: string; company?: string }> = Array.isArray(c.quotes) ? c.quotes : [];
  if (!quotes.length) return null;
  return (
    <div className="kit-block">
      <h2 className="kit-h2">{heading}</h2>
      {subheading && <p className="kit-sub">{subheading}</p>}
      <div style={{
        display: "grid",
        gridTemplateColumns: quotes.length === 1 ? "1fr" : "repeat(auto-fit, minmax(380px, 1fr))",
        gap: 24,
        marginTop: 24,
        alignItems: "stretch",
      }}>
        {quotes.map((q, i) => (
          <figure key={i} style={{
            margin: 0,
            padding: "56px 28px 24px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}>
            <div aria-hidden="true" style={{
              position: "absolute",
              top: 4, left: 22,
              fontSize: 72,
              lineHeight: 1,
              color: "var(--orange, #e8312a)",
              opacity: 0.35,
              fontFamily: "Georgia, serif",
              fontWeight: 700,
              userSelect: "none",
              pointerEvents: "none",
            }}>“</div>
            <blockquote style={{
              margin: "0 0 18px",
              padding: 0,
              border: 0,
              borderLeft: 0,
              fontSize: "clamp(1rem, 1.25vw, 1.1rem)",
              lineHeight: 1.55,
              color: "#e4e4e7",
              fontStyle: "italic",
              position: "relative",
              zIndex: 1,
              flex: 1,
            }}>{q.quote}</blockquote>
            <figcaption style={{
              fontSize: 13,
              color: "#a1a1aa",
              lineHeight: 1.4,
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: 14,
              marginTop: "auto",
            }}>
              <span style={{ fontWeight: 700, color: "#fafafa" }}>{q.name}</span>
              {(q.role || q.company) && (
                <span style={{ display: "block", marginTop: 2 }}>
                  {q.role}{q.role && q.company ? " · " : ""}{q.company && <span style={{ color: "#cbd5e1" }}>{q.company}</span>}
                </span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function InvestmentCallout({ content }: { content: any }) {
  const c = content || {};
  const lead = c.lead || "Most audio brands invest ~3% of annual turnover in marketing.";
  const punch = c.punch || "If you're investing less, you're shrinking. If you're investing it in click farms, you're shrinking faster.";
  return (
    <div style={{
      maxWidth: 760,
      margin: "0 auto",
      padding: "28px 32px",
      borderLeft: "4px solid var(--orange, #e8312a)",
      background: "rgba(232,49,42,0.07)",
      borderRadius: "0 12px 12px 0",
    }}>
      <p style={{
        fontSize: "clamp(1.2rem, 2vw, 1.5rem)",
        fontWeight: 700,
        lineHeight: 1.35,
        margin: "0 0 10px",
        color: "#ffffff",
        letterSpacing: "-0.01em",
      }}>{lead}</p>
      <p style={{
        fontSize: "clamp(0.95rem, 1.2vw, 1.05rem)",
        lineHeight: 1.5,
        margin: 0,
        color: "#d4d4d8",
        maxWidth: 600,
      }}>{punch}</p>
    </div>
  );
}

function AnalyticsProof({ content }: { content: any }) {
  const c = content || {};
  const heading = c.heading || "Reporting & Analytics";
  const subheading = c.subheading || "Every campaign, measured. Every dollar, accountable.";
  const intro = c.intro || "Where most publishers hand you a quarterly screenshot and call it reporting, every StereoNET partner gets a live, always-on analytics dashboard. Login any time, see exactly how your campaign is performing across every region, every ad unit, every day.";
  const bullets: Array<{ title: string; body: string }> = Array.isArray(c.bullets) && c.bullets.length ? c.bullets : [
    { title: "Live, always-on dashboard", body: "Not a PDF. Not a quarterly export. A real, live URL you can refresh any time to see today's numbers." },
    { title: "Per-ad-unit performance", body: "Impressions, clicks, CTR and unique reach broken out for every billboard, sidebar, and in-content placement — not lumped into one campaign total." },
    { title: "Geographic breakdown", body: "See where your audience is actually engaging — country, region, and city-level views so you know which markets are responding." },
    { title: "Daily, weekly, monthly", body: "Slice by any timeframe. Compare this month to last. Spot trends before your competitors do." },
    { title: "Independent of GA4", body: "Our analytics layer sits between your ads and our audience. Every impression we serve is one we can prove was served — no relying on third-party tracking that's increasingly blocked by browsers." },
    { title: "Bot-filtered as standard", body: "Cloudflare bot detection runs first. Numbers you see are humans. No inflated impression counts from crawlers, scanners, or AI training bots." },
  ];
  const example_url: string | undefined = c.example_url;
  const example_thumbnail: string | undefined = c.example_thumbnail;
  const example_caption: string = c.example_caption || "See what a live partner report looks like";
  const footer_note: string | undefined = c.footer_note;
  return (
    <div className="kit-block">
      <h2 className="kit-h2">{heading}</h2>
      {subheading && <p className="kit-sub">{subheading}</p>}
      {intro && String(intro).split(/\n\n+/).map((para, i) => (
        <p key={i} className="kit-body" style={{ maxWidth: 820 }}>{para}</p>
      ))}
      <div style={{
        display: "grid",
        gridTemplateColumns: example_url ? "1.4fr 1fr" : "1fr",
        gap: 32,
        alignItems: "start",
        marginTop: 24,
      }}>
        <div>
          <ul style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}>
            {bullets.map((b, i) => (
              <li key={i} style={{
                paddingLeft: 18,
                borderLeft: "2px solid rgba(232,49,42,0.4)",
              }}>
                <div style={{ fontWeight: 700, color: "#fafafa", marginBottom: 4, fontSize: "1rem" }}>{b.title}</div>
                {b.body && (
                  <div style={{ color: "#cbd5e1", fontSize: "0.95rem", lineHeight: 1.5 }}>{b.body}</div>
                )}
              </li>
            ))}
          </ul>
          {footer_note && <p className="kit-footnote" style={{ marginTop: 18 }}>{footer_note}</p>}
        </div>
        {example_url && (
          <a
            href={example_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              borderRadius: 12,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              textDecoration: "none",
              color: "inherit",
              transition: "transform 0.2s ease, border-color 0.2s ease",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(232,49,42,0.5)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ""; (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.12)"; }}
            title="Open the live example report in a new tab"
          >
            {example_thumbnail ? (
              <img
                src={example_thumbnail}
                alt="Example partner analytics report"
                style={{ display: "block", width: "100%", height: "auto" }}
              />
            ) : (
              <div style={{
                aspectRatio: "16 / 10",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                color: "rgba(255,255,255,0.5)",
                padding: 24,
                textAlign: "center",
              }}>
                Live report preview
              </div>
            )}
            <div style={{
              padding: "12px 16px",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              borderTop: "1px solid rgba(255,255,255,0.08)",
            }}>
              <span>{example_caption}</span>
              <span style={{ color: "#e8312a", fontWeight: 600, whiteSpace: "nowrap" }}>Open ↗</span>
            </div>
          </a>
        )}
      </div>
    </div>
  );
}

function Offer(_props: { content: any }) {
  // Pulled live from PULSE settings (admin-editable). Falls back to defaults if endpoint fails.
  const [items, setItems] = useState<{ title: string; body: string }[]>(PARTNERSHIP_DEFAULTS);
  const [heading, setHeading] = useState<string>("What partnership looks like");
  const [subheading, setSubheading] = useState<string>("Eight ways to put your brand in front of audiophiles who are ready to buy. Mix and match — or speak with us about a custom package.");
  useEffect(() => {
    let alive = true;
    fetch("/api/public/partnership-menu")
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j) return;
        if (j.items?.length) setItems(j.items);
        if (typeof j.heading === "string" && j.heading) setHeading(j.heading);
        if (typeof j.subheading === "string") setSubheading(j.subheading);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Accent-color the last word of the heading (matches the previous "What partnership <accent>looks like</accent>" styling)
  const headingParts = (() => {
    const trimmed = (heading || "").trim();
    const idx = trimmed.lastIndexOf(" ");
    if (idx < 0) return { lead: "", tail: trimmed };
    return { lead: trimmed.slice(0, idx), tail: trimmed.slice(idx + 1) };
  })();
  return (
    <>
      <h2>{headingParts.lead}{headingParts.lead && " "}<span className="accent">{headingParts.tail}</span></h2>
      {subheading && <p className="section-sub orange-sub">{subheading}</p>}
      <div className="partnership-menu">
        {items.map((it, i) => (
          <div key={i} className="partnership-item">
            <div className="partnership-num">{String(i + 1).padStart(2, "0")}</div>
            <div className="partnership-text">
              <strong>{it.title}</strong>
              <p>{it.body}</p>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function BannerExamples({ content, broadstreet }: { content: any; broadstreet: any }) {
  const c = content || {};
  const heading = c.heading || "Banner Examples";
  const intro = c.intro || "Live examples of the display formats included in every campaign. Each banner runs in rotation across StereoNET's network of editorial, forum, and news pages. To preview the full-width Masthead ad, scroll back to the top of this page.";

  const BannerCard = ({ label, size, zone, w, h }: { label: string; size: string; zone?: string; w: number; h: number }) => (
    <div className="banner-example">
      <div className="banner-example-head">
        <div className="banner-example-title">{label}</div>
        <div className="banner-example-size">{size}</div>
      </div>
      <div className="banner-example-frame" style={{ width: w + "px", height: h + "px" }}>
        {zone
          ? <BroadstreetAd zoneId={zone} />
          : <div className="banner-example-placeholder">Placeholder — live ad enabled per kit</div>}
      </div>
    </div>
  );

  return (
    <>
      <h2>{heading}</h2>
      {intro && <p className="banner-examples-intro">{renderInline(intro)}</p>}
      <div className="banner-examples">
        <BannerCard label="Billboard" size="970 × 250 px" zone={broadstreet?.billboard_zone} w={970} h={250} />
        <div className="banner-examples-row">
          <BannerCard label="HPU"  size="300 × 600 px" zone={broadstreet?.hpu_zone}  w={300} h={600} />
          <BannerCard label="MREC" size="300 × 250 px" zone={broadstreet?.mrec_zone} w={300} h={250} />
        </div>
      </div>
    </>
  );
}

function fmtMoney(n: number | null | undefined, currency: string): string {
  if (n == null) return "POA";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(n);
  } catch { return `${currency} ${n}`; }
}

// ---- Currency context for retailer kits ----------------------------------
// Lets the public retailer kit toggle USD <-> AUD/GBP/EUR/NZD across every
// price renderer. FX rates are stored as multipliers from USD (USD -> X).
// The convert() function below handles both: (a) prices already stored in USD
// (most retailer addons, all bolt-ons regional rows), and (b) prices stored
// in their native regional currency (e.g. ANZ bolt-ons in AUD). We normalise
// to USD first via the inverse rate, then multiply out into the display
// currency.
type FxRates = Record<string, number>; // USD -> X
type CurrencyCtx = {
  display: string;            // e.g. "USD"
  taxSuffix: string;          // e.g. "ex GST" for AUD, else "no tax"
  rates: FxRates;             // USD -> X for each supported code
  convert: (amount: number | null | undefined, fromCurrency: string) => { amount: number | null; currency: string };
  fmt: (amount: number | null | undefined, fromCurrency: string) => string;
  setDisplay?: (code: string) => void;
  locked: boolean;            // proposal-frozen?
};
const CurrencyContext = createContext<CurrencyCtx>({
  display: "USD",
  taxSuffix: "no tax",
  rates: { USD: 1 },
  convert: (a, c) => ({ amount: a == null ? null : Number(a), currency: c }),
  fmt: (a, c) => (a == null ? "POA" : fmtMoney(Number(a), c)),
  locked: false,
});
function useCurrency() { return useContext(CurrencyContext); }

// Build the price-suffix string for a tier or bolt-on based on its
// billing_period and the active display currency. Examples:
//   billing_period='monthly', USD -> '/month · no tax'
//   billing_period='annual',  AUD -> '/year · ex GST'
//   billing_period='one_off', USD -> 'one-off · no tax'
function useBillingSuffix(a: { price_suffix?: string | null; billing_period?: string | null }) {
  const cur = useCurrency();
  const period = (a.billing_period || "monthly").toLowerCase();
  const periodLabel = period === "annual" ? "/ year" : period === "one_off" ? "one-off" : "/ month";
  const tax = cur.display === "AUD" ? "ex GST" : "no tax";
  // Existing rows may have a price_suffix that already contains tax wording
  // ("no tax", "ex GST"). We always build the canonical form ourselves so the
  // tax label flips correctly with the currency selector.
  return `${periodLabel} · ${tax}`;
}

const SUPPORTED_CURRENCIES = ["USD", "AUD", "GBP", "EUR", "NZD"] as const;
const CURRENCY_LABELS: Record<string, string> = {
  USD: "USD",
  AUD: "AUD",
  GBP: "GBP",
  EUR: "EUR",
  NZD: "NZD",
};
const FALLBACK_FX: FxRates = { USD: 1, AUD: 1.52, GBP: 0.79, EUR: 0.92, NZD: 1.66 };

function CurrencyProvider({ kit, isRetailerKit, children }: { kit: Kit; isRetailerKit: boolean; children: React.ReactNode }) {
  const locked = !!(kit as any).locked_currency;
  const initial = (kit as any).locked_currency || kit.base_currency || "USD";
  const [display, setDisplay] = useState<string>(String(initial).toUpperCase());
  const [rates, setRates] = useState<FxRates>(FALLBACK_FX);

  useEffect(() => {
    // Only fetch FX rates if the kit may show prices in something other than
    // its base currency — i.e. it's a retailer kit with no locked override.
    if (!isRetailerKit || locked) return;
    fetch("/api/fx-rates", { credentials: "omit" })
      .then(r => r.ok ? r.json() : null)
      .then((j: any) => { if (j?.rates) setRates({ ...FALLBACK_FX, ...j.rates }); })
      .catch(() => { /* keep fallback */ });
  }, [isRetailerKit, locked]);

  const convert = (amount: number | null | undefined, fromCurrency: string) => {
    if (amount == null) return { amount: null, currency: display };
    const from = String(fromCurrency || "USD").toUpperCase();
    const to = display.toUpperCase();
    if (from === to) return { amount: Number(amount), currency: to };
    const fromRate = rates[from] || 1; // USD -> from
    const toRate = rates[to] || 1;     // USD -> to
    if (!fromRate || !toRate) return { amount: Number(amount), currency: to };
    // Normalise to USD then to display
    const usd = Number(amount) / fromRate;
    return { amount: usd * toRate, currency: to };
  };

  const fmt = (amount: number | null | undefined, fromCurrency: string) => {
    const c = convert(amount, fromCurrency);
    if (c.amount == null) return "POA";
    return fmtMoney(c.amount, c.currency);
  };

  const taxSuffix = display === "AUD" ? "ex GST" : "no tax";

  const ctx: CurrencyCtx = { display, taxSuffix, rates, convert, fmt, setDisplay, locked };
  return <CurrencyContext.Provider value={ctx}>{children}</CurrencyContext.Provider>;
}

function CurrencySelectorBar() {
  const { display, setDisplay, locked } = useCurrency();
  if (locked) return null; // proposal already pinned a currency
  return (
    <div className="currency-selector-bar no-print" role="region" aria-label="Currency selector">
      <div className="currency-selector-bar__inner">
        <span className="currency-selector-bar__label">View prices in</span>
        <div className="currency-selector-bar__pills">
          {SUPPORTED_CURRENCIES.map(code => (
            <button
              key={code}
              type="button"
              onClick={() => setDisplay?.(code)}
              className={`currency-pill ${display === code ? "is-active" : ""}`}
              aria-pressed={display === code}
            >
              {CURRENCY_LABELS[code]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Reads from the existing 'billing' field (set in the kit editor). When set
// to 'annual', shows the Partner-style "/ month · billed annually as $X/yr".
function tierIsAnnual(tier: Addon): boolean {
  return String((tier as any).billing || "").toLowerCase() === "annual";
}

function SelectedTierSuffix({ tier }: { tier: Addon }) {
  const cur = useCurrency();
  const tax = cur.display === "AUD" ? "ex GST" : "no tax";
  if (tierIsAnnual(tier) && tier.price_value != null) {
    const annual = cur.fmt(Number(tier.price_value) * 12, tier.price_currency);
    return (
      <>
        <span className="your-package-period"> / month · billed annually ({annual}/yr) · {tax}</span>
        <span className="tier-period-badge tier-period-badge--annual">Annual</span>
      </>
    );
  }
  return <span className="your-package-period"> / month · {tax}</span>;
}

// Billing-period badge that sits ABOVE the tier price. Shows "Annual" for
// annual tiers and "Month" otherwise so all columns share the same vertical
// rhythm.
function TierAnnualBadgeAbove({ tier }: { tier: Addon }) {
  const isAnnual = tierIsAnnual(tier);
  return (
    <div className="invest-annual-tag">
      <span className={`tier-period-badge ${isAnnual ? "tier-period-badge--annual" : "tier-period-badge--month"}`}>{isAnnual ? "Annual" : "Month"}</span>
    </div>
  );
}

function TierPeriodLine({ tier }: { tier: Addon }) {
  const cur = useCurrency();
  if (tierIsAnnual(tier) && tier.price_value != null) {
    const annual = cur.fmt(Number(tier.price_value) * 12, tier.price_currency);
    return (
      <div className="invest-price-period">
        <div>/ month</div>
        <div>billed annually ({annual}/yr)</div>
      </div>
    );
  }
  return <div className="invest-price-period"><span>/ month</span></div>;
}

function Investment({ content, tiers, kit, scope, hasProposal, share, slug, token }: { content: any; tiers: Addon[]; kit: Kit; scope?: ProposalScope | null; hasProposal?: boolean; share?: any; slug?: string; token?: string }) {
  const cur = useCurrency();
  // Apply any per-kit frozen tier price snapshot. Used to lock the Standard
  // Rates table on already-sent proposals so catalog changes don't appear to
  // retroactively alter the prices shown to that prospect.
  const frozen: Record<string, number> | undefined = content?.frozen_tier_prices;
  if (frozen && Object.keys(frozen).length > 0) {
    tiers = tiers.map(t => {
      const v = frozen[(t as any).addon_key];
      if (typeof v === "number" && Number.isFinite(v)) {
        return { ...t, price_value: v };
      }
      return t;
    });
  }
  const selectedTier = scope?.tier || null;
  const [showAllTiers, setShowAllTiers] = useState(false);
  // Build an inclusion matrix. The row set is audience-specific: trade kits
  // use the existing matrix (Banners, Ad Weighting, Review Slots etc.) and
  // retailer kits use a retailer-specific matrix (Store listing, Forum access,
  // Sponsor forum, Competitions, Event coverage, Display banners, Classifieds,
  // Additional discount, AI Discoverability, Newsletter & Social).
  const isRetailer = kit.kind === "retailer";
  const tradeRows: { key: string; label: string; render: (t: Addon) => any }[] = [
    { key: "banners", label: "Display Advertising Banner Sets", render: t => fmtCell(t.inclusions?.banners) },
    { key: "ad_weighting", label: "Ad Weighting (Campaign Power)", render: t => fmtCell(t.inclusions?.ad_weighting, "x") },
    { key: "news_pr", label: "Unlimited News & PR with Editorial Priority", render: t => boolCell(t.inclusions?.news_pr) },
    { key: "newsletter_social", label: "Newsletter & Social Media Coverage", render: t => boolCell(t.inclusions?.newsletter_social) },
    { key: "reviews_per_year", label: "Review Slots (per 12 months)", render: t => fmtCell(t.inclusions?.reviews_per_year) },
    { key: "brand_distributor_pages", label: "Brand & Distributor Pages", render: t => boolCell(t.inclusions?.brand_distributor_pages) },
    { key: "exclusive_forum", label: "Exclusive Global Sponsor Forum", render: t => boolCell(t.inclusions?.exclusive_forum) },
    { key: "classifieds_access", label: "Commercial Classifieds Access", render: t => boolCell(t.inclusions?.classifieds_access) },
    { key: "ai_discoverability", label: "AI Discoverability & LLM Surfacing", render: t => boolCell(t.inclusions?.ai_discoverability) },
    { key: "discount_pct", label: "Additional Advertising Discount", render: t => discountCell(t.inclusions?.discount_pct) },
  ];
  const retailerRows: { key: string; label: string; render: (t: Addon) => any }[] = [
    { key: "store_listed", label: "Your store listed in Find a Store page", render: t => boolCell(t.inclusions?.store_listed) },
    { key: "forum_access", label: "Global Commercial Forum Access", render: t => boolCell(t.inclusions?.forum_access) },
    { key: "sponsor_forum", label: "Your very own Retailer Sponsor Forum", render: t => boolCell(t.inclusions?.sponsor_forum) },
    { key: "competitions", label: "Competitions & Giveaways", render: t => boolCell(t.inclusions?.competitions) },
    { key: "event_coverage", label: "Event Coverage & Promotion", render: t => boolCell(t.inclusions?.event_coverage) },
    { key: "display_banners", label: "Display Advertising Banners", render: t => boolCell(t.inclusions?.display_banners) },
    { key: "classifieds_access", label: "Commercial Classifieds Access", render: t => boolCell(t.inclusions?.classifieds_access) },
    // 'discount_pct' removed from retailer matrix — retailer pricing is fixed.
    { key: "ai_discoverability", label: "Appears in AI search & ChatGPT", render: t => boolCell(t.inclusions?.ai_discoverability) },
    { key: "newsletter_social", label: "Mentions in newsletter & social posts", render: t => boolCell(t.inclusions?.newsletter_social) },
  ];
  const defaultRows = isRetailer ? retailerRows : tradeRows;
  const [savedOrder, setSavedOrder] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const audience = isRetailer ? "retailer" : "trade";
    fetch(`/api/public/inclusion-order?audience=${audience}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (alive && Array.isArray(j?.order)) setSavedOrder(j.order); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isRetailer]);
  // Apply saved order (filtered to known keys), then append any default rows not in saved.
  const byKey = new Map(defaultRows.map(r => [r.key, r]));
  const inclusionRows = (() => {
    if (!savedOrder) return defaultRows;
    const seen = new Set<string>();
    const out: typeof defaultRows = [];
    for (const k of savedOrder) { const r = byKey.get(k); if (r && !seen.has(k)) { out.push(r); seen.add(k); } }
    for (const r of defaultRows) { if (!seen.has(r.key)) out.push(r); }
    return out;
  })();
  return (
    <>
      <h2>{hasProposal ? "Standard Rates" : (content.heading || "Your Investment")}</h2>
      {hasProposal && (
        <p className="standard-rates-note">
          These are StereoNET&rsquo;s public list prices, shown here for context. Your personalised offer above takes precedence.
        </p>
      )}
      {selectedTier && (
        <div className="your-package-card">
          <div className="your-package-label">Your recommended package</div>
          <div className="your-package-name">{selectedTier.label}</div>
          {selectedTier.subtitle && <div className="your-package-sub">{selectedTier.subtitle}</div>}
          <ul className="your-package-inclusions">
            {inclusionRows.map(row => {
              const cell = row.render(selectedTier);
              // Skip rows that render as a cross (not included)
              const isCross = (cell as any)?.props?.className === "invest-x";
              if (isCross) return null;
              return <li key={row.key}><span className="your-package-inclusion-check">✓</span> {row.label}{cell && !isCross ? <span className="your-package-inclusion-value"> — {cell}</span> : null}</li>;
            })}
          </ul>
          <div className="your-package-footer">
            <div className="your-package-price">
              {selectedTier.is_poa || selectedTier.price_value == null ? "POA" : cur.fmt(selectedTier.price_value, selectedTier.price_currency)}
              <SelectedTierSuffix tier={selectedTier} />
            </div>
            <button type="button" className="your-package-compare" onClick={() => setShowAllTiers(s => !s)}>
              {showAllTiers ? "Hide comparison table" : "Looking for something different? Compare all tiers ↓"}
            </button>
          </div>
        </div>
      )}
      <div className="invest-table-wrap" style={{ display: (selectedTier && !showAllTiers) ? "none" : "block" }}>
        <table className="invest-table">
          <thead>
            <tr>
              <th className="invest-incl-header">Inclusions</th>
              {tiers.map(t => (
                <th key={t.id}>
                  <div className="tier-head-name">{t.label}</div>
                  {t.subtitle && <div className="tier-head-sub">{t.subtitle}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inclusionRows.map(row => (
              <tr key={row.key}>
                <td className="invest-incl-cell">{row.label}</td>
                {tiers.map(t => <td key={t.id} className="invest-data-cell">{row.render(t)}</td>)}
              </tr>
            ))}
            <tr className="invest-price-row">
              <td className="invest-price-label">
                <div className="invest-price-label-main">Price <span className="price-currency-tag">({cur.display})</span></div>
                <div className="invest-price-label-tax">{cur.display === "AUD" ? "ex GST" : "no tax"}</div>
              </td>
              {tiers.map(t => (
                <td key={t.id} className="invest-price">
                  <TierAnnualBadgeAbove tier={t} />
                  <span className="invest-price-chip">
                    {t.is_poa || t.price_value == null ? "P.O.A." : cur.fmt(t.price_value, t.price_currency)}
                  </span>
                  <TierPeriodLine tier={t} />
                </td>
              ))}
            </tr>
            {isRetailer && (
              <tr className="invest-cta-row no-print">
                <td className="invest-cta-label"></td>
                {tiers.map(t => (
                  <td key={t.id} className="invest-cta-cell">
                    <RetailerTierCTA tier={t} share={share} slug={slug || ""} token={token || ""} />
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Retailer-only tier CTA. Renders "Choose Partner / Choose Silver / Choose Gold"
// under each tier in the matrix. Opens a confirmation modal that captures
// name + email + (optional) company and POSTs to /request-proposal with the
// tier label pre-filled. Disabled on internal-preview shares.
function RetailerTierCTA({ tier, share, slug, token }: { tier: Addon; share?: any; slug: string; token: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(share?.prospect_name || "");
  const [email, setEmail] = useState(share?.prospect_email || "");
  const [company, setCompany] = useState(share?.prospect_company || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const isPreview = (slug || "").startsWith("internal-preview-");
  const alreadyActioned = share?.proposal_state === "accepted" || share?.proposal_state === "declined" || share?.proposal_state === "proposal_requested";

  const buttonLabel = `Choose ${tier.label}`;
  return (
    <>
      <button
        type="button"
        className="retailer-tier-cta"
        onClick={() => setOpen(true)}
        disabled={isPreview || alreadyActioned}
        title={isPreview ? "Action buttons are disabled on internal previews. Send the kit to enable." : (alreadyActioned ? "This kit already has a recorded response." : buttonLabel)}
      >
        {isPreview ? `${buttonLabel} (preview)` : (alreadyActioned ? "Already actioned" : buttonLabel)}
      </button>
      {open && (
        <div className="proposal-modal-backdrop" onClick={() => !busy && setOpen(false)}>
          <div className="proposal-modal request-proposal-modal" onClick={e => e.stopPropagation()}>
            <div className="proposal-modal-head">
              <h3>Confirm your selection</h3>
              <button className="proposal-modal-close" onClick={() => !busy && setOpen(false)} aria-label="Close">×</button>
            </div>
            <p className="proposal-modal-intro">
              You've chosen the <strong>{tier.label}</strong> tier. Confirm your details and our team will be in touch within one business day to finalise paperwork and onboarding.
            </p>
            {doneMsg ? (
              <div className="proposal-status accepted" style={{ margin: "0.5rem 0" }}>
                <div className="proposal-status-title">{doneMsg}</div>
              </div>
            ) : (
              <div className="rp-body">
                <div className="rp-section">
                  <label className="rp-field-label">Your name</label>
                  <input className="rp-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mike Rogers" />
                </div>
                <div className="rp-section">
                  <label className="rp-field-label">Email</label>
                  <input className="rp-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@yourstore.com" />
                </div>
                <div className="rp-section">
                  <label className="rp-field-label">Store / company</label>
                  <input className="rp-input" value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Audio Destination" />
                </div>
                {err && <div className="rp-error">{err}</div>}
                <div className="rp-actions">
                  <button type="button" className="cta-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
                  <button
                    type="button"
                    className="cta-primary"
                    disabled={busy || !name.trim() || !email.trim()}
                    onClick={async () => {
                      setBusy(true); setErr(null);
                      try {
                        const res = await fetch(`/api/media-kit/public/${slug}/request-proposal?t=${encodeURIComponent(token)}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          credentials: "omit",
                          body: JSON.stringify({ name: name.trim(), email: email.trim(), company: company.trim(), tier: tier.label, boltons: [], message: `Selected ${tier.label} tier via retailer kit.` }),
                        });
                        const j = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(j?.message || `Error ${res.status}`);
                        setDoneMsg(`Thanks. Our team will be in touch shortly to confirm your ${tier.label} package.`);
                      } catch (e: any) {
                        setErr(e?.message || "Something went wrong. Please try again or email us directly.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? "Submitting…" : `Confirm ${tier.label}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function fmtCell(v: any, suffix = ""): any {
  if (v === undefined || v === null || v === "" || v === 0 || v === "0") return <span className="invest-x">✕</span>;
  return <span className="invest-v">{String(v)}{suffix}</span>;
}
function boolCell(v: any): any {
  return v ? <span className="invest-check">✓</span> : <span className="invest-x">✕</span>;
}
function discountCell(v: any): any {
  if (!v || v === 0) return <span className="invest-x">✕</span>;
  return <span className="invest-v">{v}%</span>;
}

function Casual({ content }: { content: any }) {
  const price = content.price || "USD $4,999";
  const period = content.price_period || "/ 3 months";
  return (
    <>
      <h2>{content.heading || "Casual / Ad-hoc"}</h2>
      {content.subheading && <p className="section-sub orange-sub">{content.subheading}</p>}
      {price && (
        <div className="casual-price">
          <span className="casual-price-amount">{price}</span>
          {period && <span className="casual-price-period">{period}</span>}
        </div>
      )}
      {content.body && <p>{content.body}</p>}
      <div className="bullet-list">
        {(content.bullets || []).map((b: any, i: number) => (
          <div key={i} className="bullet-row"><strong>{b.title}</strong><p>{renderInline(b.body || "")}</p></div>
        ))}
      </div>
      {content.footer && <p className="muted small mt-3">{content.footer}</p>}
    </>
  );
}

function Boltons({ content, boltons, scope }: { content: any; boltons: Addon[]; scope?: ProposalScope | null }) {
  const cur = useCurrency();
  const selectedKeys = new Set<string>(scope?.bolton_keys || []);
  const hasSelection = selectedKeys.size > 0;
  const [showAll, setShowAll] = useState(false);
  const included = hasSelection ? boltons.filter(b => selectedKeys.has(b.addon_key)) : boltons;
  const explore = hasSelection ? boltons.filter(b => !selectedKeys.has(b.addon_key)) : [];
  // Detect group membership by label/key prefix, NOT by exact addon_key (kits use varying keys).
  // Each group has: a heading, a matcher to identify members, and a fn to pick the "primary" (base variant).
  type Grp = { groupKey: string; heading: string; match: (a: Addon) => boolean; pickPrimary: (xs: Addon[]) => Addon };
  const groups: Grp[] = [
    {
      groupKey: "masthead",
      heading: "Masthead Advertisement",
      match: a => /masthead/i.test(a.label) || /masthead/i.test(a.addon_key),
      pickPrimary: xs => xs.find(a => !/3.?month|3 ?mo|special/i.test(a.label)) || xs[0],
    },
    {
      groupKey: "diamond",
      heading: "Exclusive Diamond Banner",
      match: a => /diamond/i.test(a.label) || /diamond/i.test(a.addon_key),
      pickPrimary: xs => xs.find(a => !/3.?month|3 ?mo|special/i.test(a.label)) || xs[0],
    },
    {
      groupKey: "social",
      heading: "Social Media Boost",
      match: a => /social.*(boost|media)|media.*boost/i.test(a.label) || /social.*boost/i.test(a.addon_key),
      // Prefer 1-month/30d as primary, else fall back to longest-duration available
      pickPrimary: xs => xs.find(a => /1 ?month|30.?day|monthly/i.test(a.label)) || xs[xs.length - 1],
    },
  ];



  const variantSuffix = (a: Addon) => {
    // Try parenthetical first, then em-dash trailing, else full label.
    let m = a.label.match(/\(([^)]+)\)\s*$/);
    if (m) return m[1];
    m = a.label.match(/[\u2014\u2013\-]\s*(.+?)$/); // em-dash, en-dash, or hyphen
    return m ? m[1].trim() : a.label;
  };

  // Compose the bolt-on list to render in the grouped grid: when there's a selection, only show included.
  const boltonsForGrid = hasSelection ? included : boltons;
  const useGroupedRender = (list: Addon[]) => {
    type Out = { kind: "group"; groupKey: string; heading: string; primary: Addon; variants: Addon[] } | { kind: "single"; addon: Addon };
    const usedIds = new Set<number>();
    const emittedGroups = new Set<string>();
    const output: Out[] = [];
    for (const b of list) {
      if (usedIds.has(b.id)) continue;
      const g = groups.find(x => x.match(b));
      if (g && !emittedGroups.has(g.groupKey)) {
        const members = list.filter(x => g.match(x));
        if (members.length > 1) {
          const primary = g.pickPrimary(members);
          const variants = members.filter(m => m.id !== primary.id);
          output.push({ kind: "group", groupKey: g.groupKey, heading: g.heading, primary, variants });
          members.forEach(m => usedIds.add(m.id));
          emittedGroups.add(g.groupKey);
          continue;
        }
        emittedGroups.add(g.groupKey);
      }
      output.push({ kind: "single", addon: b });
      usedIds.add(b.id);
    }
    return output;
  };
  const includedOutput = useGroupedRender(boltonsForGrid);
  const exploreOutput = useGroupedRender(explore);

  return (
    <>
      <h2>{hasSelection ? "Included in your proposal" : (content.heading || "Bolt-on Promos")}</h2>
      {!hasSelection && content.subheading && <p className="section-sub orange-sub">{content.subheading}</p>}
      <div className="bolton-grid">{includedOutput.map(item => renderBoltonItem(item, variantSuffix, cur.fmt))}</div>
      {hasSelection && explore.length > 0 && (
        <div className="bolton-explore-wrap">
          <button type="button" className="bolton-explore-toggle" onClick={() => setShowAll(s => !s)}>
            {showAll ? "Hide additional options" : `Explore more bolt-ons (${explore.length}) ↓`}
          </button>
          {showAll && (
            <div className="bolton-grid bolton-grid-explore">{exploreOutput.map(item => renderBoltonItem(item, variantSuffix, cur.fmt))}</div>
          )}
        </div>
      )}
    </>
  );
}

type BoltonOutItem = { kind: "group"; groupKey: string; heading: string; primary: Addon; variants: Addon[] } | { kind: "single"; addon: Addon };
function renderBoltonItem(item: BoltonOutItem, variantSuffix: (a: Addon) => string, fmt: (n: number | null | undefined, c: string) => string = fmtMoney) {
  if (item.kind === "group") {
    const { groupKey, heading, primary, variants } = item;
    const exampleUrl = [primary, ...variants].map(a => a.example_url).find(Boolean) as string | undefined;
    const isMasthead = groupKey === "masthead";
    // Sort all variants (primary + alternates) by price ascending so the
    // cheapest option is shown first. POA entries fall to the bottom. The
    // SPECIAL pill still attaches to any variant whose label suggests a
    // discounted multi-month rate, so it follows whichever row it belongs to.
    const allVariants = [primary, ...variants];
    const sortedVariants = [...allVariants].sort((a, b) => {
      const ap = a.is_poa || a.price_value == null ? Infinity : Number(a.price_value);
      const bp = b.is_poa || b.price_value == null ? Infinity : Number(b.price_value);
      return ap - bp;
    });
    const isSpecial = (v: Addon) => /(3.?month|3 months|special)/i.test(v.label);
    return (
      <div key={`g-${groupKey}`} className={`bolton-card avail-${primary.availability}`}>
        <div className="bolton-name">{heading}</div>
        {primary.description && <p className="bolton-desc">{primary.description}</p>}
        {isMasthead && (
          <div className="bolton-tip"><span className="bolton-tip-arrow">↑</span> Click “Preview the StereoNET masthead ad” at the top of this page to see it live.</div>
        )}
        <div className="bolton-spacer" />
        <div className="bolton-variants">
          {sortedVariants.map(v => (
            <div key={v.id} className="bolton-variant">
              <span className="bolton-variant-label">
                {variantSuffix(v)}
                {isSpecial(v) && <span className="bolton-variant-badge">SPECIAL</span>}
              </span>
              <span className="bolton-variant-price">
                {v.is_poa || v.price_value == null ? "POA" : fmt(v.price_value, v.price_currency)}
                {v.price_suffix && <span className="bolton-suffix"> {v.price_suffix}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="bolton-foot bolton-foot-grouped">
          {exampleUrl && (
            <a href={exampleUrl} target="_blank" rel="noopener noreferrer" className="bolton-example">View example ↗</a>
          )}
          <span className={`bolton-avail avail-tag-${primary.availability}`}>
            {primary.availability === "available" ? "Available" : primary.availability === "sold_out" ? "Sold out" : primary.availability === "coming_soon" ? "Coming soon" : "Not available"}
          </span>
        </div>
      </div>
    );
  }
  const b = item.addon;
  return (
    <div key={b.id} className={`bolton-card avail-${b.availability}`}>
      <div className="bolton-name">{b.label}</div>
      {b.description && <p className="bolton-desc">{b.description}</p>}
      <div className="bolton-spacer" />
      <div className="bolton-foot">
        <div className="bolton-price">
          {b.is_poa || b.price_value == null ? "POA" : fmt(b.price_value, b.price_currency)}
          {b.price_suffix && <span className="bolton-suffix"> {b.price_suffix}</span>}
        </div>
        <div className="bolton-foot-actions">
          {b.example_url && (
            <a href={b.example_url} target="_blank" rel="noopener noreferrer" className="bolton-example">View example ↗</a>
          )}
          <span className={`bolton-avail avail-tag-${b.availability}`}>
            {b.availability === "available" ? "Available" : b.availability === "sold_out" ? "Sold out" : b.availability === "coming_soon" ? "Coming soon" : "Not available"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Ready({ content, share, hasProposal }: { content: any; share: any; hasProposal?: boolean }) {
  return (
    <>
      <h2>{content.heading || "Are You Ready?"}</h2>
      {content.subheading && <p className="section-sub orange-sub">{content.subheading}</p>}
      {content.epigraph && <p><strong>{content.epigraph}</strong></p>}
      {renderParagraphs(content.paragraphs || [])}
      {/* Hide the bottom CTA on personalised kits — the Proposal block at the top already provides Accept/Request changes/Talk to us */}
      {content.cta_enabled !== false && !hasProposal && (
        <div className="ready-cta">
          <a href="mailto:marcrushton@stereonet.com?subject=Media%20Kit%20Inquiry" className="cta-btn primary">{content.cta_label || "Get in touch"}</a>
        </div>
      )}
    </>
  );
}

function Terms({ content }: { content: any }) {
  return (
    <>
      <h2>{content.heading || "Terms & Conditions"}</h2>
      <ul className="terms-list">
        {(content.bullets || []).map((b: string, i: number) => <li key={i}>{renderInline(b)}</li>)}
      </ul>
    </>
  );
}

function Footer({ content, kit, share }: { content: any; kit: Kit; share: any }) {
  return (
    <footer className="footer">
      <div className="section-inner footer-inner">
        <div className="footer-col">
          <div className="footer-label">Publisher · {content.publisher || (kit.region || "Global")}</div>
          <div className="footer-name">{content.publisher_name}</div>
          <div className="footer-email">{content.publisher_email}</div>
        </div>
        <div className="footer-col">
          <div className="footer-label">Ad Copy & Creative</div>
          <div className="footer-email">{content.ad_copy_email}</div>
        </div>
        <div className="footer-col">
          <div className="footer-label">{content.company}</div>
          <div className="footer-name">{content.managing_director}</div>
          <div className="footer-email">{content.md_email}</div>
        </div>
      </div>
      <div className="footer-copy">
        Copyright {new Date().getFullYear()} Sound Media International Pty Ltd.
        {share?.expires_at && <span> · This kit link expires {new Date(share.expires_at).toLocaleDateString()}.</span>}
      </div>
    </footer>
  );
}

const globalCss = `
.kit-public-body { margin: 0; }

/* Currency selector bar — retailer kit only. Pinned just above the hero,
   prominent enough that a viewer notices the option but small enough not
   to compete with the hero headline. */
.currency-selector-bar {
  background: linear-gradient(180deg, #15151a 0%, #0e0e12 100%);
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1.25rem;
  position: sticky;
  top: 0;
  z-index: 25;
  backdrop-filter: blur(8px);
}
.currency-selector-bar__inner {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 0.9rem;
  flex-wrap: wrap;
}
.currency-selector-bar__label {
  font-size: 0.78rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #b8b8c0;
  font-weight: 600;
}
.currency-selector-bar__pills { display: inline-flex; gap: 0.35rem; flex-wrap: wrap; }
.currency-pill {
  appearance: none;
  border: 1px solid var(--border);
  background: #1a1a1f;
  color: #cfcfd4;
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 56px;
}
.currency-pill:hover { border-color: #555; color: #fff; }
.currency-pill.is-active {
  background: var(--orange);
  border-color: var(--orange);
  color: #fff;
  box-shadow: 0 0 0 3px rgba(232, 49, 42, 0.18);
}
/* Tier billing-period badge */
.tier-period-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1px solid;
  vertical-align: middle;
}
.tier-period-badge--annual {
  background: rgba(232, 49, 42, 0.12);
  border-color: rgba(232, 49, 42, 0.4);
  color: var(--orange);
}
.tier-period-badge--month {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.18);
  color: var(--muted);
}
.invest-price-label-main { display: block; }
.invest-price-label-tax {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: none;
}
.invest-price-period {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.72rem;
  color: var(--muted);
  letter-spacing: 0.04em;
}
.invest-price-period .tier-period-badge { margin-left: 0.35rem; }
.invest-annual-tag { margin-bottom: 0.4rem; display: block; }
.invest-annual-tag .tier-period-badge { margin: 0; }
.currency-selector-bar__suffix {
  margin-left: auto;
  font-size: 0.74rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 500;
}
@media (max-width: 640px) {
  .currency-selector-bar__suffix { margin-left: 0; width: 100%; }
}

.kit-root {
  --orange: #e8312a;
  --bg: #0a0a0c;
  --card: #131316;
  --card2: #1a1a1d;
  --border: #2a2a2f;
  --text: #f3f3f4;
  --muted: #888;
  background: var(--bg); color: var(--text); min-height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.hero { padding: 5rem 1.5rem 4rem; border-bottom: 1px solid var(--border); }
.hero-inner { max-width: 980px; margin: 0 auto; }
.brand-row { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 2.5rem; }
.brand { display: flex; align-items: center; gap: 0.75rem; }
/* Trimmed viewBox (3.39:1 aspect) so height alone is enough — the browser
   computes width automatically from the SVG's aspect ratio. */
.brand-logo { height: 72px; width: auto; max-width: 70vw; display: block; }
@media (max-width: 600px) { .brand-logo { height: 56px; } }
.brand-pitch {
  font-size: 0.75rem; font-weight: 800; letter-spacing: 0.18em;
  padding: 5px 11px; border-radius: 5px; background: var(--orange); color: white;
  line-height: 1; display: inline-flex; align-items: center;
}
.hero-title { font-size: clamp(2rem, 5vw, 3rem); font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; margin: 0 0 1rem; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; color: #cbd5e1; font-size: 0.9rem; }
.region-chip { display: inline-block; padding: 4px 10px; border-radius: 4px; background: var(--orange); color: white; font-weight: 800; font-size: 0.75rem; letter-spacing: 0.08em; }
.hero-personal { margin-top: 1.25rem; color: var(--muted); font-size: 0.95rem; font-style: italic; }
.hero-pitch { margin-top: 2rem; max-width: 820px; }
.hero-headline {
  font-size: clamp(2.25rem, 5.5vw, 3.5rem);
  font-weight: 800;
  letter-spacing: -0.025em;
  line-height: 1.05;
  margin: 0 0 1rem;
  color: #ffffff;
  text-wrap: balance;
}
.hero-supporting {
  font-size: clamp(1rem, 1.4vw, 1.2rem);
  color: #d4d4d8;
  margin: 0;
  max-width: 700px;
  line-height: 1.5;
}
.hero-proof {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2.5rem;
  margin-top: 2.5rem;
  padding-top: 2rem;
  border-top: 1px solid rgba(255,255,255,0.12);
  max-width: 720px;
  justify-items: start;
}
.hero-proof-tile { display: flex; flex-direction: column; gap: 0.35rem; }
.hero-proof-num {
  font-size: clamp(1.65rem, 3vw, 2.25rem);
  font-weight: 800;
  color: var(--orange);
  letter-spacing: -0.02em;
  line-height: 1;
}
.hero-proof-lbl {
  font-size: 0.85rem;
  color: #a1a1aa;
  font-weight: 500;
  line-height: 1.35;
  text-wrap: balance;
}
@media (max-width: 640px) {
  .hero-proof { grid-template-columns: 1fr; gap: 1.1rem; }
}

.section { padding: 4rem 1.5rem; }
.section.section-alt { background: var(--card); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.section-inner { max-width: 980px; margin: 0 auto; }
.section h2 { font-size: 1.875rem; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 1rem; }
.section h3 { font-size: 1rem; font-weight: 700; color: var(--text); margin: 0 0 1rem; text-transform: uppercase; letter-spacing: 0.08em; }
.section p { font-size: 1rem; color: #cfcfd2; margin: 0 0 1rem; line-height: 1.6; }
.section .section-sub { color: var(--muted); font-size: 1rem; margin-top: -0.5rem; }
.section .section-sub.orange-sub { color: var(--orange); font-weight: 600; }
.mt-3 { margin-top: 1rem; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }

blockquote { border-left: 3px solid var(--orange); margin: 0 0 1.5rem; padding: 0.5rem 0 0.5rem 1rem; color: var(--muted); font-style: italic; }
blockquote cite { display: block; margin-top: 0.25rem; font-size: 0.85rem; }

.audience-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 2rem 0 1rem; }
@media (max-width: 720px) { .audience-grid { grid-template-columns: repeat(2, 1fr); } }
.audience-card { background: var(--card2); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; }
.audience-pct { font-size: 2rem; font-weight: 800; color: var(--orange); letter-spacing: -0.02em; }
.audience-label { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.25rem; }
.audience-bar { margin-top: 0.75rem; width: 100%; height: 6px; background: rgba(255,255,255,0.06); border-radius: 999px; overflow: hidden; }
.audience-bar-fill { height: 100%; background: linear-gradient(90deg, var(--orange), #ff6b5e); border-radius: 999px; }

/* Audience snapshot 9-tile grid */
.ag-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 1.75rem 0 1rem; }
@media (max-width: 900px) { .ag-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px) { .ag-grid { grid-template-columns: 1fr; } }
.ag-tile { background: var(--card2); border: 1px solid var(--border); border-radius: 10px; padding: 1.15rem 1.15rem 1rem; display: flex; flex-direction: column; min-height: 130px; }
.ag-value { font-size: 2.1rem; font-weight: 800; color: var(--orange); letter-spacing: -0.02em; line-height: 1; }
.ag-label { font-size: 0.85rem; color: #e5e5e7; margin-top: 0.55rem; line-height: 1.3; flex: 1; }
.ag-note { font-size: 0.7rem; color: var(--muted); margin-top: 0.55rem; line-height: 1.35; text-transform: uppercase; letter-spacing: 0.04em; }
.ag-source { font-style: italic; opacity: 0.75; }

/* Research-sources horizontal bar chart */
.rs-highlight { background: linear-gradient(90deg, rgba(232,49,42,0.18), rgba(232,49,42,0.06)); border: 1px solid rgba(232,49,42,0.35); border-radius: 10px; padding: 1rem 1.25rem; display: flex; align-items: center; gap: 1rem; margin: 1.5rem 0 1.75rem; }
.rs-highlight-pct { font-size: 2.4rem; font-weight: 800; color: var(--orange); letter-spacing: -0.02em; line-height: 1; }
.rs-highlight-label { font-size: 0.95rem; color: #e5e5e7; font-weight: 600; }
.rs-bars { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.5rem; }
.rs-row { display: grid; grid-template-columns: 220px 1fr 50px; gap: 0.75rem; align-items: center; }
@media (max-width: 720px) { .rs-row { grid-template-columns: 1fr; gap: 0.2rem; } .rs-row .rs-pct { text-align: right; } }
.rs-name { font-size: 0.85rem; color: #e5e5e7; }
.rs-row-hl .rs-name { color: var(--orange); font-weight: 600; }
.rs-track { background: rgba(255,255,255,0.06); height: 18px; border-radius: 4px; overflow: hidden; }
.rs-fill { height: 100%; background: linear-gradient(90deg, #888 0%, #aaa 100%); border-radius: 4px; }
.rs-row-hl .rs-fill { background: linear-gradient(90deg, var(--orange), #ff6b5e); }
.rs-pct { font-size: 0.9rem; font-weight: 700; color: #e5e5e7; text-align: right; }
.rs-row-hl .rs-pct { color: var(--orange); }

/* Section connector — visual bridge between two related blocks */
.sc-wrap { display: flex; flex-direction: column; align-items: center; gap: 0; padding: 1rem 0; margin: -1rem 0 -1rem; }
.sc-line { width: 2px; height: 32px; background: linear-gradient(180deg, transparent 0%, var(--orange) 100%); }
.sc-pill { background: var(--orange); color: #fff; font-size: 0.82rem; font-weight: 700; padding: 0.55rem 1.1rem; border-radius: 999px; letter-spacing: 0.01em; box-shadow: 0 4px 14px rgba(232,49,42,0.35); text-align: center; max-width: 90%; }
.sc-arrow { color: var(--orange); font-size: 1.6rem; font-weight: 800; line-height: 1; margin-top: 0.35rem; animation: scbounce 1.8s ease-in-out infinite; }
@keyframes scbounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(4px); } }

/* Broadstreet live ads */
.bs-ad-wrap { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; width: 100%; }
.bs-ad-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.bs-ad-wrap ins { display: block; max-width: 100%; }

/* Partnership menu (replaces What We Offer) — mirrors /advertising */
.partnership-menu { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 2rem; margin: 1.5rem 0; }
@media (max-width: 720px) { .partnership-menu { grid-template-columns: 1fr; } }
.partnership-item { display: flex; gap: 1.1rem; padding: 1rem 0; border-top: 1px solid var(--border); }
.partnership-num { font-size: 1.75rem; font-weight: 800; color: var(--orange); letter-spacing: -0.02em; line-height: 1; min-width: 2.5rem; flex-shrink: 0; }
.partnership-text strong { display: block; font-size: 1rem; font-weight: 700; margin-bottom: 0.25rem; color: var(--text); }
.partnership-text p { font-size: 0.9rem; color: var(--muted); margin: 0; line-height: 1.5; }

/* Inline accents used in headings/copy (mirrors /advertising) */
h2 .accent, .accent-strong { color: var(--orange); }
.accent-strong { font-weight: 700; }

/* Shared Audience Stats block — matches /advertising page styling */
.audstats h2 { margin-bottom: 0.25rem; }
.audstats .section-sub { margin-bottom: 2rem; }
.audstats-row { margin-bottom: 2.25rem; }
.audstats-row:last-of-type { margin-bottom: 0; }
.audstats-row-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); margin: 0 0 1rem; display: flex; align-items: center; gap: 0.75rem; }
.audstats-row-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.audstats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
@media (max-width: 900px) { .audstats-grid { grid-template-columns: repeat(2, 1fr); } }
.audstats-card { padding: 1.1rem 1.2rem; background: var(--card2); border: 1px solid var(--border); border-radius: 10px; transition: border-color 0.15s, transform 0.15s; }
.audstats-card:hover { border-color: var(--orange); transform: translateY(-1px); }
.audstats-num { font-size: clamp(1.4rem, 2.8vw, 2rem); font-weight: 800; color: var(--orange); line-height: 1; letter-spacing: -0.02em; }
.audstats-num sup { font-size: 0.4em; color: var(--orange); font-weight: 700; margin-left: 2px; vertical-align: super; }
.audstats-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text); margin-top: 0.6rem; line-height: 1.35; }
.audstats-sub { font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem; line-height: 1.4; font-weight: 500; }
.audstats-footnote { font-size: 0.7rem; color: var(--muted); margin: 1.75rem 0 0; line-height: 1.55; max-width: 720px; }
.audstats-footnote sup { color: var(--orange); font-weight: 700; }

/* Grouped bolt-on variants (Masthead / Diamond / Social) */
.bolton-variants { display: flex; flex-direction: column; gap: 0.4rem; margin: 0.75rem 0 0.5rem; padding-top: 0.6rem; border-top: 1px dashed var(--border); }
.bolton-variant { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding: 0.2rem 0; font-size: 0.88rem; }
.bolton-variant-label { color: var(--text); font-weight: 600; display: inline-flex; align-items: center; gap: 0.5rem; text-transform: capitalize; }
.bolton-variant-price { color: var(--orange); font-weight: 800; font-size: 0.95rem; letter-spacing: -0.01em; white-space: nowrap; }
.bolton-variant-price .bolton-suffix { color: var(--muted); font-weight: 500; font-size: 0.78rem; margin-left: 2px; }
.bolton-variant-badge { font-size: 0.6rem; font-weight: 800; letter-spacing: 0.08em; padding: 0.12rem 0.4rem; background: var(--orange); color: #fff; border-radius: 3px; }
.bolton-foot-grouped { justify-content: space-between; margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--border); gap: 0.75rem; flex-wrap: wrap; }
.bolton-foot-actions { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }

/* Bolton card polish */
.bolton-card { display: flex; flex-direction: column; transition: border-color 0.15s, transform 0.15s; }
.bolton-card:hover { border-color: var(--orange); transform: translateY(-1px); }
.bolton-name { font-size: 1.05rem; font-weight: 800; letter-spacing: -0.01em; margin-bottom: 0.4rem; }
.bolton-desc { color: var(--muted); font-size: 0.88rem; line-height: 1.5; margin: 0 0 0.5rem; }
.bolton-tip { font-size: 0.72rem; font-weight: 600; color: var(--orange); background: rgba(232,49,42,0.07); border-left: 2px solid var(--orange); border-radius: 4px; padding: 0.4rem 0.6rem; margin: 0; line-height: 1.4; display: flex; align-items: flex-start; gap: 0.4rem; }
.bolton-tip-arrow { font-weight: 800; flex-shrink: 0; }

/* "View example" CTA */
.bolton-example { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em; padding: 0.35rem 0.7rem; border: 1px solid var(--border); border-radius: 999px; color: var(--text); text-decoration: none; background: rgba(255,255,255,0.03); transition: all 0.15s; white-space: nowrap; }
.bolton-example:hover { border-color: var(--orange); color: var(--orange); background: rgba(232,49,42,0.08); }

/* Casual block price */
.casual-price { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.75rem 0 1rem; padding: 0.6rem 1rem; background: rgba(232,49,42,0.08); border: 1px solid rgba(232,49,42,0.2); border-radius: 8px; width: fit-content; }
.casual-price-amount { font-size: 1.6rem; font-weight: 800; color: var(--orange); letter-spacing: -0.01em; }
.casual-price-period { font-size: 0.85rem; color: var(--muted); font-weight: 600; }

/* Banner Examples block (separate section) */
.banner-examples-intro { color: var(--muted); max-width: 720px; margin: 0 0 2rem; }
.standard-rates-note { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; padding: 0.6rem 0.9rem; border-left: 3px solid var(--orange); background: rgba(232,49,42,0.05); border-radius: 0 6px 6px 0; line-height: 1.5; max-width: 760px; }
/* Bullet list in editor-driven paragraph blocks (Who We Are, Are You Ready?, etc).
   Lines starting with "- " or "* " become <li> elements inside a .mk-bullets <ul>. */
.mk-bullets { list-style: none; padding: 0; margin: 0.75rem 0 1.25rem; display: flex; flex-direction: column; gap: 0.6rem; }
.mk-bullets li { position: relative; padding-left: 1.5rem; color: var(--text); line-height: 1.55; }
.mk-bullets li::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 8px; height: 8px; border-radius: 2px; background: var(--orange); }
.banner-examples { display: flex; flex-direction: column; gap: 2rem; align-items: flex-start; }
.banner-examples-row { display: flex; flex-direction: row; gap: 2rem; flex-wrap: wrap; align-items: flex-start; }
.banner-example { background: var(--card2); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; display: inline-block; }
.banner-example-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.banner-example-title { font-size: 1.05rem; font-weight: 800; letter-spacing: -0.01em; }
.banner-example-size { font-size: 0.78rem; color: var(--muted); font-weight: 600; letter-spacing: 0.04em; }
.banner-example-frame { background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12); display: flex; justify-content: center; align-items: center; overflow: hidden; box-sizing: content-box; flex: 0 0 auto; }
.banner-example-frame .bs-ad-wrap { width: 100%; height: 100%; align-items: center; justify-content: center; gap: 0; }
.banner-example-frame .bs-ad-wrap ins { display: block; margin: 0; }
.banner-example-frame .bs-ad-wrap ins iframe, .banner-example-frame .bs-ad-wrap ins img { display: block; }
.banner-example-placeholder { color: var(--muted); font-size: 0.85rem; padding: 1.5rem; text-align: center; }
@media (max-width: 1040px) {
  .banner-example { max-width: 100%; }
}

/* Inline live-ad inside Ad Banner Set Specs */
.offer-bullets-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem 2rem; margin: 1.5rem 0 2rem; }
@media (max-width: 720px) { .offer-bullets-grid { grid-template-columns: 1fr; } }
.banner-specs-full { width: 100%; margin-top: 0.5rem; }
.banner-live-label { font-size: 0.78rem; color: var(--orange); font-weight: 600; margin: 0.25rem 0 1rem; }
.banner-grid-stacked { display: flex; flex-direction: column; gap: 1rem; }
.banner-name-row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.25rem; flex-wrap: nowrap; white-space: nowrap; }
.banner-spec-row { display: flex; flex-direction: column; gap: 1rem; }
@media (min-width: 720px) { .banner-spec-row { flex-direction: row; align-items: flex-start; justify-content: flex-start; gap: 1.25rem; } }
.banner-fixed-hpu { width: 332px; flex: 0 0 auto; }
.banner-fixed-mrec { width: 332px; flex: 0 0 auto; }
.banner-live { margin-top: 0.6rem; background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12); border-radius: 6px; padding: 0.5rem; display: flex; justify-content: center; align-items: flex-start; overflow: hidden; }
.banner-live .bs-ad-wrap { width: auto; align-items: center; gap: 0; }
.banner-live .bs-ad-wrap ins { display: block; margin: 0; max-width: 100%; height: auto; }
.banner-live .bs-ad-wrap ins iframe, .banner-live .bs-ad-wrap ins img { display: block; max-width: 100%; height: auto; }

.bs-masthead-wrap { position: relative; width: 100%; }
.bs-masthead { width: 100%; background: #000; display: flex; justify-content: center; align-items: center; line-height: 0; }
.bs-masthead .bs-ad-wrap { gap: 0; }
.bs-masthead .bs-ad-wrap ins { display: block; }
.bs-masthead-close { display: flex; align-items: center; justify-content: center; width: 100%; background: rgba(232,49,42,0.95); border: none; color: #fff; font-size: 0.8rem; font-weight: 700; cursor: pointer; padding: 0.45rem 1rem; line-height: 1; letter-spacing: 0.02em; }
.bs-masthead-close:hover { background: var(--orange); }

.bs-masthead-block { position: relative; z-index: 5; }
.bs-masthead-toggle-row { display: flex; justify-content: center; padding: 0.5rem 1rem; background: var(--bg, #0a0a0b); border-bottom: 1px solid var(--border); position: relative; z-index: 10; }
.bs-masthead-toggle { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 0.4rem 0.9rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 0.45rem; transition: all 0.15s ease; }
.bs-masthead-toggle:hover { color: #fff; border-color: var(--orange); }
.bs-masthead-toggle.on { color: #fff; border-color: var(--orange); background: rgba(232,49,42,0.1); }
.bs-toggle-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--muted); transition: background 0.15s ease; }
.bs-masthead-toggle.on .bs-toggle-dot { background: var(--orange); box-shadow: 0 0 0 3px rgba(232,49,42,0.25); }

/* Featured Article / Manifesto block */
.fa-card { background: linear-gradient(135deg, rgba(232,49,42,0.08) 0%, rgba(232,49,42,0.02) 100%); border: 1px solid rgba(232,49,42,0.3); border-radius: 14px; padding: 2rem 2.25rem; margin-top: 0.5rem; }
@media (max-width: 600px) { .fa-card { padding: 1.5rem 1.25rem; } }
.fa-eyebrow { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: var(--orange); margin-bottom: 0.5rem; }
.fa-headline { font-size: 1.5rem; font-weight: 800; color: #fff; margin: 0 0 1rem; line-height: 1.25; letter-spacing: -0.01em; }
@media (max-width: 600px) { .fa-headline { font-size: 1.2rem; } }
.fa-quote { border-left: 3px solid var(--orange); margin: 1rem 0; padding: 0.5rem 0 0.5rem 1.25rem; font-size: 1.05rem; font-style: italic; color: #e5e5e7; line-height: 1.45; position: relative; }
.fa-quote-mark { color: var(--orange); font-size: 1.4rem; font-weight: 700; font-style: normal; margin: 0 0.15rem; }
.fa-intro { color: #cfcfd2; font-size: 0.95rem; line-height: 1.55; margin: 1rem 0; }
.fa-meta { font-size: 0.8rem; color: var(--muted); margin: 0.5rem 0 1rem; }
.fa-meta-divider { margin-left: 0.4rem; }
.fa-cta { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.1rem; background: var(--orange); color: #fff; font-weight: 700; font-size: 0.85rem; text-decoration: none; border-radius: 6px; letter-spacing: 0.02em; transition: background 0.15s ease; }
.fa-cta:hover { background: #ff4f48; }

.offer-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 2rem; margin-top: 1.5rem; }
@media (max-width: 720px) { .offer-grid { grid-template-columns: 1fr; } }
.offer-row { margin-bottom: 1.25rem; }
.offer-row strong { display: block; font-weight: 700; margin-bottom: 0.15rem; }
.offer-row p { margin: 0; font-size: 0.95rem; color: #cfcfd2; }

.banner-specs { background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; }
.banner-grid { display: grid; gap: 0.75rem; margin-bottom: 1rem; }
.banner-spec { border: 2px solid var(--orange); border-radius: 8px; padding: 0.85rem; background: var(--card); text-align: center; }
.banner-name { font-weight: 800; font-size: 0.9rem; letter-spacing: 0.05em; text-transform: uppercase; }
.banner-size { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }
.banner-billboard { aspect-ratio: 970 / 110; }
.banner-hpu { aspect-ratio: 300 / 200; max-width: 180px; margin: 0 auto; }
.banner-mrec { aspect-ratio: 300 / 200; max-width: 140px; margin: 0 auto; }
.banner-note { font-size: 0.78rem; color: var(--muted); margin: 0.5rem 0 0; line-height: 1.45; }

.invest-table-wrap { overflow-x: auto; margin-top: 1.5rem; border-radius: 14px; border: 1px solid var(--border); background: var(--card); box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset; }
.invest-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.9rem; table-layout: fixed; }
.invest-table th { word-wrap: break-word; }
.invest-table .invest-incl-header { width: 38%; }
/* All tier columns share equal width within the remaining 62% */
.invest-table thead th:not(.invest-incl-header) { width: auto; }
.invest-price-period { font-size: 0.7rem; line-height: 1.3; word-wrap: break-word; white-space: normal; }
.invest-table th { padding: 1.1rem 1rem; text-align: center; font-weight: 800; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.1em; background: linear-gradient(180deg, rgba(232,49,42,0.07), rgba(255,255,255,0.02)); border-bottom: 1px solid var(--border); color: var(--orange); }
.invest-table th.invest-incl-header { text-align: left; padding-left: 1.25rem; background: rgba(255,255,255,0.03); color: var(--muted); }
.invest-table td { padding: 0.85rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.1s; }
.invest-table tbody tr:last-of-type td { border-bottom: none; }
.invest-table tbody tr:hover td { background: rgba(232,49,42,0.04); }
.tier-head-name { font-size: 0.95rem; font-weight: 800; color: var(--text); letter-spacing: 0.04em; }
.tier-head-sub { font-size: 0.7rem; color: var(--muted); margin-top: 0.35rem; font-weight: 400; text-transform: none; letter-spacing: 0; max-width: 220px; margin-inline: auto; line-height: 1.35; }
.invest-incl-cell { font-weight: 600; color: var(--text); font-size: 0.88rem; padding-left: 1.25rem !important; }
.invest-data-cell { text-align: center; color: var(--orange); font-weight: 800; font-size: 1rem; letter-spacing: -0.01em; }
.invest-table .invest-x { color: rgba(255,255,255,0.18); font-weight: 400; font-size: 1.1rem; }
.invest-table .invest-check { color: var(--orange); font-size: 1.15rem; font-weight: 700; }
.invest-check { color: var(--orange); font-size: 1.1rem; }
.invest-x { color: #555; }
.invest-v { color: var(--orange); }
.invest-price-row td { background: rgba(232,49,42,0.08) !important; border-top: 2px solid var(--orange) !important; padding: 1.25rem 1rem !important; vertical-align: top !important; }
.invest-cta-row td { background: rgba(232,49,42,0.04) !important; border-top: 0 !important; padding: 0.25rem 1rem 1.25rem !important; text-align: center; }
.invest-cta-row .invest-cta-label { background: transparent !important; }
.retailer-tier-cta {
  display: inline-block;
  padding: 0.55rem 1rem;
  border-radius: 999px;
  background: var(--orange);
  color: #fff;
  border: 0;
  font-weight: 700;
  font-size: 0.78rem;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(232,49,42,0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.retailer-tier-cta:hover:not(:disabled) { background: #d62b24; transform: translateY(-1px); box-shadow: 0 5px 14px rgba(232,49,42,0.4); }
.retailer-tier-cta:disabled { opacity: 0.55; cursor: not-allowed; background: #555; box-shadow: none; }
.rp-field-label { display: block; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 0.35rem; font-weight: 700; }
.rp-input { width: 100%; padding: 0.6rem 0.85rem; background: #18181b; border: 1px solid #2a2a2e; border-radius: 6px; color: #f3f3f4; font-size: 0.9rem; }
.rp-input:focus { outline: none; border-color: var(--orange); }
.rp-error { color: #ff8a85; font-size: 0.85rem; padding: 0.4rem 0; }
.rp-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.5rem; }

/* Find a Store / Driving Consumers to Retailers block (retailer kit) */
.fas-block { max-width: 1100px; margin: 0 auto; }
.fas-head { text-align: center; max-width: 780px; margin: 0 auto 2.5rem; }
.fas-intro { color: var(--muted); font-size: 1rem; line-height: 1.6; margin-top: 1rem; }
.fas-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
@media (max-width: 820px) { .fas-steps { grid-template-columns: 1fr; } }
.fas-step {
  background: rgba(232, 49, 42, 0.04);
  border: 1px solid rgba(232, 49, 42, 0.18);
  border-radius: 12px;
  padding: 1.5rem 1.4rem 1.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  position: relative;
  transition: transform 0.2s ease, border-color 0.2s ease;
}
.fas-step:hover { transform: translateY(-3px); border-color: rgba(232, 49, 42, 0.45); }
.fas-step-num {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: var(--orange);
  color: #fff;
  font-weight: 800;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(232, 49, 42, 0.35);
}
.fas-step-title { font-weight: 700; font-size: 1.02rem; color: var(--text); line-height: 1.35; }
.fas-step-text { color: var(--muted); font-size: 0.92rem; line-height: 1.6; }
.fas-footer { text-align: center; color: var(--muted); margin-top: 2rem; font-size: 0.92rem; max-width: 780px; margin-left: auto; margin-right: auto; line-height: 1.6; }
.invest-price-row:hover td { background: rgba(232,49,42,0.12) !important; }
.invest-price-label { color: var(--text) !important; font-weight: 800 !important; font-size: 0.85rem !important; text-transform: uppercase; letter-spacing: 0.06em; padding-left: 1.25rem !important; }
.invest-price { text-align: center; }
.invest-price-chip { display: inline-block; padding: 0.4rem 0.85rem; background: var(--orange); color: #fff; border-radius: 6px; font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; box-shadow: 0 2px 8px rgba(232,49,42,0.25); }
.price-currency-tag { font-weight: 500; color: var(--muted); font-size: 0.7rem; text-transform: none; letter-spacing: 0; margin-left: 0.35rem; }

.bullet-list { margin-top: 1rem; }
.bullet-row { margin-bottom: 1.25rem; padding-left: 1rem; border-left: 2px solid var(--orange); }
.bullet-row strong { display: block; font-weight: 700; margin-bottom: 0.15rem; }
.bullet-row p { margin: 0; font-size: 0.95rem; color: #cfcfd2; }

.bolton-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin-top: 1.5rem; align-items: stretch; }
@media (max-width: 900px) { .bolton-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 540px) { .bolton-grid { grid-template-columns: 1fr; } }
.bolton-card { position: relative; background: var(--card2); border: 1px solid var(--border); border-radius: 12px; padding: 1.1rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.6rem; transition: border-color 0.15s ease, transform 0.15s ease; overflow: hidden; }
/* Sold-out / unavailable cards: keep them readable, mute price + ribbon them */
.bolton-card.avail-sold_out, .bolton-card.avail-not_available { opacity: 0.85; }
.bolton-card.avail-sold_out .bolton-name, .bolton-card.avail-not_available .bolton-name { color: var(--muted); }
.bolton-card.avail-sold_out .bolton-price, .bolton-card.avail-sold_out .bolton-variant-price,
.bolton-card.avail-not_available .bolton-price, .bolton-card.avail-not_available .bolton-variant-price { color: var(--muted); text-decoration: line-through; text-decoration-thickness: 1px; }
.bolton-name { font-size: 1.02rem; font-weight: 800; color: var(--text); line-height: 1.25; letter-spacing: -0.005em; }
.bolton-desc { margin: 0; font-size: 0.85rem; color: var(--muted); line-height: 1.5; }
/* Spacer is no longer needed — the foot/variants blocks anchor themselves to
   the bottom of the card via margin-top:auto, so simple cards just gain a
   little bottom whitespace while cards stay row-equalised. */
.bolton-card > .bolton-spacer { display: none; }
/* Variants block (multi-price rows like Social Media Boost) anchors to bottom;
   for grouped cards the foot underneath it sits right below with no extra gap. */
.bolton-card .bolton-variants { margin-top: auto; }
.bolton-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding-top: 0.65rem; border-top: 1px dashed var(--border); }
/* For simple cards (no variants), the foot itself does the anchoring. */
.bolton-card > .bolton-foot:not(.bolton-foot-grouped) { margin-top: auto; }
/* For grouped cards the inner foot sits flush against the variants — don't
   draw the dashed border (variants already separate it) and zero out padding. */
.bolton-foot-grouped { border-top: none; padding-top: 0.5rem; }
.bolton-price { font-size: 1.15rem; font-weight: 800; color: var(--orange); letter-spacing: -0.01em; line-height: 1; }
.bolton-suffix { font-size: 0.7rem; color: var(--muted); font-weight: 400; }
.bolton-avail { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.2rem 0.45rem; border-radius: 4px; }
.avail-tag-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.avail-tag-sold_out { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.avail-tag-coming_soon { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.avail-tag-not_available { background: rgba(120, 120, 120, 0.15); color: #888; }

.ready-cta { margin-top: 2rem; display: flex; gap: 0.75rem; flex-wrap: wrap; }
.cta-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.75rem 1.5rem; border-radius: 8px; font-size: 0.95rem; font-weight: 700; text-decoration: none; transition: all 0.15s ease; }
.cta-btn.primary { background: var(--orange); color: white; }
.cta-btn.primary:hover { background: #d62b24; }

.terms-list { list-style: none; padding: 0; margin: 1rem 0 0; }
.terms-list li { padding: 0.75rem 0 0.75rem 1.25rem; border-bottom: 1px solid var(--border); color: #cfcfd2; font-size: 0.9rem; position: relative; }
.terms-list li::before { content: ""; position: absolute; left: 0; top: 1.2em; width: 6px; height: 6px; background: var(--orange); border-radius: 50%; }
.terms-list li:last-child { border-bottom: none; }

.footer { background: var(--card); padding: 3rem 1.5rem 2rem; border-top: 1px solid var(--border); }
.footer-inner { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2rem; }
@media (max-width: 720px) { .footer-inner { grid-template-columns: 1fr; } }
.footer-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 700; margin-bottom: 0.5rem; }
.footer-name { font-size: 1rem; font-weight: 700; color: var(--text); margin-bottom: 0.15rem; }
.footer-email { font-size: 0.85rem; color: var(--orange); }
.footer-copy { max-width: 980px; margin: 2rem auto 0; padding-top: 2rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; text-align: center; }

.error-state { padding: 4rem 1.5rem; text-align: center; max-width: 540px; margin: 0 auto; }
.error-state h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
.error-state p { color: var(--muted); }

/* Personalised proposal block (only renders on prospect clones) */
.proposal-block { background: linear-gradient(180deg, rgba(232,49,42,0.05), rgba(232,49,42,0)); border: 1px solid rgba(232,49,42,0.35); border-radius: 14px; padding: 2rem 2rem 1.75rem; }
.proposal-head { margin-bottom: 1.25rem; }
.proposal-label { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.18em; color: var(--orange); text-transform: uppercase; margin-bottom: 0.5rem; }
.proposal-prepared { font-size: clamp(1.5rem, 3vw, 2rem); font-weight: 800; margin: 0 0 0.5rem; line-height: 1.15; letter-spacing: -0.02em; }
.proposal-prepared .accent { color: var(--orange); }
.proposal-subtitle { color: #cfcfd2; font-size: 1rem; line-height: 1.55; margin: 0; }
.proposal-subtitle p { margin: 0 0 0.75rem; }
.proposal-subtitle p:last-child { margin-bottom: 0; }
/* Region scope strip — sits in the proposal head and makes Global vs regional
   campaigns visually unmistakable. */
.proposal-regions { margin-top: 1rem; padding: 0.85rem 1rem; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; }
.proposal-regions-global { background: linear-gradient(135deg, rgba(232,49,42,0.12), rgba(232,49,42,0.04)); border-color: rgba(232,49,42,0.35); }
.proposal-regions-label { display: block; font-size: 0.65rem; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 0.55rem; }
.proposal-regions-global .proposal-regions-label { color: var(--orange); }
.proposal-regions-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; }
.proposal-regions-banner { font-size: 0.85rem; font-weight: 800; color: var(--orange); letter-spacing: -0.005em; margin-right: 0.5rem; }
.proposal-region-chip { font-size: 0.78rem; font-weight: 600; padding: 0.25rem 0.6rem; background: rgba(255,255,255,0.06); color: var(--text); border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
.proposal-regions-global .proposal-region-chip { background: rgba(232,49,42,0.08); border-color: rgba(232,49,42,0.25); color: #fff; }
.proposal-client-logo { display: flex; align-items: center; justify-content: flex-start; margin: 0 0 0.5rem; }
.proposal-client-logo img { max-height: 64px; max-width: 220px; width: auto; height: auto; display: block; background: rgba(255,255,255,0.04); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); }
@media (max-width: 600px) { .proposal-client-logo img { max-height: 48px; max-width: 180px; } }
.proposal-summary { display: grid; grid-template-columns: 1fr; gap: 0.85rem; padding: 1.25rem 1.25rem; background: var(--card2); border: 1px solid var(--border); border-radius: 10px; margin-top: 1rem; }
@media (min-width: 720px) { .proposal-summary { grid-template-columns: auto 1fr auto; align-items: center; column-gap: 1.5rem; } }
.proposal-total-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.25rem; }
.proposal-total-value { font-size: 1.85rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); line-height: 1; }
.proposal-total-period { font-size: 0.9rem; color: var(--muted); font-weight: 600; margin-left: 0.25rem; }
.proposal-summary-line { color: #cfcfd2; font-size: 0.95rem; line-height: 1.5; }
.proposal-valid { font-size: 0.8rem; color: var(--muted); white-space: nowrap; }
.proposal-notes { margin-top: 1rem; }
.proposal-notes p { color: var(--muted); font-size: 0.9rem; line-height: 1.55; margin: 0 0 0.5rem; }
.proposal-ctas { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-top: 1.5rem; }
.cta-primary, .cta-secondary, .cta-tertiary { padding: 0.7rem 1.25rem; border-radius: 8px; font-weight: 700; font-size: 0.9rem; cursor: pointer; border: 1px solid transparent; transition: opacity 0.15s, transform 0.05s; }
.cta-primary { background: var(--orange); color: white; }
.cta-primary:hover:not(:disabled) { opacity: 0.92; }
.cta-secondary { background: transparent; color: var(--text); border-color: var(--border); }
.cta-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.04); }
.cta-tertiary { background: transparent; color: var(--muted); border-color: transparent; }
.cta-tertiary:hover:not(:disabled) { color: var(--text); }
.cta-primary:disabled, .cta-secondary:disabled, .cta-tertiary:disabled { opacity: 0.5; cursor: not-allowed; }
.proposal-status { margin-top: 1.5rem; padding: 1rem 1.15rem; border-radius: 8px; }
.proposal-status.accepted { background: rgba(34,197,94,0.10); border: 1px solid rgba(34,197,94,0.45); }
.proposal-status.declined { background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.45); }
.proposal-status-title { font-weight: 700; font-size: 0.95rem; color: var(--text); margin-bottom: 0.25rem; }
.proposal-status-sub { color: var(--muted); font-size: 0.85rem; line-height: 1.5; }

/* Modal */
.proposal-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(3px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.proposal-modal { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6); }
.proposal-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.proposal-modal-head h3 { font-size: 1.25rem; font-weight: 700; margin: 0; color: var(--text); }
.proposal-modal-close { background: transparent; border: none; color: var(--muted); font-size: 1.75rem; line-height: 1; cursor: pointer; padding: 0 0.25rem; }
.proposal-modal-close:hover { color: var(--text); }
.proposal-modal-intro { color: var(--muted); font-size: 0.9rem; line-height: 1.55; margin: 0 0 1.25rem; }
.proposal-modal-fields { display: flex; flex-direction: column; gap: 0.85rem; }
.proposal-modal-fields label { display: flex; flex-direction: column; gap: 0.35rem; }
.proposal-modal-fields label span { font-size: 0.8rem; font-weight: 600; color: var(--text); }
.proposal-modal-fields input, .proposal-modal-fields textarea { background: var(--card2); border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.75rem; color: var(--text); font-size: 0.95rem; font-family: inherit; outline: none; transition: border-color 0.15s; }
.proposal-modal-fields input:focus, .proposal-modal-fields textarea:focus { border-color: var(--orange); }
.proposal-modal-fields textarea { resize: vertical; min-height: 90px; }
.proposal-modal-error { color: #fca5a5; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.40); padding: 0.6rem 0.85rem; border-radius: 6px; font-size: 0.85rem; margin-top: 1rem; }
.proposal-modal-actions { display: flex; justify-content: flex-end; gap: 0.65rem; margin-top: 1.25rem; }

/* Request-Proposal modal — isolated styling so the parent .proposal-modal-fields
   rules don't leak in and stack everything vertically. */
.request-proposal-modal { max-width: 620px; }
.request-proposal-modal .rp-body { display: flex; flex-direction: column; gap: 1.1rem; }
.request-proposal-modal .rp-section-title { font-size: 0.8rem; font-weight: 700; color: var(--text); margin-bottom: 0.55rem; letter-spacing: 0.01em; }
.request-proposal-modal .rp-options { display: flex; flex-direction: column; gap: 0.5rem; }
.request-proposal-modal .rp-empty { color: var(--muted); font-size: 0.85rem; }
.request-proposal-modal .rp-row {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.request-proposal-modal .rp-row:hover { border-color: rgba(232,49,42,0.55); background: rgba(255,255,255,0.04); }
.request-proposal-modal .rp-row-selected { border-color: var(--orange) !important; background: rgba(232,49,42,0.08) !important; }
.request-proposal-modal .rp-row input[type="radio"],
.request-proposal-modal .rp-row input[type="checkbox"] {
  margin: 0.2rem 0 0 0;
  flex-shrink: 0;
  width: 16px; height: 16px;
  accent-color: #e8312a;
  cursor: pointer;
}
.request-proposal-modal .rp-row-body { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-width: 0; }
.request-proposal-modal .rp-row-title { font-size: 0.92rem; font-weight: 600; color: var(--text); line-height: 1.3; }
.request-proposal-modal .rp-row-meta { font-size: 0.78rem; color: var(--muted); line-height: 1.3; }
.request-proposal-modal .rp-row-desc { font-size: 0.8rem; color: var(--muted); line-height: 1.4; margin-top: 0.2rem; }
.request-proposal-modal .rp-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; }
@media (max-width: 540px) {
  .request-proposal-modal .rp-grid-2 { grid-template-columns: 1fr; }
}
.request-proposal-modal .rp-field { display: flex; flex-direction: column; gap: 0.35rem; }
.request-proposal-modal .rp-field-label { font-size: 0.78rem; font-weight: 600; color: var(--text); }
.request-proposal-modal .rp-input,
.request-proposal-modal .rp-textarea {
  width: 100%;
  background: rgba(0,0,0,0.25);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.55rem 0.7rem;
  font-size: 0.92rem;
  font-family: inherit;
  outline: none;
}
.request-proposal-modal .rp-textarea { resize: vertical; min-height: 80px; line-height: 1.45; }
.request-proposal-modal .rp-input:focus,
.request-proposal-modal .rp-textarea:focus { border-color: var(--orange); }

/* Your-package card (rendered above the tier comparison table when a tier is selected on the proposal) */
.your-package-card { background: linear-gradient(180deg, rgba(232,49,42,0.07), rgba(232,49,42,0)); border: 1px solid rgba(232,49,42,0.35); border-radius: 12px; padding: 1.5rem 1.5rem 1.25rem; margin-bottom: 1.5rem; }
.your-package-label { font-size: 0.7rem; font-weight: 800; letter-spacing: 0.18em; color: var(--orange); text-transform: uppercase; margin-bottom: 0.4rem; }
.your-package-name { font-size: 1.65rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); margin-bottom: 0.25rem; }
.your-package-sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.85rem; }
.your-package-inclusions { list-style: none; padding: 0; margin: 0.5rem 0 1rem; display: grid; grid-template-columns: 1fr; gap: 0.4rem; }
@media (min-width: 720px) { .your-package-inclusions { grid-template-columns: 1fr 1fr; } }
.your-package-inclusions li { color: #cfcfd2; font-size: 0.9rem; line-height: 1.4; display: flex; align-items: flex-start; gap: 0.5rem; }
.your-package-inclusion-check { color: var(--orange); font-weight: 800; flex-shrink: 0; }
.your-package-inclusion-value { color: var(--muted); }
.your-package-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding-top: 0.85rem; border-top: 1px solid var(--border); margin-top: 0.5rem; }
.your-package-price { font-size: 1.85rem; font-weight: 800; color: var(--text); letter-spacing: -0.02em; }
.your-package-period { font-size: 0.9rem; color: var(--muted); font-weight: 600; }
.your-package-compare { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 0.5rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; transition: color 0.15s, border-color 0.15s; }
.your-package-compare:hover { color: var(--text); border-color: var(--orange); }

/* Explore-more bolt-ons section (rendered below the included ones when a proposal has a bolt-on selection) */
.bolton-explore-wrap { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
.bolton-explore-toggle { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 0.65rem 1.15rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: color 0.15s, border-color 0.15s; }
.bolton-explore-toggle:hover { color: var(--text); border-color: var(--orange); }
.bolton-grid-explore { margin-top: 1.25rem; opacity: 0.85; }
`;

// ─── Rich proposal detail (used when the proposal block was stamped by the wizard) ────
// Renders the full Investment + Discount highlight + Line items + Acceptance flow,
// reusing the same data shape the legacy /pitch/ flow used. The Accept path posts
// to /api/media-kit/public/:slug/accept with the billing details, contacts,
// and signed name; the Decline path posts to /api/media-kit/public/:slug/decline.
function RichProposalDetail(props: {
  c: any;
  share: any;
  slug: string;
  token: string;
  termsText: string;
  busy: boolean;
  errMsg: string | null;
  ctaActive?: boolean;
  setBusy: (b: boolean) => void;
  setErrMsg: (m: string | null) => void;
  setDoneMsg: (m: string | null) => void;
  onAccepted: () => void;
}) {
  const { c, share, slug, token, termsText, busy, errMsg, setBusy, setErrMsg, setDoneMsg } = props;
  const ctaActive = props.ctaActive !== false; // default true for back-compat
  const [decision, setDecision] = useState<null | "accept" | "decline">(null);
  const [billingCompany, setBillingCompany] = useState(share?.prospect_company || "");
  const [billingAddress, setBillingAddress] = useState("");
  const [contacts, setContacts] = useState<{ name: string; email: string }[]>([
    { name: share?.prospect_name || "", email: share?.prospect_email || "" },
  ]);
  const [signedName, setSignedName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const currency = c.total_currency || "USD";
  const isCasual = (c.proposal_type === "casual") || (c.total_period === "one_off");
  const months = c.contract_months || 6;
  const subtotal = Number(c.monthly_subtotal) || 0;
  const discountPct = Number(c.discount_pct) || 0;
  const monthlyTotal = Number(c.monthly_total) || subtotal;
  const contractTotal = Number(c.contract_total) || monthlyTotal * months;
  // Casual / one-off totals: bypass the monthly maths and use one-off subtotal/total
  const oneOffSubtotal = Number(c.one_off_subtotal) || subtotal;
  const oneOffTotal = Number(c.one_off_total) || Number(c.total_value) || oneOffSubtotal;
  const lineItems: any[] = Array.isArray(c.line_items_snapshot) ? c.line_items_snapshot : [];
  // Complimentary value: sum of `original_unit_price × qty` across all
  // complimentary lines. We deliberately do NOT multiply by contract months
  // — the displayed strike-through value (e.g. "$1,999 for a 1 Month masthead")
  // already reflects exactly what's being given away. The line's unit string
  // is descriptive, not a billing multiplier. If a partner wants a recurring
  // freebie, they set qty to the count of periods.
  const complimentaryValue = lineItems.reduce((sum, li) => {
    if (!li.is_complimentary) return sum;
    const orig = Number(li.original_unit_price) || 0;
    const qty = Number(li.qty) || 1;
    return sum + orig * qty;
  }, 0);
  const discountSaving = isCasual
    ? (oneOffSubtotal - oneOffTotal)
    : (subtotal - monthlyTotal) * months;
  const saving = discountSaving + complimentaryValue;

  const fmt = (n: number) => {
    const amount = new Intl.NumberFormat("en-AU", { style: "currency", currency: String(currency).toUpperCase(), currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(n || 0);
    const needsCode = ["USD", "AUD", "SGD", "NZD", "HKD", "CAD"].includes(String(currency).toUpperCase());
    return needsCode ? `${amount} ${String(currency).toUpperCase()}` : amount;
  };
  const taxSuffix = (() => {
    const cur = String(currency).toUpperCase();
    if (cur === "AUD") return " ex GST";
    if (cur === "GBP") return " no tax";
    return "";
  })();

  const submitAccept = async () => {
    if (!signedName.trim()) { setErrMsg("Please type your full legal name to sign."); return; }
    if (!accepted) { setErrMsg("Please confirm you have read and accept the Terms & Conditions."); return; }
    if (!billingCompany.trim()) { setErrMsg("Billing company name is required."); return; }
    if (!billingAddress.trim()) { setErrMsg("Billing address is required."); return; }
    const validContacts = contacts.filter(c => c.name.trim() && c.email.trim());
    if (validContacts.length === 0) { setErrMsg("At least one accounts contact is required."); return; }
    setBusy(true); setErrMsg(null);
    try {
      const r = await fetch(`/api/media-kit/public/${slug}/accept?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          name: signedName.trim(),
          email: validContacts[0].email,
          signed_name: signedName.trim(),
          billing_company: billingCompany.trim(),
          billing_address: billingAddress.trim(),
          accounts_contacts: validContacts,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || `Error ${r.status}`);
      setDoneMsg("Thank you. Your acceptance has been recorded and our team will be in touch within one business day.");
    } catch (e: any) {
      setErrMsg(e?.message || "Something went wrong.");
    } finally { setBusy(false); }
  };

  const submitDecline = async () => {
    setBusy(true); setErrMsg(null);
    try {
      const r = await fetch(`/api/media-kit/public/${slug}/decline?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          name: share?.prospect_name || "",
          email: share?.prospect_email || "",
          reason: declineReason.trim() || "(no reason provided)",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || `Error ${r.status}`);
      setDoneMsg("Thanks for letting us know. We'll be in touch if anything changes.");
    } catch (e: any) {
      setErrMsg(e?.message || "Something went wrong.");
    } finally { setBusy(false); }
  };

  return (
    <div className="rich-proposal">
      {lineItems.length > 0 && (
        <div className="rich-line-items">
          <h3>What's included</h3>
          <ul>
            {lineItems.map((li: any, i: number) => (
              <li key={i} className={li.is_complimentary ? "is-complimentary" : ""}>
                <div className="rich-li-row">
                  <span className="rich-li-label">{li.label}{(() => {
                    // Show qty + period for periodic line items (e.g. "(1) — over 6 months").
                    // Bare qty multiplier still shown for non-periodic > 1 (e.g. "× 3").
                    const unit = String(li.unit || "");
                    const qty = Number(li.qty || 0);
                    const isPeriodic = /per\s+\d+\s+months?|over\s+\d+\s+months?|per\s+month/i.test(unit);
                    if (isPeriodic && qty > 0) return ` (${qty}) — ${unit}`;
                    if (qty && qty !== 1) return ` × ${qty}`;
                    return "";
                  })()}</span>
                  {li.is_complimentary && (
                    <span className="rich-li-price">
                      {li.original_unit_price != null && Number(li.original_unit_price) > 0 && (
                        <span className="rich-li-strike mono">{fmt(Number(li.original_unit_price) * Number(li.qty || 1))}</span>
                      )}
                      <span className="rich-li-comp-badge">Complimentary</span>
                    </span>
                  )}
                </div>
                {li.description && <span className="rich-li-desc">{li.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rich-invest-card">
        <h3>Your investment</h3>
        {isCasual ? (
          <>
            <div className="rich-invest-row">
              <span>Subtotal</span>
              <span className="mono">{fmt(oneOffSubtotal)}</span>
            </div>
            {discountPct > 0 && (
              <div className="rich-discount">
                <div className="rich-discount-left">
                  <span className="rich-discount-pct">−{discountPct}%</span>
                  <span className="rich-discount-label">{c.discount_label_text || "Partnership discount applied"}</span>
                </div>
                <span className="rich-discount-amount mono">
                  −{fmt(oneOffSubtotal - oneOffTotal)}
                </span>
              </div>
            )}
            <div className="rich-invest-row big">
              <span>One-off total</span>
              <span className="mono">
                {fmt(oneOffTotal)}{taxSuffix && <span className="rich-tax-suffix">{taxSuffix}</span>}
              </span>
            </div>
            {c.proposed_start_date && (
              <div className="rich-invest-row sub">
                <span className="muted">Proposed start date</span>
                <span className="muted">{new Date(c.proposed_start_date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</span>
              </div>
            )}
            {saving > 0 && (
              <div className="rich-savings">
                Total saving: <strong>{fmt(saving)}</strong>
                {complimentaryValue > 0 && discountSaving > 0 && (
                  <span className="rich-savings-breakdown"> ({fmt(discountSaving)} discount + {fmt(complimentaryValue)} complimentary)</span>
                )}
                {complimentaryValue > 0 && discountSaving === 0 && (
                  <span className="rich-savings-breakdown"> (complimentary value included)</span>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rich-invest-row">
              <span>Monthly subtotal</span>
              <span className="mono">{fmt(subtotal)}</span>
            </div>
            {discountPct > 0 && (
              <div className="rich-discount">
                <div className="rich-discount-left">
                  <span className="rich-discount-pct">−{discountPct}%</span>
                  <span className="rich-discount-label">{c.discount_label_text || "Partnership discount applied"}</span>
                </div>
                <span className="rich-discount-amount mono">
                  −{fmt(subtotal - monthlyTotal)}
                  <span className="rich-discount-period">/ month</span>
                </span>
              </div>
            )}
            <div className="rich-invest-row big">
              <span>Monthly investment</span>
              <span className="mono">
                {fmt(monthlyTotal)}{taxSuffix && <span className="rich-tax-suffix">{taxSuffix}</span>}
              </span>
            </div>
            <div className="rich-invest-row sub">
              <span className="muted">Total over {months}-month contract</span>
              <span className="mono muted">{fmt(contractTotal)}{taxSuffix}</span>
            </div>
            {c.proposed_start_date && (
              <div className="rich-invest-row sub">
                <span className="muted">Proposed start date</span>
                <span className="muted">{new Date(c.proposed_start_date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</span>
              </div>
            )}
            {saving > 0 && (
              <div className="rich-savings">
                Total saving over {months} months: <strong>{fmt(saving)}</strong>
                {complimentaryValue > 0 && discountSaving > 0 && (
                  <span className="rich-savings-breakdown"> ({fmt(discountSaving)} discount + {fmt(complimentaryValue)} complimentary)</span>
                )}
                {complimentaryValue > 0 && discountSaving === 0 && (
                  <span className="rich-savings-breakdown"> (complimentary value included)</span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="rich-decision">
        <h3>Ready to move forward?</h3>

        {!ctaActive && (
          <div className="rich-decision-pending" style={{ color: "var(--muted)", fontSize: "0.9rem", padding: "0.5rem 0" }}>
            This proposal is still in draft. Accept and Decline will be available once it has been sent.
          </div>
        )}

        {ctaActive && decision === null && (
          <div className="rich-decision-buttons">
            <button className="cta-primary" onClick={() => { setErrMsg(null); setDecision("accept"); }} disabled={busy}>Accept Proposal</button>
            <button className="cta-tertiary" onClick={() => { setErrMsg(null); setDecision("decline"); }} disabled={busy}>Decline</button>
          </div>
        )}

        {decision === "accept" && (
          <div className="rich-accept-form">
            {termsText && (
              <div className="rich-tnc">
                <h4>Terms &amp; Conditions</h4>
                <div className="rich-tnc-scroll">{renderTncMarkdown(termsText)}</div>
              </div>
            )}

            <div className="rich-billing">
              <h4>Your billing details</h4>
              <label>
                <span>Billing / company name *</span>
                <input value={billingCompany} onChange={e => setBillingCompany(e.target.value)} placeholder="Company name" />
              </label>
              <label>
                <span>Billing address *</span>
                <textarea value={billingAddress} onChange={e => setBillingAddress(e.target.value)} placeholder="Street, city, region, postcode, country" />
              </label>
              <div className="rich-contacts-label">Accounts / invoicing contacts *</div>
              {contacts.map((c, i) => (
                <div key={i} className="rich-contact-row">
                  <input
                    placeholder="Name"
                    value={c.name}
                    onChange={e => {
                      const next = [...contacts];
                      next[i] = { ...next[i], name: e.target.value };
                      setContacts(next);
                    }}
                  />
                  <input
                    placeholder="Email"
                    type="email"
                    value={c.email}
                    onChange={e => {
                      const next = [...contacts];
                      next[i] = { ...next[i], email: e.target.value };
                      setContacts(next);
                    }}
                  />
                  {contacts.length > 1 && (
                    <button type="button" className="rich-contact-remove" onClick={() => setContacts(contacts.filter((_, j) => j !== i))} title="Remove">×</button>
                  )}
                </div>
              ))}
              <button type="button" className="rich-contact-add" onClick={() => setContacts([...contacts, { name: "", email: "" }])}>+ Add another contact</button>
              <p className="rich-invoice-note">Invoices will go to all contacts listed.</p>
            </div>

            <label className="rich-signed">
              <span>Your full name *</span>
              <input type="text" value={signedName} onChange={e => setSignedName(e.target.value)} placeholder="Full legal name" />
            </label>

            <label className="rich-checkbox-row">
              <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
              <span>I have read and accept the Terms &amp; Conditions outlined, and am authorised to sign this agreement on behalf of <strong>{billingCompany || share?.prospect_company || "the named company"}</strong>{isCasual ? "." : ", and commit to the specified contract period."}</span>
            </label>

            {errMsg && <div className="rich-error">{errMsg}</div>}

            <div className="rich-form-actions">
              <button type="button" className="cta-tertiary" onClick={() => { setDecision(null); setErrMsg(null); }} disabled={busy}>Back</button>
              <button type="button" className="cta-primary" onClick={submitAccept} disabled={busy}>{busy ? "Submitting…" : "Confirm acceptance"}</button>
            </div>
          </div>
        )}

        {decision === "decline" && (
          <div className="rich-accept-form">
            <p>Sorry to hear this isn't quite right. A short note about why helps us refine future proposals — optional.</p>
            <label>
              <span>Reason (optional)</span>
              <textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Pricing, timing, scope, not a fit right now…" />
            </label>
            {errMsg && <div className="rich-error">{errMsg}</div>}
            <div className="rich-form-actions">
              <button type="button" className="cta-tertiary" onClick={() => { setDecision(null); setErrMsg(null); }} disabled={busy}>Back</button>
              <button type="button" className="cta-primary" onClick={submitDecline} disabled={busy}>{busy ? "Submitting…" : "Send"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Lightweight markdown renderer for T&Cs (headings, paragraphs, bullets, bold).
function renderTncMarkdown(md: string) {
  const lines = md.split(/\r?\n/);
  const out: any[] = [];
  let buf: string[] = [];
  const flushP = () => {
    if (buf.length) {
      out.push(<p key={out.length}>{renderInline(buf.join(" "))}</p>);
      buf = [];
    }
  };
  let ul: string[] = [];
  const flushUl = () => {
    if (ul.length) {
      out.push(<ul key={out.length}>{ul.map((x, i) => <li key={i}>{renderInline(x)}</li>)}</ul>);
      ul = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushP(); flushUl(); continue; }
    if (line.startsWith("#### ")) { flushP(); flushUl(); out.push(<h5 key={out.length}>{line.slice(5)}</h5>); continue; }
    if (line.startsWith("### ")) { flushP(); flushUl(); out.push(<h5 key={out.length}>{line.slice(4)}</h5>); continue; }
    if (line.startsWith("## ")) { flushP(); flushUl(); out.push(<h4 key={out.length}>{line.slice(3)}</h4>); continue; }
    if (line.startsWith("# ")) { flushP(); flushUl(); out.push(<h4 key={out.length}>{line.slice(2)}</h4>); continue; }
    if (line.startsWith("- ") || line.startsWith("* ")) { flushP(); ul.push(line.slice(2)); continue; }
    flushUl();
    buf.push(line);
  }
  flushP(); flushUl();
  return out;
}

// ─── Rich proposal (full Investment + Acceptance) styles ───────────────────
const richProposalCss = `
.rich-proposal { margin-top: 2rem; display: grid; gap: 1.75rem; }
.rich-proposal h3 { font-size: 1.05rem; font-weight: 700; color: var(--text); margin: 0 0 0.85rem; letter-spacing: -0.01em; }
.rich-proposal h4 { font-size: 0.95rem; font-weight: 700; color: var(--text); margin: 0 0 0.6rem; }

.rich-line-items ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
.rich-line-items li { display: flex; flex-direction: column; padding: 0.7rem 0.95rem; border: 1px solid var(--border); border-radius: 8px; background: rgba(255,255,255,0.02); }
.rich-line-items li.is-complimentary { border-color: rgba(34, 197, 94, 0.30); background: linear-gradient(90deg, rgba(34,197,94,0.04), rgba(34,197,94,0.0)); }
.rich-li-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.rich-li-price { display: inline-flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.rich-li-strike { color: var(--muted); text-decoration: line-through; text-decoration-thickness: 1px; font-size: 0.85rem; }
.rich-li-comp-badge { display: inline-block; font-size: 0.65rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.25rem 0.55rem; border-radius: 999px; background: rgba(34, 197, 94, 0.18); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.40); white-space: nowrap; }
.rich-li-label { font-weight: 600; color: var(--text); font-size: 0.9rem; }
.rich-li-desc { font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; line-height: 1.45; }

.rich-invest-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem 1.75rem; }
.rich-invest-row { display: flex; justify-content: space-between; align-items: baseline; padding: 0.5rem 0; font-size: 0.95rem; color: var(--text); }
.rich-invest-row.big { font-size: 1.35rem; font-weight: 800; border-top: 1px solid var(--border); padding-top: 0.9rem; margin-top: 0.4rem; color: var(--orange); }
.rich-invest-row.sub { font-size: 0.85rem; padding-top: 0; }
.rich-invest-row .mono { font-variant-numeric: tabular-nums; }
.rich-tax-suffix { font-size: 0.55em; font-weight: 600; margin-left: 0.5rem; opacity: 0.7; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.muted { color: var(--muted); }

.rich-discount {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  margin: 0.7rem 0 0.25rem;
  padding: 0.85rem 1.1rem;
  background: linear-gradient(135deg, rgba(34,197,94,0.10), rgba(34,197,94,0.04));
  border: 1px solid rgba(34,197,94,0.32);
  border-radius: 10px;
}
.rich-discount-left { display: flex; align-items: center; gap: 0.85rem; }
.rich-discount-pct { display: inline-flex; align-items: center; justify-content: center; min-width: 56px; padding: 0.25rem 0.55rem; background: #16a34a; color: #fff; font-weight: 800; font-size: 0.95rem; border-radius: 6px; font-variant-numeric: tabular-nums; }
.rich-discount-label { color: #86efac; font-weight: 600; font-size: 0.9rem; }
.rich-discount-amount { color: #4ade80; font-weight: 700; font-size: 1.02rem; font-variant-numeric: tabular-nums; }
.rich-discount-period { font-size: 0.7rem; font-weight: 500; color: #86efac; margin-left: 0.35rem; letter-spacing: 0.04em; text-transform: uppercase; }
.rich-savings { margin-top: 0.75rem; padding: 0.55rem 0.85rem; text-align: center; background: rgba(34,197,94,0.06); border: 1px dashed rgba(34,197,94,0.30); border-radius: 6px; font-size: 0.8rem; color: #86efac; }
.rich-savings strong { color: #4ade80; font-weight: 800; font-size: 0.92rem; margin-left: 0.25rem; }
.rich-savings-breakdown { display: block; margin-top: 0.2rem; font-size: 0.72rem; color: #6ee7b7; opacity: 0.85; font-weight: 500; }

.rich-decision { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem 1.75rem; }
.rich-decision-buttons { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.5rem; }
.rich-accept-form { display: grid; gap: 1rem; margin-top: 0.5rem; }
.rich-accept-form > label, .rich-billing label { display: grid; gap: 0.35rem; font-size: 0.82rem; color: var(--muted); }
.rich-accept-form input[type="text"], .rich-accept-form input[type="email"], .rich-accept-form textarea,
.rich-billing input, .rich-billing textarea {
  background: rgba(0,0,0,0.25); color: var(--text); border: 1px solid var(--border); padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.92rem; font-family: inherit; width: 100%;
}
.rich-accept-form textarea, .rich-billing textarea { min-height: 70px; resize: vertical; line-height: 1.45; }
.rich-accept-form input:focus, .rich-accept-form textarea:focus { outline: 2px solid rgba(232,49,42,0.4); border-color: var(--orange); }
.rich-billing { display: grid; gap: 0.75rem; padding: 1rem 1.1rem; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,255,255,0.02); }
.rich-contacts-label { font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }
.rich-contact-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.5rem; align-items: center; }
.rich-contact-remove { background: transparent; border: 1px solid var(--border); color: var(--muted); width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-size: 1.1rem; line-height: 1; }
.rich-contact-remove:hover { color: var(--orange); border-color: var(--orange); }
.rich-contact-add { justify-self: start; background: transparent; border: 1px dashed var(--border); color: var(--muted); padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }
.rich-contact-add:hover { border-color: var(--orange); color: var(--orange); }
.rich-invoice-note { font-size: 0.78rem; color: var(--muted); margin: 0.2rem 0 0; }

.rich-tnc { border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; background: rgba(255,255,255,0.02); }
.rich-tnc-scroll { max-height: 320px; overflow-y: auto; font-size: 0.87rem; color: #d4d4d6; line-height: 1.6; padding-right: 0.75rem; }
.rich-tnc-scroll p { margin: 0 0 0.7rem; }
.rich-tnc-scroll h4 { font-size: 1rem; font-weight: 700; color: var(--text); margin: 1.2rem 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border); }
.rich-tnc-scroll h5 { font-size: 0.78rem; font-weight: 700; color: var(--text); margin: 0.9rem 0 0.35rem; text-transform: uppercase; letter-spacing: 0.06em; }
.rich-tnc-scroll h4:first-child, .rich-tnc-scroll h5:first-child { margin-top: 0; }
.rich-tnc-scroll ul { margin: 0 0 0.85rem; padding: 0; list-style: none; }
.rich-tnc-scroll ul li { position: relative; padding-left: 1.25rem; margin-bottom: 0.45rem; }
.rich-tnc-scroll ul li::before { content: ""; position: absolute; left: 0; top: 0.6em; width: 6px; height: 6px; border-radius: 50%; background: var(--orange); }
.rich-tnc-scroll::-webkit-scrollbar { width: 6px; }
.rich-tnc-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.rich-tnc-scroll strong { color: var(--text); }

.rich-checkbox-row { display: flex !important; flex-direction: row !important; align-items: flex-start; gap: 0.9rem; padding: 0.85rem 1rem; border: 1px solid var(--border); border-radius: 8px; background: rgba(255,255,255,0.02); cursor: pointer; }
.rich-checkbox-row:hover { border-color: var(--orange); }
.rich-checkbox-row input[type="checkbox"] { width: 22px; height: 22px; flex-shrink: 0; margin: 0; accent-color: var(--orange); cursor: pointer; }
.rich-checkbox-row span { font-size: 0.85rem; color: var(--text); line-height: 1.5; }

.rich-signed { margin-top: 0.3rem; }
.rich-error { color: #fca5a5; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.40); padding: 0.6rem 0.85rem; border-radius: 6px; font-size: 0.85rem; }
.rich-form-actions { display: flex; justify-content: flex-end; gap: 0.65rem; margin-top: 0.5rem; }
`;

// ─── Print stylesheet ───────────────────────────────────────────────────────
// The public kit/proposal renders edge-to-edge dark with vibrant accents.
// Browser print engines default to white backgrounds and stripped colors, which
// makes the saved PDF look broken. The rules below force backgrounds + colors,
// suppress interactive controls, and lay out for portrait A4/Letter.
const printCss = `
.kit-pdf-btn {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 9999;
  background: var(--orange, #e8312a);
  color: #fff;
  border: 0;
  border-radius: 999px;
  padding: 0.65rem 1.1rem;
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(232, 49, 42, 0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.kit-pdf-btn:hover { background: #d62b24; transform: translateY(-1px); box-shadow: 0 8px 24px rgba(232, 49, 42, 0.45); }
.print-cover-stamp { display: none; }
/* Print-only utility — elements with .print-only are hidden on screen and
   only appear in the saved PDF. */
.print-only { display: none !important; }

@media print {
  /* Force the browser to keep our dark backgrounds + colored accents. */
  html, body, .kit-root, .section, .section.alt, .hero {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
    background: #0a0a0a !important;
    color: #f4f4f5 !important;
  }
  body { margin: 0 !important; }
  .kit-root { padding-bottom: 0 !important; }

  /* A4 portrait with tight, even margins. We deliberately push margins out
     slightly so the browser's auto-injected header/footer (page number, URL,
     date) doesn't crash into the content even if the user forgets to disable
     them in the print dialog. */
  @page {
    size: A4 portrait;
    margin: 14mm 12mm 16mm;
    background: #0a0a0a;
  }

  /* Print-only utility: reveal elements with .print-only on the saved PDF. */
  .print-only { display: block !important; }
  .hero-date { font-size: 0.9rem; color: #a1a1aa; margin-top: 0.5rem; }

  /* Cover page — logo + media-kit lockup at top, big centred prospect name in
     the middle, region badge + date strip at the bottom. Forces a page break
     after so the proposal always opens on its own page. */
  .hero {
    padding: 0 !important;
    border-bottom: none !important;
    page-break-after: always !important;
    break-after: page !important;
    min-height: 250mm !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    justify-content: stretch !important;
    background: radial-gradient(ellipse at top, rgba(232,49,42,0.18), transparent 70%), #0a0a0a !important;
    position: relative !important;
  }
  .hero-inner {
    padding: 0 !important;
    max-width: none !important;
    width: 100% !important;
    flex: 1 1 auto !important;
    display: grid !important;
    grid-template-rows: auto 1fr auto !important;
    gap: 0 !important;
  }
  /* Row 1: brand row — logo + MEDIA KIT pill, top-centered with a divider beneath. */
  .hero .brand-row {
    padding: 16mm 0 8mm !important;
    display: flex !important;
    justify-content: center !important;
    border-bottom: 1px solid rgba(255,255,255,0.08) !important;
    margin-bottom: 0 !important;
  }
  .hero .brand { display: flex !important; align-items: center !important; gap: 0.85rem !important; justify-content: center !important; }
  .brand-logo { height: 72px !important; width: auto !important; }
  .hero .brand-pitch { font-size: 0.85rem !important; padding: 0.45rem 0.9rem !important; }

  /* Row 2: the big centre block — Prepared for [Brand]. */
  .hero-title {
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    text-align: center !important;
    font-size: 0 !important; /* hide the "Prepared for" text; we re-render via ::before */
    color: #fff !important;
    margin: 0 !important;
    padding: 0 12mm !important;
  }
  .hero-title::before {
    content: "Prepared for";
    display: block;
    font-size: 0.75rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: #e8312a;
    margin-bottom: 1.25rem;
    font-weight: 800;
  }
  .hero-title::after {
    content: attr(data-prospect);
    display: block;
    font-size: 3.4rem;
    line-height: 1.05;
    letter-spacing: -0.025em;
    font-weight: 800;
    color: #fff;
  }
  /* The "For the attention of …" subtitle in print sits below the big name. */
  .hero-personal {
    text-align: center !important;
    color: #d4d4d8 !important;
    font-size: 1rem !important;
    margin: 1.25rem 0 0 !important;
    font-style: normal !important;
  }

  /* Row 3: bottom strip — region badge + date, separated by a divider. */
  .hero-meta {
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 0.6rem !important;
    padding: 6mm 12mm !important;
    border-top: 1px solid rgba(255,255,255,0.08) !important;
    color: #a1a1aa !important;
    font-size: 0.9rem !important;
    flex-wrap: wrap !important;
  }
  .region-chip {
    background: var(--orange, #e8312a) !important;
    color: #fff !important;
    padding: 0.35rem 0.85rem !important;
    border-radius: 4px !important;
    font-size: 0.75rem !important;
    font-weight: 800 !important;
    letter-spacing: 0.15em !important;
  }
  .hero-date {
    text-align: center !important;
    font-size: 0.9rem !important;
    color: #a1a1aa !important;
    margin: 0 !important;
    padding: 2mm 12mm 16mm !important;
  }

  /* Section spacing for print — tighter top padding so the proposal block
     starts cleanly at the top of page 2. */
  .kit-root > .section:first-of-type,
  .kit-root > .section:nth-of-type(2) {
    padding-top: 0 !important;
  }

  /* Hide things that don't belong on a printed proposal. */
  .no-print,
  .kit-pdf-btn,
  .masthead-toggle,
  .masthead-shade,
  .ready-cta,
  .rich-decision,
  .rich-decision-buttons,
  .rich-form,
  .rich-form-actions,
  .proposal-action-cta,
  .request-proposal-cta,
  .bolton-example,
  button {
    display: none !important;
  }

  /* Banner Examples block: print one row only (we shrunk it earlier) and
     stop it spanning more than one printed page. */
  .banner-examples-row,
  .banner-examples {
    page-break-inside: avoid;
  }

  /* Don't break key blocks across pages where avoidable. */
  .proposal-block,
  .proposal-summary,
  .rich-proposal-detail,
  .investment-card,
  .audstats-grid,
  .bolton-card,
  .ag-grid,
  .partnership-menu,
  .terms-list,
  .who-are-we,
  .why-us {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Section padding tightening for print (screens use bigger pads). */
  .section, .section.alt {
    padding: 1.25rem 0 !important;
  }
  .section-inner {
    padding: 0 !important;
  }

  /* Make sure hero + dark gradients render. */
  .hero, .hero::before, .hero::after {
    background-color: #0a0a0a !important;
  }

  /* Links: keep them readable in print (don't underline our orange). */
  a { color: inherit !important; text-decoration: none !important; }

  /* Footer copy block — keep but smaller. */
  .footer { padding: 1.5rem 1rem !important; }
}
`;
