import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
  Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Conditional import for web compatibility
let MapView, Marker, Callout, PROVIDER_GOOGLE, AnimatedRegion;

// Check if running on web environment
const isWeb = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isWeb) {
  // Web environment - render a placeholder or use web maps
  MapView = ({ children, style }) => (
    <View style={[styles.map, style, styles.webMapContainer]}>
      <Text style={styles.webMapPlaceholder}>Map functionality not available on web</Text>
      <Text style={styles.webMapHint}>Use mobile app for map features</Text>
      {children}
    </View>
  );

  Marker = ({ children }) => <View style={styles.webMarkerPlaceholder}>{children}</View>;
  Marker.Animated = Marker; // Mock for web

  Callout = ({ children }) => <View style={styles.webCallout}>{children}</View>;
  PROVIDER_GOOGLE = null;

  // Mock AnimatedRegion for web to prevent reference errors
  AnimatedRegion = class {
    constructor(config) {
      this.latitude = config.latitude || 0;
      this.longitude = config.longitude || 0;
    }
    timing() { return { start: () => { } }; }
    setValue() { }
  };
} else {
  // Native environment
  const RNMaps = require('react-native-maps');
  MapView = RNMaps.default;
  ({ Marker, Callout, PROVIDER_GOOGLE, AnimatedRegion } = RNMaps);
}



const MapComponent = ({ busData, destination, markerStatus = 'moving', autoFocus = false, onAutoFocusDone, onUserInteraction }) => {
  // FIX: Ensure mapRegion is defined
  const [mapRegion, setMapRegion] = useState({
    latitude: 11.554528,
    longitude: 78.019759,
    latitudeDelta: 0.0922,
    longitudeDelta: 0.0421,
  });

  // Pulse Animation Value
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const bounceAnimRef = useRef(null);

  // AnimatedRegion for the bus movement
  const [coordinate] = useState(new AnimatedRegion({
    latitude: 11.554528,
    longitude: 78.019759,
    latitudeDelta: 0,
    longitudeDelta: 0
  }));


  const mapRef = useRef(null);

  const statusStyles = {
    moving: {
      borderColor: '#2ecc71',
      backgroundColor: 'rgba(46, 204, 113, 0.18)',
      borderWidth: 2,
      borderStyle: 'dotted',
    },
    stopped: {
      borderColor: '#c0392b',
      backgroundColor: '#e74c3c',
      borderWidth: 2,
      borderStyle: 'solid',
    },
  };

  // Animate marker when bus data updates
  useEffect(() => {
  if (busData?.latitude && busData?.longitude) {
    const newCoord = {
      latitude: busData.latitude,
      longitude: busData.longitude,
    };

    coordinate.timing({
      ...newCoord,
      duration: 1500,
      useNativeDriver: false,
    }).start();

    // 🔥 Important fallback fix
    coordinate.setValue(newCoord);
  }
}, [busData]);

  useEffect(() => {
    const duration = markerStatus === 'moving' ? 1200 : 2000;
    bounceAnim.setValue(0);
    bounceAnimRef.current?.stop();

    bounceAnimRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: 1,
          duration,
          useNativeDriver: true,
        }),
        Animated.timing(bounceAnim, {
          toValue: 0,
          duration,
          useNativeDriver: true,
        }),
      ])
    );

    bounceAnimRef.current.start();

    return () => {
      bounceAnimRef.current?.stop();
    };
  }, [markerStatus]);

  const markerTranslateY = bounceAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -6],
  });

  const userInteractedRef = useRef(false);

  useEffect(() => {
    if (autoFocus) {
      userInteractedRef.current = false;
    }
  }, [autoFocus]);

  // Fit to bus and destination markers only when autoFocus is requested.
  useEffect(() => {
    if (!autoFocus || userInteractedRef.current || !mapRef.current) return;
    if (!busData || !busData.latitude || !busData.longitude) return;

    const coordinates = [busData];
    if (destination && destination.latitude && destination.longitude) {
      coordinates.push(destination);
    }

    if (coordinates.length > 0) {
      setTimeout(() => {
        mapRef.current.fitToCoordinates(coordinates, {
          edgePadding: { top: 50, right: 50, bottom: 200, left: 50 },
          animated: true,
        });
        if (onAutoFocusDone) onAutoFocusDone();
      }, 100);
    }
  }, [autoFocus, busData, destination, onAutoFocusDone]);

  useEffect(() => {
  const startAnimation = () => {
    pulseAnim.setValue(0);
    Animated.loop(
      Animated.timing(pulseAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: false, // Required for transform/opacity on non-native props
      })
    ).start();
  };

  startAnimation();
}, []);
  // Calculate distance between two points (in km)
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  };

  // Calculate ETA (in minutes) - assuming average speed of 30 km/h
  const calculateETA = (distance) => {
    if (distance <= 0) return 0;
    return Math.round((distance / 30) * 60); // time = distance/speed * 60 minutes
  };
