import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../context/AuthContext";
import planMappingApi from "../api/planMappingApi";
import { COLORS, RADIUS, SPACING } from "../theme";

const PLANS = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function busLabel(bus) {
  return `Bus ${bus?.previewNumber ?? bus?.busNo ?? "—"}`;
}

function PlanMappingScreen() {
  const { token, user } = useAuth();
  const [data, setData] = useState({ buses: [], clusters: [], activePlan: "PLAN A" });
  const [selectedPlan, setSelectedPlan] = useState("PLAN B");
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [routeForm, setRouteForm] = useState(null);
  const isSuperadmin = String(user?.role || "").toLowerCase() === "superadmin";

  const load = useCallback(async (isRefresh = false) => {
    if (!token || !isSuperadmin) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await planMappingApi.get(token);
      const nextData = {
        buses: result.buses || [],
        clusters: result.clusters || [],
        activePlan: PLANS.includes(result.activePlan) ? result.activePlan : "PLAN A",
      };
      setData(nextData);
    } catch (requestError) {
      setError(requestError.message || "Could not load plan mappings.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isSuperadmin, token]);

  useEffect(() => {
    if (!isSuperadmin) {
      setError("This page is only available to super admins.");
      setLoading(false);
      return;
    }
    load();
  }, [isSuperadmin, load]);

  const clusters = useMemo(
    () => data.clusters.filter((cluster) => cluster.planName === selectedPlan),
    [data.clusters, selectedPlan],
  );
  const roots = useMemo(
    () => data.buses.filter((bus) =>
      bus.status === "active" &&
      bus.plans?.includes(selectedPlan) &&
      !data.clusters.some((cluster) =>
        cluster.planName === selectedPlan &&
        cluster.id !== form?.clusterId &&
        cluster.rootBus?.id === bus.id,
      ),
    ),
    [data.buses, data.clusters, form?.clusterId, selectedPlan],
  );
  const members = useMemo(() => {
    const mappedElsewhere = new Set(
      clusters
        .filter((cluster) => cluster.id !== form?.clusterId)
        .flatMap((cluster) => (cluster.memberBuses || []).map((bus) => bus.id)),
    );
    return data.buses.filter(
      (bus) =>
        bus.status === "active" &&
        bus.plans?.includes("PLAN A") &&
        !bus.plans?.includes(selectedPlan) &&
        !mappedElsewhere.has(bus.id),
    );
  }, [clusters, data.buses, form?.clusterId, selectedPlan]);
  const unmappedMembers = useMemo(() => {
    const mapped = new Set(clusters.flatMap((cluster) =>
      (cluster.memberBuses || []).map((bus) => bus.id),
    ));
    return members.filter((bus) => !mapped.has(bus.id));
  }, [clusters, members]);

  const openCreateForm = () => {
    setError("");
    setMessage("");
    setForm({
      clusterId: null,
      planName: selectedPlan,
      clusterName: `Cluster ${clusters.length + 1}`,
      rootBusId: "",
      locationBusId: "",
      memberBusIds: [],
    });
  };

  const openEditForm = (cluster) => {
    setError("");
    setMessage("");
    setForm({
      clusterId: cluster.id,
      planName: cluster.planName,
      clusterName: cluster.clusterName,
      rootBusId: cluster.rootBus?.id || "",
      locationBusId: cluster.locationBus?.id || "",
      memberBusIds: (cluster.memberBuses || []).map((bus) => bus.id),
    });
  };

  const updateForm = (key, value) => {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "rootBusId" && current?.locationBusId === value
        ? { locationBusId: "" }
        : {}),
    }));
  };

  const toggleMember = (busId) => {
    setForm((current) => {
      if (!current) return current;
      const selected = current.memberBusIds.includes(busId);
      return {
        ...current,
        memberBusIds: selected
          ? current.memberBusIds.filter((id) => id !== busId)
          : [...current.memberBusIds, busId],
        ...(selected || current.locationBusId !== busId
          ? {}
          : { locationBusId: "" }),
      };
    });
  };

  const saveCluster = async () => {
    if (!form) return;
    if (!form.clusterName.trim()) {
      setError("Enter a name for this cluster.");
      return;
    }
    if (!form.rootBusId) {
      setError("Choose a root bus with a route for the selected plan.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      await planMappingApi.save(token, {
        ...form,
        locationBusId: form.locationBusId || null,
        clusterName: form.clusterName.trim(),
      });
      setForm(null);
      setMessage("Cluster saved. Rider assignments remain unchanged.");
      await load(true);
    } catch (requestError) {
      const uncovered = requestError.data?.uncoveredBuses;
      setError(
        `${requestError.message || "Could not save this cluster."}${
          uncovered?.length
            ? ` Buses needing another assignment: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.`
            : ""
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const availableLocationBuses = useMemo(
    () =>
      data.buses.filter(
        (bus) =>
          bus.canBeTemporaryLocation &&
          bus.id !== form?.rootBusId &&
          !(form?.memberBusIds || []).includes(bus.id) &&
          (bus.id === form?.locationBusId || !bus.currentlyInUse),
      ),
    [data.buses, form?.locationBusId, form?.memberBusIds, form?.rootBusId],
  );

  const openRouteEditor = (cluster) => {
    setError("");
    setMessage("");
    setRouteForm({
      cluster,
      stops: (cluster.rootStops || []).map((stop) => ({
        stopName: stop.stopName || "",
        stopId: stop.stopId || "",
        arrivalTime: stop.arrivalTime || "",
      })),
    });
  };

  const updateRouteStop = (index, key, value) => {
    setRouteForm((current) => ({
      ...current,
      stops: current.stops.map((stop, stopIndex) => {
        if (stopIndex !== index) return stop;
        return {
          ...stop,
          [key]: value,
          ...(key === "stopName" ? { stopId: "" } : {}),
        };
      }),
    }));
  };

  const saveRootRoutes = async () => {
    if (!routeForm) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await planMappingApi.updateRoutes(
        token,
        routeForm.cluster.id,
        routeForm.stops,
      );
      setRouteForm(null);
      setMessage("Root route updated. Riders in this cluster have been notified.");
      await load(true);
    } catch (requestError) {
      setError(requestError.message || "Could not update the root route.");
    } finally {
      setSaving(false);
    }
  };

  const deleteCluster = (cluster) => {
    Alert.alert(
      "Delete cluster",
      `Delete "${cluster.clusterName}"? Rider coverage will be checked before it is removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSaving(true);
            setError("");
            setMessage("");
            try {
              await planMappingApi.remove(token, cluster.id);
              setMessage("Cluster deleted.");
              await load(true);
            } catch (requestError) {
              setError(requestError.message || "Could not delete this cluster.");
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  };

  const renderBusNode = (bus, options = {}) => (
    <View
      key={bus.id}
      style={[styles.busNode, options.root && styles.rootNode]}
      accessibilityLabel={`${busLabel(bus)}, ${bus.assignedUsers || 0} assigned riders`}
    >
      <View style={styles.nodeCopy}>
        <Text style={styles.nodeName}>{busLabel(bus)}</Text>
        <Text style={styles.nodeMeta}>{bus.assignedUsers || 0} assigned riders</Text>
      </View>
      {options.root ? <Text style={styles.rootBadge}>ROOT</Text> : null}
    </View>
  );

  if (!isSuperadmin) {
    return (
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>Plan mapping is only available to super admins.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={COLORS.primary}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>SUPER ADMIN ORGANIZER</Text>
            <Text style={styles.title}>Plan Mapping</Text>
            <Text style={styles.subtitle}>Build bus trees and choose the service used by riders.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            style={[styles.smallButton, saving && styles.disabledButton]}
            onPress={() => load(true)}
            disabled={saving || loading}
          >
            <Text style={styles.smallButtonText}>Refresh</Text>
          </Pressable>
        </View>

        {error ? <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text> : null}
        {message ? <Text accessibilityRole="status" style={styles.successBanner}>{message}</Text> : null}

        <View style={styles.sectionHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.sectionTitle}>Bus organizer</Text>
            <Text style={styles.sectionDescription}>Select a plan to view and edit its service tree.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={openCreateForm}
            disabled={saving || loading || selectedPlan === "PLAN A"}
            style={[
              styles.primaryButton,
              (saving || loading || selectedPlan === "PLAN A") && styles.disabledButton,
            ]}
          >
            <Text style={styles.primaryButtonText}>Create cluster</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.planTabScroll}>
          <View style={styles.planTabs}>
            {PLANS.map((plan) => (
              <Pressable
                key={plan}
                accessibilityRole="tab"
                accessibilityState={{ selected: selectedPlan === plan }}
                onPress={() => {
                  setSelectedPlan(plan);
                  setForm(null);
                  setError("");
                  setMessage("");
                }}
                style={[styles.planTab, selectedPlan === plan && styles.selectedPlanTab]}
              >
                <Text style={[styles.planTabTitle, selectedPlan === plan && styles.selectedPlanTabTitle]}>
                  {plan}
                </Text>
                <Text style={styles.planTabCaption}>
                  {plan === "PLAN A" ? "Separate buses" : "Route clusters"}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={COLORS.primary} />
            <Text style={styles.sectionDescription}>Loading routes and bus assignments…</Text>
          </View>
        ) : selectedPlan === "PLAN A" ? (
          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Separate bus service</Text>
            <Text style={styles.sectionDescription}>Plan A buses always operate independently.</Text>
            {data.buses
              .filter((bus) => bus.status === "active" && bus.plans?.includes("PLAN A"))
              .map((bus) => (
                <View key={bus.id} style={styles.separateBusCard}>
                  {renderBusNode(bus)}
                  <Text style={styles.nodeMeta}>{bus.plans?.length || 0} route set(s)</Text>
                </View>
              ))}
            {!data.buses.some((bus) => bus.status === "active" && bus.plans?.includes("PLAN A")) ? (
              <Text style={styles.emptyState}>No active Plan A buses are available.</Text>
            ) : null}
          </View>
        ) : (
          <View style={styles.organizerStack}>
            {clusters.map((cluster) => (
              <View key={cluster.id} style={styles.clusterCard}>
                <View style={styles.clusterHeader}>
                  <View style={styles.headerCopy}>
                    <Text style={styles.clusterName}>{cluster.clusterName}</Text>
                    <Text style={styles.nodeMeta}>
                      {(cluster.memberBuses || []).length + 1} buses · {selectedPlan}
                    </Text>
                  </View>
                  <View style={styles.clusterActions}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openEditForm(cluster)}
                      disabled={saving}
                      style={styles.smallButton}
                    >
                      <Text style={styles.smallButtonText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => deleteCluster(cluster)}
                      disabled={saving}
                      style={styles.smallButton}
                    >
                      <Text style={styles.dangerButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.tree}>
                  <View style={styles.rootActions}>
                    <Text style={styles.nodeGroupLabel}>ROOT · ROUTE SOURCE</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openRouteEditor(cluster)}
                      disabled={saving}
                      style={styles.smallButton}
                    >
                      <Text style={styles.smallButtonText}>Edit routes</Text>
                    </Pressable>
                  </View>
                  {cluster.rootBus ? (
                    renderBusNode(cluster.rootBus, { root: true })
                  ) : (
                    <Text style={styles.errorText}>This cluster has no root bus.</Text>
                  )}
                  {cluster.locationBus ? (
                    <Text style={styles.nodeMeta}>
                      Temporary live location: {busLabel(cluster.locationBus)}
                    </Text>
                  ) : null}
                  {cluster.rootStops?.length ? (
                    <View style={styles.stopList}>
                      <Text style={styles.stopListTitle}>Root stops and arrival times</Text>
                      {cluster.rootStops.map((stop) => (
                        <View key={`${stop.stopOrder}-${stop.stopName}`} style={styles.stopRow}>
                          <Text style={styles.stopName}>{stop.stopOrder}. {stop.stopName}</Text>
                          <Text style={styles.stopTime}>{stop.arrivalTime || "Time not uploaded"}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  <View style={styles.memberGroup}>
                    <Text style={styles.nodeGroupLabel}>MAPPED BUSES · SHARE ROOT SERVICE</Text>
                    {(cluster.memberBuses || []).length ? (
                      <View style={styles.memberList}>
                        {cluster.memberBuses.map((bus) => renderBusNode(bus))}
                      </View>
                    ) : (
                      <Text style={styles.emptyMember}>No mapped buses yet.</Text>
                    )}
                  </View>
                </View>
              </View>
            ))}
            {!clusters.length && !loading ? (
              <Text style={styles.emptyState}>
                No clusters for {selectedPlan}. Create one, choose a root bus with that route, and add Plan A-only buses.
              </Text>
            ) : null}
          </View>
        )}

        {selectedPlan !== "PLAN A" && !loading ? (
          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Unmapped Plan A buses</Text>
            <Text style={styles.sectionDescription}>
              Edit a cluster and select a bus to add it to that root service.
            </Text>
            {unmappedMembers.length ? (
              <View style={styles.memberList}>
                {unmappedMembers.map((bus) => renderBusNode(bus))}
              </View>
            ) : (
              <Text style={styles.emptyMember}>All active Plan A-only buses are mapped.</Text>
            )}
          </View>
        ) : null}

        <Text style={styles.footerNote}>
          Buses and route stops come from the existing Excel upload workflow in Organize → Buses.
        </Text>
      </ScrollView>

      <Modal
        visible={Boolean(form)}
        transparent
        animationType="slide"
        onRequestClose={() => setForm(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{form?.clusterId ? "Edit cluster" : "Create cluster"}</Text>
              <Text style={styles.sectionDescription}>
                Choose the service root and the Plan A-only buses that should share its route.
              </Text>
              <Text style={styles.fieldLabel}>Cluster name</Text>
              <TextInput
                value={form?.clusterName || ""}
                onChangeText={(value) => updateForm("clusterName", value)}
                style={styles.textInput}
                placeholder="e.g. North route"
                maxLength={80}
              />

              <Text style={styles.fieldLabel}>Root bus · requires {selectedPlan} route</Text>
              {roots.map((bus) => (
                <Pressable
                  key={bus.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: form?.rootBusId === bus.id }}
                  onPress={() => updateForm("rootBusId", bus.id)}
                  style={[
                    styles.selectionNode,
                    form?.rootBusId === bus.id && styles.selectedNode,
                  ]}
                >
                  {renderBusNode(bus, { root: true })}
                  <Text style={styles.nodeMeta}>{bus.plans.join(", ")}</Text>
                </Pressable>
              ))}
              {!roots.length ? (
                <Text style={styles.emptyMember}>No active buses have a {selectedPlan} route.</Text>
              ) : null}

              <Text style={styles.fieldLabel}>Plan A-only member buses</Text>
              {members.map((bus) => {
                const checked = form?.memberBusIds.includes(bus.id) || false;
                return (
                  <Pressable
                    key={bus.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    onPress={() => toggleMember(bus.id)}
                    style={[styles.selectionNode, checked && styles.selectedNode]}
                  >
                    {renderBusNode(bus)}
                  </Pressable>
                );
              })}
              {!members.length ? (
                <Text style={styles.emptyMember}>No available Plan A-only buses for this service.</Text>
              ) : null}

              <Text style={styles.fieldLabel}>Temporary live-location bus (optional)</Text>
              <Text style={styles.sectionDescription}>
                Route stops stay with the root. Select an available bus with no riders currently using it.
              </Text>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: !form?.locationBusId }}
                onPress={() => updateForm("locationBusId", "")}
                style={[styles.selectionNode, !form?.locationBusId && styles.selectedNode]}
              >
                <Text style={styles.nodeName}>Use root bus location</Text>
              </Pressable>
              {availableLocationBuses.map((bus) => (
                <Pressable
                  key={bus.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: form?.locationBusId === bus.id }}
                  onPress={() => updateForm("locationBusId", bus.id)}
                  style={[
                    styles.selectionNode,
                    form?.locationBusId === bus.id && styles.selectedNode,
                  ]}
                >
                  {renderBusNode(bus)}
                </Pressable>
              ))}
              {!availableLocationBuses.length ? (
                <Text style={styles.emptyMember}>No spare buses are currently available.</Text>
              ) : null}

              {error ? <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text> : null}
              <View style={styles.modalActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setForm(null)}
                  disabled={saving}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={saveCluster}
                  disabled={saving || !roots.length}
                  style={[styles.primaryButton, (saving || !roots.length) && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>{saving ? "Saving…" : "Save tree"}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        visible={Boolean(routeForm)}
        transparent
        animationType="slide"
        onRequestClose={() => setRouteForm(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>Edit root route</Text>
              <Text style={styles.sectionDescription}>
                Use existing stop names. New stops must be verified. Arrival time format: 8:10AM.
              </Text>
              {error ? <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text> : null}
              {(routeForm?.stops || []).map((stop, index) => (
                <View key={`route-stop-${index}`} style={styles.routeEditorRow}>
                  <TextInput
                    value={stop.stopName}
                    onChangeText={(value) => updateRouteStop(index, "stopName", value)}
                    style={[styles.textInput, styles.routeStopName]}
                    placeholder={`Stop ${index + 1}`}
                  />
                  <TextInput
                    value={stop.arrivalTime}
                    onChangeText={(value) => updateRouteStop(index, "arrivalTime", value)}
                    style={[styles.textInput, styles.routeStopTime]}
                    placeholder="8:10AM"
                    autoCapitalize="characters"
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setRouteForm((current) => ({
                        ...current,
                        stops: current.stops.filter((_, stopIndex) => stopIndex !== index),
                      }))
                    }
                    style={styles.smallButton}
                  >
                    <Text style={styles.dangerButtonText}>Remove</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  setRouteForm((current) => ({
                    ...current,
                    stops: [...current.stops, { stopName: "", stopId: "", arrivalTime: "" }],
                  }))
                }
                disabled={(routeForm?.stops || []).length >= 100}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Add stop</Text>
              </Pressable>
              <View style={styles.modalActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setRouteForm(null)}
                  disabled={saving}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={saveRootRoutes}
                  disabled={saving || !routeForm?.stops.length}
                  style={[styles.primaryButton, (saving || !routeForm?.stops.length) && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>{saving ? "Saving…" : "Save routes"}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.m, paddingBottom: 36, gap: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: SPACING.m },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: COLORS.textBody, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: COLORS.textHeader, fontSize: 27, fontWeight: "800", marginTop: 4 },
  subtitle: { color: COLORS.textBody, fontSize: 14, lineHeight: 20, marginTop: 5 },
  panel: {
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.card,
    backgroundColor: COLORS.white,
  },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  sectionTitle: { color: COLORS.textHeader, fontSize: 17, fontWeight: "800" },
  sectionDescription: { color: COLORS.textBody, fontSize: 12, lineHeight: 18, marginTop: 4 },
  primaryButton: { alignItems: "center", justifyContent: "center", backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11 },
  primaryButtonText: { color: COLORS.white, fontSize: 12, fontWeight: "800" },
  secondaryButton: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 15, paddingVertical: 11 },
  secondaryButtonText: { color: COLORS.textHeader, fontSize: 12, fontWeight: "700" },
  smallButton: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  smallButtonText: { color: COLORS.textHeader, fontSize: 11, fontWeight: "700" },
  dangerButtonText: { color: COLORS.error, fontSize: 11, fontWeight: "700" },
  disabledButton: { opacity: 0.55 },
  planTabScroll: { flexGrow: 0 },
  planTabs: { flexDirection: "row", gap: 8 },
  planTab: { minWidth: 112, padding: 10, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, backgroundColor: COLORS.white },
  selectedPlanTab: { borderColor: COLORS.primary, backgroundColor: "#EFF6FF" },
  planTabTitle: { color: COLORS.textHeader, fontSize: 12, fontWeight: "800" },
  selectedPlanTabTitle: { color: COLORS.primary },
  planTabCaption: { color: COLORS.textBody, fontSize: 10, marginTop: 4 },
  organizerStack: { gap: 12 },
  clusterCard: { overflow: "hidden", borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, backgroundColor: COLORS.white },
  clusterHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, padding: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  clusterName: { color: COLORS.textHeader, fontSize: 14, fontWeight: "800" },
  clusterActions: { flexDirection: "row", gap: 6 },
  tree: { padding: 12, gap: 9 },
  rootActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  routeEditorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  routeStopName: { flex: 1 },
  routeStopTime: { width: 92 },
  nodeGroupLabel: { color: COLORS.textBody, fontSize: 9, fontWeight: "800", letterSpacing: 0.7 },
  busNode: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderWidth: 1, borderColor: "#CBD7E7", borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 11, paddingVertical: 9 },
  rootNode: { borderWidth: 2, borderColor: "#88AEF4", backgroundColor: "#F4F8FF" },
  nodeCopy: { flex: 1 },
  nodeName: { color: COLORS.textHeader, fontSize: 13, fontWeight: "800" },
  nodeMeta: { color: COLORS.textBody, fontSize: 10, marginTop: 3 },
  rootBadge: { color: COLORS.primary, backgroundColor: "#E5EFFF", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 4, fontSize: 9, fontWeight: "800" },
  stopList: { padding: 10, borderWidth: 1, borderColor: COLORS.border, borderRadius: 9, backgroundColor: "#FBFCFE" },
  stopListTitle: { color: COLORS.textHeader, fontSize: 11, fontWeight: "700", marginBottom: 6 },
  stopRow: { flexDirection: "row", justifyContent: "space-between", gap: 8, paddingVertical: 5, borderTopWidth: 1, borderTopColor: COLORS.border },
  stopName: { flex: 1, color: COLORS.textBody, fontSize: 10 },
  stopTime: { color: COLORS.primary, fontSize: 10, fontWeight: "700" },
  memberGroup: { padding: 10, gap: 8, borderWidth: 1, borderColor: "#D5DEEB", borderRadius: 10, backgroundColor: "#FBFCFE" },
  memberList: { gap: 8 },
  emptyMember: { color: COLORS.textBody, fontSize: 11, paddingVertical: 8 },
  emptyState: { color: COLORS.textBody, fontSize: 12, lineHeight: 18, textAlign: "center", padding: 18, borderWidth: 1, borderStyle: "dashed", borderColor: COLORS.border, borderRadius: 10 },
  separateBusCard: { gap: 4, marginTop: 10, padding: 9, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10 },
  footerNote: { color: COLORS.textBody, fontSize: 10, lineHeight: 15, textAlign: "center", paddingHorizontal: 8 },
  loadingState: { alignItems: "center", gap: 8, paddingVertical: 40 },
  errorText: { color: COLORS.error, fontSize: 13, textAlign: "center" },
  errorBanner: { color: "#9F1D17", backgroundColor: "#FFF0F0", borderWidth: 1, borderColor: "#FECACA", borderRadius: 9, padding: 10, fontSize: 11, lineHeight: 16 },
  successBanner: { color: "#166534", backgroundColor: "#ECFDF3", borderWidth: 1, borderColor: "#BBF7D0", borderRadius: 9, padding: 10, fontSize: 11, lineHeight: 16 },
  modalOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15, 23, 42, 0.48)" },
  modalCard: { maxHeight: "92%", padding: 18, borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: COLORS.white },
  modalTitle: { color: COLORS.textHeader, fontSize: 20, fontWeight: "800", marginBottom: 4 },
  fieldLabel: { color: COLORS.textHeader, fontSize: 12, fontWeight: "700", marginTop: 16, marginBottom: 7 },
  textInput: { minHeight: 44, paddingHorizontal: 11, borderWidth: 1, borderColor: COLORS.border, borderRadius: 9, color: COLORS.textHeader, backgroundColor: COLORS.white },
  selectionNode: { marginTop: 7, padding: 5, borderWidth: 1, borderColor: COLORS.border, borderRadius: 11 },
  selectedNode: { borderWidth: 2, borderColor: COLORS.primary, backgroundColor: "#F4F8FF" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 18, paddingBottom: 10 },
});

export default PlanMappingScreen;
