import * as Cesium from 'cesium';
import { embeddedMediaFrameUrl } from '../data/bhoteKoshiEmbeddedMedia.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { isSurfacePick, pickGroundPosition } from '../data/scenePick.js';

/**
 * Three live casts, one per trending story, pinned to the top, left and
 * right of the globe. Each cast can be dragged and minimized; both survive a
 * reload. The feed follows the camera and replaces itself with the next
 * location.
 */

const REFRESH_MS = 60_000;
const MOVE_SETTLE_MS = 450;
const FOLLOW_MIN_DISTANCE_M = 35_000;
// At world-view heights there is no meaningful "current locality" under the
// camera centre, and every tiny rotation would cross a city. Above this the
// casts keep reporting the last place the user actually looked at.
const FOLLOW_MAX_CAMERA_HEIGHT_M = 2_000_000;
const CAST_COUNT = 3;
const EARTH_RADIUS_M = 6_371_000;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CAST_LAYOUT_KEY = 'gev.news-casts.v1';
const CAST_MARGIN_PX = 8;

/**
 * Public 24/7 broadcasts used when the location-matched live search returns no
 * embeddable stream (or the YouTube key is not configured). They are addressed
 * by channel rather than by video ID so the embed always resolves whatever is
 * on air now instead of a fixed stream that later turns private. The chip names
 * the channel so a world feed is never mistaken for a local one.
 */
