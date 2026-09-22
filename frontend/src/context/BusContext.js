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
} from "react";
import io from "socket.io-client";
import { API_BASE_URL } from "../api/api";
import { useAuth } from "./AuthContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { isNetworkError, getErrorMessage } from "../utils/errorHandler";

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
  selectedPlan: "PLAN A", // Default plan
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
    case "UPDATE_BUS_STATUS":
      return {
        ...state,
        buses: state.buses.map((bus) =>
          // Match and update by previewNumber (privacy: internal bus_no is not exposed to clients)
          bus.previewNumber && action.payload.previewNumber && (
            String(bus.previewNumber) === String(action.payload.previewNumber)
          )
            ? { ...bus, ...action.payload }
            : bus,
        ),
        selectedBus:
          state.selectedBus && state.selectedBus.previewNumber && action.payload.previewNumber && String(state.selectedBus.previewNumber) === String(action.payload.previewNumber)
                ? { ...state.selectedBus, ...action.payload }
                : state.selectedBus,
      };
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
    case "SET_SELECTED_PLAN":
      return { ...state, selectedPlan: action.payload };
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
      // Disconnect socket if token is cleared
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    // Connect to the root namespace — backend socket.io serves only "/".
    // Backend uses `path: "/socket.io"` (no trailing slash).
    const newSocket = io(`${API_BASE_URL}`, {
      path: "/socket.io",
      transports: ["websocket"],

      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    newSocket.on("connect", () => {
      if (requestGenerationRef.current === 0 || !token) return;
      console.log("BusContext socket connected:", newSocket.id);
      setSocket(newSocket);
    });

    newSocket.on("locationUpdate", (data) => {
      dispatch({ type: "UPDATE_BUS_STATUS", payload: data });
    });

    newSocket.on("connect_error", (error) => {
      console.log("BusContext socket connect error:", error.message);
    });

    newSocket.on("bus-update", (data) => {
      console.log("BusContext bus-update:", data);
      dispatch({ type: "UPDATE_BUS_STATUS", payload: data });

      if (data.actionType === "PLAN_CHANGED") {
        refreshBuses();
      }
    });

    // Cleanup: disconnect socket when token changes or component unmounts
    return () => {
      newSocket.removeAllListeners();
      newSocket.disconnect();
    };
  }, [token]);

  const getSocket = () => socket;

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

  const refreshBuses = async () => {
    dispatch({ type: "SET_LOADING", payload: true });
    try {
      const response = await fetch(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};
      if (response.ok) {
        dispatch({ type: "SET_BUSES", payload: data.buses });
        dispatch({ type: "SET_ERROR", payload: null });
        const cacheKey = `buses_${user?.id || user?._id || "anonymous"}`;
        await AsyncStorage.setItem(cacheKey, JSON.stringify(data.buses));
      } else {
        // Non-OK response → surface a descriptive message based on status.
        const err = new Error(
          data.error || `Request failed (${response.status})`,
        );
        err.status = response.status;
        throw err;
      }
    } catch (error) {
      // Network error → clear connection message; otherwise show server message.
      const message = isNetworkError(error)
        ? "Cannot connect to the server. Please check your internet connection."
        : getErrorMessage(error, "Failed to load buses.");
      dispatch({ type: "SET_ERROR", payload: message });
    } finally {
      dispatch({ type: "SET_LOADING", payload: false });
    }
  };

  const selectPreviewBus = async (previewNumber) => {
    dispatch({ type: "SET_LOADING", payload: true });
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/bus/track-by-preview/${previewNumber}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = await response.json();

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

  const setSelectedPlan = (plan) => {
    dispatch({ type: "SET_SELECTED_PLAN", payload: plan });
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
    setSelectedPlan,
    updateLocation,
    getSocket,
  };

  return <BusContext.Provider value={value}>{children}</BusContext.Provider>;
};

export const useBus = () => useContext(BusContext);
