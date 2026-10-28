import { flyToAustin, flyToLocation } from '../camera.js';
import { t } from '../i18n/index.js';

export const USER_LOCATION_STORAGE_KEY = 'gev:last-known-location';

/**
 * Prompt operator for location on startup, and fly to coordinates upon approval.
 *
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {HTMLElement} [options.loaderStatus]
 * @param {HTMLElement} [options.loadingScreen]
 * @param {boolean} [options.hasShareState=false]
 * @param {Function} [options.defer]
 * @param {AbortSignal} [options.signal]
 * @param {Geolocation} [options.geolocation]
 * @param {Storage} [options.storage]
 * @param {Location} [options.locationRef]
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{status: string, latitude?: number, longitude?: number, error?: any}>}
 */
export function initStartupLocationPrompt({
  viewer,
  loaderStatus,
  loadingScreen = typeof document !== 'undefined'
    ? document.getElementById('loading-screen')
    : null,
  hasShareState = false,
  defer,
  signal,
  geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : null,
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
  locationRef = typeof window !== 'undefined' ? window.location : null,
  timeoutMs = 15000,
} = {}) {
  let activeFlightCancel = null;
  let watchdogTimer = null;
  let cleanListeners = null;

  // Register cleanup once synchronously during component construction
  if (typeof defer === 'function') {
    defer(() => {
      clearTimeout(watchdogTimer);
      cleanListeners?.();
      activeFlightCancel?.();
    });
  }

  // If restoring a shared view, the author's target takes precedence
  if (hasShareState) {
    if (loaderStatus) loaderStatus.textContent = t('Restoring shared view...');
    return Promise.resolve({ status: 'share-state' });
  }

  // Headless test suites or explicit bypass
  const search = locationRef?.search || '';
  const isAutomated =
    (typeof navigator !== 'undefined' && navigator.webdriver) ||
    search.includes('welcome=0') ||
    search.includes('location=0');

  if (isAutomated) {
    if (loaderStatus) loaderStatus.textContent = t('Flying to Austin, TX...');
    activeFlightCancel = flyToAustin(viewer);
    return Promise.resolve({ status: 'automated' });
  }

  // If operator has a previously approved home location, fly directly to it
  let savedLocation = null;
  try {
    const raw = storage?.getItem(USER_LOCATION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        Number.isFinite(parsed?.latitude) &&
        Number.isFinite(parsed?.longitude)
      ) {
        savedLocation = parsed;
      }
    }
  } catch {
    /* ignore storage parsing error */
  }

  if (savedLocation) {
    if (loaderStatus) {
      loaderStatus.textContent = t(
        'Location found: {lat}°, {lon}° — Loading view...',
        {
          lat: savedLocation.latitude.toFixed(4),
          lon: savedLocation.longitude.toFixed(4),
        },
      );
    }
    activeFlightCancel = flyToLocation(viewer, {
      latitude: savedLocation.latitude,
      longitude: savedLocation.longitude,
      altitude: 800,
      overviewAltitude: 35000,
      duration: 4.0,
    });
    // In background, refresh current position if geolocation is available and permitted
    if (geolocation && typeof geolocation.getCurrentPosition === 'function') {
      try {
        geolocation.getCurrentPosition(
          (pos) => {
            const latitude = pos?.coords?.latitude;
            const longitude = pos?.coords?.longitude;
            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
              storage?.setItem(
                USER_LOCATION_STORAGE_KEY,
                JSON.stringify({
                  latitude,
                  longitude,
                  timestamp: Date.now(),
                }),
              );
            }
          },
          () => {},
          { timeout: 8000, maximumAge: 60000 },
        );
      } catch {
        /* background refresh failure ignored */
      }
    }
    return Promise.resolve({
      status: 'located',
      latitude: savedLocation.latitude,
      longitude: savedLocation.longitude,
    });
  }

  // Check if browser geolocation is supported
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    if (loaderStatus) loaderStatus.textContent = t('Flying to Austin, TX...');
    activeFlightCancel = flyToAustin(viewer);
    return Promise.resolve({ status: 'unsupported' });
  }

  const promptEl = loadingScreen?.querySelector?.('#loader-location-prompt');
  const approveBtn = loadingScreen?.querySelector?.('#loader-approve-location');
  const skipBtn = loadingScreen?.querySelector?.('#loader-skip-location');

  if (!promptEl || !approveBtn || !skipBtn) {
    if (loaderStatus) loaderStatus.textContent = t('Flying to Austin, TX...');
    activeFlightCancel = flyToAustin(viewer);
    return Promise.resolve({ status: 'no-ui' });
  }

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(watchdogTimer);
      promptEl.setAttribute('hidden', '');
      approveBtn.removeEventListener('click', handleApprove);
      skipBtn.removeEventListener('click', handleSkip);
      signal?.removeEventListener('abort', handleAbort);
    };
    cleanListeners = cleanup;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleAbort = () => {
      activeFlightCancel?.();
      settle({ status: 'aborted' });
    };

    const handleApprove = () => {
      clearTimeout(watchdogTimer);
      approveBtn.disabled = true;
      skipBtn.disabled = true;
      approveBtn.textContent = t('LOCATING...');
      if (loaderStatus) {
        loaderStatus.textContent = t('Detecting your location...');
      }

      // Safety timeout in case browser geolocation hangs indefinitely without callback
      const geoTimeoutMs = Math.max(timeoutMs, 12000);
      watchdogTimer = setTimeout(() => {
        if (settled) return;
        console.warn('[Location] Geolocation timed out waiting for fix');
        if (loaderStatus) {
          loaderStatus.textContent = t(
            'Location unavailable — opening default view...',
          );
        }
        activeFlightCancel = flyToAustin(viewer);
        settle({ status: 'timeout' });
      }, geoTimeoutMs);

      try {
        geolocation.getCurrentPosition(
          (position) => {
            if (settled) return;
            const latitude = position?.coords?.latitude;
            const longitude = position?.coords?.longitude;

            if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
              if (loaderStatus) {
                loaderStatus.textContent = t(
                  'Location found: {lat}°, {lon}° — Loading view...',
                  {
                    lat: latitude.toFixed(4),
                    lon: longitude.toFixed(4),
                  },
                );
              }
              try {
                storage?.setItem(
                  USER_LOCATION_STORAGE_KEY,
                  JSON.stringify({
                    latitude,
                    longitude,
                    timestamp: Date.now(),
                  }),
                );
              } catch {
                /* quota or private browsing */
              }
              activeFlightCancel = flyToLocation(viewer, {
                latitude,
                longitude,
                altitude: 800,
                overviewAltitude: 35000,
                duration: 4.0,
              });
              settle({ status: 'located', latitude, longitude });
            } else {
              if (loaderStatus) {
                loaderStatus.textContent = t(
                  'Location unavailable — opening default view...',
                );
              }
              activeFlightCancel = flyToAustin(viewer);
              settle({ status: 'invalid-coords' });
            }
          },
          (error) => {
            if (settled) return;
            console.warn(
              '[Location] Geolocation permission denied or failed:',
              error,
            );
            if (loaderStatus) {
              loaderStatus.textContent = t(
                'Location access denied — opening globe view...',
              );
            }
            activeFlightCancel = flyToAustin(viewer);
            settle({ status: 'denied', error });
          },
          {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000,
          },
        );
      } catch (err) {
        if (settled) return;
        console.warn('[Location] Geolocation invocation failed:', err);
        activeFlightCancel = flyToAustin(viewer);
        settle({ status: 'error', error: err });
      }
    };

    const handleSkip = () => {
      clearTimeout(watchdogTimer);
      approveBtn.disabled = true;
      skipBtn.disabled = true;
      if (loaderStatus) {
        loaderStatus.textContent = t('Opening globe view...');
      }
      activeFlightCancel = flyToAustin(viewer);
      settle({ status: 'skipped' });
    };

    approveBtn.addEventListener('click', handleApprove, { once: true });
    skipBtn.addEventListener('click', handleSkip, { once: true });

    // If operator already authorized location in browser permissions, auto-approve immediately
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((perm) => {
          if (settled) return;
          if (perm.state === 'granted') {
            handleApprove();
          }
        })
        .catch(() => {});
    }

    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    // Reveal the location prompt UI
    promptEl.removeAttribute('hidden');
    if (loaderStatus) {
      loaderStatus.textContent = t('Select an option to begin...');
    }

    // Watchdog timer so user is never stalled if left untouched
    watchdogTimer = setTimeout(() => {
      if (settled) return;
      if (loaderStatus) loaderStatus.textContent = t('Flying to Austin, TX...');
      activeFlightCancel = flyToAustin(viewer);
      settle({ status: 'timeout' });
    }, timeoutMs);
  });
}
