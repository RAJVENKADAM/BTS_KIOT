import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '../context/AuthContext';
import Icon from 'react-native-vector-icons/Ionicons';
import { COLORS } from '../theme';

// Import screens
import HomeScreen from '../screens/HomeScreen';
import MessagesScreen from '../screens/MessagesScreen';
import TrackMeScreen from '../screens/TrackMe/TrackMeScreen';
import OrganizeScreen from '../screens/OrganizeScreen';
import ProfileScreen from '../screens/ProfileScreen';

const Tab = createBottomTabNavigator();

export default function BottomNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  const role = user?.role || 'USER';

  const renderTabs = () => {
    switch (role) {
      case 'SUPERADMIN':
        return (
          <>
            <Tab.Screen name="Home" component={HomeScreen} />
            <Tab.Screen name="Messages" component={MessagesScreen} />
            <Tab.Screen name="Organize" component={OrganizeScreen} />
            <Tab.Screen name="Profile" component={ProfileScreen} />
          </>
        );
      case 'PRIMARY_ADMIN':
        return (
          <>
            <Tab.Screen name="Home" component={HomeScreen} />
            <Tab.Screen name="Messages" component={MessagesScreen} />
            <Tab.Screen name="TrackMe" component={TrackMeScreen} />
            <Tab.Screen name="Profile" component={ProfileScreen} />
          </>
        );
      case 'USER':
      default:
        return (
          <>
            <Tab.Screen name="Home" component={HomeScreen} />
            <Tab.Screen name="Messages" component={MessagesScreen} />
            <Tab.Screen name="Profile" component={ProfileScreen} />
          </>
        );
    }
  };

  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName = 'home';

          if (route.name === 'Home') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Messages') {
            iconName = focused ? 'chatbubbles' : 'chatbubbles-outline';
          } else if (route.name === 'TrackMe') {
            iconName = focused ? 'locate' : 'locate-outline';
          } else if (route.name === 'Organize') {
            iconName = focused ? 'settings' : 'settings-outline';
          } else if (route.name === 'Profile') {
            iconName = focused ? 'person' : 'person-outline';
          }

          return (
            <Icon
              name={iconName}
              size={20}
              color={color}
            />
          );
        },
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textBody,
        tabBarStyle: {
          backgroundColor: COLORS.white,
          borderTopWidth: 1,
          borderTopColor: COLORS.border,
          height: 65,
          paddingBottom: 10,
          paddingTop: 10,
          elevation: 20,
          shadowColor: COLORS.shadow,
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.1,
          shadowRadius: 10,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
        headerShown: false,
      })}
    >
      {renderTabs()}
    </Tab.Navigator>
  );
}
