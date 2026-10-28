import { fetchRegionalJson } from './http.js';

// One YouTube live search costs 100 quota units against the default 10,000
// units/day. The cap and the long per-place cache keep a user who pans around
// the globe from spending the whole day's quota in a few minutes.
export const SEARCH_COST_UNITS = 100;
const DEFAULT_DAILY_SEARCH_LIMIT = 80;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 120;
const MAX_VIDEOS = 3;

const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

function configured(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function youtubeVideoId(value) {
  const id = String(value || '');
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** A live-search query led by the most specific place name available. */
export function buildYouTubeLiveQuery(place) {
  const locality = cleanText(place?.locality, 60);
  const region = cleanText(place?.region, 60);
  const country = cleanText(place?.country, 60);
  const lead =
    [locality, country].filter(Boolean).join(' ') ||
    region ||
    country ||
    'world';
  return `${lead} news live`.slice(0, 120);
}

/**
 * Keep only embeddable live videos with a syntactically valid id. The API is
 * asked for live, embeddable results, but the response is still treated as
 * untrusted input before any id reaches an iframe.
 */
export function normalizeYouTubeLiveVideos(payload, limit = MAX_VIDEOS) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const seen = new Set();
  const videos = [];
  for (const item of items) {
    const videoId = youtubeVideoId(item?.id?.videoId ?? item?.videoId);
    if (!videoId || seen.has(videoId)) continue;
    const title = cleanText(item?.snippet?.title);
    if (!title) continue;
    seen.add(videoId);
    const publishedMs = Date.parse(item?.snippet?.publishedAt);
    videos.push({
      videoId,
      title,
      channel: cleanText(item?.snippet?.channelTitle, 80) || 'YouTube live',
      publishedAt: Number.isFinite(publishedMs)
        ? new Date(publishedMs).toISOString()
        : null,
    });
    if (videos.length >= Math.max(1, limit)) break;
  }
  return videos;
}

function regionCodeFor(place) {
  const code = cleanText(place?.countryCode, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function cacheKeyFor(place) {
  return (
    [place?.countryCode, place?.locality, place?.region, place?.country]
      .map((value) => cleanText(value, 60).toLowerCase())
      .filter(Boolean)
      .join('|') || 'world'
  );
}

function dailyLimitFrom(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_DAILY_SEARCH_LIMIT;
}

/**
 * Build a provider around one API key. `fetchJson`, `now` and the quota are
 * injectable so the cache and budget behaviour can be tested without network.
 */
export function createNewsVideoProvider({
  apiKey = configured('YOUTUBE_API_KEY'),
  fetchJson = fetchRegionalJson,
  now = () => Date.now(),
  dailySearchLimit = dailyLimitFrom(process.env.GEV_NEWS_VIDEO_DAILY_SEARCHES),
} = {}) {
  const cache = new Map();
  let quotaDay = '';
  let searchesToday = 0;

  function takeQuota() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== quotaDay) {
      quotaDay = day;
      searchesToday = 0;
    }
    if (searchesToday >= dailySearchLimit) return false;
    searchesToday += 1;
    return true;
  }

  function trimCache() {
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function fetchForPlace(place) {
    if (!apiKey) {
      return { status: 'unconfigured', query: null, source: null, videos: [] };
    }
    const query = buildYouTubeLiveQuery(place);
    const key = cacheKeyFor(place);
    const cached = cache.get(key);
    if (cached && now() - cached.cachedAt <= CACHE_TTL_MS) {
      return { ...cached.result, cached: true };
    }
    if (!takeQuota()) {
      return { status: 'quota', query, source: null, videos: [] };
    }

    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      eventType: 'live',
      videoEmbeddable: 'true',
      maxResults: '5',
      q: query,
      relevanceLanguage: 'en',
      key: apiKey,
    });
    const regionCode = regionCodeFor(place);
    if (regionCode) params.set('regionCode', regionCode);

    let result;
    try {
      const payload = await fetchJson(`${YOUTUBE_SEARCH_ENDPOINT}?${params}`, {
        headers: { 'User-Agent': 'gods-eye-view-regional-news-video/1.0' },
        timeoutMs: 9000,
        redirect: 'error',
      });
      const videos = normalizeYouTubeLiveVideos(payload);
      result = {
        status: videos.length ? 'ready' : 'empty',
        query,
        source: videos.length ? 'YouTube Data API' : null,
        videos,
      };
    } catch {
      // A missing live stream must never break the briefing; the client falls
      // back to its curated channels and poster surface.
      result = { status: 'error', query, source: null, videos: [] };
    }
    cache.set(key, { result, cachedAt: now() });
    trimCache();
    return result;
  }

  return {
    fetchForPlace,
    getSearchesToday: () => searchesToday,
  };
}

let sharedProvider = null;

/** Resolve location-matched live videos through the process-wide provider. */
export function fetchRegionalNewsVideo(place) {
  sharedProvider ??= createNewsVideoProvider();
  return sharedProvider.fetchForPlace(place);
}

/** Test hook: drop the shared provider (and its cache/quota counters). */
export function resetNewsVideoProviderForTests() {
  sharedProvider = null;
}
