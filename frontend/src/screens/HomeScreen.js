/**
 * HomeScreen — Primary screen for live bus tracking.
 *
 * Architecture & Data Flow:
 * ─────────────────────────
 * 1. UI renders an OpenStreetMap (Leaflet via WebView) as fullscreen background.
 * 2. Top bar overlay provides search input (bus number or preview number) +
 *    "Organize" (admin only) + Profile nav icons.
 * 3. @gorhom/bottom-sheet houses status info: bus card with distance-to-college,
 *    marker status (moving/waiting/stopped), error/loading states.
 *
 * State Management:
 * ─────────────────
 * - AuthContext provides { token, user } for API auth.
 * - BusContext provides { error, refreshBuses, getSocket } for bus list + socket.
 * - Local state tracks search query, busData (latest GPS), location status,
 *   marker movement state, and display logic.
 *
 * Socket Integration:
 * ───────────────────
 * - Joins/leaves socket room "bus_{busNo}" when selectedBusNo changes.
 * - Listens for "bus-update" events to update currentPlan in real time.
 * - No polling — live updates are socket-driven; manual refresh via handleRefresh.
 *
 * Search & Marker Rules:
 * ───────────────────────
 * - Non-admin users auto-load bus_no from user profile; can only see their bus.
 * - Superadmin searches explicitly; "not found" clears all previous markers.
 * - Marker only shows when shouldShowBusMarker evaluates to true — never falls
 *   back to stale lastGoodLocation for a failed search.
 *
 * Bus Status Detection:
 * ──────────────────────
 * - detectBusStatus tracks coordinate repetition via refs.
 *   - Same coord 3x → "waiting"
 *   - Same coord 10x → "stopped"
 *   - Different coord → "moving"
 * - chooseBusStatus prioritises API's "stopped" state over coordinate detection.
 */
import React, { useState, useRef, useEffect, useCallback } from "react";
import OSMMap from "../components/Map/OSMMap";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  StatusBar,
  Platform,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useBus } from "../context/BusContext";
import busApi from "../api/busApi";
import { COLORS, SHADOWS } from "../theme";
import { useAuth } from "../context/AuthContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";

const SNAP_POINTS = ["25%", "50%", "75%"];

