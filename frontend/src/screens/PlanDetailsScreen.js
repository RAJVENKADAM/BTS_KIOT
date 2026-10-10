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
import { getErrorMessage } from "../utils/errorHandler";

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

  const [routeBusPreviewNumber, setRouteBusPreviewNumber] = useState(null);
  const [isReplacementRoute, setIsReplacementRoute] = useState(false);
  const [routeSelectionLabel, setRouteSelectionLabel] = useState(null);

  /**
   * ---------------------------------------------------------
   * LOAD ACTIVE PLAN BUSES
   * ---------------------------------------------------------
   *
   * The backend should return buses belonging to the current
   * active plan.
   *
   * Buses that are currently out of their assigned route are
   * excluded here when the backend provides one of:
   *
   *   outOfRoute
   *   isOutOfRoute
   *   routeStatus === "OUT_OF_ROUTE"
   *
   * Route validation itself should ideally happen in backend
   * using the active route/stops assigned to that bus.
   */
  const loadActivePlanBuses = useCallback(
    async (requestedPlan) => {
      try {
        setLoading(true);
        setError(null);

        const global = await busApi.getGlobalActivePlan(token);

        const activePlan = global?.activePlan || requestedPlan || "PLAN A";

        const data = await busApi.getBusesForPlan(token, activePlan);

        let buses = data?.buses || data?.data || [];

        /**
         * Exclude buses which backend has identified as being
         * outside their active route.
         *
         * If your backend does not currently send these fields,
         * all active-plan buses will remain visible.
         */
        buses = buses.filter((bus) => {
          if (bus?.outOfRoute === true) return false;
          if (bus?.isOutOfRoute === true) return false;

          if (
            typeof bus?.routeStatus === "string" &&
            bus.routeStatus.toUpperCase() === "OUT_OF_ROUTE"
          ) {
            return false;
          }

          return true;
        });

        /**
         * Sort buses by their display number.
         */
        buses.sort((a, b) => {
          const numA = parseInt(getDisplayBusNumber(a), 10) || 0;
          const numB = parseInt(getDisplayBusNumber(b), 10) || 0;

          return numA - numB;
        });

        setItems(buses);
        setPlanName(activePlan);
      } catch (err) {
        console.log("PlanDetails: failed to load buses", err?.message || err);

        setError(getErrorMessage(err, "Could not load buses for this plan."));
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  /**
   * ---------------------------------------------------------
   * LOAD ORDERED STOPS FOR BUS
   * ---------------------------------------------------------
   *
   * The backend should return only the ACTIVE stops assigned
   * to this bus and in their actual route order.
   *
   * Example:
   *
   * 1. Idappadi
   * 2. Sankari
   * 3. Magudanchavadi
   * 4. Konganapuram
   * 5. KIOT College
   *
   * This order can also be used by the map screen to generate
   * the route polyline.
   */
  const loadStopsForBus = useCallback(
    async (busIdentifier) => {
      try {
        setLoading(true);
        setError(null);

        const target = busNo || busIdentifier || previewNumber;

        const data = await busApi.getBusRoutes(token, target);

        setRouteBusPreviewNumber(
          data?.routeBusPreviewNumber ?? previewNumber ?? busNo ?? null,
        );

        setIsReplacementRoute(data?.isReplacementRoute === true);

        setRouteSelectionLabel(data?.routeSelectionLabel ?? null);

        /**
         * Preferred backend response:
         *
         * {
         *   activePlan: "PLAN A",
         *   stops: [...]
         * }
         */
        if (Array.isArray(data?.stops)) {
          setItems(normalizeAndOrderStops(data.stops));

          setPlanName(data?.activePlan || data?.currentPlan || "Current plan");

          return;
        }

        /**
         * Backward compatibility for:
         *
         * {
         *   plans: {
         *     "PLAN A": [...]
         *   }
         * }
         */
        if (data?.plans) {
          const active =
            data?.activePlan || data?.currentPlan || Object.keys(data.plans)[0];

          const stops = data.plans[active] || [];

          setItems(normalizeAndOrderStops(stops));

          setPlanName(active);

          return;
        }

        /**
         * Backward compatibility if API directly returns array.
         */
        if (Array.isArray(data)) {
          setItems(normalizeAndOrderStops(data));

          return;
        }

        setItems([]);
      } catch (err) {
        console.log("PlanDetails: failed to load stops", err?.message || err);

        setError(getErrorMessage(err, "Could not load stops for this bus."));
      } finally {
        setLoading(false);
      }
    },
    [token, previewNumber, busNo],
  );

  /**
   * ---------------------------------------------------------
   * NORMALIZE / ORDER STOPS
   * ---------------------------------------------------------
   *
   * Backend should preferably already return stops in route
   * order.
   *
   * If stop_order / order / sequence is available, this gives
   * us an additional safety layer.
   */
  const normalizeAndOrderStops = (stops) => {
    if (!Array.isArray(stops)) {
      return [];
    }

    return [...stops].filter(Boolean).sort((a, b) => {
      const orderA = Number(
        a?.stop_order ?? a?.stopOrder ?? a?.sequence ?? a?.order ?? 0,
      );

      const orderB = Number(
        b?.stop_order ?? b?.stopOrder ?? b?.sequence ?? b?.order ?? 0,
      );

      /**
       * If no order is provided for either stop, preserve
       * backend order.
       */
      if (!orderA && !orderB) return 0;

      if (!orderA) return 1;
      if (!orderB) return -1;

      return orderA - orderB;
    });
  };

  /**
   * ---------------------------------------------------------
   * INITIAL LOAD
   * ---------------------------------------------------------
   */
  useEffect(() => {
    navigation.setOptions({
      headerShown: false,
    });

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
    navigation,
  ]);

  /**
   * ---------------------------------------------------------
   * BUS CARD
   * ---------------------------------------------------------
   */
  const renderBusCard = (bus, index) => {
    const displayNumber = getDisplayBusNumber(bus);

    const stopCount = Number(
      bus?.activeStopCount ?? bus?.stopCount ?? bus?.stops?.length ?? 0,
    );

    const isOperating = bus?.isActive !== false && bus?.status !== "INACTIVE";

    return (
      <View
        key={bus?._id || bus?.id || bus?.busNo || index}
        style={styles.busCard}
      >
        <View style={styles.busCardTop}>
          <View style={styles.busIconContainer}>
            <Ionicons name="bus" size={25} color={COLORS.primary} />
          </View>

          <View style={styles.busInfo}>
            <Text style={styles.busLabel}>BUS</Text>

            <Text style={styles.busNumber}>{displayNumber}</Text>
          </View>

          <View
            style={[
              styles.statusBadge,
              isOperating ? styles.statusActive : styles.statusInactive,
            ]}
          >
            <View
              style={[
                styles.statusDot,
                isOperating ? styles.statusDotActive : styles.statusDotInactive,
              ]}
            />

            <Text
              style={[
                styles.statusText,
                isOperating
                  ? styles.statusTextActive
                  : styles.statusTextInactive,
              ]}
            >
              {isOperating ? "ACTIVE" : "INACTIVE"}
            </Text>
          </View>
        </View>

        <View style={styles.routeSummary}>
          <View style={styles.routeSummaryItem}>
            <Ionicons
              name="location-outline"
              size={17}
              color={COLORS.textBody}
            />

            <Text style={styles.routeSummaryText}>
              {stopCount > 0 ? `${stopCount} active stops` : "Active route"}
            </Text>
          </View>

          {bus?.routeName && (
            <View style={styles.routeSummaryItem}>
              <Ionicons
                name="git-network-outline"
                size={17}
                color={COLORS.textBody}
              />

              <Text style={styles.routeSummaryText} numberOfLines={1}>
                {bus.routeName}
              </Text>
            </View>
          )}
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          style={styles.viewStopsButton}
          onPress={() => {
            const targetBusNo =
              bus?.busNo ||
              bus?.bus_no ||
              bus?.previewNumber ||
              bus?.preview_number;

            navigation.push("PlanDetails", {
              mode: "stopsForBus",
              busNo: targetBusNo,
              previewNumber: bus?.previewNumber || bus?.preview_number,
              plan: planName,
            });
          }}
        >
          <Text style={styles.viewStopsText}>View route stops</Text>

          <Ionicons name="arrow-forward" size={16} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
    );
  };

  /**
   * ---------------------------------------------------------
   * STOP ROW
   * ---------------------------------------------------------
   */
  const renderStop = (stop, index) => {
    const stopName =
      stop?.stop_name || stop?.stopName || stop?.name || `Stop ${index + 1}`;

    const isFirst = index === 0;
    const isLast = index === items.length - 1;

    return (
      <View
        key={stop?._id || stop?.id || `${stopName}-${index}`}
        style={styles.stopContainer}
      >
        <View style={styles.stopTimeline}>
          <View
            style={[
              styles.stopCircle,
              isFirst && styles.startCircle,
              isLast && styles.destinationCircle,
            ]}
          >
            <Text style={styles.stopNumber}>{index + 1}</Text>
          </View>

          {!isLast && <View style={styles.timelineLine} />}
        </View>

        <View style={styles.stopCard}>
          <View style={styles.stopHeader}>
            <Text style={styles.stopOrder}>
              STOP {String(index + 1).padStart(2, "0")}
            </Text>

            {isFirst && (
              <View style={styles.startBadge}>
                <Text style={styles.startBadgeText}>START</Text>
              </View>
            )}

            {isLast && (
              <View style={styles.destinationBadge}>
                <Text style={styles.destinationBadgeText}>DESTINATION</Text>
              </View>
            )}
          </View>

          <Text style={styles.stopName} numberOfLines={2}>
            {stopName}
          </Text>

          {(stop?.latitude != null || stop?.lat != null) &&
            (stop?.longitude != null || stop?.lng != null) && (
              <Text style={styles.coordinateText}>
                {Number(stop?.latitude ?? stop?.lat).toFixed(5)}
                {" , "}
                {Number(stop?.longitude ?? stop?.lng).toFixed(5)}
              </Text>
            )}
        </View>
      </View>
    );
  };

  /**
   * ---------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------
   */
  return (
    <View style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={23} color={COLORS.textHeader} />
        </TouchableOpacity>

        <View style={styles.headerTextContainer}>
          <Text style={styles.title}>
            {mode === "activePlan"
              ? `Plan ${planName}`
              : `Bus ${routeBusPreviewNumber ?? busNo ?? previewNumber ?? ""}`}
          </Text>

          <Text style={styles.subtitle}>
            {mode === "activePlan"
              ? "Active buses and their assigned routes"
              : routeSelectionLabel
                ? `Showing ${routeSelectionLabel}`
                : isReplacementRoute
                  ? "Replacement route"
                  : "Current active route"}
          </Text>
        </View>
      </View>

      {/* CONTENT */}
      <View style={styles.content}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={COLORS.primary} />

            <Text style={styles.loadingText}>Loading route information...</Text>
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <View style={styles.errorIcon}>
              <Ionicons name="alert-circle-outline" size={28} color="#D64545" />
            </View>

            <Text style={styles.errorTitle}>Unable to load route</Text>

            <Text style={styles.errorText}>{error}</Text>

            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                if (mode === "activePlan") {
                  loadActivePlanBuses(initialPlan);
                } else {
                  loadStopsForBus(busNo || previewNumber);
                }
              }}
            >
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centered}>
            <View style={styles.emptyIcon}>
              <Ionicons
                name={
                  mode === "activePlan" ? "bus-outline" : "location-outline"
                }
                size={32}
                color={COLORS.textBody}
              />
            </View>

            <Text style={styles.emptyTitle}>
              {mode === "activePlan" ? "No active buses" : "No active stops"}
            </Text>

            <Text style={styles.emptyText}>
              {mode === "activePlan"
                ? "There are no buses currently assigned to this active plan."
                : "This bus has no active stops assigned to its current route."}
            </Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
            {mode === "activePlan" ? (
              <>
                {/* PLAN SUMMARY */}
                <View style={styles.summaryCard}>
                  <View style={styles.summaryIcon}>
                    <Ionicons
                      name="map-outline"
                      size={22}
                      color={COLORS.primary}
                    />
                  </View>

                  <View style={styles.summaryTextContainer}>
                    <Text style={styles.summaryTitle}>Active Route Plan</Text>

                    <Text style={styles.summaryDescription}>
                      {items.length} active{" "}
                      {items.length === 1 ? "bus" : "buses"} currently assigned
                      to {planName}.
                    </Text>
                  </View>
                </View>

                {/* BUS LIST */}
                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={styles.sectionTitle}>Active Buses</Text>

                    <Text style={styles.sectionSubtitle}>
                      Select a bus to view its ordered stops
                    </Text>
                  </View>

                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{items.length}</Text>
                  </View>
                </View>

                {items.map(renderBusCard)}
              </>
            ) : (
              <>
                {isReplacementRoute && (
                  <View style={styles.replacementBanner}>
                    <Ionicons
                      name="swap-horizontal-outline"
                      size={19}
                      color="#9A6700"
                    />

                    <Text style={styles.replacementText}>
                      This bus is currently serving a replacement route.
                    </Text>
                  </View>
                )}

                {/* ORDERED STOPS */}
                <View style={styles.stopsSection}>{items.map(renderStop)}</View>

                {/* POLYLINE INFORMATION */}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

/**
 * =========================================================
 * STYLES
 * =========================================================
 */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  /* HEADER */

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 15,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: "#E8E8E8",
  },

  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F4F6F8",
    marginRight: 11,
  },

  headerTextContainer: {
    flex: 1,
  },

  title: {
    fontSize: 19,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  subtitle: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 3,
    lineHeight: 17,
  },

  /* CONTENT */

  content: {
    flex: 1,
    paddingHorizontal: 16,
  },

  scrollContent: {
    paddingTop: 16,
    paddingBottom: 30,
  },

  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
    paddingTop: 80,
  },

  loadingText: {
    marginTop: 10,
    color: COLORS.textBody,
    fontSize: 13,
  },

  /* SUMMARY */

  summaryCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 15,
    borderRadius: 14,
    backgroundColor: "#EEF4FF",
    borderWidth: 1,
    borderColor: "#DCE8FF",
    marginBottom: 22,
  },

  summaryIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.white,
    marginRight: 12,
  },

  summaryTextContainer: {
    flex: 1,
  },

  summaryTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  summaryDescription: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 4,
    lineHeight: 17,
  },

  /* SECTION */

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },

  sectionTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  sectionSubtitle: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 3,
  },

  countBadge: {
    minWidth: 30,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  countBadgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
  },

  /* BUS CARD */

  busCard: {
    backgroundColor: COLORS.white,
    borderRadius: 15,
    padding: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#E9E9E9",
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 5,
    shadowOffset: {
      width: 0,
      height: 2,
    },
  },

  busCardTop: {
    flexDirection: "row",
    alignItems: "center",
  },

  busIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 13,
    backgroundColor: "#EEF4FF",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  busInfo: {
    flex: 1,
  },

  busLabel: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    color: COLORS.textBody,
  },

  busNumber: {
    fontSize: 20,
    fontWeight: "800",
    color: COLORS.textHeader,
    marginTop: 1,
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 20,
  },

  statusActive: {
    backgroundColor: "#E9F8EF",
  },

  statusInactive: {
    backgroundColor: "#F4F4F4",
  },

  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },

  statusDotActive: {
    backgroundColor: "#1B9A55",
  },

  statusDotInactive: {
    backgroundColor: "#999999",
  },

  statusText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },

  statusTextActive: {
    color: "#167A43",
  },

  statusTextInactive: {
    color: "#777777",
  },

  routeSummary: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#F0F0F0",
  },

  routeSummaryItem: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
  },

  routeSummaryText: {
    fontSize: 11,
    color: COLORS.textBody,
    marginLeft: 5,
  },

  viewStopsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 13,
    paddingVertical: 10,
    borderRadius: 9,
    backgroundColor: "#EEF4FF",
  },

  viewStopsText: {
    fontSize: 12,
    fontWeight: "800",
    color: COLORS.primary,
    marginRight: 6,
  },

  /* ROUTE HEADER */

  routeHeaderCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E8E8E8",
    padding: 15,
    marginBottom: 12,
  },

  routeHeaderIcon: {
    width: 45,
    height: 45,
    borderRadius: 12,
    backgroundColor: "#EEF4FF",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  routeHeaderContent: {
    flex: 1,
  },

  routeHeaderTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  routeHeaderSubtitle: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 3,
  },

  /* REPLACEMENT */

  replacementBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FFF7DF",
    borderWidth: 1,
    borderColor: "#F0D98A",
    marginBottom: 15,
  },

  replacementText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 11,
    lineHeight: 16,
    color: "#795600",
    fontWeight: "600",
  },

  /* STOPS */

  stopsSection: {
    marginTop: 3,
  },

  stopContainer: {
    flexDirection: "row",
    minHeight: 91,
  },

  stopTimeline: {
    width: 42,
    alignItems: "center",
  },

  stopCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#E8EDF3",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },

  startCircle: {
    backgroundColor: COLORS.primary,
  },

  destinationCircle: {
    backgroundColor: "#1B9A55",
  },

  stopNumber: {
    fontSize: 10,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  timelineLine: {
    position: "absolute",
    top: 29,
    bottom: -1,
    width: 2,
    backgroundColor: "#D9DEE5",
  },

  stopCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    marginLeft: 8,
    borderWidth: 1,
    borderColor: "#E9E9E9",
  },

  stopHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 5,
  },

  stopOrder: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: COLORS.textBody,
    flex: 1,
  },

  startBadge: {
    backgroundColor: "#E8F0FE",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
  },

  startBadgeText: {
    fontSize: 8,
    fontWeight: "800",
    color: COLORS.primary,
  },

  destinationBadge: {
    backgroundColor: "#E8F7EF",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
  },

  destinationBadgeText: {
    fontSize: 8,
    fontWeight: "800",
    color: "#167A43",
  },

  stopName: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textHeader,
    lineHeight: 19,
  },

  coordinateText: {
    fontSize: 9,
    color: "#8A8F98",
    marginTop: 5,
  },

  /* ROUTE INFO */

  routeInfoCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 14,
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: "#F5F8FC",
    borderWidth: 1,
    borderColor: "#E4EAF2",
  },

  routeInfoContent: {
    flex: 1,
    marginLeft: 9,
  },

  routeInfoTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  routeInfoDescription: {
    fontSize: 11,
    lineHeight: 16,
    color: COLORS.textBody,
    marginTop: 4,
  },

  /* EMPTY */

  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0F2F5",
    marginBottom: 15,
  },

  emptyTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  emptyText: {
    textAlign: "center",
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textBody,
    marginTop: 6,
  },

  /* ERROR */

  errorIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF0F0",
    marginBottom: 14,
  },

  errorTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: COLORS.textHeader,
  },

  errorText: {
    textAlign: "center",
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.textBody,
    marginTop: 6,
  },

  retryButton: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },

  retryText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
  },
});
