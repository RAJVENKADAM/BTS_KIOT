/**
 * BusContext — Global bus state management with socket.io real-time updates.
 * Provides buses list, selected bus, live location, ETA, plan selection,
 * and socket connection for live tracking updates.
 */
import React, { createContext, useContext, useReducer, useEffect, useState } from 'react';
import io from 'socket.io-client';
import { API_BASE_URL } from '../api/api';
import { useAuth } from './AuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  selectedPlan: 'PLAN A', // Default plan
};

const busReducer = (state, action) => {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload, error: null };
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };
    case 'SET_BUSES':
      return { ...state, buses: action.payload };
    case 'SET_SELECTED_BUS':
      return { ...state, selectedBus: action.payload };
    case 'UPDATE_BUS_STATUS':
      return {
        ...state,
        buses: state.buses.map(bus => 
          (bus.busNo === action.payload.busNo || bus.bus_no === action.payload.busNo) 
            ? { ...bus, ...action.payload } 
            : bus
        ),
        selectedBus: state.selectedBus?.busNo === action.payload.busNo || state.selectedBus?.bus_no === action.payload.busNo
          ? { ...state.selectedBus, ...action.payload } 
          : state.selectedBus,
      };
    case 'SET_SELECTED_PREVIEW':
      return { ...state, selectedPreviewNumber: action.payload };
    case 'SET_LOCATION':
      return { ...state, currentLocation: action.payload };
    case 'SET_ETA':
      return { ...state, etaToUser: action.payload.etaToUser, etaToCollege: action.payload.etaToCollege };
    case 'SET_SELECTED_PLAN':
      return { ...state, selectedPlan: action.payload };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
};

export const BusProvider = ({ children }) => {
  const [state, dispatch] = useReducer(busReducer, initialState);
  const { token } = useAuth();

  // Load cached buses on startup
  useEffect(() => {
    loadBuses();
  }, [token]);

  // Socket connection for real-time updates
  const [socket, setSocket] = useState(null);
  useEffect(() => {
    if (!token) {
      // Disconnect socket if token is cleared
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    // socket.io path must match backend socket.io server config.
    // Backend uses `path: "/socket.io"` (no trailing slash).
    const newSocket = io(`${API_BASE_URL}/bus-location`, { 
      path: '/socket.io',
      transports: ['websocket'],

      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    newSocket.on('connect', () => {
      console.log('BusContext socket connected:', newSocket.id);
      setSocket(newSocket);
    });
    
    newSocket.on('locationUpdate', (data) => {
      dispatch({ type: 'UPDATE_BUS_STATUS', payload: data });
    });

    newSocket.on('connect_error', (error) => {
      console.log('BusContext socket connect error:', error.message);
    });

    newSocket.on('bus-update', (data) => {
      console.log('BusContext bus-update:', data);
      dispatch({ type: 'UPDATE_BUS_STATUS', payload: data });
      
      // Direct plan update if available, plus refresh for robustness
      if (data.actionType === 'PLAN_CHANGED' && data.currentPlan) {
        dispatch({ 
          type: 'UPDATE_BUS_STATUS', 
          payload: { busNo: data.busNo, currentPlan: data.currentPlan } 
        });
      }
      if (data.actionType === 'PLAN_CHANGED') {
        refreshBuses();
      }
    });

    // Cleanup: disconnect socket when token changes or component unmounts
    return () => {
      if (newSocket && newSocket.connected) {
        newSocket.disconnect();
      }
    };
  }, [token]);

  const getSocket = () => socket;

  const loadBuses = async () => {
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const cached = await AsyncStorage.getItem('buses');
      if (cached) {
        dispatch({ type: 'SET_BUSES', payload: JSON.parse(cached) });
      }
    } catch (err) {
      console.error('Cache load error:', err);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const refreshBuses = async () => {
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const response = await fetch(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok) {
        dispatch({ type: 'SET_BUSES', payload: data.buses });
        await AsyncStorage.setItem('buses', JSON.stringify(data.buses));
      }
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error.message });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const selectPreviewBus = async (previewNumber) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const response = await fetch(`${API_BASE_URL}/api/bus/track-by-preview/${previewNumber}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      
      const bus = state.buses.find(b => b.previewNumber === previewNumber);
      dispatch({ type: 'SET_SELECTED_PREVIEW', payload: previewNumber });
      dispatch({ type: 'SET_SELECTED_BUS', payload: { previewNumber, busNo: data.busNo || 'Unknown' } });
      await AsyncStorage.setItem('selectedBusPreviewNumber', previewNumber);
      const currentSocket = getSocket();
      if (currentSocket) currentSocket.emit('join-bus', data.busNo);
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error.message });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const selectBus = (busNo) => {
    const bus = state.buses.find(b => b.busNo === busNo);
    dispatch({ type: 'SET_SELECTED_BUS', payload: bus || null });
  };

  const setSelectedPlan = (plan) => {
    dispatch({ type: 'SET_SELECTED_PLAN', payload: plan });
  };

  const updateLocation = (location) => {
    dispatch({ type: 'SET_LOCATION', payload: location });
  };

  // Load persisted selected bus on startup
  useEffect(() => {
    const loadPersistedBus = async () => {
      try {
        const previewNumber = await AsyncStorage.getItem('selectedBusPreviewNumber');
        if (previewNumber && token) {
          selectPreviewBus(previewNumber);
        }
      } catch (error) {
        console.error('Failed to load persisted bus:', error);
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

  return (
    <BusContext.Provider value={value}>
      {children}
    </BusContext.Provider>
  );
};

export const useBus = () => useContext(BusContext);
