import 'react-native-gesture-handler';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createStackNavigator } from '@react-navigation/stack';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { BusProvider } from './src/context/BusContext';
import BottomNavigator from './src/navigation/BottomNavigator';

import SplashScreen from './src/screens/SplashScreen';
import LoginScreen from './src/screens/LoginScreen';
import OrganizeScreen from './src/screens/OrganizeScreen';
import ProfileScreen from './src/screens/ProfileScreen';

const Stack = createStackNavigator();

/**
 * Auth + App routing controller
 * - While loading: show splash
 * - No token: show Login
 * - Has token: show Home (main app)
 */
function AppNavigator() {
  const { token, loading } = useAuth();

  // Show splash while auth loads from storage
  if (loading) {
    return <SplashScreen />;
  }

  // Not authenticated → show Login flow
  if (!token) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Login" component={LoginScreen} />
      </Stack.Navigator>
    );
  }

  // Authenticated → show main app
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home" component={BottomNavigator} />
      <Stack.Screen name="Organize" component={OrganizeScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
    </Stack.Navigator>
  );
}

/**
 * Root App
 */
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <BusProvider>
          <NavigationContainer>
            <AppNavigator />
          </NavigationContainer>
        </BusProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}