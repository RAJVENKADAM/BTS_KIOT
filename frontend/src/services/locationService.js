import * as Location from 'expo-location';
import { Alert, Platform } from 'react-native';

class LocationService {
  constructor() {
    this.intervalId = null;
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

  // Start tracking location - NOW every 30 seconds exactly
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

    // Fetch immediately first
    try {
      console.log('📍 Initial GPS fetch...');
      const position = await Location.getCurrentPositionAsync({
        enableHighAccuracy: true,
        accuracy: Location.Accuracy.High,
        timeout: 15000,
        maximumAge: 10000,
      });
      const { latitude, longitude, accuracy } = position.coords;
      if (this.locationCallback) {
        this.locationCallback({
          latitude,
          longitude,
          accuracy,
          timestamp: position.timestamp
        });
      }
    } catch (error) {
      console.error('Initial GPS fetch error:', error);
    }

    // Set 30-second interval for rate limit compliance
    this.intervalId = setInterval(async () => {
      if (!this.isTracking || !this.locationCallback) return;
      
      try {
        console.log('📍 GPS fetch every 30s...');
        const position = await Location.getCurrentPositionAsync({
          enableHighAccuracy: true,
          accuracy: Location.Accuracy.High,
          timeout: 15000,
          maximumAge: 29000, // Almost 30s max age
        });
        const { latitude, longitude, accuracy } = position.coords;
        if (this.locationCallback) {
          this.locationCallback({
            latitude,
            longitude,
            accuracy,
            timestamp: position.timestamp
          });
        }
      } catch (error) {
        console.error('Periodic GPS fetch error:', error);
        // Don't stop tracking on single failure
      }
    }, 30000); // Exactly 30 seconds

    console.log('✅ GPS tracking started - 30s intervals');
    return true;
  }

  // Stop tracking location
  stopTracking() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isTracking = false;
    this.locationCallback = null;
    console.log('🛑 GPS tracking stopped');
  }

  // Get current position once (unchanged)
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

