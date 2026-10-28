import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initStartupLocationPrompt,
  USER_LOCATION_STORAGE_KEY,
} from './startupLocation.js';

function createMockElements() {
  const listeners = new Map();
  const approveBtn = {
    disabled: false,
    textContent: 'APPROVE',
    addEventListener(event, fn) {
      listeners.set(`approve:${event}`, fn);
    },
    removeEventListener(event) {
      listeners.delete(`approve:${event}`);
    },
    click() {
      listeners.get('approve:click')?.();
    },
  };
  const skipBtn = {
    disabled: false,
    textContent: 'SKIP',
    addEventListener(event, fn) {
      listeners.set(`skip:${event}`, fn);
    },
    removeEventListener(event) {
      listeners.delete(`skip:${event}`);
    },
    click() {
      listeners.get('skip:click')?.();
    },
  };
  const hiddenAttrs = new Set(['hidden']);
  const promptEl = {
    hasAttribute: (attr) => hiddenAttrs.has(attr),
    setAttribute: (attr) => hiddenAttrs.add(attr),
    removeAttribute: (attr) => hiddenAttrs.delete(attr),
  };
  const loadingScreen = {
    querySelector(selector) {
      if (selector === '#loader-location-prompt') return promptEl;
      if (selector === '#loader-approve-location') return approveBtn;
      if (selector === '#loader-skip-location') return skipBtn;
      return null;
    },
  };
  const loaderStatus = { textContent: '' };
  return { loadingScreen, promptEl, approveBtn, skipBtn, loaderStatus };
}

function createMockViewer() {
  const views = [];
  const flights = [];
  return {
    isDestroyed: () => false,
    camera: {
      setView(opts) {
        views.push(opts);
      },
      flyTo(opts) {
        flights.push(opts);
      },
      cancelFlight() {},
    },
    _records: { views, flights },
  };
}

test('startupLocation: hasShareState returns share-state without prompting', async () => {
  const { loadingScreen, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  const result = await initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    hasShareState: true,
  });
  assert.equal(result.status, 'share-state');
  assert.equal(loaderStatus.textContent, 'Restoring shared view...');
});

test('startupLocation: bypasses and flies to Austin in automated/test mode', async () => {
  const { loadingScreen, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  let deferredFlight = null;
  const result = await initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    locationRef: { search: '?welcome=0' },
    defer: (fn) => {
      deferredFlight = fn;
    },
  });
  assert.equal(result.status, 'automated');
  assert.ok(typeof deferredFlight === 'function');
});

test('startupLocation: falls back when geolocation is unsupported', async () => {
  const { loadingScreen, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  let deferredFlight = null;
  const result = await initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    geolocation: null,
    locationRef: { search: '' },
    defer: (fn) => {
      deferredFlight = fn;
    },
  });
  assert.equal(result.status, 'unsupported');
  assert.ok(typeof deferredFlight === 'function');
});

test('startupLocation: approves, acquires location, and flies to user coordinates', async () => {
  const { loadingScreen, promptEl, approveBtn, loaderStatus } =
    createMockElements();
  const viewer = createMockViewer();
  const storageMap = new Map();
  const storage = {
    setItem: (k, v) => storageMap.set(k, v),
    getItem: (k) => storageMap.get(k),
  };
  const mockGeo = {
    getCurrentPosition(success) {
      setTimeout(() => {
        success({
          coords: {
            latitude: 19.076,
            longitude: 72.8777,
          },
        });
      }, 10);
    },
  };

  const promise = initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    geolocation: mockGeo,
    storage,
    locationRef: { search: '' },
  });

  assert.equal(promptEl.hasAttribute('hidden'), false);
  approveBtn.click();

  const result = await promise;
  assert.equal(result.status, 'located');
  assert.equal(result.latitude, 19.076);
  assert.equal(result.longitude, 72.8777);
  assert.ok(storageMap.has(USER_LOCATION_STORAGE_KEY));
  assert.ok(promptEl.hasAttribute('hidden'));
});

test('startupLocation: handles geolocation denial gracefully', async () => {
  const { loadingScreen, approveBtn, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  const mockGeo = {
    getCurrentPosition(success, error) {
      setTimeout(() => {
        error(new Error('Permission denied'));
      }, 10);
    },
  };

  const promise = initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    geolocation: mockGeo,
    locationRef: { search: '' },
  });

  approveBtn.click();
  const result = await promise;
  assert.equal(result.status, 'denied');
  assert.match(loaderStatus.textContent, /Location access denied/);
});

test('startupLocation: operator skip button opens globe/austin directly', async () => {
  const { loadingScreen, skipBtn, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  const mockGeo = {
    getCurrentPosition() {},
  };

  const promise = initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    geolocation: mockGeo,
    locationRef: { search: '' },
  });

  skipBtn.click();
  const result = await promise;
  assert.equal(result.status, 'skipped');
  assert.equal(loaderStatus.textContent, 'Opening globe view...');
});

test('startupLocation: strictly respects application lifecycle defer contract', async () => {
  const { loadingScreen, approveBtn } = createMockElements();
  let cancelled = 0;
  const viewer = {
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {},
      cancelFlight() {
        cancelled++;
      },
    },
  };

  let acceptingCleanup = true;
  const cleanups = [];
  const defer = (dispose) => {
    if (!acceptingCleanup || typeof dispose !== 'function') {
      throw new TypeError('Register cleanup during component construction');
    }
    cleanups.push(dispose);
  };

  const mockGeo = {
    getCurrentPosition(success) {
      setTimeout(() => {
        success({
          coords: { latitude: 37.7749, longitude: -122.4194 },
        });
      }, 10);
    },
  };

  const promise = initStartupLocationPrompt({
    viewer,
    loadingScreen,
    geolocation: mockGeo,
    defer,
    locationRef: { search: '' },
  });

  // End of component construction phase — defer must not be called after this
  acceptingCleanup = false;

  approveBtn.click();
  const result = await promise;
  assert.equal(result.status, 'located');
  assert.equal(result.latitude, 37.7749);

  // When application is destroyed, cleanups run and flight is cancelled
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(cancelled, 1);
});

test('startupLocation: automatically uses saved user location from storage without prompting', async () => {
  const { loadingScreen, promptEl, loaderStatus } = createMockElements();
  const viewer = createMockViewer();
  const storageMap = new Map([
    [
      USER_LOCATION_STORAGE_KEY,
      JSON.stringify({ latitude: 51.5074, longitude: -0.1278, timestamp: Date.now() }),
    ],
  ]);
  const storage = {
    setItem: (k, v) => storageMap.set(k, v),
    getItem: (k) => storageMap.get(k),
  };

  const result = await initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    storage,
    locationRef: { search: '' },
  });

  assert.equal(result.status, 'located');
  assert.equal(result.latitude, 51.5074);
  assert.equal(result.longitude, -0.1278);
  assert.equal(promptEl.hasAttribute('hidden'), true);
  assert.match(loaderStatus.textContent, /Location found|Target acquired/);
});


