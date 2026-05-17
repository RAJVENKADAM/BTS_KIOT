import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, ActivityIndicator } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { Ionicons as Icon } from '@expo/vector-icons';
import { COLORS } from '../theme';

// Import screens
import HomeScreen from '../screens/HomeScreen';
import TrackMeScreen from '../screens/TrackMe/TrackMeScreen';
import OrganizeScreen from '../screens/OrganizeScreen';
import ProfileScreen from '../screens/ProfileScreen';

const Tab = createBottomTabNavigator();

export default function BottomNavigator() {
  const { user, loading } = useAuth();

  // NEVER return null - always return JSX
  // Show loading indicator while auth loads
  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background }}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  const role = (user?.role || 'student').toLowerCase();
  console.log('BOTTOM NAVIGATOR - Current User:', user?.email, 'Role:', role);

  const renderTabs = () => {
    const screens = [     <Tab.Screen key="Home" name="Home" component={HomeScreen} />   ];

    if (role === 'superadmin') {
      screens.push(<Tab.Screen key="Organize" name="Organize" component={OrganizeScreen} />);
    } else if (role === 'primary_admin') {
      screens.push(<Tab.Screen key="TrackMe" name="TrackMe" component={TrackMeScreen} />);
    }

    screens.push(<Tab.Screen key="Profile" name="Profile" component={ProfileScreen} />);
    return screens;
  };

  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName = 'home';

          if (route.name === 'Home') { iconName = focused ? 'home' : 'home-outline';        } else if (route.name === 'TrackMe') {
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
