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

export default function PlanDetailsScreen({ route, navigation }) {
  const {
    mode = "activePlan",
    plan: initialPlan,
    previewNumber,
    busNo,
  } = route.params || {};
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [planName, setPlanName] = useState(initialPlan || "PLAN A");

  const loadActivePlanBuses = useCallback(
    async (plan) => {
      try {
        setLoading(true);
        setError(null);
        const p = plan || planName || "PLAN A";
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
    [token, planName],
  );

  const loadStopsForBus = useCallback(
    async (busIdentifier) => {
      try {
        setLoading(true);
        setError(null);
        const target = busNo || busIdentifier || previewNumber;
        const data = await busApi.getBusRoutes(token, target);
        if (data?.plans) {
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
      loadActivePlanBuses(initialPlan);
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
                {items.map((it, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.gridItem}
                    onPress={() => {
                      const targetBusNo =
                        it.busNo ||
                        it.bus_no ||
                        it.previewNumber ||
                        it.preview_number;
                      navigation.push("PlanDetails", {
                        mode: "stopsForBus",
                        busNo: targetBusNo,
                      });
                    }}
                  >
                    <Text style={styles.gridItemText}>
                      {getDisplayBusNumber(it)}
                    </Text>
                  </TouchableOpacity>
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
