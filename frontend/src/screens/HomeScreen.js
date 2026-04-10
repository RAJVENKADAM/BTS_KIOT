import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  AsyncStorage,
  Modal,
  ScrollView,
  ActivityIndicator,
  Alert
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useBus } from '../context/BusContext';
import busApi from '../api/busApi';
import { COLORS, RADIUS, SHADOWS } from '../theme';
import { useAuth } from '../context/AuthContext';
import MapComponent from '../components/Map/MapComponent';

const { height } = Dimensions.get('window');

const MIN_HEIGHT = 150;
const MAX_HEIGHT = height * 0.6;
const POLL_INTERVAL = 30000; // 30s polling to respect API rate limit

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

const formatIndianTime = (hours, minutes, seconds) => {
  const totalMinutes = hours * 60 + minutes + seconds / 60;
  const hrs = Math.floor(totalMinutes / 60);
  const mins = Math.floor(totalMinutes % 60);
  const secs = Math.floor((totalMinutes % 1) * 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const HomeScreen = () => {
  const { token, user } = useAuth();
  const navigation = useNavigation();
  const role = (user?.role || 'student').toLowerCase();
  const { error, refreshBuses, selectedPlan, setSelectedPlan } = useBus(); // Keep for compatibility, ignore preview context for now

  const [searchQuery, setSearchQuery] = useState('');
  const [busData, setBusData] = useState(null);
  const [noBusFound, setNoBusFound] = useState(false);
  const [selectedPreviewNumber, setSelectedPreviewNumber] = useState(null);
  const [selectedBusNo, setSelectedBusNo] = useState(null);
  const [lastGoodLocation, setLastGoodLocation] = useState(null);
  const [locationStatus, setLocationStatus] = useState('idle'); // idle|loading|live|offline|error
  const [markerStatus, setMarkerStatus] = useState('moving'); // moving|waiting|stopped

  const lastCoordRef = useRef(null);
  const sameCoordinateCount = useRef(0);
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const [shouldAutoFocus, setShouldAutoFocus] = useState(false);
  const [showStopsModal, setShowStopsModal] = useState(false);
  const [routeStops, setRouteStops] = useState([]);
  const [loadingStops, setLoadingStops] = useState(false);
  const sheetHeight = useRef(new Animated.Value(MIN_HEIGHT)).current;
  const pollInterval = useRef(null);

  useEffect(() => {
    if (!selectedBusNo) {
      setIsSheetExpanded(false);
      Animated.spring(sheetHeight, {
        toValue: MIN_HEIGHT,
        useNativeDriver: false,
        stiffness: 220,
        damping: 22,
        mass: 1,
      }).start();
      return;
    }

    // When a bus is selected, expand the sheet
    setIsSheetExpanded(true);
    const hasLocation = busData && busData.latitude != null && busData.longitude != null;
    const toValue = hasLocation ? MAX_HEIGHT * 0.6 : MAX_HEIGHT * 0.3;

    Animated.spring(sheetHeight, {
      toValue,
      useNativeDriver: false,
      stiffness: 220,
      damping: 22,
      mass: 1,
    }).start();
  }, [selectedBusNo]);

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
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);


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

  // Detect bus movement status based on coordinate tracking
  const detectBusStatus = (lat, lng) => {
    const currentCoord = `${lat.toFixed(5)},${lng.toFixed(5)}`;

    if (lastCoordRef.current === currentCoord) {
      sameCoordinateCount.current += 1;
    } else {
      sameCoordinateCount.current = 1;
      lastCoordRef.current = currentCoord;
    }

    if (sameCoordinateCount.current >= 3) {
      return 'stopped';
    }
    return 'moving';
  };

  useEffect(() => {
    if (selectedBusNo && token) {
      // Clear any existing polling
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }

      let abortController = new AbortController();
      const pollLiveLocation = async () => {
        const signal = abortController.signal;
        try {
          // Only set loading if we don't have data yet
          if (!busData) {
            setLocationStatus('loading');
          }
          
          const data = await busApi.getBusLocation(token, selectedBusNo);

          if (data && data.latitude !== null && data.longitude !== null) {
            const nextBusData = {
              ...data,
              source: data.source || 'gps'
            };
            setBusData(nextBusData);
            setLastGoodLocation(nextBusData);
            setLocationStatus(data.isStale ? 'stale' : 'live');
            setNoBusFound(false);

            const statusFromAPI = data.busState;
            const statusFromCoordinates = detectBusStatus(data.latitude, data.longitude);
            setMarkerStatus(chooseBusStatus(statusFromAPI, statusFromCoordinates));
          } else {
            console.log('No valid location in poll:', data);
            // Only show error if we don't have any previous good location
            if (!lastGoodLocation) {
              setLocationStatus('error');
              setNoBusFound(true);
            } else {
              setBusData(lastGoodLocation);
              setLocationStatus('offline');
            }
          }
        } catch (err) {
          if (signal.aborted) return;
          console.log('Poll error:', err.message);
          // Only show error if we don't have any previous good location
          if (!lastGoodLocation) {
            setLocationStatus('error');
            setNoBusFound(true);
          } else {
            setBusData(lastGoodLocation);
            setLocationStatus('offline');
          }
        }
      };

      // Start polling immediately
      pollLiveLocation();

      // Set up interval for continuous polling
      pollInterval.current = setInterval(() => {
        abortController.abort();
        abortController = new AbortController();
        pollLiveLocation();
      }, POLL_INTERVAL);

      return () => {
        if (pollInterval.current) {
          clearInterval(pollInterval.current);
          pollInterval.current = null;
        }
        abortController.abort();
      };
    } else {
      // Clear polling when no bus is selected
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }
    }
  }, [selectedBusNo, token]);


  const toggleSheet = () => {
    const newExpandedState = !isSheetExpanded;
    setIsSheetExpanded(newExpandedState);

    const targetHeight = newExpandedState ? MAX_HEIGHT : MIN_HEIGHT;

    Animated.spring(sheetHeight, {
      toValue: targetHeight,
      useNativeDriver: false,
      stiffness: 150,
      damping: 20,
      mass: 1,
    }).start();
  };


  const handlePlanPress = async () => {
    if (!displayBusData?.currentPlan || !displayBusData.busNo || !token) {
      Alert.alert('Error', 'No plan data available');
      return;
    }
    setLoadingStops(true);
    try {
      const data = await busApi.getRouteStops(token, displayBusData.busNo, displayBusData.currentPlan);
      setRouteStops(data.stops || []);
      setShowStopsModal(true);
    } catch (error) {
      console.error('Stops load error:', error);
      Alert.alert('Error', 'Failed to load route stops');
    } finally {
      setLoadingStops(false);
    }
  };

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;

    const isPreviewSearch = /^\d{3,7}$/.test(query);
    setSearchQuery('');
    setNoBusFound(false);
    setLocationStatus('loading');

    // Clear any existing polling to avoid conflicts
    if (pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }

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
        sameCoordinateCount.current = 0;
        lastCoordRef.current = null;
        
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
        setSelectedBusNo(null);
        setSelectedPreviewNumber(null);
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
      sameCoordinateCount.current = 0;
      lastCoordRef.current = null;
      
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
          // Only reset if it's not the same bus or if we don't have good data
          if (!isSameBus || !lastGoodLocation) {
            setBusData(null);
            setLastGoodLocation(null);
            setLocationStatus('error');
            setNoBusFound(true);
          } else {
            setBusData(lastGoodLocation);
            setLocationStatus('offline');
          }
        }
      } catch (err) {
        console.log('Bus search error:', err.message);
        // Only reset if it's not the same bus or if we don't have good data
        if (!isSameBus || !lastGoodLocation) {
          setBusData(null);
          setLastGoodLocation(null);
          setLocationStatus('error');
          setNoBusFound(true);
        } else {
          setBusData(lastGoodLocation);
          setLocationStatus('offline');
        }
      }
    }
  };


  const displayBusData = busData || lastGoodLocation;
  const displayBusLabel = selectedPreviewNumber || selectedBusNo || displayBusData?.busNo;

  // Memoized bus card to prevent flicker
  const busCardContent = React.useMemo(() => {
    if (!displayBusData) return null;

    const distance = calculateDistance(displayBusData.latitude, displayBusData.longitude, KIOT_LAT, KIOT_LNG);
    const speed = markerStatus === 'moving' ? (displayBusData.speed || 30) : 0;
    let eta = 'No ETA';

    if (speed > 0 && distance > 0) {
      const timeHours = distance / speed;
      const hours = Math.floor(timeHours);
      const minutes = Math.floor((timeHours % 1) * 60);
      const seconds = Math.floor((((timeHours % 1) * 60) % 1) * 60);
      eta = formatIndianTime(hours, minutes, seconds);
    }

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
          <Text style={styles.etaLabel}>Estimated Time of Arrival</Text>
          <View style={styles.etaRow}>
            <View style={styles.etaItem}>
              <Text style={styles.etaValue}>{distance.toFixed(1)} KM</Text>
              <Text style={styles.etaSubtext}>Distance</Text>
            </View>
            <View style={styles.etaDivider} />
            <View style={styles.etaItem}>
              <Text style={styles.etaValue}>{eta}</Text>
              <Text style={styles.etaSubtext}>Time</Text>
            </View>
          </View>
        </View>
        
        {/* ACTIVE PLAN SECTION */}
{displayBusData?.currentPlan && (
          <TouchableOpacity style={styles.planSection} onPress={handlePlanPress} activeOpacity={0.8}>
            <Text style={styles.planLabel}>Active Plan</Text>
            <Text style={styles.planValue}>{displayBusData.currentPlan}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [displayBusData, displayBusLabel, markerStatus]);

  return (
    <View style={styles.container}>
      <StatusBar translucent backgroundColor="transparent" barStyle="dark-content" />

      {/* MAP */}
      <MapComponent
        busData={busData}
        markerStatus={markerStatus}
        autoFocus={shouldAutoFocus}
        onAutoFocusDone={() => setShouldAutoFocus(false)}
        onUserInteraction={() => setShouldAutoFocus(false)}
      />
      <View style={styles.topBar}>
  <View style={styles.searchContainer}>
    {/* LEFT ICON */}
    <Ionicons name="search" size={18} color={COLORS.textBody} />

    {/* INPUT */}
    <TextInput
      placeholder={selectedBusNo ? `${selectedBusNo}` : "Search Bus"}
      value={searchQuery}
      onChangeText={setSearchQuery}
      onSubmitEditing={handleSearch}
      style={styles.searchInput}
      placeholderTextColor={COLORS.textBody}
    />

    {/* RIGHT ICONS */}
    <View style={styles.rightIcons}>
  {role === 'superadmin' && (
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
</View>

      {/* BOTTOM SHEET */}
      <Animated.View style={[styles.bottomSheet, { height: sheetHeight }]}>
        <TouchableOpacity style={styles.toggleButton} onPress={toggleSheet} activeOpacity={0.7}>
          <Ionicons
            name={isSheetExpanded ? "chevron-down" : "chevron-up"}
            size={15}
            color={COLORS.textBody}
          />
        </TouchableOpacity>

        <View style={styles.sheetHeader}>
          <View>
            <Text style={styles.sheetLabel}>Live Bus Tracking</Text>
            <Text style={styles.sheetSubLabel}>search for bus to view time location</Text>
          </View>
        </View>

        <View style={styles.content}>
          {error ? (
            <Text style={[styles.infoText, styles.errorText]}>{error}</Text>
          ) : noBusFound && !displayBusData ? (
            <Text style={[styles.infoText, styles.errorText]}>No bus found for this preview number</Text>
          ) : !selectedBusNo ? (
            <Text style={styles.infoText}>Search any bus to track its live location.</Text>
          ) : displayBusData ? (
            busCardContent
          ) : locationStatus === 'loading' ? (
            <Text style={styles.infoText}>Loading live location...</Text>
          ) : (
            <Text style={styles.infoText}>No location data available</Text>
          )}
        </View>

        {/* BUTTONS - BOTTOM ROW INSIDE MODAL */}
        <View style={styles.modalButtonContainer}>
        </View>
      </Animated.View>

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

  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    ...SHADOWS.soft,
  },

  toggleButton: {
    alignItems: 'center',
    paddingVertical: 5,
    marginBottom: 8,
  },

  content: {
    marginTop: 5,
  },

  infoText: {
    textAlign: 'center',
    color: COLORS.textBody,
    fontSize: 14,
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

  etaDivider: {
    width: 1,
    height: 40,
    backgroundColor: '#ddd',
    marginHorizontal: 20,
  },

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
    backgroundColor: 'rgba(0,0,0,0.5)',
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
