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
    temporaryChanges: [],
    changeMode: "alter",
    userSearch: "",
    userRoleFilter: "all",
    userStatusFilter: "all",
    userBusFilter: "all",
    selectedUserId: null,
    selectedBusNo: null,
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
    "bus-changes": "Temporary bus changes",
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
    state.temporaryChanges = [];
    state.userSearch = "";
    state.userRoleFilter = "all";
    state.userStatusFilter = "all";
    state.userBusFilter = "all";
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
      const [result, globalPlan] = await Promise.all([
        request("/api/bus/plan-mappings"),
        request("/api/bus/global-plan"),
      ]);
      const activePlan = globalPlan.activePlan;
      if (!PLANS.includes(activePlan)) {
        throw new Error("The server returned an unsupported active service.");
      }
      state.data = {
        activePlan,
        buses: result.buses || [],
        clusters: result.clusters || [],
      };
      if (!PLANS.includes(state.selectedPlan)) {
        state.selectedPlan = state.data.activePlan;
      }
      state.selectedGlobalPlan = state.data.activePlan;
      render();
      if (result.activePlan !== activePlan) {
        showNotice(
          `The global plan is ${activePlan.replace("PLAN ", "Plan ")}, but plan-mapping data reports ${String(result.activePlan || "unknown")}. Refresh the dashboard or contact the system administrator if this continues.`,
          true,
        );
      }
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
    await loadTemporaryBusChanges();
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
    renderBusChangePage();
  }

  async function loadTemporaryBusChanges() {
    try {
      const result = await request("/api/bus/temporary-changes");
      state.temporaryChanges = result.changes || [];
      renderBusChangePage();
    } catch (error) {
      byId("temporary-changes-list").innerHTML =
        `<div class="empty-state"><strong>Could not load temporary changes</strong><p>${escapeHtml(error.message || "Refresh and try again.")}</p></div>`;
    }
  }

  function renderUsers() {
    const container = byId("users-list");
    if (!container) return;
    const roleFilter = byId("users-role-filter");
    const statusFilter = byId("users-status-filter");
    const busFilter = byId("users-bus-filter");
    const searchInput = byId("users-search");
    const count = byId("users-count");

    if (searchInput) searchInput.value = state.userSearch;
    if (roleFilter) roleFilter.value = state.userRoleFilter;
    if (statusFilter) statusFilter.value = state.userStatusFilter;
    if (busFilter) {
      const buses = [...new Set(state.users.map((user) => String(user.bus_no || "").trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      busFilter.innerHTML = '<option value="all">All buses</option>' + buses.map((busNo) =>
        `<option value="${escapeHtml(busNo)}">Bus ${escapeHtml(busNo)}</option>`,
      ).join("");
      if (buses.includes(state.userBusFilter)) busFilter.value = state.userBusFilter;
      else {
        state.userBusFilter = "all";
        busFilter.value = "all";
      }
    }

    if (!state.users.length) {
      if (count) count.textContent = "0 users";
      container.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }

    const search = state.userSearch.trim().toLocaleLowerCase();
    const users = state.users.filter((user) => {
      const role = String(user.role || "").toLowerCase();
      const active = user.is_active !== false;
      const busNo = String(user.bus_no || "").trim();
      const matchesSearch = !search || [
        user.name,
        user.email,
        user.role,
        user.bus_no,
        active ? "active" : "inactive",
      ].some((value) => String(value || "").toLocaleLowerCase().includes(search));
      return matchesSearch &&
        (state.userRoleFilter === "all" || role === state.userRoleFilter) &&
        (state.userStatusFilter === "all" || (state.userStatusFilter === "active") === active) &&
        (state.userBusFilter === "all" || busNo === state.userBusFilter);
    });

    if (count) count.textContent = `${users.length} of ${state.users.length} users`;
    if (!users.length) {
      container.innerHTML = '<div class="empty-state"><strong>No matching users</strong><p>Change or clear the search and filters to see users.</p></div>';
      return;
    }

    container.innerHTML = `
      <table class="user-table">
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Bus</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>
          ${users.map((user) => {
            const active = user.is_active !== false;
            const role = String(user.role || "—");
            const roleLabel = role === "primary_admin" ? "Primary admin" : role === "superadmin" ? "Super admin" : role;
            return `
            <tr>
              <td class="user-name">${escapeHtml(user.name || "Unnamed user")}</td>
              <td>${escapeHtml(user.email || "—")}</td>
              <td>${escapeHtml(roleLabel)}</td>
              <td>${user.bus_no ? `Bus ${escapeHtml(user.bus_no)}` : "—"}</td>
              <td><span class="status-pill${active ? " status-active" : " status-inactive"}">${active ? "Active" : "Inactive"}</span></td>
              <td class="user-actions">
                <button type="button" class="button button-quiet" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Edit</button>
                ${active
                  ? `<button type="button" class="text-button danger" data-user-action="deactivate" data-user-id="${escapeHtml(user.id)}">Deactivate</button>`
                  : `<button type="button" class="text-button" data-user-action="activate" data-user-id="${escapeHtml(user.id)}">Activate</button>`}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
  }

  function renderBuses() {
    const container = byId("buses-list");
    if (!container) return;
    if (!state.adminBuses.length) {
      container.innerHTML = '<div class="empty-state">No buses found.</div>';
      return;
    }
    container.innerHTML = state.adminBuses.map((bus) => `
      <button type="button" class="bus-card" data-bus-open="${escapeHtml(bus.busNo)}" aria-label="Manage ${escapeHtml(busName(bus))}">
        <span>${escapeHtml(busName(bus))}</span>
        <span class="bus-card-arrow" aria-hidden="true">›</span>
      </button>
    `).join("");
  }

  function openBusOptions(busNo) {
    const bus = state.adminBuses.find((item) => item.busNo === busNo);
    if (!bus) return;
    state.selectedBusNo = busNo;
    byId("bus-options-title").textContent = busName(bus);
    byId("bus-options-details").textContent =
      `${bus.status || "Unknown status"} · ${(bus.plans || []).join(", ") || "No routes uploaded"} · ${Number(bus.assignedUsers || 0)} assigned riders`;
    const hasTemporaryChange = hasActiveTemporaryChange(bus.busNo);
    byId("bus-options-actions").innerHTML = hasTemporaryChange
      ? '<p class="bus-options-warning">Rollback this temporary change before editing or deleting this bus.</p>'
      : `
        <button type="button" class="button button-quiet" data-bus-action="edit" data-bus-no="${escapeHtml(bus.busNo)}">Edit details</button>
        <button type="button" class="button button-quiet" data-bus-action="routes" data-bus-no="${escapeHtml(bus.busNo)}">Edit routes</button>
        <button type="button" class="button button-danger" data-bus-action="delete" data-bus-no="${escapeHtml(bus.busNo)}">Delete bus</button>
      `;
    byId("bus-options-dialog").showModal();
  }

  function normalizedBusNo(value) {
    return String(value || "").trim().toUpperCase();
  }

  function hasActiveTemporaryChange(busNo) {
    const normalized = normalizedBusNo(busNo);
    return state.temporaryChanges.some((change) =>
      change.status !== "rolled_back" &&
      [change.sourceBusNo, change.targetBusNo].some(
        (identifier) => normalizedBusNo(identifier) === normalized,
      ),
    );
  }

  function activeBuses(excludedBusNos = []) {
    const excluded = new Set(excludedBusNos.map(normalizedBusNo));
    return state.adminBuses.filter((bus) =>
      bus.status === "active" &&
      !bus.isAltered &&
      !hasActiveTemporaryChange(bus.busNo) &&
      !excluded.has(normalizedBusNo(bus.busNo)),
    );
  }

  function isReusableCombinedSource(bus) {
    if (!bus || bus.status !== "active" || bus.isAltered || activeRiderCount(bus) !== 0) {
      return false;
    }
    const busNo = normalizedBusNo(bus.busNo);
    const relatedChanges = state.temporaryChanges.filter(
      (change) =>
        change.status !== "rolled_back" &&
        [change.sourceBusNo, change.targetBusNo].some(
          (identifier) => normalizedBusNo(identifier) === busNo,
        ),
    );
    return relatedChanges.length > 0 && relatedChanges.every(
      (change) =>
        change.type === "combine" &&
        normalizedBusNo(change.sourceBusNo) === busNo,
    );
  }

  function reusableCombinedSources(excludedBusNos = []) {
    const excluded = new Set(excludedBusNos.map(normalizedBusNo));
    return state.adminBuses.filter(
      (bus) =>
        !excluded.has(normalizedBusNo(bus.busNo)) &&
        isReusableCombinedSource(bus),
    );
  }

  function replacementBuses(excludedBusNos = []) {
    const excluded = new Set(excludedBusNos.map(normalizedBusNo));
    const availableBusNos = new Set(
      [...activeBuses(), ...reusableCombinedSources()].map((bus) =>
        normalizedBusNo(bus.busNo),
      ),
    );
    return state.adminBuses.filter(
      (bus) =>
        !excluded.has(normalizedBusNo(bus.busNo)) &&
        availableBusNos.has(normalizedBusNo(bus.busNo)),
    );
  }

  function activeRiderCount(bus) {
    if (!bus) return 0;
    const identifiers = new Set(
      [bus.busNo, bus.previewNumber].map(normalizedBusNo).filter(Boolean),
    );
    return state.users.filter((user) =>
      user.role === "student" &&
      user.is_active !== false &&
      identifiers.has(normalizedBusNo(user.bus_no)),
    ).length;
  }

  function renderBusPicker(containerId, buses, selectedBusNo, inputId) {
    const container = byId(containerId);
    const selected = normalizedBusNo(selectedBusNo);
    if (!buses.length) {
      container.innerHTML = '<div class="member-empty">No eligible buses are available.</div>';
      return;
    }
    container.innerHTML = buses.map((bus) => {
      const isSelected = normalizedBusNo(bus.busNo) === selected;
      const reusable = isReusableCombinedSource(bus);
      const plans = (bus.plans || []).length
        ? bus.plans.join(", ")
        : "Routes not listed";
      return `
        <button type="button" class="bus-picker-card${isSelected ? " is-selected" : ""}" aria-pressed="${isSelected}" data-bus-picker="${inputId}" data-bus-no="${escapeHtml(bus.busNo)}">
          <span class="bus-picker-card-heading"><strong>${escapeHtml(busName(bus))}</strong><span>${activeRiderCount(bus)} riders</span></span>
          <span class="bus-picker-card-meta">${escapeHtml(bus.busNo)} · ${escapeHtml(plans)}</span>
          ${reusable ? '<span class="bus-picker-card-badge">Available · 0 riders</span>' : ""}
        </button>`;
    }).join("");
  }

  function renderRoutePicker(sourceBus, targetBus, selectedRoute) {
    const container = byId("combine-route-picker");
    const choices = [
      {
        value: "source",
        title: sourceBus ? `${busName(sourceBus)} routes` : "Source bus routes",
        detail: sourceBus
          ? (sourceBus.plans || []).join(", ") || "Saved route details unavailable"
          : "Choose the source bus first",
      },
      {
        value: "target",
        title: targetBus ? `${busName(targetBus)} routes` : "Replacement bus routes",
        detail: targetBus
          ? (targetBus.plans || []).join(", ") || "Saved route details unavailable"
          : "Choose the replacement bus first",
      },
      {
        value: "custom",
        title: "Custom Excel routes",
        detail: "Upload a workbook with plan columns and optional arrival times",
      },
    ];
    container.innerHTML = choices.map((choice) => {
      const isSelected = choice.value === selectedRoute;
      return `
        <button type="button" class="route-picker-card${isSelected ? " is-selected" : ""}" aria-pressed="${isSelected}" data-route-picker="${choice.value}">
          <span class="route-picker-indicator" aria-hidden="true"></span>
          <span><strong>${escapeHtml(choice.title)}</strong><small>${escapeHtml(choice.detail)}</small></span>
        </button>`;
    }).join("");
  }

  function renderTemporaryChangeList() {
    const container = byId("temporary-changes-list");
    if (!container) return;
    if (!state.temporaryChanges.length) {
      container.innerHTML = '<div class="empty-state"><strong>No active temporary changes</strong><p>Altered or combined buses will appear here with a rollback option.</p></div>';
      return;
    }
    container.innerHTML = state.temporaryChanges.map((change) => {
      const isAlter = change.type === "alter";
      const isApplying = change.status === "applying";
      const sourceBus = state.adminBuses.find(
        (bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(change.sourceBusNo),
      );
      const sourceRiders = sourceBus ? activeRiderCount(sourceBus) : 0;
      const routeChoice = change.routeSource === "custom"
        ? "Custom uploaded routes"
        : change.routeSource === "source"
          ? "Source bus stops"
          : change.routeSource === "target"
            ? "Handling bus stops"
            : "";
      return `
        <article class="temporary-change-card">
          <div class="temporary-change-copy">
            <span class="change-type-pill">${isAlter ? "Altered" : "Combined"}</span>
            <h3>${escapeHtml(busName({ previewNumber: change.sourcePreview, busNo: change.sourceBusNo }))} ${isAlter ? "using location from" : "combined with"} ${escapeHtml(busName({ previewNumber: change.targetPreview, busNo: change.targetBusNo }))}</h3>
            <p>${isAlter
              ? "Original stops are preserved; replacement bus supplies live location."
              : `Source riders follow the replacement bus. ${escapeHtml(routeChoice)}. Source bus currently has ${sourceRiders} rider(s); roll back newer changes first and make it empty.`}</p>
            <small>${Number(change.affectedUsersCount || 0)} affected riders · ${escapeHtml(change.status === "applying" ? "Change is being applied" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(change.createdAt)))}</small>
          </div>
          <button type="button" class="button button-quiet" data-rollback-change="${escapeHtml(change.id)}" data-legacy="${Boolean(change.legacy)}" ${isApplying ? "disabled" : ""}>${isApplying ? "Applying…" : "Rollback to normal"}</button>
        </article>`;
    }).join("");
  }

  function renderBusChangePage() {
    let sourceBusNo = byId("alter-source")?.value;
    let targetBusNo = byId("alter-target")?.value;
    const alterSourceBuses = activeBuses().filter(
      (bus) => activeRiderCount(bus) > 0,
    );
    if (!alterSourceBuses.some((bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(sourceBusNo))) {
      sourceBusNo = "";
      byId("alter-source").value = "";
    }
    const alterTargetBuses = replacementBuses([sourceBusNo]).filter(
      (bus) => activeRiderCount(bus) === 0,
    );
    if (!alterTargetBuses.some((bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(targetBusNo))) {
      targetBusNo = "";
      byId("alter-target").value = "";
    }
    renderBusPicker("alter-source-picker", alterSourceBuses, sourceBusNo, "alter-source");
    renderBusPicker("alter-target-picker", alterTargetBuses, targetBusNo, "alter-target");
    const alterSource = state.adminBuses.find(
      (bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(sourceBusNo),
    );
    const alterTarget = state.adminBuses.find(
      (bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(targetBusNo),
    );
    byId("alter-impact-summary").textContent =
      alterSource && alterTarget
        ? `${activeRiderCount(alterSource)} source rider(s) will be assigned to ${busName(alterTarget)}. The replacement bus has 0 riders now. Route stops remain from ${busName(alterSource)}; ${busName(alterTarget)} supplies only live location.`
        : "Choose a source bus with riders and a replacement bus with 0 riders. Source riders will move to the replacement, while Home continues to show the source bus’s stops.";

    let combineSourceNo = byId("combine-source")?.value;
    let combineTargetNo = byId("combine-target")?.value;
    const combineSourceBuses = [
      ...activeBuses(),
      ...reusableCombinedSources(),
    ];
    if (!combineSourceBuses.some((bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(combineSourceNo))) {
      combineSourceNo = "";
      byId("combine-source").value = "";
    }
    const combineTargetBuses = replacementBuses([combineSourceNo]);
    if (!combineTargetBuses.some((bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(combineTargetNo))) {
      combineTargetNo = "";
      byId("combine-target").value = "";
    }
    renderBusPicker("combine-source-picker", combineSourceBuses, combineSourceNo, "combine-source");
    renderBusPicker("combine-target-picker", combineTargetBuses, combineTargetNo, "combine-target");
    const combineSource = state.adminBuses.find((bus) => bus.busNo === combineSourceNo);
    const combineTarget = state.adminBuses.find((bus) => bus.busNo === combineTargetNo);
    renderRoutePicker(
      combineSource,
      combineTarget,
      byId("combine-route-source").value || "source",
    );
    if (combineSource && combineTarget) {
      byId("combine-impact-summary").textContent =
        `${activeRiderCount(combineSource)} source-bus rider(s) will move to ${busName(combineTarget)}. The source bus will have 0 riders and can be reused. Before rollback, undo newer changes involving the source and reassign any riders from it so it has 0 riders.`;
    } else {
      byId("combine-impact-summary").textContent =
        "Choose both buses to review rider counts. The source bus will have 0 riders after combining and can be reused. Before rollback, undo newer changes involving it and make sure it has 0 riders.";
    }
    const useCustomRoutes = byId("combine-route-source").value === "custom";
    byId("combine-routes-file-field").hidden = !useCustomRoutes;
    byId("combine-routes-file").required = useCustomRoutes;
    byId("combine-routes-file").disabled = !useCustomRoutes;

    document.querySelectorAll("[data-change-mode]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.changeMode === state.changeMode));
    });
    document.querySelectorAll("[data-change-form]").forEach((form) => {
      form.hidden = form.dataset.changeForm !== state.changeMode;
    });
    renderTemporaryChangeList();
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
    byId("global-plan-notice").hidden = true;
    try {
      const result = await request("/api/bus/global-plan", {
        method: "PUT",
        body: JSON.stringify({ plan }),
      });
      if (result.activePlan !== plan) {
        throw new Error("The server did not confirm the selected operating service.");
      }
      const persistedPlan = await request("/api/bus/global-plan");
      if (persistedPlan.activePlan !== plan) {
        throw new Error(
          `The update response confirmed ${plan}, but the server still reports ${persistedPlan.activePlan || "an unknown plan"}. The active service was not verified.`,
        );
      }
      state.data.activePlan = result.activePlan;
      state.selectedGlobalPlan = result.activePlan;
      renderGlobalService();
      byId("global-plan-notice").hidden = true;
      showToast("Operating service updated. Assigned riders have been notified.");
      await loadData({ quiet: true });
    } catch (error) {
      const uncovered = error.data?.uncoveredBuses;
      const notice = byId("global-plan-notice");
      notice.textContent = `${error.message}${uncovered?.length ? ` Map these buses first: ${uncovered.map((bus) => `Bus ${bus}`).join(", ")}.` : ""}`;
      notice.classList.add("notice-error");
      notice.hidden = false;
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
      await loadAdminRecords();
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

  async function submitTemporaryAlteration(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = byId("temporary-alter-submit");
    const errorBox = byId("temporary-alter-error");
    errorBox.hidden = true;
    const sourceBusNo = form.elements.sourceBusNo.value;
    const targetBusNo = form.elements.targetBusNo.value;
    if (!sourceBusNo || !targetBusNo || sourceBusNo === targetBusNo) {
      errorBox.textContent = "Choose two different buses.";
      errorBox.hidden = false;
      return;
    }
    const source = state.adminBuses.find(
      (bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(sourceBusNo),
    );
    const target = state.adminBuses.find(
      (bus) => normalizedBusNo(bus.busNo) === normalizedBusNo(targetBusNo),
    );
    if (!source || activeRiderCount(source) === 0) {
      errorBox.textContent = "Choose a source bus with riders to move.";
      errorBox.hidden = false;
      return;
    }
    if (!target || activeRiderCount(target) !== 0) {
      errorBox.textContent = "Choose a replacement bus with 0 riders.";
      errorBox.hidden = false;
      return;
    }
    const confirmation =
      `Temporarily alter ${busName(source)} to use ${busName(target)} for live location?\n\n` +
      `${activeRiderCount(source)} source rider(s) will be assigned to the replacement bus. ` +
      "The source bus's stops remain unchanged; the replacement bus has 0 riders before the change.";
    if (!window.confirm(confirmation)) return;

    submit.disabled = true;
    submit.textContent = "Applying…";
    try {
      const result = await request(
        `/api/bus/alter-bus/${encodeURIComponent(sourceBusNo)}`,
        {
          method: "POST",
          body: JSON.stringify({
            newBusNo: targetBusNo,
          }),
        },
      );
      showToast(`${result.message} ${Number(result.notifiedStudents || 0)} rider(s) notified.`);
      form.reset();
      await loadData({ quiet: true });
    } catch (error) {
      errorBox.textContent = error.message || "Could not apply this temporary alteration.";
      errorBox.hidden = false;
      await loadData({ quiet: true });
    } finally {
      submit.disabled = false;
      submit.textContent = "Apply temporary alteration";
    }
  }

  async function submitTemporaryCombination(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = byId("temporary-combine-submit");
    const errorBox = byId("temporary-combine-error");
    const sourceBusNo = form.elements.sourceBusNo.value;
    const targetBusNo = form.elements.targetBusNo.value;
    const routeSource = form.elements.routeSource.value;
    errorBox.hidden = true;
    if (!sourceBusNo || !targetBusNo || sourceBusNo === targetBusNo) {
      errorBox.textContent = "Choose two different buses.";
      errorBox.hidden = false;
      return;
    }
    if (routeSource === "custom" && !form.elements.routesFile.files?.[0]) {
      errorBox.textContent = "Upload a route workbook for the combined service.";
      errorBox.hidden = false;
      return;
    }
    const source = state.adminBuses.find((bus) => bus.busNo === sourceBusNo);
    const target = state.adminBuses.find((bus) => bus.busNo === targetBusNo);
    const routeLabel = routeSource === "source"
      ? "source bus stops"
      : routeSource === "target"
        ? "handling bus stops"
        : "the uploaded routes";
    if (!window.confirm(
      `Temporarily combine ${busName(source)} with ${busName(target)} using ${routeLabel}?\n\n${activeRiderCount(source)} source rider(s) will move to the replacement bus, leaving the source with 0 riders. It can be reused in another temporary change. Roll back newer changes first and make sure this source has 0 riders before rolling back this combination.`,
    )) return;

    submit.disabled = true;
    submit.textContent = "Applying…";
    try {
      let body;
      if (routeSource === "custom") {
        body = new FormData(form);
      } else {
        body = JSON.stringify({ newBusNo: targetBusNo, routeSource });
      }
      if (body instanceof FormData) {
        body.set("newBusNo", targetBusNo);
        body.set("routeSource", routeSource);
      }
      const result = await request(
        `/api/bus/combine-bus/${encodeURIComponent(sourceBusNo)}`,
        { method: "POST", body },
      );
      showToast(`${result.message} ${Number(result.notifiedStudents || 0)} rider(s) notified.`);
      form.reset();
      byId("combine-route-source").value = "source";
      await loadData({ quiet: true });
    } catch (error) {
      errorBox.textContent = error.message || "Could not combine these buses.";
      errorBox.hidden = false;
      await loadData({ quiet: true });
    } finally {
      submit.disabled = false;
      submit.textContent = "Apply temporary combination";
      renderBusChangePage();
    }
  }

  async function rollbackTemporaryChange(changeId, isLegacy) {
    const change = state.temporaryChanges.find((item) => item.id === changeId);
    if (!change) return;
    const description = `Restore ${busName({ previewNumber: change.sourcePreview, busNo: change.sourceBusNo })} to normal service? Its original routes and saved rider assignments will be restored.`;
    if (!window.confirm(description)) return;
    try {
      const result = isLegacy
        ? await request(
          `/api/bus/restore-altered/${encodeURIComponent(change.sourceBusNo)}`,
          { method: "PUT" },
        )
        : await request(
          `/api/bus/temporary-changes/${encodeURIComponent(changeId)}/rollback`,
          { method: "POST", body: "{}" },
        );
      showToast(`${result.message || "Temporary change rolled back."} ${Number(result.notifiedStudents || 0)} rider(s) notified.`);
      await loadData({ quiet: true });
    } catch (error) {
      showToast(error.message || "Could not roll back this temporary change.", true);
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
    byId("temporary-alter-form").addEventListener("submit", submitTemporaryAlteration);
    byId("temporary-combine-form").addEventListener("submit", submitTemporaryCombination);
    byId("refresh-temporary-changes").addEventListener("click", () => loadData());
    document.querySelectorAll("[data-change-mode]").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.changeMode = tab.dataset.changeMode;
        renderBusChangePage();
      });
    });
    document.addEventListener("click", (event) => {
      const busChoice = event.target.closest("[data-bus-picker]");
      if (busChoice) {
        byId(busChoice.dataset.busPicker).value = busChoice.dataset.busNo;
        renderBusChangePage();
        return;
      }
      const routeChoice = event.target.closest("[data-route-picker]");
      if (routeChoice) {
        byId("combine-route-source").value = routeChoice.dataset.routePicker;
        renderBusChangePage();
      }
    });
    ["alter-source", "alter-target", "combine-source", "combine-target", "combine-route-source"]
      .forEach((id) => byId(id).addEventListener("change", renderBusChangePage));
    byId("temporary-changes-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-rollback-change]");
      if (!button) return;
      rollbackTemporaryChange(button.dataset.rollbackChange, button.dataset.legacy === "true");
    });
    byId("users-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-user-action]");
      if (!button) return;
      if (button.dataset.userAction === "edit") openUserEditor(button.dataset.userId);
      if (button.dataset.userAction === "deactivate") deactivateUser(button.dataset.userId);
      if (button.dataset.userAction === "activate") activateUser(button.dataset.userId);
    });
    byId("buses-list").addEventListener("click", (event) => {
      const card = event.target.closest("[data-bus-open]");
      if (card) {
        openBusOptions(card.dataset.busOpen);
        return;
      }
    });
    byId("bus-options-actions").addEventListener("click", (event) => {
      const button = event.target.closest("[data-bus-action]");
      if (!button) return;
      const { busAction, busNo } = button.dataset;
      byId("bus-options-dialog").close();
      if (busAction === "edit") openBusEditor(busNo);
      if (busAction === "routes") openRouteEditor(busNo);
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
      byId("global-plan-notice").hidden = true;
      byId("global-plan-notice").classList.remove("notice-error");
      renderGlobalService();
    });
    byId("users-search").addEventListener("input", (event) => {
      state.userSearch = event.currentTarget.value;
      renderUsers();
    });
    byId("users-role-filter").addEventListener("change", (event) => {
      state.userRoleFilter = event.currentTarget.value;
      renderUsers();
    });
    byId("users-status-filter").addEventListener("change", (event) => {
      state.userStatusFilter = event.currentTarget.value;
      renderUsers();
    });
    byId("users-bus-filter").addEventListener("change", (event) => {
      state.userBusFilter = event.currentTarget.value;
      renderUsers();
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
