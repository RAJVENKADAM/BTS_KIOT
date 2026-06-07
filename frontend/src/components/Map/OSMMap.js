import React, { useRef, useEffect } from "react";
import { WebView } from "react-native-webview";

const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

export default function OSMMap({ busData, buses = [] }) {
  const webRef = useRef(null);

  // Push multi-bus payload + selected bus payload (legacy) to WebView
  // Keep strict single-focus behavior:
  // - Only send a single bus marker (BUS_LOCATION)
  // - Ignore multi-bus payloads so other buses never render simultaneously
  useEffect(() => {
    if (!webRef.current) return;

    // Always clear previous markers by forcing a new HTML instance would be best,
    // but for minimal change we simply avoid sending BUSES_LOCATION.

    if (busData && busData.latitude != null && busData.longitude != null) {
      const singlePayload = {
        type: "BUS_LOCATION",
        busNo: busData.busNo ?? busData.bus_no ?? "single",
        previewNumber: busData.previewNumber ?? busData.preview_number,
        latitude: busData.latitude,
        longitude: busData.longitude,
      };
      webRef.current.postMessage(JSON.stringify(singlePayload));
    }
  }, [busData]);


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

    /* Pulsing ring for live buses */
    .bus-pulse {
      position: relative;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: rgba(0, 200, 100, 0.20);
      border: 2px solid rgba(0, 200, 100, 0.85);
      transform: translate(-50%, -50%);
      box-sizing: border-box;
    }

    .bus-pulse:after {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 2px solid rgba(0, 200, 100, 0.60);
      transform: translate(-50%, -50%);
      animation: busPulse 1.2s ease-out infinite;
    }

    @keyframes busPulse {
      0% { opacity: 0.9; transform: translate(-50%, -50%) scale(0.85); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(2.2); }
    }

    .bus-dot {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: rgba(0, 200, 100, 0.95);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 12px rgba(0, 200, 100, 0.55);
    }
  </style>
</head>
<body>
  <div id="map"></div>

  <script>
    (function () {
      var initialLat = ${KIOT_LAT};
      var initialLng = ${KIOT_LNG};

      var map = L.map('map', { zoomControl: false, rotate: true }).setView([initialLat, initialLng], 14);

      // Enable manual rotation (Leaflet rotate plugin)
      // Note: in many builds rotate is supported only with a plugin; keeping rotate:true for best-effort.

      function focusMap(lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return;
        map.setView([lat, lng], 16);
      }



      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19
      }).addTo(map);

      // College marker (static)
      L.marker([initialLat, initialLng]).addTo(map).bindPopup("KIOT College");

      // Registry for bus markers (key -> marker)
      var busMarkers = {};

      function isFiniteNumber(x) {
        return typeof x === 'number' && isFinite(x);
      }

      function busIconHtml() {
        return '<div class="bus-pulse"><div class="bus-dot"></div></div>';
      }

      function createBusMarker() {
        var icon = L.divIcon({
          className: '',
          html: busIconHtml(),
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });

        var m = L.marker([initialLat, initialLng], { icon: icon, interactive: false });
        m.addTo(map);
        return m;
      }

      function upsertBusMarker(key, lat, lng) {
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return;
        if (!busMarkers[key]) busMarkers[key] = createBusMarker();
        busMarkers[key].setLatLng([lat, lng]);
      }

      function handleMessage(raw) {
        try {
          var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!data) return;

          // Multi-bus payload (should not be used after strict changes)
          if (data.type === 'BUSES_LOCATION' && Array.isArray(data.buses)) {
            data.buses.forEach(function (b) {
              if (!b) return;
              var key = (b.busNo || b.bus_no || b.previewNumber || b.preview_number || '').toString();
              if (!key) return;
              upsertBusMarker(key, b.latitude, b.longitude);
            });
            return;
          }

          // Single bus payload
          if (data.type === 'BUS_LOCATION') {
            var keySingle = (data.busNo || data.bus_no || data.previewNumber || data.preview_number || 'single').toString();
            upsertBusMarker(keySingle, data.latitude, data.longitude);
            // Focus strictly on the bus location
            focusMap(data.latitude, data.longitude);
            return;
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
      source={{ html, baseUrl: "" }}
      style={{ flex: 1, width: "100%", height: "100%" }}
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

