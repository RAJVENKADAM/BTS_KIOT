import 'react-native-gesture-handler';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createStackNavigator } from '@react-navigation/stack';

import { AuthProvider } from './src/context/AuthContext';
import { BusProvider } from './src/context/BusContext';

// Screens
import LoginScreen from './src/screens/LoginScreen';
import SplashScreen from './src/screens/SplashScreen';
import HomeScreen from './src/screens/HomeScreen';
import OrganizeScreen from './src/screens/OrganizeScreen';
import ProfileScreen from './src/screens/ProfileScreen';

// Services
import './src/services/bgTracking';

// Theme
import { COLORS } from './src/theme';

const Stack = createStackNavigator();


// ✅ Main App Navigator
function MainApp() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: COLORS.primary,
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <Stack.Screen 
        name="Home" 
        component={HomeScreen} 
        options={{ headerShown: false }} 
      />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen
        name="Organize"
        component={OrganizeScreen}
        options={{ headerTitle: 'Admin Dashboard' }}
      />
      
    </Stack.Navigator>
  );
}


// ✅ Auth Navigator (ONLY ONCE)
function AuthNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Splash" component={SplashScreen} />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="MainApp" component={MainApp} />
    </Stack.Navigator>
  );
}


// ✅ Root App (ONLY ONCE)
export default function App() {
  return (
    <AuthProvider>
      <BusProvider>
        <NavigationContainer>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <AuthNavigator />
          </GestureHandlerRootView>
        </NavigationContainer>
      </BusProvider>
    </AuthProvider>
  );
}