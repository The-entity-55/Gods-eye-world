import { requiredFiniteQueryNumber } from '../common/query.js';

function validRegionalPoint(params) {
  const latitude = requiredFiniteQueryNumber(params, 'latitude');
  const longitude = requiredFiniteQueryNumber(params, 'longitude');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
    return null;
  return { latitude, longitude };
}

function preferenceList(value, { pattern, maxItems = 4, maxLength = 60 } = {}) {
  const values = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item.length <= maxLength && pattern.test(item));
  return [...new Set(values)].slice(0, maxItems);
}

/**
 * Accept a deliberately small, query-only preference vocabulary. These values
 * influence search terms and provider filters; they can never select a URL or
 * pass credentials through the browser.
 */
function regionalNewsPreferences(params) {
  const preferences = {
    topics: preferenceList(params.get('topics'), {
      pattern: /^[\p{L}\p{N}][\p{L}\p{N} &'/-]{0,59}$/u,
    }),
    countries: preferenceList(params.get('countries'), {
      pattern: /^[a-z]{2}$/i,
      maxItems: 3,
      maxLength: 2,
    }).map((country) => country.toUpperCase()),
    domains: preferenceList(params.get('domains'), {
      pattern: /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i,
      maxItems: 4,
      maxLength: 120,
    }).map((domain) => domain.toLowerCase()),
    language: /^[a-z]{2}$/i.test(String(params.get('language') || ''))
      ? String(params.get('language')).toLowerCase()
      : 'en',
  };
  if (params.get('scope') === 'global') preferences.scope = 'global';
  return preferences;
}

export { validRegionalPoint, regionalNewsPreferences };
