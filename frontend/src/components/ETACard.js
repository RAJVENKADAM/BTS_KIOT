import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../theme';
import { Body, MutedText } from './UI/Typography';

const ETACard = ({ 
  eta, 
  destination, 
  distance, 
  isMoving, 
  onPress,
  type = 'user' // 'user' or 'college'
 }) => {
  const getIconName = () => {
    if (type === 'college') return 'school';
    return 'location';
  };

  const getDestinationLabel = () => {
    if (type === 'college') return 'KIOT College';
    return 'Your Location';
  };

  const formatETA = (minutes) => {
    if (!minutes || minutes < 1) return 'Arriving now';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    return `${Math.round(minutes / 60)} hr`;
  };

  const formatDistance = (meters) => {
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(1)}km`;
  };

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.header}>
        <View style={styles.iconContainer}>
          <Ionicons name={getIconName()} size={20} color={COLORS.primary} />
        </View>
        <View style={styles.textContainer}>
          <Body style={styles.destination}>{getDestinationLabel()}</Body>
          <MutedText style={styles.distance}>{formatDistance(distance || 0)}</MutedText>
        </View>
        {isMoving && (
          <View style={styles.movingIndicator}>
            <Ionicons name="play" size={12} color={COLORS.success} />
          </View>
        )}
      </View>
      <View style={styles.etaContainer}>
        <Text style={styles.eta}>{formatETA(eta)}</Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.card,
    padding: SPACING.md,
    marginVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...SHADOWS.soft,
  },
  header: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primary + '10',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.sm,
  },
  textContainer: {
    flex: 1,
  },
  destination: {
    fontSize: 16,
    fontWeight: '600',
  },
  distance: {
    fontSize: 14,
  },
  movingIndicator: {
    backgroundColor: COLORS.success + '10',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  etaContainer: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: COLORS.primary + '10',
    borderRadius: RADIUS.sm,
    alignSelf: 'flex-start',
  },
  eta: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.primary,
  },
});

export default ETACard;