const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const HomeScreen = () => {
  const { token, user } = useAuth();
  const navigation = useNavigation();
  const role = (user?.role || "student").toLowerCase();
  const isAdmin = role === "superadmin";
  const { error, refreshBuses, getSocket } = useBus();
  const socket = getSocket ? getSocket() : null;

  const [searchQuery, setSearchQuery] = useState("");
  const [busData, setBusData] = useState(null);
  const [noBusFound, setNoBusFound] = useState(false);
  const [isBusSearchAttempted, setIsBusSearchAttempted] = useState(false);
  const [selectedPreviewNumber, setSelectedPreviewNumber] = useState(null);
  const [selectedBusNo, setSelectedBusNo] = useState(null);
  const [lastGoodLocation, setLastGoodLocation] = useState(null);
  const [isSuperadminSearched, setIsSuperadminSearched] = useState(false);
  const [locationStatus, setLocationStatus] = useState("idle");
  const [markerStatus, setMarkerStatus] = useState("moving");
  const [isOffline, setIsOffline] = useState(false);

  // Plan / routes modal state
  const [routesData, setRoutesData] = useState(null);
  const [showStopsModal, setShowStopsModal] = useState(false);
  const [activePlanTab, setActivePlanTab] = useState("PLAN A");
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  // True once the searched/selected bus is confirmed to exist (even offline / no GPS)
  const [isBusFound, setIsBusFound] = useState(false);

  const lastCoordinateRef = useRef(null);
  const sameCoordinateCountRef = useRef(0);
  const busStatusRef = useRef("moving");
  const selectedBusNoRef = useRef(selectedBusNo);
  useEffect(() => {
    selectedBusNoRef.current = selectedBusNo;
  }, [selectedBusNo]);
  const lastPlanRef = useRef(null);
  // ⚠️ FIX: Search counter to prevent stale state.
  // Incremented on each new search. After async API call completes,
  // we check if this is still the latest search — if not, ignore the result.
  const searchCounterRef = useRef(0);

  useEffect(() => {
    const persistBusData = async () => {
      if (locationStatus === "loading") return;
      try {
        if (selectedBusNo) {
          await AsyncStorage.setItem("selectedBusNo", selectedBusNo);
        }
        if (selectedPreviewNumber) {
          await AsyncStorage.setItem(
            "selectedPreviewNumber",
            selectedPreviewNumber,
          );
        }
        if (busData && locationStatus !== "error") {
          await AsyncStorage.setItem("savedBusData", JSON.stringify(busData));
        }
      } catch (err) {
        console.log("Error persisting bus data:", err);
      }
    };
    persistBusData();
  }, [selectedBusNo, selectedPreviewNumber, busData, locationStatus]);

  useEffect(() => {
    if (user?.bus_no && !isAdmin && !selectedBusNo && !selectedPreviewNumber) {
      setSelectedBusNo(user.bus_no);
      setLocationStatus("loading");
      setIsOffline(false);
    }
  }, [user, isAdmin, selectedBusNo, selectedPreviewNumber]);

  useEffect(() => {
    if (isAdmin) setIsSuperadminSearched(false);
  }, [isAdmin]);

  useEffect(() => {
    if (!socket || !selectedBusNo) return;
    socket.emit("join-bus", selectedBusNo);
    return () => {
      socket.emit("leave-bus", selectedBusNo);
    };
  }, [socket, selectedBusNo]);

  // Load plans + stops for the selected bus (for the bottom sheet plan chip + modal)
  useEffect(() => {
    if (!selectedBusNo || !token) return;
    let cancelled = false;
    setLoadingRoutes(true);
    busApi
      .getBusRoutes(token, selectedBusNo)
      .then((data) => {
        if (cancelled) return;
        setRoutesData(data);
        setIsBusFound(true);
        setActivePlanTab(data.currentPlan || data.planNames?.[0] || "PLAN A");
        // Ensure busData reflects the latest currentPlan
        setBusData((prev) => {
          if (!prev)
            return { busNo: selectedBusNo, currentPlan: data.currentPlan };
          if (prev.currentPlan && prev.currentPlan !== data.currentPlan)
            return prev;
          return { ...prev, currentPlan: data.currentPlan };
        });
      })
      .catch((e) => console.log("Failed to load routes:", e.message))
      .finally(() => {
        if (!cancelled) setLoadingRoutes(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBusNo, token]);

  useEffect(() => {
    if (!socket) return;
    const handleBusUpdate = (data) => {
      if (!data) return;
      const selected = selectedBusNoRef.current;
      if (!selected) return;
      const incomingBusNo = data.busNo ?? data.bus_no ?? data.busNumber;
      if (!incomingBusNo || String(incomingBusNo) !== String(selected)) return;
      const newPlan = data.currentPlan;
      if (!newPlan || lastPlanRef.current === newPlan) return;
      lastPlanRef.current = newPlan;
      setBusData((prev) => {
        if (!prev)
          return {
            busNo: selected,
            currentPlan: newPlan,
            _updatedAt: Date.now(),
          };
        return { ...prev, currentPlan: newPlan, _updatedAt: Date.now() };
      });
      // Keep plan modal state in sync with live plan changes
      setRoutesData((prevRoutes) =>
        prevRoutes ? { ...prevRoutes, currentPlan: newPlan } : prevRoutes,
      );
      setActivePlanTab(newPlan);
    };
    socket.on("bus-update", handleBusUpdate);
    return () => socket.off("bus-update", handleBusUpdate);
  }, [socket]);

  useEffect(() => {
    refreshBuses();
    const loadPersistedBusData = async () => {
      try {
        const savedBusNo = await AsyncStorage.getItem("selectedBusNo");
        const savedPreviewNumber = await AsyncStorage.getItem(
          "selectedPreviewNumber",
        );
        const savedBusData = await AsyncStorage.getItem("savedBusData");
        if (savedBusNo) setSelectedBusNo(savedBusNo);
        if (savedPreviewNumber) setSelectedPreviewNumber(savedPreviewNumber);
        if (savedBusData) {
          const parsedData = JSON.parse(savedBusData);
          setBusData(parsedData);
          setLastGoodLocation(parsedData);
        }
      } catch (err) {
        console.log("Error loading persisted bus data:", err);
      }
    };
    loadPersistedBusData();
  }, []);

  const normalizeBusState = (state) => {
    const normalized = typeof state === "string" ? state.toLowerCase() : "";
    return ["moving", "stopped"].includes(normalized) ? normalized : null;
  };

  const chooseBusStatus = (apiState, coordinateState) => {
    const normalizedApi = normalizeBusState(apiState);
    if (normalizedApi === "stopped") return normalizedApi;
    return coordinateState;
  };

  const detectBusStatus = (lat, lng) => {
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !isFinite(lat) ||
      !isFinite(lng)
    ) {
      return busStatusRef.current || "moving";
    }
    const currentCoord = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const lastCoord = lastCoordinateRef.current;
    if (lastCoord === currentCoord) {
      sameCoordinateCountRef.current += 1;
    } else {
      lastCoordinateRef.current = currentCoord;
      sameCoordinateCountRef.current = 1;
    }
    const count = sameCoordinateCountRef.current;
    let nextStatus;
    if (count >= 10) nextStatus = "stopped";
    else if (count >= 3) nextStatus = "waiting";
    else nextStatus = "moving";
    busStatusRef.current = nextStatus;
    return nextStatus;
  };

  /**
   * Determines if GPS data is stale based on lastSuccessfulGpsUpdate timestamp.
   * Backend GPS worker retains old coordinates even when GPS provider fails.
   * The real indicator of freshness is lastSuccessfulGpsUpdate: if null or >3min old → offline.
   */
  const isGpsStale = (data) => {
    if (!data) return true;
    // If backend reports status as offline, trust it
    if (data.status === "offline") return true;
    // Check lastSuccessfulGpsUpdate timestamp
    const lastGps = data.lastSuccessfulGpsUpdate;
    if (!lastGps) return true; // never had a successful GPS fix → offline
    const ageMs = Date.now() - new Date(lastGps).getTime();
    return ageMs > 3 * 60 * 1000; // older than 3 min → stale/offline
  };

  const handleRefresh = useCallback(async () => {
    if (!selectedBusNo && !selectedPreviewNumber) return;
    setLocationStatus("loading");
    try {
      let data;
      if (selectedPreviewNumber) {
        data = await busApi.trackByPreview(token, selectedPreviewNumber);
      } else {
        data = await busApi.getBusLocation(token, selectedBusNo);
      }

      const hasValidCoords =
        data &&
        data.latitude != null &&
        data.longitude != null &&
        Number.isFinite(Number(data.latitude)) &&
        Number.isFinite(Number(data.longitude)) &&
        data.latitude !== "NaN" &&
        data.longitude !== "NaN";

      // Bus is "found" if backend returned a bus identifier (even when offline/no GPS)
      const foundInBackend = !!(
        data &&
        (data.busNo || data.bus_no || data.busNumber)
      );

      // 1. Check GPS timestamp staleness FIRST (most reliable)
      const staleGps = isGpsStale(data);

      if (staleGps) {
        // GPS is stale → mark offline immediately
        setIsOffline(true);
        setLocationStatus("offline");
        if (hasValidCoords) {
          // Show the coordinates but marked offline
          setBusData({ ...data, source: data.source || "gps" });
          setLastGoodLocation({ ...data, source: data.source || "gps" });
          setNoBusFound(false);
          setIsBusFound(true);
        } else if (lastGoodLocation) {
          setBusData(lastGoodLocation);
          setNoBusFound(false);
          setIsBusFound(true);
        } else {
          setBusData(null);
          setNoBusFound(!foundInBackend);
          setIsBusFound(foundInBackend);
        }
      } else if (hasValidCoords) {
        // Fresh GPS with valid coords → live
        const nextBusData = { ...data, source: data.source || "gps" };
        setBusData(nextBusData);
        setLastGoodLocation(nextBusData);
        setLocationStatus("live");
        setIsOffline(false);
        setNoBusFound(false);
        setIsBusFound(true);
        const statusFromAPI = data.busState;
        const statusFromCoordinates = detectBusStatus(
          data.latitude,
          data.longitude,
        );
        setMarkerStatus(chooseBusStatus(statusFromAPI, statusFromCoordinates));
      } else {
        // No valid coords — bus may still exist (offline) → keep plan visible
        setBusData(null);
        setLastGoodLocation(null);
        setLocationStatus("offline");
        setIsOffline(true);
        setNoBusFound(!foundInBackend);
        setIsBusFound(foundInBackend);
      }
    } catch (err) {
      console.log("Refresh error:", err.message);
      if (lastGoodLocation) {
        setBusData(lastGoodLocation);
        setLocationStatus("offline");
        setIsOffline(true);
        setIsBusFound(true);
      } else {
        setLocationStatus("error");
        setNoBusFound(true);
      }
    }
    await refreshBuses();
  }, [
    selectedBusNo,
    selectedPreviewNumber,
    token,
    lastGoodLocation,
    refreshBuses,
  ]);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    // A purely numeric query is treated as a preview-number search (e.g. "4").
    // Alphanumeric queries (e.g. "TN30AH5907") are treated as bus_no.
    const isPreviewSearch = /^\d+$/.test(query);
    setSearchQuery("");

    // ⚠️ FIX: Reset ALL state atomically before each new search.
    // Prevent stale data from previous search appearing while loading.
    const currentSearch = ++searchCounterRef.current;
    setNoBusFound(false);
    setLocationStatus("loading");
    setIsBusSearchAttempted(true);
    setIsOffline(false);
    setBusData(null);
    setLastGoodLocation(null);
    setIsBusFound(false);
    setRoutesData(null);
    sameCoordinateCountRef.current = 0;
    lastCoordinateRef.current = null;
    if (isAdmin) setIsSuperadminSearched(true);

    if (isPreviewSearch) {
      setSelectedPreviewNumber(query);
      setSelectedBusNo(null);
      try {
        const data = await busApi.trackByPreview(token, query);

        // ⚠️ FIX: Ignore stale response from previous search
        if (currentSearch !== searchCounterRef.current) return;

        if (!data || data.error || !(data.busNo || data.bus_no)) {
          throw new Error(
            data?.error || "No bus found for this preview number",
          );
        }
        const nextBusNo = data.busNo || data.bus_no || null;
        setSelectedBusNo(nextBusNo);
        setIsBusFound(true);

        // Bus found — always show plan. GPS may be offline/missing.
        const hasPreviewCoords =
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude));

        // Check GPS staleness
        if (isGpsStale(data) || !hasPreviewCoords) {
          setBusData({ ...data, previewNumber: query, busNo: nextBusNo });
          setLastGoodLocation({
            ...data,
            previewNumber: query,
            busNo: nextBusNo,
          });
          setLocationStatus("offline");
          setIsOffline(true);
        } else {
          const nextBusData = {
            ...data,
            previewNumber: query,
            busNo: nextBusNo,
          };
          setBusData(nextBusData);
          setLastGoodLocation(nextBusData);
          setLocationStatus("live");
          setIsOffline(false);
          const statusFromAPI = data.busState;
          const statusFromCoordinates = detectBusStatus(
            data.latitude,
            data.longitude,
          );
          setMarkerStatus(
            chooseBusStatus(statusFromAPI, statusFromCoordinates) || "moving",
          );
        }
      } catch (err) {
        console.log("Preview search error:", err.message);
        // ⚠️ FIX: Ignore stale response from previous search
        if (currentSearch !== searchCounterRef.current) return;
        setSelectedBusNo(null);
        setSelectedPreviewNumber(null);
        setBusData(null);
        setLastGoodLocation(null);
        setIsBusFound(false);
        setRoutesData(null);
        setLocationStatus("error");
        setNoBusFound(true);
      }
    } else {
      const busNo = query.toUpperCase();
      setSelectedPreviewNumber(null);
      setSelectedBusNo(busNo);
      setIsBusFound(true); // Optimistic — will be confirmed by API

      try {
        const data = await busApi.getBusLocation(token, busNo);

        // ⚠️ FIX: Ignore stale response from previous search
        if (currentSearch !== searchCounterRef.current) return;

        // ⚠️ FIX: busApi.getBusLocation now validates busNo match internally
        // and throws if mismatch. If we reach here, the response is valid.

        if (
          data &&
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude)) &&
          data.latitude !== "NaN" &&
          data.longitude !== "NaN"
        ) {
          // Check GPS staleness
          if (isGpsStale(data)) {
            setBusData({ ...data, source: data.source || "gps" });
            setLastGoodLocation({ ...data, source: data.source || "gps" });
            setLocationStatus("offline");
            setIsOffline(true);
          } else {
            const nextBusData = { ...data, source: data.source || "gps" };
            setBusData(nextBusData);
            setLastGoodLocation(nextBusData);
            setLocationStatus("live");
            setIsOffline(false);
            const statusFromAPI = data.busState;
            const statusFromCoordinates = detectBusStatus(
              data.latitude,
              data.longitude,
            );
            setMarkerStatus(
              chooseBusStatus(statusFromAPI, statusFromCoordinates) || "moving",
            );
          }
        } else {
          // Bus found but no valid live coords → show offline + plan.
          // (getBusLocation throws only when bus doesn't exist, so reaching
          // here means the bus exists but GPS is offline/missing.)
          console.log("No valid location for bus search:", data);
          setBusData(null);
          setLastGoodLocation(null);
          setLocationStatus("offline");
          setIsOffline(true);
          setIsBusFound(true);
          setNoBusFound(false);
        }
      } catch (err) {
        console.log("Bus search error:", err.message);
        // ⚠️ FIX: Ignore stale response from previous search
        if (currentSearch !== searchCounterRef.current) return;
        setBusData(null);
        setLastGoodLocation(null);
        setIsBusFound(false);
        setRoutesData(null);
        setLocationStatus("error");
        setNoBusFound(true);
      }
    }
  };

  const shouldShowBusMarker = (() => {
    if (!isAdmin) return !!selectedBusNo || !!selectedPreviewNumber;
    return isSuperadminSearched && (!!selectedBusNo || !!selectedPreviewNumber);
  })();

  const displayBusData = shouldShowBusMarker ? busData : null;
  const displayBusLabel =
    selectedPreviewNumber || selectedBusNo || displayBusData?.busNo;

  const busCardContent = React.useMemo(() => {
    if (!displayBusData) return null;
    const distance = calculateDistance(
      displayBusData.latitude,
      displayBusData.longitude,
      KIOT_LAT,
      KIOT_LNG,
    );
    return (
      <View style={styles.busCard}>
        {isOffline && (
          <Text style={styles.offlineNote}>
            ⚠ Last known location — GPS is offline
          </Text>
        )}
        <View style={styles.cardHeader}>
          <Text style={styles.busNumber}>Bus {displayBusLabel}</Text>
          <View
            style={[
              styles.statusBadge,
              isOffline && styles.offlineBadge,
              !isOffline && markerStatus === "moving" && styles.movingBadge,
              !isOffline && markerStatus === "stopped" && styles.stoppedBadge,
            ]}
          >
            <Text style={styles.badgeText}>
              {isOffline ? "OFFLINE" : markerStatus.toUpperCase()}
            </Text>
          </View>
        </View>
        <View style={styles.etaContainer}>
          <Text style={styles.etaLabel}>Distance to College</Text>
          <View style={styles.etaRow}>
            <View style={styles.etaItem}>
              <Text style={styles.etaValue}>{distance.toFixed(1)} KM</Text>
              <Text style={styles.etaSubtext}>KIOT Campus</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }, [displayBusData, displayBusLabel, markerStatus, isOffline]);

  // Standalone Plan card — always visible once a bus is found, even if offline / no GPS coords.
  const planCardContent = React.useMemo(() => {
    if (!isBusFound && !routesData) return null;
    const currentPlan =
      displayBusData?.currentPlan || routesData?.currentPlan || "PLAN A";
    const hasPlanStops = !!routesData?.planNames?.length;
    const isOfflineMode = isOffline || !displayBusData;
    return (
      <View style={styles.planCard}>
        {isOfflineMode && (
          <View style={styles.lastPlanNote}>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={COLORS.textBody}
            />
            <Text style={styles.lastPlanNoteText}>
              {routesData && !hasPlanStops
                ? "No stops uploaded for this bus yet."
                : `The bus's last plan is ${currentPlan}`}
            </Text>
          </View>
        )}
        <TouchableOpacity
          style={styles.planChip}
          onPress={() => setShowStopsModal(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="map-outline" size={16} color={COLORS.primary} />
          <Text style={styles.planChipLabel}>Current Plan</Text>
          <Text style={styles.planChipValue}>{currentPlan}</Text>
          <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
        </TouchableOpacity>
        {!hasPlanStops && isAdmin && (
          <Text style={styles.planEmptyHint}>
            Go to Organize → Buses → Edit Routes to upload a routes Excel.
          </Text>
        )}
      </View>
    );
  }, [isBusFound, routesData, displayBusData, isOffline, isAdmin]);

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      {/* MAP */}
      <View style={styles.mapBackground}>
        <OSMMap
          busData={
            displayBusData ? { ...displayBusData, _isOffline: isOffline } : null
          }
          buses={[]}
        />
      </View>

      <View style={styles.topBar}>
        <View style={styles.searchContainer}>
          {/* LEFT ICON */}
          <Ionicons name="search" size={18} color={COLORS.textBody} />

          {/* INPUT */}
          <TextInput
            placeholder={"Search Bus"}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            style={styles.searchInput}
            placeholderTextColor={COLORS.textBody}
          />

          {/* CLEAR BUTTON */}
          {searchQuery ? (
            <TouchableOpacity
              onPress={() => setSearchQuery("")}
              style={styles.clearButton}
            >
              <Ionicons name="close-circle" size={18} color={COLORS.textBody} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* RIGHT ICONS */}
        <View style={styles.rightIcons}>
          {isAdmin && (
            <TouchableOpacity
              style={styles.organizeButton}
              onPress={() => navigation.navigate("Organize")}
              activeOpacity={0.7}
            >
              <Text style={styles.organizeText}>Organize</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.iconButtonPrimary}
            onPress={() => navigation.navigate("Profile")}
            activeOpacity={0.7}
          >
            <Ionicons name="person-outline" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* BOTTOM SHEET (gorhom) */}
      <BottomSheet
        index={isAdmin ? 0 : 0}
        snapPoints={SNAP_POINTS}
        enablePanDownToClose={false}
        animateOnMount={false}
        topInset={350}
        handleIndicatorStyle={styles.handleIndicator}
        backgroundStyle={styles.sheetBackground}
        containerStyle={styles.sheetContainer}
      >
        <BottomSheetView style={styles.sheetContent}>
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.sheetLabel}>Live Bus Tracking</Text>
              <Text style={styles.sheetSubLabel}>
                {isAdmin
                  ? "search for bus to view time location"
                  : user?.bus_no
                    ? `tracking your bus ${user.bus_no}`
                    : "no bus assigned"}
              </Text>
            </View>
          </View>

          <View style={styles.content}>
            {error ? (
              <Text style={[styles.infoText, styles.errorText]}>{error}</Text>
            ) : noBusFound ? (
              <View>
                <Text style={[styles.infoText, styles.errorText]}>
                  Bus Not Found
                </Text>
                <Text style={[styles.infoText, styles.subInfoText]}>
                  Showing KIOT campus location.
                </Text>
              </View>
            ) : isBusSearchAttempted &&
              !displayBusData &&
              !isBusFound &&
              !routesData ? (
              <View>
                <Text style={[styles.infoText, styles.errorText]}>
                  Bus Not Found
                </Text>
                <Text style={[styles.infoText, styles.subInfoText]}>
                  Showing KIOT campus location.
                </Text>
              </View>
            ) : !selectedBusNo && !selectedPreviewNumber ? (
              <Text style={styles.infoText}>
                {isAdmin
                  ? "Search any bus to track its live location."
                  : user?.bus_no
                    ? `Tracking your bus ${user.bus_no}...`
                    : "No bus assigned"}
              </Text>
            ) : locationStatus === "loading" && !routesData ? (
              <Text style={styles.infoText}>Loading live location...</Text>
            ) : displayBusData ? (
              <>
                {busCardContent}
                {planCardContent}
              </>
            ) : (
              <>
                {planCardContent}
                {!displayBusData && isBusFound && (
                  <Text
                    style={[
                      styles.infoText,
                      styles.offlineNote,
                      { marginTop: 12 },
                    ]}
                  >
                    Bus is offline or no live GPS available right now.
                  </Text>
                )}
              </>
            )}
          </View>
        </BottomSheetView>
      </BottomSheet>

      {/* ============ PLANS / STOPS MODAL ============ */}
      <Modal
        visible={showStopsModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowStopsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Bus {displayBusLabel}</Text>
                <Text style={styles.modalSubtitle}>Plans & Stops</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowStopsModal(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={24} color={COLORS.textBody} />
              </TouchableOpacity>
            </View>

            {loadingRoutes ? (
              <ActivityIndicator
                color={COLORS.primary}
                style={{ marginVertical: 30 }}
              />
            ) : !routesData || !routesData.planNames?.length ? (
              <View style={styles.noPlansBox}>
                <Text style={styles.noPlansText}>
                  No plans uploaded for this bus yet.
                </Text>
                {isAdmin && (
                  <Text style={styles.noPlansHint}>
                    Go to Organize → Buses → Edit Routes to upload a routes
                    Excel.
                  </Text>
                )}
              </View>
            ) : (
              <>
                {/* Plan selector tabs */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.planTabs}
                  contentContainerStyle={styles.planTabsContent}
                >
                  {routesData.planNames.map((plan) => {
                    const isActive = plan === activePlanTab;
                    const isCurrent =
                      plan ===
                      (routesData.currentPlan || displayBusData?.currentPlan);
                    return (
                      <TouchableOpacity
                        key={plan}
                        style={[
                          styles.planTab,
                          isActive && styles.planTabActive,
                        ]}
                        onPress={() => setActivePlanTab(plan)}
                      >
                        <Text
                          style={[
                            styles.planTabText,
                            isActive && styles.planTabTextActive,
                          ]}
                        >
                          {plan}
                        </Text>
                        {isCurrent && <View style={styles.currentDot} />}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                {/* Admin: change current plan */}
                {isAdmin && routesData.planNames.length > 1 && (
                  <TouchableOpacity
                    style={styles.changePlanBtn}
                    onPress={async () => {
                      if (
                        activePlanTab ===
                        (routesData.currentPlan || displayBusData?.currentPlan)
                      )
                        return;
                      try {
                        await busApi.updatePlan(
                          token,
                          selectedBusNo,
                          activePlanTab,
                        );
                        setRoutesData((prev) => ({
                          ...prev,
                          currentPlan: activePlanTab,
                        }));
                        setBusData((prev) => ({
                          ...prev,
                          currentPlan: activePlanTab,
                        }));
                      } catch (e) {
                        Alert.alert("Failed", e.message);
                      }
                    }}
                  >
                    <Ionicons name="swap-horizontal" size={16} color="#fff" />
                    <Text style={styles.changePlanBtnText}>
                      Set "{activePlanTab}" as Current Plan
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Stops for active plan */}
                <ScrollView style={styles.stopsList}>
                  {(routesData.plans[activePlanTab] || []).map((stop, idx) => (
                    <View
                      key={`${activePlanTab}-${idx}`}
                      style={styles.stopRow}
                    >
                      <View style={styles.stopIndex}>
                        <Text style={styles.stopIndexText}>{idx + 1}</Text>
                      </View>
                      <Text style={styles.stopName}>{stop.stop_name}</Text>
                    </View>
                  ))}
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default HomeScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  mapBackground: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },

  topBar: {
    position: "absolute",
    top: Platform.OS === "ios" ? 60 : 50,
    left: 15,
    right: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    zIndex: 10,
  },
  rightIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6, // reduce gap
  },
  organizeButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.primary,
    paddingHorizontal: 10,
    height: 32,
    borderRadius: 16,
    gap: 4,
  },

  organizeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  iconButtonPrimary: {
    width: 32,
    height: 32,
    borderRadius: 16, // perfect circle
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
  },
  searchContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.93)",
    borderRadius: 50,
    paddingHorizontal: 12,
    height: 45,
    ...SHADOWS.soft,
  },

  searchInput: {
    flex: 1,
    marginLeft: 8,
    marginRight: 8, // IMPORTANT
    fontSize: 14,
    color: COLORS.textHeader,
  },

  errorText: {
    color: "#e74c3c",
  },

  // gorhom bottom-sheet styles
  sheetContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
  sheetBackground: {
    backgroundColor: COLORS.white,
  },
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  handleIndicator: {
    backgroundColor: "#00000022",
    width: 44,
    height: 5,
    borderRadius: 10,
  },

  content: {
    marginTop: 5,
  },

  infoText: {
    textAlign: "center",
    color: COLORS.textBody,
    fontSize: 14,
  },
  subInfoText: {
    textAlign: "center",
    color: COLORS.textBody,
    fontSize: 12,
    marginTop: 4,
    opacity: 0.8,
  },
  offlineNote: {
    textAlign: "center",
    color: "#dc2626",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
  },
  clearButton: {
    padding: 4,
  },

  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },

  sheetLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.textHeader,
  },

  sheetSubLabel: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 4,
  },

  busCard: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 16,
    ...SHADOWS.soft,
    marginTop: 10,
  },

  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },

  busNumber: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.textHeader,
  },

  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#f0f0f0",
  },

  movingBadge: {
    backgroundColor: "#2ecc71",
  },

  stoppedBadge: {
    backgroundColor: "#e74c3c",
  },

  offlineBadge: {
    backgroundColor: "#dc2626",
  },

  badgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.white,
    textTransform: "uppercase",
  },

  etaContainer: {
    alignItems: "center",
  },

  etaLabel: {
    fontSize: 14,
    color: COLORS.textBody,
    marginBottom: 12,
    textAlign: "center",
  },

  etaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },

  etaItem: {
    alignItems: "center",
    flex: 1,
  },

  etaValue: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.textHeader,
    marginBottom: 4,
  },

  etaSubtext: {
    fontSize: 12,
    color: COLORS.textBody,
  },

  // plan chip
  planCard: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    ...SHADOWS.soft,
  },
  lastPlanNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  lastPlanNoteText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textBody,
    fontWeight: "500",
  },
  planEmptyHint: {
    fontSize: 11,
    color: COLORS.textBody,
    marginTop: 8,
    textAlign: "center",
    opacity: 0.8,
  },
  planChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF2FF",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  planChipLabel: {
    fontSize: 13,
    color: COLORS.textBody,
    fontWeight: "500",
  },
  planChipValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.primary,
    textTransform: "uppercase",
  },

  // stops modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 30,
    maxHeight: "75%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.textHeader,
  },
  modalSubtitle: {
    fontSize: 13,
    color: COLORS.textBody,
    marginTop: 2,
  },
  modalCloseBtn: {
    padding: 6,
  },
  planTabs: {
    flexGrow: 0,
    marginBottom: 12,
  },
  planTabsContent: {
    gap: 8,
    paddingVertical: 4,
  },
  planTab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: "transparent",
    gap: 6,
  },
  planTabActive: {
    backgroundColor: "#EEF2FF",
    borderColor: COLORS.primary,
  },
  planTabText: {
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.textBody,
    textTransform: "uppercase",
  },
  planTabTextActive: {
    color: COLORS.primary,
  },
  currentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.success,
  },
  changePlanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 12,
  },
  changePlanBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  stopsList: {
    flexGrow: 0,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  stopIndex: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#EEF2FF",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  stopIndexText: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.primary,
  },
  stopName: {
    fontSize: 15,
    fontWeight: "500",
    color: COLORS.textHeader,
    flex: 1,
  },
  noPlansBox: {
    alignItems: "center",
    paddingVertical: 30,
    paddingHorizontal: 20,
  },
  noPlansText: {
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.textBody,
    textAlign: "center",
  },
  noPlansHint: {
    fontSize: 13,
    color: COLORS.textBody,
    textAlign: "center",
    marginTop: 8,
    opacity: 0.8,
  },
});
