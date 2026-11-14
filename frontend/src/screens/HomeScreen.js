/**
 * HomeScreen — Primary screen for live bus tracking.
 *
 * Architecture & Data Flow:
 * ─────────────────────────
 * 1. UI renders an OpenStreetMap (Leaflet via WebView) as fullscreen background.
 * 2. Top bar overlay provides Profile/Notifications navigation.
 * 3. @gorhom/bottom-sheet houses status info: bus card with distance-to-college,
 *    online/offline status, error/loading states.
 *
 * State Management:
 * ─────────────────
 * - AuthContext provides { token, user } for API auth.
 * - BusContext provides { error, refreshBuses, getSocket } for bus list + socket.
 * - Local state tracks busData (latest GPS), location status,
 *    marker movement state, and display logic.
 *
 * Socket Integration:
 * ───────────────────
 * - Joins/leaves authorized preview rooms while Home is focused.
 * - Listens for "bus-update" events to refresh live bus status in real time.
 * - Live bus updates are socket-driven.
 *
 * Marker Rules:
 * ──────────────
 * - Assigned buses auto-load from the user profile.
 * - Marker only shows when shouldShowBusMarker evaluates to true — never falls
 *   back to stale lastGoodLocation for a failed lookup.
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
  AppState,
  StyleSheet,
  StatusBar,
  Platform,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Dimensions, // ADD THIS
} from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useBus } from "../context/BusContext";
import busApi from "../api/busApi";
import { COLORS, SHADOWS } from "../theme";
import { useAuth } from "../context/AuthContext";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { getErrorMessage } from "../utils/errorHandler";
import { getDisplayBusNumber } from "../utils/busDisplay";
import notificationApi from "../api/notificationApi";
const {
  getGpsFreshnessDelay,
  getLocationOrder,
  getSocketRecoveryDelay,
  hasValidGpsCoordinates,
  hasKnownLocationOrder,
  isGpsStale,
  isLocationForSelection,
  createGpsLocationReconciler,
} = require("../utils/gpsLocationPolicy.cjs");
const { getPreviewRoomIds } = require("../utils/socketConnectionPolicy.cjs");
const { subscribeSocketEvent } = require("../utils/socketSubscription.cjs");

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
  const { token, user, updateUserData } = useAuth();
  const isFleetAdmin = ["primary_admin", "superadmin"].includes(
    String(user?.role || "").toLowerCase(),
  );
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { assignment, error, getSocket } = useBus();
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
  const [appIsActive, setAppIsActive] = useState(
    AppState.currentState === "active",
  );
  const busDataRef = useRef(busData);
  busDataRef.current = busData;
  const selectedPreviewNumberRef = useRef(selectedPreviewNumber);
  selectedPreviewNumberRef.current = selectedPreviewNumber;
  const hasBeenFocusedRef = useRef(false);
  const latestGpsOrderRef = useRef(getLocationOrder(null));
  const reconnectRequestRef = useRef(0);
  const gpsSnapshotRequestInFlightRef = useRef(false);
  const gpsReconcilerRef = useRef(createGpsLocationReconciler());
  const gpsSelectionKeyRef = useRef(null);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppIsActive(nextState === "active");
    });
    return () => subscription.remove();
  }, []);

  const getGpsSelectionKey = (busNo, previewNumber) => {
    if (previewNumber) return `preview:${String(previewNumber)}`;
    if (busNo) return `bus:${String(busNo).trim().toUpperCase()}`;
    return null;
  };

  const selectGpsTarget = (busNo, previewNumber) => {
    const key = getGpsSelectionKey(busNo, previewNumber);
    if (gpsSelectionKeyRef.current !== key) {
      gpsSelectionKeyRef.current = key;
      gpsReconcilerRef.current.select(key);
      latestGpsOrderRef.current = getLocationOrder(null);
      busDataRef.current = null;
    }
    return key;
  };

  const beginGpsSnapshot = (key = gpsSelectionKeyRef.current) =>
    gpsReconcilerRef.current.beginSnapshot(key);

  const reconcileGpsSnapshot = (key, snapshot, generation) => {
    const result = gpsReconcilerRef.current.reconcileSnapshot(
      key,
      snapshot,
      generation,
    );
    if (result.accepted) {
      latestGpsOrderRef.current = getLocationOrder(result.location);
    }
    return result;
  };

  useEffect(() => {
    if (!socket || !isFocused) return undefined;
    selectGpsTarget(
      selectedBusNoRef.current,
      selectedPreviewNumberRef.current,
    );
    let disposed = false;
    const handleLocationUpdate = (data) => {
      if (disposed || !data || data.error) return;
      const selected = selectedBusNoRef.current;
      const currentPreview = selectedPreviewNumberRef.current;
      const currentBusData = busDataRef.current;
      const currentKey = gpsSelectionKeyRef.current;
      const assignedBusNo = String(user?.bus_no || "").trim().toUpperCase();
      const allowAssignedRoomEvent =
        Boolean(selected) &&
        String(selected).trim().toUpperCase() === assignedBusNo;
      if (
        !isLocationForSelection(
          data,
          selected,
          currentPreview,
          currentBusData,
          allowAssignedRoomEvent,
        )
      ) {
        if (!currentBusData) {
          gpsReconcilerRef.current.bufferLive(currentKey, data);
        }
        return;
      }
      const reconciliation = gpsReconcilerRef.current.acceptLive(
        currentKey,
        data,
      );
      if (!reconciliation.accepted) return;
      latestGpsOrderRef.current = getLocationOrder(data);

      const hasFreshCoordinates =
        hasValidGpsCoordinates(data) && !isGpsStale(data);
      const nextBusData = {
        ...(currentBusData || {}),
        ...data,
        busNo: data.busNo ?? data.bus_no ?? selected,
        bus_no: data.bus_no ?? selected,
        previewNumber: data.previewNumber ?? currentPreview ?? undefined,
        latitude: hasFreshCoordinates
          ? data.latitude
          : null,
        longitude: hasFreshCoordinates
          ? data.longitude
          : null,
        speed: data.speed ?? currentBusData?.speed ?? 0,
        source: data.source || currentBusData?.source || "gps",
        isBusActiveInCurrentPlan:
          data.isBusActiveInCurrentPlan ??
          currentBusData?.isBusActiveInCurrentPlan,
        notActiveMessage:
          data.notActiveMessage ?? currentBusData?.notActiveMessage ?? null,
        alteration: data.alteration ?? currentBusData?.alteration ?? null,
      };
      const inactive =
        nextBusData.isBusActiveInCurrentPlan === false ||
        !!nextBusData.notActiveMessage;
      const live =
        !inactive &&
        hasFreshCoordinates;
      nextBusData._isOffline = !live;
      nextBusData._markerStatus = inactive
        ? "inactive"
        : live
          ? "moving"
          : "offline";
      busDataRef.current = nextBusData;

      const visibleLocationChanged = [
        "latitude",
        "longitude",
        "lastSuccessfulGpsUpdate",
        "speed",
        "status",
        "is_online",
        "_isOffline",
        "_markerStatus",
        "source",
        "gpsOfflineThresholdMs",
        "isBusActiveInCurrentPlan",
        "notActiveMessage",
      ].some((property) => !Object.is(currentBusData?.[property], nextBusData[property]));
      if (visibleLocationChanged) {
        setBusData(nextBusData);
        setLastGoodLocation(live ? nextBusData : null);
      }
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
    const unsubscribe = subscribeSocketEvent(
      socket,
      "locationUpdate",
      handleLocationUpdate,
    );
    return () => {
      disposed = true;
      unsubscribe();
      gpsReconcilerRef.current.invalidate();
      gpsSelectionKeyRef.current = null;
      latestGpsOrderRef.current = getLocationOrder(null);
    };
  }, [socket, isFocused, user?.id, user?._id, user?.bus_no]);

  useEffect(() => {
    if (!busData || locationStatus !== "live") return undefined;
    let timer;
    const updateFreshness = () => {
      const currentLocation = busDataRef.current;
      if (!currentLocation) return;
      const delay = getGpsFreshnessDelay(currentLocation);
      if (delay > 0) {
        timer = setTimeout(updateFreshness, delay);
        return;
      }
      if (!isGpsStale(currentLocation)) return;
      setLocationStatus("offline");
      setIsOffline(true);
      setMarkerStatus("offline");
      setTrackingError("Bus is offline or no live GPS is available right now.");
      setBusData((current) =>
        current ? { ...current, _isOffline: true, _markerStatus: "offline" } : current,
      );
      setLastGoodLocation((current) =>
        current ? { ...current, _isOffline: true, _markerStatus: "offline" } : current,
      );
    };
    timer = setTimeout(updateFreshness, getGpsFreshnessDelay(busData));
    return () => clearTimeout(timer);
  }, [busData, locationStatus]);

  // Routes and panel states consolidated inside Bottom Sheet
  const [routesData, setRoutesData] = useState(null);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const bottomSheetRef = useRef(null);
  const [showPlanInSheet, setShowPlanInSheet] = useState(false);
  const [planViewMode, setPlanViewMode] = useState(null); // 'activePlan' | 'stopsForBus' | null
  const assignmentKeyRef = useRef(null);

  useEffect(() => {
    if (user?.role !== "student" || !assignment) return;

    const assignedBusNo = assignment.busNo || null;
    const previewNumber = assignment.previewNumber || null;
    const nextKey = `${assignment.assignmentVersion || "0"}:${previewNumber || assignedBusNo || "none"}`;
    if (assignmentKeyRef.current !== nextKey) {
      assignmentKeyRef.current = nextKey;
      gpsReconcilerRef.current.invalidate();
      latestGpsOrderRef.current = getLocationOrder(null);
      setRoutesData(null);
      setLastGoodLocation(null);
    }

    const selectionKey = selectGpsTarget(assignedBusNo, previewNumber);
    selectedBusNoRef.current = assignedBusNo;
    selectedPreviewNumberRef.current = previewNumber;
    setSelectedBusNo(assignedBusNo);
    setSelectedPreviewNumber(previewNumber);

    if (!assignedBusNo && !previewNumber) {
      busDataRef.current = null;
      setBusData(null);
      setIsBusFound(false);
      setIsOffline(false);
      setLocationStatus("unavailable");
      setMarkerStatus("inactive");
      setTrackingError(
        assignment.notActiveMessage || "No bus is currently assigned to you.",
      );
      return;
    }

    const hasFreshCoordinates =
      assignment.gpsStatus === "fresh" &&
      hasValidGpsCoordinates(assignment) &&
      !isGpsStale(assignment);
    const inactive = assignment.isBusActiveInCurrentPlan === false;
    const nextBusData = {
      ...assignment,
      busNo: assignedBusNo,
      previewNumber,
      _isOffline: !hasFreshCoordinates,
      _markerStatus: inactive
        ? "inactive"
        : hasFreshCoordinates
          ? "moving"
          : "offline",
    };
    busDataRef.current = nextBusData;
    setBusData(nextBusData);
    setIsBusFound(true);
    setIsOffline(!hasFreshCoordinates);
    setLocationStatus(hasFreshCoordinates ? "live" : "offline");
    setMarkerStatus(nextBusData._markerStatus);
    setTrackingError(
      inactive
        ? assignment.notActiveMessage || "Your assigned bus is unavailable."
        : hasFreshCoordinates
          ? null
          : assignment.gpsStatus === "stale"
            ? "GPS data is stale. Waiting for a fresh location."
            : "No fresh GPS location is available for your assigned bus.",
    );
    if (hasFreshCoordinates) {
      setLastGoodLocation(nextBusData);
    } else {
      setLastGoodLocation(null);
    }
    if (selectionKey) setNoBusFound(false);
  }, [assignment, user?.role]);

  // Keep the expanded sheet below the profile and notification controls.
  const { height: SCREEN_HEIGHT } = Dimensions.get("window");
  const TOP_BAR_TOP = Platform.OS === "ios" ? 60 : 50;
  const TOP_BAR_HEIGHT = 32;
  const SAFE_GAP_BELOW_TOP_BAR = 12;
  const TOP_BAR_BOTTOM = TOP_BAR_TOP + TOP_BAR_HEIGHT + SAFE_GAP_BELOW_TOP_BAR;

  const snapPoints = useMemo(() => {
    const maxAvailableHeight = SCREEN_HEIGHT - TOP_BAR_BOTTOM;
    const maxPercent = Math.floor((maxAvailableHeight / SCREEN_HEIGHT) * 100);

    if (showPlanInSheet) {
      return ["50%", `${Math.min(maxPercent, 80)}%`];
    }
    return ["25%", "45%"];
  }, [showPlanInSheet, SCREEN_HEIGHT, TOP_BAR_BOTTOM]);

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
  selectedBusNoRef.current = selectedBusNo;
  const searchCounterRef = useRef(0);

  useEffect(() => {
    if (!isFleetAdmin) return;
    busDataRef.current = null;
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
    selectedPreviewNumberRef.current = null;
    gpsReconcilerRef.current.invalidate();
    gpsSelectionKeyRef.current = null;
    latestGpsOrderRef.current = getLocationOrder(null);

    if (user?.bus_no) {
      setSelectedBusNo(user.bus_no);
      setSelectedPreviewNumber(null);
      setLocationStatus("loading");
    } else {
      setSelectedBusNo(null);
      setSelectedPreviewNumber(null);
      setLocationStatus("idle");
    }
  }, [user?.id, user?._id, user?.bus_no, isFleetAdmin]);

  useEffect(() => {
    if (user?.role !== "student" || assignment) return;
    busDataRef.current = null;
    setBusData(null);
    setLastGoodLocation(null);
    setRoutesData(null);
    setSelectedBusNo(null);
    setSelectedPreviewNumber(null);
    selectedBusNoRef.current = null;
    selectedPreviewNumberRef.current = null;
    setIsBusFound(false);
    setIsOffline(false);
    setLocationStatus("loading");
    setTrackingError(null);
  }, [user?.id, user?._id, user?.role, assignment]);

  const autoLoadedBusKeyRef = useRef(null);
  useEffect(() => {
    if (!isFleetAdmin) return;
    const assignedBusNo = (user?.bus_no || "").trim().toUpperCase() || null;
    let snapshotGeneration = null;
    if (assignedBusNo) {
      selectedBusNoRef.current = assignedBusNo;
      setSelectedBusNo(assignedBusNo);
      selectedPreviewNumberRef.current = null;
      const selectionKey = selectGpsTarget(assignedBusNo, null);
      snapshotGeneration = beginGpsSnapshot(selectionKey);
    } else {
      selectedBusNoRef.current = null;
      setSelectedBusNo(null);
      selectedPreviewNumberRef.current = null;
      selectGpsTarget(null, null);
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
        const snapshot = await busApi.getBusLocation(token, assignedBusNo);
        if (cancelled) return;
        const reconciliation = reconcileGpsSnapshot(
          `bus:${assignedBusNo}`,
          snapshot,
          snapshotGeneration,
        );
        if (!reconciliation.accepted) return;
        const data = reconciliation.location;

        const hasValidCoords = hasValidGpsCoordinates(data);

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
        if (
          cancelled ||
          gpsSelectionKeyRef.current !== `bus:${assignedBusNo}`
        ) {
          return;
        }
        if (hasKnownLocationOrder(latestGpsOrderRef.current)) return;
        setSelectedBusNo(assignedBusNo);
        setBusData(null);
        setLastGoodLocation(null);
        setRoutesData(null);
        setLocationStatus("error");
        setNoBusFound(err?.status === 404);
        setTrackingError(
          err?.status === 404 && user?.bus_no
            ? `Your assigned bus ${assignedBusNo} is no longer available. It is inactive for today's service; contact the Super Admin for assistance.`
            : err?.status === 404
              ? "Bus not found. Please check the bus number and try again."
              : getErrorMessage(err, "Could not load this bus."),
        );
        if (err?.status === 404 && user?.bus_no) {
          setMarkerStatus("inactive");
          setIsOffline(true);
        }
        setIsBusFound(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?._id, user?.bus_no, token]);

  useEffect(() => {
    if (
      isFleetAdmin &&
      isFocused &&
      hasBeenFocusedRef.current &&
      socket?.connected
    ) {
      const selectedIdentifier =
        selectedPreviewNumberRef.current || selectedBusNoRef.current;
      if (selectedIdentifier) {
        socket.emit("request-bus-location", selectedIdentifier);
      }
    }
    if (isFocused) hasBeenFocusedRef.current = true;
  }, [isFocused, socket, isFleetAdmin]);

  useEffect(() => {
    if (
      !isFleetAdmin ||
      !socket ||
      (!selectedBusNo && !selectedPreviewNumber)
    ) return;
    if (!isFocused) return undefined;
    const roomIds = getPreviewRoomIds(selectedPreviewNumber, busData);
    roomIds.forEach((roomId) => {
      socket.emit("join-bus", roomId);
    });
    return () => {
      roomIds.forEach((roomId) => {
        socket.emit("leave-bus", roomId);
      });
    };
  }, [
    socket,
    isFocused,
    selectedBusNo,
    selectedPreviewNumber,
    isFleetAdmin,
    busData?.previewNumber,
    busData?.preview_number,
    busData?.effectivePreviewNumber,
  ]);

  useEffect(() => {
    if (!socket || !isFocused || !appIsActive) return undefined;
    let hasConnected = !!socket.connected;
    let recoveryAttempt = 0;
    let recoveryTimer = null;
    let recoveryRequestInFlight = false;
    let disposed = false;
    let scheduleRecovery = () => {};

    const getSelectedKey = () => {
      const currentBusNo = selectedBusNoRef.current;
      const currentPreview = selectedPreviewNumberRef.current;
      if (currentPreview) return `preview:${currentPreview}`;
      if (currentBusNo) return `bus:${currentBusNo}`;
      return null;
    };

    const refreshLocation = async (targetKey) => {
      if (
        disposed ||
        !socket.connected ||
        recoveryRequestInFlight ||
        gpsSnapshotRequestInFlightRef.current
      ) return;
      const currentBusNo = selectedBusNoRef.current;
      const currentPreview = selectedPreviewNumberRef.current;
      if (!currentBusNo && !currentPreview) return;
      recoveryRequestInFlight = true;
      const selectedKey = targetKey || (currentPreview
        ? `preview:${currentPreview}`
        : `bus:${currentBusNo}`);
      if (selectedKey !== getSelectedKey()) {
        recoveryRequestInFlight = false;
        return;
      }
      gpsSnapshotRequestInFlightRef.current = true;
      const snapshotGeneration = beginGpsSnapshot(selectedKey);
      const requestId = ++reconnectRequestRef.current;
      try {
        const data = await busApi.getGpsLocationSnapshot(
          token,
          currentPreview || currentBusNo,
        );
        if (disposed || requestId !== reconnectRequestRef.current) return;
        const currentSelectionKey = getSelectedKey();
        if (selectedKey !== currentSelectionKey) return;
        const reconciliation = reconcileGpsSnapshot(
          selectedKey,
          data,
          snapshotGeneration,
        );
        if (!reconciliation.accepted) {
          recoveryAttempt = 0;
          return;
        }

        const reconciledData = reconciliation.location;
        const nextBusData = {
          ...reconciledData,
          busNo:
            reconciledData.busNo ||
            reconciledData.bus_no ||
            selectedBusNoRef.current ||
            currentPreview,
          previewNumber:
            reconciledData.previewNumber ||
            selectedPreviewNumberRef.current ||
            busDataRef.current?.previewNumber,
        };
        const inactive =
          nextBusData.isBusActiveInCurrentPlan === false ||
          !!nextBusData.notActiveMessage;
        const live =
          !inactive &&
          hasValidGpsCoordinates(nextBusData) &&
          !isGpsStale(nextBusData);
        nextBusData._isOffline = !live;
        nextBusData._markerStatus = inactive
          ? "inactive"
          : live
            ? "moving"
            : "offline";
        busDataRef.current = nextBusData;
        setBusData(nextBusData);
        setLastGoodLocation(live ? nextBusData : null);
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
        recoveryAttempt = 0;
      } catch (error) {
        if (disposed || requestId !== reconnectRequestRef.current) return;
        console.warn(
          "Could not refresh bus location after socket reconnect:",
          error?.message || error,
        );
        if (!socket.connected) return;
        recoveryAttempt += 1;
        scheduleRecovery();
      } finally {
        recoveryRequestInFlight = false;
        gpsSnapshotRequestInFlightRef.current = false;
      }
    };

    scheduleRecovery = () => {
      if (disposed || !getSelectedKey()) return;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(
        () => {
          recoveryTimer = null;
          void refreshLocation();
        },
        getSocketRecoveryDelay(recoveryAttempt),
      );
    };

    const handleConnect = () => {
      if (!hasConnected) {
        hasConnected = true;
        return;
      }
      scheduleRecovery();
    };

    const unsubscribeConnect = subscribeSocketEvent(
      socket,
      "connect",
      handleConnect,
    );
    return () => {
      disposed = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      reconnectRequestRef.current += 1;
      unsubscribeConnect();
    };
  }, [
    socket,
    token,
    isFocused,
    appIsActive,
    selectedBusNo,
    selectedPreviewNumber,
  ]);

  useEffect(() => {
    if (!socket || !user?.id) return;
    const handleNotification = (notification) => {
      setUnreadNotifications((count) => count + 1);
      return;
      if (notification?.type === "plan_changed" && user?.bus_no) {
        const assignedBusNo = String(user.bus_no).toUpperCase();
        selectedBusNoRef.current = assignedBusNo;
        selectedPreviewNumberRef.current = null;
        const selectionKey = selectGpsTarget(assignedBusNo, null);
        const snapshotGeneration = beginGpsSnapshot(selectionKey);
        setSelectedBusNo(assignedBusNo);
        setSelectedPreviewNumber(null);
        setTrackingError(null);
        setLocationStatus("loading");
        Promise.all([
          busApi.getBusLocation(token, assignedBusNo),
          busApi.getBusRoutes(token, assignedBusNo),
        ])
          .then(([nextBus, nextRoutes]) => {
            const reconciliation = reconcileGpsSnapshot(
              selectionKey,
              nextBus,
              snapshotGeneration,
            );
            if (!reconciliation.accepted) return;
            const reconciledBus = reconciliation.location;
            const inactive =
              reconciledBus?.isBusActiveInCurrentPlan === false ||
              Boolean(reconciledBus?.notActiveMessage);
            const offline =
              inactive ||
              !hasValidGpsCoordinates(reconciledBus) ||
              isGpsStale(reconciledBus);
            setBusData(reconciledBus);
            setLastGoodLocation(reconciledBus);
            setRoutesData(nextRoutes);
            setIsBusFound(true);
            setIsOffline(offline);
            setLocationStatus(offline ? "offline" : "live");
            setMarkerStatus(inactive ? "inactive" : offline ? "offline" : "moving");
            setTrackingError(
              inactive
                ? reconciledBus?.notActiveMessage || "Your bus is inactive for today's service."
                : null,
            );
          })
          .catch((error) => {
            console.error("Failed to refresh bus after service change:", error);
            if (error?.status === 404) {
              setBusData(null);
              setLastGoodLocation(null);
              setRoutesData(null);
              setIsBusFound(false);
              setIsOffline(true);
              setLocationStatus("offline");
              setMarkerStatus("inactive");
              setTrackingError(
                `Your assigned bus ${assignedBusNo} is no longer available. It is inactive for today's service; contact the Super Admin for assistance.`,
              );
            } else {
              setTrackingError(getErrorMessage(error, "Could not refresh your bus after the plan change."));
            }
          });
      }
      const busChangeTypes = [
        "bus_altered",
        "bus_combined",
        "bus_reassigned",
        "bus_unassigned",
        "bus_change_rolled_back",
      ];
      if (busChangeTypes.includes(notification?.type) && user) {
        const isUnassigned = notification.type === "bus_unassigned";
        const assignmentBusNo = isUnassigned
          ? null
          : notification.assignmentBusNo ||
            (notification.type === "bus_combined"
              ? notification.newPreview
              : user.bus_no);
        const assignmentChanged = [
          "bus_combined",
          "bus_reassigned",
          "bus_unassigned",
          "bus_change_rolled_back",
        ].includes(notification.type);

        if (assignmentChanged) {
          updateUserData({
            ...user,
            bus_no: assignmentBusNo ? String(assignmentBusNo) : null,
            ...(isUnassigned
              ? { previewNumber: null, preview_number: null }
              : notification.newPreview
                ? { previewNumber: notification.newPreview }
                : {}),
          });
        }

        if (isUnassigned) {
          gpsReconcilerRef.current.invalidate();
          gpsSelectionKeyRef.current = null;
          selectedBusNoRef.current = null;
          selectedPreviewNumberRef.current = null;
          latestGpsOrderRef.current = getLocationOrder(null);
          setSelectedBusNo(null);
          setSelectedPreviewNumber(null);
          setBusData(null);
          setLastGoodLocation(null);
          setRoutesData(null);
          setIsBusFound(false);
          setIsOffline(false);
          setLocationStatus("idle");
          setTrackingError(null);
          setSearchQuery("");
          return;
        }

        const busNoToRefresh = String(
          assignmentChanged ? assignmentBusNo : user.bus_no || "",
        ).trim();
        if (busNoToRefresh) {
          selectedBusNoRef.current = busNoToRefresh;
          selectedPreviewNumberRef.current = null;
          busDataRef.current = null;
          const selectionKey = selectGpsTarget(busNoToRefresh, null);
          const snapshotGeneration = beginGpsSnapshot(selectionKey);
          setSelectedBusNo(busNoToRefresh);
          setSelectedPreviewNumber(null);
          setSearchQuery(
            String(notification.newPreview || busNoToRefresh),
          );
          setTrackingError(null);
          setLocationStatus("loading");
          Promise.all([
            busApi.getBusLocation(token, busNoToRefresh),
            busApi.getBusRoutes(token, busNoToRefresh),
          ])
            .then(([nextBus, nextRoutes]) => {
              const reconciliation = reconcileGpsSnapshot(
                selectionKey,
                nextBus,
                snapshotGeneration,
              );
              if (!reconciliation.accepted) return;
              const reconciledBus = reconciliation.location;
              const isOffline =
                !hasValidGpsCoordinates(reconciledBus) || isGpsStale(reconciledBus);
              setBusData({
                ...reconciledBus,
                _isOffline: isOffline,
                _markerStatus: isOffline ? "offline" : "moving",
              });
              setLastGoodLocation(reconciledBus);
              setRoutesData(nextRoutes);
              setIsBusFound(true);
              setIsOffline(isOffline);
              setLocationStatus(isOffline ? "offline" : "live");
              setTrackingError(null);
            })
            .catch((error) =>
              console.error("Failed to refresh bus after temporary change:", error),
            );
        }
      }
    };
    return subscribeSocketEvent(socket, "notification", handleNotification);
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
      if (!isFleetAdmin) return;
      if (!["PLAN_CHANGED", "PLAN_MAPPING_CHANGED", "BUS_ALTERED", "BUS_COMBINED"].includes(data?.actionType)) return;
      const identifier = selectedPreviewNumber || selectedBusNo || user?.bus_no;
      if (!identifier) return;
      const selectionKey = selectGpsTarget(
        selectedBusNoRef.current || identifier,
        selectedPreviewNumberRef.current,
      );
      const snapshotGeneration = beginGpsSnapshot(selectionKey);
      busApi
        .getBusLocation(token, identifier)
        .then((nextBusData) => {
          const reconciliation = reconcileGpsSnapshot(
            selectionKey,
            nextBusData,
            snapshotGeneration,
          );
          if (!reconciliation.accepted) return;
          const reconciledBusData = reconciliation.location;
          setBusData(reconciledBusData);
          setLastGoodLocation(reconciledBusData);
          const inactive =
            reconciledBusData?.isBusActiveInCurrentPlan === false ||
            Boolean(reconciledBusData?.notActiveMessage);
          setTrackingError(
            inactive
              ? reconciledBusData?.notActiveMessage || "Your bus is inactive for today's service."
              : null,
          );
          setMarkerStatus(inactive ? "inactive" : "moving");
          const offline =
            inactive ||
            !hasValidGpsCoordinates(reconciledBusData) ||
            isGpsStale(reconciledBusData);
          setIsOffline(offline);
          setLocationStatus(offline ? "offline" : "live");
        })
        .catch((error) => {
          console.error("Failed to refresh assigned bus:", error);
          if (error?.status === 404 && user?.bus_no) {
            setBusData(null);
            setLastGoodLocation(null);
            setRoutesData(null);
            setIsBusFound(false);
            setIsOffline(true);
            setLocationStatus("offline");
            setMarkerStatus("inactive");
            setTrackingError(
              `Your assigned bus ${user.bus_no} is no longer available. It is inactive for today's service; contact the Super Admin for assistance.`,
            );
          }
        });
      busApi
        .getBusRoutes(token, identifier)
        .then(setRoutesData)
        .catch((error) => console.error("Failed to refresh bus stops:", error));
    };
    return subscribeSocketEvent(socket, "bus-update", handleBusUpdate);
  }, [
    socket,
    token,
    selectedBusNo,
    selectedPreviewNumber,
    user?.bus_no,
    isFleetAdmin,
  ]);

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
    if (!isFleetAdmin) return;
    const query = searchQuery.trim();
    if (!query) return;
    reconnectRequestRef.current += 1;
    const isPreviewSearch = /^\d+$/.test(query);
    busDataRef.current = null;
    selectedPreviewNumberRef.current = isPreviewSearch ? query : null;
    selectedBusNoRef.current = isPreviewSearch ? null : query.toUpperCase();
    const selectionKey = selectGpsTarget(
      selectedBusNoRef.current,
      selectedPreviewNumberRef.current,
    );
    const snapshotGeneration = beginGpsSnapshot(selectionKey);

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
        const snapshot = await busApi.trackByPreview(token, query);

        if (currentSearch !== searchCounterRef.current) return;
        const reconciliation = reconcileGpsSnapshot(
          selectionKey,
          snapshot,
          snapshotGeneration,
        );
        if (!reconciliation.accepted) return;
        const reconciledData = reconciliation.location;
        setTrackingError(null);

        if (
          !reconciledData ||
          reconciledData.error ||
          !(reconciledData.busNo || reconciledData.bus_no)
        ) {
          throw new Error(
            reconciledData?.error || "No bus found for this preview number",
          );
        }
        const data = reconciledData;
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

        const hasPreviewCoords = hasValidGpsCoordinates(data);

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
        if (hasKnownLocationOrder(latestGpsOrderRef.current)) return;
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
        const snapshot = await busApi.getBusLocation(token, busNo);

        if (currentSearch !== searchCounterRef.current) return;
        const reconciliation = reconcileGpsSnapshot(
          selectionKey,
          snapshot,
          snapshotGeneration,
        );
        if (!reconciliation.accepted) return;
        const data = reconciliation.location;
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

        if (hasValidGpsCoordinates(data)) {
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
        if (hasKnownLocationOrder(latestGpsOrderRef.current)) return;
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
    if (!isFleetAdmin) return;
    searchCounterRef.current += 1;
    reconnectRequestRef.current += 1;
    gpsReconcilerRef.current.invalidate();
    gpsSelectionKeyRef.current = null;
    latestGpsOrderRef.current = getLocationOrder(null);
    setSearchQuery("");
    setNoBusFound(false);
    setTrackingError(null);
    setLocationStatus("idle");
    setIsBusSearchAttempted(false);
    setSelectedPreviewNumber(null);
    selectedPreviewNumberRef.current = null;
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
  }, [closeAllOverlayPanels, isFleetAdmin]);

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
    previewNumber: assignment
      ? assignment.previewNumber
      : user?.previewNumber ?? user?.preview_number,
    busNo: assignment ? assignment.busNo : user?.bus_no,
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
                          ? "no bus assigned — contact administration"
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
                      ? "No bus is assigned to you. Please contact administration for assistance."
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
    justifyContent: "flex-end",
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
