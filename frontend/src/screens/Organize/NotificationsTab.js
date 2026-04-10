import React, { useState, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../context/AuthContext';
import { API_BASE_URL } from '../../api/api';
import { COLORS } from '../../theme';

export default function NotificationsTab() {
  const { token } = useAuth();

  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedBuses, setSelectedBuses] = useState([]);

  // ================= FETCH =================
  const loadBuses = async () => {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE_URL}/api/bus/get-all-buses`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();

      console.log("BUS API:", data);

      if (res.ok) {
        setBuses(data.buses || []);
      } else {
        Alert.alert('Error', data.error || 'Failed to load buses');
      }
    } catch (err) {
      console.log(err);
      Alert.alert('Network Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBuses();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadBuses();
    setRefreshing(false);
  };

  // ================= SELECT =================
  const toggleBus = (busNo) => {
    setSelectedBuses((prev) =>
      prev.includes(busNo)
        ? prev.filter((b) => b !== busNo)
        : [...prev, busNo]
    );
  };

  // ================= ACTIONS =================
  const activateBuses = async () => {
    try {
      await Promise.all(
        selectedBuses.map((bus) =>
          fetch(`${API_BASE_URL}/api/bus/activate-bus/${bus}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );

      Alert.alert('Activated');
      setSelectedBuses([]);
      loadBuses();
    } catch {
      Alert.alert('Error activating');
    }
  };

  const deactivateBuses = async () => {
    try {
      await Promise.all(
        selectedBuses.map((bus) =>
          fetch(`${API_BASE_URL}/api/bus/delete-bus/${bus}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );

      Alert.alert('Deactivated');
      setSelectedBuses([]);
      loadBuses();
    } catch {
      Alert.alert('Error deactivating');
    }
  };

  // ================= UI =================
  const getStatusColor = (status) => {
    if (status === 'active') return 'green';
    if (status === 'inactive') return 'red';
    return 'gray';
  };

  const renderBus = (bus) => (
    <TouchableOpacity
      key={bus.busNo}
      style={[
        styles.card,
        selectedBuses.includes(bus.busNo) && styles.selected,
      ]}
      onPress={() => toggleBus(bus.busNo)}
    >
      <View style={styles.row}>
        <MaterialIcons name="directions-bus" size={28} color="#333" />

        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.busNo}>{bus.busNo}</Text>
          <Text style={styles.preview}>
            Preview: {bus.previewNumber || '-'}
          </Text>
        </View>

        <View style={styles.statusContainer}>
          <View
            style={[
              styles.dot,
              { backgroundColor: getStatusColor(bus.status) },
            ]}
          />
          <Text style={styles.status}>{bus.status}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  // ================= RENDER =================
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {loading ? (
          <ActivityIndicator style={{ marginTop: 50 }} />
        ) : buses.length === 0 ? (
          <Text style={{ textAlign: 'center', marginTop: 50 }}>
            No buses found
          </Text>
        ) : (
          buses.map(renderBus)
        )}
      </ScrollView>

      {/* ACTION BAR */}
      {selectedBuses.length > 0 && (
        <View style={styles.actionBar}>
          <Text>{selectedBuses.length} selected</Text>

          <View style={{ flexDirection: 'row' }}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: 'green' }]}
              onPress={activateBuses}
            >
              <Text style={styles.btnText}>Activate</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, { backgroundColor: 'red' }]}
              onPress={deactivateBuses}
            >
              <Text style={styles.btnText}>Deactivate</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ================= STYLES =================
const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    margin: 10,
    padding: 15,
    borderRadius: 12,
    elevation: 2,
  },

  selected: {
    borderWidth: 2,
    borderColor: COLORS.primary,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  busNo: {
    fontSize: 18,
    fontWeight: 'bold',
  },

  preview: {
    color: 'gray',
  },

  statusContainer: {
    alignItems: 'center',
  },

  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginBottom: 3,
  },

  status: {
    fontSize: 12,
  },

  actionBar: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    backgroundColor: '#fff',
    padding: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    elevation: 10,
  },

  btn: {
    padding: 10,
    borderRadius: 8,
    marginLeft: 10,
  },

  btnText: {
    color: '#fff',
    fontWeight: 'bold',
  },
});