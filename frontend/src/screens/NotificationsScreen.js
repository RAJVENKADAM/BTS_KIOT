import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useAuth } from "../context/AuthContext";
import notificationApi from "../api/notificationApi";
import { COLORS } from "../theme";
import { useBus } from "../context/BusContext";
import { getErrorMessage } from "../utils/errorHandler";
const { subscribeSocketEvent } = require("../utils/socketSubscription.cjs");

const DATE_TIME_ZONE = "Asia/Kolkata";

function getDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DATE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value: part }) => [type, part]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function getDateLabel(value, dateKey) {
  const today = getDateKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === today) return "Today";
  if (dateKey === getDateKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: DATE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function formatMessageTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: DATE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export default function NotificationsScreen() {
  const { token } = useAuth();
  const navigation = useNavigation();
  const { getSocket } = useBus();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const messageRows = useMemo(() => {
    const rows = [];
    let previousDateKey = null;
    const messages = notifications
      .filter(
        (item) =>
          typeof item?.message === "string" &&
          item.message.trim().length > 0 &&
          Number.isFinite(new Date(item.createdAt).getTime()),
      )
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

    messages.forEach((item) => {
      const dateKey = getDateKey(item.createdAt);
      if (dateKey !== previousDateKey) {
        rows.push({
          id: `date-${dateKey}`,
          rowType: "date",
          label: getDateLabel(item.createdAt, dateKey),
        });
        previousDateKey = dateKey;
      }
      rows.push(item);
    });
    return rows;
  }, [notifications]);

  const currentMessageId = useMemo(() => {
    for (let index = messageRows.length - 1; index >= 0; index -= 1) {
      if (!messageRows[index].rowType) return messageRows[index].id;
    }
    return null;
  }, [messageRows]);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await notificationApi.getAll(token);
      setNotifications(data.notifications || []);
    } catch (error) {
      console.error("Failed to load notifications:", error);
      Alert.alert(
        "Messages unavailable",
        getErrorMessage(error, "Could not load your messages."),
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  const markRead = async (id) => {
    try {
      await notificationApi.markOneRead(token, id);
      setNotifications((items) =>
        items.map((item) =>
          String(item.id) === String(id) ? { ...item, read: true } : item,
        ),
      );
    } catch (error) {
      console.error("Failed to mark notification read:", error);
      Alert.alert(
        "Could not update message",
        getErrorMessage(error, "Please try again."),
      );
    }
  };

  const removeAllNotifications = async () => {
    Alert.alert(
      "Delete all messages",
      "Delete every message from your inbox?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await notificationApi.removeAll(token);
              setNotifications([]);
            } catch (error) {
              console.error("Failed to delete notification:", error);
              Alert.alert(
                "Could not delete messages",
                getErrorMessage(error, "Please try again."),
              );
            }
          },
        },
      ],
    );
  };

  useFocusEffect(
    useCallback(() => {
      loadNotifications();
    }, [loadNotifications]),
  );

  React.useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const handleNotification = (notification) => {
      if (
        typeof notification?.message !== "string" ||
        !notification.message.trim()
      ) {
        return;
      }
      const liveItem = {
        ...notification,
        id: notification.id || `live-${Date.now()}-${Math.random()}`,
        read: false,
        createdAt: notification.createdAt || new Date().toISOString(),
      };
      setNotifications((items) => {
        if (
          notification.id &&
          items.some((item) => String(item.id) === String(notification.id))
        ) {
          return items;
        }
        return [liveItem, ...items];
      });
    };
    return subscribeSocketEvent(socket, "notification", handleNotification);
  }, [getSocket]);

  const renderItem = ({ item }) => {
    if (item.rowType === "date") {
      return (
        <View style={styles.dateDivider}>
          <Text style={styles.dateDividerText}>{item.label}</Text>
        </View>
      );
    }

    return (
      <TouchableOpacity
        style={styles.messageRow}
        activeOpacity={0.85}
        onPress={() => !item.read && markRead(item.id)}
      >
        <View
          style={[
            styles.messageBubble,
            item.id === currentMessageId && styles.currentMessageBubble,
          ]}
        >
          <Text style={[styles.message, !item.read && styles.unreadMessage]}>
            {item.message.trim()}
          </Text>
          <Text style={styles.meta}>{formatMessageTime(item.createdAt)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Messages</Text>
        <TouchableOpacity
          accessibilityLabel="Delete all messages"
          style={styles.deleteAllButton}
          onPress={removeAllNotifications}
          disabled={!notifications.length}
        >
          <Text style={styles.deleteAllText}>Delete all</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={COLORS.primary} />
      ) : (
        <FlatList
          data={messageRows}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={
            messageRows.length ? styles.list : styles.emptyList
          }
          ListEmptyComponent={
            <Text style={styles.empty}>No messages yet.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  header: {
    padding: 18,
    paddingTop: 50,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: COLORS.primary,
  },
  title: { fontSize: 20, fontWeight: "700", color: "#fff" },
  list: { paddingHorizontal: 12, paddingVertical: 10 },
  emptyList: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: COLORS.textBody, fontSize: 16 },
  dateDivider: {
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginVertical: 10,
    borderRadius: 12,
    backgroundColor: "#DBEAFE",
  },
  dateDividerText: { color: COLORS.primary, fontSize: 12, fontWeight: "600" },
  messageRow: { alignItems: "flex-start", marginBottom: 8 },
  messageBubble: {
    maxWidth: "88%",
    minWidth: "55%",
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 5,
    borderRadius: 10,
    backgroundColor: "#DBEAFE",
    elevation: 1,
  },
  currentMessageBubble: {
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  deleteAllButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#DBEAFE",
  },
  deleteAllText: { color: COLORS.primary, fontSize: 12, fontWeight: "700" },
  message: {
    color: "#1F2933",
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "500",
  },
  unreadMessage: { fontWeight: "700" },
  meta: { color: "#667781", fontSize: 11, textAlign: "right", marginTop: 3 },
});
