import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../api/api';
import Constants from 'expo-constants';

// ------------------------------------------------------------------
// SDK 54: Pull projectId from app.json extra.eas.projectId
// ------------------------------------------------------------------
const PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId ||
  'd2b0e413-8d33-4486-b0ca-4bbc2a04a5c4';

// ------------------------------------------------------------------
// Notification handler (required for foreground alerts on Android/iOS)
// ------------------------------------------------------------------
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ------------------------------------------------------------------
// A) Request notification permissions
// ------------------------------------------------------------------
export async function requestNotificationPermissions() {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[PushNotify] Notification permissions not granted');
      return false;
    }

    console.log('[PushNotify] Notification permissions granted');
    return true;
  } catch (error) {
    console.error('[PushNotify] Error requesting notification permissions:', error);
    return false;
  }
}

// ------------------------------------------------------------------
// B) Get Expo Push Token (SDK 54 compatible)
// ------------------------------------------------------------------
export async function getExpoPushToken() {
  try {
    // Bare workflow / dev-client MUST pass projectId explicitly
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: PROJECT_ID,
    });
    console.log('[PushNotify] Expo Push Token generated:', token);
    return token;
  } catch (error) {
    if (error.message?.includes('projectId')) {
      console.error(
        '[PushNotify] Push Notification Setup Required:\n' +
        '1. Ensure extra.eas.projectId is set in app.json\n' +
        '2. Use a development build (expo-dev-client) — NOT Expo Go\n' +
        '   Build: npx expo run:android  or  eas build --profile development'
      );
    } else {
      console.error('[PushNotify] Error getting Expo push token:', error.message);
    }
    return null;
  }
}

// ------------------------------------------------------------------
// C) Register token with backend — includes bus_no for bus-based routing
// ------------------------------------------------------------------
export async function registerTokenWithBackend(token, busNo) {
  try {
    const storedToken = await AsyncStorage.getItem('token');
    if (!storedToken) {
      console.log('[PushNotify] No auth token available, skipping backend registration');
      return null;
    }

    const response = await fetch(`${API_BASE_URL}/api/bus/save-push-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storedToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, busNo }),
    });

    const data = await response.json();
    if (response.ok) {
      console.log('[PushNotify] Token saved to backend successfully. bus_no:', busNo);
      await AsyncStorage.setItem('expoPushToken', token);
      return data;
    } else {
      console.error('[PushNotify] Failed to save token:', data.error);
      return null;
    }
  } catch (error) {
    console.error('[PushNotify] Error registering token with backend:', error);
    return null;
  }
}

// ------------------------------------------------------------------
// D) Setup listeners (call once on app mount)
// ------------------------------------------------------------------
export function setupNotificationListeners() {
  // Foreground notification received
  const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
    console.log('[PushNotify] Notification received in foreground:', notification.request.content);
  });

  // User tapped notification (app was background or closed)
  const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    console.log('[PushNotify] Notification tapped:', response.notification.request.content);
    const data = response.notification.request.content.data;
    if (data?.actionType) {
      console.log('[PushNotify] Action type from tap:', data.actionType);
    }
  });

  const subs = [receivedSub, responseSub];
  global.notificationSubscriptions = subs;
  return subs;
}

// ------------------------------------------------------------------
// E) Cleanup listeners
// ------------------------------------------------------------------
export function cleanupNotifications() {
  if (global.notificationSubscriptions) {
    global.notificationSubscriptions.forEach((sub) => sub.remove());
    global.notificationSubscriptions = null;
  }
}

// ------------------------------------------------------------------
// F) Register for push notifications (call AFTER login success)
// ------------------------------------------------------------------
export async function registerForPushNotificationsAsync(busNo) {
  try {
    console.log('[PushNotify] Starting push registration for bus:', busNo);

    // 1. Android notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('bus_notifications', {
        name: 'Bus Notifications',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#4F46E5',
      });
      console.log('[PushNotify] Android notification channel created');
    }

    // 2. Request permissions
    const permissionsGranted = await requestNotificationPermissions();
    if (!permissionsGranted) {
      console.log('[PushNotify] Permissions denied, aborting registration');
      return false;
    }

    // 3. Get Expo Push Token
    const pushToken = await getExpoPushToken();
    if (!pushToken) {
      console.log('[PushNotify] Failed to get Expo Push Token');
      return false;
    }

    // 4. Send to backend with bus_no
    await registerTokenWithBackend(pushToken, busNo);

    console.log('[PushNotify] Push registration completed successfully');
    return true;
  } catch (error) {
    console.error('[PushNotify] Error in registerForPushNotificationsAsync:', error);
    return false;
  }
}

// ------------------------------------------------------------------
// G) Initialize handlers only (call in App.js useEffect on mount)
// ------------------------------------------------------------------
export async function initializeNotificationHandlers() {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('bus_notifications', {
        name: 'Bus Notifications',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#4F46E5',
      });
    }
    setupNotificationListeners();
    console.log('[PushNotify] Notification handlers initialized');
  } catch (error) {
    console.error('[PushNotify] Error initializing notification handlers:', error);
  }
}

export default {
  requestNotificationPermissions,
  getExpoPushToken,
  registerTokenWithBackend,
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  cleanupNotifications,
  initializeNotificationHandlers,
};

