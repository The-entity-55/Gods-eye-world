import * as Cesium from 'cesium';

/**
 * Fly camera to specified geographic coordinates with a cinematic orbital entry.
 * @param {Cesium.Viewer} viewer
 * @param {object} options
 * @param {number} options.longitude - Longitude in degrees
 * @param {number} options.latitude - Latitude in degrees
 * @param {number} [options.altitude=600] - Final camera height above ground in meters
 * @param {number} [options.overviewAltitude=25000] - Initial orbital overview height
 * @param {number} [options.duration=4.0] - Fly-in duration in seconds
 * @param {number} [options.heading=15] - Final camera heading in degrees
 * @param {number} [options.pitch=-30] - Final camera pitch in degrees
 * @returns {Function} Cancels the pending or active flight.
 */
export function flyToLocation(
  viewer,
  {
    longitude,
    latitude,
    altitude = 600,
    overviewAltitude = 25000,
    duration = 4.0,
    heading = 15,
    pitch = -30,
  } = {},
) {
  // Start from orbital overview altitude looking straight down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      longitude,
      latitude,
      overviewAltitude,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0.0,
      },
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);

  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(viewer) {
  return flyToLocation(viewer, {
    longitude: -97.7431,
    latitude: 30.2672,
    altitude: 600,
    overviewAltitude: 25000,
    duration: 4.0,
    heading: 15,
    pitch: -30,
  });
}
