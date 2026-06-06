# BlackboxAI Edit Plan - Fix OSM map black screen

## Information Gathered
- `HomeScreen` renders `<MapComponent ... />` as first child inside a root `<View style={styles.container}>`.
- Current `MapComponent.js` uses `react-native-maps` with OSM tile layer; this can still fail/blank depending on RN/Expo native map provider.
- There is already an `OSMMap.js` component using `react-native-webview` + Leaflet (OSM tiles) with a `postMessage` bridge for dynamic bus markers.
- `OSMMap.js` currently exists but is NOT used by `HomeScreen`.
- The map needs to render full-screen behind overlay UI (top bar + bottom sheet). `HomeScreen` already uses `position: 'absolute'` for `topBar` and `bottomSheet`, but the map container has no explicit absolute/background layering.

## Plan
### 1) Replace/repair the map implementation
- Update `frontend/src/components/Map/OSMMap.js` to be robust on both iOS/Android:
  - WebView style: `position: 'absolute'`, `top:0,left:0,right:0,bottom:0`, `flex:1`.
  - Add `injectedJavaScriptBeforeContentLoaded` and `injectedJavaScript`-style sizing calls via `postMessage` and `map.invalidateSize`.
  - Keep a single Leaflet map instance and only update markers on `BUS_LOCATION` messages.
  - Ensure initial marker uses KIOT fallback; if busData missing, still shows base map.

### 2) Fix map integration inside HomeScreen
- Update `frontend/src/screens/HomeScreen.js` to render `<OSMMap />` instead of `<MapComponent />`.
- Make the map background layer:
  - Wrap map in a container with `position: 'absolute'`, full-screen.
  - Ensure overlay components have higher `zIndex` (`topBar` already has zIndex: 10; bottom sheet should have zIndex: 10 as well).

### 3) Prevent layout/height=0 issues
- Add `styles.mapBackground` and apply it.
- Add `minHeight: 1` as safety if needed.

### 4) Dynamic marker updates
- Keep existing bridge: `webRef.current.postMessage(JSON.stringify({type:'BUS_LOCATION', ...}))`.
- Ensure latitude/longitude checks prevent invalid updates.

## Dependent Files to be edited
- `frontend/src/components/Map/OSMMap.js`
- `frontend/src/screens/HomeScreen.js`

## Followup steps
- Run frontend checks:
  - `npm test` (if configured)
  - or `npm run lint`
  - and build/run on device/emulator to confirm map is no longer black.

<ask_followup_question>
Approve replacing `MapComponent` with the WebView+Leaflet `OSMMap` and applying absolute full-screen background layering + zIndex fixes (only map-related files).
</ask_followup_question>

