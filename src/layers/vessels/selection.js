import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';

export function createSelection({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { resolvePickId, isOwnedByOtherLayer, pickContact } = services.picking;
  const { requestWorldFocus } = services.worldFocus;
  const {
    selectEntityContext,
    registerEntityContext,
    clearSelectedEntityContextForLayer,
  } = services.context;
  const aisLiveVesselsLayer = layer;

  function installInteraction(viewer) {
    if (state.clickHandler || !viewer) return;
    const handler = state.interactionHandlerFactory
      ? state.interactionHandlerFactory(viewer)
      : new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    bindVesselInteraction(
      viewer,
      handler,
      state.interactionKeyTarget || document,
    );
  }

  function bindVesselInteraction(viewer, handler, keyTarget) {
    state.clickHandler = handler;
    handler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!state.feed.enabled) return;
      const picked = pickContact
        ? pickContact(viewer.scene, click.position)
        : viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      let record = pickedId ? state.records.byMmsi.get(pickedId) : null;
      const rawId = picked?.id ?? picked?.primitive?.id;
      const ownRecordPick =
        rawId && typeof rawId === 'object' && Object.hasOwn(rawId, 'mmsi');

      // An own-layer record without a live map key is a strict no-op (FB-1
      // residual). Trails carry no layer identity and hug their contacts, so any
      // `gev-trail:*` pick is also a no-op. Every other non-vessel pick — sibling
      // unowned scene picks dismiss the current vessel inspection.
      if (ownRecordPick && (!pickedId || !record)) return;
      if (pickedId && !record && String(pickedId).startsWith('gev-trail:'))
        return;

      // A sibling layer already owns this click. Preserve the current vessel
      // selection and do not compete with its camera command.
      const siblingOwned =
        pickedId && isOwnedByOtherLayer('ais-live-vessels', pickedId);
      // Cyclone geometry is ambient context behind painted cards. Its handler
      // yields to the same foreground AIS hit. Keep moving-contact precedence
      // unchanged: those handlers may issue their own camera command.
      const cycloneBackground =
        siblingOwned && !isOwnedByOtherLayer('weather-cyclones', pickedId);
      if (siblingOwned && !cycloneBackground) return;

      // Cards are painted on a pointer-events:none canvas, so the scene pick is
      // usually terrain behind the card. Resolve against the host's current
      // actionable hit rectangles before treating the click as empty space.
      const cardHit = !record
        ? vesselState._vesselOverlayHost.hitTest?.(
            click.position?.x,
            click.position?.y,
            {
              ...(cycloneBackground
                ? {}
                : { sourceId: VESSEL_OVERLAY_SOURCE_ID }),
            },
          )
        : null;
      if (cycloneBackground && cardHit?.sourceId !== VESSEL_OVERLAY_SOURCE_ID)
        return;
      if (!record && cardHit) {
        const mmsi = String(cardHit.entryId || '').startsWith('vessel:')
          ? cardHit.entryId.slice('vessel:'.length)
          : null;
        record = mmsi ? state.records.byMmsi.get(mmsi) || null : null;
        // A stale card id is not empty terrain and must not clear a newer
        // selection. The next paint will evict its hit rectangle.
        if (!record) return;
      }

      if (record) {
        // A valid sprite or card click always transfers the camera exactly once,
        // including a second click on the already-selected vessel.
        selectAndFocusVessel(record);
      } else {
        const transition = components.queries.reduceVesselSelection({
          selectedMmsi: state.selectedRecord?.mmsi,
          pickedMmsi: null,
          gesture: 'click',
        });
        if (transition.action === 'deselect') clearVesselInspection();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    state.keyTarget = keyTarget;
    state.keydownHandler = onVesselKeyDown;
    keyTarget.addEventListener('keydown', state.keydownHandler);
    // Vessels never set viewer.trackedEntity, so any new tracked entity belongs
    // to another layer and takes interaction ownership of the scene.
    state.trackedEntityRemover = viewer.trackedEntityChanged.addEventListener(
      () => {
        const trackedVesselMmsi = String(
          viewer.trackedEntity?.gevVesselInfo?.mmsi || '',
        );
        if (
          viewer.trackedEntity &&
          state.selectedRecord &&
          trackedVesselMmsi !== String(state.selectedRecord.mmsi)
        )
          clearVesselInspection();
      },
    );
  }

  /** Select one live vessel and request one UI-owned camera transfer. */

  function selectAndFocusVessel(record) {
    if (!record?.mmsi) return false;
    const transition = components.queries.reduceVesselSelection({
      selectedMmsi: state.selectedRecord?.mmsi,
      pickedMmsi: record.mmsi,
      gesture: 'click',
    });
    if (transition.action === 'select') selectVessel(record);
    requestWorldFocus({
      kind: 'vessel',
      id: record.mmsi,
      label: record.name || record.mmsi,
      position:
        components.rendering.getVisual(record).billboard?.position ||
        components.rendering.getVisual(record).position,
    });
    return true;
  }

  function removeVesselInteraction() {
    if (state.clickHandler) {
      state.clickHandler.destroy();
      state.clickHandler = null;
    }
    if (state.keyTarget && state.keydownHandler) {
      state.keyTarget.removeEventListener('keydown', state.keydownHandler);
    }
    state.keyTarget = null;
    state.keydownHandler = null;
    if (state.trackedEntityRemover) {
      state.trackedEntityRemover();
      state.trackedEntityRemover = null;
    }
  }

  function onVesselKeyDown(event) {
    if (!state.feed.enabled || event.key !== 'Escape') return;
    const transition = components.queries.reduceVesselSelection({
      selectedMmsi: state.selectedRecord?.mmsi,
      gesture: 'escape',
    });
    if (transition.action === 'deselect') {
      clearVesselInspection();
    }
  }

  /**
   * Give the shared Cockpit controller a live entity for the selected vessel.
   * AIS sprites live in a BillboardCollection, so they cannot themselves be
   * tracked by Cesium. The callback follows that sprite without creating a
   * second visible vessel on the map.
   */
  function prepareSelectedVesselForCockpit() {
    const record = state.selectedRecord;
    const viewer = state.viewer;
    if (!state.feed.enabled || !record?.mmsi || !viewer?.entities) return null;
    if (state.cockpitEntity && viewer.entities.contains(state.cockpitEntity))
      return state.cockpitEntity;
    const position = new Cesium.CallbackProperty((time, result) => {
      vesselInfo.latitude = Number(record.lat);
      vesselInfo.longitude = Number(record.lon);
      vesselInfo.track = Number(record.course);
      const currentSpeedKt = Number(record.speed);
      vesselInfo.velocityMps = Number.isFinite(currentSpeedKt)
        ? currentSpeedKt * 0.514444
        : 0;
      vesselInfo.stale = Boolean(record.stale);
      const visual = components.rendering.getVisual(record);
      const source = visual.billboard?.position || visual.position;
      return source ? Cesium.Cartesian3.clone(source, result) : undefined;
    }, false);
    const vesselInfo = {
      id: String(record.mmsi),
      mmsi: String(record.mmsi),
      layerId: 'ais-live-vessels',
      callsign: record.name || String(record.mmsi),
      registration: String(record.mmsi),
      latitude: Number(record.lat),
      longitude: Number(record.lon),
      altitudeM: 0,
      velocityMps: Number.isFinite(Number(record.speed))
        ? Number(record.speed) * 0.514444
        : 0,
      track: Number(record.course),
      stale: Boolean(record.stale),
      vesselType: record.type || null,
    };
    state.cockpitEntity = viewer.entities.add({
      position,
      show: false,
    });
    // Entity only merges its documented properties, so app identity must be
    // attached after creation rather than supplied as constructor options.
    state.cockpitEntity.gevTrackedId = `ais-live-vessels:${record.mmsi}`;
    state.cockpitEntity.gevVesselInfo = vesselInfo;
    return state.cockpitEntity;
  }

  /** Remove the invisible Cockpit bridge and leave the vessel selected. */
  function releaseSelectedVesselCockpit(entity = state.cockpitEntity) {
    const viewer = state.viewer;
    if (!entity || entity !== state.cockpitEntity) return false;
    if (viewer?.trackedEntity === entity) viewer.trackedEntity = undefined;
    if (viewer?.entities?.contains(entity)) viewer.entities.remove(entity);
    state.cockpitEntity = null;
    return true;
  }

  function selectVessel(record) {
    if (!record?.mmsi) return;
    const reuseTrail = state.trailMmsi === record.mmsi;
    clearSelection({ preserveTrail: reuseTrail });
    state.selectedRecord = record;
    record.missedRefreshes = 0;
    if (components.rendering.getVisual(record).billboard) {
      components.rendering.getVisual(record).billboard.image =
        components.rendering.shipIcon(record, true);
      components.rendering.getVisual(record).billboard.scale =
        components.rendering.shipScale(record) * 1.2;
    }
    // Rebuild the card set immediately so the full-detail card appears on the
    // click, not up to VISIBILITY_UPDATE_MS later.
    components.rendering.updateVisibility(true);
    components.cards.updateSelectedVesselHud(record);
    if (registerSelectedContext(record)) {
      selectEntityContext(record);
    }
    // Track-history trail (PRD F3/F4): seed with the current position + async
    // backfill from the server-side per-MMSI ring buffer.
    if (reuseTrail) {
      components.tracking.appendSelectedVesselTrailFix(record);
    } else {
      components.tracking.startSelectedVesselTrail(record);
    }
  }

  /**
   * Register (or refresh) the selected vessel in the shared context store so
   * the realtime/voice layer can describe what the user has selected.
   * @param {Object} record - Selected vessel record.
   * @returns {Object|null} The context record, or null if registration failed.
   */

  function registerSelectedContext(record) {
    if (!record?.mmsi) return null;
    try {
      return registerEntityContext(record, {
        id: `ais-${record.mmsi}`,
        layerId: 'ais-live-vessels',
        layerName: 'Live AIS Vessels',
        source: aisLiveVesselsLayer.source,
        label: components.cards.displayVesselName(record),
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          mmsi: record.mmsi,
          type: record.type,
          speedKt: record.speed,
          course: record.course,
          destination: record.destination,
        },
      });
    } catch (error) {
      console.warn('[Data:ais-live-vessels] context register failed', error);
      return null;
    }
  }

  function clearSelection({ preserveTrail = false, evicted = false } = {}) {
    releaseSelectedVesselCockpit();
    const record = state.selectedRecord;
    if (components.rendering.getVisual(record)?.billboard) {
      components.rendering.getVisual(record).billboard.image =
        components.rendering.shipIcon(record, false);
      components.rendering.getVisual(record).billboard.scale =
        components.rendering.shipScale(record);
    }
    state.selectedRecord = null;
    // Drop the full-detail card right away (no-op when the layer is disabled —
    // disable() clears the entry set itself).
    if (record && state.feed.enabled)
      components.rendering.updateVisibility(true);
    if (!preserveTrail) components.tracking.clearSelectedVesselTrail();
    try {
      clearSelectedEntityContextForLayer('ais-live-vessels', { evicted });
    } catch (error) {
      console.warn('[Data:ais-live-vessels] context clear failed', error);
    }
  }

  /**
   * @param {object} [options] Clear origin.
   * @param {boolean} [options.evicted=false] The vessel aged out of the feed
   *   rather than being deselected.
   */

  function clearVesselInspection({ evicted = false } = {}) {
    clearSelection({ evicted });
    components.cards.resetSelectedVesselHud();
  }
  return {
    installInteraction,
    bindVesselInteraction,
    selectAndFocusVessel,
    removeVesselInteraction,
    onVesselKeyDown,
    prepareSelectedVesselForCockpit,
    releaseSelectedVesselCockpit,
    selectVessel,
    registerSelectedContext,
    clearSelection,
    clearVesselInspection,
  };
}
