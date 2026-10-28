import * as Cesium from 'cesium';

/**
 * Creates a Cesium CustomShader that computes real-time dynamic day/night shading
 * for 3D tilesets (such as Google Photorealistic 3D Tiles).
 *
 * It uses the current Sun vector in world coordinates (czm_sunDirectionWC)
 * to calculate the angle with the Earth's surface normal at each fragment.
 *
 * - Day side (sun elevation > 0.08): 100% full photorealistic daylight texture.
 * - Night side (sun elevation < -0.12): realistic night shading with atmospheric ambient tint.
 * - Terminator zone: smooth dusk/dawn transition.
 *
 * @param {typeof import('cesium')} CesiumInstance
 * @returns {Cesium.CustomShader}
 */
export function createDayNightCustomShader(CesiumInstance = Cesium) {
  if (!CesiumInstance?.CustomShader) return null;
  return new CesiumInstance.CustomShader({
    lightingModel: CesiumInstance.LightingModel.UNLIT,
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        // Derive world coordinate position on the Earth ellipsoid
        vec4 worldPos = czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0);
        vec3 surfaceNormal = normalize(worldPos.xyz);

        // Dot product with Sun direction in World Coordinates (ECF)
        float sunElevation = dot(surfaceNormal, czm_sunDirectionWC);

        // Smoothstep across civil twilight/terminator
        float dayFactor = smoothstep(-0.12, 0.08, sunElevation);

        vec3 dayColor = material.diffuse;
        float luminance = dot(dayColor, vec3(0.299, 0.587, 0.114));

        // Realistic night appearance:
        // Ambient night contrast with subtle cool indigo/navy tint
        vec3 nightTint = vec3(0.08, 0.12, 0.22);
        vec3 nightColor = vec3(luminance) * nightTint * 1.6 + dayColor * 0.035;

        material.diffuse = mix(nightColor, dayColor, dayFactor);
      }
    `,
  });
}
