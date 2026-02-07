import React, { useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  Alert,
  StatusBar,
  Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL } from '../api/api';
import MapComponent from '../components/Map/MapComponent';
import { COLORS, RADIUS, SPACING, SHADOWS } from '../theme';

const HomeScreen = () => {
  const { token } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      Alert.alert('Error', 'Please enter a bus number');
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/bus/current-plan/${searchQuery.trim()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok) {
        Alert.alert('Error', data.error || 'Bus not found');
        return;
      }

      let displayMessage = `Bus ${searchQuery.trim()} is currently on plan: ${data.currentPlan || 'No plan'}`;

      // If it's a combined bus, show the operating bus info
      if (data.isCombined && data.operatingBus) {
        displayMessage += `\n\n(This is a combined bus. Using operating bus ${data.operatingBus}'s plan)`;
      }

      // Show popup with current plan
      Alert.alert(
        'Current Plan',
        displayMessage,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'OK' }
        ]
      );
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Search failed');
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar translucent backgroundColor="transparent" barStyle="dark-content" />

      <View style={styles.mapContainer}>
        <MapComponent busData={null} destination={null} />
      </View>

      <View style={styles.searchOverlay} pointerEvents="box-none">
        <View style={styles.searchBar}>
          <Ionicons name="search" size={20} color={COLORS.textBody} style={{ marginRight: 8 }} />
          <TextInput
            placeholder="Search bus number..."
            placeholderTextColor={COLORS.textBody}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>
      </View>




    </View>
  );
};

export default HomeScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  mapContainer: {
    flex: 1,
  },
  searchOverlay: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 50,
    left: SPACING.screenPadding,
    right: SPACING.screenPadding,
    zIndex: 1000,
    elevation: 10,
  },
  searchBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.input,
    paddingHorizontal: 16,
    height: 56,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.soft,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: COLORS.textHeader,
    height: '100%',
  },
});

