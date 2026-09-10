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
 *    marker movement state, and display logic.
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
 *    back to stale lastGoodLocation for a failed search.
 *
 * Bus Status Detection:
 * ──────────────────────
 * - detectBusStatus tracks coordinate repetition via refs.
 *  - Same coord 3x → "waiting"
 *  - Same coord 10x → "stopped"
 *  - Different coord → "moving"
 * - chooseBusStatus prioritises API's "stopped" state over coordinate detection.
 */
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import OSMMap from "../components/Map/OSMMap";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  StatusBar,
  Platform,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Dimensions, // ADD THIS
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

  // Routes and panel states consolidated inside Bottom Sheet
  const [routesData, setRoutesData] = useState(null);
  const [planBuses, setPlanBuses] = useState([]);
  const [activePlanTab, setActivePlanTab] = useState("PLAN A");
  const [globalPlan, setGlobalPlan] = useState("PLAN A");
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [loadingPlanBuses, setLoadingPlanBuses] = useState(false);
  const bottomSheetRef = useRef(null);
  const [showPlanInSheet, setShowPlanInSheet] = useState(false);
  const [planViewMode, setPlanViewMode] = useState(null); // 'activePlan' | 'stopsForBus' | null

  // Compute where the search bar actually ends, so the sheet never expands behind it
  const { height: SCREEN_HEIGHT } = Dimensions.get("window");
  const TOP_BAR_TOP = Platform.OS === "ios" ? 60 : 50;
  const TOP_BAR_HEIGHT = 45;
  const SAFE_GAP_BELOW_SEARCH = 12;
  const SEARCH_BAR_BOTTOM =
    TOP_BAR_TOP + TOP_BAR_HEIGHT + SAFE_GAP_BELOW_SEARCH;

  // Refined snap points to ensure modal expands safely up to right below the search bar without overlapping it
  const snapPoints = useMemo(() => {
    const maxAvailableHeight = SCREEN_HEIGHT - SEARCH_BAR_BOTTOM;
    const maxPercent = Math.floor((maxAvailableHeight / SCREEN_HEIGHT) * 100);

    if (showPlanInSheet) {
      return ["50%", `${Math.min(maxPercent, 68)}%`];
    }
    return ["25%", "45%"];
  }, [showPlanInSheet]);

  const closeAllOverlayPanels = useCallback(() => {
    setShowPlanInSheet(false);
    setPlanViewMode(null);
  }, []);

  const [isBusFound, setIsBusFound] = useState(false);

  const lastCoordinateRef = useRef(null);
  const sameCoordinateCountRef = useRef(0);
  const busStatusRef = useRef("moving");
  const selectedBusNoRef = useRef(selectedBusNo);
  useEffect(() => {
    selectedBusNoRef.current = selectedBusNo;
  }, [selectedBusNo]);
  const searchCounterRef = useRef(0);

  const busStorageKey = useCallback(
    (key) => {
      if (!isAdmin) return null;
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

  useEffect(() => {
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
      setSelectedBusNo(null);
      setLocationStatus("idle");
      return;
    }

    if (user?.bus_no) {
      setSelectedBusNo(user.bus_no);
      setLocationStatus("loading");
    } else {
      setSelectedBusNo(null);
      setLocationStatus("idle");
    }
  }, [user?.id, user?._id, user?.bus_no, isAdmin]);

  const autoLoadedBusKeyRef = useRef(null);
  useEffect(() => {
    if (isAdmin) return;
    const assignedBusNo = (user?.bus_no || "").trim().toUpperCase() || null;
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
    if (autoLoadedBusKeyRef.current === loadKey) return;
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
        setRoutesData((prev) => prev);

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
        setSelectedBusNo(assignedBusNo);
        setBusData(null);
        setLastGoodLocation(null);
        setRoutesData(null);
        setLocationStatus("error");
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
  }, [socket, busData, selectedBusNo, selectedPreviewNumber]);

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

        const sorted = [...buses].sort((a, b) => {
          const getVal = (item) => {
            if (typeof item === "string" || typeof item === "number") {
              return String(item);
            }
            return String(
              item?.previewNumber ||
                item?.preview_number ||
                item?.busNumber ||
                item?.bus_number ||
                item?.busNo ||
                item?.bus_no ||
                item?.name ||
                "",
            ).trim();
          };

          const strA = getVal(a);
          const strB = getVal(b);

          const numA = parseInt(strA.replace(/\D/g, ""), 10);
          const numB = parseInt(strB.replace(/\D/g, ""), 10);

          if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
          }

          return strA.localeCompare(strB, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        });

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

  const openActivePlanInSheet = useCallback(async () => {
    const latestPlan = await loadGlobalActivePlan();
    await loadActivePlanBuses(latestPlan);
    setPlanViewMode("activePlan");
    setShowPlanInSheet(true);
    if (bottomSheetRef.current && bottomSheetRef.current.snapToIndex) {
      try {
        bottomSheetRef.current.snapToIndex(1); // expand to higher snap point
      } catch (e) {}
    }
  }, [loadGlobalActivePlan, loadActivePlanBuses]);

  useEffect(() => {
    loadGlobalActivePlan();
  }, [loadGlobalActivePlan]);

  useEffect(() => {
    refreshBuses();
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
  }, [busStorageKey, isAdmin]);

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

  const isGpsStale = (data) => {
    if (!data) return true;
    if (data.status === "offline") return true;
    const lastGps = data.lastSuccessfulGpsUpdate;
    if (!lastGps) return true;
    const ageMs = Date.now() - new Date(lastGps).getTime();
    return ageMs > 3 * 60 * 1000;
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

      const staleGps = isGpsStale(data);

      if (staleGps) {
        setIsOffline(true);
        setLocationStatus("offline");
        if (hasValidCoords) {
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
  ]);

  const handleOpenPlanBus = useCallback(
    async (busNo) => {
      if (!busNo) return;
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
          setPlanViewMode("stopsForBus");
          setShowPlanInSheet(true);
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
        setPlanViewMode("stopsForBus");
        setShowPlanInSheet(true);
        if (bottomSheetRef.current && bottomSheetRef.current.snapToIndex) {
          bottomSheetRef.current.snapToIndex(1);
        }
      } catch (err) {
        console.log("Open plan bus error:", err.message);
        setTrackingError(getErrorMessage(err, "Could not load this bus"));
        setLocationStatus("error");
      }
    },
    [token],
  );

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    const isPreviewSearch = /^\d+$/.test(query);

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

        const hasPreviewCoords =
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude));

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
        if (currentSearch !== searchCounterRef.current) return;
        setSelectedBusNo(null);
        setSelectedPreviewNumber(null);
        setBusData(null);
        setLastGoodLocation(null);
        setIsBusFound(false);
        setRoutesData(null);
        setLocationStatus("error");
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
      setIsBusFound(true);

      try {
        const data = await busApi.getBusLocation(token, busNo);

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

        if (
          data &&
          data.latitude != null &&
          data.longitude != null &&
          Number.isFinite(Number(data.latitude)) &&
          Number.isFinite(Number(data.longitude)) &&
          data.latitude !== "NaN" &&
          data.longitude !== "NaN"
        ) {
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
          setBusData(null);
          setLastGoodLocation(null);
          setLocationStatus("offline");
          setIsOffline(true);
          setIsBusFound(true);
          setNoBusFound(false);
        }
      } catch (err) {
        if (currentSearch !== searchCounterRef.current) return;
        setBusData(null);
        setLastGoodLocation(null);
        setIsBusFound(false);
        setRoutesData(null);
        setLocationStatus("error");
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
    closeAllOverlayPanels();
    if (isAdmin) setIsSuperadminSearched(false);
  }, [isAdmin, closeAllOverlayPanels]);

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
                  : `Current global plan is ${currentPlan}`}
            </Text>
          </View>
        )}
        <TouchableOpacity
          style={styles.planChip}
          onPress={() => {
            if (!selectedBusNo && !selectedPreviewNumber) {
              // Navigate to PlanDetails page for the active global plan
              navigation.navigate("PlanDetails", { mode: "activePlan", plan: globalPlan });
              return;
            }
            // If a bus is selected, navigate to the stops view for that bus
            navigation.navigate("PlanDetails", {
              mode: "stopsForBus",
              previewNumber: selectedPreviewNumber,
              busNo: selectedBusNo,
            });
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
          <Ionicons name="search" size={18} color={COLORS.textBody} />

          <TextInput
            placeholder={"Search"}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            style={styles.searchInput}
            placeholderTextColor={COLORS.textBody}
          />

          <View style={styles.clearSlot}>
            {searchQuery ? (
              <TouchableOpacity
                onPress={handleClearSearch}
                style={styles.clearButton}
              >
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={COLORS.textBody}
                />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <View style={styles.rightIcons}>
          <TouchableOpacity
            style={[
              styles.iconButtonPrimary,
              locationStatus === "loading" && { opacity: 0.6 },
            ]}
            onPress={handleSocketRefresh}
            activeOpacity={0.7}
            disabled={locationStatus === "loading"}
          >
            <Ionicons name="refresh" size={18} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.planButton}
            onPress={() => navigation.navigate("PlanDetails", { mode: "activePlan", plan: globalPlan })}
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

      <BottomSheet
        ref={bottomSheetRef}
        index={0}
        snapPoints={snapPoints}
        enablePanDownToClose={false}
        animateOnMount={true}
        handleIndicatorStyle={styles.handleIndicator}
        backgroundStyle={styles.sheetBackground}
        containerStyle={styles.sheetContainer}
        onChange={(idx) => {
          if (idx === 0 && !showPlanInSheet) {
            closeAllOverlayPanels();
          }
        }}
      >
        <BottomSheetView style={styles.sheetContent}>
          {showPlanInSheet && planViewMode === "activePlan" ? (
            <View style={{ flex: 1, paddingBottom: 24 }}>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>{globalPlan}</Text>
                  <Text style={styles.sheetSubLabel}>
                    List of buses in active plan
                  </Text>
                </View>
                <TouchableOpacity onPress={closeAllOverlayPanels}>
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
              </View>

              {loadingPlanBuses ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color={COLORS.primary} size="small" />
                  <Text style={styles.loadingText}>
                    Fetching active plan buses...
                  </Text>
                </View>
              ) : planBuses.length === 0 ? (
                <View style={styles.noPlansBox}>
                  <Text style={styles.noPlansText}>
                    No buses are assigned to {globalPlan} right now.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 80 }}
                  showsVerticalScrollIndicator={true}
                >
                  {planBuses.map((bus, idx) => (
                    <TouchableOpacity
                      key={`${bus.previewNumber ?? bus.busNo ?? bus.bus_no ?? "bus"}-${idx}`}
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
            <View style={{ flex: 1, paddingBottom: 24 }}>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>Bus {displayBusLabel}</Text>
                  <Text style={styles.sheetSubLabel}>Plans & Stops</Text>
                </View>
                <TouchableOpacity onPress={closeAllOverlayPanels}>
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
              </View>

              {loadingRoutes ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color={COLORS.primary} size="small" />
                  <Text style={styles.loadingText}>
                    Fetching route stops...
                  </Text>
                </View>
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
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 80 }}
                  showsVerticalScrollIndicator={true}
                >
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
    </View>
  );
};

export default HomeScreen;

// ...styles remain the same

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
    flex: 1, // ADD THIS — lets inner ScrollViews claim the sheet's real available height
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
