import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import { LinearGradient } from 'expo-linear-gradient';
import AddUsersScreen from './Organize/AddUsersScreen';
import AddBusesScreen from './Organize/AddBusesScreen';
import NotificationsTab from './Organize/NotificationsTab';
import { COLORS, SPACING, SHADOWS } from '../theme';
import { Header, Subtitle } from '../components/UI/Typography';

export default function OrganizeScreen() {
  const [activeTab, setActiveTab] = useState('users');

  const renderTabContent = () => {
    switch (activeTab) {
      case 'users':
        return <AddUsersScreen />;
      case 'buses':
        return <AddBusesScreen />;
      case 'notifications':
        return <NotificationsTab />;
      default:
        return <AddUsersScreen />;
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.container}>
        <View style={styles.headerContainer}>
          <Header>Admin Dashboard</Header>
          <Subtitle style={{ marginBottom: 16 }}>Manage users, buses, and notifications</Subtitle>
          <View style={styles.tabRow}>
            <TouchableOpacity
              style={[styles.tabButton, activeTab === 'users' && styles.activeTabButton]}
              onPress={() => setActiveTab('users')}
              activeOpacity={0.7}
            >
              <MaterialIcons
                name="person"
                size={20}
                color={activeTab === 'users' ? COLORS.white : COLORS.muted}
              />
              <Text style={[styles.tabText, activeTab === 'users' && styles.activeTabText]}>Users</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tabButton, activeTab === 'buses' && styles.activeTabButton]}
              onPress={() => setActiveTab('buses')}
              activeOpacity={0.7}
            >
              <MaterialIcons
                name="directions-bus"
                size={20}
                color={activeTab === 'buses' ? COLORS.white : COLORS.muted}
              />
              <Text style={[styles.tabText, activeTab === 'buses' && styles.activeTabText]}>Buses</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tabButton, activeTab === 'notifications' && styles.activeTabButton]}
              onPress={() => setActiveTab('notifications')}
              activeOpacity={0.7}
            >
              <MaterialIcons
                name="notifications"
                size={20}
                color={activeTab === 'notifications' ? COLORS.white : COLORS.muted}
              />
              <Text style={[styles.tabText, activeTab === 'notifications' && styles.activeTabText]}>Changes</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.contentContainer}>
          {renderTabContent()}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
  },
  headerContainer: {
    paddingTop: 16,
    paddingHorizontal: SPACING.screenPadding,
    backgroundColor: COLORS.white,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    ...SHADOWS.soft,
    paddingBottom: 15,
    zIndex: 10,
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: 8,
  },
  tabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.inputBg,
    gap: 4,
  },
  activeTabButton: {
    backgroundColor: COLORS.primary,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.muted,
  },
  activeTabText: {
    color: COLORS.white,
  },
  contentContainer: {
    flex: 1,
  },
});
