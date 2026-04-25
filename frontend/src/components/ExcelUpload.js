import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { pick } from '@react-native-documents/picker';
import { COLORS } from '../theme';

const ExcelUpload = ({ onUpload, disabled = false }) => {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');

  const pickDocument = async () => {
    if (disabled || loading) return;

    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        copyToCacheDirectory: true,
      });

      if (res.canceled) return;

      if (res.assets && res.assets[0]) {
        const file = res.assets[0];
        setFileName(file.name);
        setLoading(true);

        await onUpload(file); // wait until upload finishes

        setLoading(false);
      }
    } catch (err) {
      setLoading(false);
      console.error('PICK ERROR:', err);
      Alert.alert('Error', 'Failed to pick or upload file');
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.button,
          (disabled || loading) && styles.disabledButton,
        ]}
        onPress={pickDocument}
        disabled={disabled || loading}
      >
        <Text style={styles.buttonText}>
          {loading ? 'Uploading...' : 'Select Excel File'}
        </Text>
      </TouchableOpacity>

      {fileName ? (
        <View style={styles.fileInfo}>
          <Text
            style={styles.fileName}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            Selected: {fileName}
          </Text>
          {loading && (
            <Text style={styles.loadingText}>Please wait...</Text>
          )}
        </View>
      ) : (
        <Text style={styles.hint}>
          Supported format: .xlsx
        </Text>
      )}
    </View>
  );
};

export default ExcelUpload;

/* ---------------- STYLES ---------------- */
const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    marginVertical: 12,
  },
  button: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    minWidth: 220,
    alignItems: 'center',
  },
  disabledButton: {
    backgroundColor: COLORS.muted,
  },
  buttonText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
  fileInfo: {
    marginTop: 12,
    alignItems: 'center',
    width: '100%',
    backgroundColor: COLORS.inputBg,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary + '33',
  },
  fileName: {
    fontSize: 14,
    color: COLORS.textHeader,
    fontWeight: '600',
    maxWidth: '90%',
  },
  hint: {
    fontSize: 13,
    color: COLORS.textBody,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 14,
    color: COLORS.primary,
    marginTop: 6,
    fontWeight: '700',
  },
});
