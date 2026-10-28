import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import { initStartupLocationPrompt } from './startupLocation.js';
import { initLocationNewsFeed } from '../ui/locationNewsFeed.js';

/** Construct the existing controls and camera presentation. */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations },
  loaderStatus,
  loadingScreen,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
  signal,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer, {
    weatherService: operations.requests.weather,
  });
  defer(() => cockpitCloudEffects?.destroy());

  // Startup camera positioning: prompt operator for geolocation and auto-fly on approve
  styleManager.startupLocationPromise = initStartupLocationPrompt({
    viewer,
    loaderStatus,
    loadingScreen,
    hasShareState: styleManager.hasShareState,
    defer,
    signal,
  });
  let locationNewsFeed;
  void styleManager.startupLocationPromise.then((location) => {
    if (signal?.aborted) return;
    const resolvedLocation =
      Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)
        ? location
        : { latitude: 30.2672, longitude: -97.7431 };
    locationNewsFeed = initLocationNewsFeed({
      viewer,
      location: resolvedLocation,
      fetchBrief: (...args) => operations.requests.regional.getBrief(...args),
      signal,
    });
  });
  defer(() => locationNewsFeed?.destroy());

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
