import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Card from './UI/Card';
import { COLORS, RADIUS, SHADOWS } from '../theme';
import { Body, MutedText, Header as TypographyHeader } from './UI/Typography';
import { normalizeBusPreview } from '../utils/busDisplay';
import { createMutationKey } from '../utils/mutationKey';

export default function UserCard({
  user,
  onDelete,
  onEdit,
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mutationKeyRef = useRef(null);
  const deleteMutationKeyRef = useRef(null);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const [draft, setDraft] = useState({
    name: user?.name ?? '',
    role: user?.role ?? 'student',
    bus_no: user?.bus_no ?? '',
  });

  const handleDelete = async () => {
    if (deletingRef.current) return;
    const key = deleteMutationKeyRef.current || createMutationKey();
    deleteMutationKeyRef.current = key;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const completed = await onDelete?.(user, key);
      if (completed === false) {
        deleteMutationKeyRef.current = null;
        return;
      }
      deleteMutationKeyRef.current = null;
    } catch {
      deleteMutationKeyRef.current = key;
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const save = async () => {
    if (savingRef.current) return;
    if (!draft.name.trim()) {
      Alert.alert('Validation', 'Name is required');
      return;
    }
    const key = mutationKeyRef.current || createMutationKey();
    mutationKeyRef.current = key;
    savingRef.current = true;
    setSaving(true);
    try {
      await onEdit?.(user, {
        name: draft.name.trim(),
        role: draft.role,
        bus_no: draft.bus_no.trim() ? draft.bus_no.trim() : null,
      }, key);
      mutationKeyRef.current = null;
      setEditing(false);
    } catch {
      mutationKeyRef.current = key;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const updateDraft = (field, value) => {
    mutationKeyRef.current = null;
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const beginEditing = () => {
    mutationKeyRef.current = null;
    setEditing(true);
  };

  const cancelEditing = () => {
    mutationKeyRef.current = null;
    setEditing(false);
  };

  const showDeleteConfirmation = () => {
    Alert.alert(
      'Deactivate user',
      `Deactivate ${user?.name || 'this user'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: handleDelete,
        },
      ]
    );
  };

  return (
    <Card style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.avatar}>
          <MaterialIcons name="person" size={18} color={COLORS.primary} />
        </View>

        <View style={{ flex: 1, marginLeft: 10 }}>
          <TypographyHeader style={styles.name} numberOfLines={1}>{user?.name || '—'}</TypographyHeader>
          <MutedText style={styles.email} numberOfLines={1}>{user?.email || ''}</MutedText>

          {!editing ? (
            <View style={styles.metaRow}>
              <Body style={styles.metaText}>Role: <Text style={styles.metaValue}>{user?.role || '-'}</Text></Body>
              <Body style={styles.metaText}>Bus: <Text style={styles.metaValue}>{normalizeBusPreview(user?.previewNumber ?? user?.preview_number) || '—'}</Text></Body>
            </View>
          ) : (
            <View style={styles.form}>
              <TextInput
                style={styles.input}
                value={draft.name}
                onChangeText={(t) => updateDraft('name', t)}
                placeholder="Name"
              />

              <TextInput
                style={styles.input}
                value={draft.role}
                onChangeText={(t) => updateDraft('role', t)}
                placeholder="Role (student/primary_admin/superadmin)"
                autoCapitalize="none"
              />

              <TextInput
                style={styles.input}
                value={String(draft.bus_no ?? '')}
                onChangeText={(t) => updateDraft('bus_no', t)}
                placeholder="Bus number"
                autoCapitalize="characters"
              />
            </View>
          )}
        </View>

        <View style={styles.actions}>
          {editing ? (
            <>
              <TouchableOpacity style={[styles.actionBtn, styles.saveBtn]} onPress={save} disabled={saving}>
                <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={cancelEditing}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={[styles.actionBtn, styles.editBtn]} onPress={beginEditing}>
                <Text style={styles.editText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} onPress={showDeleteConfirmation} disabled={deleting}>
                <Text style={styles.deleteText}>Delete</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    marginBottom: 10,
    ...SHADOWS.soft,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: COLORS.primary + '12',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primary + '33',
  },
  name: {
    fontSize: 15,
    fontWeight: '800',
  },
  email: {
    marginTop: 2,
    color: COLORS.muted,
  },
  metaRow: {
    marginTop: 8,
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    color: COLORS.textBody,
  },
  metaValue: {
    fontWeight: '700',
  },
  actions: {
    marginLeft: 12,
    gap: 8,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  actionBtn: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  editBtn: {
    backgroundColor: COLORS.primary + '14',
    borderColor: COLORS.primary + '55',
  },
  editText: {
    color: COLORS.primary,
    fontWeight: '800',
    fontSize: 12,
  },
  deleteBtn: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FECACA',
  },
  deleteText: {
    color: COLORS.error,
    fontWeight: '800',
    fontSize: 12,
  },
  saveBtn: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  saveText: {
    color: COLORS.white,
    fontWeight: '800',
    fontSize: 12,
  },
  cancelBtn: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.border,
  },
  cancelText: {
    color: COLORS.textBody,
    fontWeight: '800',
    fontSize: 12,
  },
  form: {
    marginTop: 8,
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.button,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: COLORS.textBody,
  },
});
