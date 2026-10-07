import React, { useEffect, useMemo, useRef } from "react";
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

const MAP_SOURCE = {
  html: `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; overflow: hidden; }
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
      var map = L.map('map', {
        zoomControl: true,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 100,
        zoomAnimation: true,
        fadeAnimation: true,
        markerZoomAnimation: true,
        inertia: true,
        inertiaDeceleration: 1800,
        inertiaMaxSpeed: 1200,
        easeLinearity: 0.2
      }).setView([11.554528, 78.019759], 13);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(map);

      var markers = {};
      var routeLine = null;
      var routeRequestId = 0;
      var lastRequestedRoute = null;
      var lastFocusedTarget = null;

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

      function formatDistance(meters) {
        var distance = Number(meters);
        if (!isFinite(distance) || distance < 0) return 'Distance unavailable';
        return distance >= 1000
          ? (distance / 1000).toFixed(1) + ' km from you'
          : Math.round(distance) + ' m from you';
      }

      function formatCoordinates(point) {
        return Number(point.latitude).toFixed(6) + ', ' +
          Number(point.longitude).toFixed(6);
      }

      function updateMarker(key, point, type, label, popup) {
        var marker = markers[key];
        if (!point) {
          if (marker) map.removeLayer(marker);
          delete markers[key];
          return;
        }

        var latLng = [point.latitude, point.longitude];
        var popupLines = Array.isArray(popup) ? popup : [popup];
        var popupContent = '<b>' + escapeHtml(label) + '</b><br>' +
          popupLines.map(escapeHtml).join('<br>');
        if (marker) {
          marker.setLatLng(latLng);
          marker.setPopupContent(popupContent);
          return;
        }

        marker = L.marker(latLng, {
          icon: L.divIcon({
            className: '',
            html: '<div class="pin ' + type + '"></div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          })
        }).addTo(map).bindPopup(popupContent);
        markers[key] = marker;
      }

      function updateRoadRoute(user, stop) {
        if (!user || !stop) {
          routeRequestId += 1;
          lastRequestedRoute = null;
          if (routeLine) {
            map.removeLayer(routeLine);
            routeLine = null;
          }
          return;
        }

        var routeKey = [
          user.latitude,
          user.longitude,
          stop.latitude,
          stop.longitude
        ].join(',');
        if (routeKey === lastRequestedRoute) return;
        lastRequestedRoute = routeKey;
        var requestId = ++routeRequestId;
        if (routeLine) {
          map.removeLayer(routeLine);
          routeLine = null;
        }
        var url = 'https://router.project-osrm.org/route/v1/driving/' +
          user.longitude + ',' + user.latitude + ';' +
          stop.longitude + ',' + stop.latitude +
          '?overview=full&geometries=geojson';

        fetch(url)
          .then(function (response) {
            if (!response.ok) {
              throw new Error('Routing service returned ' + response.status);
            }
            return response.json();
          })
          .then(function (result) {
            if (requestId !== routeRequestId) return;
            var coordinates = result.routes && result.routes[0] &&
              result.routes[0].geometry &&
              result.routes[0].geometry.coordinates;
            if (
              result.code !== 'Ok' ||
              !Array.isArray(coordinates) ||
              coordinates.length < 2
            ) {
              throw new Error('No road route was returned');
            }

            var points = coordinates.map(function (coordinate) {
              return [coordinate[1], coordinate[0]];
            });
            if (routeLine) map.removeLayer(routeLine);
            routeLine = L.polyline(points, {
              color: '#16a34a',
              weight: 4,
              opacity: 0.85,
              lineCap: 'round',
              lineJoin: 'round'
            }).addTo(map);
            if (lastFocusedTarget) {
              map.fitBounds(routeLine.getBounds(), {
                padding: [32, 32],
                maxZoom: 16,
                animate: true,
                duration: 0.6
              });
            }
          })
          .catch(function (error) {
            if (requestId === routeRequestId) {
              lastRequestedRoute = null;
              console.warn('Could not load the map route:', error.message);
            }
          });
      }

      window.updateMasterMap = function (data) {
        data = data || {};
        updateMarker('user', data.user, 'user', 'You', 'Your current location');
        updateMarker(
          'stop',
          data.stop,
          'stop',
          'Recommended stop',
          [
            data.stopName || 'Recommended stop',
            formatDistance(data.userDistance),
            'Coordinates: ' + formatCoordinates(data.stop)
          ]
        );
        updateMarker(
          'bus',
          data.bus,
          'bus',
          'Bus ' + (data.busNumber || 'Nearest active bus'),
          [
            'Status: ' + (data.busStatus || 'Unknown'),
            data.etaMinutes == null ? null : 'ETA: ' + data.etaMinutes + ' min'
          ].filter(function (line) { return line !== null; })
        );

        updateRoadRoute(data.user, data.stop);

        var targetKey = data.stop
          ? [data.stopId || '', data.stop.latitude, data.stop.longitude].join(':')
          : null;
        if (targetKey && targetKey !== lastFocusedTarget) {
          var focusPoints = [data.user, data.stop].filter(Boolean).map(function (point) {
            return [point.latitude, point.longitude];
          });
          map.fitBounds(focusPoints, {
            padding: [32, 32],
            maxZoom: 16,
            animate: true,
            duration: 0.6
          });
          lastFocusedTarget = targetKey;
        } else if (!lastFocusedTarget && !data.stop) {
          var fallbackPoints = [data.user, data.bus].filter(Boolean).map(function (point) {
            return [point.latitude, point.longitude];
          });
          if (fallbackPoints.length > 1) {
            map.fitBounds(fallbackPoints, { padding: [32, 32], animate: true, duration: 0.6 });
          } else if (fallbackPoints.length === 1) {
            map.flyTo(fallbackPoints[0], 15, { duration: 0.6 });
          }
        }
      };
    })();
  </script>
</body>
</html>`,
};

export default function MasterMap({ recommendation }) {
  const webRef = useRef(null);
  const mapReadyRef = useRef(false);
  const dataRef = useRef(null);
  const data = useMemo(() => {
    const result = recommendation || {};
    return {
      user: toPoint(result.userLocation),
      stop: toPoint(result.stop),
      bus: toPoint(result.gps),
      stopId: result.stop?.stopId,
      stopName: result.stop?.name || "Recommended stop",
      busNumber: result.serviceBusNumbers?.length
        ? result.serviceBusNumbers.join(" + ")
        : result.busNumber || "Nearest active bus",
      userDistance: result.userDistanceToStop,
      busStatus: result.status || "Unknown",
      etaMinutes: result.etaMinutes,
    };
  }, [recommendation]);

  useEffect(() => {
    dataRef.current = data;
    if (!mapReadyRef.current || !webRef.current) return;
    webRef.current.injectJavaScript(
      `window.updateMasterMap(${JSON.stringify(data)}); true;`,
    );
  }, [data]);

  const handleLoadEnd = () => {
    mapReadyRef.current = true;
    if (dataRef.current) {
      webRef.current?.injectJavaScript(
        `window.updateMasterMap(${JSON.stringify(dataRef.current)}); true;`,
      );
    }
  };

  return (
    <WebView
      ref={webRef}
      originWhitelist={["*"]}
      source={MAP_SOURCE}
      javaScriptEnabled
      domStorageEnabled
      nestedScrollEnabled
      scrollEnabled={false}
      onLoadEnd={handleLoadEnd}
      style={{ flex: 1, minHeight: 300 }}
    />
  );
}
