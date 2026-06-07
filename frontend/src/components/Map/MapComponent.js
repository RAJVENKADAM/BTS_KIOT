import React, { useEffect, useMemo, useRef } from 'react';
import MapView, {
  Circle,
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  UrlTile,
} from 'react-native-maps';

const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const toCoord = (lat, lng) => {
  if (!isNum(lat) || !isNum(lng)) return null;
  return { latitude: lat, longitude: lng };
};

function safeLatLngOrFallback({ latitude, longitude }, fallback) {
  const c = toCoord(latitude, longitude);
  return c || fallback;
}

export default function MapComponent({
  busData,
  markerStatus,
  autoFocus,
  animate = false,
  onAutoFocusDone,
  onUserInteraction,
  // user location props (optional; app may set them elsewhere)
  userLocation,
  routeStops = [],
  routePolylineCoords = [],
}) {
  const mapRef = useRef(null);

  const fallbackRegion = useMemo(
    () => ({
      latitude: KIOT_LAT,
      longitude: KIOT_LNG,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    }),
    []
  );

  const busCoord = useMemo(() => {
    if (!busData) return null;
    const lat = busData.latitude ?? busData.lat;
    const lng = busData.longitude ?? busData.lng;
    return toCoord(lat, lng);
  }, [busData]);

  const userCoord = useMemo(() => {
    const lat = userLocation?.latitude;
    const lng = userLocation?.longitude;
    // If caller doesn't provide userLocation, we intentionally keep it null.
    return toCoord(lat, lng);
  }, [userLocation]);

  const initialRegion = useMemo(() => {
    // Never provide a null/undefined coordinate to initialRegion.
    const c = busCoord || userCoord;
    return c
      ? {
          ...c,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }
      : fallbackRegion;
  }, [busCoord, userCoord, fallbackRegion]);

  const polylineCoords = useMemo(() => {
    if (Array.isArray(routePolylineCoords) && routePolylineCoords.length) {
      return routePolylineCoords
        .map((p) => toCoord(p?.latitude, p?.longitude) || toCoord(p?.lat, p?.lng))
        .filter(Boolean);
    }

    // Fallback: derive from routeStops if provided as "lat,lng" strings.
    if (!Array.isArray(routeStops) || routeStops.length === 0) return [];
    const coords = [];
    for (const stop of routeStops) {
      if (typeof stop === 'string') {
        const parts = stop.split(',').map((x) => x.trim());
        if (parts.length >= 2) {
          const lat = Number(parts[0]);
          const lng = Number(parts[1]);
          const c = toCoord(lat, lng);
          if (c) coords.push(c);
        }
      } else if (stop && typeof stop === 'object') {
        const c = toCoord(stop?.latitude, stop?.longitude) || toCoord(stop?.lat, stop?.lng);
        if (c) coords.push(c);
      }
    }
    return coords;
  }, [routeStops, routePolylineCoords]);

  // Auto-focus / fitToCoordinates
  useEffect(() => {
    if (!autoFocus) return;
    if (!mapRef.current) return;

    const coordsToFit = [];
    if (busCoord) coordsToFit.push(busCoord);
    if (userCoord) coordsToFit.push(userCoord);

    const shouldFit = coordsToFit.length > 0;
    const fallback = { latitude: KIOT_LAT, longitude: KIOT_LNG };
    const target = shouldFit ? coordsToFit : [fallback];

    // If fitToCoordinates gets an empty array, some native versions can crash.
    const safeTarget = Array.isArray(target) && target.length ? target : [fallback];

    try {
      mapRef.current.fitToCoordinates(safeTarget, {
        edgePadding: { top: 80, right: 40, bottom: 120, left: 40 },
        animated: !!animate,
      });
    } catch (e) {
      // As a fallback, just animate to the bus coordinate (or KIOT).
      const c = safeLatLngOrFallback(busCoord ? { latitude: busCoord.latitude, longitude: busCoord.longitude } : null, fallback);
      try {
        mapRef.current.animateToRegion(
          {
            latitude: c.latitude,
            longitude: c.longitude,
            latitudeDelta: 0.05,
            longitudeDelta: 0.05,
          },
          !!animate
        );
      } catch (_) {
        // ignore
      }
    }

    onAutoFocusDone?.();
  }, [autoFocus, animate, busCoord, userCoord, onAutoFocusDone]);

  return (
    <MapView
      ref={mapRef}
  style={{ flex: 1 }}
  initialRegion={initialRegion}
  provider={PROVIDER_DEFAULT}
  rotateEnabled={true}
  pitchEnabled={false}

  scrollEnabled={true}
  zoomEnabled={true}
  onTouchStart={() => onUserInteraction?.()}
  onPanDrag={() => onUserInteraction?.()}
  showsUserLocation={false}
      // Prevent “black screen” scenarios by never letting the map be uninitialized.
      
      onMapReady={() => {
        // noop: leaving hook for future compatibility
      }}
      // iOS: helps avoid blank map when used with tiles

    >
      {/* OpenStreetMap tiles (no API key) */}
      <UrlTile
        urlTemplate={'https://tile.openstreetmap.org/{z}/{x}/{y}.png'}
        maximumZ={19}
        flipY={false}
      />

      {/* Bus marker */}
      {busCoord ? (
        <Marker coordinate={busCoord} tracksViewChanges={false}>
  <>
    {/* outer glow */}
    <Circle
      center={busCoord}
      radius={72}
      fillColor={
        markerStatus === 'stopped'
          ? 'rgba(255, 0, 0, 0.07)'
          : 'rgba(0, 200, 100, 0.07)'
      }
    />

    {/* mid glow (bigger) */}
    <Circle
      center={busCoord}
      radius={36}
      fillColor={
        markerStatus === 'stopped'
          ? 'rgba(255, 0, 0, 0.18)'
          : 'rgba(0, 200, 100, 0.18)'
      }
    />

    {/* center dot (bigger) */}
    <Circle
      center={busCoord}
      radius={10}
      fillColor={markerStatus === 'stopped' ? '#ff3b30' : '#00c853'}
      strokeColor="white"
      strokeWidth={2}
    />
  </>
</Marker>
      ) : null}

      {/* User marker (only if provided) */}
      {userCoord ? (
        <Marker coordinate={userCoord} title={'You'}>
          <React.Fragment>
            <Circle
              center={userCoord}
              radius={25}
              fillColor={'rgba(59, 130, 246, 0.25)'}
              strokeWidth={0}
            />
            <Circle
              center={userCoord}
              radius={8}
              fillColor={'rgba(59, 130, 246, 0.95)'}
              strokeColor={'white'}
              strokeWidth={2}
            />
          </React.Fragment>
        </Marker>
      ) : null}

      {/* Route polyline */}
      {polylineCoords.length > 0 ? (
        <Polyline
          coordinates={polylineCoords}
          strokeWidth={4}
          strokeColor={'rgba(255, 165, 0, 0.95)'}
          fillColor={'rgba(255, 165, 0, 0.45)'}
          lineCap={'round'}
          lineJoin={'round'}
        />
      ) : null}
    </MapView>
  );
}
