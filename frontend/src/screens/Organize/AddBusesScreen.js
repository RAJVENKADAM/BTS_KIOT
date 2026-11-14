import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  FlatList,
  Modal,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Dimensions,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import XLSX from "xlsx";
import { importBusRoutesExcelJson } from "../../api/importApi";
import { useAuth } from "../../context/AuthContext";
import { COLORS } from "../../theme";
import { API_BASE_URL } from "../../api/api";
import busApi from "../../api/busApi";
import {
  readExcelFile,
  convertExcelToJson,
  convertColumnsToPlans,
} from "../../utils/excelImport";
import { fetchJson, getErrorMessage } from "../../utils/errorHandler";
import { getDisplayBusNumber } from "../../utils/busDisplay";
import { stopApi } from "../../api/stopApi";
import {
  createMutationKey,
  getMutationAttempt,
} from "../../utils/mutationKey";

const SCREEN_WIDTH = Dimensions.get("window").width;
// Calculate item width for exactly 5 per row with clean spacing
const HORIZONTAL_PADDING = 12;
const GAP = 8;
const ITEM_WIDTH = (SCREEN_WIDTH - HORIZONTAL_PADDING * 2 - GAP * 4) / 5;

// Uppercase plan names so they match the default current_plan "PLAN A"
const normalizePlans = (plans) => {
  const out = {};
  for (const [plan, stops] of Object.entries(plans || {})) {
    out[String(plan).toUpperCase()] = stops;
  }
  return out;
};

