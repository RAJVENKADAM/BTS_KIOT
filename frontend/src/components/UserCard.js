import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Card from './UI/Card';
import { COLORS, RADIUS, SHADOWS } from '../theme';
import { Body, MutedText, Header as TypographyHeader } from './UI/Typography';

export default function UserCard({
  user,
  onDelete,
  onEdit,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: user?.name ?? '',
    role: user?.role ?? 'student',
    bus_no: user?.bus_no ?? '',
  });

  const handleDelete = () => {
    Alert.alert(
      'Deactivate user',
      `Deactivate ${user?.name || 'this user'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => onDelete?.(user),
        },
      ]
    );
  };

  const save = () => {
    if (!draft.name.trim()) {
      Alert.alert('Validation', 'Name is required');
      return;
    }
    onEdit?.(user, {
      name: draft.name.trim(),
      role: draft.role,
      bus_no: draft.bus_no.trim() ? draft.bus_no.trim() : null,
    });
    setEditing(false);
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
              <Body style={styles.metaText}>Bus: <Text style={styles.metaValue}>{user?.bus_no || '—'}</Text></Body>
            </View>
          ) : (
            <View style={styles.form}>
              <TextInput
                style={styles.input}
                value={draft.name}
                onChangeText={(t) => setDraft((d) => ({ ...d, name: t }))}
                placeholder="Name"
              />

              <TextInput
                style={styles.input}
                value={draft.role}
                onChangeText={(t) => setDraft((d) => ({ ...d, role: t }))}
                placeholder="Role (student/primary_admin/superadmin)"
                autoCapitalize="none"
              />

              <TextInput
                style={styles.input}
                value={String(draft.bus_no ?? '')}
                onChangeText={(t) => setDraft((d) => ({ ...d, bus_no: t }))}
                placeholder="Bus number"
                autoCapitalize="characters"
              />
            </View>
          )}
        </View>

        <View style={styles.actions}>
          {editing ? (
            <>
              <TouchableOpacity style={[styles.actionBtn, styles.saveBtn]} onPress={save}>
                <Text style={styles.saveText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={() => setEditing(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={[styles.actionBtn, styles.editBtn]} onPress={() => setEditing(true)}>
                <Text style={styles.editText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} onPress={handleDelete}>
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

