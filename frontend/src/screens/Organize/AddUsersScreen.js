import React, { useState, useEffect } from "react";
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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";

import { excelManagementApi } from "../../api/excelManagementApi";
import MultiExcelUpload from "../../components/MultiExcelUpload";
import ExcelUploadCard from "../../components/ExcelUploadCard";
import UserCard from "../../components/UserCard";
import Card from "../../components/UI/Card";
import * as DocumentPicker from "expo-document-picker";

import { uploadUsersExcelWorkbook } from "../../api/importApi";

import { COLORS, SPACING, RADIUS, SHADOWS } from "../../theme";
import { Header, Body, MutedText } from "../../components/UI/Typography";
import { getErrorMessage } from "../../utils/errorHandler";

function formatImportRowErrors(rowResults) {
  if (!Array.isArray(rowResults)) return "";
  const failures = rowResults.filter((row) => row?.status === "failed");
  if (!failures.length) return "";
  const details = failures
    .slice(0, 6)
    .map((row) => {
      const excelRow = Number.isInteger(row.rowNumber)
        ? row.rowNumber
        : (Number(row.index) || 0) + 2;
      return `Excel row ${excelRow}: ${row.reason}`;
    });
  if (failures.length > details.length) {
    details.push(`...and ${failures.length - details.length} more.`);
  }
  return `\n\nRow issues:\n${details.join("\n")}`;
}

