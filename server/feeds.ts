import { XMLParser } from "fast-xml-parser";
import type { InsertArticle } from "@shared/schema";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", cdataPropName: "__cdata", parseTagValue: true });

// ─── Site config ──────────────────────────────────────────────────────────────
export const SITES = {
  stereonet: {
    label: "StereoNET",
    url: "https://www.stereonet.com/site/content-rss",
    color: "#22d3ee",
  },
  whathifi: {
    label: "What Hi-Fi",
    url: "https://www.whathifi.com/feeds/all",
    color: "#6366f1",
  },
  hifipig: {
    label: "HiFi Pig",
    url: "https://www.hifipig.com/feed/",
    color: "#ec4899",
  },
  darko: {
    label: "Darko.Audio",
    url: "https://darko.audio/feed/",
    color: "#f97316",
  },
  ecoustics: {
    label: "eCoustics",
    url: "https://www.ecoustics.com/feed/",
    color: "#84cc16",
  },
  absolutesound: {
    label: "The Absolute Sound",
    url: "https://www.theabsolutesound.com/rss",
    color: "#eab308",
  },
  hifinews: {
    label: "Hi-Fi News",
    url: "https://www.hifinews.com/rss.xml",
    color: "#ef4444",
  },

  audiophileman: {
    label: "The Audiophile Man",
    url: "https://theaudiophileman.com/feed/",
    color: "#06b6d4",
  },
  twitteringmachines: {
    label: "Twittering Machines",
    url: "https://www.twitteringmachines.com/feed/",
    color: "#10b981",
  },
  audiohead: {
    label: "Audio-Head",
    url: "https://audio-head.com/feed/",
    color: "#f43f5e",
  },
  soundstage: {
    label: "SoundStage!",
    url: "https://www.soundstagehifi.com/index.php?format=feed&type=rss",
    color: "#3b82f6",
  },
  hometheaterhifi: {
    label: "HomeTheaterHiFi",
    url: "https://www.hometheaterhifi.com/feed/",
    color: "#a16207",
  },
  stereophile: {
    label: "Stereophile",
    url: "https://www.stereophile.com/rss.xml",
    color: "#7c3aed",
  },
  audioxpress: {
    label: "audioXpress",
    url: "https://audioxpress.com/rss",
    color: "#64748b",
  },
  techradar: {
    label: "TechRadar",
    url: "https://www.techradar.com/feeds.xml",
    color: "#0066cc",
  },
  cnet: {
    label: "CNET",
    url: "https://www.cnet.com/rss/news",
    color: "#e31937",
  },
  theverge: {
    label: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    color: "#6200ea",
  },
  engadget: {
    label: "Engadget",
    url: "https://www.engadget.com/rss.xml",
    color: "#1dbcf0",
  },
  tomsguide: {
    label: "Tom's Guide",
    url: "https://www.tomsguide.com/feeds/all",
    color: "#d32f2f",
  },
  gearpatrol: {
    label: "Gear Patrol",
    url: "https://www.gearpatrol.com/feed/",
    color: "#1a1a1a",
  },
  channelnews: {
    label: "ChannelNews",
    url: "https://channelnews.com.au/feed/",
    color: "#0055a5",
  },
  soundonsound: {
    label: "Sound On Sound",
    url: "https://www.soundonsound.com/rss.xml",
    color: "#c62828",
  },
  dailyaudio: {
    label: "daily.audio",
    url: "https://daily.audio/feed/",
    color: "#ff6f00",
  },
  samsung: {
    label: "Samsung Newsroom",
    url: "https://news.samsung.com/global/feed",
    color: "#1428a0",
  },

  // ─── Added April 2026 ──────────────────────────────────────
  audioholics: {
    label: "Audioholics",
    url: "https://www.audioholics.com/rss.xml",
    color: "#0ea5e9",
  },
  enjoythemusic: {
    label: "Enjoy the Music",
    url: "https://www.enjoythemusic.com/enjoythemusic.xml",
    color: "#d97706",
  },
  audiophilia: {
    label: "Audiophilia",
    url: "https://www.audiophilia.com/reviews?format=rss",
    color: "#9333ea",
  },
  dagogo: {
    label: "Dagogo",
    url: "https://dagogo.com/feed",
    color: "#be123c",
  },
  parttimeaudiophile: {
    label: "Part-Time Audiophile",
    url: "https://parttimeaudiophile.com/feed",
    color: "#0f766e",
  },
  hifiplus: {
    label: "Hi-Fi+",
    url: "https://www.hifiplus.com/news/feed",
    color: "#e11d48",
  },
  audiobacon: {
    label: "Audio Bacon",
    url: "https://audiobacon.net/feed",
    color: "#ea580c",
  },
  audiophilereview: {
    label: "Audiophile Review",
    url: "https://audiophilereview.com/feed",
    color: "#4338ca",
  },
  audioresurgence: {
    label: "Audio Resurgence",
    url: "https://audioresurgence.com/feed",
    color: "#0891b2",
  },
  audiofi: {
    label: "AudioFi",
    url: "https://audiofi.net/feed",
    color: "#7c2d12",
  },

  // ─── Manufacturer newsrooms (direct RSS) ───────────────────────
  dynaudio: {
    label: "Dynaudio",
    url: "https://www.dynaudio.com/news?format=rss",
    color: "#831843",
  },
  kef: {
    label: "KEF",
    url: "https://us.kef.com/blogs/news.atom",
    color: "#78350f",
  },
  klipsch: {
    label: "Klipsch",
    url: "https://www.klipsch.com/blog/rss",
    color: "#b91c1c",
  },
  lg_newsroom: {
    label: "LG Newsroom",
    url: "https://www.lgnewsroom.com/feed/",
    color: "#a21caf",
  },
  mcintosh: {
    label: "McIntosh",
    url: "https://www.mcintoshlabs.com/rss/news",
    color: "#15803d",
  },
  sonos_community: {
    label: "Sonos Community",
    url: "https://en.community.sonos.com/feed/topics",
    color: "#1e40af",
  },

  // ─── Google News queries (brands without direct RSS) ─────────────────
  gn_bose: {
    label: "Bose (via News)",
    url: "https://news.google.com/rss/search?q=%22Bose+QuietComfort%22+OR+%22Bose+headphones%22+OR+%22Bose+soundbar%22+OR+%22Bose+speaker%22+OR+%22Bose+Ultra%22&hl=en-US",
    color: "#0ea5e9",
  },
  gn_bowerswilkins: {
    label: "Bowers & Wilkins (via News)",
    url: "https://news.google.com/rss/search?q=%22Bowers+%26+Wilkins%22+speakers&hl=en-US",
    color: "#fbbf24",
  },
  gn_bang_olufsen: {
    label: "Bang & Olufsen (via News)",
    url: "https://news.google.com/rss/search?q=%22Bang+%26+Olufsen%22&hl=en-US",
    color: "#a3a3a3",
  },
  gn_focal: {
    label: "Focal (via News)",
    url: "https://news.google.com/rss/search?q=%22Focal+Utopia%22+OR+%22Focal+Sopra%22+OR+%22Focal+Aria%22+OR+%22Focal+Clear%22+OR+%22Focal+Bathys%22+OR+%22Focal+Chora%22+OR+%22Focal+Stellia%22+OR+%22Focal+Elegia%22+OR+%22Focal+Naim%22+OR+%22Focal+Vestia%22&hl=en-US",
    color: "#dc2626",
  },
  gn_denon: {
    label: "Denon (via News)",
    url: "https://news.google.com/rss/search?q=%22Denon+AVR%22+OR+%22Denon+receiver%22+OR+%22Denon+amplifier%22+OR+%22Denon+PMA%22+OR+%22Denon+DCD%22+OR+%22Denon+Home%22&hl=en-US",
    color: "#1e293b",
  },
  gn_marantz: {
    label: "Marantz (via News)",
    url: "https://news.google.com/rss/search?q=%22Marantz+Cinema%22+OR+%22Marantz+amplifier%22+OR+%22Marantz+receiver%22+OR+%22Marantz+Model%22+OR+%22Marantz+PM%22+OR+%22Marantz+SA%22&hl=en-US",
    color: "#92400e",
  },
  gn_svs: {
    label: "SVS (via News)",
    url: "https://news.google.com/rss/search?q=SVS+subwoofer&hl=en-US",
    color: "#1d4ed8",
  },
  gn_sennheiser: {
    label: "Sennheiser (via News)",
    url: "https://news.google.com/rss/search?q=%22Sennheiser+HD%22+OR+%22Sennheiser+Momentum%22+OR+%22Sennheiser+IE%22+OR+%22Sennheiser+Accentum%22+OR+%22Sennheiser+Ambeo%22+OR+%22Sennheiser+headphones%22&hl=en-US",
    color: "#059669",
  },
  gn_audiotechnica: {
    label: "Audio-Technica (via News)",
    url: "https://news.google.com/rss/search?q=%22Audio-Technica%22&hl=en-US",
    color: "#f59e0b",
  },
  gn_panasonic: {
    label: "Panasonic TV (via News)",
    url: "https://news.google.com/rss/search?q=%22Panasonic+OLED%22+OR+%22Panasonic+Z95%22+OR+%22Panasonic+MZ%22+OR+%22Panasonic+Viera%22+OR+%22Panasonic+TV%22&hl=en-US",
    color: "#1e3a8a",
  },
  gn_sony_audio: {
    label: "Sony Audio (via News)",
    // Tight phrase queries so Google News only returns articles about actual Sony audio
    // products, not every piece that mentions Sony as a competitor/reference.
    url: "https://news.google.com/rss/search?q=%22Sony+headphones%22+OR+%22Sony+WH-1000%22+OR+%22Sony+WF-1000%22+OR+%22Sony+speaker%22+OR+%22Sony+amplifier%22+OR+%22Sony+soundbar%22+OR+%22Sony+Bravia%22&hl=en-US",
    color: "#1f2937",
  },
} as const;

