import React, { useMemo } from "react";
import { WebView } from "react-native-webview";

const toPoint = (point) => {
  if (
    !point ||
    point.latitude == null ||
    point.longitude == null ||
    String(point.latitude).trim() === "" ||
    String(point.longitude).trim() === "" ||
    !Number.isFinite(Number(point.latitude)) ||
    !Number.isFinite(Number(point.longitude))
  ) {
    return null;
  }
  return {
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
  };
};

export default function MasterMap({ recommendation }) {
  const data = useMemo(() => {
    const result = recommendation || {};
    return {
      user: toPoint(result.userLocation),
      stop: toPoint(result.stop),
      bus: toPoint(result.gps),
      stopName: result.stop?.name || "Recommended stop",
      busNumber: result.busNumber || "Nearest active bus",
      userDistance: result.userDistanceToStop,
      busStatus: result.status || "Unknown",
      etaMinutes: result.etaMinutes,
    };
  }, [recommendation]);
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; }
    .pin { width: 30px; height: 30px; border: 3px solid white; border-radius: 50%; box-shadow: 0 2px 6px #33415599; }
    .user { background: #2563eb; }
    .stop { background: #16a34a; }
    .bus { background: #ea580c; }
    .leaflet-popup-content { font: 14px Arial, sans-serif; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function () {
      var data = ${payload};
      var points = [];
      var map = L.map('map', { zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(map);
      function addMarker(point, type, label, popup) {
        if (!point) return;
        var latLng = [point.latitude, point.longitude];
        points.push(latLng);
        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, function (character) {
            return {
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            }[character];
          });
        }
        L.marker(latLng, {
          icon: L.divIcon({
            className: '',
            html: '<div class="pin ' + type + '"></div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          })
        }).addTo(map).bindPopup('<b>' + escapeHtml(label) + '</b><br>' + escapeHtml(popup));
      }
      addMarker(data.user, 'user', 'You', 'Your current location');
      addMarker(data.stop, 'stop', 'Recommended stop', data.stopName);
      addMarker(data.bus, 'bus', 'Bus ' + data.busNumber,
        'Status: ' + data.busStatus +
        (data.etaMinutes == null ? '' : '<br>ETA: ' + data.etaMinutes + ' min'));
      if (data.stop && data.user) {
        L.polyline([
          [data.user.latitude, data.user.longitude],
          [data.stop.latitude, data.stop.longitude]
        ], { color: '#16a34a', dashArray: '6 8', weight: 3 }).addTo(map);
      }
      if (points.length > 1) map.fitBounds(points, { padding: [28, 28] });
      else if (points.length === 1) map.setView(points[0], 15);
      else map.setView([11.554528, 78.019759], 13);
    })();
  </script>
</body>
</html>`;

  return (
    <WebView
      originWhitelist={["*"]}
      source={{ html }}
      javaScriptEnabled
      domStorageEnabled
      style={{ flex: 1, minHeight: 300 }}
    />
  );
}
