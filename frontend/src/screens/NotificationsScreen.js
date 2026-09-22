import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
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
import { getDisplayBusNumber } from "../utils/busDisplay";

export default function NotificationsScreen() {
  const { token } = useAuth();
  const navigation = useNavigation();
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

  const removeNotification = async (id) => {
    try {
      await notificationApi.remove(token, id);
      setNotifications((items) =>
        items.filter((item) => String(item.id) !== String(id)),
      );
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadNotifications();
    }, [loadNotifications]),
  );

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={[styles.card, !item.read && styles.unreadCard]}
      activeOpacity={0.85}
      onPress={() => !item.read && markRead(item.id)}
    >
      <View style={styles.icon}>
        <Ionicons
          name={
            item.type === "plan_changed"
              ? "git-branch-outline"
              : item.type === "bus_status"
                ? "radio-outline"
                : "swap-horizontal"
          }
          size={22}
          color={COLORS.primary}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.message}>{item.message}</Text>
        {!item.read && <Text style={styles.unreadLabel}>Unread</Text>}
        {item.type === "plan_changed" || item.type === "bus_status" ? (
          <Text style={styles.meta}>
            {item.type === "bus_status"
              ? item.message
              : item.isBusActive
                ? "Your bus is active."
                : "Your bus is not active."}
          </Text>
        ) : (
          <>
            <Text style={styles.meta}>Bus {getDisplayBusNumber(item.oldPreview)} → Bus {getDisplayBusNumber(item.newPreview)}</Text>
            <TouchableOpacity
              style={styles.button}
              onPress={() =>
                // Navigate using preview number — PlanDetails/ctrl will accept preview
                navigation.navigate("PlanDetails", {
                  mode: "stopsForBus",
                  busNo: item.newPreview,
                })
              }
            >
              <Text style={styles.buttonText}>See stoppings</Text>
              <Ionicons name="arrow-forward" size={15} color="#fff" />
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          accessibilityLabel="Delete notification"
          style={styles.deleteButton}
          onPress={() => removeNotification(item.id)}
        >
          <Ionicons name="trash-outline" size={19} color={COLORS.textBody} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={COLORS.textHeader} />
        </TouchableOpacity>
        <Text style={styles.title}>Notifications</Text>
        <View style={{ width: 24 }} />
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
  deleteButton: { paddingLeft: 10, justifyContent: "center" },
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
