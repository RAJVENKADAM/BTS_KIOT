/**
 * BusContext — Global bus state management with socket.io real-time updates.
 * Provides buses list, selected bus, live location, ETA, plan selection,
 * and socket connection for live tracking updates.
 */
import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import io from "socket.io-client";
import { AppState } from "react-native";
import { API_BASE_URL, SOCKET_BASE_URL } from "../api/api";
import { useAuth } from "./AuthContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchJson, getErrorMessage } from "../utils/errorHandler";
const {
  getSocketActionForAppStateChange,
  isPermanentSocketAuthenticationError,
  shouldConnectSocketForAppState,
  SOCKET_RECONNECTION_ATTEMPTS,
  SOCKET_RECONNECTION_DELAY_MS,
  SOCKET_RECONNECTION_MAX_DELAY_MS,
  SOCKET_RECONNECTION_RANDOMIZATION_FACTOR,
  shouldReconnectAfterServerDisconnect,
} = require("../utils/socketConnectionPolicy.cjs");
const { logSocketDiagnostic } = require("../utils/socketDiagnostics.cjs");

const BusContext = createContext();

const initialState = {
  buses: [],
  selectedPreviewNumber: null,
  selectedBus: null,
  currentLocation: null,
  etaToUser: null,
  etaToCollege: null,
  loading: false,
  error: null,
};

const busReducer = (state, action) => {
  switch (action.type) {
    case "RESET":
      return initialState;
    case "SET_LOADING":
      return { ...state, loading: action.payload, error: null };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "SET_BUSES":
      return { ...state, buses: action.payload };
    case "SET_SELECTED_BUS":
      return { ...state, selectedBus: action.payload };
    case "SET_SELECTED_PREVIEW":
      return { ...state, selectedPreviewNumber: action.payload };
    case "SET_LOCATION":
      return { ...state, currentLocation: action.payload };
    case "SET_ETA":
      return {
        ...state,
        etaToUser: action.payload.etaToUser,
        etaToCollege: action.payload.etaToCollege,
      };
    case "RESET":
      return initialState;
    default:
      return state;
  }
};

