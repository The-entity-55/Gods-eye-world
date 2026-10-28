import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin, flyToLocation } from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('flyToLocation accepts coordinates and cancels pending flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let setViews = 0;
  let cancelled = 0;
  let targetDest;
  const stop = flyToLocation(
    {
      isDestroyed: () => false,
      camera: {
        setView({ destination }) {
          setViews++;
          targetDest = destination;
        },
        flyTo() {
          flights++;
        },
        cancelFlight() {
          cancelled++;
        },
      },
    },
    { longitude: 72.8777, latitude: 19.076 },
  );
  assert.equal(setViews, 1);
  assert.ok(targetDest);
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});
