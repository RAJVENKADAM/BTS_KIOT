import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "../context/AuthContext";
import notificationApi from "../api/notificationApi";
import { COLORS } from "../theme";

export default function NotificationsScreen() {
  const { token } = useAuth();
  const navigation = useNavigation();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await notificationApi.getAll(token);
      setNotifications(data.notifications || []);
      await notificationApi.markRead(token);
    } catch (error) {
      console.error("Failed to load notifications:", error);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.icon}>
        <Ionicons name="swap-horizontal" size={22} color={COLORS.primary} />
      </View>
      <View style={styles.body}>
        <Text style={styles.message}>{item.message}</Text>
        <Text style={styles.meta}>Bus {item.oldBusNo} → Bus {item.newBusNo}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() =>
            navigation.navigate("PlanDetails", {
              mode: "stopsForBus",
              busNo: item.newBusNo,
            })
          }
        >
          <Text style={styles.buttonText}>See stoppings</Text>
          <Ionicons name="arrow-forward" size={15} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
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
  icon: { marginRight: 12, paddingTop: 2 },
  body: { flex: 1 },
  message: { color: COLORS.textHeader, fontSize: 15, fontWeight: "600" },
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
