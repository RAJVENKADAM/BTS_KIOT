import React, { useState, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { API_BASE_URL } from '../../api/api';
import { excelManagementApi } from '../../api/excelManagementApi';
import ExcelUpload from '../../components/ExcelUpload';
import MultiExcelUpload from '../../components/MultiExcelUpload';
import ExcelUploadCard from '../../components/ExcelUploadCard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import XLSX from 'xlsx';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { Header, Body, MutedText, Subtitle } from '../../components/UI/Typography';
import Card from '../../components/UI/Card';

export default function AddUsersScreen() {
  const [uploading, setUploading] = useState(false);
  const [excelUploads, setExcelUploads] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const { token, loading: authLoading } = useAuth();

  useEffect(() => {
    if (token) loadExcelUploads();
  }, [token]);

  const loadExcelUploads = async () => {
    try {
      const response = await excelManagementApi.getAllUploads(token);
      if (response.success) {
        setExcelUploads(response.data);
      }
    } catch (error) {
      console.error('Failed to load Excel uploads:', error);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadExcelUploads();
    setRefreshing(false);
  };

  const generateExcelTemplate = async () => {
    try {
      const sampleData = [
        { name: 'John Doe', email: 'john.doe@example.com', busno: 'BUS001', role: 'student', mobile_no: '9876543210', date_of_year: '1990' },
        { name: 'Jane Smith', email: 'jane.smith@example.com', busno: 'BUS002', role: 'primary_admin', mobile_no: '9876543211', date_of_year: '1985' }
      ];

      const ws = XLSX.utils.json_to_sheet(sampleData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      const fileUri = FileSystem.cacheDirectory + 'user_template.xlsx';

      await FileSystem.writeAsStringAsync(fileUri, wbout, { encoding: FileSystem.EncodingType.Base64 });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to generate template');
    }
  };

  const handleFileUpload = async (file, customName = null) => {
    if (!token || !file?.uri) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: Platform.OS === 'android' ? file.uri : file.uri.replace('file://', ''),
        name: file.name || 'users.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (customName) {
        formData.append('customName', customName);
      }

      const response = await fetch(`${API_BASE_URL}/api/organize/upload-excel-users`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const result = await response.json();
      if (response.ok) {
        Alert.alert('Success', `Imported: ${result?.results?.created || 0} users`);
        loadExcelUploads();
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (error) {
      Alert.alert('Upload Error', error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleEditUpload = async (uploadId) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      if (result.canceled) return;
      setUploading(true);
      const response = await excelManagementApi.reupload(token, uploadId, result.assets[0]);

      if (response.success) {
        Alert.alert('Updated', 'User list updated successfully');
        loadExcelUploads();
      }
    } catch (error) {
      Alert.alert('Error', error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteUpload = async (uploadId) => {
    Alert.alert("Delete Upload", "This will deactivate users associated with this file. Continue?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setUploading(true);
          try {
            const response = await excelManagementApi.deleteUpload(token, uploadId);
            if (response.success) loadExcelUploads();
          } catch (error) {
            Alert.alert('Error', 'Delete failed');
          } finally {
            setUploading(false);
          }
        }
      }
    ]);
  };

  if (authLoading) {
    return (
      <View style={styles.centered}><ActivityIndicator color={COLORS.primary} /></View>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={styles.scrollContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
          showsVerticalScrollIndicator={false}
        >
          <Header style={styles.sectionLabel}>Download the Excel Template</Header>
          <Card style={styles.templateCard}>
            <View style={styles.excelSheetBackground} />
            <View style={styles.cardHeader}>
              <View style={styles.iconCircle}>
                <MaterialCommunityIcons name="file-excel-outline" size={24} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 16 }}>
                <Body style={styles.cardTitle}>Excel Template</Body>
                <MutedText>Use our standard format</MutedText>
              </View>
            </View>
            <TouchableOpacity
              style={styles.templateBtn}
              onPress={generateExcelTemplate}
              activeOpacity={0.8}
            >
              <Ionicons name="download-outline" size={20} color={COLORS.primary} />
              <Body style={styles.templateBtnText}>Download Template</Body>
            </TouchableOpacity>
          </Card>

          <View style={styles.section}>
            <Header style={styles.sectionLabel}>Upload Users</Header>
            <View style={[styles.uploadBox, uploading && styles.disabledBox]}>
              {uploading ? (
                <View style={styles.processing}>
                  <ActivityIndicator color={COLORS.primary} />
                  <Body style={styles.processingText}>Processing Users...</Body>
                </View>
              ) : (
                <MultiExcelUpload onUpload={handleFileUpload} disabled={uploading} />
              )}
            </View>
          </View>

          {excelUploads.length > 0 && (
            <View style={styles.section}>
              <View style={styles.historyHeader}>
                <Header style={styles.sectionLabel}>Manage Users</Header></View>

              {excelUploads.map((upload) => (
                <ExcelUploadCard
                  key={upload.id}
                  upload={upload}
                  onEdit={handleEditUpload}
                  onDelete={handleDeleteUpload}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scrollContainer: { padding: SPACING.screenPadding, paddingBottom: 40 },
  templateCard: {
    padding: 20,
    marginBottom: 24,
    position: 'relative',
    overflow: 'visible',
  },
  excelSheetBackground: {
    position: 'absolute',
    top: -10,
    left: -10,
    right: -10,
    bottom: -10,
    backgroundColor: COLORS.primary + '08', // Very low opacity primary tint for sheet paper
    borderRadius: RADIUS.card + 8,
    zIndex: -1,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: COLORS.primary + '1A', // Low opacity primary for sheet effect
    justifyContent: 'center',
    alignItems: 'center'
  },
  cardTitle: { fontSize: 17, fontWeight: '700' },
  templateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: RADIUS.button,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  templateBtnText: { color: COLORS.primary, fontWeight: '700', marginLeft: 8 },
  section: { marginBottom: 28 },
  sectionLabel: { fontSize: 18, marginBottom: 12 },
  uploadBox: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.card,
    borderWidth: 1.5,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'solid',
    ...SHADOWS.soft,
  },
  disabledBox: { opacity: 0.7 },
  processing: { padding: 40, alignItems: 'center' },
  processingText: { marginTop: 12, color: COLORS.primary, fontWeight: '700' },
  historyHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  badge: {
    backgroundColor: COLORS.primary,
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
    marginBottom: 10,
  },
  badgeText: { fontSize: 12, color: COLORS.white, fontWeight: '800' },
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { fontSize: 20, marginTop: 16, marginBottom: 4 },
});