export type SiteKey = keyof typeof SITES;

// ─── Brand/product extractor ───────────────────────────────────────────────────
// Extracts capitalised brand names and model numbers from article titles.
// Fully dynamic — no hardcoded list. Frequency across the DB is what surfaces signal.
export function extractBrands(title: string): string[] {
  const brands = new Set<string>();

  // 1. Model numbers: alphanumeric with digits (e.g. WH-1000XM6, R3 Meta, CXA81, HD 800 S)
  const modelPattern = /\b([A-Z][A-Za-z0-9]*[-\s]?[A-Z0-9][A-Za-z0-9\-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = modelPattern.exec(title)) !== null) {
    const tok = m[1].trim();
    // Must contain at least one digit OR be all-caps (acronym/brand)
    if (/\d/.test(tok) || /^[A-Z]{2,}$/.test(tok)) {
      if (tok.length >= 2 && tok.length <= 30) brands.add(tok);
    }
  }

  // 2. Capitalised words/phrases — grab runs of Title Case words (2+ chars each)
  // Split on common separators first
  // Strip possessive 's (straight apostrophe ’ and curly apostrophe ’) so
  // "Sennheiser’s HD 480" extracts the brand as "Sennheiser" not "Sennheiser’s".
  // Without this the brand-match coverage check fails because StereoNET stores
  // "Sennheiser’s" while every other site stores plain "Sennheiser".
  const titleClean = title
    .replace(/[\u2019']s\b/g, "")
    .replace(/[\u2014\u2013\-:|,\.\?!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = titleClean.split(" ");
  let phrase: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // A "brand word": starts with uppercase, ≥2 chars, not a common English stop word
    const isCapWord = /^[A-Z][a-zA-Z0-9'&+]{1,}$/.test(w) && !STOP_WORDS.has(w.toLowerCase());
    if (isCapWord) {
      phrase.push(w);
    } else {
      if (phrase.length >= 1) {
        // Add the full phrase, plus every length-1+ sub-phrase. The length-1
        // case ensures single brand words like "Sennheiser" are captured even
        // when they appear in a multi-word run like "Sennheiser HD".
        for (let len = 1; len <= phrase.length; len++) {
          for (let start = 0; start <= phrase.length - len; start++) {
            brands.add(phrase.slice(start, start + len).join(" "));
          }
        }
      }
      phrase = [];
    }
  }
  if (phrase.length >= 1) {
    for (let len = 1; len <= phrase.length; len++) {
      for (let start = 0; start <= phrase.length - len; start++) {
        brands.add(phrase.slice(start, start + len).join(" "));
      }
    }
  }

  // Filter out very common noise words that slip through
  return [...brands].filter(b =>
    b.length >= 2 &&
    b.length <= 40 &&
    // Single words under 3 chars must be known brand acronyms
    (b.length >= 3 || /^(LG|B&W|JBL|KEF|NAD|SVS|REL|PSB|YBA|AKG)$/i.test(b)) &&
    !STOP_WORDS.has(b.toLowerCase()) &&
    !/^(Review|News|Feature|Opinion|The|New|Best|Top|How|Why|What|When|Where|Who|Is|Are|Was|Were|Has|Have|Had|Will|Would|Could|Should|Its|This|That|These|Those|With|From|Into|About|After|Before|During|While|Because|Though|Although|However|Therefore|Furthermore|Moreover|Nevertheless|Nonetheless|Meanwhile|Subsequently|Consequently|Accordingly|Otherwise)$/i.test(b)
  );
}

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","up","about","into","through","during","before","after","above","below",
  "between","out","off","over","under","again","then","once","here","there",
  "when","where","why","how","all","both","each","few","more","most","other",
  "some","such","no","not","only","same","than","too","very","just","its",
  "new","review","news","feature","opinion","best","top","is","are","was",
  "were","has","have","had","will","would","could","should","this","that",
  "these","those","what","which","who","whom","it","he","she","we","they",
  "i","me","him","her","us","them","my","your","his","its","our","their",
  "now","also","first","second","third","one","two","three","four","five",
  "get","got","can","do","does","did","go","goes","gone","come","coming",
  "take","taking","make","making","look","looking","say","said","says",
  "tested","tested","launched","announced","revealed","introduced","unveils",
  "price","spec","specs","everything","know","right","good","great","high",
  "low","big","small","long","short","old","young","own","still","back",
  "part","way","day","year","time","hand","place","case","week","month",
  "vs","versus","vs.","compared","against","show","report","guide","pick",
  "picks","award","awards","inside","track","exclusive","hands","listen",
  "set","amp","dac","pro","plus","mini","max","ultra","lite","se","mk",
  // Publication names that appear in article titles
  "stereonet","whathifi","hifipig","darko","ecoustics","stereophile",
  "soundstage","audiophile","twitteringmachines","audioxpress","hifinews",
  // Generic audio/tech/media words that aren't brands
  "app","apps","hi","fi","hifi","audio","sound","music","video","tv",
  "uk","us","usa","eu","aus","china","japan","india","germany","france",
  "blu","ray","bluetooth","wifi","usb","hdmi","rca","xlr","optical",
  "loudspeaker","loudspeakers","preamp","preamplifier","monoblock",
  "debut","legend","rewind","launch","launches","launched","announces",
  "unveils","reveals","introduces","available","coming","soon",
  "flagship","reference","signature","classic","heritage","tribute",
  "portable","desktop","compact","tower","floor","stand","mount",
  "channel","surround","atmos","spatial","immersive","analog","digital",
  "vinyl","tape","disc","stream","streaming","lossless","balanced",
  "class","power","powered","active","passive","planar","dynamic",
  "open","closed","back","over","ear","in","on","true","wireless",
  "wired","noise","cancelling","canceling","monitor","monitors",
  "studio","home","theater","theatre","cinema","room","test","bench",
  "super","mega","dual","triple","single","multi","pair","kit",
  "black","white","silver","gold","red","blue","green","special",
  "limited","anniversary","update","updated","firmware","software",
  "dan","i'm","im","it's","its","we","they","you","my","our","your",
  "av","april","march","february","january","may","june","july",
  "august","september","october","november","december","2024","2025","2026",
  "smart","vinyl","danish","british","american","japanese","german","french",
  "italian","swedish","chinese","korean","australian","european","asian",
  "dmp","rca","ii","iii","iv","gen","generation","type","version",
  "hot","cool","fresh","latest","next","last","big","small","little",
  "point","points","thing","things","lot","lots","kind","sort",
  "much","many","really","quite","rather","enough","nearly","almost",
  "already","just","even","ever","never","always","often","sometimes",
  "today","tomorrow","yesterday","tonight","morning","evening","afternoon",
  // Common non-brand words that slip through
  "available","coming","full","limited","special","official","original",
  "classic","standard","premium","advanced","complete","series","range",
  "edition","version","model","product","system","speaker","speakers",
  "amplifier","amplifiers","receiver","turntable","headphone","headphones",
  "streamer","integrated","bookshelf","floorstanding","subwoofer","network",
  "wireless","bluetooth","stereo","phono","cartridge","tonearm","cable",
  "cables","interconnect","soundstage","soundbar","earphones","earbuds",
  "review","reviewed","preview","interview","awards","award","winner",
  "exclusive","hands","listen","listening","tested","announced","launched",
  "unveiled","revealed","introduced","released","discontinued","updated",
  "improved","upgraded","refreshed","successor","replacement","alternative",
  "comparison","versus","shootout","roundup","roundup","buying","guide",
  "everything","know","need","want","looking","considering","worth",
  "price","pricing","cost","value","budget","affordable","expensive",
  "flagship","entry","level","high","end","mid","range","top","best",
]);

// ─── Content type classifier ──────────────────────────────────────────────────
// Uses URL patterns, categories, and title signals
type ContentType = "review" | "news" | "feature" | "opinion" | "unknown";

const REVIEW_SIGNALS = [
  /\/review[s]?\//i, /\breview\b/i, /\btested\b/i, /\bhands.on\b/i,
  /\bfirst look\b/i, /\blistening test\b/i, /\brating\b/i, /\bscore\b/i,
];
const NEWS_SIGNALS = [
  /\/news\//i, /\bnews\b/i, /\blaunche[sd]\b/i, /\bannounce[sd]?\b/i,
  /\brelease[sd]?\b/i, /\bdeals?\b/i, /\bprice[sd]?\b/i, /\blaunch\b/i,
  /\bunveil[s]?\b/i, /\bintroduce[sd]?\b/i, /\bnew \b/i, /\bupdate[sd]?\b/i,
  /\baward[s]?\b/i, /\bshow\b/i, /\baxpona\b/i, /\bces\b/i, /\bcambridge audio/i,
];
const FEATURE_SIGNALS = [
  /\/feature[s]?\//i, /\bfeature\b/i, /\bbest\b/i, /\bguide\b/i,
  /\bhow to\b/i, /\bexplained\b/i, /\bbuyersguide\b/i, /\bcompared\b/i,
  /\bvs\b/i, /\bversus\b/i, /\bchoosin[g]\b/i, /\bwhat to buy\b/i,
  /\btop \d/i, /\b\d+ best\b/i, /\bbest of\b/i, /\bin for review\b/i,
];
const OPINION_SIGNALS = [
  /\/opinion[s]?\//i, /\bopinion\b/i, /\beditorial\b/i, /\bcomment\b/i,
  /\bcolumn\b/i, /\bthoughts?\b/i, /\bponderings?\b/i, /\bessay\b/i,
  /\bwhy\b/i, /\bshould you\b/i, /\bletters?\b/i, /\binterview\b/i,
];

// Category-based hints
const CAT_REVIEW_HINTS = ["review", "reviews", "equipment reviews", "hifi reviews"];
const CAT_NEWS_HINTS = ["news", "latest news", "hifi news", "industry news", "product launch"];
const CAT_FEATURE_HINTS = ["features", "best picks", "buyer's guide", "buying guide", "hifi shows", "show report"];
const CAT_OPINION_HINTS = ["opinion", "editorial", "behind the brands", "industry insider", "interview"];

function classifyContentType(url: string, title: string, categories: string[]): ContentType {
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();
  const catsLower = categories.map(c => c.toLowerCase());

  // Check URL patterns first (most reliable)
  if (REVIEW_SIGNALS.slice(0, 1).some(p => p.test(urlLower))) return "review";
  if (NEWS_SIGNALS.slice(0, 1).some(p => p.test(urlLower))) return "news";
  if (FEATURE_SIGNALS.slice(0, 1).some(p => p.test(urlLower))) return "feature";
  if (OPINION_SIGNALS.slice(0, 1).some(p => p.test(urlLower))) return "opinion";

  // Check categories
  if (catsLower.some(c => CAT_REVIEW_HINTS.includes(c))) return "review";
  if (catsLower.some(c => CAT_NEWS_HINTS.includes(c))) return "news";
  if (catsLower.some(c => CAT_FEATURE_HINTS.includes(c))) return "feature";
  if (catsLower.some(c => CAT_OPINION_HINTS.includes(c))) return "opinion";

  // Check title signals
  if (REVIEW_SIGNALS.some(p => p.test(titleLower))) return "review";
  if (FEATURE_SIGNALS.some(p => p.test(titleLower))) return "feature";
  if (OPINION_SIGNALS.some(p => p.test(titleLower))) return "opinion";
  if (NEWS_SIGNALS.some(p => p.test(titleLower))) return "news";

  return "unknown";
}

// ─── RSS Fetcher ──────────────────────────────────────────────────────────────
async function safeFetch(url: string, timeout = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function decodeEntities(str: string): string {
  return str
    .replace(/&#0*38;|&amp;/g, "&")
    .replace(/&#0*60;|&lt;/g, "<")
    .replace(/&#0*62;|&gt;/g, ">")
    .replace(/&#0*34;|&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8212;/g, "\u2014")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#124;/g, "|")
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&[a-z]+;/gi, "");
}

function extractText(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return decodeEntities(val.replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  if (val.__cdata) return decodeEntities(String(val.__cdata).trim());
  if (val["#text"]) return decodeEntities(String(val["#text"]).trim());
  return decodeEntities(String(val).replace(/<!\[CDATA\[|\]\]>/g, "").trim());
}

// Map a content_type to the StereoNET URL segment that lives under the host.
// Returns null if we should leave the URL alone (unknown type).
function stereonetSegmentForType(t: string | null | undefined): string | null {
  switch (t) {
    case "review":  return "reviews";
    case "news":    return "news";
    case "opinion": return "opinion";   // singular per the live site
    case "feature": return "features";  // plural per the live site
    default:        return null;
  }
}

// Inject the right /news|reviews|opinion|features/ segment if missing.
// Idempotent: returns the input unchanged if a recognised segment is already
// in the path, or if we can't classify the article.
export function repairStereonetUrl(url: string, contentType: string | null | undefined): string {
  if (!url || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)stereonet\.com$/i.test(u.hostname)) return url;
    const path = u.pathname.replace(/^\/+/, "");
    // Already segmented? Leave alone.
    if (/^(news|reviews|opinion|features|opinions|review|headphone-zone|tag|category|series|forum|product-news|videos|video|in-the-press|press-release|press-releases|podcast|podcasts|community|guide|guides|deals|gallery|images|account|advertising)\b/i.test(path)) {
      return url;
    }
    // Need a slug to repair — if the path is empty (homepage) leave alone.
    if (!path) return url;
    const seg = stereonetSegmentForType(contentType);
    if (!seg) return url;
    u.pathname = `/${seg}/${path}`;
    return u.toString();
  } catch {
    return url;
  }
}

function parseRss(xml: string, site: string): InsertArticle[] {
  const now = new Date().toISOString();
  try {
    const data = parser.parse(xml);
    const channel = data?.rss?.channel;
    if (!channel) return [];
    const rawItems = channel.item;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    return items.slice(0, 100).map((item: any) => {
      const title = extractText(item.title);
      const rawUrl = extractText(item.link) || extractText(item.guid);
      // Clean UTM params from URL
      const url = rawUrl.split("?utm_")[0].split("&#038;utm_")[0];
      const pubDateStr = extractText(item.pubDate);
      let publishedAt = now;
      let publishedDate = now.slice(0, 10);
      if (pubDateStr) {
        try {
          let d: Date | null = null;
          // Handle MM-DD-YYYY HH:mm format (e.g. audioXpress: "08-04-2026 14:35")
          const mmddyyyy = pubDateStr.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
          if (mmddyyyy) {
            const [, mm, dd, yyyy, hh, mi] = mmddyyyy;
            d = new Date(`${yyyy}-${mm}-${dd}T${hh ?? "00"}:${mi ?? "00"}:00.000Z`);
          }
          // Handle dc:date ISO format and standard RFC 2822
          if (!d || isNaN(d.getTime())) {
            d = new Date(pubDateStr);
          }
          if (d && !isNaN(d.getTime())) {
            // Reject dates more than 7 days in the future (likely parsing error)
            if (d.getTime() <= Date.now() + 7 * 86400000) {
              publishedAt = d.toISOString();
              publishedDate = d.toISOString().slice(0, 10);
            }
          }
        } catch {}
      }

      // Extract categories
      let rawCats = item.category;
      let categories: string[] = [];
      if (rawCats) {
        const arr = Array.isArray(rawCats) ? rawCats : [rawCats];
        categories = arr.map(extractText).filter(Boolean);
      }

      // Extract author from dc:creator, author, or dc:contributor
      const rawAuthor = item["dc:creator"] ?? item["dc:contributor"] ?? item.author ?? null;
      let author: string | null = null;
      if (rawAuthor) {
        const cleaned = extractText(rawAuthor).replace(/^Review---\s*/i, "").trim();
        // Ignore generic/email values
        author = (cleaned && !cleaned.includes("@") && cleaned.length < 80) ? cleaned : null;
      }

      const contentType = classifyContentType(url, title, categories);
      const brandList = extractBrands(title);

      // StereoNET's RSS feed sometimes emits bare /<slug> URLs that 404 because
      // the real site routes through a content-type segment (/news/, /reviews/,
      // /opinion/, /features/). Patch on the way in.
      const finalUrl = site === "stereonet" ? repairStereonetUrl(url, contentType) : url;

      return {
        site,
        title,
        url: finalUrl,
        publishedAt,
        publishedDate,
        contentType,
        categories: JSON.stringify(categories),
        author,
        brands: JSON.stringify(brandList),
        fetchedAt: now,
      };
    }).filter((a: InsertArticle) => a.title && a.url);

    // Deduplicate multi-page reviews (e.g. Stereophile publishes "Product Review",
    // "Product Review Measurements", "Product Review Specifications" as separate items)
    // Deduplicate: if "Product Review" exists, remove "Product Review Measurements", "Product Review Page 2", etc.
    const titles = new Set(parsed.map(a => a.title));
    return parsed.filter(a => {
      // Check if any other article's title is a prefix of this one
      for (const t of titles) {
        if (t !== a.title && a.title.startsWith(t + " ") && a.site === site) {
          // This title is an extension of another — it's a sub-page
          return false;
        }
      }
      return true;
    });
  } catch (e) {
    console.error(`[feeds] parse error for ${site}:`, e);
    return [];
  }
}

// ─── Main fetch ───────────────────────────────────────────────────────────────
export async function fetchAllSites(): Promise<{ articles: InsertArticle[]; siteResults: Record<string, number> }> {
  const allArticles: InsertArticle[] = [];
  const siteResults: Record<string, number> = {};

  // Use DB-managed sites if available, fall back to hardcoded SITES
  let sitesToFetch: { siteKey: string; url: string }[] = [];
  try {
    // Lazy import to avoid circular dependency (storage.ts imports feeds.ts)
    const { storage } = await import("./storage");
    const dbSites = storage.getEnabledSites();
    if (dbSites.length > 0) {
      sitesToFetch = dbSites.map(s => ({ siteKey: s.site_key, url: s.rss_url }));
    }
  } catch {
    // Fall through to hardcoded
  }

  if (sitesToFetch.length === 0) {
    sitesToFetch = (Object.keys(SITES) as SiteKey[]).map(key => ({ siteKey: key, url: SITES[key].url }));
  }

  await Promise.all(
    sitesToFetch.map(async ({ siteKey, url }) => {
      const xml = await safeFetch(url);
      if (!xml) {
        siteResults[siteKey] = 0;
        return;
      }
      const parsed = parseRss(xml, siteKey);
      siteResults[siteKey] = parsed.length;
      allArticles.push(...parsed);
    })
  );

  return { articles: allArticles, siteResults };
}

// ─── Seed data generator ──────────────────────────────────────────────────────
export function generateSeedData(): InsertArticle[] {
  const now = new Date();
  const articles: InsertArticle[] = [];

  // Generate 30 days of realistic data
  const siteData: Record<SiteKey, { avgPerDay: number; typeWeights: number[] }> = {
    stereonet:         { avgPerDay: 5,  typeWeights: [0.35, 0.40, 0.20, 0.05] },
    whathifi:          { avgPerDay: 8,  typeWeights: [0.40, 0.30, 0.25, 0.05] },
    hifipig:           { avgPerDay: 6,  typeWeights: [0.35, 0.40, 0.15, 0.10] },
    darko:             { avgPerDay: 3,  typeWeights: [0.45, 0.30, 0.20, 0.05] }, // review/news-heavy
    ecoustics:         { avgPerDay: 10, typeWeights: [0.15, 0.75, 0.08, 0.02] }, // mostly news
    absolutesound:     { avgPerDay: 4,  typeWeights: [0.55, 0.20, 0.20, 0.05] }, // review-heavy
    hifinews:          { avgPerDay: 5,  typeWeights: [0.45, 0.30, 0.20, 0.05] },
    hifiplus:          { avgPerDay: 3,  typeWeights: [0.50, 0.25, 0.20, 0.05] }, // review-heavy
    audiophileman:     { avgPerDay: 2,  typeWeights: [0.40, 0.30, 0.20, 0.10] },
    twitteringmachines:{ avgPerDay: 2,  typeWeights: [0.50, 0.20, 0.25, 0.05] },
    audiohead:         { avgPerDay: 2,  typeWeights: [0.55, 0.25, 0.15, 0.05] },
    soundstage:        { avgPerDay: 4,  typeWeights: [0.45, 0.30, 0.20, 0.05] },
    hometheaterhifi:   { avgPerDay: 3,  typeWeights: [0.30, 0.50, 0.15, 0.05] },
  };

  const contentTypes: Array<"review" | "news" | "feature" | "opinion"> = ["review", "news", "feature", "opinion"];

  const titleTemplates: Record<SiteKey, Record<string, string[]>> = {
    stereonet: {
      review: ["{brand} {product} Review", "{brand} {product} Reviewed: Top Pick?", "Review: {brand} {product}"],
      news: ["{brand} {product} Launches in Australia", "{brand} Announces New {product}", "Exclusive: {brand}'s New {product}"],
      feature: ["Best {category} 2026 — StereoNET Picks", "Group Test: {category} Under $1000", "StereoNET Awards 2026"],
      opinion: ["Opinion: The State of {category} in 2026", "Why {brand} Is Worth Watching"],
    },
    whathifi: {
      review: ["{brand} {product} review", "{brand} {product} review: five-star performance?", "We tested the {brand} {product}"],
      news: ["{brand} announces {product} — here's everything we know", "{brand} {product} release date, price and specs"],
      feature: ["Best {category} 2026: our top picks", "Best {brand} products right now", "{category} vs {category}: which should you buy?"],
      opinion: ["Why we think {brand} is getting it right", "Has {brand} beaten the competition?"],
    },
    hifipig: {
      review: ["{brand} {product} Review", "In Review: {brand} {product}", "{brand} {product} — A Full Review"],
      news: ["{brand} Announces {product}", "New From {brand}: The {product}", "{brand} at AXPONA 2026"],
      feature: ["Best {category} Under £500", "HiFi Show Report: AXPONA 2026", "Guide to {category}"],
      opinion: ["Why {category} Matters More Than Ever", "An Audiophile's Take on {brand}"],
    },
    darko: {
      review: ["{brand} {product} Review", "{brand} {product}: In-Depth", "Measured: {brand} {product}"],
      news: ["{brand} Announces {product}", "First Look: {brand} {product}", "{brand}'s New {product} Arrives"],
      feature: ["The Darko Guide to {category}", "Why {brand} Stands Apart", "Thinking Aloud: {category}"],
      opinion: ["Perspective: On {brand} and the State of {category}", "An Honest Take on {brand}"],
    },
    ecoustics: {
      review: ["{brand} {product} Hands-On", "Quick Review: {brand} {product}"],
      news: ["{brand} Launches {product}", "{brand} Unveils New {product}", "{brand} {product} Now Available", "{brand} Announces {product} at AXPONA"],
      feature: ["Best {category} of 2026", "Buyer's Guide: {category}"],
      opinion: ["Industry Roundup: {category}"],
    },
    absolutesound: {
      review: ["{brand} {product} Review", "Equipment Report: {brand} {product}", "{brand} {product} — Highly Recommended"],
      news: ["{brand} Introduces {product}", "Show Report: {brand} at AXPONA"],
      feature: ["TAS Editors' Choice: {category}", "The Case for {brand}", "Best {category} of the Year"],
      opinion: ["On the Record: {category} in 2026", "Editor's View: The Future of {category}"],
    },
    hifinews: {
      review: ["{brand} {product} Review", "Test: {brand} {product}", "{brand} {product} Measured"],
      news: ["{brand} Launches {product}", "News: {brand} {product} Announced", "{brand} Reveals New {product}"],
      feature: ["Show Report: {brand} at Bristol", "Hi-Fi News Recommended: {category}", "Choosing {category}"],
      opinion: ["Comment: {brand} and the Future", "Letters: On {category}"],
    },
    hifiplus: {
      review: ["{brand} {product} Review", "{brand} {product} — Reference Grade?", "HiFi+ Tests: {brand} {product}"],
      news: ["{brand} Announces {product}", "From the Show Floor: {brand} {product}"],
      feature: ["HiFi+ Recommends: {category}", "The Shortlist: Best {category}", "State of the Art: {category}"],
      opinion: ["Perspective: {brand} Then and Now"],
    },
    audiophileman: {
      review: ["{brand} {product} Review", "Testing the {brand} {product}"],
      news: ["{brand} Releases {product}", "New: {brand} {product}"],
      feature: ["Best {category} Right Now", "The Audiophile Man's Guide to {category}"],
      opinion: ["Why {brand} Deserves More Attention", "Thoughts on {category}"],
    },
    twitteringmachines: {
      review: ["{brand} {product} Review", "{brand} {product}: A Long Listen"],
      news: ["{brand} Introduces {product}", "News: {brand} {product}"],
      feature: ["Streaming {category}: Where We Are", "The Best {category} I've Heard"],
      opinion: ["Musings on {brand} and {category}"],
    },
    audiohead: {
      review: ["{brand} {product} Review", "Headphone Review: {brand} {product}", "{brand} {product} Tested"],
      news: ["{brand} Announces New {product}", "{brand} {product} Released"],
      feature: ["Best Headphones of 2026", "Audio-Head's {category} Roundup"],
      opinion: ["Hot Take: {brand} {product}"],
    },
    soundstage: {
      review: ["{brand} {product} Review — SoundStage!", "Reviewed: {brand} {product}", "{brand} {product} on SoundStage!"],
      news: ["{brand} Launches {product}", "SoundStage! News: {brand} {product}"],
      feature: ["SoundStage! Recommends: {category}", "The Best {category} of 2026"],
      opinion: ["SoundStage! Perspective: {brand}"],
    },
    hometheaterhifi: {
      review: ["{brand} {product} Review", "HomeTheaterHiFi Tests the {brand} {product}"],
      news: ["{brand} {product} Press Release", "{brand} Announces {product}", "New Product: {brand} {product}"],
      feature: ["Best Home Cinema {category} 2026", "Setting Up {category}: A Guide"],
      opinion: ["Editorial: The State of Home Theatre"],
    },
  };

  const brands = ["Sony", "KEF", "Focal", "Sennheiser", "Naim", "Cambridge Audio", "WiiM", "Bluesound", "Denon", "Yamaha", "B&W", "Dynaudio", "Linn", "Chord", "McIntosh"];
  const products = ["WH-1000XM6", "R3 Meta", "Utopia", "HD 800 S", "Atom", "CXA81", "Ultra", "Node 3", "PMA-3000NE", "R-N2000A", "802 D4", "Confidence 20", "Klimax 360", "Hugo TT 3", "MA352"];
  const categories = ["headphones", "streamers", "loudspeakers", "turntables", "amplifiers", "DACs", "soundbars", "TVs", "earphones"];

  let idCounter = 1;
  for (let d = 29; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10);

    for (const [siteKey, config] of Object.entries(siteData) as [SiteKey, typeof siteData[SiteKey]][]) {
      // Vary count per day ±40%
      const dayCount = Math.max(1, Math.round(config.avgPerDay * (0.6 + Math.random() * 0.8)));

      for (let i = 0; i < dayCount; i++) {
        // Pick content type based on weights
        const rand = Math.random();
        let cumWeight = 0;
        let typeIdx = 0;
        for (let t = 0; t < config.typeWeights.length; t++) {
          cumWeight += config.typeWeights[t];
          if (rand <= cumWeight) { typeIdx = t; break; }
        }
        const contentType = contentTypes[typeIdx];

        const brand = brands[Math.floor(Math.random() * brands.length)];
        const product = products[Math.floor(Math.random() * products.length)];
        const category = categories[Math.floor(Math.random() * categories.length)];

        const templates = titleTemplates[siteKey][contentType];
        const template = templates[Math.floor(Math.random() * templates.length)];
        const title = template
          .replace("{brand}", brand)
          .replace("{product}", product)
          .replace("{category}", category);

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
        const siteUrls: Record<SiteKey, string> = {
          stereonet: `https://www.stereonet.com/${contentType === "review" ? "reviews" : contentType === "feature" ? "features" : "news"}/${slug}`,
          whathifi: `https://www.whathifi.com/${contentType === "review" ? "reviews" : contentType === "news" ? "news" : "advice"}/${slug}`,
          hifipig: `https://www.hifipig.com/${slug}/`,
          darko: `https://darko.audio/${slug}/`,
          ecoustics: `https://www.ecoustics.com/${contentType === "news" ? "news" : "products"}/${slug}/`,
          absolutesound: `https://www.theabsolutesound.com/articles/${slug}`,
          hifinews: `https://www.hifinews.com/content/${slug}`,
          hifiplus: `https://hifiplus.com/articles/${slug}/`,
          audiophileman: `https://theaudiophileman.com/${slug}/`,
          twitteringmachines: `https://www.twitteringmachines.com/${slug}/`,
          audiohead: `https://audio-head.com/${slug}/`,
          soundstage: `https://www.soundstagenetwork.com/${slug}`,
          hometheaterhifi: `https://www.hometheaterhifi.com/${contentType === "review" ? "equipment-reviews" : "news"}/${slug}/`,
        };

        const hourOffset = Math.floor(Math.random() * 18) + 6; // 6am–midnight
        const pubDate = new Date(date);
        pubDate.setHours(hourOffset, Math.floor(Math.random() * 60));

        articles.push({
          site: siteKey,
          title,
          url: `${siteUrls[siteKey]}-${idCounter}`,
          publishedAt: pubDate.toISOString(),
          publishedDate: dateStr,
          contentType,
          categories: JSON.stringify([contentType, brand.toLowerCase()]),
          fetchedAt: new Date().toISOString(),
        });
        idCounter++;
      }
    }
  }

  return articles;
}