export const BusProvider = ({ children }) => {
  const [state, dispatch] = useReducer(busReducer, initialState);
  const { token, user } = useAuth();
  const requestGenerationRef = React.useRef(0);
  const appStateRef = useRef(AppState.currentState || "active");

  const refreshBuses = useCallback(async () => {
    dispatch({ type: "SET_LOADING", payload: true });
    try {
      const data = await fetchJson(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      dispatch({ type: "SET_BUSES", payload: data.buses });
      dispatch({ type: "SET_ERROR", payload: null });
      const cacheKey = `buses_${user?.id || user?._id || "anonymous"}`;
      await AsyncStorage.setItem(cacheKey, JSON.stringify(data.buses));
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        payload: getErrorMessage(error, "Could not load buses."),
      });
    } finally {
      dispatch({ type: "SET_LOADING", payload: false });
    }
  }, [token, user?.id, user?._id]);

  // Load cached buses on startup
  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    loadBuses();
    return () => {
      if (generation === requestGenerationRef.current) requestGenerationRef.current += 1;
    };
  }, [token]);

  // Socket connection for real-time updates
  const [socket, setSocket] = useState(null);
  useEffect(() => {
    if (!token) {
      AsyncStorage.multiRemove(["buses", "selectedBusPreviewNumber"]).catch(() => {});
      dispatch({ type: "RESET" });
      setSocket(null);
      return;
    }

    setSocket(null);
    let disposed = false;
    let authenticationRejected = false;
    let wasConnected = false;
    let hasConnectedOnce = false;
    let lastDisconnectWasConnected = null;
    let diagnosticSocketId = null;
    let manualReconnectAttemptNumber = 0;
    let pendingManualReconnectAttempt = null;
    const observedEngines = new Map();
    // Connect to the root namespace — backend socket.io serves only "/".
    // Backend uses `path: "/socket.io"` (no trailing slash).
    const newSocket = io(`${SOCKET_BASE_URL}`, {
      path: "/socket.io",
      transports: ["websocket"],
      autoConnect: shouldConnectSocketForAppState(appStateRef.current),
      auth: { token },
      reconnection: true,
      reconnectionAttempts: SOCKET_RECONNECTION_ATTEMPTS,
      reconnectionDelay: SOCKET_RECONNECTION_DELAY_MS,
      reconnectionDelayMax: SOCKET_RECONNECTION_MAX_DELAY_MS,
      randomizationFactor: SOCKET_RECONNECTION_RANDOMIZATION_FACTOR,
    });

    const logDiagnostic = (event, details = {}) =>
      logSocketDiagnostic(event, newSocket, {
        socketId: diagnosticSocketId,
        ...details,
      });

    const attachEngineDiagnostics = () => {
      const engine = newSocket.io.engine;
      if (!engine || observedEngines.has(engine)) return;
      diagnosticSocketId = newSocket.id || engine.id || diagnosticSocketId;
      const handleEngineClose = (reason, description) => {
        logDiagnostic("client-engine-closed", {
          disconnectReason: reason,
          disconnectDescription: description,
          transportType: engine.transport?.name,
          wasConnected: lastDisconnectWasConnected ?? wasConnected,
          reconnectionAttempted: newSocket.active,
          reconnectionAttemptNumber: manualReconnectAttemptNumber || null,
          reconnectionResult: newSocket.active ? "pending" : null,
        });
      };
      observedEngines.set(engine, handleEngineClose);
      engine.on("close", handleEngineClose);
    };
    const handleManagerOpen = () => attachEngineDiagnostics();
    newSocket.io.on("open", handleManagerOpen);

    const startManualReconnect = (trigger) => {
      manualReconnectAttemptNumber += 1;
      pendingManualReconnectAttempt = manualReconnectAttemptNumber;
      logDiagnostic("client-reconnection-attempt", {
        disconnectReason:
          trigger === "io server disconnect" ? trigger : null,
        reconnectionTrigger:
          trigger === "io server disconnect"
            ? "server-disconnect"
            : "app-foreground",
        wasConnected,
        reconnectionAttempted: true,
        reconnectionAttemptNumber: manualReconnectAttemptNumber,
        reconnectionResult: "pending",
      });
    };

    newSocket.on("connect", () => {
      const isReconnect = hasConnectedOnce;
      wasConnected = true;
      lastDisconnectWasConnected = null;
      diagnosticSocketId =
        newSocket.id || newSocket.io.engine?.id || diagnosticSocketId;
      attachEngineDiagnostics();
      logDiagnostic("client-connected", {
        wasConnected: isReconnect,
        reconnectionAttempted: isReconnect,
        reconnectionAttemptNumber:
          pendingManualReconnectAttempt || manualReconnectAttemptNumber || null,
        reconnectionResult: isReconnect ? "success" : null,
      });
      pendingManualReconnectAttempt = null;
      hasConnectedOnce = true;
      if (disposed || requestGenerationRef.current === 0 || !token) return;
      setSocket(newSocket);
    });

    newSocket.on("connect_error", (error) => {
      logDiagnostic("client-connect-error", {
        disconnectDescription: error,
        wasConnected,
        reconnectionAttempted: hasConnectedOnce || newSocket.active,
        reconnectionAttemptNumber:
          pendingManualReconnectAttempt || manualReconnectAttemptNumber || null,
        reconnectionResult: "failed",
      });
      if (isPermanentSocketAuthenticationError(error)) {
        authenticationRejected = true;
        newSocket.io.reconnection(false);
      }
    });

    newSocket.on("disconnect", (reason, description) => {
      const willManuallyReconnect =
        !disposed &&
        !authenticationRejected &&
        shouldConnectSocketForAppState(appStateRef.current) &&
        shouldReconnectAfterServerDisconnect(reason) &&
        Boolean(token);
      const willManagerReconnect =
        wasConnected &&
        reason !== "io client disconnect" &&
        reason !== "io server disconnect" &&
        !authenticationRejected;
      logDiagnostic("client-disconnected", {
        disconnectReason: reason,
        disconnectDescription: description,
        wasConnected,
        reconnectionAttempted: willManuallyReconnect || willManagerReconnect,
        reconnectionAttemptNumber:
          pendingManualReconnectAttempt || manualReconnectAttemptNumber || null,
        reconnectionResult:
          willManuallyReconnect || willManagerReconnect ? "pending" : null,
      });
      lastDisconnectWasConnected = wasConnected;
      wasConnected = false;
      if (willManuallyReconnect) {
        startManualReconnect(reason);
        newSocket.connect();
      }
    });

    const handleManagerReconnectAttempt = (attempt) => {
      logDiagnostic("client-manager-reconnect-attempt", {
        wasConnected,
        reconnectionAttempted: true,
        reconnectionAttemptNumber: attempt,
        reconnectionResult: "pending",
      });
    };
    const handleManagerReconnect = (attempt) => {
      logDiagnostic("client-manager-reconnected", {
        wasConnected,
        reconnectionAttempted: true,
        reconnectionAttemptNumber: attempt,
        reconnectionResult: "success",
      });
    };
    const handleManagerReconnectError = (error) => {
      logDiagnostic("client-manager-reconnect-error", {
        disconnectDescription: error,
        wasConnected,
        reconnectionAttempted: true,
        reconnectionAttemptNumber: manualReconnectAttemptNumber || null,
        reconnectionResult: "failed",
      });
    };
    const handleManagerReconnectFailed = () => {
      logDiagnostic("client-manager-reconnect-failed", {
        wasConnected,
        reconnectionAttempted: true,
        reconnectionAttemptNumber: SOCKET_RECONNECTION_ATTEMPTS,
        reconnectionResult: "failed",
      });
    };
    newSocket.io.on("reconnect_attempt", handleManagerReconnectAttempt);
    newSocket.io.on("reconnect", handleManagerReconnect);
    newSocket.io.on("reconnect_error", handleManagerReconnectError);
    newSocket.io.on("reconnect_failed", handleManagerReconnectFailed);

    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextAppState) => {
        const previousAppState = appStateRef.current;
        const action = getSocketActionForAppStateChange({
          previousAppState,
          nextAppState,
          socketConnected: newSocket.connected,
          authenticationRejected,
        });
        appStateRef.current = nextAppState;
        if (action === "disconnect") {
          logDiagnostic("client-app-state-disconnect-requested", {
            disconnectReason: "io client disconnect",
            wasConnected: newSocket.connected,
            reconnectionAttempted: false,
          });
          newSocket.disconnect();
        }
        if (action === "connect") {
          newSocket.io.reconnection(true);
          startManualReconnect(`app-state ${previousAppState} to ${nextAppState}`);
          newSocket.connect();
        }
      },
    );

    newSocket.on("bus-update", (data) => {
      if (data.actionType === "PLAN_CHANGED") {
        refreshBuses();
      }
    });

    // Cleanup: disconnect socket when token changes or component unmounts
    return () => {
      disposed = true;
      appStateSubscription.remove();
      logDiagnostic("client-cleanup-disconnect-requested", {
        disconnectReason: "io client disconnect",
        wasConnected: newSocket.connected,
        reconnectionAttempted: false,
      });
      newSocket.io.off("open", handleManagerOpen);
      newSocket.io.off("reconnect_attempt", handleManagerReconnectAttempt);
      newSocket.io.off("reconnect", handleManagerReconnect);
      newSocket.io.off("reconnect_error", handleManagerReconnectError);
      newSocket.io.off("reconnect_failed", handleManagerReconnectFailed);
      for (const [engine, handleEngineClose] of observedEngines) {
        engine.off("close", handleEngineClose);
      }
      observedEngines.clear();
      newSocket.removeAllListeners();
      newSocket.disconnect();
    };
  }, [token, refreshBuses]);

  const getSocket = useCallback(() => socket, [socket]);

  const loadBuses = async () => {
    dispatch({ type: "SET_LOADING", payload: true });
    try {
      const cacheKey = `buses_${user?.id || user?._id || "anonymous"}`;
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        dispatch({ type: "SET_BUSES", payload: JSON.parse(cached) });
      }
    } catch (err) {
      console.error("Cache load error:", err);
    } finally {
      dispatch({ type: "SET_LOADING", payload: false });
    }
  };

  const selectPreviewBus = async (previewNumber) => {
    dispatch({ type: "SET_LOADING", payload: true });
    try {
      await fetchJson(
        `${API_BASE_URL}/api/bus/track-by-preview/${previewNumber}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const bus = state.buses.find((b) => b.previewNumber === previewNumber);
      dispatch({ type: "SET_SELECTED_PREVIEW", payload: previewNumber });
      dispatch({
        type: "SET_SELECTED_BUS",
        payload: { previewNumber, bus: bus || null },
      });
      const cacheKey = `selectedBusPreviewNumber_${user?.id || user?._id || "anonymous"}`;
      await AsyncStorage.setItem(cacheKey, previewNumber);
      const currentSocket = getSocket();
      // Join the preview-based socket room (privacy-preserving)
      if (currentSocket) currentSocket.emit("join-bus", previewNumber);
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        payload: getErrorMessage(
          error,
          "Could not track the selected bus. Please try again.",
        ),
      });
    } finally {
      dispatch({ type: "SET_LOADING", payload: false });
    }
  };

  const selectBus = (busNo) => {
    const bus = state.buses.find((b) => b.busNo === busNo);
    dispatch({ type: "SET_SELECTED_BUS", payload: bus || null });
  };

  const updateLocation = (location) => {
    dispatch({ type: "SET_LOCATION", payload: location });
  };

  // Load persisted selected bus on startup
  useEffect(() => {
    const loadPersistedBus = async () => {
      try {
        const previewNumber = await AsyncStorage.getItem(
          `selectedBusPreviewNumber_${user?.id || user?._id || "anonymous"}`,
        );
        if (previewNumber && token) {
          selectPreviewBus(previewNumber);
        }
      } catch (error) {
        console.error("Failed to load persisted bus:", error);
      }
    };
    loadPersistedBus();
  }, [token]);

  const value = {
    ...state,
    refreshBuses,
    selectPreviewBus,
    selectBus,
    updateLocation,
    getSocket,
  };

  return <BusContext.Provider value={value}>{children}</BusContext.Provider>;
};

export const useBus = () => useContext(BusContext);
