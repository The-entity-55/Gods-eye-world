import { fetchRegionalText, fetchRegionalJson } from './http.js';
import { normalizeRegionalArticles } from '../../../src/data/regionalModel.js';

const MAX_ARTICLES = 8;

function configured(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanText(value, maxLength = 180) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeArticle(row) {
  const title = cleanText(row?.title || row?.name);
  const url = String(row?.url || row?.link || '').trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!title || !['http:', 'https:'].includes(parsed.protocol)) return null;
  const date = row?.publishedAt || row?.published_date || row?.date;
  const timestamp = Date.parse(date);
  return {
    title,
    url: parsed.href,
    domain: cleanText(
      row?.domain || row?.source || parsed.hostname.replace(/^www\./, ''),
      80,
    ),
    publishedAt: Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : null,
    image: safeImageUrl(
      row?.thumbnail ||
        row?.thumbnail_small ||
        row?.image ||
        row?.urlToImage ||
        row?.socialimage,
    ),
    sourceCountry: null,
  };
}

function normalizeSearchArticles(rows, limit = MAX_ARTICLES) {
  const seen = new Set();
  const articles = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const article = safeArticle(row);
    if (!article) continue;
    const signature = `${article.title.toLowerCase()}|${new URL(article.url).hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    articles.push(article);
    if (articles.length >= limit) break;
  }
  return articles;
}

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  return decodeRssText(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
      block,
    )?.[1] || '',
  );
}

function normalizeRssArticles(xml, limit = MAX_ARTICLES) {
  const rows = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    rows.push({
      title: rssTag(item, 'title'),
      url: rssTag(item, 'link'),
      source: rssTag(item, 'source'),
      publishedAt: rssTag(item, 'pubDate'),
    });
  }
  return normalizeSearchArticles(rows, limit);
}

function queryFor(place, preferences = {}) {
  if (preferences.scope === 'global') {
    return [
      'world news',
      ...(preferences.topics || []),
      ...(preferences.countries || []),
    ]
      .map((value) => cleanText(value, 60))
      .filter(Boolean)
      .join(' ')
      .slice(0, 300);
  }
  const locality = place?.locality || place?.region || place?.country;
  if (!locality) return null;
  return [
    locality,
    ...(preferences.topics || []),
    ...(preferences.countries || []),
  ]
    .map((value) => cleanText(value, 60))
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

function preferredCountry(place, preferences) {
  return (
    preferences?.countries?.[0] ||
    place?.countryCode ||
    'US'
  ).toUpperCase();
}

async function fetchSerpApiNews(query, place, preferences) {
  const apiKey = configured('SERPAPI_API_KEY');
  if (!apiKey) return null;
  const params = new URLSearchParams({
    engine: 'google_news',
    q: `${query} when:1d`,
    gl: preferredCountry(place, preferences).toLowerCase(),
    hl: preferences.language || 'en',
    so: '1',
    api_key: apiKey,
  });
  const payload = await fetchRegionalJson(
    `https://serpapi.com/search.json?${params}`,
    {
      headers: { 'User-Agent': 'gods-eye-view-regional-news/1.0' },
      timeoutMs: 12_000,
      redirect: 'error',
    },
  );
  return normalizeSearchArticles(payload?.news_results || payload?.local_news);
}

async function fetchTavilyNews(query, place, preferences) {
  const apiKey = configured('TAVILY_API_KEY');
  if (!apiKey) return null;
  const payload = await fetchRegionalJson('https://api.tavily.com/search', {
    method: 'POST',
    body: JSON.stringify({
      query,
      topic: 'news',
      search_depth: 'basic',
      max_results: MAX_ARTICLES,
      include_published_date: true,
      country: preferredCountry(place, preferences),
      language: preferences.language || 'en',
      filter_by_language: true,
      ...(preferences.domains?.length
        ? {
            include_domains: preferences.domains,
            include_domains_mode: 'restrict',
          }
        : {}),
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeoutMs: 12_000,
    redirect: 'error',
  });
  return normalizeSearchArticles(payload?.results);
}

async function fetchFirecrawlNews(query, place, preferences) {
  const apiKey = configured('FIRECRAWL_API_KEY');
  if (!apiKey) return null;
  const payload = await fetchRegionalJson(
    'https://api.firecrawl.dev/v2/search',
    {
      method: 'POST',
      body: JSON.stringify({
        query,
        limit: MAX_ARTICLES,
        sources: [{ type: 'news' }],
        location: place?.label || undefined,
        country: preferredCountry(place, preferences),
        ...(preferences.domains?.length
          ? { includeDomains: preferences.domains }
          : {}),
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: 12_000,
      redirect: 'error',
    },
  );
  return normalizeSearchArticles(payload?.data?.news || payload?.data?.web);
}

async function fetchGoogleRssNews(query, place, preferences) {
  const country = preferredCountry(place, preferences);
  const params = new URLSearchParams({
    q: query,
    hl: `${preferences.language || 'en'}-${country}`,
    gl: country,
    ceid: `${country}:${preferences.language || 'en'}`,
  });
  const xml = await fetchRegionalText(
    `https://news.google.com/rss/search?${params}`,
    {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    },
  );
  return normalizeRssArticles(xml);
}

async function fetchGdeltNews(query) {
  const params = new URLSearchParams({
    query: `"${query.replace(/["\\]/g, ' ')}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(MAX_ARTICLES),
    sort: 'datedesc',
    timespan: '24h',
  });
  const payload = await fetchRegionalJson(
    `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
    {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    },
  );
  return normalizeRegionalArticles(payload, MAX_ARTICLES);
}

/**
 * Resolve one location-aware news result set. Paid sources are attempted in a
 * news-specialist-first order and only until one returns articles, limiting
 * quota spend. Google RSS and GDELT keep the feature useful with no keys.
 */
async function fetchRegionalNews(place, preferences = {}) {
  const query = queryFor(place, preferences);
  if (!query)
    return { status: 'unavailable', query: null, articles: [], source: null };
  const sources = [
    ['SerpAPI Google News', fetchSerpApiNews],
    ['Tavily News', fetchTavilyNews],
    ['Firecrawl News', fetchFirecrawlNews],
    ['Google News RSS', fetchGoogleRssNews],
    ['GDELT fallback', fetchGdeltNews],
  ];
  for (const [source, fetchNews] of sources) {
    try {
      const articles = await fetchNews(query, place, preferences);
      if (articles?.length) return { status: 'ready', query, articles, source };
    } catch {
      // Try the next provider. Provider-specific errors and credentials never
      // reach the browser, which only receives source attribution on success.
    }
  }
  return { status: 'unavailable', query, articles: [], source: null };
}

export { fetchRegionalNews, normalizeSearchArticles, queryFor };
