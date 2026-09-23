import React, { useCallback, useState } from "react";
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

export default function NotificationsScreen() {
  const { token } = useAuth();
  const navigation = useNavigation();
  const { getSocket } = useBus();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await notificationApi.getAll(token);
      setNotifications(data.notifications || []);
    } catch (error) {
      console.error("Failed to load notifications:", error);
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
    }
  };

  const removeAllNotifications = async () => {
    Alert.alert("Delete all messages", "Delete every message from your inbox?", [
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
    }
        },
      },
    ]);
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
      if (!notification?.message) return;
      const liveItem = {
        ...notification,
        id: notification.id || `live-${Date.now()}-${Math.random()}`,
        read: false,
        createdAt: notification.createdAt || new Date().toISOString(),
      };
      setNotifications((items) => {
        if (notification.id && items.some((item) => String(item.id) === String(notification.id))) {
          return items;
        }
        return [liveItem, ...items];
      });
    };
    socket.on("notification", handleNotification);
    return () => socket.off("notification", handleNotification);
  }, [getSocket]);

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={[styles.card, !item.read && styles.unreadCard]}
      activeOpacity={0.85}
      onPress={() => !item.read && markRead(item.id)}
    >
      <View style={styles.body}>
        <Text style={styles.message}>{item.message}</Text>
        {!item.read && <Text style={styles.unreadLabel}>Unread</Text>}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={COLORS.textHeader} />
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
          data={notifications}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={notifications.length ? styles.list : styles.emptyList}
          ListEmptyComponent={<Text style={styles.empty}>No new notifications.</Text>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    padding: 18,
    paddingTop: 50,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: COLORS.white,
  },
  title: { fontSize: 20, fontWeight: "700", color: COLORS.textHeader },
  list: { padding: 16 },
  emptyList: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { color: COLORS.textBody, fontSize: 16 },
  card: {
    flexDirection: "row",
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  unreadCard: { borderLeftWidth: 4, borderLeftColor: COLORS.primary },
  deleteAllButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#FEF2F2" },
  deleteAllText: { color: COLORS.error, fontSize: 12, fontWeight: "700" },
  icon: { marginRight: 12, paddingTop: 2 },
  body: { flex: 1 },
  message: { color: COLORS.textHeader, fontSize: 15, fontWeight: "600" },
  unreadLabel: { color: COLORS.primary, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  meta: { color: COLORS.textBody, marginTop: 6 },
  button: {
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
