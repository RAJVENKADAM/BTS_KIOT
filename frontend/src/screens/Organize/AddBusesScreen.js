import React, { useState, useEffect } from "react";
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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
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
import { getErrorMessage } from "../../utils/errorHandler";
import { getDisplayBusNumber } from "../../utils/busDisplay";

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
  const { token } = useAuth();

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

  // Bus options modal
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [selectedBus, setSelectedBus] = useState(null);

  // Edit details modal
  const [showEditDetailsModal, setShowEditDetailsModal] = useState(false);
  const [editPreviewNumber, setEditPreviewNumber] = useState("");
  const [editDeviceId, setEditDeviceId] = useState("");
  const [editRegNo, setEditRegNo] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);

  // Edit routes modal
  const [showEditRoutesModal, setShowEditRoutesModal] = useState(false);
  const [editRoutesByPlan, setEditRoutesByPlan] = useState(null);
  const [editExcelFileName, setEditExcelFileName] = useState("");
  const [parsingEditExcel, setParsingEditExcel] = useState(false);
  const [savingRoutes, setSavingRoutes] = useState(false);

  // Global active plan
  const [showGlobalPlanModal, setShowGlobalPlanModal] = useState(false);
  const [globalPlan, setGlobalPlan] = useState("PLAN A");
  const [savingGlobalPlan, setSavingGlobalPlan] = useState(false);

  const loadBuses = async () => {
    setLoading(true);
    try {
      const res = await fetch(API_BASE_URL + "/api/bus/get-all-buses", {
        headers: { Authorization: "Bearer " + token },
      });
      const rawText = await res.text();
      const data = rawText ? JSON.parse(rawText) : {};
      if (res.ok) {
        const loadedBuses = data.buses || [];
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
      } else {
        const err = new Error(data.error || "Failed to load buses");
        err.status = res.status;
        throw err;
      }
    } catch (e) {
      Alert.alert(
        "Error loading buses",
        getErrorMessage(e, "Could not load the bus list."),
      );
    }
    setLoading(false);
  };

  useEffect(() => {
    loadBuses();
    const loadGlobalPlan = async () => {
      try {
        const data = await busApi.getGlobalActivePlan(token);
        if (data?.activePlan)
          setGlobalPlan(String(data.activePlan).toUpperCase());
      } catch (e) {
        console.log("Failed to load active plan:", e.message);
      }
    };
    loadGlobalPlan();
  }, [token]);

  // ---------- Excel parsing helpers ----------
  const pickAndParseExcel = async (isEdit) => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const file = res.assets && res.assets[0];
      if (!file) return;

      if (isEdit) setParsingEditExcel(true);
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

      if (isEdit) {
        setEditRoutesByPlan(plans);
        setEditExcelFileName(file.name);
      } else {
        setRoutesByPlan(plans);
        setExcelFileName(file.name);
      }
    } catch (e) {
      Alert.alert("Parse Error", e?.message || "Failed to parse Excel");
    } finally {
      if (isEdit) setParsingEditExcel(false);
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
  const handleAddBus = async () => {
    if (!busNo.trim() || !deviceId.trim()) {
      return Alert.alert("Bus No and Device ID required");
    }
    setAddingBus(true);
    try {
      const payload = {
        busNo: busNo.trim().toUpperCase(),
        previewNumber: previewNumber.trim() || null,
        deviceId: deviceId.trim(),
        regNo: null,
        routesByPlan: routesByPlan || {},
      };
      await importBusRoutesExcelJson({ token, busPayload: payload });
      Alert.alert("Success", "Bus added successfully");
      setShowAddModal(false);
      setBusNo("");
      setPreviewNumber("");
      setDeviceId("");
      setRoutesByPlan(null);
      setExcelFileName("");
      loadBuses();
    } catch (e) {
      Alert.alert("Failed", getErrorMessage(e, "Could not add the bus."));
    } finally {
      setAddingBus(false);
    }
  };

  // ---------- Edit details ----------
  const openEditDetails = () => {
    setEditPreviewNumber(selectedBus?.previewNumber || "");
    setEditDeviceId(
      selectedBus?.gpsDeviceId || selectedBus?.gps_device_id || "",
    );
    setEditRegNo(selectedBus?.regNo || "");
    setShowOptionsModal(false);
    setShowEditDetailsModal(true);
  };

  const handleSaveDetails = async () => {
    setSavingDetails(true);
    try {
      await busApi.updateBusDetails(token, selectedBus.busNo, {
        previewNumber: editPreviewNumber.trim() || null,
        gpsDeviceId: editDeviceId.trim(),
        regNo: editRegNo.trim() || null,
      });
      Alert.alert("Success", "Bus details updated");
      setShowEditDetailsModal(false);
      loadBuses();
    } catch (e) {
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

  const handleSaveRoutes = async () => {
    if (!editRoutesByPlan) {
      return Alert.alert("Missing Routes", "Please upload Excel routes first");
    }
    setSavingRoutes(true);
    try {
      await importBusRoutesExcelJson({
        token,
        busPayload: {
          busNo: selectedBus.busNo,
          previewNumber: selectedBus.previewNumber || null,
          deviceId: selectedBus.gpsDeviceId || selectedBus.gps_device_id || "",
          regNo: selectedBus.regNo || null,
          routesByPlan: editRoutesByPlan,
          replaceRoutes: true,
        },
      });
      Alert.alert("Success", "Routes updated");
      setShowEditRoutesModal(false);
    } catch (e) {
      Alert.alert("Failed", getErrorMessage(e, "Could not update the routes."));
    } finally {
      setSavingRoutes(false);
    }
  };

  // ---------- Global active plan ----------
  const openGlobalPlanModal = async () => {
    setShowOptionsModal(false);
    try {
      const data = await busApi.getGlobalActivePlan(token);
      if (data?.activePlan)
        setGlobalPlan(String(data.activePlan).toUpperCase());
    } catch (e) {
      console.log("Failed to load active plan for global modal:", e.message);
    }
    setShowGlobalPlanModal(true);
  };

  const handleSelectGlobalPlan = async (plan) => {
    if (plan === globalPlan) return;
    setSavingGlobalPlan(true);
    try {
      const data = await busApi.setGlobalActivePlan(token, plan);
      setGlobalPlan(String(data?.activePlan || plan).toUpperCase());
      setShowGlobalPlanModal(false);
      loadBuses();
    } catch (e) {
      Alert.alert(
        "Failed",
        getErrorMessage(e, "Could not update the global plan."),
      );
    } finally {
      setSavingGlobalPlan(false);
    }
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
              const res = await fetch(
                API_BASE_URL + "/api/bus/delete-bus/" + selectedBus?.busNo,
                {
                  method: "DELETE",
                  headers: { Authorization: "Bearer " + token },
                },
              );
              if (res.ok) {
                setShowOptionsModal(false);
                loadBuses();
              } else {
                const rawText = await res.text();
                const data = rawText ? JSON.parse(rawText) : {};
                Alert.alert(
                  "Error",
                  getErrorMessage(
                    {
                      ...new Error(data.error || "Failed to delete bus"),
                      status: res.status,
                    },
                    "Failed to delete the bus.",
                  ),
                );
              }
            } catch (e) {
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
          {item.previewNumber ?? ""}
        </Text>
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
        data={buses}
        renderItem={renderBus}
        keyExtractor={(i, idx) =>
          i?.id?.toString() || i?.busNo?.toString() || idx.toString()
        }
        numColumns={5}
        contentContainerStyle={styles.listContainer}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No buses yet. Tap + to add one.</Text>
        }
      />

      <TouchableOpacity
        style={styles.routeFab}
        onPress={openGlobalPlanModal}
        activeOpacity={0.8}
      >
        <Ionicons name="git-branch-outline" size={20} color="#fff" />
        <Text style={styles.routeFabText}>{globalPlan}</Text>
      </TouchableOpacity>

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
            <Text style={styles.header}>Bus Options</Text>
            <Text style={styles.subHeader}>
              Bus: {getDisplayBusNumber(selectedBus)}
            </Text>

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

            <TouchableOpacity
              style={[styles.optionButton, styles.deleteButton]}
              onPress={handleDeleteBus}
            >
              <Ionicons name="trash-outline" size={20} color={COLORS.error} />
              <Text style={[styles.optionText, { color: COLORS.error }]}>
                Delete
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setShowOptionsModal(false)}
              style={styles.closeTouch}
            >
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
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

      {/* ================= GLOBAL ACTIVE PLAN MODAL ================= */}
      <Modal
        transparent
        animationType="fade"
        visible={showGlobalPlanModal}
        onRequestClose={() => setShowGlobalPlanModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Set Active Route Plan</Text>
            <Text style={styles.subHeader}>
              This applies to the whole app. Only buses under the active plan
              are treated as active.
            </Text>

            {["PLAN A", "PLAN B", "PLAN C", "PLAN D"].map((plan) => {
              const active = plan === globalPlan;
              return (
                <TouchableOpacity
                  key={plan}
                  style={[
                    styles.optionButton,
                    active && styles.activePlanButton,
                  ]}
                  onPress={() => handleSelectGlobalPlan(plan)}
                  disabled={savingGlobalPlan}
                >
                  <Ionicons
                    name={active ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={active ? COLORS.primary : COLORS.textBody}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      active && { color: COLORS.primary },
                    ]}
                  >
                    {plan}
                  </Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              onPress={() => setShowGlobalPlanModal(false)}
              style={styles.closeTouch}
            >
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
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
  routeFab: {
    position: "absolute",
    bottom: 90,
    right: 24,
    backgroundColor: COLORS.primary,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    height: 48,
    borderRadius: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 5,
    gap: 8,
  },
  routeFabText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
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
  optionText: { fontSize: 15, color: COLORS.textHeader, fontWeight: "600" },
  deleteButton: { borderColor: "#FECACA", backgroundColor: "#FEF2F2" },
  activePlanButton: { borderColor: COLORS.primary, backgroundColor: "#EEF2FF" },
});
