import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
  StatusBar,
  TextInput,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as DocumentPicker from 'expo-document-picker';

import { useAuth } from '../../context/AuthContext';
import { API_BASE_URL } from '../../api/api';
import BusCard from '../../components/BusCard';
import ExcelUpload from '../../components/ExcelUpload';
import { COLORS, SPACING, RADIUS, SHADOWS, SIZES } from '../../theme';
import { Header, Subtitle, MutedText, Body } from '../../components/UI/Typography';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';

export default function AddBusesScreen() {
  const { token, loading: authLoading } = useAuth();

  const [uploading, setUploading] = useState(false);
  const [buses, setBuses] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newBusNumber, setNewBusNumber] = useState('');
  const [loadingBuses, setLoadingBuses] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [showBusModal, setShowBusModal] = useState(false);
  const [showPlanSelector, setShowPlanSelector] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedBusNumber, setEditedBusNumber] = useState('');
  const [updating, setUpdating] = useState(false);





  const loadBuses = useCallback(async () => {
    if (!token) return;
    setLoadingBuses(true);
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
      setLoadingBuses(false);
    }
  }, [token]);

  useEffect(() => {
    loadBuses();
  }, [loadBuses]);

  const handleDeactivateBus = async (busNo) => {
    Alert.alert("Deactivate Bus", `Are you sure you want to deactivate ${busNo}? The bus can be reactivated later.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deactivate",
        style: "destructive",
        onPress: async () => {
          try {
            const res = await fetch(`${API_BASE_URL}/api/bus/delete-bus/${busNo}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            if (res.ok) {
              loadBuses();
              Alert.alert('Success', data.message || 'Bus deactivated successfully');
            } else {
              Alert.alert('Error', data.error || 'Deactivation failed');
            }
          } catch (err) {
            Alert.alert('Network Error', 'Unable to connect to server');
          }
        }
      }
    ]);
  };

  const handleChangePlan = async (busNo, newPlan) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/bus/change-plan/${busNo}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newPlan }),
      });
      if (res.ok) loadBuses();
    } catch (err) {
      Alert.alert('Error', 'Plan update failed');
    }
  };

  const handleAddBusSubmit = async (file) => {
    if (!newBusNumber.trim()) {
      Alert.alert('Validation', 'Please enter a bus number first');
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('busNo', newBusNumber.trim());
      formData.append('file', {
        uri: file.uri,
        name: file.name || 'routes.xlsx',
        type: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const res = await fetch(`${API_BASE_URL}/api/bus/upload-bus-routes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const data = await res.json();
      if (res.ok) {
        Alert.alert('Success', 'Bus and routes updated successfully');
        setShowAddModal(false);
        setNewBusNumber('');
        loadBuses();
      } else {
        Alert.alert('Upload Failed', data.error);
      }
    } catch (err) {
      Alert.alert('Network Error', 'Check your connection and try again');
    } finally {
      setUploading(false);
    }
  };

  const toggleAddModal = (busNo = '') => {
    setNewBusNumber(busNo);
    setShowAddModal(!showAddModal);
  };

  const openBusModal = (bus) => {
    setSelectedBus(bus);
    setEditedBusNumber(bus.busNo);
    setShowBusModal(true);
    setShowPlanSelector(false);
    setIsEditing(false);
  };

  const closeBusModal = () => {
    setShowBusModal(false);
    setSelectedBus(null);
    setShowPlanSelector(false);
    setIsEditing(false);
  };

  const handleEditBusNumber = async () => {
    if (!editedBusNumber.trim()) {
      Alert.alert('Validation', 'Bus number is required');
      return;
    }

    if (editedBusNumber.trim() === selectedBus.busNo) {
      setIsEditing(false);
      return;
    }

    setUpdating(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/bus/update-bus-number/${selectedBus.busNo}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ newBusNo: editedBusNumber.trim() }),
        }
      );

      const data = await res.json();
      if (res.ok) {
        Alert.alert('Success', data.message, [
          {
            text: 'OK',
            onPress: () => {
              setIsEditing(false);
              loadBuses();
              closeBusModal();
            },
          },
        ]);
      } else {
        Alert.alert('Error', data.error);
      }
    } catch (err) {
      Alert.alert('Network Error', 'Cannot reach server.');
    } finally {
      setUpdating(false);
    }
  };

  const handleReupload = async () => {
    if (uploading) return;

    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (res.assets && res.assets[0]) {
        const file = res.assets[0];
        setUploading(true);

        const formData = new FormData();
        formData.append('busNo', selectedBus.busNo);
        formData.append('file', {
          uri: file.uri,
          name: file.name || 'routes.xlsx',
          type:
            file.type ||
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });

        const uploadRes = await fetch(
          `${API_BASE_URL}/api/bus/upload-bus-routes`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: formData,
          }
        );

        const data = await uploadRes.json();
        if (uploadRes.ok) {
          Alert.alert('Success', data.message, [
            { text: 'OK', onPress: () => {
              loadBuses();
              closeBusModal();
            }},
          ]);
        } else {
          Alert.alert('Upload Failed', data.error);
        }
      }
    } catch (err) {
      Alert.alert('Network Error', 'Cannot reach server.');
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/bus/activate-bus/${selectedBus.busNo}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const data = await res.json();
      if (res.ok) {
        Alert.alert('Success', data.message || 'Bus activated successfully', [
          { text: 'OK', onPress: () => {
            loadBuses();
            closeBusModal();
          }},
        ]);
      } else {
        Alert.alert('Error', data.error || 'Activation failed');
      }
    } catch (err) {
      Alert.alert('Network Error', 'Cannot reach server.');
    }
  };




  if (authLoading) return <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>;

  return (
    <SafeAreaView edges={['bottom']} style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <LinearGradient
          colors={['transparent', 'rgba(147, 51, 234, 0.1)', 'transparent']}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
          {loadingBuses ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.primary} />
              <MutedText style={{ marginTop: 12 }}>Syncing fleet...</MutedText>
            </View>
          ) : buses.length > 0 ? (
            <View>
              {/* Header */}
              <View style={styles.headerRow}>
                <Header>All Buses</Header>
              </View>

              {/* Bus Cards */}
              <ScrollView showsVerticalScrollIndicator={false} style={styles.busScrollContainer}>
                <View style={styles.busRowContainer}>
                  {buses.map((bus, index) => (
                    <View key={bus.busNo || index} style={styles.busCardWrapper}>
                      <BusCard
                        bus={bus}
                        onPress={openBusModal}
                      />
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons name="bus-marker" size={80} color={COLORS.muted} />
              <Header style={styles.emptyTitle}>No Buses Registered</Header>
              <MutedText style={styles.emptySub}>Tap the + button to add your first bus</MutedText>
            </View>
          )}
        </ScrollView>
        </LinearGradient>

        <TouchableOpacity style={styles.fab} onPress={() => toggleAddModal()} activeOpacity={0.9}>
          <Ionicons name="add" size={32} color={COLORS.white} />
        </TouchableOpacity>

        <Modal transparent visible={showAddModal} animationType="fade">
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              activeOpacity={1}
              style={styles.modalCloseOverlay}
              onPress={() => !uploading && toggleAddModal()}
            />
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <View>
                  <Header style={styles.modalTitle}>Bus Details</Header>
                  <Subtitle style={{ marginBottom: 0 }}>Configure bus routes and plans</Subtitle>
                </View>
                <TouchableOpacity onPress={() => !uploading && toggleAddModal()} style={styles.closeBtn}>
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
              </View>

              <View style={styles.formSection}>
                <Input
                  label="Bus Number"
                  placeholder="e.g. TN-37-BY-1234"
                  icon="bus-outline"
                  value={newBusNumber}
                  onChangeText={setNewBusNumber}
                  editable={!uploading}
                />

                <MutedText style={styles.fieldLabel}>Route Data (Excel)</MutedText>
                <View style={styles.uploadBox}>
                  {uploading ? (
                    <View style={styles.modalLoading}>
                      <ActivityIndicator color={COLORS.primary} />
                      <Body style={styles.uploadingText}>Uploading Routes...</Body>
                    </View>
                  ) : (
                    <ExcelUpload onUpload={handleAddBusSubmit} disabled={uploading} />
                  )}
                </View>

                <TouchableOpacity
                  style={styles.discardBtn}
                  onPress={() => !uploading && toggleAddModal()}
                >
                  <Body style={styles.discardText}>Discard Changes</Body>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <Modal transparent visible={showBusModal} animationType="slide">
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              activeOpacity={1}
              style={styles.modalCloseOverlay}
              onPress={closeBusModal}
            />
            <View style={styles.busModalContent}>
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.busModalHeader}>
                  <View>
                    <Header style={styles.busModalTitle}>{selectedBus?.busNo}</Header>
                    <Subtitle style={{ marginBottom: 0 }}>Bus Management Options</Subtitle>
                  </View>
                  <TouchableOpacity onPress={closeBusModal} style={styles.closeBtn}>
                    <Ionicons name="close" size={24} color={COLORS.textBody} />
                  </TouchableOpacity>
                </View>

                <View style={styles.busModalBody}>
                  {/* Edit Bus Number */}
                  <View style={styles.optionSection}>
                    {isEditing ? (
                      <View style={styles.editRow}>
                        <TextInput
                          value={editedBusNumber}
                          onChangeText={setEditedBusNumber}
                          style={styles.editInput}
                          autoFocus
                        />
                        <View style={styles.editButtons}>
                          <TouchableOpacity
                            style={[styles.editBtn, styles.cancelBtn]}
                            onPress={() => {
                              setIsEditing(false);
                              setEditedBusNumber(selectedBus.busNo);
                            }}
                            disabled={updating}
                          >
                            <MaterialIcons name="close" size={20} color={COLORS.textBody} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.editBtn, styles.confirmBtn]}
                            onPress={handleEditBusNumber}
                            disabled={updating}
                          >
                            {updating ? (
                              <ActivityIndicator size="small" color={COLORS.white} />
                            ) : (
                              <MaterialIcons name="check" size={20} color={COLORS.white} />
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.optionMain}
                        onPress={() => setIsEditing(true)}
                      >
                        <View style={styles.iconCircle}>
                          <MaterialIcons name="edit" size={18} color={COLORS.primary} />
                        </View>
                        <Body style={styles.optionText}>Edit Bus Number</Body>
                        <MaterialIcons name="chevron-right" size={20} color={COLORS.muted} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Change Plan */}
                  <View style={styles.optionSection}>
                    <TouchableOpacity
                      style={styles.optionMain}
                      onPress={() => setShowPlanSelector(!showPlanSelector)}
                    >
                      <View style={styles.iconCircle}>
                        <MaterialIcons name="swap-horiz" size={18} color={COLORS.primary} />
                      </View>
                      <Body style={styles.optionText}>Change Route Plan</Body>
                      <MaterialIcons
                        name={showPlanSelector ? "keyboard-arrow-up" : "keyboard-arrow-down"}
                        size={20}
                        color={COLORS.muted}
                      />
                    </TouchableOpacity>

                    {showPlanSelector && (
                      <View style={styles.planSelector}>
                        {Object.keys(selectedBus?.routes || {}).map((plan) => (
                          <TouchableOpacity
                            key={plan}
                            style={[styles.planOption, selectedBus.currentPlan === plan && styles.activePlanOption]}
                            onPress={() => {
                              handleChangePlan(selectedBus.busNo, plan);
                              setShowPlanSelector(false);
                              closeBusModal();
                            }}
                          >
                            <Body style={[styles.planText, selectedBus.currentPlan === plan && styles.activePlanText]}>
                              Plan {plan}
                            </Body>
                            {selectedBus.currentPlan === plan && (
                              <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
                            )}
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>

                  
                  {/* Update Route Data */}
                  <View style={styles.optionSection}>
                    <TouchableOpacity
                      style={styles.optionMain}
                      onPress={handleReupload}
                      disabled={uploading}
                    >
                      <View style={[styles.iconCircle, { backgroundColor: '#EEF2FF' }]}>                        
                        <MaterialIcons name="file-upload" size={18} color={COLORS.primary} />
                      </View>
                      <Body style={styles.optionText}>Update Route Data</Body>
                      {uploading && <ActivityIndicator size="small" color={COLORS.primary} />}
                    </TouchableOpacity>
                  </View>

                  {/* Activate/Deactivate */}
                  <View style={styles.optionSection}>
                    <TouchableOpacity
                      style={styles.optionMain}
                      onPress={selectedBus?.status === 'inactive' ? handleActivate : () => {
                        handleDeactivateBus(selectedBus.busNo);
                        closeBusModal();
                      }}
                    >
                      <View style={[styles.iconCircle, { backgroundColor: selectedBus?.status === 'inactive' ? '#E1FCEF' : '#FEE2E2' }]}>                        
                        <MaterialIcons
                          name={selectedBus?.status === 'inactive' ? "check-circle" : "block"}
                          size={18}
                          color={selectedBus?.status === 'inactive' ? COLORS.success : COLORS.error}
                        />
                      </View>
                      <Body style={[styles.optionText, selectedBus?.status !== 'inactive' && { color: COLORS.error }]}>                        
                        {selectedBus?.status === 'inactive' ? 'Activate Bus' : 'Deactivate Bus'}
                      </Body>
                    </TouchableOpacity>
                  </View>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>


      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  scroll: { padding: SPACING.screenPadding, paddingBottom: 100 },
  busRowContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  busCardWrapper: {
    width: '30%',
    margin: 4,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingContainer: { alignItems: 'center', marginTop: 60 },
  emptyContainer: { alignItems: 'center', marginTop: 100, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 20, marginTop: 16, textAlign: 'center' },
  emptySub: { textAlign: 'center', marginTop: 4 },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.soft,
    elevation: 8,
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
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    ...SHADOWS.soft,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  modalTitle: { fontSize: 22 },
  closeBtn: {
    padding: 4,
    backgroundColor: COLORS.inputBg,
    borderRadius: 12,
  },
  formSection: { gap: 2 },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textHeader,
    marginBottom: 4,
    marginLeft: 4,
  },
  uploadBox: {
    backgroundColor: COLORS.inputBg,
    borderRadius: RADIUS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    overflow: 'hidden',
    marginBottom: 12,
  },
  modalLoading: { padding: 40, alignItems: 'center' },
  uploadingText: { marginTop: 12, color: COLORS.primary, fontWeight: '700' },
  discardBtn: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  discardText: { color: COLORS.error, fontWeight: '600' },
  busModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    maxHeight: '80%',
    ...SHADOWS.soft,
  },
  busModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  busModalTitle: { fontSize: 22 },
  busModalBody: {
    padding: 24,
    paddingTop: 16,
  },
  optionSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textHeader,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editInput: {
    flex: 1,
    height: 48,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: COLORS.textHeader,
    backgroundColor: COLORS.white,
  },
  editButtons: {
    flexDirection: 'row',
    marginLeft: 8,
    gap: 6,
  },
  editBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtn: {
    backgroundColor: COLORS.inputBg,
  },
  confirmBtn: {
    backgroundColor: COLORS.primary,
  },
  optionMain: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  optionText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textBody,
  },
  planSelector: {
    backgroundColor: COLORS.inputBg,
    borderRadius: 12,
    marginTop: 8,
    padding: 4,
  },
  planOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 8,
  },
  activePlanOption: {
    backgroundColor: COLORS.white,
    ...SHADOWS.soft,
  },
  planText: {
    fontSize: 15,
    color: COLORS.textBody,
  },
  activePlanText: {
    color: COLORS.success,
    fontWeight: '700',
  },
  actionBar: {
    backgroundColor: COLORS.white,
    padding: 16,
    marginBottom: 16,
    borderRadius: RADIUS.card,
    ...SHADOWS.soft,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  selectedBusItem: {
    backgroundColor: 'COLORS.inputBg',
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

});
