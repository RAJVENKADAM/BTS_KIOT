import React, { useRef, useState, useEffect } from "react";
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

import {
  getImportOperation,
  uploadUsersExcelWorkbook,
} from "../../api/importApi";

import { COLORS, SPACING, RADIUS, SHADOWS } from "../../theme";
import { Header, Body, MutedText } from "../../components/UI/Typography";
import { getErrorMessage } from "../../utils/errorHandler";
import { getMutationAttempt } from "../../utils/mutationKey";

function formatImportRowErrors(rowResults) {
  if (!Array.isArray(rowResults)) return "";
  const failures = rowResults.filter((row) =>
    ["failed", "conflict"].includes(row?.status),
  );
  if (!failures.length) return "";
  const details = failures
    .slice(0, 6)
    .map((row) => {
      const excelRow = Number.isInteger(row.rowNumber)
        ? row.rowNumber
        : (Number(row.index) || 0) + 2;
      return `Excel row ${excelRow}: ${row.reason || row.error || row.status}`;
    });
  if (failures.length > details.length) {
    details.push(`...and ${failures.length - details.length} more.`);
  }
  return `\n\nRow issues:\n${details.join("\n")}`;
}

function formatImportLedgerRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const details = rows
    .filter((row) => row.status !== "completed")
    .slice(0, 6)
    .map(
      (row) =>
        `Excel row ${row.rowNumber}: ${row.status}${row.error ? ` - ${row.error}` : ""}`,
    );
  return details.length
    ? `\n\nPersisted row status:\n${details.join("\n")}`
    : "";
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
  const importMutation = useRef({ key: null, signature: null });
  const importInFlight = useRef(false);
  const uploadDeleteAttempts = useRef(new Map());
  const uploadDeleteInFlight = useRef(new Set());

  useEffect(() => {
    if (token) loadExcelUploads();
  }, [token]);

  const loadUsersForUpload = async (
    uploadId,
    { cursorMode = true, cursor, append = false } = {},
  ) => {
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
        { cursorMode, cursor, limit: 100 },
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
      cursor: pagination.nextCursor,
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
    if (!token || !file?.uri || importInFlight.current) return;

    importInFlight.current = true;
    setUploading(true);
    const operation = {
      name: file.name || "",
      size: file.size ?? null,
      lastModified: file.lastModified ?? null,
      uri: file.uri,
      customName: String(customName || "").trim(),
    };
    const idempotencyKey = getMutationAttempt(importMutation, operation);

    try {
      const response = await uploadUsersExcelWorkbook({
        token,
        file,
        excelCustomName: customName,
        idempotencyKey,
      });

      if (response?.success) {
        const summary = response.summary || {};
        if (response.status === "completed" && !summary.outcomeUnknown) {
          importMutation.current = { key: null, signature: null };
        }
        let persistedRows = "";
        if (response.uploadId && response.status !== "completed") {
          try {
            const status = await getImportOperation({
              token,
              uploadId: response.uploadId,
            });
            persistedRows = formatImportLedgerRows(status.rows);
          } catch (statusError) {
            persistedRows = `\n\n${getErrorMessage(
              statusError,
              "Could not load persisted import row status.",
            )}`;
          }
        }
        const rowErrors =
          formatImportRowErrors(summary.rowResults) || persistedRows;
        Alert.alert(
          response.status === "processing"
            ? "Import processing"
            : summary.partial
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
            rowErrors ||
              (response.status === "processing"
                ? `Import ${response.uploadId} is still processing. Refresh the upload list or inspect its row status before retrying.`
                : ""),
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
      if (e?.status === 409 || e?.isTimeout || summary?.partial || summary?.outcomeUnknown) {
        await loadExcelUploads();
      }
    } finally {
      importInFlight.current = false;
      setUploading(false);
    }
  };

  const handleDeleteUpload = async (upload) => {
    const uploadId = upload?.id || upload?._id;
    if (!uploadId || uploadDeleteInFlight.current.has(uploadId)) return;
    uploadDeleteInFlight.current.add(uploadId);
    setUploading(true);
    let attempt = uploadDeleteAttempts.current.get(uploadId);
    if (!attempt) {
      attempt = { current: { key: null, signature: null } };
      uploadDeleteAttempts.current.set(uploadId, attempt);
    }
    const expectedVersion = upload.revision ?? 0;
    const idempotencyKey = getMutationAttempt(attempt, {
      uploadId,
      expectedVersion,
      operation: "deactivate-upload",
    });
    try {
      const response = await excelManagementApi.deleteUpload(
        token,
        uploadId,
        expectedVersion,
        idempotencyKey,
      );
      if (response.success) {
        uploadDeleteAttempts.current.delete(uploadId);
        await loadExcelUploads();
      }
    } catch (error) {
      if (error?.status === 409) await loadExcelUploads();
      Alert.alert(
        "Upload deactivation failed",
        getErrorMessage(error, "Could not deactivate this upload."),
      );
    } finally {
      uploadDeleteInFlight.current.delete(uploadId);
      setUploading(false);
    }
  };

  const handleDeleteUser = (user, uploadId, idempotencyKey) => {
    if (!user?.id || !uploadId) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      Alert.alert(
        "Deactivate user",
        `Deactivate ${user?.name || user?.email || "this user"}?`,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          {
            text: "Deactivate",
            style: "destructive",
            onPress: async () => {
              try {
                const response = await excelManagementApi.deactivateUser(
                  token,
                  user,
                  idempotencyKey,
                );
                if (!response?.success) {
                  throw new Error("The server could not confirm the user update.");
                }
                await loadUsersForUpload(uploadId);
                resolve(true);
              } catch (e) {
                Alert.alert(
                  "Error",
                  getErrorMessage(e, "Failed to deactivate user."),
                );
                reject(e);
              }
            },
          },
        ],
      );
    });
  };

  const handleEditUser = async (user, payload, uploadId, idempotencyKey) => {
    if (!user?.id || !uploadId) return;

    try {
      const res = await excelManagementApi.updateUser(
        token,
        user.id,
        {
          ...payload,
          expectedVersion: user.resourceVersion,
          assignmentRevision: user.assignmentRevision,
        },
        idempotencyKey,
      );
      if (!res?.success) {
        throw new Error("The server could not confirm the user update.");
      }
      await loadUsersForUpload(uploadId);
    } catch (e) {
      Alert.alert("Error", getErrorMessage(e, "Failed to update user."));
      throw e;
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
                            onDelete={(selectedUser, mutationKey) =>
                              handleDeleteUser(
                                selectedUser,
                                upload.id,
                                mutationKey,
                              )
                            }
                            onEdit={(selectedUser, payload, mutationKey) =>
                              handleEditUser(
                                selectedUser,
                                payload,
                                upload.id,
                                mutationKey,
                              )
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
