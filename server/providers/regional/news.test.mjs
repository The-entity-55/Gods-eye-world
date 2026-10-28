import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchArticles, queryFor } from './news.js';

test('normalizes search-provider articles without allowing unsafe links', () => {
  assert.deepEqual(
    normalizeSearchArticles([
      {
        title: '  Regional update ',
        url: 'https://news.example/one',
        source: 'News Example',
        published_date: '2026-10-27T12:00:00Z',
        thumbnail: 'https://cdn.example/one.jpg',
      },
      { title: 'Regional update', url: 'https://news.example/two' },
      { title: 'Unsafe', url: 'javascript:alert(1)' },
    ]),
    [
      {
        title: 'Regional update',
        url: 'https://news.example/one',
        domain: 'News Example',
        publishedAt: '2026-10-27T12:00:00.000Z',
        image: 'https://cdn.example/one.jpg',
        sourceCountry: null,
      },
    ],
  );
});

test('article thumbnails accept only http(s) image URLs', () => {
  const [article] = normalizeSearchArticles([
    {
      title: 'Thumbnail sanity',
      url: 'https://news.example/story',
      thumbnail: 'javascript:alert(1)',
    },
  ]);
  assert.equal(article.image, null);
});

test('builds a location-led query with optional global preferences', () => {
  assert.equal(
    queryFor(
      { locality: 'Bengaluru' },
      { topics: ['technology'], countries: ['US'] },
    ),
    'Bengaluru technology US',
  );
  assert.equal(queryFor(null), null);
});
