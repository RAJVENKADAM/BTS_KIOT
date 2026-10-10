import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useIsFocused } from "@react-navigation/native";
import MasterMap from "../components/Map/MasterMap";
import masterApi from "../api/masterApi";
import { getErrorMessage } from "../utils/errorHandler";
import { useAuth } from "../context/AuthContext";
import { useBus } from "../context/BusContext";
import { COLORS, SHADOWS } from "../theme";

const formatDistance = (distance) => {
  if (!Number.isFinite(Number(distance))) return null;
  return Number(distance) >= 1000
    ? `${(Number(distance) / 1000).toFixed(1)} km`
    : `${Math.round(Number(distance))} m`;
};

function getStatusMessage(status, message) {
  if (message) return message;
  if (status === "ALREADY_AT_COLLEGE") {
    return "Your current location is within 500 metres of KIOT College.";
  }
  if (status === "NO_FUTURE_STOPS") {
    return "Your bus has already passed all stops on its active route.";
  }
  if (status === "GPS_UNAVAILABLE") {
    return "Live location is currently unavailable for the active buses.";
  }
  if (status === "NO_ACTIVE_BUSES")
    return "There are no active buses right now.";
  return "No waiting stop is available right now.";
}

export default function MasterScreen({ navigation }) {
  const { token } = useAuth();
  const { getSocket } = useBus();
  const socket = getSocket ? getSocket() : null;
  const isFocused = useIsFocused();
  const [permission, setPermission] = useState("unknown");
  const [loading, setLoading] = useState(false);
  const [recommendationData, setRecommendationData] = useState(null);
  const [error, setError] = useState("");
  const refreshTimerRef = useRef(null);
  const refreshRef = useRef(null);
  const scrollRef = useRef(null);
  const mapTopRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let permissionResult = await Location.getForegroundPermissionsAsync();
      if (!permissionResult.granted) {
        permissionResult = await Location.requestForegroundPermissionsAsync();
      }
      if (!permissionResult.granted) {
        setPermission("denied");
        setRecommendationData(null);
        return;
      }
      setPermission("granted");
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: true,
      });
      const result = await masterApi.getRecommendation(
        token,
        position.coords.latitude,
        position.coords.longitude,
      );
      setRecommendationData(result);
      socket?.emit("join-master");
    } catch (refreshError) {
      setError(
        getErrorMessage(
          refreshError,
          "Could not refresh your bus recommendation.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [socket, token]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (isFocused) refresh();
  }, [isFocused, refresh]);

  useEffect(() => {
    if (!isFocused || !socket) return undefined;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshRef.current?.();
      }, 400);
    };
    const handleLocationUpdate = () => scheduleRefresh();
    const handleBusUpdate = () => scheduleRefresh();

    socket.emit("join-master");
    socket.on("locationUpdate", handleLocationUpdate);
    socket.on("bus-update", handleBusUpdate);
    socket.on("notification", handleBusUpdate);
    return () => {
      socket.emit("leave-master");
      socket.off("locationUpdate", handleLocationUpdate);
      socket.off("bus-update", handleBusUpdate);
      socket.off("notification", handleBusUpdate);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [isFocused, socket]);

  const recommendation = recommendationData?.recommendation || null;
  const status = recommendationData?.status;
  const atCollege = status === "ALREADY_AT_COLLEGE";
  const hasStop = status === "RECOMMENDED" && recommendation?.stop;

  const openLocationSettings = async () => {
    if (Platform.OS === "web") {
      await refresh();
      return;
    }
    try {
      await Linking.openSettings();
    } catch (settingsError) {
      setError(
        getErrorMessage(settingsError, "Could not open location settings."),
      );
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={COLORS.white}
        translucent={false}
      />
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Go back"
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.textHeader} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Master</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>ACTIVE BUSES NEAR YOU</Text>
        <Text style={styles.title}>WHERE SHOULD I WAIT NOW?</Text>

        {permission === "denied" ? (
          <View style={styles.noticeCard}>
            <Ionicons
              name="location-outline"
              size={30}
              color={COLORS.primary}
            />
            <Text style={styles.cardTitle}>Location Required</Text>
            <Text style={styles.body}>
              Master needs your current location to determine a nearby waiting
              stop for active buses. Your location is used for this
              recommendation only.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={openLocationSettings}
            >
              <Text style={styles.primaryButtonText}>Enable Location</Text>
            </TouchableOpacity>
          </View>
        ) : loading && !recommendationData ? (
          <View style={styles.noticeCard}>
            <ActivityIndicator color={COLORS.primary} size="large" />
            <Text style={styles.body}>
              Finding active buses and nearby stops…
            </Text>
          </View>
        ) : error && !recommendationData ? (
          <View style={styles.noticeCard}>
            <Text style={styles.cardTitle}>Couldn’t update Master</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : (
          <View style={styles.resultCard}>
            {atCollege ? (
              <>
                <Text style={styles.waitLabel}>CAMPUS ARRIVAL</Text>
                <Text style={styles.stopName}>You’re already at KIOT College</Text>
                <Text style={styles.infoText}>
                  {formatDistance(recommendation?.collegeDistanceMeters)} from
                  campus
                </Text>
              </>
            ) : hasStop ? (
              <>
                <Text style={styles.waitLabel}>
                  {recommendation.isCollegeDestination ? "GO TO" : "WAIT AT"}
                </Text>
                <Text style={styles.stopName}>{recommendation.stop.name}</Text>
                {recommendation.operationType !== "NORMAL" && (
                  <Text style={styles.operationLabel}>
                    {recommendation.operationType} SERVICE
                  </Text>
                )}
                <View style={styles.infoRow}>
                  <Text style={styles.infoText}>
                    Bus{" "}
                    {recommendation.serviceBusNumbers?.length
                      ? recommendation.serviceBusNumbers.join(" + ")
                      : recommendation.busNumber || "Nearest active bus"}
                  </Text>
                </View>
                {recommendation.operatingBusNumber &&
                  !recommendation.serviceBusNumbers?.includes(
                    String(recommendation.operatingBusNumber),
                  ) && (
                    <Text style={styles.subtleText}>
                      {recommendation.operationType === "ALTER"
                        ? `Original bus ${recommendation.busNumber} is operating as`
                        : "Service is operated by"}{" "}
                      bus {recommendation.operatingBusNumber}
                    </Text>
                  )}
                <View style={styles.metricsRow}>
                  <View style={styles.metricCard}>
                    <Text style={styles.metricLabel}>YOUR WALK</Text>
                    <Text style={styles.metricValue}>
                      {formatDistance(
                        recommendation.walkingDistanceMeters ??
                          recommendation.userDistanceToStop,
                      ) || "—"}
                    </Text>
                    <Text style={styles.metricHint}>
                      About {recommendation.walkingEtaMinutes || "—"} min
                    </Text>
                  </View>
                  {!recommendation.isCollegeDestination && (
                    <View style={styles.metricCard}>
                      <Text style={styles.metricLabel}>BUS TO STOP</Text>
                      <Text style={styles.metricValue}>
                        {recommendation.etaMinutes == null
                          ? "Updating"
                          : `${recommendation.etaMinutes} min`}
                      </Text>
                      <Text style={styles.metricHint}>
                        {formatDistance(recommendation.busRouteDistanceToStop) ||
                          "Route distance unavailable"}
                      </Text>
                    </View>
                  )}
                </View>
              </>
            ) : (
              <>
                <Text style={styles.cardTitle}>
                  {status === "NO_FUTURE_STOPS"
                    ? "ACTIVE BUSES HAVE PASSED THEIR REMAINING STOPS"
                    : status === "NO_CATCHABLE_STOPS"
                      ? "YOUR BUS CANNOT BE CAUGHT RIGHT NOW"
                      : status === "GPS_UNAVAILABLE"
                        ? "LIVE BUS LOCATION UNAVAILABLE"
                        : status === "NO_ACTIVE_BUSES"
                          ? "NO ACTIVE BUSES"
                          : "NO WAITING STOP AVAILABLE"}
                </Text>
                {recommendation?.busNumber && (
                  <Text style={styles.infoText}>
                    Bus {recommendation.busNumber}
                  </Text>
                )}
                <Text style={styles.body}>
                  {getStatusMessage(status, recommendationData?.message)}
                </Text>
              </>
            )}
          </View>
        )}

        {!!recommendation?.userLocation && !atCollege && (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() =>
              scrollRef.current?.scrollTo({
                y: Math.max(0, mapTopRef.current - 12),
                animated: true,
              })
            }
          >
            <Text style={styles.secondaryButtonText}>
              {status === "NO_FUTURE_STOPS"
                ? "VIEW BUS LOCATION"
                : "VIEW LIVE MAP"}
            </Text>
          </TouchableOpacity>
        )}

        {!!recommendation?.userLocation && !atCollege && (
          <View
            style={styles.mapCard}
            onLayout={(event) => {
              mapTopRef.current = event.nativeEvent.layout.y;
            }}
          >
            <Text style={styles.mapTitle}>LIVE MAP</Text>
            <Text style={styles.mapCaption}>
              {hasStop
                ? "Active bus route · stops in order · KIOT College destination"
                : "Your location · nearest active bus"}
            </Text>
            <View style={styles.mapContainer}>
              <MasterMap recommendation={recommendation} />
            </View>
          </View>
        )}

        {recommendation?.gps?.status === "UNAVAILABLE" && (
          <View style={styles.noticeInline}>
            <Ionicons
              name="alert-circle-outline"
              size={20}
              color={COLORS.warning}
            />
            <Text style={[styles.body, styles.noticeInlineBody]}>
              Live bus location is currently unavailable. No bus position or ETA
              is being estimated.
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.disabledButton]}
          onPress={refresh}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>REFRESH</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.footer}>
          Master checks all active buses and recommends a nearby catchable stop
          under the active plan.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    height: 40,
    width: 40,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: COLORS.textHeader },
  content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 34 },
  eyebrow: {
    marginTop: 8,
    color: COLORS.primary,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 1,
  },
  title: {
    color: COLORS.textHeader,
    fontSize: 21,
    fontWeight: "800",
    marginTop: 7,
    marginBottom: 4,
    flexShrink: 1,
  },
  planLabel: {
    fontSize: 13,
    color: COLORS.textBody,
    marginBottom: 16,
    flexShrink: 1,
  },
  resultCard: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 20,
    marginTop: 14,
    ...SHADOWS.soft,
  },
  waitLabel: { color: COLORS.primary, fontWeight: "800", fontSize: 12 },
  operationLabel: {
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: "#EFF6FF",
    color: COLORS.primary,
    borderRadius: 8,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 4,
  },
  stopName: {
    marginTop: 6,
    marginBottom: 14,
    color: COLORS.textHeader,
    fontSize: 22,
    fontWeight: "800",
    flexShrink: 1,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 10,
  },
  infoText: {
    color: COLORS.textHeader,
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  metricCard: {
    flex: 1,
    minWidth: 0,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#F4F7FB",
  },
  metricLabel: {
    color: COLORS.textBody,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  metricValue: {
    marginTop: 5,
    color: COLORS.textHeader,
    fontSize: 17,
    fontWeight: "800",
  },
  metricHint: {
    marginTop: 3,
    color: COLORS.textBody,
    fontSize: 12,
  },
  etaText: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 14,
    flexShrink: 1,
  },
  subtleText: {
    color: COLORS.textBody,
    fontSize: 12,
    marginTop: 5,
    lineHeight: 18,
    flexShrink: 1,
  },
  timestamp: {
    marginTop: 17,
    color: COLORS.textBody,
    fontSize: 12,
    flexShrink: 1,
  },
  cardTitle: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "800",
    color: COLORS.textHeader,
    marginTop: 10,
    flexShrink: 1,
  },
  body: {
    color: COLORS.textBody,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    flexShrink: 1,
  },
  noticeCard: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    marginTop: 16,
    ...SHADOWS.soft,
  },
  primaryButton: {
    minHeight: 48,
    marginTop: 18,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  primaryButtonText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: "800",
    flexShrink: 1,
    textAlign: "center",
  },
  disabledButton: { opacity: 0.65 },
  secondaryButton: {
    minHeight: 44,
    marginTop: 10,
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  secondaryButtonText: {
    color: COLORS.primary,
    fontWeight: "800",
    fontSize: 13,
    flexShrink: 1,
    textAlign: "center",
  },
  mapCard: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 14,
    marginTop: 18,
    ...SHADOWS.soft,
  },
  mapTitle: { color: COLORS.textHeader, fontWeight: "800", fontSize: 16 },
  mapCaption: {
    color: COLORS.textBody,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 10,
    flexShrink: 1,
  },
  mapContainer: { height: 320, overflow: "hidden", borderRadius: 12 },
  noticeInline: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#FFFBEB",
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
  },
  noticeInlineBody: { flex: 1, minWidth: 0, marginTop: 0 },
  errorText: {
    color: COLORS.error,
    fontSize: 13,
    marginTop: 10,
    flexShrink: 1,
  },
  footer: {
    textAlign: "center",
    color: COLORS.textBody,
    fontSize: 12,
    marginTop: 14,
    flexShrink: 1,
  },
});
