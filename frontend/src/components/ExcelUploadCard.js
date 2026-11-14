/**
 * ExcelUploadCard — Displays an uploaded Excel file and its delete action.
 */
import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { Body, MutedText } from './UI/Typography';
import Card from './UI/Card';

export default function ExcelUploadCard({
  upload,
  onDelete
}) {
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleDelete = () => {
    Alert.alert(
      'Deactivate Excel Upload',
      `Are you sure you want to deactivate "${upload.file_name}"?\n\nThis will deactivate all users created from this Excel file.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => onDelete(upload)
        }
      ]
    );
  };

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleContainer}>
          <View style={styles.fileIcon}>
            <MaterialIcons name="description" size={22} color={COLORS.primary} />
          </View>
          <View style={styles.fileInfo}>
            <Body style={styles.fileName} numberOfLines={1}>
              {upload.custom_name || decodeURIComponent(upload.file_name)}
            </Body>
            {upload.custom_name && (
              <MutedText style={styles.originalFileName} numberOfLines={1}>
                File: {decodeURIComponent(upload.file_name)}
              </MutedText>
            )}
            <MutedText style={styles.date}>
              {formatDate(upload.uploaded_at)}
            </MutedText>
            {upload.is_active === false && (
              <MutedText>Upload and linked users are deactivated.</MutedText>
            )}
            {upload.import_status === 'processing' && (
              <MutedText>Import is still processing.</MutedText>
            )}
            {upload.import_status === 'partial' && (
              <MutedText>
                Partial import: {upload.import_summary?.failedRows ?? 0} rows failed
                of {upload.import_summary?.totalRows ?? 0}.
              </MutedText>
            )}
            {upload.import_status === 'failed' && (
              <MutedText>Import failed before users were saved.</MutedText>
            )}
          </View>
        </View>
      </View>

      <View style={styles.buttonRow}>
        {upload.is_active !== false && <TouchableOpacity
          style={[styles.actionBtn, styles.deleteBtn]}
          onPress={handleDelete}
          activeOpacity={0.7}
        >
          <MaterialIcons name="delete" size={18} color={COLORS.error} />
          <Text style={styles.btnTextDelete}>Deactivate</Text>
        </TouchableOpacity>}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  fileIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textHeader,
    marginBottom: 2,
  },
  date: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  originalFileName: {
    fontSize: 12,
    color: COLORS.muted,
    fontStyle: 'italic',
    marginBottom: 2,
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: 20,
    gap: 16,
    paddingLeft: 4,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  infoText: {
    fontSize: 13,
    color: COLORS.textBody,
    marginLeft: 6,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
  },
  deleteBtn: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FECACA',
  },
  btnTextDelete: {
    marginLeft: 6,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.error,
  },
});
