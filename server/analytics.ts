import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { cfg } from "./config";

export const GA4_PROPERTY = () => cfg("GA4_PROPERTY_ID", "276060710");
const SC_SITE = () => cfg("SEARCH_CONSOLE_SITE", "sc-domain:stereonet.com");

// Cache auth per credentials value so it rebuilds when the admin rotates creds.
let authCache: { key: string; auth: GoogleAuth } | null = null;

export function getAuth(): GoogleAuth | null {
  const b64 = cfg("GOOGLE_CREDENTIALS_B64");
  if (!b64) {
    console.error("[analytics] No GOOGLE_CREDENTIALS_B64 configured");
    return null;
  }
  if (authCache && authCache.key === b64) return authCache.auth;
  try {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    const auth = new GoogleAuth({
      credentials: json,
      scopes: [
        "https://www.googleapis.com/auth/analytics.readonly",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ],
    });
    authCache = { key: b64, auth };
    return auth;
  } catch (e: any) {
    console.error("[analytics] Failed to parse credentials:", e.message);
    return null;
  }
}

// ─── GA4 Data ────────────────────────────────────────────────────────────────

const BOT_COUNTRIES = ["Singapore", "China", "Hong Kong"];

function buildCountryExclusionFilter(exclude?: string[]) {
  if (!exclude || exclude.length === 0) return undefined;
  return {
    notExpression: {
      filter: {
        fieldName: "country",
        inListFilter: { values: exclude },
      },
    },
  };
}

// Build a combined filter: country MUST be in `include` AND NOT in `exclude`.
function buildCountryScopeFilter(include?: string[], exclude?: string[]) {
  const expressions: any[] = [];
  if (include && include.length > 0) {
    expressions.push({ filter: { fieldName: "country", inListFilter: { values: include } } });
  }
  if (exclude && exclude.length > 0) {
    expressions.push({ notExpression: { filter: { fieldName: "country", inListFilter: { values: exclude } } } });
  }
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

export { BOT_COUNTRIES };

export async function fetchGA4Overview(
  startDate: string,
  endDate: string,
  excludeCountries?: string[],
  includeCountries?: string[]
) {
  const a = getAuth();
  if (!a) return null;
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const dimensionFilter = includeCountries && includeCountries.length > 0
      ? buildCountryScopeFilter(includeCountries, excludeCountries)
      : buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
          { name: "newUsers" },
        ],
        ...(dimensionFilter && { dimensionFilter }),
      },
    });
    const row = res.data.rows?.[0];
    if (!row) return null;
    const vals = row.metricValues!.map(v => v.value!);
    return {
      activeUsers: parseInt(vals[0]),
      sessions: parseInt(vals[1]),
      pageviews: parseInt(vals[2]),
      avgSessionDuration: parseFloat(vals[3]),
      bounceRate: parseFloat(vals[4]),
      newUsers: parseInt(vals[5]),
    };
  } catch (e: any) {
    console.error("[analytics] GA4 overview error:", e.message);
    return null;
  }
}

export async function fetchGA4Daily(startDate: string, endDate: string, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" } }],
        ...(df && { dimensionFilter: df }),
      },
    });
    return (res.data.rows || []).map(row => ({
      date: row.dimensionValues![0].value!.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
      users: parseInt(row.metricValues![0].value!),
      sessions: parseInt(row.metricValues![1].value!),
      pageviews: parseInt(row.metricValues![2].value!),
    }));
  } catch (e: any) {
    console.error("[analytics] GA4 daily error:", e.message);
    return [];
  }
}

export async function fetchGA4TopPages(startDate: string, endDate: string, limit = 20, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit,
        ...(df && { dimensionFilter: df }),
      },
    });
    return (res.data.rows || []).map(row => ({
      path: row.dimensionValues![0].value!,
      pageviews: parseInt(row.metricValues![0].value!),
      users: parseInt(row.metricValues![1].value!),
    }));
  } catch (e: any) {
    console.error("[analytics] GA4 top pages error:", e.message);
    return [];
  }
}

