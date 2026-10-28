import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  articleAge,
  buildCastVideo,
  clampCastPosition,
  initLocationNewsFeed,
  mergeCastArticles,
  newsDistanceM,
  WORLD_LIVE_CHANNELS,
} from './locationNewsFeed.js';

function mockElement(tag) {
  const classes = new Set();
  const listeners = new Map();
  const attributes = {};
  const element = {
    tagName: tag.toUpperCase(),
    className: '',
    children: [],
    parent: null,
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    attributes,
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
        element.className = [...classes].join(' ');
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name) {
        if (classes.has(name)) {
          classes.delete(name);
          element.className = [...classes].join(' ');
          return false;
        }
        classes.add(name);
        element.className = [...classes].join(' ');
        return true;
      },
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return attributes[name];
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parent = element;
        element.children.push(node);
      }
    },
    remove() {
      if (!element.parent) return;
      const index = element.parent.children.indexOf(element);
      if (index !== -1) element.parent.children.splice(index, 1);
      element.parent = null;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
  return element;
}

function installDocument() {
  const body = mockElement('body');
  const documentListeners = new Map();
  globalThis.document = {
    hidden: false,
    body,
    createElement: (tag) => mockElement(tag),
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = documentListeners.get(type);
      if (!list) return;
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    emit(type, event = {}) {
      for (const listener of [...(documentListeners.get(type) || [])])
        listener(event);
    },
    listenerCount(type) {
      return (documentListeners.get(type) || []).length;
    },
  };
  return body;
}

function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 15);
    };
    poll();
  });
}

test('merges local and worldwide rows into three safe unique stories', () => {
  const articles = mergeCastArticles(
    [
      {
        title: 'Austin council vote',
        url: 'https://news.example/austin',
        domain: 'News Example',
        publishedAt: '2026-10-28T10:00:00Z',
        image: 'http://cdn.example/austin.jpg',
      },
      { title: 'Unsafe', url: 'javascript:alert(1)' },
    ],
    [
      { title: 'World markets', url: 'https://news.example/world' },
      { title: 'Austin council vote', url: 'https://news.example/austin-copy' },
      { title: 'Fourth story', url: 'https://news.example/fourth' },
    ],
  );
  assert.equal(articles.length, 3);
  assert.equal(articles[0].title, 'Austin council vote');
  // Non-HTTPS images would be blocked by the page CSP; drop them up front.
  assert.equal(articles[0].image, null);
  assert.equal(articles[1].title, 'World markets');
  assert.equal(articles[2].title, 'Fourth story');
});

test('pairs each cast with a location stream or a named world channel', () => {
  const videos = [
    {
      videoId: 'abcdefghijk',
      title: 'Austin live',
      channel: 'KXAN',
    },
  ];
  assert.deepEqual(buildCastVideo(videos, 0), {
    kind: 'live',
    id: 'abcdefghijk',
    title: 'Austin live',
    label: 'LIVE · KXAN',
  });
  assert.deepEqual(buildCastVideo(videos, 1), {
    kind: 'world',
    channelId: WORLD_LIVE_CHANNELS[1].channelId,
    title: `${WORLD_LIVE_CHANNELS[1].name} live`,
    label: `WORLD LIVE · ${WORLD_LIVE_CHANNELS[1].name}`,
  });
  assert.equal(buildCastVideo([{ videoId: 'bad' }], 0).kind, 'world');
});

test('reports a story as live until its timestamp is in the past', () => {
  assert.equal(articleAge('invalid-date'), 'live');
  const now = Date.now();
  assert.equal(articleAge(new Date(now - 120_000).toISOString()), '2m ago');
  assert.equal(
    articleAge(new Date(now - 3_600_000 * 3).toISOString()),
    '3h ago',
  );
  assert.equal(
    articleAge(new Date(now - 86_400_000 * 3).toISOString()),
    '3d ago',
  );
});

