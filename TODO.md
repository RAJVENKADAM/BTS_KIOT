# TODO - Map Black Screen Fix (Expo React Native)

## Plan
1. Fix map integration in `frontend/src/screens/HomeScreen.js` so the map is a true background layer and always has a non-zero rendered height.
2. Replace/repair the map component to use stable OpenStreetMap rendering via `react-native-webview` + Leaflet.
3. Ensure WebView/Leaflet container uses `flex:1` + `position:absolute` to occupy full screen and updates marker dynamically on prop changes.
4. Fix Android rendering issues by disabling nested scrolling, forcing `pointerEvents`/`zIndex`, and forcing Leaflet `invalidateSize` on RN->WebView layout changes.
5. Confirm bus marker updates correctly when latitude/longitude changes.

## Steps tracking
- [ ] Step 0: Gather evidence (already partially done)
- [ ] Step 1: Implement new stable `OSMMap` component (Leaflet in WebView)
- [ ] Step 2: Integrate `OSMMap` into `HomeScreen` (map as background, overlay UI above)
- [ ] Step 3: Add layout fixes for zIndex/flex/absolute positioning
- [ ] Step 4: Verify dynamic marker updates logic (postMessage bridge)
- [ ] Step 5: Run app build/test command(s) to verify map renders