export default function AddUsersScreen() {
  const [uploading, setUploading] = useState(false);
  const [excelUploads, setExcelUploads] = useState([]);
  const [usersByUpload, setUsersByUpload] = useState({}); // { [uploadId]: users[] }
  const [loadingUsersByUpload, setLoadingUsersByUpload] = useState({});
  const [paginationByUpload, setPaginationByUpload] = useState({});
  const [loadingMoreUsersByUpload, setLoadingMoreUsersByUpload] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const { token, loading: authLoading } = useAuth();

  useEffect(() => {
    if (token) loadExcelUploads();
  }, [token]);

  const loadUsersForUpload = async (uploadId, { page = 1, append = false } = {}) => {
    if (!uploadId || !token) return;

    try {
      if (append) {
        setLoadingMoreUsersByUpload((p) => ({ ...p, [uploadId]: true }));
      } else {
        setLoadingUsersByUpload((p) => ({ ...p, [uploadId]: true }));
      }
      const response = await excelManagementApi.getUsersByUpload(
        token,
        uploadId,
        { page, limit: 100 },
      );
      if (response.success) {
        setUsersByUpload((p) => ({
          ...p,
          [uploadId]: append
            ? [...(p[uploadId] || []), ...(response.data || [])]
            : response.data || [],
        }));
        setPaginationByUpload((p) => ({
          ...p,
          [uploadId]: response.pagination || null,
        }));
      } else {
        if (!append) setUsersByUpload((p) => ({ ...p, [uploadId]: [] }));
      }
    } catch (e) {
      console.error("Failed to load users for upload:", uploadId, e);
    } finally {
      if (append) {
        setLoadingMoreUsersByUpload((p) => ({ ...p, [uploadId]: false }));
      } else {
        setLoadingUsersByUpload((p) => ({ ...p, [uploadId]: false }));
      }
    }
  };

  const loadMoreUsersForUpload = async (uploadId) => {
    const pagination = paginationByUpload[uploadId];
    if (!pagination?.hasNextPage || loadingMoreUsersByUpload[uploadId]) return;
    await loadUsersForUpload(uploadId, {
      page: pagination.page + 1,
      append: true,
    });
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
      console.error("Failed to load Excel uploads:", error);
      Alert.alert(
        "Load failed",
        getErrorMessage(error, "Could not load your Excel uploads."),
      );
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadExcelUploads();
    setRefreshing(false);
  };

  const handleFileUpload = async (file, customName) => {
    if (!token || !file?.uri) return;

    setUploading(true);

    try {
      const response = await uploadUsersExcelWorkbook({
        token,
        file,
        excelCustomName: customName,
      });

      if (response?.success) {
        const summary = response.summary || {};
        const rowErrors = formatImportRowErrors(summary.rowResults);
        Alert.alert(
          summary.partial
            ? "Import partially completed"
            : summary.failedRows
            ? "Import completed with errors"
            : "Import complete",
          [
            `Total rows: ${summary.totalRows ?? 0}`,
            `Valid rows: ${summary.validRows ?? 0}`,
            `Inserted: ${summary.insertedRows ?? 0}`,
            `Updated: ${summary.updatedRows ?? 0}`,
            `Unchanged: ${summary.unchangedRows ?? 0}`,
            `Duplicates: ${summary.duplicateRows ?? 0}`,
            `Failed: ${summary.failedRows ?? 0}`,
            summary.outcomeUnknown
              ? "Database outcome is uncertain; check the upload status before retrying."
              : "",
            rowErrors,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      // Keep existing UI behavior; legacy Excel management list will stay as-is.
      await loadExcelUploads();
    } catch (e) {
      const summary = e?.summary;
      const rowErrors = formatImportRowErrors(
        summary?.rowResults || e?.rowResults,
      );
      const message = [
        ...(summary
          ? [
              `Total rows: ${summary.totalRows ?? 0}`,
              `Valid rows: ${summary.validRows ?? 0}`,
              `Inserted: ${summary.insertedRows ?? 0}`,
              `Updated: ${summary.updatedRows ?? 0}`,
              `Unchanged: ${summary.unchangedRows ?? 0}`,
              `Duplicates: ${summary.duplicateRows ?? 0}`,
              `Failed: ${summary.failedRows ?? 0}`,
              ...(summary.outcomeUnknown
                ? ["Database outcome is uncertain; check the upload status before retrying."]
                : []),
            ]
          : []),
        getErrorMessage(e, "The user import could not be completed."),
        rowErrors,
        e?.isTimeout
          ? "The server may still have completed this import. Check the upload cards before retrying."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      Alert.alert(
        summary?.partial ? "Import partially completed" : "Import failed",
        message,
      );
      if (e?.isTimeout || summary?.partial || summary?.outcomeUnknown) {
        await loadExcelUploads();
      }
    } finally {
      setUploading(false);
    }
  };

  const handleEditUpload = async (uploadId) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      if (result.canceled) return;
      setUploading(true);
      const response = await excelManagementApi.reupload(
        token,
        uploadId,
        result.assets[0],
      );

      if (response.success) {
        Alert.alert("Updated", "User list updated successfully");
        loadExcelUploads();
      }
    } catch (error) {
      Alert.alert(
        "Error",
        getErrorMessage(error, "Could not update the Excel upload."),
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteUpload = async (uploadId) => {
    Alert.alert(
      "Delete Upload",
      "This will deactivate users associated with this file. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setUploading(true);
            try {
              const response = await excelManagementApi.deleteUpload(
                token,
                uploadId,
              );
              if (response.success) {
                await loadExcelUploads();
              }
            } catch (error) {
              Alert.alert("Error", getErrorMessage(error, "Delete failed."));
            } finally {
              setUploading(false);
            }
          },
        },
      ],
    );
  };

  const handleDeleteUser = async (user, uploadId) => {
    if (!user?.id || !uploadId) return;

    Alert.alert(
      "Deactivate user",
      `Deactivate ${user?.name || user?.email || "this user"}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deactivate",
          style: "destructive",
          onPress: async () => {
            try {
              await excelManagementApi.deactivateUser(token, user.id);
              await loadUsersForUpload(uploadId);
            } catch (e) {
              Alert.alert(
                "Error",
                getErrorMessage(e, "Failed to deactivate user."),
              );
            }
          },
        },
      ],
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
      Alert.alert("Error", getErrorMessage(e, "Failed to update user."));
    }
  };

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContainer}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.primary}
            />
          }
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
                <MultiExcelUpload
                  onUpload={handleFileUpload}
                  disabled={uploading}
                />
              )}
            </View>
          </View>

          {excelUploads.length > 0 && (
            <View style={styles.section}>
              <View style={styles.historyHeader}>
                <Header style={styles.sectionLabel}>Manage Users</Header>
              </View>

              {excelUploads.map((upload) => (
                <View key={upload.id}>
                  <ExcelUploadCard
                    upload={upload}
                    onEdit={handleEditUpload}
                    onDelete={handleDeleteUpload}
                  />
                  <View style={styles.usersSection}>
                    {loadingUsersByUpload[upload.id] ? (
                      <ActivityIndicator color={COLORS.primary} />
                    ) : usersByUpload[upload.id]?.length ? (
                      <>
                        <MutedText style={styles.usersCount}>
                          {paginationByUpload[upload.id]?.total ??
                            usersByUpload[upload.id].length} active users
                        </MutedText>
                        {usersByUpload[upload.id].map((user) => (
                          <UserCard
                            key={user.id}
                            user={user}
                            onDelete={(selectedUser) =>
                              handleDeleteUser(selectedUser, upload.id)
                            }
                            onEdit={(selectedUser, payload) =>
                              handleEditUser(selectedUser, payload, upload.id)
                            }
                          />
                        ))}
                        {paginationByUpload[upload.id]?.hasNextPage && (
                          <TouchableOpacity
                            style={styles.loadMoreButton}
                            onPress={() => loadMoreUsersForUpload(upload.id)}
                            disabled={loadingMoreUsersByUpload[upload.id]}
                          >
                            {loadingMoreUsersByUpload[upload.id] ? (
                              <ActivityIndicator color={COLORS.primary} />
                            ) : (
                              <MutedText style={styles.loadMoreText}>
                                Load more users (
                                {usersByUpload[upload.id].length} of{" "}
                                {paginationByUpload[upload.id].total})
                              </MutedText>
                            )}
                          </TouchableOpacity>
                        )}
                      </>
                    ) : (
                      <MutedText style={styles.noUsers}>
                        No active users in this upload.
                      </MutedText>
                    )}
                  </View>
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
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  scrollContainer: { padding: SPACING.screenPadding, paddingBottom: 40 },
  section: { marginBottom: 28 },
  sectionLabel: { fontSize: 18, marginBottom: 12 },
  uploadBox: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: "solid",
    overflow: "hidden",
    ...SHADOWS.soft,
  },
  disabledBox: { opacity: 0.7 },
  processing: { padding: 40, alignItems: "center" },
  processingText: { marginTop: 12, color: COLORS.primary, fontWeight: "700" },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  usersSection: {
    paddingLeft: 16,
    marginBottom: 16,
  },
  usersCount: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  noUsers: {
    textAlign: "center",
    fontSize: 13,
    marginVertical: 8,
    paddingLeft: 16,
  },
  loadMoreButton: {
    alignItems: "center",
    paddingVertical: 12,
  },
  loadMoreText: {
    color: COLORS.primary,
    fontWeight: "700",
  },
});
