import 'react-native-gesture-handler';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createStackNavigator } from '@react-navigation/stack';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { BusProvider } from './src/context/BusContext';

import SplashScreen from './src/screens/SplashScreen';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import OrganizeScreen from './src/screens/OrganizeScreen';
import ProfileScreen from './src/screens/ProfileScreen';

const Stack = createStackNavigator();

/**
 * Main authenticated app stack
 */
function MainStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#1976D2' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
      }}
    >
      <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Organize" component={OrganizeScreen} options={{ title: 'Admin Dashboard' }} />
    </Stack.Navigator>
  );
}

/**
 * Auth + App routing controller
 */
function AppNavigator() {
  const { token, loading } = useAuth();

  // IMPORTANT: never return null in native apps for root navigation
  if (loading) {
    return <SplashScreen />;
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {token ? (
        <Stack.Screen name="MainStack" component={MainStack} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
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