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
import { importBusRoutesExcelJson } from '../../api/importApi';
import { useAuth } from '../../context/AuthContext';
import { COLORS } from '../../theme';
import { API_BASE_URL } from '../../api/api';

export default function AddBusesScreen() {
  const { token } = useAuth();

  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [busNo, setBusNo] = useState('');
  const [previewNumber, setPreviewNumber] = useState('');
  const [deviceId, setDeviceId] = useState('');

  const loadBuses = async () => {
    setLoading(true);
    try {
      const res = await fetch(API_BASE_URL + '/api/bus/get-all-buses', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await res.json();
      if (res.ok) setBuses(data.buses || []);
    } catch (e) {
      Alert.alert('Error loading buses');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadBuses();
  }, []);

  const handleAddBus = async () => {
    if (!busNo.trim() || !deviceId.trim()) {
      return Alert.alert('Bus No and Device ID required');
    }
    try {
      const payload = {
        busNo: busNo.trim().toUpperCase(),
        previewNumber: previewNumber.trim() || null,
        deviceId: deviceId.trim(),
        regNo: null,
        routesByPlan: {},
      };
      await importBusRoutesExcelJson({ token, busPayload: payload });
      Alert.alert('Success', 'Bus added successfully');
      setShowAddModal(false);
      setBusNo('');
      setPreviewNumber('');
      setDeviceId('');
      loadBuses();
    } catch (e) {
      Alert.alert('Failed', e?.message || 'Unknown error');
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
        <View style={[styles.dot, { backgroundColor: item.status === 'active' ? 'green' : 'red' }]} />
        <Text>{item.status}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) return <ActivityIndicator style={{ marginTop: 50 }} />;

  return (
    <View style={{ flex: 1 }}>
      <FlatList data={buses} renderItem={renderBus} keyExtractor={(i, idx) => idx.toString()} />

      <TouchableOpacity style={styles.fab} onPress={() => setShowAddModal(true)}>
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>

      <Modal transparent visible={showAddModal}>
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Add Bus</Text>
            <TextInput placeholder="Bus Number (TN30AH5907)" value={busNo} onChangeText={setBusNo} style={styles.input} />
            <TextInput placeholder="Preview No (4,5,6...)" value={previewNumber} onChangeText={setPreviewNumber} style={styles.input} keyboardType="numeric" />
            <TextInput placeholder="Device ID (0867440065950925)" value={deviceId} onChangeText={setDeviceId} style={styles.input} />
            <TouchableOpacity style={styles.button} onPress={handleAddBus}>
              <Text style={{ color: '#fff' }}>Add Bus</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAddModal(false)}>
              <Text style={{ textAlign: 'center', marginTop: 10 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={showOptionsModal}>
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Bus Options</Text>
            <Text style={styles.subHeader}>Bus: {selectedBus?.busNo}</Text>
            <TouchableOpacity
              style={styles.optionButton}
              onPress={async () => {
                Alert.alert('Delete Bus', 'Are you sure you want to delete bus ' + selectedBus?.busNo + '?', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete', style: 'destructive',
                    onPress: async () => {
                      try {
                        const res = await fetch(API_BASE_URL + '/api/bus/delete-bus/' + selectedBus?.busNo, {
                          method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
                        });
                        if (res.ok) { setShowOptionsModal(false); loadBuses(); }
                        else Alert.alert('Error', 'Failed to delete bus');
                      } catch (e) { Alert.alert('Network Error'); }
                    }
                  }
                ]);
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
  header: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  subHeader: { fontSize: 14, color: '#666', marginBottom: 20 },
  optionButton: { padding: 15, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginBottom: 10, alignItems: 'center' },
  optionText: { fontSize: 16, color: '#333' },
});

