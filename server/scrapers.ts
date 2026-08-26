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

export async function scrapeAllSites(): Promise<ScrapedArticle[]> {
  const [tas] = await Promise.all([
    scrapeAbsoluteSound(),
  ]);
  return [...tas];
}
