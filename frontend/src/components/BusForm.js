import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useBus } from '../context/BusContext';
import { API_BASE_URL } from '../api/api';

import Button from './UI/Button';
import Input from './UI/Input';
import { COLORS, SPACING, RADIUS } from '../theme';
import { Subtitle, MutedText } from './UI/Typography';

const BusForm = ({ 
  initialData = {}, 
  onSuccess, 
  onCancel,
  mode = 'add' // 'add' or 'edit'
 }) => {
  const [formData, setFormData] = useState({
    busNo: '',
    previewNumber: '',
    gpsId: '',
    ...initialData,
  });
  const [uploading, setUploading] = useState(false);
  const [parsedRoutes, setParsedRoutes] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const { refreshBuses } = useBus();
  const { token } = useAuth();

  const validateBusNo = (busNo) => {
    const tnRegex = /^TN[A-Z0-9]+$/i;
    return tnRegex.test(busNo);
  };

  const handlePreviewValidate = async () => {
    if (!token) {
      Alert.alert('Auth Error', 'Please login again');
      return false;
    }
    if (formData.previewNumber) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/bus/validate-preview/${formData.previewNumber}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!data.valid) {
          Alert.alert('Validation Error', 'Preview number already in use');
          return false;
        }
      } catch (err) {
        console.error('Preview validate error:', err);
      }
    }
    return true;
  };

  const handleFilePick = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      copyToCacheDirectory: false,
    });

    if (result.type === 'success') {
      setUploading(true);
      const formDataFile = new FormData();
      formDataFile.append('file', {
        uri: result.uri,
        name: result.name,
        type: result.mimeType,
      });

      if (!token) {
        Alert.alert('Auth Error', 'Please login again');
        setUploading(false);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/api/bus/upload-bus-routes`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formDataFile,
        });
        const data = await res.json();
        if (res.ok) {
          setParsedRoutes(data);
          setShowPreview(true);
        } else {
          Alert.alert('Parse Error', data.error);
        }
      } catch (err) {
        Alert.alert('Network Error', 'Failed to parse Excel');
      } finally {
        setUploading(false);
      }
    }
  };

  const handleSubmit = async () => {
    if (!validateBusNo(formData.busNo)) {
      Alert.alert('Validation Error', 'Bus number must be TN + alphanumeric (e.g., TN30AH5907)');
      return;
    }

    if (formData.previewNumber && !(await handlePreviewValidate())) {
      return;
    }

    if (!parsedRoutes) {
      Alert.alert('Missing Routes', 'Please upload Excel routes first');
      return;
    }

    setUploading(true);
    try {
      const submitData = new FormData();
      submitData.append('busNo', formData.busNo);
      if (formData.previewNumber) submitData.append('previewNumber', formData.previewNumber);
      if (formData.gpsId) submitData.append('gpsId', formData.gpsId);
      submitData.append('file', {
        uri: parsedRoutes.fileUri || parsedRoutes.file, // Assume stored in parse response
        name: 'routes.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (!token) {
        Alert.alert('Auth Error', 'Please login again');
        setUploading(false);
        return;
      }
      const res = await fetch(`${API_BASE_URL}/api/bus/upload-bus-routes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: submitData,
      });

      const data = await res.json();
      if (res.ok) {
        Alert.alert('Success', data.message);
        refreshBuses();
        onSuccess?.();
      } else {
        Alert.alert('Submit Error', data.error);
      }
    } catch (err) {
      Alert.alert('Network Error', err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <Input
        label="Bus Number *"
        value={formData.busNo}
        onChangeText={(text) => setFormData({ ...formData, busNo: text.toUpperCase() })}
        placeholder="TN30AH5907"
        keyboardType="default"
      />
      <Input
        label="Bus Preview Number *"
        value={formData.previewNumber}
        onChangeText={(text) => setFormData({ ...formData, previewNumber: text })}
        placeholder="Bus 101"
      />
      <Input
        label="GPS Device ID"
        value={formData.gpsId}
        onChangeText={(text) => setFormData({ ...formData, gpsId: text })}
        placeholder="GPS-12345"
      />

      <TouchableOpacity style={styles.uploadBtn} onPress={handleFilePick} disabled={uploading}>
        <Ionicons name="cloud-upload-outline" size={24} color={COLORS.white} />
        <Text style={styles.uploadText}>
          {uploading ? 'Parsing...' : 'Upload Bus Routes Excel'}
        </Text>
      </TouchableOpacity>

      {parsedRoutes && (
        <View style={styles.previewCard}>
          <Subtitle>Parsed Routes Preview</Subtitle>
          <MutedText>{Object.keys(parsedRoutes.routes || {}).join(', ')} ({Object.values(parsedRoutes.routes || {}).reduce((acc, b) => acc + (b?.length || 0), 0)} stops)</MutedText>
        </View>
      )}

      {showPreview && (
        <TouchableOpacity style={styles.previewBtn} onPress={() => setShowPreview(false)}>
          <Text style={styles.previewBtnText}>Hide Preview</Text>
        </TouchableOpacity>
      )}

      <View style={styles.buttonRow}>
        <Button title="Cancel" variant="outline" onPress={onCancel} />
        <Button title={uploading ? 'Saving...' : 'Save Bus'} onPress={handleSubmit} loading={uploading} />
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: SPACING.screenPadding,
  },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 16,
    borderRadius: RADIUS.input,
    marginVertical: SPACING.lg,
  },
  uploadText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 12,
  },
  previewCard: {
    backgroundColor: COLORS.primary + '05',
    padding: 16,
    borderRadius: RADIUS.card,
    marginVertical: 12,
  },
  previewBtn: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  previewBtnText: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
});

export default BusForm;