export default function AddBusesScreen() {
  const { token, user } = useAuth();
  const isSuperadmin = String(user?.role || "").toLowerCase() === "superadmin";

  const [buses, setBuses] = useState([]);
  const [loading, setLoading] = useState(false);

  // Add bus modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [busNo, setBusNo] = useState("");
  const [previewNumber, setPreviewNumber] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [routesByPlan, setRoutesByPlan] = useState(null);
  const [excelFileName, setExcelFileName] = useState("");
  const [parsingExcel, setParsingExcel] = useState(false);
  const [addingBus, setAddingBus] = useState(false);
  const [coordinateSheetBusy, setCoordinateSheetBusy] = useState(false);

  // Bus options modal
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);
  const [showAlterModal, setShowAlterModal] = useState(false);
  const [showRouteChoiceModal, setShowRouteChoiceModal] = useState(false);
  const [alterTargetBus, setAlterTargetBus] = useState(null);
  const [alterationRoutesByPlan, setAlterationRoutesByPlan] = useState(null);
  const [alterationExcelFileName, setAlterationExcelFileName] = useState("");
  const [parsingAlterationExcel, setParsingAlterationExcel] = useState(false);
  const [busChangeMode, setBusChangeMode] = useState("alter");
  const [alteringBus, setAlteringBus] = useState(false);
  const [restoringBus, setRestoringBus] = useState(false);

  // Edit details modal
  const [showEditDetailsModal, setShowEditDetailsModal] = useState(false);
  const [editPreviewNumber, setEditPreviewNumber] = useState("");
  const [editDeviceId, setEditDeviceId] = useState("");
  const [editRegNo, setEditRegNo] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const detailsMutation = useRef({ key: null, signature: null });
  const addBusMutation = useRef({ key: null, signature: null });
  const routesMutation = useRef({ key: null, signature: null });
  const busChangeMutation = useRef({ key: null, signature: null });
  const restoreMutation = useRef({ key: null, signature: null });
  const deleteMutation = useRef({ key: null, signature: null });

  // Edit routes modal
  const [showEditRoutesModal, setShowEditRoutesModal] = useState(false);
  const [editRoutesByPlan, setEditRoutesByPlan] = useState(null);
  const [editExcelFileName, setEditExcelFileName] = useState("");
  const [parsingEditExcel, setParsingEditExcel] = useState(false);
  const [savingRoutes, setSavingRoutes] = useState(false);

  const loadBuses = async () => {
    setLoading(true);
    try {
      const data = await fetchJson(API_BASE_URL + "/api/bus/get-all-buses", {
        headers: { Authorization: "Bearer " + token },
      });
      const loadedBuses = [
        ...(data.buses || []),
        ...(data.alteredBuses || []),
      ];
      // Sort buses in ascending order by their preview number (numeric comparison with string fallback)
      loadedBuses.sort((a, b) => {
        const numA = Number(a.previewNumber);
        const numB = Number(b.previewNumber);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB;
        }
        return String(a.previewNumber || "").localeCompare(
          String(b.previewNumber || ""),
        );
      });
      setBuses(loadedBuses);
    } catch (e) {
      Alert.alert(
        "Error loading buses",
        getErrorMessage(e, "Could not load the bus list."),
      );
    }
    setLoading(false);
  };

  const handleRestoreAltered = () => {
    if (!selectedBus?.isAltered) return;
    Alert.alert(
      "Restore original bus",
      `End the bus change for Bus ${getDisplayBusNumber(selectedBus)} and restore its original route settings?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: async () => {
            setRestoringBus(true);
            try {
              const mutation = {
                busNo: selectedBus.busNo,
                expectedVersion: selectedBus.revision ?? 0,
              };
              const idempotencyKey = getMutationAttempt(
                restoreMutation,
                mutation,
              );
              await busApi.restoreAltered(
                token,
                selectedBus.busNo,
                mutation.expectedVersion,
                idempotencyKey,
              );
              restoreMutation.current = { key: null, signature: null };
              setShowOptionsModal(false);
              await loadBuses();
            } catch (error) {
              if (error?.status === 409) await loadBuses();
              Alert.alert(
                "Restore failed",
                getErrorMessage(error, "Could not restore bus."),
              );
            } finally {
              setRestoringBus(false);
            }
          },
        },
      ],
    );
  };

  useEffect(() => {
    loadBuses();
  }, [token, isSuperadmin]);

  // ---------- Excel parsing helpers ----------
  const pickAndParseExcel = async (isEdit, isAlteration = false) => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const file = res.assets && res.assets[0];
      if (!file) return;

      if (isAlteration) {
        setParsingAlterationExcel(true);
        setAlterationRoutesByPlan(null);
        setAlterationExcelFileName("");
      }
      else if (isEdit) setParsingEditExcel(true);
      else setParsingExcel(true);

      const readResult = await readExcelFile(file);
      // Each column header = plan name (Plan A, Plan B, ...). Preserve original casing.
      const rows = convertExcelToJson(readResult, {
        normalizeHeaders: false,
        skipEmptyRows: true,
      });
      const plans = normalizePlans(convertColumnsToPlans(rows));

      if (!Object.keys(plans).length) {
        Alert.alert(
          "Parse Error",
          'No plans found. Make sure each column header is a plan name (e.g. "Plan A", "Plan B").',
        );
        return;
      }

      if (isAlteration) {
        setAlterationRoutesByPlan(plans);
        setAlterationExcelFileName(file.name);
      } else if (isEdit) {
        setEditRoutesByPlan(plans);
        setEditExcelFileName(file.name);
      } else {
        setRoutesByPlan(plans);
        setExcelFileName(file.name);
      }
    } catch (e) {
      Alert.alert(
        "Could not read routes file",
        getErrorMessage(e, "Please check the file and try again."),
      );
    } finally {
      if (isAlteration) setParsingAlterationExcel(false);
      else if (isEdit) setParsingEditExcel(false);
      else setParsingExcel(false);
    }
  };

  const renderPlansPreview = (plans) => {
    if (!plans) return null;
    const keys = Object.keys(plans);
    if (!keys.length) return null;
    return keys.map((plan) => (
      <View key={plan} style={styles.planPreview}>
        <Text style={styles.planPreviewTitle}>{plan}</Text>
        <Text style={styles.planPreviewStops}>
          {plans[plan].map((s) => s.stop_name).join(" → ")}
        </Text>
      </View>
    ));
  };

  // ---------- Add bus ----------
  const saveNewBus = async (resolvedRoutes) => {
    setAddingBus(true);
    try {
      const payload = {
        busNo: busNo.trim().toUpperCase(),
        previewNumber: previewNumber.trim() || null,
        deviceId: deviceId.trim(),
        regNo: null,
        routesByPlan: resolvedRoutes || {},
        expectedVersion: 0,
      };
      const idempotencyKey = getMutationAttempt(addBusMutation, payload);
      await importBusRoutesExcelJson({
        token,
        busPayload: payload,
        idempotencyKey,
      });
      addBusMutation.current = { key: null, signature: null };
      Alert.alert("Success", "Bus added successfully. Stops without coordinates can be added later from the Stop Master sheet.");
      setShowAddModal(false);
      setBusNo("");
      setPreviewNumber("");
      setDeviceId("");
      setRoutesByPlan(null);
      setExcelFileName("");
      loadBuses();
    } catch (e) {
      if (e?.status === 409) await loadBuses();
      Alert.alert("Failed", getErrorMessage(e, "Could not add the bus."));
    } finally {
      setAddingBus(false);
    }
  };

  const handleAddBus = async () => {
    if (!busNo.trim() || !deviceId.trim()) {
      return Alert.alert("Bus No and Device ID required");
    }
    await saveNewBus(routesByPlan || {});
  };

  // ---------- Edit details ----------
  const openEditDetails = () => {
    detailsMutation.current = { key: null, signature: null };
    setEditPreviewNumber(selectedBus?.previewNumber || "");
    setEditDeviceId(
      selectedBus?.gpsDeviceId || selectedBus?.gps_device_id || "",
    );
    setEditRegNo(selectedBus?.regNo || "");
    setShowOptionsModal(false);
    setShowEditDetailsModal(true);
  };

  const handleSaveDetails = async () => {
    const payload = {
      previewNumber: editPreviewNumber.trim() || null,
      gpsDeviceId: editDeviceId.trim(),
      regNo: editRegNo.trim() || null,
      expectedVersion: selectedBus?.revision ?? 0,
    };
    const signature = JSON.stringify(payload);
    if (
      !detailsMutation.current.key ||
      detailsMutation.current.signature !== signature
    ) {
      detailsMutation.current = {
        key: createMutationKey(),
        signature,
      };
    }
    setSavingDetails(true);
    try {
      await busApi.updateBusDetails(token, selectedBus.busNo, {
        ...payload,
      }, detailsMutation.current.key);
      Alert.alert("Success", "Bus details updated");
      setShowEditDetailsModal(false);
      loadBuses();
    } catch (e) {
      if (e?.status === 409) await loadBuses();
      Alert.alert(
        "Failed",
        getErrorMessage(e, "Could not update bus details."),
      );
    } finally {
      setSavingDetails(false);
    }
  };

  // ---------- Edit routes ----------
  const openEditRoutes = () => {
    setEditRoutesByPlan(null);
    setEditExcelFileName("");
    setShowOptionsModal(false);
    setShowEditRoutesModal(true);
  };

  const saveEditedRoutes = async (resolvedRoutes) => {
    setSavingRoutes(true);
    try {
      const payload = {
        busNo: selectedBus.busNo,
        previewNumber: selectedBus.previewNumber || null,
        deviceId: selectedBus.gpsDeviceId || selectedBus.gps_device_id || "",
        regNo: selectedBus.regNo || null,
        routesByPlan: resolvedRoutes,
        replaceRoutes: true,
        expectedVersion: selectedBus.revision ?? 0,
      };
      const idempotencyKey = getMutationAttempt(routesMutation, payload);
      await importBusRoutesExcelJson({ token, busPayload: payload, idempotencyKey });
      routesMutation.current = { key: null, signature: null };
      Alert.alert("Success", "Routes updated");
      setShowEditRoutesModal(false);
    } catch (e) {
      if (e?.status === 409) await loadBuses();
      Alert.alert("Failed", getErrorMessage(e, "Could not update the routes."));
    } finally {
      setSavingRoutes(false);
    }
  };

  const handleSaveRoutes = async () => {
    if (!editRoutesByPlan) {
      return Alert.alert("Missing Routes", "Please upload Excel routes first");
    }
    await saveEditedRoutes(editRoutesByPlan);
  };

  const downloadStopCoordinateSheet = async () => {
    setCoordinateSheetBusy(true);
    try {
      const data = await stopApi.getCoordinateSheet(token);
      if (!Array.isArray(data.stops) || !data.stops.length) {
        throw new Error(
          "Stop Master has no stops to download. Add route stops first, then try again.",
        );
      }
      const worksheet = XLSX.utils.aoa_to_sheet([
        ["Stop Name", "Latitude", "Longitude"],
        ...(data.stops || []).map((stop) => [
          stop.name,
          stop.latitude ?? "",
          stop.longitude ?? "",
        ]),
      ]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Stop Coordinates");
      const fileName = "stop-coordinates.xlsx";

      if (Platform.OS === "web") {
        XLSX.writeFile(workbook, fileName, { bookType: "xlsx" });
        return;
      }
      const base64 = XLSX.write(workbook, {
        bookType: "xlsx",
        type: "base64",
      });
      const mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

      if (
        Platform.OS === "android" &&
        FileSystem.StorageAccessFramework?.requestDirectoryPermissionsAsync
      ) {
        const permission =
          await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("Download cancelled", "No folder was selected.");
          return;
        }
        const savedFileUri =
          await FileSystem.StorageAccessFramework.createFileAsync(
            permission.directoryUri,
            "stop-coordinates",
            mimeType,
          );
        await FileSystem.writeAsStringAsync(savedFileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        Alert.alert(
          "Download complete",
          "Saved stop-coordinates.xlsx to the folder you selected.",
        );
        return;
      }

      const outputDirectory =
        FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!outputDirectory) {
        throw new Error("Could not access local storage for the Excel file.");
      }
      const fileUri = `${outputDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error(
          `The Excel file was created at ${fileUri}, but sharing is not available on this device.`,
        );
      }
      await Sharing.shareAsync(fileUri, {
        mimeType,
        dialogTitle: "Download Stop Master coordinates",
      });
      Alert.alert(
        "Stop sheet ready",
        `The Excel file contains ${data.stops.length} unique stops. Save or share stop-coordinates.xlsx to continue.`,
      );
    } catch (error) {
      Alert.alert(
        "Download failed",
        getErrorMessage(error, "Could not download the Stop Master sheet."),
      );
    } finally {
      setCoordinateSheetBusy(false);
    }
  };

  const saveAlteration = async (routeSource, resolvedRoutes) => {
    if (!alterTargetBus) return;
    setAlteringBus(true);
    try {
      const changeBus = busChangeMode === "combine"
        ? busApi.combineBus
        : busApi.alterBus;
      const expectedVersion = selectedBus.revision ?? 0;
      const expectedVersions = {
        [selectedBus.busNo]: expectedVersion,
        [alterTargetBus.busNo]: alterTargetBus.revision ?? 0,
      };
      const routeOptions = busChangeMode === "combine"
        ? {
            routeSource,
            ...(routeSource === "custom"
              ? { routesByPlan: resolvedRoutes }
              : {}),
          }
        : {};
      const idempotencyKey = getMutationAttempt(busChangeMutation, {
        mode: busChangeMode,
        sourceBusNo: selectedBus.busNo,
        targetBusNo: alterTargetBus.busNo,
        expectedVersions,
        routeOptions,
      });
      const result = await changeBus(
        token,
        selectedBus.busNo,
        alterTargetBus.busNo,
        routeOptions,
        { expectedVersion, expectedVersions, idempotencyKey },
      );
      busChangeMutation.current = { key: null, signature: null };
      setShowAlterModal(false);
      setShowRouteChoiceModal(false);
      await loadBuses();
      Alert.alert(
        busChangeMode === "combine" ? "Buses combined" : "Bus altered",
        `${result.message} ${result.notifiedStudents} student(s) notified.`,
      );
    } catch (e) {
      if (e?.status === 409) await loadBuses();
      Alert.alert(
        "Failed",
        getErrorMessage(
          e,
          busChangeMode === "combine"
            ? "Could not combine the buses."
            : "Could not alter the bus.",
        ),
      );
    } finally {
      setAlteringBus(false);
    }
  };

  const handleAlterBus = async (routeSource, uploadedRoutes) => {
    try {
      if (busChangeMode === "alter") {
        setShowRouteChoiceModal(false);
        await saveAlteration();
        return;
      }
      let routes = uploadedRoutes;
      if (routeSource !== "custom") {
        const routeBus =
          routeSource === "source" ? selectedBus : alterTargetBus;
        const data = await busApi.getBusRoutes(token, routeBus.busNo);
        routes = data?.plans || {};
        if (!Object.keys(routes).length) {
          return Alert.alert(
            "No routes",
            `Bus ${getDisplayBusNumber(routeBus)} has no routes to select. Upload routes first or choose another bus.`,
          );
        }
      }
      setShowRouteChoiceModal(false);
      await saveAlteration(routeSource, routes);
    } catch (error) {
      Alert.alert(
        "Could not load routes",
        getErrorMessage(error, "Unable to verify routes for the selected bus."),
      );
    }
  };

  const openAlterBus = (mode) => {
    setBusChangeMode(mode);
    setAlterTargetBus(null);
    setAlterationRoutesByPlan(null);
    setAlterationExcelFileName("");
    setShowOptionsModal(false);
    setShowAlterModal(true);
  };

  // ---------- Delete ----------
  const handleDeleteBus = () => {
    Alert.alert(
      "Delete Bus",
      "Are you sure you want to delete bus " + selectedBus?.busNo + "?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const expectedVersion = selectedBus?.revision ?? 0;
              const expectedVersions = Object.fromEntries(
                buses
                  .filter((bus) => bus.busNo && Number.isSafeInteger(bus.revision))
                  .map((bus) => [bus.busNo, bus.revision]),
              );
              const idempotencyKey = getMutationAttempt(deleteMutation, {
                busNo: selectedBus?.busNo,
                expectedVersion,
                expectedVersions,
              });
              await busApi.deleteBus(token, selectedBus?.busNo, {
                expectedVersion,
                expectedVersions,
                idempotencyKey,
              });
              deleteMutation.current = { key: null, signature: null };
              setShowOptionsModal(false);
              loadBuses();
            } catch (e) {
              if (e?.status === 409) await loadBuses();
              Alert.alert(
                "Error",
                getErrorMessage(e, "Could not delete the bus."),
              );
            }
          },
        },
      ],
    );
  };

  // ---------- Render ----------
  const renderBus = ({ item, index }) => {
    const isLastInRow = (index + 1) % 5 === 0;
    return (
      <TouchableOpacity
        style={[
          styles.card,
          { width: ITEM_WIDTH, height: ITEM_WIDTH },
          !isLastInRow && { marginRight: GAP },
        ]}
        activeOpacity={0.7}
        onPress={() => {
          setSelectedBus(item);
          setShowOptionsModal(true);
        }}
      >
        <Text style={styles.title} numberOfLines={1}>
          {getDisplayBusNumber(item)}
        </Text>
        {item.isAltered && (
          <Text style={styles.alteredLabel}>
            {item.alterationType === "combine"
              ? `Combined with ${item.alteredToPreview ?? "—"}`
              : `Altered to ${item.alteredToPreview ?? "—"}`}
          </Text>
        )}
      </TouchableOpacity>
    );
  };

  if (loading)
    return (
      <ActivityIndicator style={{ marginTop: 50 }} color={COLORS.primary} />
    );

  return (
    <View style={styles.container}>
      <FlatList
        key="bus-grid-5-columns"
        data={buses.filter((bus) => !bus.isAltered)}
        renderItem={renderBus}
        keyExtractor={(i, idx) =>
          i?.id?.toString() || i?.busNo?.toString() || idx.toString()
        }
        numColumns={5}
        contentContainerStyle={styles.listContainer}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No buses yet. Tap + to add one.</Text>
        }
        ListHeaderComponent={
          <View>
            <Text style={styles.alteredSectionTitle}>Buses</Text>
            {isSuperadmin && (
              <View style={styles.coordinateSheetPanel}>
                <Text style={styles.coordinateSheetTitle}>
                  Stop Master coordinates
                </Text>
                <Text style={styles.coordinateSheetDescription}>
                  Download the current Stop Master coordinates for review. Coordinate uploads are temporarily disabled until revision-checked transactional import is available.
                </Text>
                <TouchableOpacity
                  style={styles.optionButton}
                  onPress={downloadStopCoordinateSheet}
                  disabled={coordinateSheetBusy}
                >
                  <Ionicons
                    name="download-outline"
                    size={20}
                    color={COLORS.primary}
                  />
                  <Text style={styles.optionText}>
                    {coordinateSheetBusy ? "Working..." : "Download Stops Excel"}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        ListFooterComponent={
          <>
            {[
              {
                type: "alter",
                title: "Altered buses",
                description:
                  "The bus uses the replacement location and the route stops selected by the super admin.",
              },
              {
                type: "combine",
                title: "Combined buses",
                description:
                  "The bus uses the replacement location and the route stops selected by the super admin.",
              },
            ].map((section) => {
              const sectionBuses = buses.filter(
                (bus) =>
                  bus.isAltered &&
                  (bus.alterationType || "alter") === section.type,
              );
              if (!sectionBuses.length) return null;
              return (
                <View key={section.type} style={styles.alteredSection}>
                  <Text style={styles.alteredSectionTitle}>
                    {section.title}
                  </Text>
                  <Text style={styles.combinedSectionDescription}>
                    {section.description}
                  </Text>
                  <View style={styles.alteredGrid}>
                    {sectionBuses.map((bus, index) => (
                      <View
                        key={String(bus.busNo || index)}
                        style={styles.alteredGridItem}
                      >
                        {renderBus({ item: bus, index })}
                      </View>
                    ))}
                  </View>
                </View>
              );
            })}
          </>
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowAddModal(true)}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* ================= ADD BUS MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showAddModal}
        onRequestClose={() => setShowAddModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.modalScrollContent}
            >
              <Text style={styles.header}>Add Bus</Text>
              <TextInput
                placeholder="Bus Number (TN30AH5907)"
                placeholderTextColor={COLORS.textBody}
                value={busNo}
                onChangeText={setBusNo}
                style={styles.input}
              />
              <TextInput
                placeholder="Preview No (4,5,6...)"
                placeholderTextColor={COLORS.textBody}
                value={previewNumber}
                onChangeText={setPreviewNumber}
                style={styles.input}
                keyboardType="numeric"
              />
              <TextInput
                placeholder="Device ID (0867440065950925)"
                placeholderTextColor={COLORS.textBody}
                value={deviceId}
                onChangeText={setDeviceId}
                style={styles.input}
              />

              <TouchableOpacity
                style={styles.uploadBtn}
                onPress={() => pickAndParseExcel(false)}
                disabled={parsingExcel}
              >
                <Text style={styles.uploadBtnText}>
                  {parsingExcel
                    ? "Parsing..."
                    : excelFileName
                      ? "Re-upload Routes Excel"
                      : "Upload Routes Excel (Plans as columns)"}
                </Text>
              </TouchableOpacity>

              {excelFileName ? (
                <Text style={styles.fileName}>{excelFileName}</Text>
              ) : null}

              {renderPlansPreview(routesByPlan)}

              <TouchableOpacity
                style={styles.button}
                onPress={handleAddBus}
                disabled={addingBus}
              >
                {addingBus ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: "#fff", fontWeight: "600" }}>
                    Add Bus
                  </Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowAddModal(false)}
                style={styles.closeTouch}
              >
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ================= BUS OPTIONS MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showOptionsModal}
        onRequestClose={() => setShowOptionsModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView
              contentContainerStyle={styles.modalScrollContent}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.header}>Bus Options</Text>
              <Text style={styles.subHeader}>
                Bus: {getDisplayBusNumber(selectedBus)}
              </Text>

              {!selectedBus?.isTemporaryChange && (
                <>
                  <TouchableOpacity
                    style={styles.optionButton}
                    onPress={openEditDetails}
                  >
                    <Ionicons
                      name="create-outline"
                      size={20}
                      color={COLORS.primary}
                    />
                    <Text style={styles.optionText}>Edit Details</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.optionButton}
                    onPress={openEditRoutes}
                  >
                    <Ionicons
                      name="git-branch-outline"
                      size={20}
                      color={COLORS.primary}
                    />
                    <Text style={styles.optionText}>
                      Edit Routes (Re-upload Excel)
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {isSuperadmin &&
                !selectedBus?.isTemporaryChange &&
                !selectedBus?.isAltered &&
                selectedBus?.status === "active" && (
                  <Text style={styles.optionHint}>
                    Use the Temporary Bus Changes page in the web dashboard to alter or combine buses.
                  </Text>
                )}

              {isSuperadmin &&
                selectedBus?.isAltered &&
                !selectedBus?.isTemporaryChange && (
                <TouchableOpacity
                  style={styles.optionButton}
                  onPress={handleRestoreAltered}
                  disabled={restoringBus}
                >
                  <Ionicons
                    name="refresh-outline"
                    size={20}
                    color={COLORS.primary}
                  />
                  <Text style={styles.optionText}>
                    {restoringBus ? "Restoring..." : "Restore original bus"}
                  </Text>
                </TouchableOpacity>
              )}

              {selectedBus?.isTemporaryChange ? (
                <Text style={styles.optionHint}>
                  Roll back this temporary change from the Super Admin dashboard before editing or deleting these buses.
                </Text>
              ) : (
                <TouchableOpacity
                  style={[styles.optionButton, styles.deleteButton]}
                  onPress={handleDeleteBus}
                >
                  <Ionicons name="trash-outline" size={20} color={COLORS.error} />
                  <Text style={[styles.optionText, { color: COLORS.error }]}>
                    Delete
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={() => setShowOptionsModal(false)}
                style={styles.closeTouch}
              >
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ================= ALTER / COMBINE BUS MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showAlterModal}
        onRequestClose={() => setShowAlterModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>
              {busChangeMode === "combine" ? "Combine Buses" : "Alter Bus"}
            </Text>
            <Text style={styles.subHeader}>
              {busChangeMode === "combine"
                ? "Select the bus to provide the live location, then choose which route stops users should see."
                : "Select the replacement bus for live location. The original bus stops remain unchanged."}
            </Text>
            <FlatList
              data={buses.filter(
                (bus) =>
                  bus.busNo !== selectedBus?.busNo &&
                  bus.canBeTemporaryReplacement &&
                  (busChangeMode === "combine" ||
                    Number(bus.riderCount) === 0),
              )}
              keyExtractor={(item) => String(item.busNo)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.optionButton}
                  onPress={() => {
                    setAlterTargetBus(item);
                    setAlterationRoutesByPlan(null);
                    setAlterationExcelFileName("");
                    setShowAlterModal(false);
                    setShowRouteChoiceModal(true);
                  }}
                  disabled={alteringBus}
                >
                  <Ionicons
                    name="bus-outline"
                    size={20}
                    color={COLORS.primary}
                  />
                  <Text style={styles.optionText}>
                    Bus {getDisplayBusNumber(item)} · {Number(item.riderCount) || 0} riders
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  No other active buses available.
                </Text>
              }
            />
            {alteringBus && <ActivityIndicator color={COLORS.primary} />}
            <TouchableOpacity
              onPress={() => setShowAlterModal(false)}
              style={styles.closeTouch}
            >
              <Text style={styles.closeText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ================= ALTER / COMBINE ROUTE CHOICE MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showRouteChoiceModal}
        onRequestClose={() => setShowRouteChoiceModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView contentContainerStyle={styles.modalScrollContent}>
              <Text style={styles.header}>
                {busChangeMode === "combine"
                  ? "Choose the combined route"
                  : "Confirm location-only change"}
              </Text>
              <Text style={styles.subHeader}>
                {busChangeMode === "combine"
                  ? `Users of Bus ${getDisplayBusNumber(selectedBus)} and Bus ${getDisplayBusNumber(alterTargetBus)} will all use Bus ${getDisplayBusNumber(alterTargetBus)}. Choose which route the combined riders should follow.`
                  : `Only the live location changes to Bus ${getDisplayBusNumber(alterTargetBus)}. Bus ${getDisplayBusNumber(selectedBus)}'s original stops stay unchanged.`}
              </Text>
              {busChangeMode === "alter" ? (
                <TouchableOpacity
                  style={styles.button}
                  onPress={() => handleAlterBus()}
                  disabled={alteringBus}
                >
                  {alteringBus ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={{ color: "#fff", fontWeight: "600" }}>
                      Confirm location change
                    </Text>
                  )}
                </TouchableOpacity>
              ) : (
                <>
                <TouchableOpacity
                  style={styles.optionButton}
                  onPress={() => handleAlterBus("source")}
                  disabled={alteringBus || parsingAlterationExcel}
                >
                  <Ionicons name="git-branch-outline" size={20} color={COLORS.primary} />
                  <Text style={styles.optionText}>
                    Use Bus {getDisplayBusNumber(selectedBus)} routes
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.optionButton}
                  onPress={() => handleAlterBus("target")}
                  disabled={alteringBus || parsingAlterationExcel}
                >
                  <Ionicons name="git-branch-outline" size={20} color={COLORS.primary} />
                  <Text style={styles.optionText}>
                    Use Bus {getDisplayBusNumber(alterTargetBus)} routes
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.uploadBtn}
                  onPress={() => pickAndParseExcel(false, true)}
                  disabled={alteringBus || parsingAlterationExcel}
                >
                  {parsingAlterationExcel ? (
                    <ActivityIndicator color={COLORS.primary} />
                  ) : (
                    <Text style={styles.optionText}>Upload new route Excel</Text>
                  )}
                </TouchableOpacity>
                {alterationExcelFileName ? (
                  <Text style={styles.fileName}>{alterationExcelFileName}</Text>
                ) : null}
                {renderPlansPreview(alterationRoutesByPlan)}
                {alterationRoutesByPlan && (
                  <TouchableOpacity
                    style={styles.button}
                    onPress={() =>
                      handleAlterBus("custom", alterationRoutesByPlan)
                    }
                    disabled={alteringBus || parsingAlterationExcel}
                  >
                    {alteringBus ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={{ color: "#fff", fontWeight: "600" }}>
                        Confirm uploaded routes
                      </Text>
                    )}
                  </TouchableOpacity>
                )}
                </>
              )}
              {alteringBus && <ActivityIndicator color={COLORS.primary} />}
              <TouchableOpacity
                onPress={() => setShowRouteChoiceModal(false)}
                style={styles.closeTouch}
                disabled={alteringBus}
              >
                <Text style={styles.closeText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ================= EDIT DETAILS MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showEditDetailsModal}
        onRequestClose={() => setShowEditDetailsModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Edit Details</Text>
            <Text style={styles.subHeader}>
              Bus: {getDisplayBusNumber(selectedBus)}
            </Text>
            <TextInput
              placeholder="Preview No"
              placeholderTextColor={COLORS.textBody}
              value={editPreviewNumber}
              onChangeText={setEditPreviewNumber}
              style={styles.input}
              keyboardType="numeric"
            />
            <TextInput
              placeholder="Device ID"
              placeholderTextColor={COLORS.textBody}
              value={editDeviceId}
              onChangeText={setEditDeviceId}
              style={styles.input}
            />
            <TouchableOpacity
              style={styles.button}
              onPress={handleSaveDetails}
              disabled={savingDetails}
            >
              {savingDetails ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: "#fff", fontWeight: "600" }}>Save</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowEditDetailsModal(false)}
              style={styles.closeTouch}
            >
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ================= EDIT ROUTES MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showEditRoutesModal}
        onRequestClose={() => setShowEditRoutesModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.modalScrollContent}
            >
              <Text style={styles.header}>Edit Routes</Text>
              <Text style={styles.subHeader}>
                Bus: {getDisplayBusNumber(selectedBus)}
              </Text>

              <TouchableOpacity
                style={styles.uploadBtn}
                onPress={() => pickAndParseExcel(true)}
                disabled={parsingEditExcel}
              >
                <Text style={styles.uploadBtnText}>
                  {parsingEditExcel
                    ? "Parsing..."
                    : editExcelFileName
                      ? "Re-upload Routes Excel"
                      : "Upload Routes Excel (Plans as columns)"}
                </Text>
              </TouchableOpacity>

              {editExcelFileName ? (
                <Text style={styles.fileName}>{editExcelFileName}</Text>
              ) : null}

              {renderPlansPreview(editRoutesByPlan)}

              <TouchableOpacity
                style={styles.button}
                onPress={handleSaveRoutes}
                disabled={savingRoutes}
              >
                {savingRoutes ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={{ color: "#fff", fontWeight: "600" }}>
                    Save Routes
                  </Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowEditRoutesModal(false)}
                style={styles.closeTouch}
              >
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F9FAFB",
  },
  listContainer: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 110,
  },
  card: {
    marginBottom: 8,
    backgroundColor: "#fff",
    borderRadius: 100,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  title: { fontSize: 13, fontWeight: "700", color: COLORS.textHeader },
  alteredLabel: {
    fontSize: 9,
    color: COLORS.warning || "#B45309",
    marginTop: 3,
    textAlign: "center",
    paddingHorizontal: 2,
  },
  combinedSectionDescription: {
    color: COLORS.textBody,
    fontSize: 13,
    lineHeight: 18,
    marginTop: -4,
    marginBottom: 12,
  },
  alteredSectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: COLORS.textHeader,
    marginBottom: 10,
  },
  coordinateSheetPanel: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  coordinateSheetTitle: {
    color: COLORS.textHeader,
    fontSize: 15,
    fontWeight: "800",
  },
  coordinateSheetDescription: {
    color: COLORS.textBody,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    marginBottom: 8,
    flexShrink: 1,
  },
  alteredSection: {
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
  },
  alteredGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  alteredGridItem: {
    marginRight: GAP,
  },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    backgroundColor: COLORS.primary,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 6,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalBox: {
    width: "90%",
    maxHeight: "85%",
    backgroundColor: "#fff",
    padding: 20,
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 5,
  },
  modalScrollContent: {
    paddingBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    fontSize: 15,
    color: COLORS.textHeader,
  },
  button: {
    backgroundColor: COLORS.primary,
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  header: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 6,
    color: COLORS.textHeader,
  },
  subHeader: { fontSize: 13, color: COLORS.textBody, marginBottom: 16 },
  closeTouch: {
    paddingVertical: 8,
  },
  closeText: {
    textAlign: "center",
    marginTop: 6,
    color: COLORS.textBody,
    fontWeight: "600",
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderStyle: "dashed",
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    backgroundColor: "#FAFAFA",
    gap: 8,
  },
  uploadBtnText: { color: COLORS.primary, fontWeight: "600", fontSize: 14 },
  fileName: {
    fontSize: 12,
    color: COLORS.textBody,
    fontStyle: "italic",
    marginBottom: 8,
    textAlign: "center",
  },
  planPreview: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  planPreviewTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textHeader,
    marginBottom: 4,
  },
  planPreviewStops: { fontSize: 12, color: COLORS.textBody },
  emptyText: {
    textAlign: "center",
    color: COLORS.textBody,
    marginTop: 40,
    fontSize: 14,
  },
  optionButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    marginBottom: 10,
    backgroundColor: "#fff",
    gap: 12,
  },
  optionText: {
    fontSize: 15,
    color: COLORS.textHeader,
    fontWeight: "600",
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  optionCopy: { flex: 1, marginLeft: 12 },
  optionHint: {
    color: COLORS.textBody,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  deleteButton: { borderColor: "#FECACA", backgroundColor: "#FEF2F2" },
});
