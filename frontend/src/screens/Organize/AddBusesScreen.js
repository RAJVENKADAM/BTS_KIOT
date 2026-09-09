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

  // Legacy per-bus plan modal kept for compatibility, but the global plan is the only supported control.
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [planNames, setPlanNames] = useState([]);
  const [currentPlan, setCurrentPlan] = useState("PLAN A");
  const [changingPlan, setChangingPlan] = useState(false);

  const loadBuses = async () => {
    setLoading(true);
    try {
      const res = await fetch(API_BASE_URL + "/api/bus/get-all-buses", {
        headers: { Authorization: "Bearer " + token },
      });
      const rawText = await res.text();
      const data = rawText ? JSON.parse(rawText) : {};
      if (res.ok) {
        setBuses(data.buses || []);
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
  const renderBus = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => {
        setSelectedBus(item);
        setShowOptionsModal(true);
      }}
    >
      <View style={styles.cardHeaderRow}>
        <Text style={styles.title}>Bus: {getDisplayBusNumber(item)}</Text>
        <View
          style={[
            styles.dot,
            { backgroundColor: item.status === "active" ? "green" : "red" },
          ]}
        />
      </View>
      <Text style={styles.subtitle}>Preview: {getDisplayBusNumber(item)}</Text>
      <Text style={styles.subtitle}>
        Device: {item.gpsDeviceId || item.gps_device_id}
      </Text>
    </TouchableOpacity>
  );

  if (loading) return <ActivityIndicator style={{ marginTop: 50 }} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.globalPlanBar}>
        <Text style={styles.globalPlanLabel}>Active Plan</Text>
        <TouchableOpacity
          style={styles.globalPlanButton}
          onPress={openGlobalPlanModal}
        >
          <Text style={styles.globalPlanButtonText}>{globalPlan}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={buses}
        renderItem={renderBus}
        keyExtractor={(i, idx) => idx.toString()}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No buses yet. Tap + to add one.</Text>
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowAddModal(true)}
      >
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>

      {/* ================= ADD BUS MODAL ================= */}
      <Modal
        transparent
        visible={showAddModal}
        onRequestClose={() => setShowAddModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
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
                  <Text style={{ color: "#fff" }}>Add Bus</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ================= BUS OPTIONS MODAL ================= */}
      <Modal
        transparent
        visible={showOptionsModal}
        onRequestClose={() => setShowOptionsModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Bus Options</Text>
            <Text style={styles.subHeader}>Bus: {getDisplayBusNumber(selectedBus)}</Text>

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

            <TouchableOpacity onPress={() => setShowOptionsModal(false)}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ================= EDIT DETAILS MODAL ================= */}
      <Modal
        transparent
        visible={showEditDetailsModal}
        onRequestClose={() => setShowEditDetailsModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <Text style={styles.header}>Edit Details</Text>
            <Text style={styles.subHeader}>Bus: {getDisplayBusNumber(selectedBus)}</Text>
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
                <Text style={{ color: "#fff" }}>Save</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowEditDetailsModal(false)}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ================= EDIT ROUTES MODAL ================= */}
      <Modal
        transparent
        visible={showEditRoutesModal}
        onRequestClose={() => setShowEditRoutesModal(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalBox}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.header}>Edit Routes</Text>
              <Text style={styles.subHeader}>Bus: {getDisplayBusNumber(selectedBus)}</Text>

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
                  <Text style={{ color: "#fff" }}>Save Routes</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowEditRoutesModal(false)}>
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ================= GLOBAL ACTIVE PLAN MODAL ================= */}
      <Modal
        transparent
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

            <TouchableOpacity onPress={() => setShowGlobalPlanModal(false)}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: 10, padding: 15, backgroundColor: "#fff", borderRadius: 10 },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 16, fontWeight: "bold" },
  subtitle: { fontSize: 13, color: COLORS.textBody, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  planBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginTop: 8,
    gap: 4,
  },
  planBadgeText: { fontSize: 12, fontWeight: "600", color: COLORS.primary },
  globalPlanBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  globalPlanLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textHeader,
  },
  globalPlanButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
  },
  globalPlanButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  fab: {
    position: "absolute",
    bottom: 20,
    right: 20,
    backgroundColor: COLORS.primary,
    padding: 15,
    borderRadius: 30,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#00000088",
    justifyContent: "center",
    alignItems: "center",
  },
  modalBox: {
    width: "90%",
    maxHeight: "85%",
    backgroundColor: "#fff",
    padding: 20,
    borderRadius: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    fontSize: 15,
    color: COLORS.textHeader,
  },
  button: {
    backgroundColor: COLORS.primary,
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 6,
  },
  header: { fontSize: 18, fontWeight: "bold", marginBottom: 10 },
  subHeader: { fontSize: 14, color: "#666", marginBottom: 16 },
  closeText: { textAlign: "center", marginTop: 10, color: COLORS.textBody },
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
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.textHeader,
    marginBottom: 4,
  },
  planPreviewStops: { fontSize: 12, color: COLORS.textBody },
  emptyText: { textAlign: "center", color: COLORS.textBody, marginTop: 30 },
  optionButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 15,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    marginBottom: 10,
    gap: 10,
  },
  optionText: { fontSize: 15, color: COLORS.textHeader, fontWeight: "500" },
  deleteButton: { borderColor: "#FECACA", backgroundColor: "#FEF2F2" },
  activePlanButton: { borderColor: COLORS.primary, backgroundColor: "#EEF2FF" },
});
