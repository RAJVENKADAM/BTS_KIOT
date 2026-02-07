import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../theme';
import { MutedText } from './UI/Typography';

const ChatBubble = ({ message, isMine, isSelected, onLongPress, onPress, showSender, isStarred, isSelectionMode }) => {
  const formatTime = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const bubbleStyle = [
    styles.bubble,
    isMine ? styles.myBubble : styles.theirBubble,
    isSelected && styles.selectedBubble
  ];

  const containerStyle = [
    styles.container,
    isMine ? styles.myContainer : styles.theirContainer,
    { flexDirection: isMine ? 'row-reverse' : 'row' }
  ];

  return (
    <View style={containerStyle}>
      {isSelectionMode && (
        <View style={styles.checkboxContainer}>
          <Ionicons
            name={isSelected ? "checkbox" : "square-outline"}
            size={20}
            color={COLORS.primary}
          />
        </View>
      )}
      <TouchableOpacity
        style={bubbleStyle}
        onPress={onPress}
        onLongPress={onLongPress}
        activeOpacity={0.8}
      >
        <Text style={[styles.messageText, isMine ? styles.myText : styles.theirText]}>
          {message.message}
        </Text>
        {message.bus_no && (
          <View style={styles.metaInfo}>
            <Text style={styles.metaText}>Bus: {message.bus_no}</Text>
          </View>
        )}
        {message.plan_name && message.plan_name !== 'GENERAL_PLAN' && (
          <View style={styles.metaInfo}>
            <Text style={styles.metaText}>Plan: {message.plan_name}</Text>
          </View>
        )}
        <View style={styles.timestampContainer}>
          <View style={styles.senderInfo}>
            <Ionicons name="chatbubbles" size={12} color={COLORS.muted} />
            <MutedText style={styles.senderRole}>
              {message.sender_role === 'SUPERADMIN' ? 'Super Admin' : 'Admin'}
            </MutedText>
          </View>
          <View style={styles.timestampWrapper}>
            <MutedText style={styles.timestamp}>{formatTime(message.created_at)}</MutedText>
            {isStarred && (
              <Ionicons name="heart" size={12} color={COLORS.primary} style={styles.starIcon} />
            )}
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

export default ChatBubble;

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    paddingHorizontal: 4,
  },
  myContainer: {
    alignItems: 'flex-end',
  },
  theirContainer: {
    alignItems: 'flex-start',
  },
  senderName: {
    fontSize: 12,
    marginBottom: 4,
    marginLeft: 20,
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 18,
    marginBottom: 4,
    marginLeft: 10,
  },
  myBubble: {
    backgroundColor: COLORS.primary,
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: COLORS.card,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  selectedBubble: {
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  myText: {
    color: COLORS.white,
  },
  theirText: {
    color: COLORS.textHeader,
  },
  timestamp: {
    fontSize: 11,
    marginTop: 4,
  },
  metaInfo: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaText: {
    fontSize: 12,
    color: COLORS.white,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
  },
  timestampContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  starIcon: {
    marginLeft: 4,
  },
  bubbleWrapper: {
    position: 'relative',
  },
  checkboxContainer: {
    marginHorizontal: 10,
    alignSelf: 'flex-end',
  },
  senderInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  senderRole: {
    fontSize: 10,
    marginLeft: 2,
  },
  timestampWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
