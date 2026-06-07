import React, { useRef, useEffect } from "react";
import { WebView } from "react-native-webview";

const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

export default function OSMMap({ busData }) {
  const webRef = useRef(null);

  // Send live bus updates to WebView
  useEffect(() => {
    if (!webRef.current || !busData) return;


    const message = JSON.stringify({
      type: "BUS_LOCATION",
      latitude: busData.latitude,
      longitude: busData.longitude,
    });

    webRef.current.postMessage(message);
  }, [busData]);

  // Inject a postMessage handler only once (fixes potential listener issues)
  const initialMessage = null;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; }
    #map { width: 100%; height: 100%; }
    .leaflet-container { background: transparent; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function () {
      var initialLat = ${KIOT_LAT};
      var initialLng = ${KIOT_LNG};

      var map = L.map('map', { zoomControl: false }).setView([initialLat, initialLng], 14);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19
      }).addTo(map);

      // College marker (static)
      L.marker([initialLat, initialLng]).addTo(map).bindPopup("KIOT College");

      // Bus marker (dynamic)
      var busMarker = L.marker([initialLat, initialLng]).addTo(map);

      function isFiniteNumber(x) {
        return typeof x === 'number' && isFinite(x);
      }

      function updateBus(lat, lng) {
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return;
        busMarker.setLatLng([lat, lng]);
        map.panTo([lat, lng]);
      }

      function handleMessage(raw) {
        try {
          var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data && data.type === 'BUS_LOCATION') {
            updateBus(data.latitude, data.longitude);
          }
        } catch (e) {
          // ignore bad payloads
        }
      }

      // RN → WebView bridge
      document.addEventListener('message', function (event) {
        handleMessage(event.data);
      });

      // Ensure Leaflet recalculates size after WebView layout settles
      function safeResize() {
        try { map.invalidateSize(true); } catch (e) {}
      }
      setTimeout(safeResize, 0);
      setTimeout(safeResize, 300);

      // Also react to visibility changes (some Android cases)
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) safeResize();
      });
    })();
  </script>
</body>
</html>
`;

return (
  <WebView
    ref={webRef}
    source={{ html, baseUrl: '' }}
    style={{ flex: 1, width: '100%', height: '100%' }}
    javaScriptEnabled
    domStorageEnabled
    originWhitelist={["*"]}
    automaticallyAdjustContentInsets={false}
    scalesPageToFit={false}
    renderLoading={() => null}
    onShouldStartLoadWithRequest={() => true}
  />
);
}