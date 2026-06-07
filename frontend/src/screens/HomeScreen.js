import React, { useState, useRef, useEffect, useCallback } from 'react';
import OSMMap from '../components/Map/OSMMap';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  StatusBar,
  Platform,
  TouchableOpacity,
  Animated,
  Dimensions,
  Modal,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useBus } from '../context/BusContext';
import busApi from '../api/busApi';
import io from 'socket.io-client';
import { COLORS, RADIUS, SHADOWS } from '../theme';
import { useAuth } from '../context/AuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';

const { height } = Dimensions.get('window');

const MIN_HEIGHT = 150;
const MAX_HEIGHT = height * 0.6;

// Stable snap points for gorhom/bottom-sheet
const SNAP_POINTS = ['25%', '50%', '75%'];
// Live updates via socket.io + manual refresh

// KIOT College coordinates
const KIOT_LAT = 11.554528;
const KIOT_LNG = 78.019759;

// Utility functions
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const HomeScreen = () => {
  const { token, user } = useAuth();
  const navigation = useNavigation();
  const role = (user?.role || 'student').toLowerCase();
  const isAdmin = role === 'superadmin';
  const { error, refreshBuses, selectedPlan, setSelectedPlan, buses, getSocket } = useBus();
  const socket = getSocket ? getSocket() : null;

  // If busData doesn't include currentPlan (or is missing), fallback to context selectedPlan
  const effectiveCurrentPlan = displayBusData?.currentPlan || selectedPlan;


  const [searchQuery, setSearchQuery] = useState('');
  const [busData, setBusData] = useState(null);
  const [noBusFound, setNoBusFound] = useState(false);
  const [isBusSearchAttempted, setIsBusSearchAttempted] = useState(false);

  const [selectedPreviewNumber, setSelectedPreviewNumber] = useState(null);
  const [selectedBusNo, setSelectedBusNo] = useState(null);
  const [lastGoodLocation, setLastGoodLocation] = useState(null);
  const [isSuperadminSearched, setIsSuperadminSearched] = useState(false);

  const [locationStatus, setLocationStatus] = useState('idle'); // idle|loading|live|offline|error
  const [markerStatus, setMarkerStatus] = useState('moving'); // moving|waiting|stopped

  const lastCoordinateRef = useRef(null);
  const sameCoordinateCountRef = useRef(0);
  const busStatusRef = useRef('moving');

  // Prevent stale closure for selected bus
  const selectedBusNoRef = useRef(selectedBusNo);
  useEffect(() => {
    selectedBusNoRef.current = selectedBusNo;
  }, [selectedBusNo]);

  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const isDraggingRef = useRef(false);


  const [shouldAutoFocus, setShouldAutoFocus] = useState(false);
  const [showStopsModal, setShowStopsModal] = useState(false);
  const [routeStops, setRouteStops] = useState([]);
  const [loadingStops, setLoadingStops] = useState(false);
  const lastPlanRef = useRef(null);

  // BottomSheet sizing is handled by @gorhom/bottom-sheet.
  // Keep these legacy animated sizing refs removed to avoid flicker/gesture conflicts.






  // IMPORTANT: Do not drive bottom-sheet position from live GPS updates.
  // @gorhom/bottom-sheet already handles gesture + snapping.
  // This screen only changes sheet *content* via state updates.
  useEffect(() => {
    // no-op
  }, [selectedBusNo, busData]);


  // Persist bus data when it changes (but not during loading)
  useEffect(() => {
    const persistBusData = async () => {
      if (locationStatus === 'loading') return; // Don't persist while loading
      
      try {
        if (selectedBusNo) {
          await AsyncStorage.setItem('selectedBusNo', selectedBusNo);
        }
        if (selectedPreviewNumber) {
          await AsyncStorage.setItem('selectedPreviewNumber', selectedPreviewNumber);
        }
        if (busData && locationStatus !== 'error') {
          await AsyncStorage.setItem('savedBusData', JSON.stringify(busData));
        }
      } catch (err) {
        console.log('Error persisting bus data:', err);
      }
    };

    persistBusData();
  }, [selectedBusNo, selectedPreviewNumber, busData, locationStatus]);



  // Auto-load user assigned bus for non-admin users
  useEffect(() => {
    if (user?.bus_no && !isAdmin && !selectedBusNo && !selectedPreviewNumber) {
      setSelectedBusNo(user.bus_no);
      setLocationStatus('loading');
    }
  }, [user, isAdmin, selectedBusNo, selectedPreviewNumber]);

  // Mark superadmin as NOT searched initially; it becomes true only after a successful/attempted search
  useEffect(() => {
    if (isAdmin) setIsSuperadminSearched(false);
  }, [isAdmin]);


  // Join/leave socket room when selectedBusNo changes
  useEffect(() => {
    if (!socket || !selectedBusNo) return;

    console.log('HomeScreen joining bus room:', `bus_${selectedBusNo}`);
    socket.emit('join-bus', selectedBusNo);

    return () => {
      socket.emit('leave-bus', selectedBusNo);
    };
  }, [socket, selectedBusNo]);

  // Socket plan updates (real-time + immutable refresh)
  useEffect(() => {
    if (!socket) return;

    const handleBusUpdate = (data) => {
      if (!data) return;

      const selected = selectedBusNoRef.current;
      if (!selected) return;

      const incomingBusNo = data.busNo ?? data.bus_no ?? data.busNumber;
      if (!incomingBusNo) return;

      if (String(incomingBusNo) !== String(selected)) return;

      const newPlan = data.currentPlan;
      if (!newPlan) return;

      // Prevent redundant rerenders for same plan (but still force on change)
      if (lastPlanRef.current === newPlan) return;
      lastPlanRef.current = newPlan;

      setBusData(prev => {
        // If busData is null/stale, still create a minimal object so the bottom sheet updates.
        if (!prev) {
          return {
            busNo: selected,
            currentPlan: newPlan,
            _updatedAt: Date.now(),
          };
        }

        return {
          ...prev,
          currentPlan: newPlan,
          _updatedAt: Date.now(),
        };
      });
    };



    socket.on('bus-update', handleBusUpdate);
    return () => socket.off('bus-update', handleBusUpdate);
  }, [socket]);


  useEffect(() => {
    refreshBuses();
    
    // Load persisted bus data on app start
    const loadPersistedBusData = async () => {
      try {
        const savedBusNo = await AsyncStorage.getItem('selectedBusNo');
        const savedPreviewNumber = await AsyncStorage.getItem('selectedPreviewNumber');
        const savedBusData = await AsyncStorage.getItem('savedBusData');
        
        if (savedBusNo) {
          setSelectedBusNo(savedBusNo);
        }
        if (savedPreviewNumber) {
          setSelectedPreviewNumber(savedPreviewNumber);
        }
        if (savedBusData) {
          const parsedData = JSON.parse(savedBusData);
          setBusData(parsedData);
          setLastGoodLocation(parsedData);
        }
      } catch (err) {
        console.log('Error loading persisted bus data:', err);
      }
    };

    loadPersistedBusData();

    return () => {
      // No polling to clear
    };
  }, []);


  // Legacy PanResponder block removed (was causing gesture conflicts / flicker).


  const normalizeBusState = (state) => {

    const normalized = typeof state === 'string' ? state.toLowerCase() : '';

    return ['moving', 'stopped'].includes(normalized) ? normalized : null;
  };

  const chooseBusStatus = (apiState, coordinateState) => {
    const normalizedApi = normalizeBusState(apiState);
    if (normalizedApi === 'stopped') {
      return normalizedApi;
    }
    return coordinateState;
  };

  // CORE MOVEMENT RULE ENGINE (Mandatory)
  // WAITING: same coordinate repeats 3 times consecutively
  // STOPPED: same coordinate repeats 10 times consecutively
  // MOVING: next coordinate differs from previous (default fallback)
  // Priority: STOPPED > WAITING > MOVING
  const detectBusStatus = (lat, lng) => {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      return busStatusRef.current || 'moving';
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
    if (count >= 10) {
      nextStatus = 'stopped';
    } else if (count >= 3) {
      nextStatus = 'waiting';
    } else {
      // If coordinate changed, count is 1 => moving
      nextStatus = 'moving';
    }

    busStatusRef.current = nextStatus;
    return nextStatus;
  };


  // Removed polling useEffect - socket + manual refresh only



  // Drag gesture: smooth following finger, then snap based on velocity/distance.
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));


  const handlePlanPress = async () => {
    if (!selectedBusNo && !selectedPreviewNumber) return;
    if (!displayBusData?.currentPlan) return;

    // This build does not yet include a backend endpoint to fetch stops by bus+plan.
    // Once added, wire it here to populate `routeStops` and show `showStopsModal`.
    Alert.alert(
      'Route Stops',
      `Stops for bus ${selectedBusNo || selectedPreviewNumber} (plan: "${displayBusData.currentPlan}") require a backend stops-by-bus+plan endpoint.`
    );
  };




  // Refresh current bus location (immediate fetch + continue polling)
  const handleRefresh = useCallback(async () => {
    if (!selectedBusNo && !selectedPreviewNumber) return;
    
    setLocationStatus('loading');
    
    try {
      let data;
      if (selectedPreviewNumber) {
        data = await busApi.trackByPreview(token, selectedPreviewNumber);
      } else {
        data = await busApi.getBusLocation(token, selectedBusNo);
      }
      
      if (data && data.latitude !== null && data.longitude !== null) {
        const nextBusData = { ...data, source: data.source || 'gps' };
        setBusData(nextBusData);
        setLastGoodLocation(nextBusData);

        setLocationStatus(data.isStale ? 'stale' : 'live');
        setNoBusFound(false);
        setShouldAutoFocus(true);
        
        const statusFromAPI = data.busState;
        const statusFromCoordinates = detectBusStatus(data.latitude, data.longitude);
        setMarkerStatus(chooseBusStatus(statusFromAPI, statusFromCoordinates));
      } else {
        // Strict: if refresh fails for the current selected bus, show KIOT only.
        setBusData(null);
        setLastGoodLocation(null);
        setLocationStatus('error');
        setNoBusFound(true);
      }

    } catch (err) {
      console.log('Refresh error:', err.message);
      if (!lastGoodLocation) {
        setLocationStatus('error');
        setNoBusFound(true);
      } else {
        setBusData(lastGoodLocation);
        setLocationStatus('offline');
      }
    }
    
    // Refresh bus list in context (for admin list)
    await refreshBuses();
  }, [selectedBusNo, selectedPreviewNumber, token, lastGoodLocation, refreshBuses]);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;

    const isPreviewSearch = /^\d{3,7}$/.test(query);
    setSearchQuery('');
    setNoBusFound(false);
    setLocationStatus('loading');

    // mark search attempted so sheet can show correct empty/error state
    setIsBusSearchAttempted(true);

    // For superadmin: once they search (success or failure), keep strict focus on that outcome
    if (isAdmin) setIsSuperadminSearched(true);



    if (isPreviewSearch) {
      setSelectedPreviewNumber(query);
      setShouldAutoFocus(true);
      try {
        const data = await busApi.trackByPreview(token, query);

        if (!data || data.error || data.latitude == null || data.longitude == null) {
          throw new Error(data?.error || 'No live data for this preview number');
        }

        const nextBusNo = data.busNo || data.bus_no || null;
        setSelectedBusNo(nextBusNo);
        
        // Reset coordinate tracking for new search
        sameCoordinateCountRef.current = 0;
        lastCoordinateRef.current = null;

        
        const nextBusData = {
          ...data,
          previewNumber: query,
          busNo: nextBusNo,
        };
        setBusData(nextBusData);
        setLastGoodLocation(nextBusData);
        setLocationStatus('live');
        
        const statusFromAPI = data.busState;
        const statusFromCoordinates = detectBusStatus(data.latitude, data.longitude);
        setMarkerStatus(chooseBusStatus(statusFromAPI, statusFromCoordinates) || 'moving');
      } catch (err) {
        console.log('Preview search error:', err.message);
        // Strict: clear any previous bus location
        setSelectedBusNo(null);
        setSelectedPreviewNumber(null);
        setBusData(null);
        setLastGoodLocation(null);
        setLocationStatus('error');
        setNoBusFound(true);
      }

    } else {
      // Bus number search - immediately fetch data
      const busNo = query.toUpperCase();
      
      // Check if we're searching for the same bus
      const isSameBus = selectedBusNo === busNo;
      
      setSelectedPreviewNumber(null);
      setSelectedBusNo(busNo);
      setShouldAutoFocus(true);
      
      // Reset coordinate tracking for new search
      sameCoordinateCountRef.current = 0;
      lastCoordinateRef.current = null;
      
      // If it's the same bus and we have good data, don't reset everything
      if (!isSameBus) {
        setBusData(null);
        setLastGoodLocation(null);
      }

      
      try {
        const data = await busApi.getBusLocation(token, busNo);

      if (data && data.latitude !== null && data.longitude !== null) {
          const nextBusData = {
            ...data,
            source: data.source || 'gps'
          };
          setBusData(nextBusData);
          setLastGoodLocation(nextBusData);

          setLocationStatus(data.isStale ? 'stale' : 'live');
          
          const statusFromAPI = data.busState;
          const statusFromCoordinates = detectBusStatus(data.latitude, data.longitude);
          setMarkerStatus(chooseBusStatus(statusFromAPI, statusFromCoordinates) || 'moving');
        } else {
          console.log('No valid location for bus search:', data);
          // Strict: clear any previous bus location and show KIOT
          setBusData(null);
          setLastGoodLocation(null);
          setLocationStatus('error');
          setNoBusFound(true);
        }
      } catch (err) {
        console.log('Bus search error:', err.message);
        // Strict: clear any previous bus location and show KIOT
        setBusData(null);
        setLastGoodLocation(null);
        setLocationStatus('error');
        setNoBusFound(true);
      }

    }
  };


  // Strict display rules:
  // - Non-admin: always show only their assigned bus (never fall back to other buses).
  // - Superadmin: if they searched at least once, show only the searched bus (or KIOT if not found).
  // - Never reuse lastGoodLocation to “hide” not-found/bad searches.
  const shouldShowBusMarker = (() => {
    if (!isAdmin) return !!selectedBusNo || !!selectedPreviewNumber;
    return isSuperadminSearched && (!!selectedBusNo || !!selectedPreviewNumber);
  })();

  const displayBusData = shouldShowBusMarker ? busData : null;
  const displayBusLabel = selectedPreviewNumber || selectedBusNo || displayBusData?.busNo;


  // Memoized bus card to prevent flicker (distance only, no ETA)
  const busCardContent = React.useMemo(() => {
    if (!displayBusData) return null;

    const distance = calculateDistance(displayBusData.latitude, displayBusData.longitude, KIOT_LAT, KIOT_LNG);

    return (
      <View style={styles.busCard}>
        <View style={styles.cardHeader}>
          <Text style={styles.busNumber}>Bus {displayBusLabel}</Text>
          <View style={[styles.statusBadge, 
            markerStatus === 'moving' && styles.movingBadge,
            markerStatus === 'stopped' && styles.stoppedBadge
          ]}>
            <Text style={styles.badgeText}>{markerStatus.toUpperCase()}</Text>
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
  }, [displayBusData, displayBusLabel, markerStatus]);

  return (
    <View style={styles.container}>
      <StatusBar translucent backgroundColor="transparent" barStyle="dark-content" />

      {/* MAP */}
      <View style={styles.mapBackground}>
        <OSMMap busData={displayBusData} buses={[]} />
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
        <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearButton}>
          <Ionicons name="close-circle" size={18} color={COLORS.textBody} />
        </TouchableOpacity>
      ) : null}
    </View>

    
    {/* RIGHT ICONS */}
    <View style={styles.rightIcons}>
  
  {isAdmin && (
    <TouchableOpacity
      style={styles.organizeButton}
      onPress={() => navigation.navigate('Organize')}
      activeOpacity={0.7}
    >
      <Text style={styles.organizeText}>Organize</Text>
    </TouchableOpacity>
  )}

  <TouchableOpacity
    style={styles.iconButtonPrimary}
    onPress={() => navigation.navigate('Profile')}
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
        topInset={150}
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
                  ? 'search for bus to view time location'
                  : user?.bus_no
                    ? `tracking your bus ${user.bus_no}`
                    : 'no bus assigned'}
              </Text>
            </View>
          </View>

          <View style={styles.content}>
            {error ? (
              <Text style={[styles.infoText, styles.errorText]}>{error}</Text>
            ) : noBusFound ? (
              <Text style={[styles.infoText, styles.errorText]}>Bus not found</Text>
            ) : isBusSearchAttempted && !displayBusData ? (
              <Text style={[styles.infoText, styles.errorText]}>Bus not found</Text>
            ) : !selectedBusNo && !selectedPreviewNumber ? (
              <Text style={styles.infoText}>
                {isAdmin
                  ? 'Search any bus to track its live location.'
                  : user?.bus_no
                    ? `Tracking your bus ${user.bus_no}...`
                    : 'No bus assigned'}
              </Text>
            ) : displayBusData ? (
              <>
                {busCardContent}

                

              </>
            ) : locationStatus === 'loading' ? (
              <Text style={styles.infoText}>Loading live location...</Text>
            ) : (
              <Text style={styles.infoText}>No location data available</Text>
            )}
          </View>

          <View style={styles.modalButtonContainer} />
        </BottomSheetView>
      </BottomSheet>

      {/* STOPS MODAL */}
      <Modal visible={showStopsModal} transparent animationType="slide">
        <TouchableOpacity 
          style={styles.modalOverlay} 
          activeOpacity={1}
          onPress={() => setShowStopsModal(false)}
        >
          <View style={styles.stopsModal}>
            <Text style={styles.stopsTitle}>{displayBusData?.currentPlan || 'Route'} Stops ({routeStops.length})</Text>
            {loadingStops ? (
              <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 20 }} />
            ) : routeStops.length === 0 ? (
              <Text style={styles.noStopsText}>No stops available</Text>
            ) : (
              <ScrollView style={styles.stopsList} showsVerticalScrollIndicator={false}>
                {routeStops.map((stop, index) => (
                  <View key={index} style={styles.stopItem}>
                    <Text style={styles.stopNumber}>{index + 1}.</Text>
                    <Text style={styles.stopName}>{stop}</Text>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity 
              style={styles.closeStopsButton}
              onPress={() => setShowStopsModal(false)}
            >
              <Text style={styles.closeStopsText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
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
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },

  topBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 50,
    left: 15,
    right: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 10,
  },
rightIcons: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6, // reduce gap
},
organizeButton: {
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: COLORS.primary,
  paddingHorizontal: 10,
  height: 32,
  borderRadius: 16,
  gap: 4,
},

organizeText: {
  color: '#fff',
  fontSize: 12,
  fontWeight: '600',
},
iconButtonPrimary: {
  width: 32,
  height: 32,
  borderRadius: 16, // perfect circle
  backgroundColor: COLORS.primary,
  justifyContent: 'center',
  alignItems: 'center',
},
  searchContainer: {
  flex: 1,
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: 'rgba(255, 255, 255, 0.93)',
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

  planContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 70 : 60,
    left: 15,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.93)',
    borderRadius: 50,
    paddingHorizontal: 12,
    height: 40,
    ...SHADOWS.soft,
  },

  planLabel: {
    fontSize: 12,
    color: COLORS.textBody,
    marginRight: 8,
  },

  planButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 15,
    marginHorizontal: 2,
  },

  activePlan: {
    backgroundColor: COLORS.primary,
  },

  planText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#555',
  },

  activePlanText: {
    color: COLORS.white,
  },

  errorText: {
    color: '#e74c3c',
  },
  warningText: {
    color: '#f39c12',
  },
  textSmall: {
    fontSize: 12,
    opacity: 0.8,
  },

  // gorhom bottom-sheet styles
  sheetContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  sheetBackground: {
    backgroundColor: COLORS.white,
  },
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  handleIndicator: {
    backgroundColor: '#00000022',
    width: 44,
    height: 5,
    borderRadius: 10,
  },


  content: {
    marginTop: 5,
  },

  infoText: {
    textAlign: 'center',
    color: COLORS.textBody,
    fontSize: 14,
  },
  userBusPlaceholder: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    color: COLORS.textHeader,
    fontWeight: '500',
  },
  clearButton: {
    padding: 4,
  },
  refreshButton: {
    backgroundColor: COLORS.success,
  },

  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textHeader,
    marginBottom: 6,
  },

  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },

  sheetLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textHeader,
  },

  sheetSubLabel: {
    fontSize: 12,
    color: COLORS.textBody,
    marginTop: 4,
  },

  statusGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },

  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: '#f0f0f0',
    marginLeft: 6,
  },

  activePill: {
    borderColor: '#00000010',
    elevation: 1,
  },

  statusText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#555',
    textTransform: 'uppercase',
  },

  activePillText: {
    color: COLORS.white,
  },

  movingPill: {
    backgroundColor: '#2ecc71',
  },

  waitingPill: {
    backgroundColor: '#f1c40f',
  },

  stoppedPill: {
    backgroundColor: '#e74c3c',
  },

  busCard: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 16,
    ...SHADOWS.soft,
    marginTop: 10,
  },

  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },

  busNumber: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textHeader,
  },

  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
  },

  movingBadge: {
    backgroundColor: '#2ecc71',
  },

  stoppedBadge: {
    backgroundColor: '#e74c3c',
  },

  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.white,
    textTransform: 'uppercase',
  },

  etaContainer: {
    alignItems: 'center',
  },

  etaLabel: {
    fontSize: 14,
    color: COLORS.textBody,
    marginBottom: 12,
    textAlign: 'center',
  },

  etaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  etaItem: {
    alignItems: 'center',
    flex: 1,
  },

  etaValue: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textHeader,
    marginBottom: 4,
  },

  etaSubtext: {
    fontSize: 12,
    color: COLORS.textBody,
  },

  /* etaDivider removed */

  planSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    alignItems: 'center',
  },

  planLabel: {
    fontSize: 12,
    color: COLORS.textBody,
    marginBottom: 8,
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  planValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.primary,
    textTransform: 'uppercase',
  },

  text: {
    fontSize: 14,
    color: COLORS.textBody,
  },

  modalButtonContainer: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: 10,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },

  modalTextButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },

  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.white,
    textTransform: 'capitalize',
  },

  // Stops Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  stopsModal: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 24,
    maxHeight: '80%',
    width: '90%',
    maxWidth: 400,
    ...SHADOWS.heavy,
  },
  stopsTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textHeader,
    textAlign: 'center',
    marginBottom: 20,
  },
  noStopsText: {
    textAlign: 'center',
    color: COLORS.textBody,
    fontSize: 16,
    marginTop: 20,
  },
  stopsList: {
    maxHeight: 400,
    marginBottom: 20,
  },
  stopItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  stopNumber: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.primary,
    width: 30,
    marginRight: 12,
  },
  stopName: {
    fontSize: 16,
    color: COLORS.textHeader,
    flex: 1,
  },
  closeStopsButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  closeStopsText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});
