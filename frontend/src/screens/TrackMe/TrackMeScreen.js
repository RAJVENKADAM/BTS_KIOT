import React, { useState, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../../api/api';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  StatusBar,
  ScrollView
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import * as Location from 'expo-location';
import locationService from '../../services/locationService';
import io from 'socket.io-client';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { Header, Subtitle, Body, MutedText } from '../../components/UI/Typography';
import Card from '../../components/UI/Card';
import Button from '../../components/UI/Button';

const TrackMeScreen = () => {
  const [isTracking, setIsTracking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [location, setLocation] = useState(null);
  const [lastUpdateTime, setLastUpdateTime] = useState(null);

  const { user, token } = useAuth();
  const socketRef = useRef(null);

  useEffect(() => {
    requestLocationPermission();
  }, []);

  useEffect(() => {
    let socket = null;

    if (isTracking && user && user.bus_no) {
      socket = io(API_BASE_URL.replace('http://', ''), {
        transports: ['websocket'],
        auth: {
          token: token
        }
      });

      socket.on('connect', () => {
        socket.emit('joinBusRoom', { busNo: user.bus_no });
      });

      const locationCallback = async (coords) => {
        await sendLocationUpdate(coords.latitude, coords.longitude);
        if (socket) {
          socket.emit('liveLocationUpdate', {
            busNo: user.bus_no,
            latitude: coords.latitude,
            longitude: coords.longitude,
            timestamp: new Date().toISOString()
          });
        }
      };

      locationService.startTracking(locationCallback);
    } else {
      locationService.stopTracking();
    }

    socketRef.current = socket;

    return () => {
      if (isTracking) {
        locationService.stopTracking();
      }

      if (socketRef.current && user && user.bus_no) {
        socketRef.current.emit('leaveBusRoom', { busNo: user.bus_no });
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [isTracking, user, token]);

  const requestLocationPermission = async () => {
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required for tracking.');
      }
    } catch (err) {
      console.warn(err);
    }
  };

  const toggleTracking = async () => {
    if (!user || !user.bus_no) {
      Alert.alert('Error', 'You are not assigned to a bus.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/track/toggle-tracking`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          action: isTracking ? 'stop' : 'start'
        })
      });

      const data = await response.json();

      if (response.ok) {
        setIsTracking(!isTracking);
        Alert.alert(
          'Success',
          `Tracking ${isTracking ? 'stopped' : 'started'} successfully`
        );
      } else {
        Alert.alert('Error', data.error || 'Failed to toggle tracking');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const sendLocationUpdate = async (lat, lng) => {
    if (!isTracking) return;

    try {
      const response = await fetch(`${API_BASE_URL}/api/track/location`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          latitude: lat,
          longitude: lng
        })
      });

      if (response.ok) {
        setLocation({ latitude: lat, longitude: lng });
        setLastUpdateTime(new Date());
      }
    } catch (error) {
      console.error('Send location error:', error);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.headerContainer}>
          <View style={styles.iconCircle}>
            <MaterialCommunityIcons name="broadcast" size={32} color={COLORS.primary} />
          </View>
          <Header>TrackMe</Header>
          <Subtitle>Real-time Bus Tracking System</Subtitle>
        </View>

        <Card style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View>
              <MutedText style={styles.label}>ASSIGNED BUS</MutedText>
              <Body style={styles.value}>{user?.bus_no || 'Not Assigned'}</Body>
            </View>
            <View style={[styles.statusBadge, isTracking ? styles.online : styles.offline]}>
              <View style={[styles.dot, isTracking ? styles.onlineDot : styles.offlineDot]} />
              <Text style={[styles.statusText, isTracking ? styles.onlineText : styles.offlineText]}>
                {isTracking ? 'ONLINE' : 'OFFLINE'}
              </Text>
            </View>
          </View>

          {location && (
            <View style={styles.locationInfo}>
              <View style={styles.divider} />
              <View style={styles.locationRow}>
                <Ionicons name="location" size={18} color={COLORS.primary} />
                <Body style={styles.coords}>
                  {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
                </Body>
              </View>
              {lastUpdateTime && (
                <MutedText style={styles.timeText}>
                  Last updated: {lastUpdateTime.toLocaleTimeString()}
                </MutedText>
              )}
            </View>
          )}
        </Card>

        <View style={styles.controls}>
          <Button
            title={isTracking ? 'STOP TRACKING' : 'START TRACKING'}
            onPress={toggleTracking}
            loading={loading}
            style={isTracking ? styles.stopButton : styles.startButton}
            textStyle={isTracking ? styles.stopButtonText : {}}
          />
        </View>

        <Card style={styles.instructionCard}>
          <Header style={styles.instrTitle}>Instructions</Header>
          <View style={styles.instrItem}>
            <View style={styles.instrDot} />
            <Body style={styles.instrText}>Tap START TRACKING to begin location sharing</Body>
          </View>
          <View style={styles.instrItem}>
            <View style={styles.instrDot} />
            <Body style={styles.instrText}>Your location will be shared in real-time with users</Body>
          </View>
          <View style={styles.instrItem}>
            <View style={styles.instrDot} />
            <Body style={styles.instrText}>Tap STOP TRACKING when your trip is complete</Body>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
};


const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    padding: SPACING.screenPadding,
    paddingBottom: 40,
  },
  headerContainer: {
    alignItems: 'center',
    marginBottom: 32,
    marginTop: 10,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    ...SHADOWS.soft,
  },
  statusCard: {
    padding: 24,
    marginBottom: 24,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  online: {
    backgroundColor: '#E1FCEF',
  },
  offline: {
    backgroundColor: '#FEE2E2',
  },
  onlineDot: {
    backgroundColor: COLORS.success,
  },
  offlineDot: {
    backgroundColor: COLORS.error,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  onlineText: {
    color: COLORS.success,
  },
  offlineText: {
    color: COLORS.error,
  },
  locationInfo: {
    marginTop: 20,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginBottom: 20,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  coords: {
    marginLeft: 8,
    fontWeight: '600',
    fontSize: 16,
  },
  timeText: {
    marginTop: 8,
    fontStyle: 'italic',
  },
  controls: {
    marginBottom: 32,
  },
  startButton: {
    backgroundColor: COLORS.primary,
  },
  stopButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: COLORS.error,
    elevation: 0,
    shadowOpacity: 0,
  },
  stopButtonText: {
    color: COLORS.error,
  },
  instructionCard: {
    padding: 24,
    backgroundColor: '#F1F5F9',
    borderColor: 'transparent',
  },
  instrTitle: {
    fontSize: 16,
    marginBottom: 16,
  },
  instrItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  instrDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.primary,
    marginRight: 12,
  },
  instrText: {
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
  },
});

export default TrackMeScreen;
