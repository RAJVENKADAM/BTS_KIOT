import * as Location from 'expo-location';
import { Alert, Platform } from 'react-native';

class LocationService {
  constructor() {
    this.watchId = null;
    this.isTracking = false;
    this.locationCallback = null;
  }

  // Request location permissions
  async requestPermissions() {
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        // If foreground permission is not granted, try background on iOS
        if (Platform.OS === 'ios') {
          ({ status } = await Location.requestBackgroundPermissionsAsync());
        }
      }

      return status === 'granted';
    } catch (error) {
      console.error('Error requesting location permission:', error);
      return false;
    }
  }

  // Start tracking location
  async startTracking(callback) {
    const hasPermission = await this.requestPermissions();
    
    if (!hasPermission) {
      Alert.alert('Permission Required', 'Location permission is required for tracking.');
      return false;
    }

    if (this.isTracking) {
      return true;
    }

    this.locationCallback = callback;
    this.isTracking = true;

    // Start watching position
    this.watchId = await Location.watchPositionAsync(
      {
        enableHighAccuracy: true,
        accuracy: Location.Accuracy.High,
        distanceInterval: 10, // Update every 10 meters
        timeInterval: 5000, // Update every 5 seconds
      },
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        
        // Call the callback with new location data
        if (this.locationCallback) {
          this.locationCallback({
            latitude,
            longitude,
            accuracy,
            timestamp: position.timestamp
          });
        }
      }
    );

    return true;
  }

  // Stop tracking location
  stopTracking() {
    if (this.watchId !== null) {
      this.watchId.remove();
      this.watchId = null;
      this.isTracking = false;
      this.locationCallback = null;
    }
  }

  // Get current position once
  async getCurrentPosition() {
    const hasPermission = await this.requestPermissions();
    
    if (!hasPermission) {
      throw new Error('Location permission denied');
    }

    try {
      const position = await Location.getCurrentPositionAsync({
        enableHighAccuracy: true,
        accuracy: Location.Accuracy.High,
        timeout: 15000,
        maximumAge: 10000,
      });
      return position.coords;
    } catch (error) {
      console.error('Location error:', error);
      throw error;
    }
  }

  // Check if tracking is active
  getTrackingStatus() {
    return this.isTracking;
  }
}

// Export a singleton instance
const locationService = new LocationService();
export default locationService;