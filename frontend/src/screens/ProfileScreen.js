/**
 * ProfileScreen — User profile view with account details and logout.
 * Displays user info in cards: name, email, role, bus number.
 */
import React, { useState } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  StatusBar
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../theme';
import { Header, Subtitle, Body, MutedText } from '../components/UI/Typography';
import Card from '../components/UI/Card';
import { getDisplayBusNumber } from '../utils/busDisplay';

export default function ProfileScreen() {
  const { user, logout, loading } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centerContainer}>
          <ActivityIndicator color={COLORS.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }


  const handleLogout = async () => {
    Alert.alert(
      'Confirm Logout',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            setIsLoggingOut(true);
            try {
              await logout();
              // Navigation auto-switches to Login once token is cleared in AuthContext.
              // No manual reset needed — dispatching RESET here causes 
              // "The action 'RESET' was not handled by any navigator" error.
            } catch (error) {
              Alert.alert('Error', 'Failed to logout. Please try again.');
            } finally {
              setIsLoggingOut(false);
            }
          }
        }
      ]
    );
  };

  const InfoItem = ({ label, value, icon }) => (
    <Card style={styles.infoCard}>
      <View style={styles.infoIconWrapper}>
        <Ionicons name={icon} size={22} color={COLORS.primary} />
      </View>
      <View style={styles.infoTextWrapper}>
        <MutedText style={styles.infoLabel}>{label}</MutedText>
        <Body style={styles.infoValue}>{value || 'N/A'}</Body>
      </View>
    </Card>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.avatarWrapper}>
            <View style={styles.avatar}>
              <Body style={styles.avatarText}>{user?.name?.charAt(0)?.toUpperCase() || 'U'}</Body>
            </View>

          </View>
          <Header style={{ marginBottom: 4 }}>{user?.name || 'User'}</Header>
          <Subtitle>{user?.email || 'N/A'}</Subtitle>
        </View>

        <View style={styles.content}>
          <Header style={styles.sectionTitle}>Account Details</Header>
          <InfoItem label="Full Name" value={user?.name} icon="person-outline" />
          <InfoItem label="Email Address" value={user?.email} icon="mail-outline" />
          <InfoItem label="Role" value={user?.role} icon="shield-checkmark-outline" />
          <InfoItem label="Bus Number" value={getDisplayBusNumber({ previewNumber: user?.previewNumber ?? user?.preview_number, busNo: user?.bus_no })} icon="bus-outline" />

          <TouchableOpacity
            style={[styles.logoutButton, isLoggingOut && styles.logoutButtonDisabled]}
            onPress={handleLogout}
            disabled={isLoggingOut}
            activeOpacity={0.8}
          >
            {isLoggingOut ? (
              <ActivityIndicator color={COLORS.error} />
            ) : (
              <>
                <Ionicons name="log-out-outline" size={20} color={COLORS.error} />
                <Body style={styles.logoutText}>Log Out</Body>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.screenPadding,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 40,
    backgroundColor: COLORS.white,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    ...SHADOWS.soft,
  },
  avatarWrapper: {
    position: 'relative',
    marginBottom: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#EEF2FF',
  },
  avatarText: {
    fontSize: 40,
    fontWeight: '800',
    color: COLORS.white,
  },
  editAvatar: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: COLORS.primary,
    padding: 8,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: COLORS.white,
  },
  content: {
    padding: SPACING.screenPadding,
  },
  sectionTitle: {
    fontSize: 18,
    marginBottom: 16,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 12,
  },
  infoIconWrapper: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  infoTextWrapper: {
    flex: 1,
  },
  infoLabel: {
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 10,
    fontWeight: '700',
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  logoutButton: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: RADIUS.button,
    borderWidth: 1,
    borderColor: COLORS.error,
    backgroundColor: 'transparent',
  },
  logoutButtonDisabled: {
    opacity: 0.5,
  },
  logoutText: {
    color: COLORS.error,
    fontWeight: '700',
    marginLeft: 8,
  },
});
