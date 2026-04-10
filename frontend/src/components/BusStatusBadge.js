import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const BusStatusBadge = ({ status, size = 'normal', style }) => {
  const getStatusConfig = (status) => {
    switch (status?.toLowerCase()) {
      case 'active':
        return {
          bg: COLORS.success + '20',
          color: COLORS.success,
          border: COLORS.success,
          icon: 'radio-button-on',
          label: 'Active',
        };
      case 'deactivated':
        return {
          bg: COLORS.error + '20',
          color: COLORS.error,
          border: COLORS.error,
          icon: 'radio-button-off',
          label: 'Deactivated',
        };
      case 'altered':
        return {
          bg: COLORS.warning + '20',
          color: COLORS.warning,
          border: COLORS.warning,
          icon: 'swap-horizontal',
          label: 'Altered',
        };
      case 'combined':
        return {
          bg: COLORS.primary + '20',
          color: COLORS.primary,
          border: COLORS.primary,
          icon: 'merge',
          label: 'Combined',
        };
      default:
        return {
          bg: COLORS.muted + '20',
          color: COLORS.muted,
          border: COLORS.muted,
          icon: 'help-circle-outline',
          label: 'Unknown',
        };
    }
  };

  const config = getStatusConfig(status);

  const badgeSize = size === 'small' ? 24 : size === 'large' ? 36 : 32;

  return (
    <View style={[styles.badge, { backgroundColor: config.bg, borderColor: config.border, width: badgeSize, height: badgeSize }, style]}>
      <Ionicons name={config.icon} size={badgeSize - 8} color={config.color} />
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    borderRadius: 16,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default BusStatusBadge;
