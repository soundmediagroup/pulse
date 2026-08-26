import { storage } from "./storage";

function parseForumHtml(html: string) {
  // The Invision Community forum page has stats in this order:
  // Ads Statistics section: Active Ads, Total Ads, Successful Sales, Total Sales (14d), Total Ads Value
  // Forum Statistics section: Total Topics, Total Posts
  //
  // HTML structure per stat card:
  //   <div class="..."><span class="...">534</span><span class="...">Active Ads</span></div>
  //
  // Strategy: find the "Ads Statistics" heading, then extract numbers in order.
  // This avoids regex label-matching issues where greedy patterns grab across cards.

  const result: any = {
    active_ads: 0,
    total_ads: 0,
    successful_sales: 0,
    clearance_rate: "N/A",
    total_sales_14d: "$0",
    total_ads_value: "$0",
    total_topics: "0",
    total_posts: "0",
    total_members: "0",
    // Precise integer counts — extracted from title="..." attributes when the
    // visible label is abbreviated (e.g. "601.9k" with title="601,872").
    total_topics_precise: null as number | null,
    total_posts_precise: null as number | null,
    total_members_precise: null as number | null,
  };

  // Find the Ads Statistics section
  const adsIdx = html.indexOf("Ads Statistics");
  const forumIdx = html.indexOf("Forum Statistics");

  if (adsIdx > -1) {
    // Get the chunk between "Ads Statistics" and "Forum Statistics" (or next major section)
    const endIdx = forumIdx > adsIdx ? forumIdx : adsIdx + 3000;
    const adsChunk = html.substring(adsIdx, endIdx);

    // Extract all numbers/dollar amounts from this chunk, in order of appearance
    // Match: plain numbers like "534" or "26,380", or dollar amounts like "$62,794" or "$53,648,176"
    const allValues: string[] = [];
    // Strip HTML tags to get just text with spaces
    const textOnly = adsChunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    // Match dollar amounts and plain numbers in order
    const valueRegex = /(\$[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?)/g;
    let m;
    const seenLabels = new Set<string>();
    while ((m = valueRegex.exec(textOnly)) !== null) {
      const val = m[1];
      // Skip tiny numbers that are likely CSS/layout artifacts, and skip "14" from "Last 14 Days"
      if (val === "14" || val === "2024") continue;
      // Skip if it looks like a year
      if (/^20\d{2}$/.test(val)) continue;
      allValues.push(val);
    }

    // The values appear in this order on the page:
    // [0] Active Ads (e.g. "534")
    // [1] Total Ads (e.g. "26,380")
    // [2] Successful Sales (e.g. "5,968")
    // [3] Total Sales $ amount (e.g. "$62,794")
    // [4] Total Ads Value $ amount (e.g. "$53,648,176")
    if (allValues.length >= 1) result.active_ads = parseInt(allValues[0].replace(/[$,]/g, "")) || 0;
    if (allValues.length >= 2) result.total_ads = parseInt(allValues[1].replace(/[$,]/g, "")) || 0;
    if (allValues.length >= 3) result.successful_sales = parseInt(allValues[2].replace(/[$,]/g, "")) || 0;

    // Find dollar amounts for sales and ads value
    const dollarValues = allValues.filter(v => v.startsWith("$"));
    if (dollarValues.length >= 1) result.total_sales_14d = dollarValues[0];
    if (dollarValues.length >= 2) result.total_ads_value = dollarValues[1];
  }

  if (forumIdx > -1) {
    // Get chunk after "Forum Statistics"
    const forumChunk = html.substring(forumIdx, forumIdx + 2000);

    // First, pull precise integer counts from title="..." attributes BEFORE stripping HTML.
    // Invision Community renders abbreviated counts with the precise value in the title attr.
    // Order matches the display order: Topics, Posts (and sometimes Members).
    const titlePreciseRegex = /title="([\d,]{4,})"/g;
    const preciseValues: number[] = [];
    let pm;
    while ((pm = titlePreciseRegex.exec(forumChunk)) !== null) {
      const n = parseInt(pm[1].replace(/,/g, ""), 10);
      if (!Number.isNaN(n) && n > 1000) preciseValues.push(n);
    }
    if (preciseValues.length >= 1) result.total_topics_precise = preciseValues[0];
    if (preciseValues.length >= 2) result.total_posts_precise = preciseValues[1];
    if (preciseValues.length >= 3) result.total_members_precise = preciseValues[2];

    // Fall back to text-mode parsing for the abbreviated display labels (legacy behaviour).
    const textOnly = forumChunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const valueRegex = /(\d[\d,]*(?:\.\d+)?[km])/gi;
    const forumValues: string[] = [];
    let m;
    while ((m = valueRegex.exec(textOnly)) !== null) {
      forumValues.push(m[1]);
    }
    if (forumValues.length >= 1) result.total_topics = forumValues[0];
    if (forumValues.length >= 2) result.total_posts = forumValues[1];
    if (forumValues.length >= 3) result.total_members = forumValues[2];

    // Find the Members count by label proximity if it wasn't the third k/m number.
    // Look for "Total Members" or "Members" near a number.
    const membersMatch = textOnly.match(/Total Members\s+(\d[\d,]*(?:\.\d+)?[km]?)/i) || textOnly.match(/Members\s+(\d[\d,]*(?:\.\d+)?[km]?)/i);
    if (membersMatch) result.total_members = membersMatch[1];
  }

  return result;
}

export async function fetchForumStats() {
  try {
    /* legacy log */ console.log("[cadence] Fetching forum stats (server-side)...");
    const res = await fetch("https://www.stereonet.com/forums/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.error("[cadence] Forum stats fetch failed:", res.status);
      return null;
    }
    const html = await res.text();

    // Check if we got a Cloudflare challenge page
    if (html.includes("challenge-platform") || html.includes("cf-browser-verification") || html.length < 5000) {
      console.error("[cadence] Forum stats: got Cloudflare challenge, skipping server-side parse");
      return null;
    }

    const stats = parseForumHtml(html);

    if (stats.active_ads > 0) {
      storage.insertForumStats(stats);
      console.log(`[cadence] Forum stats saved: ${stats.active_ads} active ads, ${stats.total_topics} topics`);
    } else {
      console.warn("[cadence] Forum stats: parsed 0 active ads, HTML may not contain stats section");
    }
    return stats;
  } catch (err: any) {
    console.error("[cadence] Forum stats error:", err?.message);
    return null;
  }
}

// Return raw HTML so client can parse it (avoids CORS issue)
export async function proxyForumPage(): Promise<string | null> {
  try {
    const res = await fetch("https://www.stereonet.com/forums/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en-US;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes("challenge-platform") || html.length < 5000) return null;
    return html;
  } catch {
    return null;
  }
}

export { parseForumHtml };
