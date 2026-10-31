(() => {
  "use strict";

  const PLANS = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];
  const TOKEN_KEY = "btms_admin_token";
  const API_BASE_URL = String(window.BTMS_CONFIG?.API_BASE_URL || "").replace(/\/+$/, "");
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY),
    user: null,
    data: { activePlan: "PLAN A", buses: [], clusters: [] },
    users: [],
    adminBuses: [],
    selectedUserId: null,
    selectedBusNo: null,
    busChangeAction: null,
    selectedPlan: "PLAN B",
    selectedGlobalPlan: null,
    page: "dashboard",
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
    const isFormData =
      typeof FormData !== "undefined" && options.body instanceof FormData;
    if (options.body && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
        cache: "no-store",
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
    showAdminPage(window.location.hash.slice(1) || "dashboard", false);
  }

  const PAGE_TITLES = {
    dashboard: "Dashboard",
    "add-users": "Add users",
    "add-buses": "Add buses",
    "global-plan": "Global plan",
    "plan-mapping": "Plan mapping",
  };

  function showAdminPage(page, updateHistory = true) {
    if (!Object.hasOwn(PAGE_TITLES, page)) page = "dashboard";
    state.page = page;
    document.querySelectorAll("[data-page-content]").forEach((section) => {
      section.hidden = section.dataset.pageContent !== page;
    });
    document.querySelectorAll(".nav-link[data-page]").forEach((link) => {
      const active = link.dataset.page === page;
      link.classList.toggle("nav-link-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    byId("active-page-title").textContent = PAGE_TITLES[page];
    if (updateHistory && window.location.hash !== `#${page}`) {
      window.history.replaceState(null, "", `#${page}`);
    }
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.data = { activePlan: "PLAN A", buses: [], clusters: [] };
    state.users = [];
    state.adminBuses = [];
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
    await loadAdminRecords();
  }

  async function loadAdminRecords() {
    const usersList = byId("users-list");
    const busesList = byId("buses-list");
    if (usersList) usersList.innerHTML = '<div class="loading-state">Loading users…</div>';
    if (busesList) busesList.innerHTML = '<div class="loading-state">Loading buses…</div>';
    const [usersResult, busesResult] = await Promise.allSettled([
      request("/api/superadmin/users"),
      request("/api/bus/get-all-buses"),
    ]);

    if (usersResult.status === "fulfilled") {
      state.users = usersResult.value.users || [];
      renderUsers();
    } else if (usersList) {
      usersList.innerHTML = `<div class="empty-state"><strong>Could not load users</strong><p>${escapeHtml(usersResult.reason.message || "Refresh and try again.")}</p></div>`;
    }

    if (busesResult.status === "fulfilled") {
      const buses = [
        ...(busesResult.value.buses || []),
        ...(busesResult.value.alteredBuses || []),
      ];
      state.adminBuses = buses.map((bus) => {
        const mapping = state.data.buses.find(
          (item) => String(item.busNo || "").toUpperCase() === String(bus.busNo || "").toUpperCase(),
        );
        return {
          ...bus,
          id: mapping?.id,
          plans: mapping?.plans || [],
          assignedUsers: mapping?.assignedUsers || 0,
        };
      });
      renderBuses();
    } else if (busesList) {
      busesList.innerHTML = `<div class="empty-state"><strong>Could not load buses</strong><p>${escapeHtml(busesResult.reason.message || "Refresh and try again.")}</p></div>`;
    }
  }

  function renderUsers() {
    const container = byId("users-list");
    if (!container) return;
    if (!state.users.length) {
      container.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }
    container.innerHTML = state.users.map((user) => {
      const active = user.is_active !== false;
      return `
        <details class="record-card">
          <summary class="record-summary">
            <div class="record-copy">
              <strong>${escapeHtml(user.name || "Unnamed user")}</strong>
              <span>${escapeHtml(user.email || "")}</span>
              <small>${escapeHtml(user.role || "—")} · Bus ${escapeHtml(user.bus_no || "—")} · ${active ? "Active" : "Inactive"}</small>
            </div>
            <span class="record-expand-label">Manage</span>
          </summary>
          <div class="record-actions">
            <button type="button" class="button button-quiet" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Edit</button>
            ${active
              ? `<button type="button" class="text-button danger" data-user-action="deactivate" data-user-id="${escapeHtml(user.id)}">Deactivate</button>`
              : `<button type="button" class="text-button" data-user-action="activate" data-user-id="${escapeHtml(user.id)}">Activate</button>`}
          </div>
        </details>
      `;
    }).join("");
  }

  function renderBuses() {
    const container = byId("buses-list");
    if (!container) return;
    if (!state.adminBuses.length) {
      container.innerHTML = '<div class="empty-state">No buses found.</div>';
      return;
    }
    container.innerHTML = state.adminBuses.map((bus) => `
      <details class="record-card">
        <summary class="record-summary">
          <div class="record-copy">
            <strong>${escapeHtml(busName(bus))} · ${escapeHtml(bus.busNo || "—")}</strong>
            <span>${escapeHtml(bus.status || "unknown")} · ${escapeHtml((bus.plans || []).join(", ") || "No routes uploaded")}</span>
            <small>GPS ${escapeHtml(bus.gpsDeviceId || "—")} · ${escapeHtml(bus.regNo || "No registration")} · ${escapeHtml(bus.assignedUsers || 0)} assigned riders</small>
          </div>
          <span class="record-expand-label">Manage</span>
        </summary>
        <div class="record-actions">
          <button type="button" class="button button-quiet" data-bus-action="edit" data-bus-no="${escapeHtml(bus.busNo)}">Edit details</button>
          <button type="button" class="button button-quiet" data-bus-action="routes" data-bus-no="${escapeHtml(bus.busNo)}">Edit routes</button>
          ${bus.isAltered
            ? `<button type="button" class="button button-quiet" data-bus-action="restore" data-bus-no="${escapeHtml(bus.busNo)}">Restore original bus</button>`
            : bus.status === "active"
              ? `<button type="button" class="button button-quiet" data-bus-action="alter" data-bus-no="${escapeHtml(bus.busNo)}">Alter bus</button>
                 <button type="button" class="button button-quiet" data-bus-action="combine" data-bus-no="${escapeHtml(bus.busNo)}">Combine bus</button>`
              : ""}
          <button type="button" class="text-button danger" data-bus-action="delete" data-bus-no="${escapeHtml(bus.busNo)}">Delete bus</button>
        </div>
      </details>
    `).join("");
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
    apply.textContent = "Apply service";
    byId("active-plan-description").textContent =
      `Current service: ${state.data.activePlan.replace("PLAN ", "Plan ")}`;
  }

  function busNode(bus, { root = false } = {}) {
    const label = busName(bus);
    const count = Number(bus?.assignedUsers || 0);
    return `<div class="bus-node${root ? " root-node" : ""}" data-bus-id="${escapeHtml(bus?.id)}" draggable="true" title="Drag to move this bus between service nodes">
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
      const result = await request("/api/bus/global-plan", {
        method: "PUT",
        body: JSON.stringify({ plan }),
      });
      if (result.activePlan !== plan) {
        throw new Error("The server did not confirm the selected operating service.");
      }
      state.data.activePlan = result.activePlan;
      state.selectedGlobalPlan = result.activePlan;
      renderGlobalService();
      showToast("Operating service updated. Assigned riders have been notified.");
      await loadData({ quiet: true });
    } catch (error) {
      const uncovered = error.data?.uncoveredBuses;
      showNotice(`${error.message}${uncovered?.length ? ` Map these buses first: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.` : ""}`, true);
    } finally {
      renderGlobalService();
    }
  }

  function displayFormResult(id, message, isError = false) {
    const result = byId(id);
    result.textContent = message;
    result.classList.toggle("form-result-error", isError);
    result.hidden = !message;
  }

  async function addUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = byId("add-user-submit");
    const error = byId("add-user-error");
    const formData = new FormData(form);
    const file = formData.get("file");
    error.hidden = true;
    displayFormResult("add-user-result", "");
    if (!file || !file.name) {
      error.textContent = "Choose an .xlsx user workbook to import.";
      error.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = "Importing…";
    try {
      const response = await request("/api/superadmin/import-users-excel", {
        method: "POST",
        body: formData,
      });
      const summary = response.summary || {};
      const failedRows = Number(summary.failedRows || 0);
      const rowErrors = (summary.rowResults || [])
        .filter((row) => row.status === "failed")
        .slice(0, 5)
        .map((row) => `Row ${(Number(row.index) || 0) + 2}: ${row.reason}`)
        .join(" ");
      displayFormResult(
        "add-user-result",
        `Import finished: ${summary.totalRows || 0} rows; ${summary.insertedRows || 0} added, ${summary.updatedRows || 0} updated, ${summary.unchangedRows || 0} unchanged, ${failedRows} failed.${rowErrors ? ` ${rowErrors}` : ""}`,
        failedRows > 0,
      );
      if (!failedRows) form.reset();
    } catch (requestError) {
      error.textContent = requestError.message || "Could not import the user workbook.";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Import users";
    }
  }

  async function addBus(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = byId("add-bus-submit");
    const error = byId("add-bus-error");
    const formData = new FormData(form);
    const busNo = String(formData.get("busNo") || "").trim();
    const routeFile = formData.get("routesFile");
    error.hidden = true;
    displayFormResult("add-bus-result", "");

    const duplicate = state.data.buses.some(
      (bus) => String(bus.busNo || "").toLowerCase() === busNo.toLowerCase(),
    );
    if (duplicate) {
      error.textContent = "That bus number already exists. Use Organize → Buses to update its routes.";
      error.hidden = false;
      return;
    }

    formData.set("busNo", busNo.toUpperCase());
    formData.set("previewNumber", String(formData.get("previewNumber") || "").trim());
    formData.set("deviceId", String(formData.get("deviceId") || "").trim());
    formData.set("regNo", String(formData.get("regNo") || "").trim());

    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const response = await request("/api/bus/import-routes", {
        method: "POST",
        body: formData,
      });
      const summary = response.summary || {};
      const failedRows = Number(summary.failedRows || 0);
      displayFormResult(
        "add-bus-result",
        failedRows
          ? `Bus saved, but ${failedRows} route row(s) failed. Add or correct its route workbook in Organize → Buses.`
          : routeFile?.name
            ? "Bus and route workbook imported successfully."
            : "Bus created without routes. Add its route workbook later in Organize → Buses.",
        failedRows > 0,
      );
      form.reset();
      await loadData({ quiet: true });
    } catch (requestError) {
      error.textContent = requestError.message || "Could not create the bus.";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Create bus";
    }
  }

  function openUserEditor(userId) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) return;
    state.selectedUserId = userId;
    const form = byId("edit-user-form");
    form.elements.name.value = user.name || "";
    form.elements.role.value = user.role || "student";
    form.elements.bus_no.value = user.bus_no || "";
    byId("edit-user-error").hidden = true;
    byId("edit-user-dialog").showModal();
  }

  async function saveUserEdit(event) {
    event.preventDefault();
    const submit = byId("edit-user-submit");
    const error = byId("edit-user-error");
    const form = event.currentTarget;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      await request(`/api/superadmin/users/${encodeURIComponent(state.selectedUserId)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: form.elements.name.value.trim(),
          role: form.elements.role.value,
          bus_no: form.elements.bus_no.value.trim() || null,
        }),
      });
      byId("edit-user-dialog").close();
      showToast("User updated.");
      await loadAdminRecords();
    } catch (requestError) {
      error.textContent = requestError.message || "Could not update this user.";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Save user";
    }
  }

  async function deactivateUser(userId) {
    const user = state.users.find((item) => item.id === userId);
    if (!user || !window.confirm(`Deactivate ${user.name || user.email}?`)) return;
    try {
      await request(`/api/superadmin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      showToast("User deactivated.");
      await loadAdminRecords();
    } catch (requestError) {
      showToast(requestError.message || "Could not deactivate this user.", true);
    }
  }

  async function activateUser(userId) {
    try {
      await request(`/api/superadmin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: true }),
      });
      showToast("User activated.");
      await loadAdminRecords();
    } catch (requestError) {
      showToast(requestError.message || "Could not activate this user.", true);
    }
  }

  function openBusEditor(busNo) {
    const bus = state.adminBuses.find((item) => item.busNo === busNo);
    if (!bus) return;
    state.selectedBusNo = busNo;
    const form = byId("edit-bus-form");
    form.elements.previewNumber.value = bus.previewNumber ?? "";
    form.elements.gpsDeviceId.value = bus.gpsDeviceId ?? "";
    form.elements.regNo.value = bus.regNo ?? "";
    byId("edit-bus-error").hidden = true;
    byId("edit-bus-dialog").showModal();
  }

  async function saveBusEdit(event) {
    event.preventDefault();
    const submit = byId("edit-bus-submit");
    const error = byId("edit-bus-error");
    const form = event.currentTarget;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      await request(`/api/bus/update-bus-details/${encodeURIComponent(state.selectedBusNo)}`, {
        method: "PUT",
        body: JSON.stringify({
          previewNumber: form.elements.previewNumber.value.trim() || null,
          gpsDeviceId: form.elements.gpsDeviceId.value.trim(),
          regNo: form.elements.regNo.value.trim() || null,
        }),
      });
      byId("edit-bus-dialog").close();
      showToast("Bus details updated.");
      await loadData({ quiet: true });
    } catch (requestError) {
      error.textContent = requestError.message || "Could not update this bus.";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Save bus";
    }
  }

  function openRouteEditor(busNo) {
    const bus = state.adminBuses.find((item) => item.busNo === busNo);
    if (!bus) return;
    state.selectedBusNo = busNo;
    byId("edit-routes-form").reset();
    byId("edit-routes-bus-label").textContent = `${busName(bus)} · existing routes will be replaced`;
    byId("edit-routes-error").hidden = true;
    byId("edit-routes-dialog").showModal();
  }

  async function replaceBusRoutes(event) {
    event.preventDefault();
    const submit = byId("edit-routes-submit");
    const error = byId("edit-routes-error");
    const form = event.currentTarget;
    const bus = state.adminBuses.find((item) => item.busNo === state.selectedBusNo);
    const file = form.elements.routesFile.files?.[0];
    error.hidden = true;
    if (!bus || !file) {
      error.textContent = "Choose a route workbook before continuing.";
      error.hidden = false;
      return;
    }

    const payload = new FormData();
    payload.set("busNo", bus.busNo);
    payload.set("previewNumber", bus.previewNumber ?? "");
    payload.set("deviceId", bus.gpsDeviceId ?? "");
    payload.set("regNo", bus.regNo ?? "");
    payload.set("replaceRoutes", "true");
    payload.set("routesFile", file);
    submit.disabled = true;
    submit.textContent = "Updating…";
    try {
      const response = await request("/api/bus/import-routes", {
        method: "POST",
        body: payload,
      });
      const failedRows = Number(response.summary?.failedRows || 0);
      if (failedRows) {
        throw new Error(`The route workbook had ${failedRows} invalid row(s). Review the workbook; successfully processed routes may already have been saved.`);
      }
      byId("edit-routes-dialog").close();
      showToast("Bus routes replaced.");
      await loadData({ quiet: true });
    } catch (requestError) {
      error.textContent = requestError.message || "Could not replace the bus routes.";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Replace routes";
    }
  }

  async function deleteBus(busNo) {
    const bus = state.adminBuses.find((item) => item.busNo === busNo);
    if (!bus || !window.confirm(`Permanently delete bus ${busNo} and its routes? Riders assigned to this bus will be unassigned. This cannot be undone.`)) return;
    try {
      await request(`/api/bus/delete-bus/${encodeURIComponent(busNo)}`, {
        method: "DELETE",
      });
      showToast(`Bus ${busNo} deleted.`);
      await loadData({ quiet: true });
    } catch (requestError) {
      showToast(requestError.message || `Could not delete bus ${busNo}.`, true);
    }
  }

  function openBusChangeDialog(busNo, action) {
    const source = state.adminBuses.find((bus) => bus.busNo === busNo);
    if (!source) return;

    state.selectedBusNo = busNo;
    state.busChangeAction = action;
    const form = byId("bus-change-form");
    form.reset();
    byId("bus-change-title").textContent =
    action === "combine" ? "Combine buses" : "Alter bus";
    byId("bus-change-source").textContent = busName(source);
    byId("bus-change-description").textContent =
    action === "combine"
      ? "Both buses' riders will use the replacement bus location. Choose which bus's routes the combined service should follow."
      : "Riders keep this bus and its original stops, while its live location comes from the replacement bus.";
    byId("bus-change-target").innerHTML = [
    '<option value="">Choose an active replacement bus</option>',
    ...state.adminBuses
      .filter((bus) =>
        bus.busNo !== source.busNo &&
        bus.status === "active" &&
        !bus.isAltered,
      )
      .map((bus) =>
        `<option value="${escapeHtml(bus.busNo)}">${escapeHtml(busName(bus))} · ${escapeHtml(bus.busNo)}</option>`,
      ),
    ].join("");
    byId("bus-change-route-field").hidden = action !== "combine";
    byId("bus-change-route-source-label").textContent = `${busName(source)} routes`;
    byId("bus-change-route-target-label").textContent = "Replacement bus routes";
    byId("bus-change-error").hidden = true;
    byId("bus-change-submit").textContent =
    action === "combine" ? "Combine buses" : "Confirm location change";
    byId("bus-change-dialog").showModal();
  }

  async function submitBusChange(event) {
    event.preventDefault();
    const submit = byId("bus-change-submit");
    const error = byId("bus-change-error");
    const form = event.currentTarget;
    const source = state.adminBuses.find((bus) => bus.busNo === state.selectedBusNo);
    const targetBusNo = form.elements.targetBusNo.value;
    const target = state.adminBuses.find((bus) => bus.busNo === targetBusNo);

    error.hidden = true;
    if (!source || !target) {
    error.textContent = "Choose an active replacement bus.";
    error.hidden = false;
    return;
    }

    const isCombine = state.busChangeAction === "combine";
    const confirmation = isCombine
    ? `Combine ${busName(source)} with ${busName(target)}? Riders assigned to both buses will use the replacement bus.`
    : `Use ${busName(target)} for the live location of ${busName(source)}? Its original stops will remain unchanged.`;
    if (!window.confirm(confirmation)) return;

    submit.disabled = true;
    submit.textContent = isCombine ? "Combining…" : "Applying…";
    try {
    const payload = { newBusNo: target.busNo };
    if (isCombine) payload.routeSource = form.elements.routeSource.value;
    const result = await request(
      `/api/bus/${isCombine ? "combine" : "alter"}-bus/${encodeURIComponent(source.busNo)}`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    byId("bus-change-dialog").close();
    showToast(
      `${result.message || (isCombine ? "Buses combined." : "Bus altered.")} ${Number(result.notifiedStudents || 0)} rider(s) notified.`,
    );
    await loadData({ quiet: true });
    } catch (requestError) {
    error.textContent =
      requestError.message ||
      (isCombine ? "Could not combine these buses." : "Could not alter this bus.");
    error.hidden = false;
    } finally {
    submit.disabled = false;
    submit.textContent = isCombine ? "Combine buses" : "Confirm location change";
    }
  }

  async function restoreBus(busNo) {
    const bus = state.adminBuses.find((item) => item.busNo === busNo);
    if (!bus?.isAltered) return;
    if (!window.confirm(`End the bus change for ${busName(bus)} and restore its original service?`)) return;
    try {
    const result = await request(
      `/api/bus/restore-altered/${encodeURIComponent(busNo)}`,
      { method: "PUT" },
    );
    showToast(
      `${result.message || "Original bus restored."} ${Number(result.notifiedStudents || 0)} rider(s) notified.`,
    );
    await loadData({ quiet: true });
    } catch (requestError) {
    showToast(requestError.message || "Could not restore this bus.", true);
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
    byId("add-user-form").addEventListener("submit", addUser);
    byId("add-bus-form").addEventListener("submit", addBus);
    byId("refresh-users").addEventListener("click", loadAdminRecords);
    byId("refresh-buses").addEventListener("click", loadData);
    byId("edit-user-form").addEventListener("submit", saveUserEdit);
    byId("edit-bus-form").addEventListener("submit", saveBusEdit);
    byId("edit-routes-form").addEventListener("submit", replaceBusRoutes);
    byId("bus-change-form").addEventListener("submit", submitBusChange);
    byId("users-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-user-action]");
      if (!button) return;
      if (button.dataset.userAction === "edit") openUserEditor(button.dataset.userId);
      if (button.dataset.userAction === "deactivate") deactivateUser(button.dataset.userId);
      if (button.dataset.userAction === "activate") activateUser(button.dataset.userId);
    });
    byId("buses-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-bus-action]");
      if (!button) return;
      const { busAction, busNo } = button.dataset;
      if (busAction === "edit") openBusEditor(busNo);
      if (busAction === "routes") openRouteEditor(busNo);
      if (busAction === "alter" || busAction === "combine") {
        openBusChangeDialog(busNo, busAction);
      }
      if (busAction === "restore") restoreBus(busNo);
      if (busAction === "delete") deleteBus(busNo);
    });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => byId(button.dataset.closeDialog).close());
    });
    document.querySelectorAll(".nav-link[data-page]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        showAdminPage(link.dataset.page);
      });
    });
    document.querySelectorAll("[data-open-page]").forEach((button) => {
      button.addEventListener("click", () => showAdminPage(button.dataset.openPage));
    });
    window.addEventListener("hashchange", () => {
      showAdminPage(window.location.hash.slice(1), false);
    });
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
