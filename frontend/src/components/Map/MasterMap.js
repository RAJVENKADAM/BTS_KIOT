import React, { useEffect, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";

const KIOT_COLLEGE = { latitude: 11.554528, longitude: 78.019759 };

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
    .college { background: #7c3aed; }
    .route-stop {
      width: 24px;
      height: 24px;
      border: 2px solid white;
      border-radius: 50%;
      background: #1d4ed8;
      color: white;
      font: 700 12px/24px Arial, sans-serif;
      text-align: center;
      box-shadow: 0 1px 5px #33415599;
    }
    .leaflet-popup-content { font: 14px Arial, sans-serif; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function () {
      var map = L.map('map', {
        zoomControl: false,
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
      map.attributionControl.setPrefix(false);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(map);

      var markers = {};
      var routeStopMarkers = {};
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

      function updateRouteStops(stops) {
        var activeKeys = {};
        (Array.isArray(stops) ? stops : []).forEach(function (stop, index) {
          if (!stop) return;
          var key = String(stop.stopId || index);
          activeKeys[key] = true;
          var marker = routeStopMarkers[key];
          var point = [stop.latitude, stop.longitude];
          var popup = '<b>' + escapeHtml(stop.sequence || index + 1) + '. ' +
            escapeHtml(stop.name || 'Bus stop') + '</b>';
          if (marker) {
            marker.setLatLng(point);
            marker.setPopupContent(popup);
            return;
          }
          marker = L.marker(point, {
            icon: L.divIcon({
              className: '',
              html: '<div class="route-stop">' +
                escapeHtml(stop.sequence || index + 1) + '</div>',
              iconSize: [24, 24],
              iconAnchor: [12, 12]
            })
          }).addTo(map).bindPopup(popup);
          routeStopMarkers[key] = marker;
        });
        Object.keys(routeStopMarkers).forEach(function (key) {
          if (activeKeys[key]) return;
          map.removeLayer(routeStopMarkers[key]);
          delete routeStopMarkers[key];
        });
      }

      function updateRoadRoute(stops, college) {
        var waypoints = (Array.isArray(stops) ? stops : [])
          .filter(function (point) {
            return point && isFinite(Number(point.latitude)) &&
              isFinite(Number(point.longitude));
          })
          .map(function (point) {
            return [Number(point.latitude), Number(point.longitude)];
          });
        if (college && isFinite(Number(college.latitude)) &&
            isFinite(Number(college.longitude))) {
          var lastWaypoint = waypoints[waypoints.length - 1];
          if (!lastWaypoint || lastWaypoint[0] !== Number(college.latitude) ||
              lastWaypoint[1] !== Number(college.longitude)) {
            waypoints.push([Number(college.latitude), Number(college.longitude)]);
          }
        }

        if (waypoints.length < 2) {
          routeRequestId += 1;
          lastRequestedRoute = null;
          if (routeLine) {
            map.removeLayer(routeLine);
            routeLine = null;
          }
          return;
        }

        var routeKey = waypoints.map(function (point) {
          return point.join(',');
        }).join(';');
        if (routeKey === lastRequestedRoute) return;
        lastRequestedRoute = routeKey;
        var requestId = ++routeRequestId;
        if (routeLine) {
          map.removeLayer(routeLine);
          routeLine = null;
        }
        var coordinates = waypoints.map(function (point) {
          return point[1] + ',' + point[0];
        }).join(';');
        var url = 'https://router.project-osrm.org/route/v1/driving/' +
          coordinates +
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
          'college',
          data.college,
          'college',
          'KIOT College',
          'Route destination'
        );
        updateRouteStops(data.routeStops);
        var stopMarker = data.isCollegeDestination ? null : data.stop;
        updateMarker(
          'stop',
          stopMarker,
          'stop',
          'Recommended stop',
          stopMarker ? [
            data.stopName || 'Recommended stop',
            'Approx. walk: ' + (data.walkingEtaMinutes == null
              ? 'time unavailable'
              : data.walkingEtaMinutes + ' min') +
              (data.walkingDistance == null
                ? ''
                : ' · ' + formatDistance(data.walkingDistance)),
            'Coordinates: ' + formatCoordinates(data.stop)
          ] : []
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

        updateRoadRoute(data.routeStops, data.college);

        var targetKey = data.routeStops && data.routeStops.length
          ? [data.busNumber || '', data.routeStops.map(function (stop) {
              return [stop.stopId || '', stop.latitude, stop.longitude].join(',');
            }).join(';'), data.college && data.college.latitude,
            data.college && data.college.longitude].join(':')
          : null;
        if (targetKey && targetKey !== lastFocusedTarget) {
          var focusPoints = data.routeStops.concat(data.college ? [data.college] : [])
            .filter(Boolean).map(function (point) {
            return [point.latitude, point.longitude];
          });
          if (!focusPoints.length && data.stop) {
            focusPoints.push([data.stop.latitude, data.stop.longitude]);
          }
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
      college: toPoint(result.collegeLocation) || KIOT_COLLEGE,
      routeStops: (Array.isArray(result.routeStops) ? result.routeStops : [])
        .map((stop) => {
          const point = toPoint(stop);
          return point
            ? {
                ...point,
                stopId: stop.stopId,
                name: stop.name,
                sequence: stop.sequence,
              }
            : null;
        })
        .filter(Boolean),
      stopId: result.stop?.stopId,
      stopName: result.stop?.name || "Recommended stop",
      busNumber: result.serviceBusNumbers?.length
        ? result.serviceBusNumbers.join(" + ")
        : result.busNumber || "Nearest active bus",
      userDistance: result.userDistanceToStop,
      isCollegeDestination: result.isCollegeDestination === true,
      walkingDistance: result.walkingDistanceMeters,
      walkingEtaMinutes: result.walkingEtaMinutes,
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
