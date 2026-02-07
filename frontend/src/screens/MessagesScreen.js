import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Clipboard,
  Modal
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../context/AuthContext';
import ChatBubble from '../components/MessageCard';
import io from 'socket.io-client';
import { API_BASE_URL } from '../api/api';
import { COLORS, SPACING } from '../theme';
import { Header, Subtitle, MutedText } from '../components/UI/Typography';

export default function MessagesScreen() {
  const [messages, setMessages] = useState([]);
  const [groupedMessages, setGroupedMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [sendMessageLoading, setSendMessageLoading] = useState(false);
  const [messagesHidden, setMessagesHidden] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [starredMessages, setStarredMessages] = useState(new Set());
  const [pinnedMessages, setPinnedMessages] = useState(new Set());
  const { token, user, isLoading: authLoading } = useAuth();
  const socketRef = useRef(null);
  const flatListRef = useRef(null);

  const fetchMessages = async () => {
    if (!token) return;

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/messages/`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();
      if (response.ok) {
        setMessages((result.messages || []).map((msg, index) => ({ ...msg, originalIndex: index })));
      } else {
        Alert.alert('Error', result.error || 'Failed to fetch messages');
      }
    } catch (error) {
      console.error('Error fetching messages:', error);
      Alert.alert('Error', 'Network error occurred while fetching messages');
    } finally {
      setLoading(false);
    }
  };

  const formatDateHeader = (dateString) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    }
  };

  const groupMessagesByDate = (messages) => {
    const groups = {};
    messages.forEach((message) => {
      const date = new Date(message.created_at);
      const dateKey = date.toDateString();
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(message);
    });

    const sortedGroups = Object.keys(groups).sort((a, b) => new Date(b) - new Date(a));
    const grouped = [];
    sortedGroups.forEach((dateKey) => {
      grouped.push({ type: 'date', date: dateKey });
      grouped.push(...groups[dateKey]);
    });
    return grouped;
  };

  useEffect(() => {
    if (!authLoading && token) {
      fetchMessages();
    }

    if (token && !socketRef.current && !authLoading) {
      socketRef.current = io(API_BASE_URL.replace('http://', ''), {
        transports: ['websocket'],
        auth: {
          token: token
        }
      });

      socketRef.current.on('new-message', (messageData) => {
        setMessages(prevMessages => [{ ...messageData, originalIndex: 0 }, ...prevMessages]);
      });

      socketRef.current.on('message-deleted', (deleteData) => {
        if (deleteData.isDeletedForAll) {
          setMessages(prevMessages =>
            prevMessages.map(msg =>
              msg.id === deleteData.messageId
                ? { ...msg, message: 'This message was deleted', isDeletedForAll: true }
                : msg
            )
          );
        } else if (deleteData.deletedForUserIds?.includes(user.id)) {
          setMessages(prevMessages =>
            prevMessages.filter(msg => msg.id !== deleteData.messageId)
          );
        }
      });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [token, authLoading]);

  useEffect(() => {
    setGroupedMessages(groupMessagesByDate(messages));
  }, [messages]);

  const handleSendMessage = async () => {
    if (!messageText.trim()) {
      Alert.alert('Error', 'Please enter a message');
      return;
    }

    if (!user || user.role === 'USER') {
      Alert.alert('Error', 'Regular users cannot send messages');
      return;
    }

    setSendMessageLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/messages/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: messageText,
          messageType: 'all'
        }),
      });

      const result = await response.json();
      if (response.ok) {
        setMessageText('');
        fetchMessages();
      } else {
        Alert.alert('Send Failed', result.error || 'Failed to send message');
      }
    } catch (error) {
      Alert.alert('Error', 'Network error occurred while sending message');
    } finally {
      setSendMessageLoading(false);
    }
  };

  const handleMessagePress = (message) => {
    if (isSelectionMode) {
      const isSelected = selectedMessages.some(m => m.id === message.id);
      if (isSelected) {
        setSelectedMessages(prev => prev.filter(m => m.id !== message.id));
      } else {
        setSelectedMessages(prev => [...prev, message]);
      }
    }
  };

  const handleMessageLongPress = (message) => {
    if (!isSelectionMode) {
      setIsSelectionMode(true);
      setSelectedMessages([message]);
    }
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedMessages([]);
  };

  const handleSelectAll = () => {
    setSelectedMessages(messages);
  };

  const handleDeselectAll = () => {
    setSelectedMessages([]);
  };

  const handleDeleteForMe = async () => {
    if (selectedMessages.length === 0) return;

    // Check if any selected messages are starred
    const hasStarred = selectedMessages.some(msg => starredMessages.has(msg.id));
    if (hasStarred) {
      Alert.alert('Cannot Delete', 'Starred messages cannot be deleted. Please unstar them first.');
      return;
    }

    Alert.alert(
      'Delete for Me',
      `Delete ${selectedMessages.length} message(s) for you only?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Implementation for delete for me
            // This would typically call an API to mark messages as deleted for current user
            setMessages(prev => prev.filter(m => !selectedMessages.some(sm => sm.id === m.id)));
            exitSelectionMode();
          }
        }
      ]
    );
  };

  const handleDeleteForEveryone = async () => {
    if (selectedMessages.length === 0) return;

    // Check if user can delete (only sender can delete for everyone)
    const canDelete = selectedMessages.every(m => m.sender_id === user.id);
    if (!canDelete) {
      Alert.alert('Error', 'You can only delete your own messages for everyone');
      return;
    }

    Alert.alert(
      'Delete for Everyone',
      `Delete ${selectedMessages.length} message(s) for all users?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // Implementation for delete for everyone
            // This would call API to mark messages as deleted for all
            setMessages(prev => prev.map(m =>
              selectedMessages.some(sm => sm.id === m.id)
                ? { ...m, message: 'This message was deleted', isDeletedForAll: true }
                : m
            ));
            exitSelectionMode();
          }
        }
      ]
    );
  };

  const handleCopy = async () => {
    if (selectedMessages.length === 0) return;

    const textToCopy = selectedMessages.map(m => m.message).join('\n');
    await Clipboard.setString(textToCopy);
    Alert.alert('Copied', 'Message(s) copied to clipboard');
    exitSelectionMode();
  };

  const handleStar = () => {
    if (selectedMessages.length === 0) return;

    const newStarred = new Set(starredMessages);
    const newPinned = new Set(pinnedMessages);
    const pinnedAt = Date.now();
    selectedMessages.forEach(msg => {
      if (starredMessages.has(msg.id)) {
        // Unstar and unpin
        newStarred.delete(msg.id);
        newPinned.delete(msg.id);
      } else {
        // Star and pin
        newStarred.add(msg.id);
        newPinned.add(msg.id);
      }
    });

    setStarredMessages(newStarred);
    setPinnedMessages(newPinned);

    // Reorder messages: unpinned in original order, pinned at top (end of array) sorted by pinnedAt descending
    setMessages(prevMessages => {
      const unpinned = prevMessages.filter(msg => !newPinned.has(msg.id));
      const pinned = prevMessages
        .filter(msg => newPinned.has(msg.id))
        .map(msg => ({ ...msg, pinnedAt: msg.pinnedAt || pinnedAt }))
        .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
      return [...unpinned, ...pinned];
    });

    exitSelectionMode();
  };

  const handlePin = () => {
    if (selectedMessages.length === 0) return;

    const newPinned = new Set(pinnedMessages);
    const pinnedAt = Date.now();
    selectedMessages.forEach(msg => {
      if (newPinned.has(msg.id)) {
        newPinned.delete(msg.id);
      } else {
        if (newPinned.size < 5) {
          newPinned.add(msg.id);
        }
      }
    });

    // Reorder messages: unpinned in original order, pinned at top (end of array) sorted by pinnedAt descending
    setMessages(prevMessages => {
      const unpinned = prevMessages.filter(msg => !newPinned.has(msg.id));
      const pinned = prevMessages
        .filter(msg => newPinned.has(msg.id))
        .map(msg => ({ ...msg, pinnedAt: msg.pinnedAt || pinnedAt }))
        .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
      return [...unpinned, ...pinned];
    });

    setPinnedMessages(newPinned);
    exitSelectionMode();
  };

  const handleClearChat = () => {
    Alert.alert(
      'Clear Chat',
      'Delete all messages for you only?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setMessages([]);
            exitSelectionMode();
          }
        }
      ]
    );
  };

  const shouldShowSender = (message, index) => {
    if (index === 0) return true;
    const prevItem = groupedMessages[index - 1];
    if (prevItem.type === 'date') return true; // Show sender after date header
    return prevItem.sender_id !== message.sender_id;
  };

  const allSelectedStarred = selectedMessages.length > 0 && selectedMessages.every(msg => starredMessages.has(msg.id));
  const allSelectedPinned = selectedMessages.length > 0 && selectedMessages.every(msg => pinnedMessages.has(msg.id));
  const allMessagesSelected = selectedMessages.length === messages.length && messages.length > 0;

  const renderMessage = ({ item, index }) => {
    if (item.type === 'date') {
      return (
        <View style={styles.dateHeader}>
          <Text style={styles.dateHeaderText}>{formatDateHeader(item.date)}</Text>
        </View>
      );
    }

    const isMine = item.sender_id === user?.id;
    const isSelected = selectedMessages.some(m => m.id === item.id);
    const showSender = shouldShowSender(item, index);
    const isStarred = starredMessages.has(item.id);

    return (
      <ChatBubble
        message={item}
        isMine={isMine}
        isSelected={isSelected}
        onPress={() => handleMessagePress(item)}
        onLongPress={() => handleMessageLongPress(item)}
        showSender={showSender}
        isStarred={isStarred}
        isSelectionMode={isSelectionMode}
      />
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient
        colors={['transparent', 'rgba(147, 51, 234, 0.1)', 'transparent']}
        style={{ flex: 1 }}
      >
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
        <View style={styles.headerContainer}>
          <View style={styles.headerRow}>
            <View style={styles.headerLeft} />

            <View style={styles.headerCenter}>
              <Header style={styles.leftAlignedText}>
                {isSelectionMode ? `${selectedMessages.length} selected` : 'Messages'}
              </Header>
              {!isSelectionMode && (
                <Subtitle style={[styles.leftAlignedText, { marginBottom: 0 }]}>Stay updated with important notifications</Subtitle>
              )}
            </View>

            <TouchableOpacity
              onPress={isSelectionMode ? exitSelectionMode : handleClearChat}
              style={styles.headerRight}
            >
              {isSelectionMode ? (
                <Ionicons name="close" size={24} color={COLORS.textHeader} />
              ) : (
                <Ionicons name="ellipsis-vertical" size={24} color={COLORS.textHeader} />
              )}
            </TouchableOpacity>
          </View>

          {isSelectionMode && (
            <View style={styles.selectionBar}>
              <TouchableOpacity style={styles.selectionButton} onPress={handleSelectAll}>
                <Ionicons name={allMessagesSelected ? "checkmark-circle" : "checkmark-circle-outline"} size={24} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.selectionButton} onPress={handleDeselectAll}>
                <Ionicons name="close-circle-outline" size={24} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.selectionButton} onPress={handleStar}>
                <Ionicons name={allSelectedStarred ? "heart" : "heart-outline"} size={24} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.selectionButton} onPress={handlePin}>
                <Ionicons name={allSelectedPinned ? "bookmark" : "bookmark-outline"} size={24} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.selectionButton} onPress={handleCopy}>
                <Ionicons name="copy-outline" size={24} color={COLORS.primary} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.selectionButton} onPress={handleDeleteForMe}>
                <Ionicons name="trash-outline" size={24} color={COLORS.danger} />
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.messagesContainer}>
          {loading ? (
            <View style={styles.centerContainer}>
              <ActivityIndicator color={COLORS.primary} size="large" />
              <MutedText style={{ marginTop: 12 }}>Loading messages...</MutedText>
            </View>
          ) : messagesHidden ? (
            <View style={styles.centerContainer}>
              <Ionicons name="eye-off" size={80} color={COLORS.muted} />
              <Header style={styles.emptyTitle}>Messages Hidden</Header>
              <MutedText style={styles.emptyText}>Tap "Show All" to view messages</MutedText>
            </View>
          ) : messages.length === 0 ? (
            <View style={styles.centerContainer}>
              <Ionicons name="chatbox-ellipses-outline" size={80} color={COLORS.muted} />
              <Header style={styles.emptyTitle}>No messages yet</Header>
              <MutedText style={styles.emptyText}>Check back later for updates</MutedText>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={groupedMessages}
              renderItem={renderMessage}
              keyExtractor={(item) => item.type === 'date' ? item.date : item.id.toString()}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.listContent}
              inverted
            />
          )}
        </View>

        {(user.role === 'SUPERADMIN' || user.role === 'PRIMARY_ADMIN') && (
          <View style={styles.inputArea}>
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.textInput}
                placeholder="Type your message here..."
                placeholderTextColor={COLORS.textBody}
                value={messageText}
                onChangeText={setMessageText}
                multiline
                maxLength={500}
              />
              <TouchableOpacity
                style={[styles.sendButton, sendMessageLoading && styles.sendButtonDisabled]}
                onPress={handleSendMessage}
                disabled={sendMessageLoading}
                activeOpacity={0.8}
              >
                {sendMessageLoading ? (
                  <ActivityIndicator color={COLORS.white} size="small" />
                ) : (
                  <Ionicons name="send" size={20} color={COLORS.white} />
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}


      </KeyboardAvoidingView>
      </LinearGradient>
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
    paddingTop: 10,
    paddingHorizontal: 0,
    paddingBottom: 10,
    backgroundColor: 'white',
    
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    width: 20,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'flex-start',
  },
  headerRight: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectionHeader: {
    color: COLORS.primary,
  },
  leftAlignedText: {
    textAlign: 'left',
  },
  selectionBar: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  selectionButton: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    minWidth: 50,
    marginRight: 4,
    marginBottom: 2,
  },
  selectionText: {
    color: COLORS.textHeader,
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
    paddingHorizontal: SPACING.screenPadding,
    backgroundColor: COLORS.primary,
    marginTop: 8,
  },
  actionButton: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    minWidth: 70,
  },
  actionText: {
    color: COLORS.white,
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  messagesContainer: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 0,
    paddingBottom: 24,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    marginTop: 16,
    marginBottom: 4,
    textAlign: 'center',
  },
  emptyText: {
    textAlign: 'center',
  },
  inputArea: {
    paddingHorizontal: SPACING.screenPadding,
    paddingVertical: 16,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: COLORS.inputBg,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  textInput: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    fontSize: 15,
    color: COLORS.textHeader,
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendButton: {
    backgroundColor: COLORS.primary,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    marginBottom: 2,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 20,
    width: '80%',
    maxWidth: 300,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textHeader,
    textAlign: 'center',
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'column',
    marginBottom: 20,
  },
  modalActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    marginBottom: 10,
    backgroundColor: COLORS.inputBg,
    borderRadius: 8,
  },
  modalActionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  modalActionText: {
    fontSize: 14,
    marginLeft: 12,
    color: COLORS.textHeader,
  },
  modalCancelButton: {
    alignItems: 'center',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  modalCancelText: {
    fontSize: 16,
    color: COLORS.primary,
    fontWeight: 'bold',
  },
  dateHeader: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  dateHeaderText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.textHeader,
    textAlign: 'center',
  },
});
