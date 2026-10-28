import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeLiveQuery,
  createNewsVideoProvider,
  normalizeYouTubeLiveVideos,
} from './newsVideo.js';

const PLACE = {
  locality: 'Austin',
  region: 'Texas',
  country: 'United States',
  countryCode: 'US',
};

test('builds a place-led live query with a world fallback', () => {
  assert.equal(buildYouTubeLiveQuery(PLACE), 'Austin United States news live');
  assert.equal(buildYouTubeLiveQuery({ region: 'Texas' }), 'Texas news live');
  assert.equal(buildYouTubeLiveQuery(null), 'world news live');
});

test('keeps only embeddable, titled, unique live-video ids', () => {
  const videos = normalizeYouTubeLiveVideos(
    {
      items: [
        {
          id: { videoId: 'abcdefghijk' },
          snippet: {
            title: ' Live from Austin ',
            channelTitle: 'Local News',
            publishedAt: '2026-10-28T10:00:00Z',
          },
        },
        {
          id: { videoId: 'abcdefghijk' },
          snippet: { title: 'Duplicate row' },
        },
        { id: { videoId: 'not-an-id' }, snippet: { title: 'Bad id' } },
        { id: { videoId: 'lmnopqrstuv' }, snippet: { title: '   ' } },
        {
          id: { videoId: 'zyxwvutsrqp' },
          snippet: { title: 'Second stream' },
        },
      ],
    },
    2,
  );
  assert.deepEqual(videos, [
    {
      videoId: 'abcdefghijk',
      title: 'Live from Austin',
      channel: 'Local News',
      publishedAt: '2026-10-28T10:00:00.000Z',
    },
    {
      videoId: 'zyxwvutsrqp',
      title: 'Second stream',
      channel: 'YouTube live',
      publishedAt: null,
    },
  ]);
});

test('searches YouTube once per place, caches the answer, then stops at the daily cap', async () => {
  let now = Date.parse('2026-10-28T12:00:00Z');
  const urls = [];
  const provider = createNewsVideoProvider({
    apiKey: 'test-key',
    dailySearchLimit: 2,
    now: () => now,
    fetchJson: async (url) => {
      urls.push(url);
      return {
        items: [
          {
            id: { videoId: 'abcdefghijk' },
            snippet: { title: 'Live in Austin', channelTitle: 'KXAN' },
          },
        ],
      };
    },
  });

  const first = await provider.fetchForPlace(PLACE);
  assert.equal(first.status, 'ready');
  assert.equal(first.videos.length, 1);
  assert.match(urls[0], /eventType=live/);
  assert.match(urls[0], /regionCode=US/);
  assert.match(urls[0], /q=Austin\+United\+States\+news\+live/);

  const cached = await provider.fetchForPlace(PLACE);
  assert.equal(cached.cached, true);
  assert.equal(urls.length, 1);

  assert.equal(
    (await provider.fetchForPlace({ ...PLACE, locality: 'Dallas' })).status,
    'ready',
  );
  const capped = await provider.fetchForPlace({
    ...PLACE,
    locality: 'Houston',
  });
  assert.equal(capped.status, 'quota');
  assert.equal(urls.length, 2);

  // A new UTC day reopens the budget.
  now += 24 * 60 * 60_000;
  assert.equal(
    (await provider.fetchForPlace({ ...PLACE, locality: 'El Paso' })).status,
    'ready',
  );
  assert.equal(provider.getSearchesToday(), 1);
});

test('a failed request becomes an error status without throwing', async () => {
  const provider = createNewsVideoProvider({
    apiKey: 'test-key',
    fetchJson: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(await provider.fetchForPlace(PLACE), {
    status: 'error',
    query: 'Austin United States news live',
    source: null,
    videos: [],
  });
});

test('an unconfigured provider never calls YouTube', async () => {
  let called = false;
  const provider = createNewsVideoProvider({
    apiKey: '',
    fetchJson: async () => {
      called = true;
      return { items: [] };
    },
  });
  assert.equal((await provider.fetchForPlace(PLACE)).status, 'unconfigured');
  assert.equal(called, false);
});
