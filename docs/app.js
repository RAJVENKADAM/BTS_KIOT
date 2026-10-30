(() => {
  "use strict";

  const PLANS = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];
  const TOKEN_KEY = "btms_admin_token";
  const API_BASE_URL = String(window.BTMS_CONFIG?.API_BASE_URL || "").replace(/\/+$/, "");
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY),
    user: null,
    data: { activePlan: "PLAN A", buses: [], clusters: [] },
    selectedPlan: "PLAN B",
    selectedGlobalPlan: null,
    form: null,
    toastTimer: null,
  };

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  const busName = (bus) =>
    `Bus ${bus?.previewNumber ?? bus?.busNo ?? "—"}`;

  async function request(path, options = {}) {
    if (!API_BASE_URL) {
      throw new Error("Set API_BASE_URL in docs/config.js before using the dashboard.");
    }
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
        mode: "cors",
      });
    } catch (error) {
      throw new Error(
        `Could not connect to BTMS API. Check the API URL and backend CORS settings. ${error.message}`,
      );
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        if (state.token && path !== "/api/auth/login") {
          clearSession();
          showLogin("Your session expired or no longer has administrator access. Please sign in again.");
        }
      }
      throw Object.assign(
        new Error(payload.error || payload.message || `Request failed (${response.status}).`),
        { data: payload, status: response.status },
      );
    }
    return payload;
  }

  function showLogin(error = "") {
    byId("dashboard-view").hidden = true;
    byId("login-view").hidden = false;
    byId("login-error").textContent = error;
    byId("login-error").hidden = !error;
  }

  function showDashboard() {
    byId("login-view").hidden = true;
    byId("dashboard-view").hidden = false;
    const name = state.user?.name || state.user?.email || "Administrator";
    byId("profile-name").textContent = name;
    byId("profile-avatar").textContent = name.trim().charAt(0).toUpperCase() || "A";
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.data = { activePlan: "PLAN A", buses: [], clusters: [] };
    sessionStorage.removeItem(TOKEN_KEY);
  }

  async function login(event) {
    event.preventDefault();
    const submit = byId("login-submit");
    const errorBox = byId("login-error");
    errorBox.hidden = true;
    submit.disabled = true;
    submit.querySelector("span").textContent = "Signing in…";
    try {
      const email = byId("login-email").value.trim();
      const password = byId("login-password").value;
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!result.token || !result.user) {
        throw new Error("The server returned an incomplete sign-in response.");
      }
      if (String(result.user.role || "").toLowerCase() !== "superadmin") {
        throw new Error("This dashboard is only available to super admins.");
      }
      state.token = result.token;
      state.user = result.user;
      sessionStorage.setItem(TOKEN_KEY, state.token);
      showDashboard();
      await loadData();
    } catch (error) {
      if (state.token && !state.user) clearSession();
      errorBox.textContent = error.message || "Sign-in failed.";
      errorBox.hidden = false;
      showLogin(errorBox.textContent);
    } finally {
      submit.disabled = false;
      submit.querySelector("span").textContent = "Sign in securely";
    }
  }

  async function restoreSession() {
    if (!state.token) return showLogin();
    try {
      const profile = await request("/api/auth/profile");
      const user = profile.user;
      if (String(user?.role || "").toLowerCase() !== "superadmin") {
        clearSession();
        return showLogin("This dashboard is only available to super admins.");
      }
      state.user = user;
      showDashboard();
      await loadData();
    } catch (error) {
      if (state.token) clearSession();
      showLogin(error.message || "Please sign in to continue.");
    }
  }

  async function signOut() {
    try {
      await request("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (error) {
      console.warn("Could not notify the server about sign-out:", error.message);
    }
    clearSession();
    showLogin();
    byId("login-password").value = "";
  }

  async function loadData({ quiet = false } = {}) {
    const refresh = byId("refresh-button");
    if (!quiet) {
      refresh.disabled = true;
      refresh.innerHTML = '<span aria-hidden="true">↻</span> Loading…';
      byId("cluster-list").innerHTML = '<div class="loading-state">Loading routes and bus assignments…</div>';
    }
    try {
      const result = await request("/api/bus/plan-mappings");
      state.data = {
        activePlan: result.activePlan,
        buses: result.buses || [],
        clusters: result.clusters || [],
      };
      if (!PLANS.includes(state.data.activePlan)) {
        throw new Error("The server returned an unsupported active service.");
      }
      if (!PLANS.includes(state.selectedPlan)) {
        state.selectedPlan = state.data.activePlan;
      }
      state.selectedGlobalPlan = state.data.activePlan;
      render();
      byId("last-updated").textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date())}`;
    } catch (error) {
      if (!quiet) {
        showNotice(error.message || "Could not load plan mapping data.", true);
        byId("cluster-list").innerHTML = '<div class="empty-state"><strong>Could not load bus data</strong><p>Check your connection and try refreshing.</p></div>';
      } else {
        showToast(error.message || "Could not refresh data.", true);
      }
    } finally {
      refresh.disabled = false;
      refresh.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
    }
  }

  function activeClusters() {
    return state.data.clusters.filter((cluster) => cluster.planName === state.selectedPlan);
  }

  function allMappedMemberIds() {
    return new Set(state.data.clusters.flatMap((cluster) =>
      (cluster.memberBuses || []).map((bus) => bus.id),
    ));
  }

  function planAMembers() {
    return state.data.buses.filter((bus) =>
      bus.status === "active" &&
      bus.plans.includes("PLAN A") &&
      !bus.plans.includes(state.selectedPlan),
    );
  }

  function renderStats() {
    const buses = state.data.buses;
    const active = buses.filter((bus) => bus.status === "active");
    const assigned = buses.reduce((total, bus) => total + Number(bus.assignedUsers || 0), 0);
    const mappedIds = allMappedMemberIds();
    const planAOnly = buses.filter((bus) =>
      bus.status === "active" && bus.plans.includes("PLAN A") &&
      !["PLAN B", "PLAN C", "PLAN D"].some((plan) => bus.plans.includes(plan)),
    );
    byId("stat-active-buses").textContent = String(active.length);
    byId("stat-clusters").textContent = String(state.data.clusters.length);
    byId("stat-unmapped").textContent = String(planAOnly.filter((bus) => !mappedIds.has(bus.id)).length);
    byId("stat-riders").textContent = String(assigned);
  }

  function renderGlobalService() {
    const options = byId("global-plan-options");
    options.innerHTML = PLANS.map((plan) => {
      const selected = state.selectedGlobalPlan === plan;
      const current = state.data.activePlan === plan;
      const label = plan === "PLAN A" ? "A · Separate" : plan.replace("PLAN ", "");
      return `<button type="button" class="plan-choice${selected ? " selected" : ""}${current ? " current" : ""}" data-global-plan="${plan}" aria-pressed="${selected}">${label}${current ? " · Active" : ""}</button>`;
    }).join("");
    const apply = byId("apply-global-plan");
    apply.disabled = !state.selectedGlobalPlan || state.selectedGlobalPlan === state.data.activePlan;
    apply.innerHTML = `Apply service <span aria-hidden="true">→</span>`;
  }

  function busNode(bus, { root = false } = {}) {
    const label = busName(bus);
    const count = Number(bus?.assignedUsers || 0);
    return `<div class="bus-node${root ? " root-node" : ""}" data-bus-id="${escapeHtml(bus?.id)}" draggable="true" title="Drag to move this bus between service nodes">
      <span class="node-glyph" aria-hidden="true">▰</span>
      <span class="node-copy"><strong>${escapeHtml(label)}</strong><small>${count} ${count === 1 ? "rider" : "riders"}</small></span>
      ${root ? '<span class="root-badge">Root</span>' : ""}
    </div>`;
  }

  function renderCluster(cluster) {
    const members = cluster.memberBuses || [];
    const stops = cluster.rootStops || [];
    const stopPreview = stops.length
      ? `<details class="root-stops"><summary>View ${stops.length} root stops and arrival times</summary>${stops.map((stop) =>
        `<div class="stop-row"><span>${escapeHtml(stop.stopOrder)}. ${escapeHtml(stop.stopName)}</span><time>${escapeHtml(stop.arrivalTime || "Time not uploaded")}</time></div>`,
      ).join("")}</details>`
      : "";
    return `<article class="cluster-card" data-cluster-id="${escapeHtml(cluster.id)}">
      <header class="cluster-head">
        <div class="cluster-title"><span class="cluster-color"></span><strong>${escapeHtml(cluster.clusterName)}</strong><span>${members.length + 1} buses</span></div>
        <div class="cluster-actions">
          <button type="button" class="text-button" data-action="edit" data-cluster-id="${escapeHtml(cluster.id)}">Edit</button>
          <button type="button" class="text-button danger" data-action="delete" data-cluster-id="${escapeHtml(cluster.id)}">Delete</button>
        </div>
      </header>
      <div class="tree">
        <div class="tree-root-wrap" data-drop-root="${escapeHtml(cluster.id)}">
          ${cluster.rootBus ? busNode(cluster.rootBus, { root: true }) : ""}
        </div>
        <div class="tree-members" data-drop-members="${escapeHtml(cluster.id)}">
          ${members.map((bus) => busNode(bus)).join("")}
        </div>
      </div>
      ${stopPreview}
      <div class="tree-note">The root supplies today's live location, active stops, and stop arrival times for every mapped bus.</div>
    </article>`;
  }

  function renderPlanA() {
    const activeBuses = state.data.buses.filter((bus) =>
      bus.status === "active" && bus.plans.includes("PLAN A"),
    );
    if (!activeBuses.length) {
      return '<div class="empty-state"><strong>No Plan A route buses found</strong><p>Upload bus routes to add services to this view.</p></div>';
    }
    return `<div class="standalone-list">${activeBuses.map((bus) => busNode(bus)).join("")}</div>`;
  }

  function renderClusters() {
    const container = byId("cluster-list");
    if (state.selectedPlan === "PLAN A") {
      container.innerHTML = renderPlanA();
      return;
    }
    const clusters = activeClusters();
    const mappedIds = new Set(clusters.flatMap((cluster) =>
      (cluster.memberBuses || []).map((bus) => bus.id),
    ));
    const unmapped = planAMembers().filter((bus) => !mappedIds.has(bus.id));
    const inventory = `<section id="available-list" class="unmapped-panel" data-drop-available="true">
      <h3>Unmapped Plan A buses <span class="cluster-title-count">(${unmapped.length})</span></h3>
      <p>Drag a bus into a cluster, or use Edit to choose a new root and members.</p>
      <div class="unmapped-list">${unmapped.map((bus) => busNode(bus)).join("") || '<span class="muted">Every eligible bus is mapped for this service.</span>'}</div>
    </section>`;
    if (!clusters.length) {
      byId("cluster-list").innerHTML = `<div class="empty-state"><strong>No ${escapeHtml(state.selectedPlan)} clusters yet</strong><p>Create a cluster, select a root with this plan's route, and add Plan A-only buses.</p></div>${inventory}`;
      return;
    }
    container.innerHTML = clusters.map(renderCluster).join("") + inventory;
  }

  function render() {
    renderStats();
    renderGlobalService();
    document.querySelectorAll(".plan-tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.plan === state.selectedPlan));
    });
    byId("create-cluster-button").hidden = state.selectedPlan === "PLAN A";
    renderClusters();
  }

  function showNotice(message, isError = false) {
    const notice = byId("page-notice");
    notice.textContent = message;
    notice.classList.toggle("notice-error", isError);
    notice.hidden = false;
  }

  function showToast(message, isError = false) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.classList.toggle("toast-error", isError);
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
  }

  function hideNotice() {
    byId("page-notice").hidden = true;
  }

  function openClusterForm(cluster = null, rootBusId = "") {
    hideNotice();
    const plan = state.selectedPlan;
    if (!PLANS.includes(plan) || plan === "PLAN A") return;
    state.form = cluster
      ? {
          clusterId: cluster.id,
          planName: cluster.planName,
          clusterName: cluster.clusterName,
          rootBusId: cluster.rootBus?.id || "",
          memberBusIds: cluster.memberBuses.map((bus) => bus.id),
        }
      : {
          clusterId: null,
          planName: plan,
          clusterName: `Cluster ${activeClusters().length + 1}`,
          rootBusId,
          memberBusIds: [],
        };
    byId("dialog-title").textContent = cluster ? "Edit service cluster" : "Create service cluster";
    byId("root-bus-label").textContent = `Root bus · ${plan.replace("PLAN ", "Plan ")} route required`;
    byId("cluster-name").value = state.form.clusterName;
    byId("dialog-error").hidden = true;

    const roots = state.data.buses.filter((bus) =>
      bus.status === "active" && bus.plans.includes(plan),
    );
    byId("root-bus").innerHTML = `<option value="">Select a root bus</option>${roots.map((bus) =>
      `<option value="${escapeHtml(bus.id)}">${escapeHtml(busName(bus))} · ${escapeHtml(bus.assignedUsers)} riders</option>`,
    ).join("")}`;
    byId("root-bus").value = state.form.rootBusId;

    const members = planAMembers();
    byId("member-bus-list").innerHTML = members.length
      ? members.map((bus) => `<label class="member-option">
          <input type="checkbox" name="memberBusIds" value="${escapeHtml(bus.id)}" ${state.form.memberBusIds.includes(bus.id) ? "checked" : ""} />
          <span>${escapeHtml(busName(bus))}</span><small>${escapeHtml(bus.assignedUsers)} riders</small>
        </label>`).join("")
      : '<div class="member-empty">No active Plan A-only buses available for this service.</div>';
    byId("save-cluster").disabled = false;
    byId("save-cluster").textContent = "Save cluster";
    const dialog = byId("cluster-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function saveCluster(event) {
    event.preventDefault();
    if (!state.form) return;
    const submit = byId("save-cluster");
    const error = byId("dialog-error");
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "Saving…";
    const payload = {
      ...state.form,
      clusterName: byId("cluster-name").value.trim(),
      rootBusId: byId("root-bus").value,
      memberBusIds: [...document.querySelectorAll('input[name="memberBusIds"]:checked')].map((input) => input.value),
    };
    try {
      await request("/api/bus/plan-mappings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      byId("cluster-dialog").close();
      state.form = null;
      showToast("Cluster saved. Service assignments are updated.");
      await loadData({ quiet: true });
    } catch (requestError) {
      const uncovered = requestError.data?.uncoveredBuses;
      error.textContent = `${requestError.message}${uncovered?.length ? ` Buses needing another assignment: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.` : ""}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Save cluster";
    }
  }

  async function deleteCluster(clusterId) {
    const cluster = state.data.clusters.find((item) => item.id === clusterId);
    if (!cluster || !window.confirm(`Delete "${cluster.clusterName}"? Rider coverage will be checked before the cluster is removed.`)) return;
    try {
      await request(`/api/bus/plan-mappings/${encodeURIComponent(clusterId)}`, { method: "DELETE" });
      showToast("Cluster deleted.");
      await loadData({ quiet: true });
    } catch (error) {
      showNotice(error.message || "Could not delete the cluster.", true);
    }
  }

  async function applyGlobalPlan() {
    const plan = state.selectedGlobalPlan;
    if (!PLANS.includes(plan) || plan === state.data.activePlan) return;
    const name = plan === "PLAN A" ? "Plan A · separate buses" : plan.replace("PLAN ", "Plan ");
    if (!window.confirm(`Switch the global operating service to ${name}? Assigned riders will be notified.`)) return;
    const button = byId("apply-global-plan");
    button.disabled = true;
    button.textContent = "Applying…";
    hideNotice();
    try {
      await request("/api/bus/global-plan", {
        method: "PUT",
        body: JSON.stringify({ plan }),
      });
      showToast("Operating service updated. Assigned riders have been notified.");
      await loadData({ quiet: true });
    } catch (error) {
      const uncovered = error.data?.uncoveredBuses;
      showNotice(`${error.message}${uncovered?.length ? ` Map these buses first: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.` : ""}`, true);
    } finally {
      renderGlobalService();
    }
  }

  function startDrag(event) {
    const node = event.target.closest("[data-bus-id]");
    if (!node) return;
    event.dataTransfer.setData("text/plain", node.dataset.busId);
    event.dataTransfer.effectAllowed = "move";
  }

  function dropOnCluster(event) {
    const target = event.target.closest("[data-drop-members], [data-drop-root]");
    if (!target) return;
    event.preventDefault();
    const clusterId = target.dataset.dropMembers || target.dataset.dropRoot;
    const cluster = state.data.clusters.find((item) => item.id === clusterId);
    const bus = state.data.buses.find((item) => item.id === event.dataTransfer.getData("text/plain"));
    if (!cluster || !bus) return;
    if (target.hasAttribute("data-drop-root")) {
      if (!bus.plans.includes(state.selectedPlan)) {
        showNotice(`Choose a bus with a ${state.selectedPlan} route to make it the root.`, true);
        return;
      }
      openClusterForm(cluster, bus.id);
      byId("member-bus-list").querySelectorAll('input[name="memberBusIds"]').forEach((input) => {
        input.checked = cluster.memberBuses.some((member) => member.id === input.value);
      });
      return;
    }
    if (!bus.plans.includes("PLAN A") || bus.plans.includes(state.selectedPlan)) {
      showNotice("Only a Plan A-only bus can be added as a cluster member.", true);
      return;
    }
    const member = cluster.memberBuses.some((item) => item.id === bus.id);
    openClusterForm(cluster);
    const checkbox = byId("member-bus-list").querySelector(`input[value="${CSS.escape(bus.id)}"]`);
    if (checkbox) checkbox.checked = true;
    if (member) showToast(`${busName(bus)} is already in this cluster.`);
  }

  function dropToAvailable(event) {
    if (!event.target.closest("[data-drop-available]")) return;
    event.preventDefault();
    const busId = event.dataTransfer.getData("text/plain");
    const cluster = activeClusters().find((item) =>
      item.memberBuses.some((bus) => bus.id === busId),
    );
    if (!cluster) return;
    const bus = state.data.buses.find((item) => item.id === busId);
    openClusterForm(cluster);
    const checkbox = byId("member-bus-list").querySelector(`input[value="${CSS.escape(busId)}"]`);
    if (checkbox) checkbox.checked = false;
    if (bus) showToast(`${busName(bus)} will be removed from this cluster when saved.`);
  }

  function bindEvents() {
    byId("login-form").addEventListener("submit", login);
    byId("logout-button").addEventListener("click", signOut);
    byId("refresh-button").addEventListener("click", () => loadData());
    byId("create-cluster-button").addEventListener("click", () => openClusterForm());
    byId("cluster-form").addEventListener("submit", saveCluster);
    byId("apply-global-plan").addEventListener("click", applyGlobalPlan);
    byId("close-dialog").addEventListener("click", () => byId("cluster-dialog").close());
    byId("cancel-dialog").addEventListener("click", () => byId("cluster-dialog").close());
    byId("cluster-dialog").addEventListener("close", () => { state.form = null; });

    byId("global-plan-options").addEventListener("click", (event) => {
      const button = event.target.closest("[data-global-plan]");
      if (!button) return;
      state.selectedGlobalPlan = button.dataset.globalPlan;
      renderGlobalService();
    });
    document.querySelectorAll(".plan-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.selectedPlan = tab.dataset.plan;
        hideNotice();
        render();
      });
    });
    byId("cluster-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const cluster = state.data.clusters.find((item) => item.id === button.dataset.clusterId);
      if (button.dataset.action === "edit" && cluster) openClusterForm(cluster);
      if (button.dataset.action === "delete") deleteCluster(button.dataset.clusterId);
    });
    byId("cluster-list").addEventListener("dragstart", startDrag);
    byId("cluster-list").addEventListener("dragover", (event) => {
      if (event.target.closest("[data-drop-members], [data-drop-root], [data-drop-available]")) {
        event.preventDefault();
      }
    });
    byId("cluster-list").addEventListener("drop", (event) => {
      if (event.target.closest("[data-drop-available]")) dropToAvailable(event);
      else dropOnCluster(event);
    });
  }

  bindEvents();
  restoreSession();
})();