useEffect(() => {
  const animation = Animated.loop(
    Animated.timing(pulseAnim, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: false,
    })
  );

  animation.start();

  return () => {
    animation.stop(); // 🔥 important
  };
}, []);
  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE || undefined}
        style={styles.map}
        initialRegion={mapRegion}
        showsUserLocation={true}
        showsMyLocationButton={true}
        showsCompass={true}
        zoomEnabled={true}
        scrollEnabled={true}
        pitchEnabled={false}
        rotateEnabled={false}
        onPanDrag={() => {
          if (!userInteractedRef.current) {
            userInteractedRef.current = true;
            if (onUserInteraction) onUserInteraction();
          }
        }}
      >
        {/* Destination Marker - only show if destination is valid */}
        {destination && destination.latitude && destination.longitude && (
          <Marker
            coordinate={destination}
            pinColor="red"
          >
            <Callout tooltip>
              <View style={styles.destinationCallout}>
                <View style={styles.destinationCalloutInner}>
                  <Text style={styles.destinationCalloutText}>Destination</Text>
                </View>
              </View>
            </Callout>
          </Marker>
        )}

        {/* KIOT College Marker */}
        <Marker
          coordinate={{
            latitude: 11.554528,
            longitude: 78.019759,
          }}
          pinColor="green"
        >
          <Callout tooltip>
            <View style={styles.kiotCallout}>
              <View style={styles.kiotCalloutInner}>
                <Text style={styles.kiotCalloutText}>KIOT College</Text>
              </View>
            </View>
          </Callout>
        </Marker>

        {/* Bus Marker */}
        {busData && busData.latitude && busData.longitude && (
  <Marker.Animated
    coordinate={coordinate}
    anchor={{ x: 0.5, y: 0.5 }} // FIXED
    flat={false}
  >
    <View style={styles.whiteCore}>
      <View
        style={[
          styles.solidCircle,
          {
            backgroundColor:
              markerStatus === 'moving' ? '#2ecc71' : '#e74c3c',
          },
        ]}
      />
    </View>
  </Marker.Animated>
)}

        {/* Route Line (if route data is available) */}
        {busData && busData.route && busData.route.length > 0 && (
          <MapView.Polyline
            coordinates={busData.route}
            strokeColor="#3498db"
            strokeWidth={4}
          />
        )}
      </MapView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    width: '100%',
    height: '100%',
  },
  statusMarker: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 5,
  },
  statusCenter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#27ae60',
  },
  waitingCenter: {
    backgroundColor: '#f39c12',
  },
  stoppedCenter: {
    backgroundColor: '#c0392b',
  },
  destinationCallout: {
    width: 100,
    backgroundColor: 'transparent',
  },
  destinationCalloutInner: {
    backgroundColor: '#e74c3c',
    padding: 10,
    borderRadius: 5,
  },
  destinationCalloutText: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
  },
  kiotCallout: {
    width: 120,
    backgroundColor: 'transparent',
  },
  kiotCalloutInner: {
    backgroundColor: '#27ae60',
    padding: 10,
    borderRadius: 5,
  },
  kiotCalloutText: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
  },
  callout: {
    width: 150,
    backgroundColor: 'transparent',
  },
  calloutInner: {
    backgroundColor: '#34495e',
    padding: 10,
    borderRadius: 5,
  },
  calloutText: {
    color: '#fff',
    fontSize: 12,
    marginBottom: 3,
  },
  webMapContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  webMapPlaceholder: {
    fontSize: 16,
    textAlign: 'center',
    marginVertical: 20,
    color: '#666',
  },
  webMapHint: {
    fontSize: 14,
    textAlign: 'center',
    color: '#888',
    fontStyle: 'italic',
  },
  webMarkerPlaceholder: {
    // Placeholder for web marker
  },
  webCallout: {
    // Placeholder for web callout
  },
  markerWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  pulseRing: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    zIndex: 1,
  },
  solidCircle: {
    width: 25,
    height: 25,
    borderColor: '#ffffff',
    borderWidth: 2,
    borderRadius: 15, // Exactly half of width/height for a perfect circle
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 10,
    zIndex: 100, // Keeps it well above the pulse
  },
  whiteCore: {
    width: 0,
    height: 0,
    borderRadius: 4,
    backgroundColor: 'white',
    zIndex: 100,
  },
});

export default MapComponent;