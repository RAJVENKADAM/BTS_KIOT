import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import io from 'socket.io-client';
import { API_BASE_URL } from '../api/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TRACKING_TASK_NAME = 'BACKGROUND_BUS_TRACKING';
let socket = null;

// Initialize socket for background use
const getSocket = async () => {
    if (socket && socket.connected) return socket;

    const token = await AsyncStorage.getItem('token');
    socket = io(`${API_BASE_URL}/bus-location`, {
        path: '/socket.io/',
        transports: ['websocket'],
        auth: { token }
    });
    return socket;
};

TaskManager.defineTask(TRACKING_TASK_NAME, async ({ data, error }) => {
    if (error) {
        console.error('Background tracking task error:', error);
        return;
    }
    if (data) {
        const { locations } = data;
        const location = locations[0];
        if (location) {
            try {
                const userData = await AsyncStorage.getItem('user');
                const user = userData ? JSON.parse(userData) : null;

                if (user && user.bus_no) {
                    const skt = await getSocket();
                    skt.emit('update-mobile-location', {
                        userId: user.id,
                        bus_no: user.bus_no,
                        latitude: location.coords.latitude,
                        longitude: location.coords.longitude,
                        speed: location.coords.speed,
                        heading: location.coords.heading,
                        timestamp: location.timestamp
                    });
                }
            } catch (err) {
                console.error('Failed to send background location:', err);
            }
        }
    }
});

export const startBackgroundTracking = async () => {
    const { status: foregroundStatus } = await Location.requestForegroundPermissionsAsync();
    if (foregroundStatus !== 'granted') return false;

    const { status: backgroundStatus } = await Location.requestBackgroundPermissionsAsync();
    if (backgroundStatus !== 'granted') return false;

    await Location.startLocationUpdatesAsync(TRACKING_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: 30000,  // Updated to 30 seconds for rate limit
        distanceInterval: 0,
        foregroundService: {
            notificationTitle: "Bus Tracking Active",
            notificationBody: "Live location is being shared",
            notificationColor: "#4F46E5"
        }
    });

    const userData = await AsyncStorage.getItem('user');
    const user = userData ? JSON.parse(userData) : null;
    const skt = await getSocket();
    skt.emit('toggle-mobile-tracking', { bus_no: user?.bus_no, active: true });

    console.log('✅ Background GPS tracking started - 30s intervals');
    return true;
};

export const stopBackgroundTracking = async () => {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK_NAME);
    if (hasStarted) {
        await Location.stopLocationUpdatesAsync(TRACKING_TASK_NAME);
    }

    const userData = await AsyncStorage.getItem('user');
    const user = userData ? JSON.parse(userData) : null;
    const skt = await getSocket();
    skt.emit('toggle-mobile-tracking', { bus_no: user?.bus_no, active: false });

    if (socket) {
        socket.disconnect();
        socket = null;
    }

    console.log('🛑 Background GPS tracking stopped');
};

export const isTrackingActive = async () => {
    return await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK_NAME);
};

