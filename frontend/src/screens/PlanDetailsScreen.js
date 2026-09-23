import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../context/AuthContext";
import busApi from "../api/busApi";
import { COLORS } from "../theme";
import { getDisplayBusNumber } from "../utils/busDisplay";
import * as Location from "expo-location";

const distanceBetween = (lat1, lng1, lat2, lng2) => {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const radius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export default function PlanDetailsScreen({ route, navigation }) {
  const {
    mode = "activePlan",
    plan: initialPlan,
    previewNumber,
    busNo,
    showNearby = false,
  } = route.params || {};
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [planName, setPlanName] = useState(initialPlan || "PLAN A");
  const [nearbyMode, setNearbyMode] = useState(showNearby);
  const [nearbyMessage, setNearbyMessage] = useState("");

  const loadActivePlanBuses = useCallback(
    async (plan) => {
      try {
        setLoading(true);
        setError(null);
        const global = await busApi.getGlobalActivePlan(token);
        const p = global?.activePlan || plan || "PLAN A";
        const data = await busApi.getBusesForPlan(token, p);
        let buses = data?.buses || data?.data || [];

        // Sort buses in ascending order based on their display/preview number
        buses.sort((a, b) => {
          const numA = parseInt(getDisplayBusNumber(a), 10) || 0;
          const numB = parseInt(getDisplayBusNumber(b), 10) || 0;
          return numA - numB;
        });

        setItems(buses);
        setPlanName(p);
      } catch (err) {
        console.log("PlanDetails: failed to load buses", err.message || err);
        setError("Failed to load buses for this plan.");
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  const loadNearbyBuses = useCallback(async () => {
    setNearbyMode(true);
    setLoading(true);
    setError(null);
    setNearbyMessage("");
    try {
      const global = await busApi.getGlobalActivePlan(token);
      const p = global?.activePlan || "PLAN A";
      const data = await busApi.getBusesForPlan(token, p);
      let buses = data?.buses || [];
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") {
          throw new Error("permission");
        }
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        buses = buses
          .map((bus) => ({
            ...bus,
            distance: distanceBetween(
              position.coords.latitude,
              position.coords.longitude,
              Number(bus.latitude),
              Number(bus.longitude),
            ),
          }))
          .sort((a, b) => {
            if (a.distance == null) return 1;
            if (b.distance == null) return -1;
            return a.distance - b.distance;
          });
        setNearbyMessage(
          buses.some((bus) => bus.distance != null)
            ? "Nearest active buses are listed first."
            : "Bus GPS locations are unavailable, so all active-plan buses are shown.",
        );
      } catch {
        setNearbyMessage(
          "Your location or bus GPS could not be fetched, so all active-plan buses are shown.",
        );
      }
      setItems(buses);
      setPlanName(p);
    } catch {
      setError("Failed to load active-plan buses.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadStopsForBus = useCallback(
    async (busIdentifier) => {
      try {
        setLoading(true);
        setError(null);
        const target = busNo || busIdentifier || previewNumber;
        const data = await busApi.getBusRoutes(token, target);
        if (Array.isArray(data?.stops)) {
          setItems(data.stops);
          setPlanName(data.activePlan || data.currentPlan || "Current plan");
        } else if (data?.plans) {
          const active =
            data?.activePlan || data?.currentPlan || Object.keys(data.plans)[0];
          const stops = data.plans[active] || [];
          setItems(stops);
          setPlanName(active);
        } else if (Array.isArray(data)) {
          setItems(data);
        } else {
          setItems([]);
        }
      } catch (err) {
        console.log("PlanDetails: failed to load stops", err.message || err);
        setError("Failed to load stops for this bus.");
      } finally {
        setLoading(false);
      }
    },
    [token, previewNumber, busNo],
  );

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
    if (mode === "activePlan") {
      if (showNearby) loadNearbyBuses();
      else loadActivePlanBuses(initialPlan);
    } else if (mode === "stopsForBus") {
      loadStopsForBus(busNo || previewNumber);
    }
  }, [
    mode,
    initialPlan,
    previewNumber,
    busNo,
    loadActivePlanBuses,
    loadStopsForBus,
    showNearby,
    loadNearbyBuses,
  ]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={COLORS.textBody} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {mode === "activePlan"
              ? `Plan ${planName}`
              : `Bus ${busNo || previewNumber}`}
          </Text>
          <Text style={styles.subtitle}>
            {mode === "activePlan"
              ? "List of buses in this plan"
              : `Stops for ${getDisplayBusNumber({ previewNumber, busNo })}`}
          </Text>
          {mode === "activePlan" && (
            <TouchableOpacity
              style={styles.nearbyButton}
              onPress={loadNearbyBuses}
              disabled={loading}
            >
              <Ionicons name="navigate-outline" size={15} color="#fff" />
              <Text style={styles.nearbyButtonText}>
                {nearbyMode ? "Refresh nearest buses" : "Nearby active buses"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.content}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={COLORS.primary} />
            <Text style={styles.loadingText}>Loading…</Text>
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={[styles.errorText]}>{error}</Text>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No items found.</Text>
          </View>
        ) : (
          <ScrollView>
            {mode === "activePlan" ? (
              <View style={styles.gridContainer}>
                {!!nearbyMessage && (
                  <Text style={styles.nearbyMessage}>{nearbyMessage}</Text>
                )}
                {items.map((it, idx) => (
                  <View
                    key={idx}
                    style={styles.gridItem}
                  >
                    <Text style={styles.gridItemText}>
                      {getDisplayBusNumber(it)}
                    </Text>
                    {it.distance != null && (
                      <Text style={styles.distanceText}>
                        {it.distance.toFixed(1)} km
                      </Text>
                    )}
                    <TouchableOpacity
                      style={styles.stopsButton}
                      onPress={() => {
                        const targetBusNo =
                          it.busNo ||
                          it.bus_no ||
                          it.previewNumber ||
                          it.preview_number;
                        navigation.push("PlanDetails", {
                          mode: "stopsForBus",
                          busNo: targetBusNo,
                          plan: planName,
                        });
                      }}
                    >
                      <Text style={styles.stopsButtonText}>View stops</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : (
              items.map((it, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.row}
                  onPress={() => {}}
                >
                  <Text
                    style={styles.rowText}
                  >{`${idx + 1}. ${it.stop_name || it.name || JSON.stringify(it)}`}</Text>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 12,
    backgroundColor: "rgba(255,255,255,0.98)",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  backBtn: { marginRight: 8, padding: 6 },
  title: { fontSize: 18, fontWeight: "700", color: COLORS.textHeader },
  subtitle: { fontSize: 12, color: COLORS.textBody, marginTop: 2 },
  nearbyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },
  nearbyButtonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  nearbyMessage: {
    width: "100%",
    color: COLORS.textBody,
    fontSize: 12,
    marginBottom: 8,
    textAlign: "center",
  },
  distanceText: { color: COLORS.textBody, fontSize: 11, marginTop: 4 },
  stopsButton: {
    marginTop: 7,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "#E8F0FE",
  },
  stopsButtonText: { color: COLORS.primary, fontSize: 11, fontWeight: "700" },
  content: { flex: 1, padding: 16 },
  centered: { alignItems: "center", justifyContent: "center", paddingTop: 24 },
  loadingText: { marginTop: 8, color: COLORS.textBody },
  errorText: { color: "#e74c3c" },
  emptyText: { color: COLORS.textBody },
  gridContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  gridItem: {
    width: "18%", // Roughly 100% / 5 minus a little gap space
    aspectRatio: 1,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: COLORS.white,
    marginBottom: 10,
    elevation: 1,
  },
  gridItemText: { color: COLORS.textHeader, fontWeight: "600", fontSize: 14 },
  row: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: COLORS.white,
    marginBottom: 10,
    elevation: 1,
  },
  rowText: { color: COLORS.textHeader, fontWeight: "600" },
});
