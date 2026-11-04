/**
 * OSMMap — OpenStreetMap Leaflet component rendered via WebView.
 * Handles single bus marker display with a circular online/offline indicator,
 * college marker, and real-time coordinate updates via postMessage.
 */
import React, { useRef, useEffect, useCallback, useMemo } from "react";
import { WebView } from "react-native-webview";
const { ROUTE_REFRESH_DISTANCE_METERS } = require("../../utils/gpsLocationPolicy.cjs");

const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

export default function OSMMap({
  busData,
  buses = [],
  markerStatus = "moving",
}) {
  const webRef = useRef(null);
  const latestPayloadRef = useRef(null);
  const latestPayloadSignatureRef = useRef(null);
  const webViewReadyRef = useRef(false);

  // Push multi-bus payload + selected bus payload (legacy) to WebView
  // Keep strict single-focus behavior:
  // - Only send a single bus marker (BUS_LOCATION)
  // - Ignore multi-bus payloads so other buses never render simultaneously
  useEffect(() => {
    let payload;
    // Strict single-focus behavior:
    // - If busData is null or has no valid coords → tell the map to clear ALL
    //   bus markers so it reverts to the KIOT college default (no stale marker
    //   from a previously searched/cancelled bus).
    // - Otherwise send only THIS bus's marker. The map clears all existing
    //   markers before rendering the single one (see CLEAR before upsert in
    //   the WebView JS), so only the searched bus ever shows.
    if (!busData) {
      payload = { type: "CLEAR_MARKERS" };
      sendPayload(payload, "CLEAR_MARKERS");
      return;
    }

    const hasPrimaryLocation =
      busData.latitude != null &&
      busData.longitude != null &&
      Number.isFinite(Number(busData.latitude)) &&
      Number.isFinite(Number(busData.longitude)) &&
      Number(busData.latitude) >= -90 &&
      Number(busData.latitude) <= 90 &&
      Number(busData.longitude) >= -180 &&
      Number(busData.longitude) <= 180;
    if (!hasPrimaryLocation) {
      payload = { type: "CLEAR_MARKERS" };
      sendPayload(payload, "CLEAR_MARKERS");
      return;
    }

    payload = {
      type: "BUS_LOCATION",
      previewNumber:
        busData.previewNumber ??
        busData.preview_number ??
        busData.busNo ??
        busData.bus_no,
      latitude: busData.latitude,
      longitude: busData.longitude,
      isOffline: busData._isOffline === true,
      markerStatus: busData._markerStatus ?? markerStatus,
      lastSuccessfulGpsUpdate: busData.lastSuccessfulGpsUpdate ?? null,
    };
    const signature = JSON.stringify({
      type: payload.type,
      previewNumber: payload.previewNumber,
      latitude: payload.latitude,
      longitude: payload.longitude,
      isOffline: payload.isOffline,
      markerStatus: payload.markerStatus,
    });
    if (signature !== latestPayloadSignatureRef.current) {
      sendPayload(payload, signature);
    } else {
      latestPayloadRef.current = payload;
    }
  }, [busData, markerStatus, sendPayload]);

  const sendPayload = useCallback((payload, signature) => {
    latestPayloadRef.current = payload;
    latestPayloadSignatureRef.current = signature;
    if (webViewReadyRef.current) {
      webRef.current?.postMessage(JSON.stringify(payload));
    }
  }, []);

  const html = useMemo(() => `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src https://*.tile.openstreetmap.org https://router.project-osrm.org;" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; }
    #map { width: 100%; height: 100%; }
    .leaflet-container { background: transparent; }
    .bus-marker {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 7px rgba(15, 23, 42, .45);
      box-sizing: border-box;
      color: #fff;
      font: 700 10px/1 Arial, sans-serif;
    }
    .bus-marker-number {
      max-width: 28px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .college-marker {
      width: 24px;
      height: 24px;
      border-radius: 50% 50% 50% 0;
      background: #2563eb;
      border: 3px solid #fff;
      box-shadow: 0 2px 6px rgba(15, 23, 42, .45);
      transform: rotate(-45deg);
      box-sizing: border-box;
    }
    .college-marker::after {
      content: '';
      display: block;
      width: 8px;
      height: 8px;
      margin: 5px;
      border-radius: 50%;
      background: #fff;
    }

    .bus-online { background: #16a34a; }
    .bus-offline { background: #dc2626; }
  </style>
</head>
<body>
  <div id="map"></div>

  <script>
    (function () {
      var initialLat = ${KIOT_LAT};
      var initialLng = ${KIOT_LNG};

// Compute the minimum zoom so the map always fills the entire screen
      // (never showing white background). Leaflet's world at zoom 0 is 256px
      // wide; to cover the viewport we need the map's pixel size >= the
      // largest screen dimension. We use the bigger of width/height so both
      // portrait and landscape stay fully covered.
      function computeMinZoom() {
        var size = window.innerWidth;
        if (window.innerHeight > size) size = window.innerHeight;
        // 256 * 2^z >= size  =>  z >= log2(size / 256)
        var z = Math.ceil(Math.log(size / 256) / Math.LN2);
        return Math.max(0, z);
      }

      var minZoom = computeMinZoom();

// Constrain panning to the world bounds so dragging can never reveal
      // the blank background beyond the map's vertical edges (Leaflet does not
      // wrap vertically). high viscosity snaps the map back instead of letting
      // the user hold it at the edge (which would show white).
      var worldBounds = [[-85.0511, -180], [85.0511, 180]];

      var map = L.map('map', {
        zoomControl: false,
        minZoom: minZoom,
        maxBounds: worldBounds,
        maxBoundsViscosity: 1.0
      }).setView([initialLat, initialLng], 14);

      // Enable manual rotation (Leaflet rotate plugin)
      // Note: in many builds rotate is supported only with a plugin; keeping rotate:true for best-effort.

// Focus on the given coordinates WITHOUT changing zoom level.
      // Uses panTo so the current user zoom is preserved (no re-zooming on
      // every location update / refresh).
      function focusMap(lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return;
        map.panTo([lat, lng]);
      }



      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19
      }).addTo(map);

      // College location marker (static and independent from bus markers).
      var collegeIcon = L.divIcon({
        className: '',
        html: '<div class="college-marker"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 24]
      });
      L.marker([initialLat, initialLng], { icon: collegeIcon })
        .addTo(map)
        .bindPopup("KIOT College");

      var routeLayers = [];
      var routeRequestId = 0;
      var routeRequestController = null;
      var routeRequestTimeout = null;
      var activeRouteBus = null;
      var lastRequestedRoute = null;
      var lastRouteAnchor = null;
      var pendingRoute = null;
      var lastLocationTimestampByBus = {};
      var hasFocusedRoute = false;
      var hasFocusedFallback = false;

      function clearRouteLines() {
        routeRequestId += 1;
        if (routeRequestController) routeRequestController.abort();
        routeRequestController = null;
        if (routeRequestTimeout) clearTimeout(routeRequestTimeout);
        routeRequestTimeout = null;
        routeLayers.forEach(function (layer) {
          map.removeLayer(layer);
        });
        routeLayers = [];
        lastRequestedRoute = null;
        lastRouteAnchor = null;
        pendingRoute = null;
        hasFocusedRoute = false;
        hasFocusedFallback = false;
      }

      function routeDistanceMeters(pointA, pointB) {
        var toRadians = function (degrees) {
          return degrees * Math.PI / 180;
        };
        var latitudeA = toRadians(pointA.lat);
        var latitudeB = toRadians(pointB.lat);
        var latitudeDelta = latitudeB - latitudeA;
        var longitudeDelta = toRadians(pointB.lng - pointA.lng);
        var haversine =
          Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
          Math.cos(latitudeA) * Math.cos(latitudeB) *
          Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2);
        return 2 * 6371000 * Math.atan2(
          Math.sqrt(haversine),
          Math.sqrt(Math.max(0, 1 - haversine))
        );
      }

      function showPossibleRoutes(busKey, lat, lng) {
        var routeKey = lat + ',' + lng;
        if (document.hidden) {
          pendingRoute = { busKey: busKey, lat: lat, lng: lng };
          return;
        }
        if (lastRequestedRoute === routeKey) return;
        if (
          lastRouteAnchor &&
          routeDistanceMeters(lastRouteAnchor, { lat: lat, lng: lng }) <
            ${ROUTE_REFRESH_DISTANCE_METERS}
        ) {
          return;
        }
        lastRequestedRoute = routeKey;
        lastRouteAnchor = { lat: lat, lng: lng };
        var requestId = ++routeRequestId;
        if (routeRequestController) routeRequestController.abort();
        if (routeRequestTimeout) clearTimeout(routeRequestTimeout);
        routeRequestController =
          typeof AbortController !== 'undefined' ? new AbortController() : null;
        var fallbackLine = L.polyline(
          [[lat, lng], [${KIOT_LAT}, ${KIOT_LNG}]],
          {
            color: '#2563eb',
            weight: 4,
            opacity: 0.55,
            dashArray: '7 8',
            lineCap: 'round',
            lineJoin: 'round'
          }
        ).addTo(map);
        routeLayers.forEach(function (layer) {
          map.removeLayer(layer);
        });
        routeLayers = [fallbackLine];
        if (!hasFocusedFallback && !hasFocusedRoute) {
          map.fitBounds(
            L.latLngBounds([[${KIOT_LAT}, ${KIOT_LNG}], [lat, lng]]),
            { padding: [36, 36], maxZoom: 14 }
          );
          hasFocusedFallback = true;
        }
        var url = 'https://router.project-osrm.org/route/v1/driving/' +
          lng + ',' + lat + ';' + ${KIOT_LNG} + ',' + ${KIOT_LAT} +
          '?alternatives=true&overview=full&geometries=geojson';

        if (routeRequestController) {
          routeRequestTimeout = setTimeout(function () {
            routeRequestController.abort();
          }, 10000);
        }
        fetch(
          url,
          routeRequestController ? { signal: routeRequestController.signal } : undefined
        )
          .then(function (response) {
            if (!response.ok) throw new Error('Routing service returned ' + response.status);
            return response.json();
          })
          .then(function (data) {
            if (requestId !== routeRequestId || busKey !== activeRouteBus) return;
            if (!data || data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
              throw new Error('No road routes were returned');
            }

            var bounds = L.latLngBounds([[${KIOT_LAT}, ${KIOT_LNG}], [lat, lng]]);
            routeLayers.forEach(function (layer) {
              map.removeLayer(layer);
            });
            routeLayers = [];

            var colors = ['#2563eb', '#f97316', '#7c3aed'];
            data.routes.slice(0, 3).forEach(function (route, index) {
              var coordinates = route.geometry && route.geometry.coordinates;
              if (!Array.isArray(coordinates) || coordinates.length < 2) return;
              var points = coordinates.map(function (point) {
                return [point[1], point[0]];
              });
              var line = L.polyline(points, {
                color: colors[index % colors.length],
                weight: index === 0 ? 6 : 4,
                opacity: index === 0 ? 0.9 : 0.65,
                dashArray: index === 0 ? null : '8 8',
                lineCap: 'round',
                lineJoin: 'round'
              }).addTo(map);
              routeLayers.push(line);
              bounds.extend(line.getBounds());
            });

            if (routeLayers.length && !hasFocusedRoute) {
              map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
              hasFocusedRoute = true;
            }
          })
          .catch(function (error) {
            if (requestId === routeRequestId) {
              lastRequestedRoute = null;
              lastRouteAnchor = null;
              if (!error || error.name !== 'AbortError') {
                console.warn('Could not load live road-route alternatives.');
              }
            }
          })
          .finally(function () {
            if (requestId === routeRequestId) {
              if (routeRequestTimeout) clearTimeout(routeRequestTimeout);
              routeRequestTimeout = null;
              routeRequestController = null;
            }
          });
      }

      // Registry for bus markers (key -> marker)
      var busMarkers = {};
      var activeMarkerKey = null;

      function isFiniteNumber(x) {
        return typeof x === 'number' && isFinite(x);
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (character) {
          return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          }[character];
        });
      }

      function busIconHtml(offline, status, label) {
        var isOffline = offline || status === 'inactive' || status === 'offline';
        var className = isOffline ? 'bus-offline' : 'bus-online';
        return '<div class="bus-marker ' + className + '"><span class="bus-marker-number">' + escapeHtml(label) + '</span></div>';
      }

      function createBusMarker(offline, status, label) {
        var isOffline = offline || status === 'inactive' || status === 'offline';
        var icon = L.divIcon({
          className: '',
          html: busIconHtml(offline, status, label),
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });

        var m = L.marker([initialLat, initialLng], { icon: icon, interactive: false });
        m.addTo(map);
        m._isOffline = isOffline;
        m._status = isOffline ? 'offline' : 'online';
        return m;
      }

function upsertBusMarker(key, lat, lng, offline, status) {
  lat = Number(lat);
  lng = Number(lng);
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return;
  var isOffline = offline || status === 'inactive' || status === 'offline';
  var normalizedStatus = isOffline ? 'offline' : 'online';
  var marker = busMarkers[key];
  if (!marker) {
    busMarkers[key] = createBusMarker(isOffline, normalizedStatus, key);
    marker = busMarkers[key];
  } else if (marker._isOffline !== isOffline || marker._status !== normalizedStatus) {
    // Status changed — recreate marker with the correct color.
          map.removeLayer(marker);
          busMarkers[key] = createBusMarker(isOffline, normalizedStatus, key);
          marker = busMarkers[key];
        }
        marker.setLatLng([lat, lng]);
      }

      // Remove ALL bus markers and reset the registry. Used when a search is
      // cancelled or when a different bus is searched so only the actively
      // searched bus (or none, reverting to the KIOT default) ever shows.
      function clearAllBusMarkers() {
        var keys = Object.keys(busMarkers);
        for (var i = 0; i < keys.length; i++) {
          var m = busMarkers[keys[i]];
          if (m) {
            try { map.removeLayer(m); } catch (e) {}
          }
        }
        busMarkers = {};
      }

      function handleMessage(raw) {
        try {
          var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!data) return;

          // Clear all bus markers (cancel search / reset / not found)
          if (data.type === 'CLEAR_MARKERS') {
            clearAllBusMarkers();
            clearRouteLines();
            activeRouteBus = null;
            activeMarkerKey = null;
            return;
          }

          // Multi-bus payload — clear stale markers first, then render each.
          if (data.type === 'BUSES_LOCATION' && Array.isArray(data.buses)) {
            clearAllBusMarkers();
            clearRouteLines();
            activeRouteBus = null;
            activeMarkerKey = null;
            data.buses.forEach(function (b) {
              if (!b) return;
              var key = (b.busNo || b.bus_no || b.previewNumber || b.preview_number || '').toString();
              if (!key) return;
              upsertBusMarker(key, b.latitude, b.longitude, b.isOffline === true, b.markerStatus || b.status);
            });
            return;
          }

          // Single bus payload — STRICTLY only this bus. Clear all previous
          // markers so a previously searched bus never lingers on the map.
          if (data.type === 'BUS_LOCATION') {
            var keySingle = (data.previewNumber || data.preview_number || data.busNo || data.bus_no || 'single').toString();
            var incomingTimestamp = Date.parse(data.lastSuccessfulGpsUpdate);
            var previousTimestamp = lastLocationTimestampByBus[keySingle];
            if (
              isFinite(previousTimestamp) &&
              (!isFinite(incomingTimestamp) || incomingTimestamp < previousTimestamp)
            ) {
              return;
            }
            if (isFinite(incomingTimestamp)) {
              lastLocationTimestampByBus[keySingle] = incomingTimestamp;
            }
            if (activeRouteBus !== keySingle) {
              if (activeMarkerKey && busMarkers[activeMarkerKey]) {
                map.removeLayer(busMarkers[activeMarkerKey]);
                delete busMarkers[activeMarkerKey];
              }
              clearRouteLines();
              activeRouteBus = keySingle;
            }
            activeMarkerKey = keySingle;
            upsertBusMarker(
              keySingle,
              data.latitude,
              data.longitude,
              data.isOffline,
              data.markerStatus || data.status
            );
            var busLat = Number(data.latitude);
            var busLng = Number(data.longitude);
            if (data.isOffline === true || data.markerStatus === 'inactive') {
              clearRouteLines();
            } else if (isFinite(busLat) && isFinite(busLng)) {
              showPossibleRoutes(keySingle, busLat, busLng);
              if (!hasFocusedFallback && !hasFocusedRoute) {
                focusMap(busLat, busLng);
              }
            }
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
      window.addEventListener('message', function (event) {
        handleMessage(event.data);
      });

// Ensure Leaflet recalculates size after WebView layout settles.
      // Also recompute minZoom on resize/rotation so the map always fills the
      // entire screen (no white background) in both portrait and landscape.
      function safeResize() {
        try {
          var newMin = computeMinZoom();
          if (newMin !== minZoom) {
            minZoom = newMin;
            map.setMinZoom(minZoom);
            // If the current zoom dropped below the new minimum, snap back.
            if (map.getZoom() < minZoom) map.setZoom(minZoom);
          }
          map.invalidateSize(true);
        } catch (e) {}
      }
      setTimeout(safeResize, 0);
      setTimeout(safeResize, 300);

      window.addEventListener('resize', safeResize);

      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          safeResize();
          if (pendingRoute) {
            var route = pendingRoute;
            pendingRoute = null;
            showPossibleRoutes(route.busKey, route.lat, route.lng);
          }
        }
      });
    })();
  </script>
</body>
</html>
`, []);
  const mapSource = useMemo(() => ({ html, baseUrl: "" }), [html]);

  return (
    <WebView
      ref={webRef}
      source={mapSource}
      style={{ flex: 1, width: "100%", height: "100%" }}
      javaScriptEnabled
      domStorageEnabled
      onLoad={() => {
        webViewReadyRef.current = true;
        if (latestPayloadRef.current) {
          webRef.current?.postMessage(JSON.stringify(latestPayloadRef.current));
        }
      }}
      onLoadStart={() => {
        webViewReadyRef.current = false;
      }}
      originWhitelist={[
        "about:blank",
        "https://unpkg.com",
        "https://*.tile.openstreetmap.org",
        "https://router.project-osrm.org",
      ]}
      automaticallyAdjustContentInsets={false}
      scalesPageToFit={false}
      renderLoading={() => null}
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" ||
        request.url.startsWith("https://unpkg.com/") ||
        request.url.startsWith("https://router.project-osrm.org/") ||
        request.url.startsWith("https://a.tile.openstreetmap.org/") ||
        request.url.startsWith("https://b.tile.openstreetmap.org/") ||
        request.url.startsWith("https://c.tile.openstreetmap.org/")
      }
    />
  );
}
