import React, { useCallback, useEffect, useMemo, useState } from "react";
import planMappingApi from "../api/planMappingApi";
import { useAuth } from "../context/AuthContext";

const PLANS = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function busLabel(bus) {
  return `Bus ${bus?.previewNumber ?? bus?.busNo ?? "—"}`;
}

export default function PlanMappingScreen({ navigation }) {
  const { token, user } = useAuth();
  const [data, setData] = useState({ buses: [], clusters: [], activePlan: "PLAN A" });
  const [selectedPlan, setSelectedPlan] = useState("PLAN B");
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await planMappingApi.get(token);
      setData(result);
      setSelectedPlan((current) =>
        PLANS.includes(current) ? current : result.activePlan,
      );
    } catch (requestError) {
      setError(requestError.message || "Could not load plan mappings.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (String(user?.role || "").toLowerCase() !== "superadmin") {
      setError("This page is only available to super admins.");
      setLoading(false);
      return;
    }
    load();
  }, [load, user?.role]);

  const clusters = useMemo(
    () => data.clusters.filter((cluster) => cluster.planName === selectedPlan),
    [data.clusters, selectedPlan],
  );
  const roots = useMemo(
    () =>
      data.buses.filter(
        (bus) =>
          bus.status === "active" &&
          bus.plans.includes(selectedPlan),
      ),
    [data.buses, selectedPlan],
  );
  const mappedMemberIds = useMemo(
    () => new Set(clusters.flatMap((cluster) => cluster.memberBuses.map((bus) => bus.id))),
    [clusters],
  );
  const members = useMemo(
    () =>
      data.buses.filter(
        (bus) =>
          bus.status === "active" &&
          bus.plans.includes("PLAN A") &&
          !bus.plans.includes(selectedPlan),
      ),
    [data.buses, selectedPlan],
  );

  const updateForm = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const createCluster = () => {
    setError("");
    setMessage("");
    setForm({
      clusterId: null,
      planName: selectedPlan,
      clusterName: `Cluster ${clusters.length + 1}`,
      rootBusId: "",
      memberBusIds: [],
    });
  };

  const editCluster = (cluster) => {
    setError("");
    setMessage("");
    setForm({
      clusterId: cluster.id,
      planName: cluster.planName,
      clusterName: cluster.clusterName,
      rootBusId: cluster.rootBus?.id || "",
      memberBusIds: cluster.memberBuses.map((bus) => bus.id),
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await planMappingApi.save(token, form);
      setForm(null);
      setMessage("Cluster saved. The mapping is now available to the bus service.");
      await load();
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

  const removeCluster = async (cluster) => {
    if (!window.confirm(`Delete "${cluster.clusterName}"?`)) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await planMappingApi.remove(token, cluster.id);
      setMessage("Cluster deleted.");
      if (form?.clusterId === cluster.id) setForm(null);
      await load();
    } catch (requestError) {
      setError(requestError.message || "Could not delete this cluster.");
    } finally {
      setSaving(false);
    }
  };

  const changeGlobalPlan = async (plan) => {
    if (plan === data.activePlan) return;
    if (!window.confirm(`Switch the operating service to ${plan}? Assigned users will be notified.`)) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await planMappingApi.setActivePlan(token, plan);
      setMessage("Operating plan changed. Affected users have been notified.");
      await load();
    } catch (requestError) {
      const uncovered = requestError.data?.uncoveredBuses;
      setError(
        `${requestError.message || "Could not change the operating plan."}${
          uncovered?.length
            ? ` Map these buses first: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.`
            : ""
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const onDragStart = (event, busId) => {
    event.dataTransfer.setData("text/plain", busId);
    event.dataTransfer.effectAllowed = "move";
  };

  const moveBusToCluster = (event, cluster) => {
    event.preventDefault();
    const busId = event.dataTransfer.getData("text/plain");
    const bus = data.buses.find((item) => item.id === busId);
    if (!bus) return;
    if (bus.plans.includes(selectedPlan)) {
      setForm({
        clusterId: cluster.id,
        planName: selectedPlan,
        clusterName: cluster.clusterName,
        rootBusId: bus.id,
        memberBusIds: cluster.memberBuses
          .filter((member) => member.plans.includes("PLAN A"))
          .map((member) => member.id),
      });
      setMessage(`${busLabel(bus)} selected as the new root. Review and save the cluster.`);
      return;
    }
    if (!bus.plans.includes("PLAN A") || bus.plans.includes(selectedPlan)) {
      setError("Only a Plan A-only bus can be added as a cluster node.");
      return;
    }
    setForm((current) => {
      if (current?.clusterId === cluster.id) {
        return {
          ...current,
          memberBusIds: [...new Set([...current.memberBusIds, busId])],
        };
      }
      return {
        clusterId: cluster.id,
        planName: selectedPlan,
        clusterName: cluster.clusterName,
        rootBusId: cluster.rootBus?.id || "",
        memberBusIds: [
          ...new Set([
            ...cluster.memberBuses.map((member) => member.id),
            busId,
          ]),
        ],
      };
    });
    setMessage(`${busLabel(bus)} moved into "${cluster.clusterName}". Save to apply it.`);
  };

  const unmapBus = (event) => {
    event.preventDefault();
    const busId = event.dataTransfer.getData("text/plain");
    const cluster = clusters.find((item) =>
      item.memberBuses.some((bus) => bus.id === busId),
    );
    if (!cluster) return;
    setForm({
      clusterId: cluster.id,
      planName: selectedPlan,
      clusterName: cluster.clusterName,
      rootBusId: cluster.rootBus?.id || "",
      memberBusIds: cluster.memberBuses
        .filter((bus) => bus.id !== busId)
        .map((bus) => bus.id),
    });
    setMessage("Node removed from the cluster. Save to apply it.");
  };

  if (String(user?.role || "").toLowerCase() !== "superadmin") {
    return <main className="pm-page"><p className="pm-alert error">{error || "Super-admin access required."}</p></main>;
  }

  return (
    <main className="pm-page">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f5f8fc; color: #172033; font-family: Inter, ui-sans-serif, system-ui, Segoe UI, sans-serif; }
        .pm-page { min-height: 100vh; padding: 28px clamp(16px, 4vw, 56px) 48px; }
        .pm-shell { max-width: 1440px; margin: 0 auto; }
        .pm-top { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:28px; }
        .pm-brand { display:flex; align-items:center; gap:12px; }
        .pm-mark { display:grid; place-items:center; width:42px; height:42px; border-radius:14px; background:#1f78d1; color:#fff; font-size:20px; font-weight:800; }
        .pm-brand strong { display:block; font-size:17px; }
        .pm-brand small { display:block; color:#64748b; margin-top:3px; }
        .pm-button { border:0; border-radius:11px; padding:11px 15px; background:#1f78d1; color:#fff; cursor:pointer; font-weight:700; }
        .pm-button:disabled { opacity:.55; cursor:wait; }
        .pm-button.secondary { background:#e9f2fc; color:#155ea9; }
        .pm-button.danger { background:#fff0f0; color:#b42318; }
        .pm-heading { display:flex; justify-content:space-between; align-items:end; gap:20px; margin-bottom:22px; }
        .pm-heading h1 { margin:0 0 7px; font-size:clamp(25px,3vw,34px); letter-spacing:-.04em; }
        .pm-heading p { margin:0; color:#64748b; }
        .pm-global { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:14px; background:#fff; border:1px solid #e2e8f0; border-radius:16px; }
        .pm-global strong { margin-right:6px; font-size:13px; }
        .pm-plan { border:1px solid #d5deea; background:#fff; color:#475569; border-radius:999px; padding:9px 15px; cursor:pointer; font-weight:700; }
        .pm-plan.active { color:#fff; border-color:#1f78d1; background:#1f78d1; }
        .pm-plan.selected { box-shadow:0 0 0 3px #bfdbfe; }
        .pm-layout { display:grid; grid-template-columns:minmax(0, 1fr) 360px; gap:20px; margin-top:20px; align-items:start; }
        .pm-panel { border:1px solid #e2e8f0; background:#fff; border-radius:18px; box-shadow:0 10px 28px rgba(15,23,42,.04); }
        .pm-panel-head { padding:18px 20px; border-bottom:1px solid #edf1f6; display:flex; justify-content:space-between; align-items:center; gap:12px; }
        .pm-panel-head h2 { margin:0; font-size:17px; }
        .pm-panel-head p { margin:4px 0 0; color:#64748b; font-size:13px; }
        .pm-cluster-list { padding:16px; display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:15px; }
        .pm-cluster { border:1px solid #dce5ef; border-radius:16px; overflow:hidden; background:#fff; }
        .pm-root { padding:16px; background:#eff6ff; border-bottom:1px solid #dbeafe; outline:none; }
        .pm-root:focus,.pm-root.dragover { box-shadow:inset 0 0 0 2px #1f78d1; }
        .pm-root-label { text-transform:uppercase; font-size:10px; letter-spacing:.12em; color:#64748b; font-weight:800; }
        .pm-root strong { display:block; margin-top:6px; font-size:16px; }
        .pm-root small { display:block; margin-top:4px; color:#64748b; }
        .pm-members { padding:13px 15px; min-height:90px; }
        .pm-members-label { color:#64748b; font-size:12px; font-weight:700; margin-bottom:10px; }
        .pm-nodes { display:flex; flex-wrap:wrap; gap:8px; }
        .pm-node { display:inline-flex; align-items:center; gap:8px; border:1px solid #d8e2ee; border-radius:999px; background:#fff; padding:8px 11px; cursor:grab; color:#334155; font-size:13px; font-weight:700; }
        .pm-node:active { cursor:grabbing; }
        .pm-node span { color:#64748b; font-size:11px; font-weight:500; }
        .pm-cluster-foot { display:flex; justify-content:space-between; align-items:center; padding:11px 14px; background:#fafcff; border-top:1px solid #edf1f6; }
        .pm-stops { padding:12px 15px; background:#fbfdff; border-top:1px solid #edf1f6; }
        .pm-stops summary { cursor:pointer; color:#475569; font-size:12px; font-weight:700; }
        .pm-stop { display:flex; justify-content:space-between; gap:12px; padding:6px 0; font-size:12px; color:#334155; }
        .pm-stop time { color:#1f78d1; font-weight:700; }
        .pm-side { padding:19px; position:sticky; top:16px; }
        .pm-side h2 { margin:0 0 6px; font-size:17px; }
        .pm-side p { margin:0 0 16px; color:#64748b; font-size:13px; line-height:1.5; }
        .pm-field { display:grid; gap:7px; margin-bottom:14px; }
        .pm-field label { color:#334155; font-size:12px; font-weight:750; }
        .pm-field input,.pm-field select { width:100%; min-height:42px; padding:9px 11px; border:1px solid #d7e0eb; border-radius:10px; background:#fff; font:inherit; }
        .pm-available { margin-top:22px; padding:14px; border:1px dashed #b8c8d9; border-radius:13px; background:#f8fafc; }
        .pm-available strong { display:block; margin-bottom:9px; font-size:12px; }
        .pm-available .pm-nodes { max-height:210px; overflow:auto; }
        .pm-alert { padding:12px 14px; margin:16px 0 0; border-radius:11px; font-size:13px; line-height:1.5; }
        .pm-alert.error { background:#fff0f0; color:#9f1d17; border:1px solid #fecaca; }
        .pm-alert.success { background:#ecfdf3; color:#166534; border:1px solid #bbf7d0; }
        .pm-empty { margin:16px; padding:22px; text-align:center; color:#64748b; border:1px dashed #cbd5e1; border-radius:13px; }
        .pm-loading { padding:50px 20px; text-align:center; color:#64748b; }
        @media (max-width: 900px) { .pm-layout { grid-template-columns:1fr; } .pm-side { position:static; } }
        @media (max-width: 560px) { .pm-page { padding:16px 12px 32px; } .pm-top,.pm-heading { align-items:flex-start; flex-direction:column; } .pm-global { align-items:flex-start; } .pm-panel-head { align-items:flex-start; flex-direction:column; } }
      `}</style>
      <div className="pm-shell">
        <header className="pm-top">
          <div className="pm-brand">
            <div className="pm-mark">B</div>
            <div><strong>BTMS · Super Admin</strong><small>Service mapping and daily operations</small></div>
          </div>
          <button className="pm-button secondary" onClick={() => navigation.goBack()}>
            Back to app
          </button>
        </header>

        <div className="pm-heading">
          <div>
            <h1>Plan Mapping</h1>
            <p>Create bus clusters and choose the service used by mapped riders.</p>
          </div>
          <button className="pm-button secondary" onClick={load} disabled={loading || saving}>
            Refresh data
          </button>
        </div>

        <section className="pm-global" aria-label="Global operating service">
          <strong>Operating service</strong>
          {PLANS.map((plan) => (
            <button
              key={plan}
              className={`pm-plan ${data.activePlan === plan ? "active" : ""} ${selectedPlan === plan ? "selected" : ""}`}
              disabled={saving}
              onClick={() => {
                setSelectedPlan(plan);
                changeGlobalPlan(plan);
              }}
            >
              {plan === "PLAN A" ? "A · Separate buses" : plan}
              {data.activePlan === plan ? " · Active" : ""}
            </button>
          ))}
        </section>

        {error ? <div className="pm-alert error" role="alert">{error}</div> : null}
        {message ? <div className="pm-alert success" role="status">{message}</div> : null}

        <div className="pm-layout">
          <section className="pm-panel">
            <div className="pm-panel-head">
              <div><h2>{selectedPlan === "PLAN A" ? "Separate bus service" : `${selectedPlan} clusters`}</h2><p>Drag a bus node between clusters, or edit the tree from the panel.</p></div>
              <button className="pm-button" onClick={createCluster} disabled={saving || selectedPlan === "PLAN A"}>
                + Create new cluster
              </button>
            </div>
            {loading ? <div className="pm-loading">Loading bus routes and clusters…</div> : selectedPlan === "PLAN A" ? (
              <div className="pm-cluster-list">
                {data.buses
                  .filter((bus) => bus.status === "active" && bus.plans.includes("PLAN A"))
                  .map((bus) => (
                    <article className="pm-cluster" key={bus.id}>
                      <div className="pm-root">
                        <div className="pm-root-label">Separate bus · no cluster</div>
                        <strong>{busLabel(bus)}</strong>
                        <small>{bus.assignedUsers} assigned riders · {bus.plans.length} route set(s)</small>
                      </div>
                    </article>
                  ))}
              </div>
            ) : clusters.length ? (
              <div className="pm-cluster-list">
                {clusters.map((cluster) => (
                  <article className="pm-cluster" key={cluster.id}>
                    <div
                      className="pm-root"
                      draggable
                      onDragStart={(event) => onDragStart(event, cluster.rootBus?.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => moveBusToCluster(event, cluster)}
                      title="Drop a bus here to make it the root or add it as a node"
                    >
                      <div className="pm-root-label">Root · location and stops source</div>
                      <strong>{busLabel(cluster.rootBus)}</strong>
                      <small>{cluster.clusterName} · {cluster.rootBus?.assignedUsers || 0} assigned riders</small>
                    </div>
                    <div className="pm-members" onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveBusToCluster(event, cluster)}>
                      <div className="pm-members-label">Mapped buses · share root location and stops</div>
                      <div className="pm-nodes">
                        {cluster.memberBuses.length ? cluster.memberBuses.map((bus) => (
                          <div key={bus.id} className="pm-node" draggable onDragStart={(event) => onDragStart(event, bus.id)}>
                            {busLabel(bus)} <span>{bus.assignedUsers} riders</span>
                          </div>
                        )) : <span className="pm-node" style={{ cursor: "default" }}>No mapped buses yet</span>}
                      </div>
                    </div>
                    <div className="pm-cluster-foot">
                      <button className="pm-button secondary" onClick={() => editCluster(cluster)} disabled={saving}>Edit tree</button>
                      <button className="pm-button danger" onClick={() => removeCluster(cluster)} disabled={saving}>Delete</button>
                    </div>
                    {cluster.rootStops?.length ? (
                      <details className="pm-stops">
                        <summary>Preview root stops and arrival times</summary>
                        {cluster.rootStops.map((stop) => (
                          <div className="pm-stop" key={`${stop.stopOrder}-${stop.stopName}`}>
                            <span>{stop.stopOrder}. {stop.stopName}</span><time>{stop.arrivalTime || "Time not uploaded"}</time>
                          </div>
                        ))}
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : <div className="pm-empty">No clusters for {selectedPlan} yet. Create one, choose a root bus with that route, and add Plan A-only buses.</div>}
          </section>

          <aside className="pm-panel pm-side">
            {form ? (
              <form onSubmit={save}>
                <h2>{form.clusterId ? "Edit cluster" : "Create cluster"}</h2>
                <p>Choose the bus that supplies this service, then select the assigned buses that should use it.</p>
                <div className="pm-field">
                  <label htmlFor="cluster-name">Cluster name</label>
                  <input id="cluster-name" value={form.clusterName} onChange={(event) => updateForm("clusterName", event.target.value)} required />
                </div>
                <div className="pm-field">
                  <label htmlFor="root-bus">Root bus · requires {selectedPlan} route</label>
                  <select id="root-bus" value={form.rootBusId} onChange={(event) => updateForm("rootBusId", event.target.value)} required>
                    <option value="">Select a root bus</option>
                    {roots.map((bus) => <option value={bus.id} key={bus.id}>{busLabel(bus)} · {bus.plans.join(", ")}</option>)}
                  </select>
                </div>
                <div className="pm-field">
                  <label>Plan A-only buses · assigned riders follow the root</label>
                  <div className="pm-nodes">
                    {members.map((bus) => (
                      <label key={bus.id} className="pm-node" style={{ cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={form.memberBusIds.includes(bus.id)}
                          onChange={(event) => updateForm(
                            "memberBusIds",
                            event.target.checked
                              ? [...form.memberBusIds, bus.id]
                              : form.memberBusIds.filter((id) => id !== bus.id),
                          )}
                        />
                        {busLabel(bus)} <span>{bus.assignedUsers} riders</span>
                      </label>
                    ))}
                    {!members.length ? <span className="pm-node" style={{ cursor: "default" }}>No unmapped Plan A-only buses</span> : null}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="pm-button" disabled={saving} type="submit">{saving ? "Saving…" : "Save tree"}</button>
                  <button className="pm-button secondary" type="button" onClick={() => setForm(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                <h2>Unmapped buses</h2>
                <p>Drag a bus into a cluster to add it. Every change is checked against assigned riders before it is saved.</p>
                <div className="pm-available" onDragOver={(event) => event.preventDefault()} onDrop={unmapBus}>
                  <strong>Available Plan A-only buses · drop a node here to unmap it</strong>
                  <div className="pm-nodes">
                    {members.filter((bus) => !mappedMemberIds.has(bus.id)).map((bus) => (
                      <div key={bus.id} className="pm-node" draggable onDragStart={(event) => onDragStart(event, bus.id)}>
                        {busLabel(bus)} <span>{bus.assignedUsers} riders</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="pm-available" style={{ background: "#eff6ff", borderStyle: "solid" }}>
                  <strong>How a cluster works</strong>
                  <div style={{ color: "#475569", fontSize: 12, lineHeight: 1.6 }}>
                    The root bus provides both the live location and the active route stops/timings. Mapped buses keep their riders, but use that root service. Plan A always remains separate.
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
