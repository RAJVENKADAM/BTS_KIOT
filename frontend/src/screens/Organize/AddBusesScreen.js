import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  FlatList,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { pick } from '@react-native-documents/picker';

import { useAuth } from '../../context/AuthContext';
import { API_BASE_URL } from '../../api/api';
import { COLORS, SHADOWS } from '../../theme';

export default function AddBusesScreen() {
  const { token } = useAuth();

  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);

  const [selectedBus, setSelectedBus] = useState(null);
  const [plans, setPlans] = useState(['PLAN A', 'PLAN B', 'PLAN C']); // Default plans
  const [selectedPlan, setSelectedPlan] = useState('PLAN A');

  const [busNo, setBusNo] = useState('');
  const [previewNumber, setPreviewNumber] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [file, setFile] = useState(null);



  // ================= LOAD =================
  const loadBuses = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();

      if (res.ok) setBuses(data.buses || []);
    } catch (e) {
      Alert.alert('Error loading buses');
    }
    setLoading(false);
  };

  const loadPlansForBus = async (busNo) => {
    console.log('Loading plans for bus:', busNo);
    try {
      const res = await fetch(`${API_BASE_URL}/api/bus/plans/${busNo}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      console.log('Plans API response status:', res.status);
      const data = await res.json();
      console.log('Plans data:', data);

      if (res.ok) {
        const plansList = data.plans || [];
        console.log('Setting plans:', plansList);
        setPlans(plansList);
        // Don't pre-select any plan, let user choose from all available plans
        setSelectedPlan('');
        
        // If no plans available, show a message
        if (plansList.length === 0) {
          Alert.alert('No Plans Available', 'This bus has no route plans uploaded. Please upload an Excel file with routes first.');
          setShowPlanModal(false);
          return;
        }
      } else {
        console.log('API error, using fallback plans');
        setPlans(['Plan A', 'Plan B', 'Plan C']); // Fallback
        setSelectedPlan('');
      }
    } catch (e) {
      console.error('Error loading plans:', e);
      setPlans(['Plan A', 'Plan B', 'Plan C']); // Fallback
      setSelectedPlan('');
    }
  };

  useEffect(() => {
    loadBuses();
  }, []);

  // ================= FILE PICK =================
  const pickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (res.assets && res.assets.length > 0) {
        setFile(res.assets[0]);
      }
    } catch (err) {
      Alert.alert('File error');
    }
  };

  // ================= ADD BUS =================
  const handleAddBus = async () => {
    if (!busNo.trim() || !deviceId.trim()) {
      return Alert.alert('Bus No and Device ID required');
    }

    try {
      const formData = new FormData();
      formData.append('busNo', busNo.trim().toUpperCase());
      formData.append('previewNumber', previewNumber.trim());
      formData.append('deviceId', deviceId.trim());

      console.log('FormData sending:', {
        busNo: busNo.trim().toUpperCase(),
        previewNumber: previewNumber.trim(),
        deviceId: deviceId.trim()
      });

      if (file) {
        formData.append('file', {
          uri: file.uri,
          name: file.name || 'routes.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }


      const res = await fetch(`${API_BASE_URL}/api/bus/upload-bus-routes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });


      const data = await res.json();

      if (res.ok) {
        setShowAddModal(false);
        setBusNo('');
        setPreviewNumber('');
        setDeviceId('');
        setFile(null);
        loadBuses();
      } else {
        Alert.alert('Error', data?.error || 'Failed');
      }
    } catch (e) {
      Alert.alert('Network Error');
    }
  };



  const renderBus = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => {
        setSelectedBus(item);
        setShowOptionsModal(true);
      }}
    >
      <Text style={styles.title}>Bus: {item.busNo}</Text>
      <Text>Preview: {item.previewNumber}</Text>

      <View style={styles.statusRow}>
        <View
          style={[
            styles.dot,
            { backgroundColor: item.status === 'active' ? 'green' : 'red' },
          ]}
        />
        <Text>{item.status}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) return <ActivityIndicator style={{ marginTop: 50 }} />;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={buses}
        renderItem={renderBus}
        keyExtractor={(i, idx) => idx.toString()}
      />

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={() => setShowAddModal(true)}>
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>

      {/* ADD MODAL */}
      <Modal transparent visible={showAddModal}>
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Add Bus</Text>

            <TextInput
              placeholder="Bus Number / Reg No (TN30AH5907)"
              value={busNo}
              onChangeText={setBusNo}
              style={styles.input}
            />

            <TextInput
              placeholder="Preview No (4,5,6...)"
              value={previewNumber}
              onChangeText={setPreviewNumber}
              style={styles.input}
              keyboardType="numeric"
            />

            <TextInput
              placeholder="Device ID (0867440065950925)"
              value={deviceId}
              onChangeText={setDeviceId}
              style={styles.input}
            />



            <TouchableOpacity onPress={pickFile} style={styles.upload}>
              <Text>{file ? file.name : 'Upload Excel'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.button} onPress={handleAddBus}>
              <Text style={{ color: '#fff' }}>Add Bus</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setShowAddModal(false)}>
              <Text style={{ textAlign: 'center', marginTop: 10 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* OPTIONS MODAL */}
      <Modal transparent visible={showOptionsModal}>
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Bus Options</Text>
            <Text style={styles.subHeader}>Bus: {selectedBus?.busNo}</Text>

            <TouchableOpacity 
              style={styles.optionButton} 
              onPress={() => {
                setShowOptionsModal(false);
                setShowPlanModal(true);
                // Clear previous plans and load new ones
                setPlans([]);
                setSelectedPlan('');
                loadPlansForBus(selectedBus.busNo);
              }}
            >
              <Text style={styles.optionText}>Change Routes</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.optionButton} 
              onPress={async () => {
                Alert.alert(
                  'Delete Bus',
                  `Are you sure you want to delete bus ${selectedBus.busNo}?`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          const res = await fetch(`${API_BASE_URL}/api/bus/delete-bus/${selectedBus.busNo}`, {
                            method: 'DELETE',
                            headers: {
                              Authorization: `Bearer ${token}`,
                            },
                          });
                          if (res.ok) {
                            setShowOptionsModal(false);
                            loadBuses();
                          } else {
                            Alert.alert('Error', 'Failed to delete bus');
                          }
                        } catch (e) {
                          Alert.alert('Network Error');
                        }
                      }
                    }
                  ]
                );
              }}
            >
              <Text style={styles.optionText}>Delete</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setShowOptionsModal(false)}>
              <Text style={{ textAlign: 'center', marginTop: 20 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* PLAN MODAL */}
      <Modal transparent visible={showPlanModal}>
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Select Plan</Text>
            <Text style={styles.subHeader}>Current: {selectedBus?.currentPlan || 'Plan A'}</Text>

            {plans.length === 0 ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ color: '#666', marginBottom: 10 }}>Loading plans...</Text>
                <ActivityIndicator size="small" color={COLORS.primary} />
              </View>
            ) : (
              plans.map(plan => (
                <TouchableOpacity 
                  key={plan}
                  style={[styles.optionButton, selectedPlan === plan && styles.selectedOption]}
                  onPress={() => setSelectedPlan(plan)}
                >
                  <Text style={[styles.optionText, selectedPlan === plan && styles.selectedOptionText]}>{plan}</Text>
                </TouchableOpacity>
              ))
            )}

            <TouchableOpacity 
              style={[styles.button, !selectedPlan && styles.disabledButton]} 
              onPress={async () => {
                if (!selectedPlan) {
                  Alert.alert('Please select a plan first');
                  return;
                }
                try {
                  const res = await fetch(`${API_BASE_URL}/api/bus/update-plan/${selectedBus.busNo}`, {
                    method: 'PUT',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ plan: selectedPlan }),
                  });
                  const data = await res.json();
                  if (res.ok) {
                    setShowPlanModal(false);
                    loadBuses(); // Refresh to show updated plan
                  } else {
                    Alert.alert('Error', data.error);
                  }
                } catch (e) {
                  Alert.alert('Network Error');
                }
              }}
              disabled={!selectedPlan}
            >
              <Text style={{ color: '#fff' }}>Update Plan</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setShowPlanModal(false)}>
              <Text style={{ textAlign: 'center', marginTop: 10 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: 10, padding: 15, backgroundColor: '#fff', borderRadius: 10 },
  title: { fontSize: 16, fontWeight: 'bold' },
  statusRow: { flexDirection: 'row', marginTop: 5, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 5 },
  fab: { position: 'absolute', bottom: 20, right: 20, backgroundColor: COLORS.primary, padding: 15, borderRadius: 30 },
  overlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'center', alignItems: 'center' },
  modalBox: { width: '90%', backgroundColor: '#fff', padding: 20, borderRadius: 10 },
  input: { borderWidth: 1, borderColor: '#ccc', marginBottom: 10, padding: 10, borderRadius: 8 },
  button: { backgroundColor: COLORS.primary, padding: 12, borderRadius: 10, alignItems: 'center' },
  disabledButton: { backgroundColor: '#ccc' },
  header: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  subHeader: { fontSize: 14, color: '#666', marginBottom: 20 },
  upload: { borderWidth: 1, borderStyle: 'dashed', padding: 15, marginBottom: 10, alignItems: 'center' },
  optionButton: { padding: 15, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginBottom: 10, alignItems: 'center' },
  selectedOption: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  optionText: { fontSize: 16, color: '#333' },
  selectedOptionText: { color: '#fff' },
});