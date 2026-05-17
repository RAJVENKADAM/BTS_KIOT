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

const Stack = createStackNavigator();

/**
 * Auth + App routing controller
 */
function AppNavigator() {
  const { token, loading } = useAuth();

  // Show splash while auth loads
  if (loading) {
    return <SplashScreen />;
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {token ? (
        <Stack.Screen name="MainApp" component={BottomNavigator} />
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