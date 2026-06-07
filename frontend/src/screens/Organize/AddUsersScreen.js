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

import { excelManagementApi } from '../../api/excelManagementApi';
import ExcelUpload from '../../components/ExcelUpload';
import MultiExcelUpload from '../../components/MultiExcelUpload';
import ExcelUploadCard from '../../components/ExcelUploadCard';
import UserCard from '../../components/UserCard';
import * as DocumentPicker from 'expo-document-picker';


import * as Sharing from 'expo-sharing';

import * as FileSystem from 'expo-file-system';

import XLSX from 'xlsx';


import { readExcelFile, convertExcelToJson } from '../../utils/excelImport';
import { importUsersExcelJson } from '../../api/importApi';


import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { Header, Body, MutedText, Subtitle } from '../../components/UI/Typography';
import Card from '../../components/UI/Card';

export default function AddUsersScreen() {
  const [uploading, setUploading] = useState(false);
  const [excelUploads, setExcelUploads] = useState([]);
  const [usersByUpload, setUsersByUpload] = useState({}); // { [uploadId]: users[] }
  const [loadingUsersByUpload, setLoadingUsersByUpload] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const { token, loading: authLoading } = useAuth();


  useEffect(() => {
    if (token) loadExcelUploads();
  }, [token]);

  const loadUsersForUpload = async (uploadId) => {
    if (!uploadId || !token) return;

    try {
      setLoadingUsersByUpload((p) => ({ ...p, [uploadId]: true }));
      const response = await excelManagementApi.getUsersByUpload(token, uploadId);
      if (response.success) {
        setUsersByUpload((p) => ({ ...p, [uploadId]: response.data || [] }));
      } else {
        setUsersByUpload((p) => ({ ...p, [uploadId]: [] }));
      }
    } catch (e) {
      console.error('Failed to load users for upload:', uploadId, e);
    } finally {
      setLoadingUsersByUpload((p) => ({ ...p, [uploadId]: false }));
    }
  };

  const loadExcelUploads = async () => {
    try {
      const response = await excelManagementApi.getAllUploads(token);
      if (response.success) {
        const uploads = response.data;
        setExcelUploads(uploads);

        // Load created users for each upload (to show cards)
        if (Array.isArray(uploads)) {
          uploads.forEach((u) => {
            if (u?.id) loadUsersForUpload(u.id);
          });
        }
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

  const handleFileUpload = async (file, customName) => {
    if (!token || !file?.uri) return;

    console.log('DocumentPicker asset:', file);

    setUploading(true);

    try {
      const readResult = await readExcelFile(file);
      // Column order doesn't matter; xlsx maps by header row.
      // Your sheet headers are: name, email, busno, role, mobile_no, date_of_year
      const rows = convertExcelToJson(readResult, {
        normalizeHeaders: true,
        skipEmptyRows: true,
      });

      const response = await importUsersExcelJson({
        token,
        users: rows.map((r) => ({
          name: r.name,
          email: r.email,
          busno: r.busno ?? r.bus_no,
          role: r.role,
          mobile_no: r.mobile_no,
          date_of_year: r.date_of_year,
        })),
        excelCustomName: customName,
      });

      if (response?.success) {
        Alert.alert(
          'Import complete',
          `totalRows: ${response.summary.totalRows}\ninserted: ${response.summary.insertedRows}\nupdated: ${response.summary.updatedRows}\nunchanged: ${response.summary.unchangedRows}\nfailed: ${response.summary.failedRows}`
        );
      }

      // Keep existing UI behavior; legacy Excel management list will stay as-is.
      loadExcelUploads();
    } catch (e) {
      Alert.alert('Import failed', e?.message || 'Unknown error');
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
    Alert.alert(
      'Delete Upload',
      'This will deactivate users associated with this file. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setUploading(true);
            try {
              const response = await excelManagementApi.deleteUpload(token, uploadId);
              if (response.success) {
                await loadExcelUploads();
              }
            } catch (error) {
              Alert.alert('Error', 'Delete failed');
            } finally {
              setUploading(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteUser = async (user, uploadId) => {
    if (!user?.id || !uploadId) return;

    Alert.alert(
      'Deactivate user',
      `Deactivate ${user?.name || user?.email || 'this user'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: async () => {
            try {
              await excelManagementApi.deactivateUser(token, user.id);
              await loadUsersForUpload(uploadId);
            } catch (e) {
              Alert.alert('Error', e?.message || 'Failed to deactivate user');
            }
          },
        },
      ]
    );
  };

  const handleEditUser = async (user, payload, uploadId) => {
    if (!user?.id || !uploadId) return;

    try {
      const res = await excelManagementApi.updateUser(token, user.id, payload);
      if (res?.success) {
        await loadUsersForUpload(uploadId);
      }
    } catch (e) {
      Alert.alert('Error', e?.message || 'Failed to update user');
    }
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
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'solid',
    overflow: 'hidden',
    ...SHADOWS.soft,
  },
  disabledBox: { opacity: 0.7 },
  processing: { padding: 40, alignItems: 'center' },
  processingText: { marginTop: 12, color: COLORS.primary, fontWeight: '700' },
  historyHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  usersSection: { marginTop: 10, marginBottom: 22 },
  usersHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  usersHeader: { fontSize: 16, fontWeight: '900', color: COLORS.textHeader },
  usersLoading: { paddingVertical: 18 },
  emptyUsersText: { color: COLORS.muted, fontWeight: '600' },
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

