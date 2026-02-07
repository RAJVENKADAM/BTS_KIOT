import React from 'react';
import {
  TouchableOpacity,
  StyleSheet,
  View,
} from 'react-native';

import { COLORS, SHADOWS, RADIUS } from '../theme';
import { Body } from './UI/Typography';
import { MaterialIcons } from '@expo/vector-icons';

const BusCard = ({ bus, onPress }) => {
  return (
    <TouchableOpacity
      onPress={() => onPress(bus)}
      activeOpacity={0.8}
      style={[styles.container, bus.status === 'active' ? styles.active : bus.status === 'inactive' ? styles.inactive : null]}
    >
      <View style={styles.contentRow}>
        <Body style={styles.busNumber}>Bus {bus.busNo}</Body>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 45,
    borderRadius: 20,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 8,
    marginVertical: 0,
    marginHorizontal: 0,
    ...SHADOWS.soft,
  },
  busNumber: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textHeader,
  },
  contentRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  selected: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.primary,
    borderWidth: 2,
  },
  selectedText: {
    color: COLORS.white,
  },
  checkmark: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: COLORS.success,
    borderRadius: 8,
    width: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  active: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.primary,
  },
  inactive: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.primary,
  },
  selectButton: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.soft,
  },
});

export default BusCard;