test('measures distance for the follow threshold', () => {
  assert.equal(newsDistanceM(30.27, -97.74, 30.27, -97.74), 0);
  const austinToDallas = newsDistanceM(30.2672, -97.7431, 32.7767, -96.797);
  assert.ok(austinToDallas > 290_000 && austinToDallas < 320_000);
  assert.equal(newsDistanceM(Number.NaN, 0, 0, 0), Number.POSITIVE_INFINITY);
});

test('mounts three fixed casts from the first location brief', async () => {
  const body = installDocument();
  const calls = [];
  const feed = initLocationNewsFeed({
    location: { latitude: 30.2672, longitude: -97.7431 },
    fetchBrief: async (latitude, longitude, options) => {
      calls.push({ latitude, longitude, preferences: options.preferences });
      if (options.preferences.scope === 'local') {
        return {
          place: { label: 'Austin, Texas' },
          articles: [
            {
              title: 'Local story one',
              url: 'https://news.example/one',
              domain: 'News Example',
              publishedAt: '2026-10-28T10:00:00Z',
            },
            {
              title: 'Local story two',
              url: 'https://news.example/two',
              domain: 'News Example',
            },
          ],
          newsVideo: {
            videos: [
              {
                videoId: 'abcdefghijk',
                title: 'Live in Austin',
                channel: 'KXAN',
              },
              {
                videoId: 'lmnopqrstuv',
                title: 'Second live stream',
                channel: 'KVUE',
              },
            ],
          },
        };
      }
      return {
        articles: [{ title: 'World story', url: 'https://news.example/world' }],
      };
    },
  });

  await feed.refresh();
  // The mount starts its own request; the awaited refresh repaints from the
  // same two-step local → worldwide sequence.
  assert.ok(calls.length >= 2);
  assert.equal(calls.at(-2).preferences.scope, 'local');
  assert.equal(calls.at(-1).preferences.scope, 'global');
  assert.equal(body.children.length, 1);

  const articles = feed.getActiveArticles();
  assert.deepEqual(
    articles.map((article) => article.title),
    ['Local story one', 'Local story two', 'World story'],
  );
  assert.deepEqual(
    feed.getCasts().map((cast) => cast.videoKey),
    [
      'live:abcdefghijk',
      'live:lmnopqrstuv',
      `world:${WORLD_LIVE_CHANNELS[2].channelId}`,
    ],
  );
  const cards = body.children[0].children;
  assert.equal(cards.length, 3);
  assert.equal(cards[0].children[2].children[0].textContent, 'Local story one');
  const frame = cards[0].children[1].children.find(
    (child) => child.tagName === 'IFRAME',
  );
  assert.match(frame.src, /youtube-nocookie\.com\/embed\/abcdefghijk/);
  assert.match(frame.src, /autoplay=1/);
  // The world fallback resolves the channel's current stream, so a rotated
  // broadcast can never leave a private video ID in the frame.
  const worldFrame = cards[2].children[1].children.find(
    (child) => child.tagName === 'IFRAME',
  );
  assert.match(worldFrame.src, /youtube-nocookie\.com\/embed\/live_stream\?/);
  assert.ok(worldFrame.src.includes(WORLD_LIVE_CHANNELS[2].channelId));

  feed.destroy();
  assert.equal(body.children.length, 0);
  assert.equal(document.listenerCount('visibilitychange'), 0);
});

test('clamps a dragged cast inside the viewport', () => {
  const viewport = {
    viewportWidth: 1200,
    viewportHeight: 800,
    margin: 8,
  };
  assert.deepEqual(
    clampCastPosition({
      left: 620,
      top: 180,
      width: 520,
      height: 240,
      ...viewport,
    }),
    { left: 620, top: 180 },
  );
  assert.deepEqual(
    clampCastPosition({
      left: 2000,
      top: 2000,
      width: 520,
      height: 240,
      ...viewport,
    }),
    { left: 672, top: 552 },
  );
  assert.deepEqual(
    clampCastPosition({
      left: -90,
      top: -40,
      width: 520,
      height: 240,
      ...viewport,
    }),
    { left: 8, top: 8 },
  );
  assert.equal(
    clampCastPosition({
      left: Number.NaN,
      top: 0,
      width: 520,
      height: 240,
      ...viewport,
    }),
    null,
  );
});

