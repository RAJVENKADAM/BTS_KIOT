import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
  Platform
} from 'react-native';

// Conditional import for web compatibility
let MapView, Marker, Callout, PROVIDER_GOOGLE;

// Check if running on web environment
const isWeb = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isWeb) {
  // Web environment - render a placeholder or use web maps
  MapView = ({ children, style, initialRegion, showsUserLocation, showsMyLocationButton, 
           showsCompass, zoomEnabled, scrollEnabled, pitchEnabled, rotateEnabled }) => (
    <View style={[styles.map, style, styles.webMapContainer]}>
      <Text style={styles.webMapPlaceholder}>Map functionality not available on web</Text>
      <Text style={styles.webMapHint}>Use mobile app for map features</Text>
      {children}
    </View>
  );
  
  Marker = ({ children, coordinate, pinColor }) => (
    <View style={styles.webMarkerPlaceholder}>
      {children}
    </View>
  );
  
  Callout = ({ children }) => <View style={styles.webCallout}>{children}</View>;
  PROVIDER_GOOGLE = null; // Not used on web
} else {
  // Native environment
  const RNMaps = require('react-native-maps');
  MapView = RNMaps.default;
  ({ Marker, Callout, PROVIDER_GOOGLE } = RNMaps);
}

import { useAuth } from '../../context/AuthContext';

const MapComponent = ({ busData, destination }) => {
  const [mapRegion, setMapRegion] = useState({
    latitude: 11.55,
    longitude: 78.02,
    latitudeDelta: 0.0922,
    longitudeDelta: 0.0421,
  });
  
  const animatedValue = useRef(new Animated.Value(0)).current;
  const { token } = useAuth();
  const mapRef = useRef(null);

  // Animate marker when bus data updates
  useEffect(() => {
    if (busData && busData.latitude && busData.longitude) {
      // Update map region to center on the bus
      setMapRegion({
        latitude: busData.latitude,
        longitude: busData.longitude,
        latitudeDelta: 0.0922,
        longitudeDelta: 0.0421,
      });

      // Animate the marker
      Animated.loop(
        Animated.sequence([
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(animatedValue, {
            toValue: 0,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      ).start();
    }
  }, [busData, animatedValue]);

  // Fit to bus and destination markers
  useEffect(() => {
    if (mapRef.current && busData && busData.latitude && busData.longitude) {
      const coordinates = [busData];
      
      // Add destination if it exists
      if (destination && destination.latitude && destination.longitude) {
        coordinates.push(destination);
      }
      
      if (coordinates.length > 0) {
        setTimeout(() => {
          mapRef.current.fitToCoordinates(coordinates, {
            edgePadding: { top: 50, right: 50, bottom: 200, left: 50 },
            animated: true,
          });
        }, 100);
      }
    }
  }, [busData, destination]);

  // Calculate distance between two points (in km)
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in km
  };

  // Calculate ETA (in minutes) - assuming average speed of 30 km/h
  const calculateETA = (distance) => {
    if (distance <= 0) return 0;
    return Math.round((distance / 30) * 60); // time = distance/speed * 60 minutes
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE || undefined}
        style={styles.map}
        initialRegion={mapRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={true}
        zoomEnabled={true}
        scrollEnabled={true}
        pitchEnabled={false}
        rotateEnabled={false}
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

        {/* Bus Marker */}
        {busData && busData.latitude && busData.longitude && (
          <Marker
            coordinate={{
              latitude: busData.latitude,
              longitude: busData.longitude,
            }}
            pinColor={busData.isOnline ? 'green' : 'red'}
          >
            <Animated.View 
              style={[
                styles.animatedMarker,
                {
                  transform: [{
                    scale: animatedValue.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1.2]
                    })
                  }]
                }
              ]}
            >
              <View style={[
                styles.busMarker,
                { backgroundColor: busData.isOnline ? '#27ae60' : '#e74c3c' }
              ]}>
                <Text style={styles.busMarkerText}>{busData.busNo}</Text>
              </View>
            </Animated.View>
            
            <Callout tooltip>
              <View style={styles.callout}>
                <View style={styles.calloutInner}>
                  <Text style={styles.calloutText}>Bus: {busData.busNo}</Text>
                  <Text style={styles.calloutText}>Status: {busData.isOnline ? 'Online' : 'Offline'}</Text>
                  {busData.driverName && (
                    <Text style={styles.calloutText}>Driver: {busData.driverName}</Text>
                  )}
                  {destination && destination.latitude && destination.longitude && (
                    <>
                      <Text style={styles.calloutText}>
                        Distance: {calculateDistance(busData.latitude, busData.longitude, destination.latitude, destination.longitude).toFixed(2)} km
                      </Text>
                      <Text style={styles.calloutText}>
                        ETA: {calculateETA(calculateDistance(busData.latitude, busData.longitude, destination.latitude, destination.longitude))} min
                      </Text>
                    </>
                  )}
                </View>
              </View>
            </Callout>
          </Marker>
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
  animatedMarker: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  busMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#27ae60',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  busMarkerText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12,
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
});

export default MapComponent;