export async function fetchGA4Sources(startDate: string, endDate: string, limit = 10, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit,
        ...(df && { dimensionFilter: df }),
      },
    });
    return (res.data.rows || []).map(row => ({
      channel: row.dimensionValues![0].value!,
      sessions: parseInt(row.metricValues![0].value!),
      users: parseInt(row.metricValues![1].value!),
    }));
  } catch (e: any) {
    console.error("[analytics] GA4 sources error:", e.message);
    return [];
  }
}

export async function fetchGA4Countries(startDate: string, endDate: string, limit = 10, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit,
        ...(df && { dimensionFilter: df }),
      },
    });
    return (res.data.rows || []).map(row => ({
      country: row.dimensionValues![0].value!,
      users: parseInt(row.metricValues![0].value!),
    }));
  } catch (e: any) {
    console.error("[analytics] GA4 countries error:", e.message);
    return [];
  }
}


export async function fetchGA4Regions(startDate: string, endDate: string, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }, { name: "sessions" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: 250,
        ...(df && { dimensionFilter: df }),
      },
    });
    const regionMap: Record<string, { users: number; sessions: number }> = {
      "Americas": { users: 0, sessions: 0 },
      "UK & Europe": { users: 0, sessions: 0 },
      "Australia/NZ/Pacific": { users: 0, sessions: 0 },
      "Asia": { users: 0, sessions: 0 },
      "Middle East": { users: 0, sessions: 0 },
      "Africa": { users: 0, sessions: 0 },
    };
    // Americas = North, Central, South America + Caribbean
    const AMERICAS = new Set([
      // North America
      "United States", "Canada", "Mexico",
      // Central America
      "Guatemala", "Belize", "El Salvador", "Honduras", "Nicaragua", "Costa Rica", "Panama",
      // Caribbean
      "Cuba", "Jamaica", "Haiti", "Dominican Republic", "Bahamas", "Barbados", "Trinidad and Tobago",
      "Puerto Rico", "Cayman Islands", "Bermuda", "Aruba", "Curacao", "Cura\u00e7ao",
      "Saint Lucia", "Grenada", "Dominica", "Antigua and Barbuda", "Saint Kitts and Nevis",
      "Saint Vincent and the Grenadines", "Martinique", "Guadeloupe", "British Virgin Islands",
      "U.S. Virgin Islands", "Turks and Caicos Islands", "Anguilla", "Montserrat", "Sint Maarten", "Saint Martin",
      // South America
      "Brazil", "Argentina", "Chile", "Colombia", "Peru", "Venezuela", "Ecuador", "Bolivia",
      "Paraguay", "Uruguay", "Guyana", "Suriname", "French Guiana", "Falkland Islands",
    ]);
    // Australia/NZ/Pacific = ANZ + all Pacific Islands
    const ANZ_PAC = new Set([
      "Australia", "New Zealand",
      "Fiji", "Papua New Guinea", "Samoa", "Tonga", "Vanuatu", "Solomon Islands", "New Caledonia",
      "French Polynesia", "Cook Islands", "Kiribati", "Micronesia", "Palau", "Marshall Islands", "Nauru", "Tuvalu",
      "Niue", "Tokelau", "American Samoa", "Guam", "Northern Mariana Islands", "Wallis and Futuna",
      "Pitcairn Islands", "Norfolk Island", "Christmas Island", "Cocos (Keeling) Islands",
    ]);
    // Asia = East, South, Southeast, Central Asia (Middle East handled separately)
    const ASIA = new Set([
      // East Asia
      "China", "Japan", "South Korea", "North Korea", "Mongolia", "Taiwan", "Hong Kong", "Macau", "Macao",
      // South Asia
      "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Bhutan", "Maldives", "Afghanistan",
      // Southeast Asia
      "Indonesia", "Thailand", "Vietnam", "Philippines", "Malaysia", "Singapore", "Myanmar", "Cambodia",
      "Laos", "Brunei", "Timor-Leste", "East Timor",
      // Central Asia
      "Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan",
    ]);
    // Middle East = Arab states + Iran, Israel, Turkey
    const MIDDLE_EAST = new Set([
      "United Arab Emirates", "Saudi Arabia", "Israel", "Turkey", "T\u00fcrkiye", "Iran", "Iraq",
      "Qatar", "Kuwait", "Oman", "Bahrain", "Yemen", "Jordan", "Lebanon", "Syria", "Palestine",
    ]);
    // UK & Europe = all European countries (EU, non-EU, Caucasus)
    const UK_EU = new Set([
      // UK + EU + Scandinavia + Iceland
      "United Kingdom", "Germany", "France", "Italy", "Spain", "Netherlands", "Belgium", "Sweden",
      "Norway", "Denmark", "Finland", "Austria", "Switzerland", "Ireland", "Poland", "Portugal",
      "Greece", "Czechia", "Czech Republic", "Romania", "Hungary", "Croatia", "Slovakia", "Slovenia",
      "Bulgaria", "Lithuania", "Latvia", "Estonia", "Luxembourg", "Malta", "Cyprus", "Iceland",
      // Non-EU Europe
      "Russia", "Ukraine", "Belarus", "Moldova", "Serbia", "Montenegro", "Bosnia and Herzegovina",
      "North Macedonia", "Macedonia", "Albania", "Kosovo", "Andorra", "Monaco", "San Marino", "Vatican City",
      "Liechtenstein",
      // Caucasus — European/European-adjacent
      "Georgia", "Armenia", "Azerbaijan",
      // British/French overseas territories geographically in Europe
      "Gibraltar", "Isle of Man", "Jersey", "Guernsey", "Faroe Islands", "Greenland",
    ]);
    // Africa = entire continent
    const AFRICA = new Set([
      "South Africa", "Nigeria", "Kenya", "Egypt", "Morocco", "Ghana", "Ethiopia", "Tanzania", "Uganda",
      "Algeria", "Tunisia", "Libya", "Sudan", "South Sudan", "Senegal", "C\u00f4te d\u2019Ivoire", "Ivory Coast",
      "Cameroon", "Angola", "Mozambique", "Zambia", "Zimbabwe", "Botswana", "Namibia", "Madagascar",
      "Mauritius", "Rwanda", "Burundi", "Somalia", "Eritrea", "Djibouti", "Mali", "Burkina Faso",
      "Niger", "Chad", "Central African Republic", "Republic of the Congo", "Congo - Brazzaville", "Congo",
      "Democratic Republic of the Congo", "Congo - Kinshasa", "Gabon", "Equatorial Guinea",
      "S\u00e3o Tom\u00e9 & Pr\u00edncipe", "Sao Tome and Principe", "Gambia", "Guinea", "Guinea-Bissau",
      "Sierra Leone", "Liberia", "Togo", "Benin", "Lesotho", "Eswatini", "Swaziland", "Malawi",
      "Comoros", "Cape Verde", "Cabo Verde", "Seychelles", "Mauritania", "Reunion", "R\u00e9union",
      "Western Sahara", "Mayotte", "Saint Helena",
    ]);
    for (const row of res.data.rows || []) {
      const country = row.dimensionValues![0].value!;
      const users = parseInt(row.metricValues![0].value!);
      const sessions = parseInt(row.metricValues![1].value!);
      let region: string | null = null;
      if (AMERICAS.has(country)) region = "Americas";
      else if (ANZ_PAC.has(country)) region = "Australia/NZ/Pacific";
      else if (ASIA.has(country)) region = "Asia";
      else if (MIDDLE_EAST.has(country)) region = "Middle East";
      else if (UK_EU.has(country)) region = "UK & Europe";
      else if (AFRICA.has(country)) region = "Africa";
      else {
        if (!(globalThis as any).__loggedUnknownCountries) (globalThis as any).__loggedUnknownCountries = new Set();
        const logged = (globalThis as any).__loggedUnknownCountries as Set<string>;
        if (!logged.has(country)) {
          logged.add(country);
          console.log(`[analytics] Unmapped country in regions: "${country}" — falling back to UK & Europe`);
        }
        region = "UK & Europe";
      }
      regionMap[region].users += users;
      regionMap[region].sessions += sessions;
    }
    return Object.entries(regionMap).map(([region, data]) => ({ region, ...data })).sort((a, b) => b.users - a.users);
  } catch (e: any) {
    console.error("[analytics] GA4 regions error:", e.message);
    return [];
  }
}