test('drags and minimizes a cast, then restores both on remount', async () => {
  const body = installDocument();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  const briefFor = () => ({
    place: { label: 'Austin, Texas' },
    articles: [{ title: 'Local story', url: 'https://news.example/one' }],
    newsVideo: { videos: [] },
  });
  const options = {
    location: { latitude: 30.2672, longitude: -97.7431 },
    fetchBrief: async () => briefFor(),
  };
  const feed = initLocationNewsFeed(options);
  await feed.refresh();

  const card = body.children[0].children[0];
  const header = card.children[0];
  card.getBoundingClientRect = () => ({
    left: 500,
    top: 72,
    width: 520,
    height: 240,
  });

  header.emit('pointerdown', {
    button: 0,
    pointerId: 1,
    clientX: 520,
    clientY: 80,
    target: header,
  });
  document.emit('pointermove', {
    pointerId: 1,
    clientX: 620,
    clientY: 180,
  });
  assert.equal(card.style.left, '600px');
  assert.equal(card.style.top, '172px');
  assert.equal(card.classList.contains('is-dragging'), true);
  document.emit('pointerup', { pointerId: 1 });
  assert.equal(card.classList.contains('is-dragging'), false);

  const controls = header.children.find(
    (child) => child.className === 'news-cast__controls',
  );
  const toggle = controls.children[0];
  toggle.emit('click', { stopPropagation() {} });
  assert.equal(card.classList.contains('is-minimized'), true);
  assert.equal(toggle.textContent, '+');

  const saved = JSON.parse(store.get('gev.news-casts.v1'));
  assert.deepEqual(saved.top, { left: 600, top: 172, minimized: true });

  feed.destroy();
  const remounted = initLocationNewsFeed(options);
  const restored = body.children[0].children[0];
  assert.equal(restored.classList.contains('is-placed'), true);
  assert.equal(restored.classList.contains('is-minimized'), true);
  assert.equal(restored.style.left, '600px');
  remounted.destroy();

  delete globalThis.localStorage;
  delete globalThis.innerWidth;
  delete globalThis.innerHeight;
});

test('follows the camera when it settles on a different place', async () => {
  installDocument();
  const calls = [];
  let moveEnd = null;
  const target = Cesium.Cartesian3.fromDegrees(-96.797, 32.7767, 100);
  const canvas = mockElement('canvas');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const viewer = {
    isDestroyed: () => false,
    camera: {
      positionCartographic: { height: 900 },
      moveEnd: {
        addEventListener(listener) {
          moveEnd = listener;
          return () => {
            moveEnd = null;
          };
        },
      },
    },
    scene: {
      canvas,
      pick: () => null,
      pickPositionSupported: true,
      pickPosition: () => target,
    },
  };
  const brief = {
    place: { label: 'Dallas, Texas' },
    articles: [{ title: 'Dallas story', url: 'https://news.example/dallas' }],
    newsVideo: { videos: [] },
  };
  const feed = initLocationNewsFeed({
    viewer,
    location: { latitude: 30.2672, longitude: -97.7431 },
    fetchBrief: async (latitude, longitude) => {
      calls.push({ latitude, longitude });
      return brief;
    },
  });
  await feed.refresh();
  const initialCalls = calls.length;
  assert.ok(moveEnd);

  moveEnd();
  await waitFor(() => calls.length > initialCalls);
  const latest = calls[calls.length - 1];
  assert.ok(Math.abs(latest.latitude - 32.7767) < 0.01);
  assert.ok(Math.abs(latest.longitude + 96.797) < 0.01);

  feed.destroy();
  assert.equal(moveEnd, null);
});
