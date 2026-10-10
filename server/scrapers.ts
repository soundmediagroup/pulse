// Web page scrapers for sites with dead/broken RSS feeds
// Fetches the news page HTML and extracts article links, titles, and dates

interface ScrapedArticle {
  title: string;
  url: string;
  date: string; // YYYY-MM-DD
  site: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function parseDate(dateStr: string): string {
  // Try various date formats and return YYYY-MM-DD
  const d = new Date(dateStr.trim());
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Try "Apr 14, 2026" format
  const months: Record<string, string> = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  const m = dateStr.match(/(\w{3})\s+(\d{1,2}),?\s*(\d{4})/);
  if (m && months[m[1]]) return `${m[3]}-${months[m[1]]}-${m[2].padStart(2, "0")}`;
  return "";
}

async function scrapeAbsoluteSound(): Promise<ScrapedArticle[]> {
  try {
    const res = await fetch("https://www.theabsolutesound.com/news/", {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const articles: ScrapedArticle[] = [];
    // Pattern: <a href="https://www.theabsolutesound.com/articles/SLUG/"><h3>TITLE</h3></a>
    const regex = /<a\s+href="(https:\/\/www\.theabsolutesound\.com\/articles\/[^"]+)"[^>]*>\s*<h3>([^<]+)<\/h3>/gi;
    let match;
    const seen = new Set<string>();
    while ((match = regex.exec(html)) !== null) {
      const url = match[1].replace(/\/$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      articles.push({
        title: match[2].trim().replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&#8211;/g, "–").replace(/&#038;/g, "&"),
        url,
        date: "", // Will try to extract dates below
        site: "absolutesound",
      });
    }

    // Try to extract dates - they appear near article links as text like "Apr 14, 2026"
    const datePattern = /href="(https:\/\/www\.theabsolutesound\.com\/articles\/[^"]+)"[\s\S]*?(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}\b)/gi;
    let dm;
    while ((dm = datePattern.exec(html)) !== null) {
      const url = dm[1].replace(/\/$/, "");
      const article = articles.find(a => a.url === url);
      if (article && !article.date) {
        article.date = parseDate(dm[2]);
      }
    }

    // Default missing dates to today
    const today = new Date().toISOString().slice(0, 10);
    for (const a of articles) {
      if (!a.date) a.date = today;
    }

    console.log(`[scraper] Absolute Sound: found ${articles.length} articles`);
    return articles;
  } catch (err: any) {
    console.error("[scraper] Absolute Sound error:", err?.message);
    return [];
  }
}

async function scrapeHiFiPlus(): Promise<ScrapedArticle[]> {
  try {
    const res = await fetch("https://hifiplus.com/category/news/", {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const articles: ScrapedArticle[] = [];
    // Pattern: <a href="https://hifiplus.com/articles/SLUG/"><h3>TITLE</h3></a> ... <li>DATE</li>
    const blockRegex = /<a\s+href="(https:\/\/hifiplus\.com\/articles\/[^"]+)"[^>]*>\s*<h3>([^<]+)<\/h3>\s*<\/a>\s*<ul>\s*<li>([^<]+)<\/li>/gi;
    let match;
    const seen = new Set<string>();
    while ((match = blockRegex.exec(html)) !== null) {
      const url = match[1].replace(/\/$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      articles.push({
        title: match[2].trim().replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&#8211;/g, "–").replace(/&#038;/g, "&"),
        url,
        date: parseDate(match[3]),
        site: "hifiplus",
      });
    }

    console.log(`[scraper] HiFi+: found ${articles.length} articles`);
    return articles;
  } catch (err: any) {
    console.error("[scraper] HiFi+ error:", err?.message);
    return [];
  }
}

async function scrapeHdtvtest(): Promise<ScrapedArticle[]> {
  try {
    // hdtvtest.co.uk has no RSS feed at all (confirmed: no <link rel=alternate>,
    // no /feed, /rss, /feed.xml, /rss.xml, nothing in robots.txt). It's a Next.js
    // site whose /news listing page is client-rendered (near-empty HTML), but the
    // homepage itself is server-rendered with the latest article cards inline, so
    // scrape that instead of /news.
    const res = await fetch("https://www.hdtvtest.co.uk/", {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const articles: ScrapedArticle[] = [];
    // Pattern: <a href="/news/SLUG">...<img alt="TITLE" ... srcSet="...Screenshot_from_YYYY_MM_DD_..." ...>
    // Capture the whole <img ...> tag's attributes so alt and srcSet can be
    // pulled out regardless of attribute order (a fixed-order regex missed
    // srcSet whenever other attributes came between alt and it).
    const regex = /href="(\/news\/[a-z0-9-]+)"[^>]*>(?:(?!<a )[\s\S])*?<img ([^>]+)>/gi;
    let match;
    const seen = new Set<string>();
    const today = new Date().toISOString().slice(0, 10);
    while ((match = regex.exec(html)) !== null) {
      const path = match[1];
      const url = `https://www.hdtvtest.co.uk${path}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const attrs = match[2];
      const altMatch = attrs.match(/alt="([^"]+)"/);
      if (!altMatch) continue;
      const title = altMatch[1].trim()
        .replace(/&amp;/g, "&").replace(/&#8217;|&#x27;/g, "'").replace(/&#8211;/g, "–")
        .replace(/&#038;/g, "&").replace(/&#8220;/g, "\u201C").replace(/&#8221;/g, "\u201D");
      // Try to pull a YYYY_MM_DD timestamp out of the screenshot filename in
      // the srcSet — not an exact publish date, but close (editors screenshot
      // around the time they write the story), and far better than nothing.
      let date = today;
      const dateMatch = attrs.match(/(\d{4})_(\d{2})_(\d{2})_/);
      if (dateMatch) {
        const [, yyyy, mm, dd] = dateMatch;
        const candidate = `${yyyy}-${mm}-${dd}`;
        if (!isNaN(new Date(candidate).getTime()) && candidate <= today) date = candidate;
      }
      articles.push({ title, url, date, site: "hdtvtest" });
    }

    console.log(`[scraper] HDTVTest: found ${articles.length} articles`);
    return articles;
  } catch (err: any) {
    console.error("[scraper] HDTVTest error:", err?.message);
    return [];
  }
}

export async function scrapeAllSites(): Promise<ScrapedArticle[]> {
  const [tas, hdtv] = await Promise.all([
    scrapeAbsoluteSound(),
    scrapeHdtvtest(),
  ]);
  return [...tas, ...hdtv];
}
