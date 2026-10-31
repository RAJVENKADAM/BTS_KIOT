/**
 * HomeScreen — Primary screen for live bus tracking.
 *
 * Architecture & Data Flow:
 * ─────────────────────────
 * 1. UI renders an OpenStreetMap (Leaflet via WebView) as fullscreen background.
 * 2. Top bar overlay provides bus search and Profile/Notifications navigation.
 * 3. @gorhom/bottom-sheet houses status info: bus card with distance-to-college,
 *    online/offline status, error/loading states.
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
 * - Live bus updates are socket-driven.
 *
 * Search & Marker Rules:
 * ───────────────────────
 * - Assigned buses auto-load from the user profile; users may search buses.
 * - "Not found" clears all previous markers.
 * - Marker only shows when shouldShowBusMarker evaluates to true — never falls
 *    back to stale lastGoodLocation for a failed search.
 *
 * Bus Status Detection:
 * ──────────────────────
 * - detectBusStatus tracks coordinate repetition for movement calculations.
 *  - Same coord 3x → "waiting"
 *  - Same coord 10x → "stopped"
 *  - Different coord → "moving"
 * - The user-facing badge reports GPS availability only: online or offline.
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
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { getErrorMessage } from "../utils/errorHandler";
import { getDisplayBusNumber } from "../utils/busDisplay";
import notificationApi from "../api/notificationApi";

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

const isGpsStale = (data) => {
  if (!data) return true;

  const status = String(data.status || "").toLowerCase();
  if (status === "offline" || data.is_online === false) return true;
  if (status !== "online" && data.is_online !== true) return true;

  const lastGps = data.lastSuccessfulGpsUpdate;
  if (!lastGps) return true;

  const timestamp = Date.parse(lastGps);
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp > 3 * 60 * 1000;
};

const HomeScreen = () => {
  const { token, user, updateUserData } = useAuth();
  const navigation = useNavigation();
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
  const [isBusFound, setIsBusFound] = useState(false);
  const [locationStatus, setLocationStatus] = useState("idle");
  const [markerStatus, setMarkerStatus] = useState("moving");
  const [isOffline, setIsOffline] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Routes and panel states consolidated inside Bottom Sheet
  const [routesData, setRoutesData] = useState(null);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
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

  const openSelectedBusStopsPage = useCallback(() => {
    const busIdentifier = selectedPreviewNumber || selectedBusNo;
    if (!isBusFound || !busIdentifier) return;

    navigation.navigate("PlanDetails", {
      mode: "stopsForBus",
      previewNumber: selectedPreviewNumber,
      busNo: selectedBusNo,
    });
  }, [
    selectedPreviewNumber,
    selectedBusNo,
    isBusFound,
    navigation,
  ]);

  const lastCoordinateRef = useRef(null);
  const sameCoordinateCountRef = useRef(0);
  const busStatusRef = useRef("moving");
  const selectedBusNoRef = useRef(selectedBusNo);
  useEffect(() => {
    selectedBusNoRef.current = selectedBusNo;
  }, [selectedBusNo]);
  const searchCounterRef = useRef(0);

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

    if (user?.bus_no) {
      setSelectedBusNo(user.bus_no);
      setSelectedPreviewNumber(null);
      setLocationStatus("loading");
    } else {
      setSelectedBusNo(null);
      setSelectedPreviewNumber(null);
      setLocationStatus("idle");
    }
  }, [user?.id, user?._id, user?.bus_no]);

  const autoLoadedBusKeyRef = useRef(null);
  useEffect(() => {
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

        if (
          data?.isBusActiveInCurrentPlan === false ||
          data?.notActiveMessage
        ) {
          setTrackingError("Your bus is inactive.");
          setLocationStatus("offline");
          setIsOffline(true);
          setMarkerStatus("inactive");
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
          setMarkerStatus("offline");
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
          setTrackingError(null);
          setMarkerStatus("moving");
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
        setNoBusFound(err?.status === 404);
        setTrackingError(
          err?.status === 404
            ? "Bus not found. Please check the bus number and try again."
            : getErrorMessage(err, "Could not load this bus."),
        );
        setIsBusFound(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?._id, user?.bus_no, token]);

  useEffect(() => {
    if (!socket || (!selectedBusNo && !selectedPreviewNumber)) return;
    // Join preview-based room (prefer previewNumber for privacy)
    const roomIds = [
      selectedPreviewNumber || selectedBusNo,
      busData?.effectivePreviewNumber,
    ].filter(Boolean);
    [...new Set(roomIds.map(String))].forEach((roomId) => {
      socket.emit("join-bus", roomId);
    });
    return () => {
      [...new Set(roomIds.map(String))].forEach((roomId) => {
        socket.emit("leave-bus", roomId);
      });
    };
  }, [socket, selectedBusNo, selectedPreviewNumber, busData?.effectivePreviewNumber]);

  useEffect(() => {
    if (!socket || !user?.id) return;
    socket.emit("join-user", user.id);
    const handleNotification = (notification) => {
      setUnreadNotifications((count) => count + 1);
      if (notification?.type === "plan_changed" && user?.bus_no) {
        const assignedBusNo = String(user.bus_no).toUpperCase();
        setSelectedBusNo(assignedBusNo);
        setSelectedPreviewNumber(null);
        setTrackingError(null);
        setLocationStatus("loading");
        Promise.all([
          busApi.getBusLocation(token, assignedBusNo),
          busApi.getBusRoutes(token, assignedBusNo),
        ])
          .then(([nextBus, nextRoutes]) => {
            setBusData(nextBus);
            setLastGoodLocation(nextBus);
            setRoutesData(nextRoutes);
            setIsBusFound(true);
            setIsOffline(isGpsStale(nextBus));
            setLocationStatus(isGpsStale(nextBus) ? "offline" : "live");
          })
          .catch((error) =>
            console.error("Failed to refresh bus after service change:", error),
          );
      }
      if (
        ["bus_altered", "bus_combined"].includes(notification?.type) &&
        user
      ) {
        const newPreview = notification.newPreview;
        if (newPreview) {
          const isCombined = notification.type === "bus_combined";
          updateUserData({
            ...user,
            ...(isCombined ? { bus_no: String(newPreview) } : {}),
            previewNumber: newPreview,
          });
          const assignedBusNo = String(user.bus_no || "").toUpperCase();
          const isViewingAssignedBus =
            Boolean(assignedBusNo) &&
            (String(selectedBusNo || "").toUpperCase() === assignedBusNo ||
              (notification.oldPreview != null &&
                String(selectedPreviewNumber || "") ===
                  String(notification.oldPreview)));
          if (isViewingAssignedBus) {
            setSelectedBusNo(isCombined ? String(newPreview) : assignedBusNo);
            setSelectedPreviewNumber(isCombined ? String(newPreview) : null);
            setSearchQuery(String(newPreview));
            setTrackingError(null);
            setLocationStatus("loading");
            busApi
              .getBusLocation(
                token,
                isCombined ? String(newPreview) : assignedBusNo,
              )
              .then((data) => {
                const isOffline = isGpsStale(data);
                setBusData({
                  ...data,
                  _isOffline: isOffline,
                  _markerStatus: isOffline ? "offline" : "moving",
                });
                setLastGoodLocation(data);
                setIsOffline(isOffline);
                setLocationStatus(isOffline ? "offline" : "live");
                setTrackingError(null);
              })
              .catch((error) =>
                console.error(
                  "Failed to refresh bus after route change:",
                  error,
                ),
              );
          }
        }
      }
    };
    socket.on("notification", handleNotification);
    return () => socket.off("notification", handleNotification);
  }, [
    socket,
    user,
    updateUserData,
    token,
    selectedBusNo,
    selectedPreviewNumber,
  ]);

  useEffect(() => {
    if (!socket) return;
    const handleBusUpdate = (data) => {
      if (!["PLAN_CHANGED", "PLAN_MAPPING_CHANGED", "BUS_ALTERED", "BUS_COMBINED"].includes(data?.actionType)) return;
      const identifier = selectedPreviewNumber || selectedBusNo || user?.bus_no;
      if (!identifier) return;
      busApi
        .getBusLocation(token, identifier)
        .then((nextBusData) => {
          setBusData(nextBusData);
          setLastGoodLocation(nextBusData);
        })
        .catch((error) => console.error("Failed to refresh assigned bus:", error));
      busApi
        .getBusRoutes(token, identifier)
        .then(setRoutesData)
        .catch((error) => console.error("Failed to refresh bus stops:", error));
    };
    socket.on("bus-update", handleBusUpdate);
    return () => socket.off("bus-update", handleBusUpdate);
  }, [socket, token, selectedBusNo, selectedPreviewNumber, user?.bus_no]);

  useEffect(() => {
    if (!token) return;
    notificationApi
      .getUnreadCount(token)
      .then((data) => setUnreadNotifications(data.unreadCount || 0))
      .catch((error) =>
        console.error("Failed to load notification count:", error),
      );
  }, [token]);

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
    const handleLocationUpdate = (data) => {
      if (!data || data.error) return;
      const selected = selectedBusNoRef.current;
      if (!selected) return;
      if (!busData) return;
      if (
        busData.isBusActiveInCurrentPlan === false ||
        busData.notActiveMessage
      ) {
        return;
      }
      const incomingBusNo =
        data.busNo ?? data.bus_no ?? data.busNumber ?? data.previewNumber;
      if (!incomingBusNo) return;
      const expectedPreviewNumbers = [
        selectedPreviewNumber,
        busData?.effectivePreviewNumber,
      ].filter(Boolean).map(String);
      if (
        expectedPreviewNumbers.length &&
        !expectedPreviewNumbers.includes(String(data.previewNumber ?? ""))
      ) {
        return;
      }

      const nextBusData = {
        ...(busData || {}),
        ...data,
        busNo: data.busNo ?? data.bus_no ?? selected,
        bus_no: data.bus_no ?? selected,
        previewNumber: data.previewNumber ?? selectedPreviewNumber ?? undefined,
        latitude: data.latitude ?? busData?.latitude,
        longitude: data.longitude ?? busData?.longitude,
        speed: data.speed ?? busData?.speed ?? 0,
        source: data.source || busData?.source || "gps",
        isBusActiveInCurrentPlan:
          data.isBusActiveInCurrentPlan ?? busData?.isBusActiveInCurrentPlan,
        notActiveMessage:
          data.notActiveMessage ?? busData?.notActiveMessage ?? null,
        alteration: data.alteration ?? busData?.alteration ?? null,
      };
      const inactive =
        nextBusData.isBusActiveInCurrentPlan === false ||
        !!nextBusData.notActiveMessage;
      const live = !inactive && !isGpsStale(nextBusData);

      setBusData(nextBusData);
      setLastGoodLocation(nextBusData);
      setLocationStatus(live ? "live" : "offline");
      setIsOffline(!live);
      setMarkerStatus(inactive ? "inactive" : live ? "moving" : "offline");
      setTrackingError(
        inactive
          ? "Your bus is inactive."
          : live
            ? null
            : "Bus is offline or no live GPS is available right now.",
      );
      setNoBusFound(false);
      setIsBusFound(true);
    };
    socket.on("locationUpdate", handleLocationUpdate);
    return () => socket.off("locationUpdate", handleLocationUpdate);
  }, [socket, busData, selectedBusNo, selectedPreviewNumber]);

  useEffect(() => {
    refreshBuses();
  }, [refreshBuses]);

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
    setMarkerStatus("moving");
    setBusData(null);
    setLastGoodLocation(null);
    setIsBusFound(false);
    setRoutesData(null);
    sameCoordinateCountRef.current = 0;
    lastCoordinateRef.current = null;
    if (isPreviewSearch) {
      setSelectedPreviewNumber(query);
      setSelectedBusNo(null);
      try {
        const data = await busApi.trackByPreview(token, query);

        if (currentSearch !== searchCounterRef.current) return;
        setTrackingError(null);

        if (!data || data.error || !(data.busNo || data.bus_no)) {
          throw new Error(
            data?.error || "No bus found for this preview number",
          );
        }
        const nextBusNo = data.busNo || data.bus_no || null;
        setSelectedBusNo(nextBusNo);
        setIsBusFound(true);

        if (
          data?.isBusActiveInCurrentPlan === false ||
          data?.notActiveMessage
        ) {
          setTrackingError("Your bus is inactive.");
          setBusData({ ...data, previewNumber: query, busNo: nextBusNo });
          setLastGoodLocation({
            ...data,
            previewNumber: query,
            busNo: nextBusNo,
          });
          setLocationStatus("offline");
          setIsOffline(true);
          setMarkerStatus("inactive");
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
          setMarkerStatus("offline");
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
          setTrackingError(null);
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
        setTrackingError(null);
        setSelectedBusNo(null);
        setSelectedPreviewNumber(null);
        setBusData(null);
        setLastGoodLocation(null);
        setIsBusFound(false);
        setRoutesData(null);
        setLocationStatus("error");
        setNoBusFound(err?.status === 404);
        setTrackingError(
          err?.status === 404
            ? "Bus not found. Please check the bus number and try again."
            : getErrorMessage(err, "Could not load this bus."),
        );
      }
    } else {
      const busNo = query.toUpperCase();
      setSelectedPreviewNumber(null);
      setSelectedBusNo(busNo);

      try {
        const data = await busApi.getBusLocation(token, busNo);

        if (currentSearch !== searchCounterRef.current) return;
        setIsBusFound(true);
        setTrackingError(null);

        if (
          data?.isBusActiveInCurrentPlan === false ||
          data?.notActiveMessage
        ) {
          setTrackingError("Your bus is inactive.");
          setBusData({ ...data, source: data?.source || "gps" });
          setLastGoodLocation({ ...data, source: data?.source || "gps" });
          setLocationStatus("offline");
          setIsOffline(true);
          setMarkerStatus("inactive");
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
          setBusData({ ...data, source: data.source || "offline" });
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
        setNoBusFound(err?.status === 404);
        setTrackingError(
          err?.status === 404
            ? "Bus not found. Please check the bus number and try again."
            : getErrorMessage(err, "Could not load this bus."),
        );
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
  }, [closeAllOverlayPanels]);

  const shouldShowBusMarker = !!selectedBusNo || !!selectedPreviewNumber;

  const displayBusData = shouldShowBusMarker ? busData : null;
  const displayBusLabel = getDisplayBusNumber({
    previewNumber:
      displayBusData?.alteration?.originalPreview ??
      selectedPreviewNumber ??
      displayBusData?.previewNumber,
    preview_number: displayBusData?.preview_number,
    busNo: selectedBusNo ?? displayBusData?.busNo ?? displayBusData?.bus_no,
  });
  const canViewBusStops =
    isBusFound && Boolean(selectedBusNo || selectedPreviewNumber);
  const assignedBusDisplay = getDisplayBusNumber({
    previewNumber: user?.previewNumber ?? user?.preview_number,
    busNo: user?.bus_no,
  });

  const busCardContent = React.useMemo(() => {
    if (!displayBusData) return null;
    const alteration = displayBusData.alteration;
    const distance = calculateDistance(
      displayBusData.latitude,
      displayBusData.longitude,
      KIOT_LAT,
      KIOT_LNG,
    );
    return (
      <View style={styles.busCard}>
        {displayBusData.notActiveMessage && (
          <View style={styles.inactivePlanBanner}>
            <Ionicons
              name="information-circle-outline"
              size={17}
              color="#92400E"
            />
            <Text style={styles.inactivePlanText}>
              {displayBusData.notActiveMessage || "Bus is not active today."}
            </Text>
          </View>
        )}
        {(alteration?.isAltered || alteration?.isReplacement) && (
          <View style={styles.inactivePlanBanner}>
            <Ionicons
              name="information-circle-outline"
              size={17}
              color="#92400E"
            />
            <Text style={styles.inactivePlanText}>{alteration.message}</Text>
          </View>
        )}
        <View style={styles.cardHeader}>
          <Text style={styles.busNumber}>Bus {displayBusLabel}</Text>
          <View
            style={[
              styles.statusBadge,
              isOffline ? styles.offlineBadge : styles.onlineBadge,
            ]}
          >
            <Text style={styles.badgeText}>
              {isOffline ? "OFFLINE" : "ONLINE"}
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
  }, [
    displayBusData,
    displayBusLabel,
    isOffline,
  ]);

  const planCardContent = React.useMemo(() => {
    if (!routesData && !isBusFound) return null;
    const isOfflineMode = isOffline || !displayBusData;
    const showTrackingError = isOfflineMode && Boolean(trackingError);
    const showNoStopsHint = Boolean(routesData) && !routesData.hasStops && isBusFound;
    if (!showTrackingError && !showNoStopsHint) return null;
    return (
      <View style={styles.planCard}>
        {showTrackingError ? (
          <View style={styles.lastPlanNote}>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={COLORS.textBody}
            />
            <Text style={styles.lastPlanNoteText}>{trackingError}</Text>
          </View>
        ) : null}
        {showNoStopsHint && (
          <Text style={styles.planEmptyHint}>
            No active stops are available for this bus today.
          </Text>
        )}
      </View>
    );
  }, [
    routesData,
    isBusFound,
    displayBusData,
    isOffline,
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
            displayBusData
              ? {
                  ...displayBusData,
                  _isOffline: isOffline,
                  _markerStatus: markerStatus,
                }
              : null
          }
          markerStatus={markerStatus}
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
            style={styles.notificationButton}
            onPress={() => {
              setUnreadNotifications(0);
              navigation.navigate("Notifications");
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="notifications-outline" size={19} color="#fff" />
            {unreadNotifications > 0 && (
              <View style={styles.notificationBadge}>
                <Text style={styles.notificationBadgeText}>
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </Text>
              </View>
            )}
          </TouchableOpacity>

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
          {showPlanInSheet && planViewMode === "stopsForBus" ? (
            <View style={{ flex: 1, paddingBottom: 24 }}>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetLabel}>
                    Bus {routesData?.routeBusPreviewNumber ?? displayBusLabel}
                  </Text>
                  <Text style={styles.sheetSubLabel}>
                    {routesData?.routeSelectionLabel
                      ? `Showing ${routesData.routeSelectionLabel}`
                      : routesData?.isReplacementRoute
                        ? `Original stops assigned to Bus ${routesData.routeBusPreviewNumber}`
                        : "Plans & Stops"}
                  </Text>
                </View>
                <TouchableOpacity onPress={closeAllOverlayPanels}>
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
              </View>

              {canViewBusStops && (
                <TouchableOpacity
                  style={styles.liveStopsButton}
                  onPress={openSelectedBusStopsPage}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="map-outline"
                    size={16}
                    color={COLORS.primary}
                  />
                  <Text style={styles.liveStopsButtonText}>View stops</Text>
                </TouchableOpacity>
              )}

              {loadingRoutes ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color={COLORS.primary} size="small" />
                  <Text style={styles.loadingText}>
                    Fetching route stops...
                  </Text>
                </View>
              ) : !routesData || !routesData.hasStops ? (
                <View style={styles.noPlansBox}>
                  <Text style={styles.noPlansText}>
                    No active stops are available for this bus today.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 80 }}
                  showsVerticalScrollIndicator={true}
                >
                  {(routesData.stops || []).map((stop, idx) => (
                    <View
                      key={`${stop.stopId || stop.stop_order}-${idx}`}
                      style={styles.stopRow}
                    >
                      <View style={styles.stopIndex}>
                        <Text style={styles.stopIndexText}>{idx + 1}</Text>
                      </View>
                      <View style={styles.stopDetails}>
                        <Text style={styles.stopName}>{stop.stop_name}</Text>
                        {stop.arrival_time ? (
                          <Text style={styles.stopArrivalTime}>
                            {stop.arrival_time}
                          </Text>
                        ) : null}
                      </View>
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
                    {selectedBusNo || selectedPreviewNumber
                        ? `tracking bus ${displayBusLabel}`
                        : assignedBusDisplay === "—"
                          ? "no bus assigned"
                          : `tracking your bus ${assignedBusDisplay}`}
                  </Text>
                </View>
              </View>

              {canViewBusStops && (
                <TouchableOpacity
                  style={styles.liveStopsButton}
                  onPress={openSelectedBusStopsPage}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="map-outline"
                    size={16}
                    color={COLORS.primary}
                  />
                  <Text style={styles.liveStopsButtonText}>View stops</Text>
                </TouchableOpacity>
              )}

              <View style={styles.content}>
                {trackingError ? (
                  <View>
                    <Text style={[styles.infoText, styles.errorText]}>
                      {trackingError}
                    </Text>
                    {markerStatus === "inactive" && (
                      <Text style={[styles.infoText, styles.subInfoText]}>
                        Your assigned bus is not operating today.
                      </Text>
                    )}
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
                    {assignedBusDisplay === "—"
                      ? "No bus assigned"
                      : `Tracking your bus ${assignedBusDisplay}...`}
                  </Text>
                ) : locationStatus === "loading" && !routesData ? (
                  <Text style={styles.infoText}>Loading live location...</Text>
                ) : displayBusData ? (
                  <>{busCardContent}</>
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
    gap: 4,
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

  notificationButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  notificationBadge: {
    position: "absolute",
    right: -3,
    top: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: COLORS.error,
    alignItems: "center",
    justifyContent: "center",
  },
  notificationBadgeText: { color: "#fff", fontSize: 9, fontWeight: "700" },
  studentPlanInfo: {
    paddingVertical: 8,
  },
  studentPlanInfoText: {
    color: COLORS.textBody,
    fontSize: 14,
    fontWeight: "600",
  },
  studentPlanAction: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 5,
  },
  inactivePlanBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEF3C7",
    borderRadius: 8,
    padding: 9,
    marginBottom: 10,
  },
  inactivePlanText: { flex: 1, color: "#92400E", fontWeight: "600" },
  liveStopsButton: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 40,
    marginTop: 12,
    borderRadius: 8,
    backgroundColor: "#E8F0FE",
  },
  liveStopsButtonText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: "800",
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

  onlineBadge: {
    backgroundColor: "#16a34a",
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
  sheetNearbyButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },
  sheetNearbyButtonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  planStopsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
    backgroundColor: "#E8F0FE",
  },
  planStopsButtonText: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "700",
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
  stopDetails: {
    flex: 1,
  },
  stopArrivalTime: {
    marginTop: 3,
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: "700",
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
