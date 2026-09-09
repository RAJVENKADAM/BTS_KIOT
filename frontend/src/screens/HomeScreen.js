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
 * - Listens for "bus-update" events to refresh live bus status in real time.
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
import { isNetworkError, getErrorMessage } from "../utils/errorHandler";
import { getDisplayBusNumber } from "../utils/busDisplay";

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
  const [trackingError, setTrackingError] = useState(null);
  const [isBusSearchAttempted, setIsBusSearchAttempted] = useState(false);
  const [selectedPreviewNumber, setSelectedPreviewNumber] = useState(null);
  const [selectedBusNo, setSelectedBusNo] = useState(null);
  const [lastGoodLocation, setLastGoodLocation] = useState(null);
  const [isSuperadminSearched, setIsSuperadminSearched] = useState(false);
  const [locationStatus, setLocationStatus] = useState("idle");
  const [markerStatus, setMarkerStatus] = useState("moving");
  const [isOffline, setIsOffline] = useState(false);

  // Plan / routes modal / sheet state
  const [routesData, setRoutesData] = useState(null);
  const [showStopsModal, setShowStopsModal] = useState(false);
  const [showPlanListModal, setShowPlanListModal] = useState(false);
  const [planBuses, setPlanBuses] = useState([]);
  const [activePlanTab, setActivePlanTab] = useState("PLAN A");
  const [globalPlan, setGlobalPlan] = useState("PLAN A");
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [loadingPlanBuses, setLoadingPlanBuses] = useState(false);
  // Bottom-sheet control: show plans/stops inside the sheet instead of separate modal
  const bottomSheetRef = useRef(null);
  const [showPlanInSheet, setShowPlanInSheet] = useState(false);
  const [planViewMode, setPlanViewMode] = useState(null); // 'activePlan' | 'stopsForBus' | null

  const closeAllOverlayPanels = useCallback(() => {
    setShowPlanListModal(false);
    setShowStopsModal(false);
    setShowPlanInSheet(false);
    setPlanViewMode(null);
  }, []);
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

  /**
   * Scope persisted bus keys by user id so one user's saved bus data never
   * leaks into another user's session. Returns null for keys that should not
   * be persisted (non-admins ALWAYS derive their bus from their profile).
   */
  const busStorageKey = useCallback(
    (key) => {
      if (!isAdmin) return null; // students/primary admins derive from user.bus_no
      const uid = user?.id || user?._id || "anon";
      return `bus_${uid}_${key}`;
    },
    [isAdmin, user?.id, user?._id],
  );

  const normalizePlanName = useCallback((plan) => {
    const value = String(plan ?? "PLAN A").trim();
    return value ? value.toUpperCase() : "PLAN A";
  }, []);

  useEffect(() => {
    const persistBusData = async () => {
      if (locationStatus === "loading") return;
      try {
        // Persistence is admin-only and user-scoped. Non-admins always derive
        // their bus from the profile — never persist (avoids cross-user leaks).
        if (selectedBusNo) {
          const key = busStorageKey("selectedBusNo");
          if (key) await AsyncStorage.setItem(key, selectedBusNo);
        }
        if (selectedPreviewNumber) {
          const key = busStorageKey("selectedPreviewNumber");
          if (key) await AsyncStorage.setItem(key, selectedPreviewNumber);
        }
        if (busData && locationStatus !== "error") {
          const key = busStorageKey("savedBusData");
          if (key) await AsyncStorage.setItem(key, JSON.stringify(busData));
        }
      } catch (err) {
        console.log("Error persisting bus data:", err);
      }
    };
    persistBusData();
  }, [
    selectedBusNo,
    selectedPreviewNumber,
    busData,
    locationStatus,
    busStorageKey,
  ]);

  /**
   * Reset bus state whenever the logged-in user changes (login/logout/switch).
   * This is the key fix for "everyone sees the same bus": stale state from a
   * previous user is completely cleared before applying the current user's bus.
   */
  useEffect(() => {
    // Clear all bus state so nothing from the previous user lingers.
    setBusData(null);
    setLastGoodLocation(null);
    setRoutesData(null);
    setIsBusFound(false);
    setNoBusFound(false);
    setTrackingError(null);
    setIsOffline(false);
    setIsBusSearchAttempted(false);
    setSelectedPreviewNumber(null);
    setMarkerStatus("moving");
    sameCoordinateCountRef.current = 0;
    lastCoordinateRef.current = null;
    busStatusRef.current = "moving";
    selectedBusNoRef.current = null;

    if (isAdmin) {
      // Admin derives their bus only from explicit search / scoped persisted data.
      setSelectedBusNo(null);
      setLocationStatus("idle");
      return;
    }

    // Non-admin: derive ONLY from their own profile.
    if (user?.bus_no) {
      setSelectedBusNo(user.bus_no);
      setLocationStatus("loading");
    } else {
      setSelectedBusNo(null);
      setLocationStatus("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?._id, isAdmin]);

  /**
   * Auto-fetch the non-admin's assigned bus location once per bus/user.
   * Handles all cases: found+live, found+offline, bus not found, no bus assigned.
   */
  const autoLoadedBusKeyRef = useRef(null);
  useEffect(() => {
    if (isAdmin) return;
    const assignedBusNo = (user?.bus_no || "").trim().toUpperCase() || null;
    // Keep the ref in sync so the guard matches the current assigned bus.
    if (assignedBusNo) {
      selectedBusNoRef.current = assignedBusNo;
      setSelectedBusNo(assignedBusNo);
    } else {
      selectedBusNoRef.current = null;
      setSelectedBusNo(null);
      setLocationStatus("idle");
      setNoBusFound(false);
      return;
    }

    const loadKey = `${user?.id || user?._id || "anon"}::${assignedBusNo}`;
    if (autoLoadedBusKeyRef.current === loadKey) return; // already auto-loaded
    autoLoadedBusKeyRef.current = loadKey;

    let cancelled = false;
    setLocationStatus("loading");
    setIsOffline(false);
    setNoBusFound(false);
    setIsBusFound(false);
    setBusData(null);
    setLastGoodLocation(null);

    (async () => {
      try {
        const data = await busApi.getBusLocation(token, assignedBusNo);
        if (cancelled) return;

        const hasValidCoords =
          data &&
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude)) &&
          data.latitude !== "NaN" &&
          data.longitude !== "NaN";

        setIsBusFound(true);
        setRoutesData((prev) => prev); // leave to the routes effect

        if (data?.notActiveMessage) {
          setTrackingError(data?.notActiveMessage);
          setLocationStatus("offline");
          setIsOffline(true);
          setBusData({
            ...data,
            busNo: data.busNo || data.bus_no || assignedBusNo,
          });
          setLastGoodLocation({
            ...data,
            busNo: data.busNo || data.bus_no || assignedBusNo,
          });
          setNoBusFound(false);
          return;
        }

        if (isGpsStale(data) || !hasValidCoords) {
          // Found but offline / no live coords — show plan + (if available)
          // last known location. Only set busData when we have coords to avoid
          // a bogus "0.0 KM" bus card / marker for a coords-less bus.
          const offlineData = {
            ...data,
            busNo: data.previewNumber || data || assignedBusNo,
          };
          if (hasValidCoords) {
            setBusData(offlineData);
            setLastGoodLocation(offlineData);
          } else {
            setBusData(null);
            setLastGoodLocation(null);
          }
          setLocationStatus("offline");
          setIsOffline(true);
          setNoBusFound(false);
        } else {
          const nextBusData = {
            ...data,
            source: data.source || "gps",
            busNo: data.previewNumber || data.bus_no || assignedBusNo,
          };
          setBusData(nextBusData);
          setLastGoodLocation(nextBusData);
          setLocationStatus("live");
          setIsOffline(false);
          setNoBusFound(false);
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
        if (cancelled) return;
        console.log(
          `Auto-load assigned bus ${assignedBusNo} error:`,
          err.message,
        );
        setSelectedBusNo(assignedBusNo);
        setBusData(null);
        setLastGoodLocation(null);
        setRoutesData(null);
        setLocationStatus("error");
        // Distinguish a network problem from a genuine "bus not found".
        if (isNetworkError(err)) {
          setNoBusFound(false);
          setTrackingError(
            "Cannot connect to the server. Please check your internet connection.",
          );
        } else {
          setNoBusFound(true);
          setTrackingError(null);
        }
        setIsBusFound(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?._id, user?.bus_no, token, isAdmin, globalPlan]);

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
        const preferredPlan =
          data?.activePlan && (data.planNames || []).includes(data.activePlan)
            ? data.activePlan
            : data?.planNames?.[0] || globalPlan || "PLAN A";
        setActivePlanTab(preferredPlan);
      })
      .catch((e) => console.log("Failed to load routes:", e.message))
      .finally(() => {
        if (!cancelled) setLoadingRoutes(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBusNo, token, globalPlan]);

  // Listen for live location updates from the DB (pushed by the GPS sync
  // worker or in response to a `request-bus-location` refresh). This updates
  // the marker WITHOUT making an HTTP API call — avoiding the rate-limited GPS
  // provider. We only update the map (busData) here; we do NOT re-zoom.
  useEffect(() => {
    if (!socket) return;
    const handleLocationUpdate = (data) => {
      if (!data || data.error) return;
      const selected = selectedBusNoRef.current;
      if (!selected) return;
      const incomingBusNo =
        data.busNo ?? data.bus_no ?? data.busNumber ?? data.previewNumber;
      if (!incomingBusNo) return;
      const incomingStr = String(incomingBusNo);
      const selectedStr = String(selected);
      // Only accept updates for the currently selected/searching bus.
      // Allow matching by previewNumber too (e.g. searched "4" → bus no "TN..").
      if (
        incomingStr !== selectedStr &&
        String(data.previewNumber ?? "") !== selectedStr
      ) {
        return;
      }

      const hasValidCoords =
        data.latitude != null &&
        data.longitude != null &&
        Number.isFinite(Number(data.latitude)) &&
        Number.isFinite(Number(data.longitude)) &&
        data.latitude !== "NaN" &&
        data.longitude !== "NaN";

      if (!hasValidCoords) return;

      const live = data.status === "online" || data.is_online === true;
      const nextBusData = {
        ...(busData || {}),
        busNo: data.busNo ?? data.bus_no ?? selected,
        bus_no: data.bus_no ?? selected,
        previewNumber: data.previewNumber ?? selectedPreviewNumber ?? undefined,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed ?? 0,
        source: data.source || "gps",
        _isOffline: !live,
      };

      setBusData(nextBusData);
      setLastGoodLocation(nextBusData);
      setLocationStatus(live ? "live" : "offline");
      setIsOffline(!live);
      setNoBusFound(false);
      setIsBusFound(true);
    };
    socket.on("locationUpdate", handleLocationUpdate);
    return () => socket.off("locationUpdate", handleLocationUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, busData, selectedBusNo, selectedPreviewNumber]);

  // Refresh the selected bus marker straight from the DB via socket.
  // This avoids re-fetching from the rate-limited GPS provider / HTTP API.
  const handleSocketRefresh = useCallback(() => {
    if (!socket) return;
    const busToRefresh = selectedPreviewNumber || selectedBusNo;
    if (!busToRefresh) return;
    setLocationStatus("loading");
    socket.emit("request-bus-location", busToRefresh);
  }, [socket, selectedPreviewNumber, selectedBusNo]);

  const loadGlobalActivePlan = useCallback(async () => {
    if (!token) return globalPlan || "PLAN A";
    try {
      const data = await busApi.getGlobalActivePlan(token);
      const nextPlan = data?.activePlan
        ? normalizePlanName(data.activePlan)
        : null;
      if (nextPlan) {
        setGlobalPlan(nextPlan);
        setActivePlanTab((prev) => {
          const currentPrev = String(prev || "").trim();
          return currentPrev && currentPrev !== "PLAN A" ? prev : nextPlan;
        });
      }
      return nextPlan || globalPlan || "PLAN A";
    } catch (e) {
      console.log("Failed to load active plan:", e.message);
      return globalPlan || "PLAN A";
    }
  }, [token, globalPlan, normalizePlanName]);

  const loadActivePlanBuses = useCallback(
    async (planOverride) => {
      if (!token) return [];
      const targetPlan = normalizePlanName(
        planOverride || globalPlan || "PLAN A",
      );
      setLoadingPlanBuses(true);
      try {
        const data = await busApi.getBusesForPlan(token, targetPlan);
        const buses = data?.buses || [];
        const sorted = [...buses].sort((a, b) =>
          String(a.busNo).localeCompare(String(b.busNo)),
        );
        setPlanBuses(sorted);
        return sorted;
      } catch (e) {
        setPlanBuses([]);
        console.log("Failed to load buses for active plan:", e.message);
        return [];
      } finally {
        setLoadingPlanBuses(false);
      }
    },
    [token, globalPlan, normalizePlanName],
  );

  const openActivePlanModal = useCallback(async () => {
    const latestPlan = await loadGlobalActivePlan();
    await loadActivePlanBuses(latestPlan);
    closeAllOverlayPanels();
    setShowPlanListModal(true);
  }, [closeAllOverlayPanels, loadGlobalActivePlan, loadActivePlanBuses]);

  // Open active plan view inside the bottom sheet (expanded)
  const openActivePlanInSheet = useCallback(async () => {
    const latestPlan = await loadGlobalActivePlan();
    await loadActivePlanBuses(latestPlan);
    closeAllOverlayPanels();
    setPlanViewMode("activePlan");
    setShowPlanInSheet(true);
    // expand to largest snap point
    if (bottomSheetRef.current && bottomSheetRef.current.snapToIndex) {
      try {
        bottomSheetRef.current.snapToIndex(2);
      } catch (e) {
        // ignore if method unavailable
      }
    }
  }, [closeAllOverlayPanels, loadGlobalActivePlan, loadActivePlanBuses]);

  useEffect(() => {
    loadGlobalActivePlan();
  }, [loadGlobalActivePlan]);

  useEffect(() => {
    if (showPlanListModal) {
      loadActivePlanBuses(globalPlan);
    }
  }, [showPlanListModal, globalPlan, loadActivePlanBuses]);

  useEffect(() => {
    refreshBuses();
    // Restore persisted bus data is now ADMIN-ONLY and USER-SCOPED.
    // Non-admins ALWAYS derive their bus from the profile (see the reset +
    // auto-load effects) so a different user's saved bus can never leak in.
    const loadPersistedBusData = async () => {
      if (!isAdmin) return;
      try {
        const savedBusNo = await AsyncStorage.getItem(
          busStorageKey("selectedBusNo"),
        );
        const savedPreviewNumber = await AsyncStorage.getItem(
          busStorageKey("selectedPreviewNumber"),
        );
        const savedBusData = await AsyncStorage.getItem(
          busStorageKey("savedBusData"),
        );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busStorageKey]);

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

      if (data?.notActiveMessage) {
        setTrackingError(data.notActiveMessage);
        setBusData({ ...data, source: data?.source || "gps" });
        setLastGoodLocation({ ...data, source: data?.source || "gps" });
        setLocationStatus("offline");
        setIsOffline(true);
        setNoBusFound(false);
        setIsBusFound(true);
        return;
      }

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
        // Distinguish a network problem from a genuine "bus not found".
        if (isNetworkError(err)) {
          setNoBusFound(false);
          setTrackingError(
            "Cannot connect to the server. Please check your internet connection.",
          );
        } else {
          setNoBusFound(true);
          setTrackingError(null);
        }
      }
    }
    await refreshBuses();
  }, [
    selectedBusNo,
    selectedPreviewNumber,
    token,
    lastGoodLocation,
    refreshBuses,
    globalPlan,
  ]);

  const handleOpenPlanBus = useCallback(
    async (busNo) => {
      if (!busNo) return;
      closeAllOverlayPanels();
      setSearchQuery(String(busNo));
      setSelectedPreviewNumber(null);
      setSelectedBusNo(String(busNo).toUpperCase());
      setIsBusSearchAttempted(true);
      setLocationStatus("loading");
      setTrackingError(null);
      try {
        const data = await busApi.getBusLocation(
          token,
          String(busNo).toUpperCase(),
        );
        if (data?.notActiveMessage) {
          setTrackingError(data.notActiveMessage);
          setBusData({
            ...data,
            busNo: data?.busNo || data?.bus_no || String(busNo).toUpperCase(),
          });
          setLastGoodLocation({
            ...data,
            busNo: data?.busNo || data?.bus_no || String(busNo).toUpperCase(),
          });
          setLocationStatus("offline");
          setIsOffline(true);
          setNoBusFound(false);
          setIsBusFound(true);
          setShowStopsModal(true);
          return;
        }

        if (
          data &&
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude)) &&
          data.latitude !== "NaN" &&
          data.longitude !== "NaN"
        ) {
          setBusData({ ...data, source: data.source || "gps" });
          setLastGoodLocation({ ...data, source: data.source || "gps" });
          setLocationStatus("live");
          setIsOffline(false);
          setNoBusFound(false);
          setIsBusFound(true);
        } else {
          setBusData(null);
          setLastGoodLocation(null);
          setLocationStatus("offline");
          setIsOffline(true);
          setIsBusFound(true);
          setNoBusFound(false);
        }
        setShowStopsModal(true);
      } catch (err) {
        console.log("Open plan bus error:", err.message);
        setTrackingError(getErrorMessage(err, "Could not load this bus"));
        setLocationStatus("error");
      }
    },
    [closeAllOverlayPanels, globalPlan, token],
  );

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    // A purely numeric query is treated as a preview-number search (e.g. "4").
    // Alphanumeric queries (e.g. "TN30AH5907") are treated as bus_no.
    const isPreviewSearch = /^\d+$/.test(query);
    // Keep the typed query in the search bar so the user can see/cross it out.
    // Do NOT clear it here — use the cross (close-circle) button to clear.

    // ⚠️ FIX: Reset ALL state atomically before each new search.
    // Prevent stale data from previous search appearing while loading.
    const currentSearch = ++searchCounterRef.current;
    setNoBusFound(false);
    setTrackingError(null);
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

        if (data?.notActiveMessage) {
          setTrackingError(data.notActiveMessage);
          setBusData({ ...data, previewNumber: query, busNo: nextBusNo });
          setLastGoodLocation({
            ...data,
            previewNumber: query,
            busNo: nextBusNo,
          });
          setLocationStatus("offline");
          setIsOffline(true);
          setNoBusFound(false);
          return;
        }

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
        // Distinguish a network problem from a genuine "bus not found".
        if (isNetworkError(err)) {
          setNoBusFound(false);
          setTrackingError(
            "Cannot connect to the server. Please check your internet connection.",
          );
        } else {
          setNoBusFound(true);
          setTrackingError(null);
        }
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

        if (data?.notActiveMessage) {
          setTrackingError(data.notActiveMessage);
          setBusData({ ...data, source: data?.source || "gps" });
          setLastGoodLocation({ ...data, source: data?.source || "gps" });
          setLocationStatus("offline");
          setIsOffline(true);
          setNoBusFound(false);
          return;
        }

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
        // Distinguish a network problem from a genuine "bus not found".
        if (isNetworkError(err)) {
          setNoBusFound(false);
          setTrackingError(
            "Cannot connect to the server. Please check your internet connection.",
          );
        } else {
          setNoBusFound(true);
          setTrackingError(null);
        }
      }
    }
  };

  /**
   * Cancel / clear the current bus search. Fully resets ALL bus state so the
   * map reverts to the KIOT college default (no stale marker). Increments the
   * search counter so any in-flight async search result is ignored.
   */
  const handleClearSearch = useCallback(() => {
    searchCounterRef.current += 1;
    setSearchQuery("");
    setNoBusFound(false);
    setTrackingError(null);
    setLocationStatus("idle");
    setIsBusSearchAttempted(false);
    setSelectedPreviewNumber(null);
    setSelectedBusNo(null);
    setLastGoodLocation(null);
    setBusData(null);
    setIsOffline(false);
    setIsBusFound(false);
    setRoutesData(null);
    setMarkerStatus("moving");
    sameCoordinateCountRef.current = 0;
    lastCoordinateRef.current = null;
    busStatusRef.current = "moving";
    selectedBusNoRef.current = null;
    if (isAdmin) setIsSuperadminSearched(false);
  }, [isAdmin]);

  const shouldShowBusMarker = (() => {
    if (!isAdmin) return !!selectedBusNo || !!selectedPreviewNumber;
    return isSuperadminSearched && (!!selectedBusNo || !!selectedPreviewNumber);
  })();

  const displayBusData = shouldShowBusMarker ? busData : null;
  const displayBusLabel = getDisplayBusNumber({
    previewNumber: selectedPreviewNumber ?? displayBusData?.previewNumber,
    preview_number: displayBusData?.preview_number,
    busNo: selectedBusNo ?? displayBusData?.busNo ?? displayBusData?.bus_no,
  });
  const assignedBusDisplay = getDisplayBusNumber({
    previewNumber: user?.previewNumber ?? user?.preview_number,
    busNo: user?.bus_no,
  });

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
              {isOffline ? (
                <>
                  <Text style={styles.etaValue}>OFFLINE</Text>
                  <Text style={styles.etaSubtext}>Location unavailable</Text>
                </>
              ) : (
                <>
                  <Text style={styles.etaValue}>{distance.toFixed(1)} KM</Text>
                  <Text style={styles.etaSubtext}>KIOT Campus</Text>
                </>
              )}
            </View>
          </View>
        </View>
      </View>
    );
  }, [displayBusData, displayBusLabel, markerStatus, isOffline]);

  // Standalone Plan card — visible for all users so the current global plan
  // and route list are always available, even before a bus is selected.
  const planCardContent = React.useMemo(() => {
    const hasPlanContext = !!(routesData || globalPlan || isBusFound);
    if (!hasPlanContext) return null;

    const currentPlan = globalPlan || "PLAN A";
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
              {trackingError
                ? trackingError
                : routesData && !hasPlanStops
                  ? "No stops uploaded for this bus yet."
                  : displayBusData
                    ? `Current global plan is ${currentPlan}`
                    : `Current global plan is ${currentPlan}`}
            </Text>
          </View>
        )}
        <TouchableOpacity
          style={styles.planChip}
          onPress={() => {
            if (!selectedBusNo && !selectedPreviewNumber) {
              openActivePlanInSheet();
              return;
            }
            setPlanViewMode("stopsForBus");
            setShowPlanInSheet(true);
            if (bottomSheetRef.current && bottomSheetRef.current.snapToIndex) {
              try {
                bottomSheetRef.current.snapToIndex(2);
              } catch (e) {}
            }
          }}
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
  }, [
    routesData,
    globalPlan,
    isBusFound,
    displayBusData,
    isOffline,
    isAdmin,
    openActivePlanInSheet,
    selectedBusNo,
    selectedPreviewNumber,
    trackingError,
  ]);

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
            placeholder={"Search"}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            style={styles.searchInput}
            placeholderTextColor={COLORS.textBody}
          />

          {/* CLEAR / CANCEL BUTTON — fully resets the search so the map
              reverts to the KIOT college default (no stale bus marker). */}
          {searchQuery ? (
            <TouchableOpacity
              onPress={handleClearSearch}
              style={styles.clearButton}
            >
              <Ionicons name="close-circle" size={18} color={COLORS.textBody} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* RIGHT ICONS */}
        <View style={styles.rightIcons}>
          {/* REFRESH (DB/socket-based, no API re-fetch) */}
          <TouchableOpacity
            style={[
              styles.iconButtonPrimary,
              locationStatus === "loading" && { opacity: 0.6 },
            ]}
            onPress={handleSocketRefresh}
            activeOpacity={0.7}
            disabled={locationStatus === "loading"}
          >
            <Ionicons
              name="refresh"
              size={18}
              color="#fff"
              style={
                locationStatus === "loading" ? styles.refreshSpin : undefined
              }
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.planButton}
            onPress={openActivePlanInSheet}
            activeOpacity={0.7}
          >
            <Text style={styles.planButtonText}>
              {globalPlan?.replace("PLAN ", "") || "A"}
            </Text>
          </TouchableOpacity>

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
        ref={bottomSheetRef}
        index={0}
        snapPoints={SNAP_POINTS}
        enablePanDownToClose={false}
        animateOnMount={true}
        handleIndicatorStyle={styles.handleIndicator}
        backgroundStyle={styles.sheetBackground}
        containerStyle={styles.sheetContainer}
        onChange={(idx) => {
          // when sheet collapsed to smallest snap, clear plan-in-sheet state
          if (idx === 0) {
            setShowPlanInSheet(false);
            setPlanViewMode(null);
          }
        }}
      >
        <BottomSheetView style={styles.sheetContent}>
          {/* When plan view is requested, render plan lists/stops inside sheet */}
          {showPlanInSheet && planViewMode === "activePlan" ? (
            <View>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>{globalPlan}</Text>
                  <Text style={styles.sheetSubLabel}>
                    List of buses in active plan
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    setShowPlanInSheet(false);
                    setPlanViewMode(null);
                    if (
                      bottomSheetRef.current &&
                      bottomSheetRef.current.snapToIndex
                    ) {
                      try {
                        bottomSheetRef.current.snapToIndex(0);
                      } catch (e) {}
                    }
                  }}
                >
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
              </View>

              {loadingPlanBuses ? (
                <ActivityIndicator
                  color={COLORS.primary}
                  style={{ marginVertical: 30 }}
                />
              ) : planBuses.length === 0 ? (
                <View style={styles.noPlansBox}>
                  <Text style={styles.noPlansText}>
                    No buses are assigned to {globalPlan} right now.
                  </Text>
                </View>
              ) : (
                <ScrollView style={[styles.stopsList, { maxHeight: 400 }]}>
                  {planBuses.map((bus) => (
                    <TouchableOpacity
                      key={bus.previewNumber}
                      style={styles.planBusRow}
                      onPress={() => handleOpenPlanBus(bus.previewNumber)}
                    >
                      <Text style={styles.planBusNumber}>
                        Bus {getDisplayBusNumber(bus)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          ) : showPlanInSheet && planViewMode === "stopsForBus" ? (
            <View>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>Bus {displayBusLabel}</Text>
                  <Text style={styles.sheetSubLabel}>Plans & Stops</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    setShowPlanInSheet(false);
                    setPlanViewMode(null);
                    if (
                      bottomSheetRef.current &&
                      bottomSheetRef.current.snapToIndex
                    ) {
                      try {
                        bottomSheetRef.current.snapToIndex(0);
                      } catch (e) {}
                    }
                  }}
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
                  <ScrollView style={[styles.stopsList, { maxHeight: 400 }]}>
                    {(routesData.plans[activePlanTab] || []).map(
                      (stop, idx) => (
                        <View
                          key={`${activePlanTab}-${idx}`}
                          style={styles.stopRow}
                        >
                          <View style={styles.stopIndex}>
                            <Text style={styles.stopIndexText}>{idx + 1}</Text>
                          </View>
                          <Text style={styles.stopName}>{stop.stop_name}</Text>
                        </View>
                      ),
                    )}
                  </ScrollView>
                </>
              )}
            </View>
          ) : (
            <>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>Live Bus Tracking</Text>
                  <Text style={styles.sheetSubLabel}>
                    {isAdmin
                      ? "search for bus to view time location"
                      : assignedBusDisplay === "—"
                        ? "no bus assigned"
                        : `tracking your bus ${assignedBusDisplay}`}
                  </Text>
                </View>
              </View>

              <View style={styles.content}>
                {trackingError ? (
                  <View>
                    <Text style={[styles.infoText, styles.errorText]}>
                      {trackingError}
                    </Text>
                    <Text style={[styles.infoText, styles.subInfoText]}>
                      Showing KIOT campus location.
                    </Text>
                  </View>
                ) : error ? (
                  <Text style={[styles.infoText, styles.errorText]}>
                    {error}
                  </Text>
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
                      : assignedBusDisplay === "—"
                        ? "No bus assigned"
                        : `Tracking your bus ${assignedBusDisplay}...`}
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
            </>
          )}
        </BottomSheetView>
      </BottomSheet>

      {/* ============ ACTIVE PLAN BUSES MODAL ============ */}
      <Modal
        visible={showPlanListModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPlanListModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Plan {globalPlan}</Text>
                <Text style={styles.modalSubtitle}>Buses in active plan</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowPlanListModal(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={24} color={COLORS.textBody} />
              </TouchableOpacity>
            </View>

            {loadingPlanBuses ? (
              <ActivityIndicator
                color={COLORS.primary}
                style={{ marginVertical: 30 }}
              />
            ) : planBuses.length === 0 ? (
              <View style={styles.noPlansBox}>
                <Text style={styles.noPlansText}>
                  No buses are assigned to {globalPlan} right now.
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.stopsList}>
                {planBuses.map((bus) => (
                  <TouchableOpacity
                    key={bus.previewNumber || bus.busNo}
                    style={styles.planBusRow}
                    onPress={() =>
                      handleOpenPlanBus(bus.previewNumber || bus.busNo)
                    }
                  >
                    <Text style={styles.planBusNumber}>
                      Bus {getDisplayBusNumber(bus)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

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

  planButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  planButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
  },
  refreshSpin: {
    // Simple static style for the refresh icon while a refresh is in progress.
    // (A real rotation animation would use RN Animated; kept minimal here.)
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
    marginBottom: 10,
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
    backgroundColor: "transparent",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 5,
    paddingBottom: 40,
    maxHeight: "75%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 15,
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
    paddingVertical: 5,
  },
  planTab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 7,
    paddingVertical: 0,
    borderRadius: 20,
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: "transparent",
    gap: 6,
    height: 24,
  },
  planTabActive: {
    backgroundColor: "#EEF2FF",
    borderColor: COLORS.primary,
  },
  planTabText: {
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.textBody,
    textTransform: "uppercase",
  },
  planTabTextActive: {
    color: COLORS.primary,
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
  planBusRow: {
    backgroundColor: "#F6F8FB",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  planBusNumber: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.textHeader,
  },
  planBusMeta: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 4,
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
