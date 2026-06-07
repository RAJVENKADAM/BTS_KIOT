# Edit plan (Map focus + single bus display + strict user/preview rules)

## Information gathered
- Frontend map rendering is done in **frontend/src/components/Map/OSMMap.js** using Leaflet WebView markers.
  - It receives **both** `buses` and `busData` and currently upserts markers for *all* buses in `buses` payload (`BUSES_LOCATION`) and also upserts a marker for `BUS_LOCATION`.
  - This is why multiple bus markers can appear together after search.
- Page logic is in **frontend/src/screens/HomeScreen.js**.
  - It maintains `selectedBusNo`, `selectedPreviewNumber`, `busData`, `lastGoodLocation`, `noBusFound`.
  - It uses `busData || lastGoodLocation` as `displayBusData`.
  - On preview/bus search failure it sets flags, but **does not always clear busData/lastGoodLocation consistently**, causing fallback to show the previous bus location.
- Backend location endpoints:
  - `backend/src/controllers/bus.controller.js#getAllBuses` returns all active buses with live locations.
  - `backend/src/controllers/bus.controller.js#getLiveLocation` tries `$or: [{ bus_no: busNo }, { preview_number: busNo }]`.
  - `backend/src/controllers/bus.controller.js#trackByPreview` returns the single bus by `preview_number`.
- Manual rotate requirement:
  - **frontend/src/components/Map/MapComponent.js** currently has `rotateEnabled={false}`.
  - But the actual map used by HomeScreen seems to be **OSMMap** (WebView), not `MapComponent`.
  - Rotating the map in Leaflet is different; we need to ensure “manual rotation” is enabled in Leaflet (likely via a rotate plugin or map setting). If the project already uses `MapComponent` elsewhere, update it too.

## Plan
### 1) Enforce “show only searched bus location at a time”
- Update **frontend/src/screens/HomeScreen.js** to send to `OSMMap`:
  - For non-admin users and admin after they have searched: pass only the selected bus/live location, and pass `buses=[]` so OSMMap won’t render multiple bus markers.
  - For admin when no search has happened: show only KIOT college marker (already present in OSMMap) and render *no* bus markers.
- Maintain a state flag e.g. `hasAdminSearched` (persisted only in current session) so:
  - superadmin once searched => keep showing the searched bus location
  - superadmin never searched => show only KIOT

### 2) Fix strict “bus not found” behavior (prevent showing other buses)
- In **HomeScreen.js**:
  - When search fails for a bus/preview, set `busData=null` and `lastGoodLocation=null` so map cannot fall back to a previous bus.
  - Do not reuse `displayBusData = busData || lastGoodLocation` in failure scenarios; make fallback conditional:
    - Only use lastGoodLocation when the current request succeeded but became offline/stale.
    - If the user searched a bus and it does not exist (404) or has no live location for that bus/preview, show KIOT and display message “Bus not found ... there is no bus 5”.

### 3) Enforce “focus strictly”
- Since OSMMap uses Leaflet, ensure the view is centered on exactly the single bus coordinate when selected.
  - Modify **frontend/src/components/Map/OSMMap.js** to:
    - Track the last “active focus bus key”.
    - When it receives `BUS_LOCATION`, call `map.setView([lat,lng], <zoom>)`.
    - When only KIOT should be shown (no busData), optionally `map.setView([KIOT_LAT, KIOT_LNG], 14)`.
- Also ensure that when user searches, map recenters to the searched bus (not the previous one).

### 4) Enable map rotate manually
- Update both map components:
  - **frontend/src/components/Map/MapComponent.js**: set `rotateEnabled={true}`.
  - For **OSMMap.js** (Leaflet WebView): enable rotation manually.
    - Leaflet core doesn’t provide rotate; if a plugin isn’t present, we need to add one and allow user gesture rotation.
    - If rotation must be compass-style (drag to rotate), we must integrate a Leaflet rotate plugin inside the HTML.

## Dependent files to be edited
- frontend/src/screens/HomeScreen.js
- frontend/src/components/Map/OSMMap.js
- frontend/src/components/Map/MapComponent.js

## Followup steps
- Run frontend build/lint (or Metro) and backend unit checks.
- Test scenarios:
  1) Non-admin: on open app, map centers on their assigned bus only.
  2) Non-admin: search a bus that doesn’t exist (e.g., “5”) => map centers on KIOT only + message indicates bus not found; no other bus shown.
  3) Superadmin: first open => KIOT only.
  4) Superadmin: search any bus => shows only that bus until next search; if that search fails => KIOT only.
  5) Rotation: user can rotate the map manually.

<ask_followup_question>
Confirm: should rotation be enabled in the Leaflet (OSMMap) WebView too (drag gesture), or is MapComponent rotation enough? I will implement in both unless you specify otherwise.
</ask_followup_question>

