import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../theme';
import { Body, MutedText } from './UI/Typography';

const MultiExcelUpload = ({ onUpload, disabled = false }) => {
  const [showModal, setShowModal] = useState(false);
  const [customName, setCustomName] = useState('');
  const [fileName, setFileName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);

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
        setSelectedFile(file);
        setFileName(file.name);
        setShowModal(true);
      }
    } catch (err) {
      console.error('PICK ERROR:', err);
      Alert.alert('Error', 'Failed to pick file');
    }
  };

  const handleUpload = async () => {
    if (!customName.trim()) {
      Alert.alert('Error', 'Please enter a custom name for this Excel sheet');
      return;
    }

    if (!selectedFile) {
      Alert.alert('Error', 'No file selected');
      return;
    }

    try {
      setLoading(true);
      setShowModal(false);
      
      // Reset form
      setCustomName('');
      setFileName('');
      setSelectedFile(null);
      
      await onUpload(selectedFile, customName.trim());
    } catch (error) {
      Alert.alert('Upload Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const cancelUpload = () => {
    setShowModal(false);
    setCustomName('');
    setFileName('');
    setSelectedFile(null);
  };

  return (
    <>
      <View style={styles.container}>
        <TouchableOpacity
          style={[
            styles.button,
            (disabled || loading) && styles.disabledButton,
          ]}
          onPress={pickDocument}
          disabled={disabled || loading}
        >
          <Ionicons 
            name="add-circle-outline" 
            size={20} 
            color={COLORS.white} 
            style={styles.buttonIcon}
          />
          <Text style={styles.buttonText}>
            {loading ? 'Uploading...' : 'Add Excel Sheet'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          Add multiple Excel sheets with custom names
        </Text>
      </View>

      <Modal
        visible={showModal}
        transparent={true}
        animationType="fade"
        onRequestClose={cancelUpload}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Excel Sheet</Text>
              <TouchableOpacity onPress={cancelUpload} style={styles.closeButton}>
                <Ionicons name="close" size={24} color={COLORS.muted} />
              </TouchableOpacity>
            </View>

            <View style={styles.filePreview}>
              <Ionicons name="document-text-outline" size={24} color={COLORS.primary} />
              <View style={styles.fileInfo}>
                <Body style={styles.fileName}>{fileName}</Body>
                <MutedText>Excel file selected</MutedText>
              </View>
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Custom Name *</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter custom name (e.g., II-IT)"
                value={customName}
                onChangeText={setCustomName}
                placeholderTextColor={COLORS.muted}
                autoCapitalize="characters"
              />
              <MutedText style={styles.inputHint}>
                This name will appear on the card
              </MutedText>
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={cancelUpload}
                disabled={loading}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.modalButton, styles.uploadButton]}
                onPress={handleUpload}
                disabled={loading || !customName.trim()}
              >
                <Text style={styles.uploadButtonText}>
                  {loading ? 'Uploading...' : 'Upload'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
};

export default MultiExcelUpload;

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
    paddingVertical: 14,
    borderRadius: 24,
    minWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledButton: {
    backgroundColor: COLORS.muted,
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    color: COLORS.textBody,
    marginTop: 8,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.card,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.textHeader,
  },
  closeButton: {
    padding: 4,
  },
  filePreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.inputBg,
    padding: 16,
    borderRadius: RADIUS.card,
    marginBottom: 20,
  },
  fileInfo: {
    marginLeft: 12,
    flex: 1,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textHeader,
    marginBottom: 2,
  },
  inputContainer: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textHeader,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.input,
    padding: 14,
    fontSize: 16,
    backgroundColor: COLORS.inputBg,
    color: COLORS.textHeader,
  },
  inputHint: {
    marginTop: 6,
    fontSize: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: RADIUS.button,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  uploadButton: {
    backgroundColor: COLORS.primary,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textBody,
  },
  uploadButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.white,
  },
});