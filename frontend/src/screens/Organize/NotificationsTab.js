import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  Platform,
} from 'react-native';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../context/AuthContext';
import { API_BASE_URL } from '../../api/api';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { Header, Subtitle, MutedText, Body } from '../../components/UI/Typography';
import Button from '../../components/UI/Button';

export default function NotificationsTab() {
  const { token } = useAuth();
  
  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedBuses, setSelectedBuses] = useState([]);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState(null); // 'activate', 'deactivate', 'alter', 'combine'
  const [alterBus, setAlterBus] = useState('');
  const [combineStep, setCombineStep] = useState(1); // 1: confirm combine, 2: select active bus
  const [selectedActiveBus, setSelectedActiveBus] = useState('');

  const loadBuses = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) {
        setBuses(data.buses || []);
      }
    } catch (err) {
      Alert.alert('Network Error', 'Unable to connect to server');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadBuses();
  }, [loadBuses]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadBuses().then(() => setRefreshing(false));
  }, [loadBuses]);


  const handleBusSelect = (busNo) => {
    setSelectedBuses(prev => {
      if (prev.includes(busNo)) {
        return prev.filter(b => b !== busNo);
      } else {
        return [...prev, busNo];
      }
    });
  };

  const scrollViewRef = useRef();

  const handleAction = (action) => {
    // Validate actions based on current selection and statuses
    const selectedBusObjects = buses.filter(b => selectedBuses.includes(b.busNo));

    if (action === 'combine') {
      if (selectedBusObjects.length < 2) {
        Alert.alert('Error', 'Select at least two buses to combine');
        return;
      }

      // Cannot combine already combined buses
      if (selectedBusObjects.some(b => b.status === 'combined' || b.isCombined)) {
        Alert.alert('Error', 'Cannot combine buses that are already combined');
        return;
      }

      const activeCount = selectedBusObjects.filter(b => b.status === 'active').length;
      const inactiveCount = selectedBusObjects.filter(b => b.status === 'inactive').length;
      if (activeCount > 0 && inactiveCount > 0) {
        Alert.alert('Error', 'Cannot combine active and inactive buses. Please select buses with the same status.');
        return;
      }

      setActionType(action);
      setShowActionModal(true);
      setCombineStep(1);
      setSelectedActiveBus('');
      return;
    }

    if (action === 'alter') {
      if (selectedBusObjects.length !== 1) {
        Alert.alert('Error', 'Please select exactly one bus to alter');
        return;
      }
      const bus = selectedBusObjects[0];
      if (bus.status !== 'active') {
        Alert.alert('Error', 'Alter is allowed only for active buses');
        return;
      }
    }

    // For activate/deactivate we allow proceed; backend will validate
    setActionType(action);
    setShowActionModal(true);
  };

  const handleActivateSelected = async () => {
    if (selectedBuses.length === 0) {
      Alert.alert('Error', 'Please select buses to activate');
      return;
    }

    Alert.alert(
      "Activate Buses",
      `Are you sure you want to activate ${selectedBuses.length} bus(es)?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Activate",
          style: "default",
          onPress: async () => {
            try {
              const results = await Promise.all(selectedBuses.map(async (busNo) => {
                const res = await fetch(`${API_BASE_URL}/api/bus/activate-bus/${busNo}`, {
                  method: 'PUT',
                  headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok, status: res.status, data, busNo };
              }));

              const failed = results.filter(r => !r.ok);
              if (failed.length > 0) {
                console.warn('Activation failed for some buses:', failed);
                Alert.alert('Partial Failure', `Failed to activate ${failed.length} bus(es).`);
              } else {
                Alert.alert('Success', 'Selected buses activated successfully');
              }
              setSelectedBuses([]);
              setShowActionModal(false);
              loadBuses();
            } catch (err) {
              Alert.alert('Network Error', 'Cannot reach server.');
            }
          }
        }
      ]
    );
  };

  const handleDeactivateSelected = async () => {
    if (selectedBuses.length === 0) {
      Alert.alert('Error', 'Please select buses to deactivate');
      return;
    }

    Alert.alert(
      "Deactivate Buses",
      `Are you sure you want to deactivate ${selectedBuses.length} bus(es)? They can be reactivated later.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deactivate",
          style: "destructive",
          onPress: async () => {
            try {
              await Promise.all(selectedBuses.map(busNo =>
                fetch(`${API_BASE_URL}/api/bus/delete-bus/${busNo}`, {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${token}` },
                })
              ));
              Alert.alert('Success', 'Selected buses deactivated successfully');
              setSelectedBuses([]);
              setShowActionModal(false);
              loadBuses();
            } catch (err) {
              Alert.alert('Network Error', 'Cannot reach server.');
            }
          }
        }
      ]
    );
  };

  const handleAlter = async () => {
    if (selectedBuses.length !== 1) {
      Alert.alert('Error', 'Please select exactly one bus for alter');
      return;
    }

    if (!alterBus.trim()) {
      Alert.alert('Error', 'Please enter the alter bus number');
      return;
    }

    try {
      // For now, just show a success message
      // TODO: Implement backend API call to set alter bus
      Alert.alert('Success', `Alter bus ${alterBus} set for ${selectedBuses[0]}`);
      setSelectedBuses([]);
      setShowActionModal(false);
      setAlterBus('');
    } catch (error) {
      console.error('Error setting alter bus:', error);
      Alert.alert('Error', 'Failed to set alter bus');
    }
  };

  const renderBusItem = React.useCallback((bus) => (
    <TouchableOpacity
      key={bus.busNo}
      style={[
        styles.busItem,
        selectedBuses.includes(bus.busNo) ? styles.selectedBusItem : (
          bus.status === 'active' ? styles.activeBusItem : 
          bus.status === 'inactive' ? styles.inactiveBusItem : null
        ),
      ]}
      onPress={() => handleBusSelect(bus.busNo)}
    >
      <View style={styles.busItemContent}>
        <Header style={[
          styles.busNumber,
          bus.status === 'inactive' && styles.inactiveText,
          selectedBuses.includes(bus.busNo) && styles.selectedBusNumberText
        ]}>
          Bus {bus.busNo}
        </Header>
      </View>
    </TouchableOpacity>
  ), [selectedBuses, handleBusSelect]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'active': return COLORS.success;
      case 'inactive': return COLORS.error;
      case 'combined': return COLORS.warning;
      default: return COLORS.muted;
    }
  };

  const getSelectedBusStatuses = () => {
    const selectedBusObjects = buses.filter(bus => selectedBuses.includes(bus.busNo));
    const activeCount = selectedBusObjects.filter(bus => bus.status === 'active').length;
    const inactiveCount = selectedBusObjects.filter(bus => bus.status === 'inactive').length;
    return { activeCount, inactiveCount, total: selectedBusObjects.length };
  };

  const getFilteredBuses = () => {
    // Helper to safely parse/normalize combinedBuses into an array
    const parseCombined = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        // Try JSON parse first
        try {
          const p = JSON.parse(val);
          if (Array.isArray(p)) return p;
        } catch (e) {
          // not JSON, fall back to CSV
        }
        return val.split(',').map(s => s.trim()).filter(Boolean);
      }
      return [];
    };

    // explicit operating records with combinedBuses present (any format)
    const explicitOperating = buses.filter(b => b && (Array.isArray(b.combinedBuses) || (typeof b.combinedBuses === 'string' && b.combinedBuses.length > 0)));

    // derive child groups from buses that reference an operatingBus
    const childGroups = buses
      .filter(b => b && b.isCombined && b.operatingBus)
      .reduce((map, b) => {
        if (!map[b.operatingBus]) map[b.operatingBus] = [];
        map[b.operatingBus].push(b.busNo);
        return map;
      }, {});

    const operatingIds = new Set([
      ...explicitOperating.map(b => b.busNo),
      ...Object.keys(childGroups)
    ]);

    // Build combined groups for rendering, normalizing combinedBuses to arrays
    const combinedGroups = Array.from(operatingIds).map(busNo => {
      const explicit = explicitOperating.find(b => b.busNo === busNo);
      const explicitList = explicit ? parseCombined(explicit.combinedBuses) : [];
      const childList = childGroups[busNo] || [];
      const combinedBuses = Array.from(new Set([...(explicitList || []), ...(childList || [])]));
      return { busNo, combinedBuses };
    });

    const combinedMembers = new Set(combinedGroups.flatMap(g => g.combinedBuses || []));

    // Exclude any bus that is an operating record or a combined member from regular list
    const regularBuses = buses.filter(bus => !operatingIds.has(bus.busNo) && !combinedMembers.has(bus.busNo));

    return { regularBuses, combinedGroups };
  };

  const handleConfirmCombine = async () => {
    if (!selectedActiveBus) {
      Alert.alert('Error', 'Please select an active bus');
      return;
    }

    // Validate that all buses have the same status
    const { activeCount, inactiveCount } = getSelectedBusStatuses();
    if (activeCount > 0 && inactiveCount > 0) {
      Alert.alert('Error', 'Cannot combine active and inactive buses. Please select buses with the same status.');
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/bus/combine-buses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          operatingBus: selectedActiveBus,
          combinedBuses: selectedBuses.filter(bus => bus !== selectedActiveBus),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        Alert.alert('Success', data.message);
        setSelectedBuses([]);
        setShowActionModal(false);
        setCombineStep(1);
        setSelectedActiveBus('');
        loadBuses(); // Refresh the bus list
      } else {
        Alert.alert('Error', data.error || 'Failed to combine buses');
      }
    } catch (error) {
      console.error('Error combining buses:', error);
      Alert.alert('Network Error', 'Unable to connect to server');
    }
  };

  const handleUncombineBuses = async (operatingBus) => {
    Alert.alert(
      'Uncombine Buses',
      `Are you sure you want to uncombine the buses under operating bus ${operatingBus}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Uncombine',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(`${API_BASE_URL}/api/bus/uncombine-buses/${operatingBus}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
              });

              const data = await response.json();

              if (response.ok) {
                Alert.alert('Success', data.message);
                loadBuses(); // Refresh the bus list
              } else {
                Alert.alert('Error', data.error || 'Failed to uncombine buses');
              }
            } catch (error) {
              console.error('Error uncombining buses:', error);
              Alert.alert('Network Error', 'Unable to connect to server');
            }
          }
        }
      ]
    );
  };

  const content = (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            title="Refreshing buses..."
            titleColor={COLORS.textBody}
          />
        }
      >

        {/* Bus List */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Subtitle>Select buses to combine or manage</Subtitle>
          </View>

          {/* Action Bar */}
          {selectedBuses.length > 0 && (() => {
            const { activeCount, inactiveCount, total } = getSelectedBusStatuses();
            return (
              <View style={styles.actionBar}>
                <Body style={styles.actionText}>
                  {selectedBuses.length} bus(es) selected
                </Body>
                <View style={styles.actionButtons}>
                  {(() => {
                    const selectedBusObjects = buses.filter(bus => selectedBuses.includes(bus.busNo));
                    if (selectedBusObjects.length === 0) return null;
                    const totalSel = selectedBusObjects.length;
                    const activeCountSel = selectedBusObjects.filter(b => b.status === 'active').length;
                    const inactiveCountSel = selectedBusObjects.filter(b => b.status === 'inactive').length;

                    // Single selection
                    if (totalSel === 1) {
                      const bus = selectedBusObjects[0];
                      if (bus.status === 'active') {
                        return (
                          <>
                            <TouchableOpacity
                              style={[styles.actionBtn, styles.deactivateBtn]}
                              onPress={() => handleAction('deactivate')}
                            >
                              <MaterialIcons name="block" size={20} color={COLORS.white} />
                              <Body style={styles.actionBtnText}>Deactivate</Body>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.actionBtn, styles.alterBtn]}
                              onPress={() => handleAction('alter')}
                            >
                              <MaterialIcons name="swap-horiz" size={20} color={COLORS.white} />
                              <Body style={styles.actionBtnText}>Alter</Body>
                            </TouchableOpacity>
                          </>
                        );
                      }

                      // Inactive single bus -> only Activate
                      return (
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.activateBtn]}
                          onPress={() => handleAction('activate')}
                        >
                          <MaterialIcons name="play-arrow" size={20} color={COLORS.white} />
                          <Body style={styles.actionBtnText}>Activate</Body>
                        </TouchableOpacity>
                      );
                    }

                    // Multiple selection
                    if (activeCountSel > 0 && inactiveCountSel > 0) {
                      // Mixed: show only Deactivate
                      return (
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.deactivateBtn]}
                          onPress={() => handleAction('deactivate')}
                        >
                          <MaterialIcons name="block" size={20} color={COLORS.white} />
                          <Body style={styles.actionBtnText}>Deactivate</Body>
                        </TouchableOpacity>
                      );
                    }

                    // All active
                    if (activeCountSel === totalSel) {
                      return (
                        <>
                          <TouchableOpacity
                            style={[styles.actionBtn, styles.deactivateBtn]}
                            onPress={() => handleAction('deactivate')}
                          >
                            <MaterialIcons name="block" size={20} color={COLORS.white} />
                            <Body style={styles.actionBtnText}>Deactivate</Body>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.actionBtn, styles.combineBtn]}
                            onPress={() => handleAction('combine')}
                          >
                            <MaterialIcons name="merge-type" size={20} color={COLORS.white} />
                            <Body style={styles.actionBtnText}>Combine</Body>
                          </TouchableOpacity>
                        </>
                      );
                    }

                    // All inactive
                    if (inactiveCountSel === totalSel) {
                      return (
                        <>
                          <TouchableOpacity
                            style={[styles.actionBtn, styles.activateBtn]}
                            onPress={() => handleAction('activate')}
                          >
                            <MaterialIcons name="play-arrow" size={20} color={COLORS.white} />
                            <Body style={styles.actionBtnText}>Activate</Body>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.actionBtn, styles.combineBtn]}
                            onPress={() => handleAction('combine')}
                          >
                            <MaterialIcons name="merge-type" size={20} color={COLORS.white} />
                            <Body style={styles.actionBtnText}>Combine</Body>
                          </TouchableOpacity>
                        </>
                      );
                    }

                    return null;
                  })()}
                </View>
              </View>
            );
          })()}

          <View style={styles.headerRow}>
            <Header>All Buses</Header>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.primary} />
              <MutedText style={{ marginTop: 12 }}>Loading buses...</MutedText>
            </View>
          ) : (() => {
            const { regularBuses, combinedBuses } = getFilteredBuses();
            return (
              <View>
                {/* All Buses Section */}
                {regularBuses.length > 0 ? (
                  <View style={styles.busRowContainer}>
                    {regularBuses.map((bus, index) => (
                      <View key={bus.busNo || index} style={styles.busCardWrapper}>
                        {renderBusItem(bus)}
                      </View>
                    ))}
                  </View>
                ) : (
                  <View style={styles.emptyContainer}>
                    <MaterialIcons name="directions-bus" size={80} color={COLORS.muted} />
                    <Header style={styles.emptyTitle}>No Regular Buses Found</Header>
                    <MutedText style={styles.emptySub}>Add buses through the Buses tab</MutedText>
                  </View>
                )}

                {/* Combined Buses Section (single aggregated card listing all combined groups) */}
                    {(() => {
                      const { regularBuses, combinedGroups } = getFilteredBuses();
                      if (!combinedGroups || combinedGroups.length === 0) return null;
                      return (
                        <View style={styles.combinedSection}>
                          <View style={styles.headerRow}>
                            <Header>Combined Buses</Header>
                          </View>
                          <View style={{ flexDirection: 'column', width: '100%' }}>
                            {combinedGroups.map((group, idx) => (
                              <View key={group.busNo || idx} style={[styles.busCardWrapper, { width: '100%', marginBottom: 0 }]}>
                                <TouchableOpacity
                                  activeOpacity={0.9}
                                  onPress={() => {
                                    Alert.alert(
                                      `Uncombine ${group.busNo}`,
                                      `Uncombine operating bus ${group.busNo} and its ${group.combinedBuses.length} bus(es)?`,
                                      [
                                        { text: 'Cancel', style: 'cancel' },
                                        {
                                          text: 'Uncombine',
                                          style: 'destructive',
                                          onPress: () => handleUncombineBuses(group.busNo)
                                        }
                                      ]
                                    );
                                  }}
                                >
                                  <View style={[styles.busItem, styles.combinedBusCard]}>
                                    <View style={styles.combinedBusHeader}>
                                      <View style={styles.operatingBusInfo}>
                                        <MaterialIcons name="merge-type" size={24} color={COLORS.warning} style={{ marginRight: 8 }} />
                                        <View>
                                          <Header style={styles.busNumber}>Operating {group.busNo}</Header>
                                          <MutedText style={styles.combinedBusSubtitle}>
                                            {group.combinedBuses.length > 0
                                              ? group.combinedBuses
                                                  .map(busNo => `Bus ${busNo}`)
                                                  .join(', ')
                                                  .replace(/, ([^,]+)$/, ' & $1')
                                              : 'No combined buses'
                                            }
                                          </MutedText>
                                        </View>
                                      </View>
                                      <TouchableOpacity
                                        style={styles.uncombineBtn}
                                        onPress={() => handleUncombineBuses(group.busNo)}
                                      >
                                        <MaterialIcons name="close" size={16} color={COLORS.white} />
                                      </TouchableOpacity>
                                    </View>


                                  </View>
                                </TouchableOpacity>
                              </View>
                            ))}
                          </View>
                        </View>
                      );
                    })()}
              </View>
            );
          })()}
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View style={styles.container}>
      {content}

      {/* Action Modal */}
      <Modal transparent visible={showActionModal} animationType="fade">
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            activeOpacity={1}
            style={styles.modalCloseOverlay}
            onPress={() => setShowActionModal(false)}
          />
          <View style={styles.actionModalContent}>
            <View style={styles.actionModalHeader}>
              <Header style={styles.actionModalTitle}>
                {actionType === 'activate' ? 'Activate Buses' :
                 actionType === 'combine' ? 'Combine Buses' :
                 actionType === 'deactivate' ? 'Deactivate Buses' :
                 'Set Alter Bus'}
              </Header>
              <TouchableOpacity onPress={() => setShowActionModal(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={COLORS.textBody} />
              </TouchableOpacity>
            </View>

            <View style={styles.actionModalBody}>
              {actionType === 'activate' && (
                <View>
                  <Body style={styles.actionDescription}>
                    Activate {selectedBuses.length} selected bus(es).
                  </Body>
                  <View style={styles.selectedBusesList}>
                    {selectedBuses.map((bus) => (
                      <View key={bus} style={styles.selectedBusListItem}>
                        <Body style={styles.selectedBusText}>{bus}</Body>
                      </View>
                    ))}
                  </View>
                  <TouchableOpacity
                    style={[styles.confirmActionBtn, styles.activateBtn]}
                    onPress={handleActivateSelected}
                  >
                    <Body style={styles.confirmActionText}>Activate Buses</Body>
                  </TouchableOpacity>
                </View>
              )}

              {actionType === 'deactivate' && (
                <View>
                  <Body style={styles.actionDescription}>
                    Deactivate {selectedBuses.length} selected bus(es). They can be reactivated later.
                  </Body>
                  <View style={styles.selectedBusesList}>
                    {selectedBuses.map((bus) => (
                      <View key={bus} style={styles.selectedBusListItem}>
                        <Body style={styles.selectedBusText}>{bus}</Body>
                      </View>
                    ))}
                  </View>
                  <TouchableOpacity
                    style={[styles.confirmActionBtn, styles.dangerBtn]}
                    onPress={handleDeactivateSelected}
                  >
                    <Body style={styles.confirmActionText}>Deactivate Buses</Body>
                  </TouchableOpacity>
                </View>
              )}

              {actionType === 'alter' && (
                <View>
                  <Body style={styles.actionDescription}>
                    Set an alter bus for {selectedBuses[0]}
                  </Body>
                  <Body style={styles.alterSectionTitle}>Select from existing buses:</Body>
                  <View style={styles.alterBusesList}>
                    {buses
                      .filter(bus => bus.busNo !== selectedBuses[0] && bus.status === 'active')
                      .map((bus) => (
                        <TouchableOpacity
                          key={bus.busNo}
                          style={[
                            styles.alterBusItem,
                            alterBus === bus.busNo && styles.selectedAlterBus
                          ]}
                          onPress={() => setAlterBus(bus.busNo)}
                        >
                          <Body style={[
                            styles.alterBusItemText,
                            alterBus === bus.busNo && styles.selectedAlterBusText
                          ]}>
                            {bus.busNo}
                          </Body>
                          {alterBus === bus.busNo && (
                            <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                          )}
                        </TouchableOpacity>
                      ))}
                  </View>
                  <Body style={styles.alterSectionTitle}>Or enter manually:</Body>
                  <TextInput
                    style={styles.alterInput}
                    placeholder="e.g. TN-37-BY-1234"
                    value={alterBus}
                    onChangeText={setAlterBus}
                  />
                  <TouchableOpacity
                    style={[styles.confirmActionBtn, !alterBus && styles.disabledBtn]}
                    onPress={handleAlter}
                    disabled={!alterBus}
                  >
                    <Body style={styles.confirmActionText}>Set Alter Bus</Body>
                  </TouchableOpacity>
                </View>
              )}

              {actionType === 'combine' && combineStep === 1 && (
                <View>
                  <Body style={styles.actionDescription}>
                    Combine {selectedBuses.length} selected buses into one operating bus.
                  </Body>
                  <View style={styles.selectedBusesList}>
                    {selectedBuses.map((bus) => (
                      <View key={bus} style={styles.selectedBusListItem}>
                        <Body style={styles.selectedBusText}>{bus}</Body>
                      </View>
                    ))}
                  </View>
                  <TouchableOpacity
                    style={styles.confirmActionBtn}
                    onPress={() => setCombineStep(2)}
                  >
                    <Body style={styles.confirmActionText}>Combine Buses</Body>
                  </TouchableOpacity>
                </View>
              )}

              {actionType === 'combine' && combineStep === 2 && (
                <View>
                  <Body style={styles.actionDescription}>
                    Select which bus will be the active operating bus in this combination:
                  </Body>
                  <View style={styles.selectedBusesList}>
                    {selectedBuses.map((bus) => (
                      <TouchableOpacity
                        key={bus}
                        style={[
                          styles.selectedBusListItem,
                          selectedActiveBus === bus && styles.selectedActiveBusItem
                        ]}
                        onPress={() => setSelectedActiveBus(bus)}
                      >
                        <View style={styles.busSelectionRow}>
                          <Body style={[
                            styles.selectedBusText,
                            selectedActiveBus === bus && styles.selectedActiveBusText
                          ]}>
                            {bus}
                          </Body>
                          {selectedActiveBus === bus && (
                            <Ionicons name="radio-button-on" size={20} color={COLORS.primary} />
                          )}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TouchableOpacity
                    style={[styles.confirmActionBtn, !selectedActiveBus && styles.disabledBtn]}
                    onPress={handleConfirmCombine}
                    disabled={!selectedActiveBus}
                  >
                    <Body style={styles.confirmActionText}>Confirm Combination</Body>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
    padding: SPACING.screenPadding,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    marginBottom: 16,
  },
  sectionTitle: { 
    fontSize: 20, 
    marginBottom: 4 
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 20,
    marginTop: 16,
    textAlign: 'center',
  },
  emptySub: {
    textAlign: 'center',
    marginTop: 4,
  },
  busList: {
    flex: 1,
  },
  busRowContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  busCardWrapper: {
    width: '30%',
    margin: 4,
  },
  combinedSection: {
    marginTop: 24,
    marginBottom: 24,
    width: '100%',
  },
  busItem: {
    backgroundColor: COLORS.white,
    borderRadius: 45,
    paddingVertical: 6,
    paddingHorizontal: 8,
    ...SHADOWS.soft,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'transparent',
    width: '100%',
    height: 45,
  },
  selectedBusItem: {
    backgroundColor: COLORS.primary, // Blue color
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 45,
    overflow: 'hidden',
    paddingVertical: 6,
    paddingHorizontal: 8,
    width: '100%',
    height: 45,
  },
  selectedBusNumberText: {
    color: COLORS.white,
    fontWeight: '700',
  },
  inactiveBusItem: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.error,
    borderWidth: 1,
    borderRadius: 45,
  },
  activeBusItem: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.primary,
    borderWidth: 1,
    borderRadius: 45,
  },
  busItemContent: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    height: '100%',
  },
  busNumber: {
    fontSize: 18,
    fontWeight: '700',
  },
  inactiveText: {
    color: COLORS.muted,
  },
  selectedSummary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.inputBg,
    padding: 12,
    borderRadius: RADIUS.input,
    marginBottom: 16,
  },
  selectedText: {
    fontWeight: '600',
  },
  actionButton: {
    marginBottom: 16,
  },
  operatingBusSelector: {
    backgroundColor: COLORS.inputBg,
    borderRadius: RADIUS.card,
    padding: 16,
  },
  selectorTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    color: COLORS.textBody,
  },
  busSelectorScroll: {
    marginBottom: 16,
  },
  operatingBusOption: {
    backgroundColor: COLORS.white,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.input,
    marginRight: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  selectedOperatingBus: {
    backgroundColor: COLORS.primary,
  },
  operatingBusText: {
    fontWeight: '600',
    color: COLORS.textBody,
  },
  selectedOperatingBusText: {
    color: COLORS.white,
  },
  combineActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: COLORS.inputBg,
    borderRadius: RADIUS.input,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: COLORS.textBody,
    fontWeight: '600',
  },
  combineBtn: {
    flex: 2,
  },
  actionBar: {
    backgroundColor: COLORS.white,
    padding: 16,
    marginBottom: 16,
    borderRadius: RADIUS.card,
    ...SHADOWS.soft,
    flexDirection: 'column',
    gap: 12,
  },
  actionText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textHeader,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  combineBtn: {
    backgroundColor: COLORS.primary,
  },
  deactivateBtn: {
    backgroundColor: COLORS.error,
  },
  alterBtn: {
    backgroundColor: COLORS.warning,
  },
  activateBtn: {
    backgroundColor: COLORS.success,
  },
  actionBtnText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: COLORS.inputBg,
    gap: 6,
  },
  toggleBtnActive: {
    backgroundColor: COLORS.primary,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
  },
  toggleTextActive: {
    color: COLORS.white,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    justifyContent: 'flex-end',
  },
  modalCloseOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  actionModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    ...SHADOWS.soft,
    maxHeight: '70%',
  },
  actionModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  actionModalTitle: {
    fontSize: 20,
  },
  actionModalBody: {
    gap: 16,
  },
  actionDescription: {
    fontSize: 16,
    color: COLORS.textBody,
    marginBottom: 16,
  },
  selectedBusesList: {
    gap: 8,
    marginBottom: 16,
  },
  selectedBusListItem: {
    backgroundColor: COLORS.inputBg,
    padding: 12,
    borderRadius: 8,
  },
  selectedBusText: {
    fontSize: 16,
    color: COLORS.textHeader,
  },
  operatingBusText: {
    fontWeight: '700',
    color: COLORS.primary,
  },
  confirmActionBtn: {
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtn: {
    backgroundColor: COLORS.error,
  },
  confirmActionText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '600',
  },
  alterInput: {
    height: 48,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: COLORS.textHeader,
    backgroundColor: COLORS.white,
    marginBottom: 16,
  },
  closeBtn: {
    padding: 4,
  },
  busSelectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  selectedActiveBusItem: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  selectedActiveBusText: {
    color: COLORS.white,
    fontWeight: '600',
  },
  disabledBtn: {
    opacity: 0.5,
  },
  combinedBusCard: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 20,
    minHeight: 80,
  },
  combinedBusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  operatingBusInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flex: 1,
    gap: 8,
  },
  combinedBusSubtitle: {
    fontSize: 13,
    marginTop: 4,
    fontWeight: '500',
  },
  uncombineBtn: {
    backgroundColor: COLORS.primary,
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  combinedBusesList: {
    borderTopWidth: 1,
    borderTopColor: COLORS.inputBg,
    paddingTop: 12,
    gap: 10,
  },
  combinedBusListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: COLORS.inputBg,
    borderRadius: 8,
  },
  combinedBusName: {
    fontSize: 15,
    fontWeight: '500',
  },  alterSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
    color: COLORS.textHeader,
  },
  alterBusesList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  alterBusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.inputBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: COLORS.inputBg,
  },
  selectedAlterBus: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  alterBusItemText: {
    fontSize: 14,
    marginRight: 6,
    color: COLORS.textBody,
  },
  selectedAlterBusText: {
    color: COLORS.white,
    fontWeight: '600',
  },
});