// ─── GA4 Devices ─────────────────────────────────────────────────────────────

export async function fetchGA4Devices(startDate: string, endDate: string, excludeCountries?: string[]) {
  const a = getAuth();
  if (!a) return [];
  try {
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: a });
    const df = buildCountryExclusionFilter(excludeCountries);
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY()}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "deviceCategory" }],
        metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        ...(df && { dimensionFilter: df }),
      },
    });
    return (res.data.rows || []).map(row => ({
      device: row.dimensionValues![0].value!,
      users: parseInt(row.metricValues![0].value!),
      sessions: parseInt(row.metricValues![1].value!),
      pageviews: parseInt(row.metricValues![2].value!),
    }));
  } catch (e: any) {
    console.error("[analytics] GA4 devices error:", e.message);
    return [];
  }
}

// ─── Search Console ──────────────────────────────────────────────────────────

export async function fetchSCQueries(startDate: string, endDate: string, limit = 20) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: limit,
        type: "web",
      },
    });
    return (res.data.rows || []).map(row => ({
      query: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
  } catch (e: any) {
    console.error("[analytics] SC queries error:", e.message);
    return [];
  }
}

// Top SC queries that contain a brand keyword, filtered server-side. Returns clicks/impressions/ctr/position.
export async function fetchSCQueriesForBrand(startDate: string, endDate: string, brand: string, limit = 25) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: 25000,
        type: "web",
        dimensionFilterGroups: [{
          filters: [{ dimension: "query", operator: "contains", expression: brand.toLowerCase() }],
        }],
      },
    });
    const rows = (res.data.rows || []).map(row => ({
      query: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
    rows.sort((a, b) => b.impressions - a.impressions);
    return rows.slice(0, limit);
  } catch (e: any) {
    console.error("[analytics] SC brand queries error:", e.message);
    return [];
  }
}

export async function fetchSCPages(startDate: string, endDate: string, limit = 20) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["page"],
        rowLimit: limit,
        type: "web",
      },
    });
    return (res.data.rows || []).map(row => ({
      page: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
  } catch (e: any) {
    console.error("[analytics] SC pages error:", e.message);
    return [];
  }
}

export async function fetchSCDaily(startDate: string, endDate: string) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["date"],
        type: "web",
      },
    });
    return (res.data.rows || []).map(row => ({
      date: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
  } catch (e: any) {
    console.error("[analytics] SC daily error:", e.message);
    return [];
  }
}

export async function fetchSCDevices(startDate: string, endDate: string) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["device"],
        type: "web",
      },
    });
    return (res.data.rows || []).map(row => ({
      device: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
  } catch (e: any) {
    console.error("[analytics] SC devices error:", e.message);
    return [];
  }
}

export async function fetchSCSearchAppearance(startDate: string, endDate: string) {
  const a = getAuth();
  if (!a) return [];
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        dimensions: ["searchAppearance"],
        type: "web",
      },
    });
    return (res.data.rows || []).map(row => ({
      appearance: row.keys![0],
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    }));
  } catch (e: any) {
    console.error("[analytics] SC search appearance error:", e.message);
    return [];
  }
}

// Fetch SC stats for a specific search type (image, video, news, discover)
export async function fetchSCByType(startDate: string, endDate: string, searchType: string) {
  const a = getAuth();
  if (!a) return null;
  try {
    const searchconsole = google.searchconsole({ version: "v1", auth: a });
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE(),
      requestBody: {
        startDate,
        endDate,
        type: searchType,
      },
    });
    const row = res.data.rows?.[0];
    if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    return {
      clicks: row.clicks!,
      impressions: row.impressions!,
      ctr: row.ctr!,
      position: row.position!,
    };
  } catch (e: any) {
    // Some types may not be available for all properties
    console.error(`[analytics] SC ${searchType} error:`, e.message);
    return null;
  }
}

export async function fetchSCSearchTypes(startDate: string, endDate: string) {
  const types = ["web", "image", "news", "discover"];
  const results = await Promise.all(
    types.map(async (t) => {
      const data = await fetchSCByType(startDate, endDate, t);
      return data ? { type: t, ...data } : null;
    })
  );
  return results.filter(Boolean);
}