export const WORLD_LIVE_CHANNELS = Object.freeze([
  { channelId: 'UCoMdktPbSTixAyNGwb-UYkQ', name: 'SKY NEWS' },
  { channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg', name: 'AL JAZEERA' },
  { channelId: 'UCQfwfsi5VrQ8yKZ-UWmAEFg', name: 'FRANCE 24' },
]);

const CAST_LAYOUT = Object.freeze(['top', 'left', 'right']);

function cleanText(value, maxLength = 180) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function safeImageUrl(value) {
  const href = safeHttpUrl(value);
  return href && href.startsWith('https://') ? href : null;
}

/** Relative age copy for one story link. */
export function articleAge(value) {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'live';
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function cleanArticle(row) {
  const title = cleanText(row?.title, 220);
  const url = safeHttpUrl(row?.url);
  if (!title || !url) return null;
  const publishedMs = Date.parse(row?.publishedAt);
  return {
    title,
    url,
    domain: cleanText(row?.domain, 80) || new URL(url).hostname,
    publishedAt: Number.isFinite(publishedMs)
      ? new Date(publishedMs).toISOString()
      : null,
    image: safeImageUrl(row?.image),
  };
}

/**
 * Top three unique stories, local first and worldwide only as a fill. The
 * server marks URLs as untrusted input, so every row is validated again before
 * it can become a link.
 */
export function mergeCastArticles(local, global, limit = CAST_COUNT) {
  const merged = [];
  const seen = new Set();
  for (const row of [
    ...(Array.isArray(local) ? local : []),
    ...(Array.isArray(global) ? global : []),
  ]) {
    const article = cleanArticle(row);
    if (!article) continue;
    const signature = `${article.title.toLowerCase()}|${new URL(article.url).hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(article);
    if (merged.length >= Math.max(1, limit)) break;
  }
  return merged;
}

/** One location-matched live stream, or null when the payload row is not one. */
export function resolveCastVideo(videos, index) {
  const video = Array.isArray(videos) ? videos[index] : null;
  const id = String(video?.videoId || '');
  if (!YOUTUBE_VIDEO_ID.test(id)) return null;
  return {
    id,
    title: cleanText(video?.title, 180),
    channel: cleanText(video?.channel, 80),
  };
}

/** Video plan for one cast: a local live stream, else a named world channel. */
export function buildCastVideo(videos, index) {
  const live = resolveCastVideo(videos, index);
  if (live) {
    return {
      kind: 'live',
      id: live.id,
      title: live.title || 'Location live video',
      label: live.channel
        ? `LIVE · ${live.channel.toUpperCase()}`
        : 'LIVE FEED',
    };
  }
  const channel = WORLD_LIVE_CHANNELS[index % WORLD_LIVE_CHANNELS.length];
  return {
    kind: 'world',
    channelId: channel.channelId,
    title: `${channel.name} live`,
    label: `WORLD LIVE · ${channel.name}`,
  };
}

/**
 * Keep a dragged cast on screen: inside the viewport where it fits, otherwise
 * flush against the margin so its header (and the grab area) stays reachable.
 */
export function clampCastPosition({
  left,
  top,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = CAST_MARGIN_PX,
}) {
  if (
    ![left, top, width, height, viewportWidth, viewportHeight].every(
      Number.isFinite,
    )
  )
    return null;
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const maxTop = Math.max(
    margin,
    viewportHeight - Math.min(height, viewportHeight) - margin,
  );
  return {
    left: Math.round(Math.min(Math.max(margin, left), maxLeft)),
    top: Math.round(Math.min(Math.max(margin, top), maxTop)),
  };
}

function storageState() {
  return globalThis.localStorage ?? null;
}

function readStoredCasts() {
  try {
    const parsed = JSON.parse(
      storageState()?.getItem(CAST_LAYOUT_KEY) || 'null',
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeStoredCasts(state) {
  try {
    storageState()?.setItem(CAST_LAYOUT_KEY, JSON.stringify(state));
  } catch {
    // Storage can be disabled or full; the layout still works for this session.
  }
}

function viewportSize() {
  return {
    width:
      Number(globalThis.innerWidth) ||
      Number(document?.documentElement?.clientWidth) ||
      1024,
    height:
      Number(globalThis.innerHeight) ||
      Number(document?.documentElement?.clientHeight) ||
      768,
  };
}

/** Great-circle distance; decides whether a camera move picked a new place. */
export function newsDistanceM(latitudeA, longitudeA, latitudeB, longitudeB) {
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite))
    return Number.POSITIVE_INFINITY;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(latitudeB - latitudeA);
  const dLon = toRad(longitudeB - longitudeA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latitudeA)) *
      Math.cos(toRad(latitudeB)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function placeLabelOf(brief) {
  const place = brief?.place;
  return cleanText(
    place?.label ||
      [place?.locality, place?.region].filter(Boolean).join(', ') ||
      place?.country,
    60,
  );
}

function pointFromWorldPosition(position) {
  if (!position) return null;
  try {
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    if (!cartographic) return null;
    const latitude = Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = Cesium.Math.toDegrees(cartographic.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

function createElement(tag, className, text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function buildCast(layout, index) {
  const card = createElement(
    'article',
    `news-cast news-cast--${layout} news-cast--rank-${index + 1}`,
  );
  card.setAttribute('aria-label', `Trending story ${index + 1}`);

  const header = createElement('header', 'news-cast__header');
  const grip = createElement('span', 'news-cast__grip');
  grip.setAttribute('aria-hidden', 'true');
  const live = createElement('span', 'news-cast__live');
  live.append(
    createElement('i', 'news-cast__rec'),
    createElement('span', null, 'LIVE'),
  );
  const place = createElement('span', 'news-cast__place', 'LOCATING…');
  const rank = createElement(
    'span',
    'news-cast__rank',
    index === 0 ? 'TOP STORY' : `TRENDING 0${index + 1}`,
  );
  const controls = createElement('div', 'news-cast__controls');
  const toggle = createElement('button', 'news-cast__control', '−');
  toggle.type = 'button';
  toggle.title = 'Minimize';
  toggle.setAttribute('aria-label', 'Minimize story');
  toggle.setAttribute('aria-expanded', 'true');
  controls.append(toggle);
  header.append(grip, live, place, rank, controls);

  const media = createElement('div', 'news-cast__media');
  const poster = createElement('img', 'news-cast__poster');
  poster.alt = '';
  poster.setAttribute('referrerpolicy', 'no-referrer');
  poster.setAttribute('loading', 'lazy');
  poster.hidden = true;
  const signal = createElement('div', 'news-cast__signal');
  const chip = createElement('span', 'news-cast__chip', 'LIVE FEED');
  const scan = createElement('span', 'news-cast__scan');
  scan.setAttribute('aria-hidden', 'true');
  media.append(poster, signal, chip, scan);

  const copy = createElement('div', 'news-cast__copy');
  const headline = createElement('a', 'news-cast__headline');
  headline.target = '_blank';
  headline.rel = 'noopener noreferrer';
  const meta = createElement('div', 'news-cast__meta');
  const source = createElement('span', 'news-cast__source', 'AWAITING UPLINK');
  const age = createElement('span', 'news-cast__age');
  meta.append(source, age);
  copy.append(headline, meta);

  card.append(header, media, copy);
  return {
    card,
    header,
    toggle,
    place,
    media,
    poster,
    chip,
    headline,
    source,
    age,
    videoKey: null,
    posterKey: null,
    iframe: null,
  };
}

/**
 * Mount the three live casts and keep them pointed at the camera's location.
 *
 * @param {object} options
 * @param {object} [options.viewer] Cesium viewer; camera moves and globe taps
 *   retarget the feed.
 * @param {{latitude: number, longitude: number}} options.location Starting point.
 * @param {Function} options.fetchBrief Regional brief request
 *   `(latitude, longitude, { preferences, signal })`.
 * @param {AbortSignal} [options.signal] Page lifetime.
 */
export function initLocationNewsFeed({
  viewer = null,
  location = { latitude: 30.2672, longitude: -97.7431 },
  fetchBrief,
  signal,
} = {}) {
  if (
    !Number.isFinite(location?.latitude) ||
    !Number.isFinite(location?.longitude) ||
    typeof fetchBrief !== 'function' ||
    typeof document === 'undefined'
  ) {
    return { destroy() {} };
  }

  let destroyed = false;
  let requestController = null;
  let refreshTimer = null;
  let settleTimer = null;
  let currentPoint = {
    latitude: location.latitude,
    longitude: location.longitude,
  };
  let articles = [];
  let videos = [];
  let placeLabel = '';

  const root = createElement('section', 'news-cast-hud');
  root.setAttribute('aria-label', 'Live location news');
  const casts = CAST_LAYOUT.map((layout, index) => {
    const cast = buildCast(layout, index);
    root.append(cast.card);
    return cast;
  });
  document.body.append(root);

  const storedLayout = readStoredCasts();
  const dragCleanups = [];

  function persistLayout() {
    writeStoredCasts(storedLayout);
  }

  function applyPosition(cast, layout, left, top) {
    cast.card.style.left = `${left}px`;
    cast.card.style.top = `${top}px`;
    cast.card.style.right = 'auto';
    cast.card.style.transform = 'none';
    cast.card.classList.add('is-placed');
    storedLayout[layout] = { ...(storedLayout[layout] || {}), left, top };
  }

  function setMinimized(cast, layout, minimized) {
    cast.card.classList.toggle('is-minimized', minimized);
    cast.toggle.textContent = minimized ? '+' : '−';
    cast.toggle.title = minimized ? 'Expand' : 'Minimize';
    cast.toggle.setAttribute(
      'aria-label',
      minimized ? 'Expand story' : 'Minimize story',
    );
    cast.toggle.setAttribute('aria-expanded', minimized ? 'false' : 'true');
    storedLayout[layout] = { ...(storedLayout[layout] || {}), minimized };
    persistLayout();
  }

  function attachDrag(cast, layout) {
    let drag = null;

    const finish = (event) => {
      if (!drag) return;
      drag = null;
      cast.card.classList.remove('is-dragging');
      cast.header.releasePointerCapture?.(event?.pointerId);
      persistLayout();
    };

    const onPointerDown = (event) => {
      if (destroyed || (event.button != null && event.button !== 0)) return;
      if (event.target?.closest?.('button, a')) return;
      const rect = cast.card.getBoundingClientRect?.();
      const left = Number(rect?.left);
      const top = Number(rect?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      drag = {
        pointerId: event.pointerId,
        startX: Number(event.clientX),
        startY: Number(event.clientY),
        left,
        top,
        width: Number(rect.width) || cast.card.offsetWidth || 288,
        height: Number(rect.height) || cast.card.offsetHeight || 220,
      };
      cast.card.classList.add('is-dragging');
      cast.header.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    };

    const onPointerMove = (event) => {
      if (!drag || destroyed || event.pointerId !== drag.pointerId) return;
      const { width: viewportWidth, height: viewportHeight } = viewportSize();
      const next = clampCastPosition({
        left: drag.left + (Number(event.clientX) - drag.startX),
        top: drag.top + (Number(event.clientY) - drag.startY),
        width: drag.width,
        height: drag.height,
        viewportWidth,
        viewportHeight,
      });
      if (next) applyPosition(cast, layout, next.left, next.top);
      event.preventDefault?.();
    };

    const onToggle = (event) => {
      event.stopPropagation?.();
      setMinimized(cast, layout, !cast.card.classList.contains('is-minimized'));
      globalThis.requestAnimationFrame?.(() => clampPlacedCasts());
    };

    cast.header.addEventListener('pointerdown', onPointerDown);
    cast.toggle.addEventListener('click', onToggle);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    dragCleanups.push(() => {
      cast.header.removeEventListener('pointerdown', onPointerDown);
      cast.toggle.removeEventListener('click', onToggle);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    });
  }

  // Restore a previous session's drag and collapse choices before first paint.
  for (const [index, cast] of casts.entries()) {
    const layout = CAST_LAYOUT[index];
    attachDrag(cast, layout);
    const saved = storedLayout[layout];
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top))
      applyPosition(cast, layout, saved.left, saved.top);
    if (saved?.minimized === true) setMinimized(cast, layout, true);
  }

  function clampPlacedCasts() {
    if (destroyed) return;
    const { width: viewportWidth, height: viewportHeight } = viewportSize();
    for (const [index, cast] of casts.entries()) {
      if (!cast.card.classList.contains('is-placed')) continue;
      const rect = cast.card.getBoundingClientRect?.();
      const left = Number(rect?.left);
      const top = Number(rect?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      const next = clampCastPosition({
        left,
        top,
        width: Number(rect.width) || cast.card.offsetWidth || 288,
        height: Number(rect.height) || cast.card.offsetHeight || 220,
        viewportWidth,
        viewportHeight,
      });
      if (next) applyPosition(cast, CAST_LAYOUT[index], next.left, next.top);
    }
    persistLayout();
  }

  globalThis.addEventListener?.('resize', clampPlacedCasts);
  globalThis.requestAnimationFrame?.(() => clampPlacedCasts());

  function setPlaceLabel(value) {
    const label = value || 'GLOBAL FEED';
    placeLabel = label;
    for (const cast of casts) cast.place.textContent = label;
  }

  function renderMedia(cast, index, article) {
    const plan = buildCastVideo(videos, index);
    cast.chip.textContent = plan.label;
    cast.chip.title = plan.title;
    const key =
      plan.kind === 'world' ? `world:${plan.channelId}` : `live:${plan.id}`;
    if (cast.videoKey !== key) {
      cast.videoKey = key;
      cast.media.classList.remove('is-playable');
      cast.iframe?.remove();
      const source =
        plan.kind === 'world'
          ? { provider: 'youtube', channelId: plan.channelId }
          : { provider: 'youtube', id: plan.id };
      const iframe = createElement('iframe', 'news-cast__frame');
      iframe.src = embeddedMediaFrameUrl(source, { autoplay: true });
      iframe.title = plan.title;
      iframe.setAttribute(
        'allow',
        'autoplay; encrypted-media; picture-in-picture; fullscreen',
      );
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.addEventListener(
        'load',
        () => {
          if (!destroyed && cast.videoKey === key)
            cast.media.classList.add('is-playable');
        },
        { once: true },
      );
      cast.iframe = iframe;
      cast.media.append(iframe);
    }
    const posterUrl = article?.image || null;
    if (cast.posterKey !== posterUrl) {
      cast.posterKey = posterUrl;
      if (posterUrl) {
        cast.poster.src = posterUrl;
        cast.poster.hidden = false;
      } else {
        cast.poster.removeAttribute('src');
        cast.poster.hidden = true;
      }
    }
  }

  function renderCast(cast, index) {
    const article = articles[index] || null;
    if (article) {
      cast.headline.textContent = article.title;
      cast.headline.href = article.url;
      cast.headline.classList.remove('is-placeholder');
      cast.source.textContent = article.domain || 'News source';
      cast.age.textContent = articleAge(article.publishedAt);
    } else {
      cast.headline.removeAttribute('href');
      cast.headline.textContent = placeLabel
        ? `Scanning ${placeLabel} for live reports…`
        : 'Acquiring location feed…';
      cast.headline.classList.add('is-placeholder');
      cast.source.textContent = 'AWAITING UPLINK';
      cast.age.textContent = '';
    }
    renderMedia(cast, index, article);
    cast.card.dataset.hasStory = article ? 'true' : 'false';
  }

  function render() {
    for (const [index, cast] of casts.entries()) renderCast(cast, index);
  }

  async function refresh() {
    if (destroyed || document.hidden) return;
    requestController?.abort();
    requestController = new AbortController();
    const { signal: requestSignal } = requestController;
    root.dataset.status = 'loading';
    try {
      const local = await fetchBrief(
        currentPoint.latitude,
        currentPoint.longitude,
        {
          preferences: { scope: 'local', language: 'en' },
          signal: requestSignal,
        },
      );
      if (destroyed || requestSignal.aborted) return;
      let globalArticles = [];
      if (
        (Array.isArray(local?.articles) ? local.articles : []).length <
        CAST_COUNT
      ) {
        try {
          const global = await fetchBrief(
            currentPoint.latitude,
            currentPoint.longitude,
            {
              preferences: {
                scope: 'global',
                topics: 'breaking news, international news',
                language: 'en',
              },
              signal: requestSignal,
            },
          );
          if (destroyed || requestSignal.aborted) return;
          globalArticles = global?.articles;
        } catch (error) {
          if (destroyed || error?.name === 'AbortError') return;
          // Local stories already arrived; a failed worldwide fill must not
          // discard them.
        }
      }
      articles = mergeCastArticles(local?.articles, globalArticles);
      videos = Array.isArray(local?.newsVideo?.videos)
        ? local.newsVideo.videos
        : [];
      setPlaceLabel(placeLabelOf(local));
      render();
      root.dataset.status = 'ready';
    } catch (error) {
      if (!destroyed && error?.name !== 'AbortError') {
        root.dataset.status = 'standby';
      }
    }
  }

  function follow(point, force) {
    if (
      !force &&
      newsDistanceM(
        currentPoint.latitude,
        currentPoint.longitude,
        point.latitude,
        point.longitude,
      ) < FOLLOW_MIN_DISTANCE_M
    )
      return;
    currentPoint = point;
    if (settleTimer != null) globalThis.clearTimeout(settleTimer);
    settleTimer = globalThis.setTimeout(() => {
      settleTimer = null;
      void refresh();
    }, MOVE_SETTLE_MS);
    settleTimer?.unref?.();
  }

  function followFromCamera() {
    const camera = viewer?.camera;
    const height = camera?.positionCartographic?.height;
    if (!Number.isFinite(height) || height > FOLLOW_MAX_CAMERA_HEIGHT_M) return;
    const canvas = viewer?.scene?.canvas;
    const width = canvas?.clientWidth;
    const canvasHeight = canvas?.clientHeight;
    if (!width || !canvasHeight) return;
    const point = pointFromWorldPosition(
      pickGroundPosition(viewer, { x: width / 2, y: canvasHeight / 2 }),
    );
    if (point) follow(point, false);
  }

  const onGlobeClick = (event) => {
    if (destroyed || !isPointerFree()) return;
    const canvas = viewer?.scene?.canvas;
    if (!canvas?.getBoundingClientRect) return;
    const bounds = canvas.getBoundingClientRect();
    const position = {
      x: event.clientX - (bounds?.left || 0),
      y: event.clientY - (bounds?.top || 0),
    };
    let picked = null;
    try {
      picked = viewer.scene.pick?.(position) ?? null;
    } catch {
      picked = null;
    }
    if (!isSurfacePick(picked)) return;
    const point = pointFromWorldPosition(pickGroundPosition(viewer, position));
    if (point) follow(point, true);
  };

  const onVisibilityChange = () => {
    if (!document.hidden) void refresh();
  };

  const removeMoveEnd =
    viewer?.camera?.moveEnd?.addEventListener?.(() => followFromCamera()) ??
    null;
  viewer?.scene?.canvas?.addEventListener?.('click', onGlobeClick);
  document.addEventListener('visibilitychange', onVisibilityChange);
  signal?.addEventListener('abort', () => destroy(), { once: true });

  setPlaceLabel('');
  render();
  void refresh();
  refreshTimer = globalThis.setInterval(() => {
    if (!document.hidden) void refresh();
  }, REFRESH_MS);
  refreshTimer?.unref?.();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    requestController?.abort();
    if (refreshTimer != null) globalThis.clearInterval(refreshTimer);
    if (settleTimer != null) globalThis.clearTimeout(settleTimer);
    refreshTimer = settleTimer = null;
    removeMoveEnd?.();
    viewer?.scene?.canvas?.removeEventListener?.('click', onGlobeClick);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    globalThis.removeEventListener?.('resize', clampPlacedCasts);
    for (const cleanup of dragCleanups) cleanup();
    dragCleanups.length = 0;
    root.remove();
  }

  return {
    destroy,
    refresh,
    getActiveArticles: () => articles.map((article) => ({ ...article })),
    getLocation: () => ({ ...currentPoint }),
    getCasts: () =>
      casts.map((cast) => ({
        videoKey: cast.videoKey,
        posterKey: cast.posterKey,
      })),
  };
}
