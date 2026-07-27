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
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';

import { excelManagementApi } from '../../api/excelManagementApi';
import MultiExcelUpload from '../../components/MultiExcelUpload';
import ExcelUploadCard from '../../components/ExcelUploadCard';
import UserCard from '../../components/UserCard';
import Card from '../../components/UI/Card';
import * as DocumentPicker from 'expo-document-picker';

import { readExcelFile, convertExcelToJson } from '../../utils/excelImport';
import { importUsersExcelJson } from '../../api/importApi';

import { COLORS, SPACING, RADIUS, SHADOWS } from '../../theme';
import { Header, Body, MutedText } from '../../components/UI/Typography';

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
                <View key={upload.id}>
                  <ExcelUploadCard
                    upload={upload}
                    onEdit={handleEditUpload}
                    onDelete={handleDeleteUpload}
                  />
                </View>
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
  usersSection: {
    paddingLeft: 16,
    marginBottom: 16,
  },
  usersCount: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  noUsers: {
    textAlign: 'center',
    fontSize: 13,
    marginVertical: 8,
    paddingLeft: 16,
  },
});

