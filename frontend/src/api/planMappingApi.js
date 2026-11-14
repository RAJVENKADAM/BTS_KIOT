import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

let mappingVersions = {};
let clusterPlans = new Map();
let clusterBusRevisions = new Map();
let globalPlanVersion = 0;
const pendingMutationKeys = new Map();

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function mutationHeaders(token, signature) {
  let idempotencyKey = pendingMutationKeys.get(signature);
  if (!idempotencyKey) {
    idempotencyKey = createIdempotencyKey();
    pendingMutationKeys.set(signature, idempotencyKey);
  }
  return {
    ...authHeaders(token),
    "Idempotency-Key": idempotencyKey,
  };
}

function completeMutation(signature) {
  pendingMutationKeys.delete(signature);
}

const planMappingApi = {
  get: async (token) => {
    const result = await fetchJson(`${API_BASE_URL}/api/bus/plan-mappings`, {
      cache: "no-store",
      headers: authHeaders(token),
    });
    mappingVersions = result.versions || {};
    globalPlanVersion = result.globalPlanVersion ?? 0;
    clusterPlans = new Map(
      (result.clusters || []).map((cluster) => [cluster.id, cluster.planName]),
    );
    clusterBusRevisions = new Map(
      (result.clusters || []).map((cluster) => [
        cluster.id,
        cluster.rootBus?.revision ?? 0,
      ]),
    );
    return result;
  },

  save: (token, mapping) => {
    const expectedVersion =
      mapping.expectedVersion ?? mappingVersions[mapping.planName] ?? 0;
    const signature = `save:${JSON.stringify({ ...mapping, expectedVersion })}`;
    return fetchJson(`${API_BASE_URL}/api/bus/plan-mappings`, {
      method: "POST",
      headers: mutationHeaders(token, signature),
      body: JSON.stringify({ ...mapping, expectedVersion }),
    }).then((result) => {
      completeMutation(signature);
      if (result.version !== undefined) {
        mappingVersions[mapping.planName] = result.version;
      }
      if (result.clusterId) clusterPlans.set(result.clusterId, mapping.planName);
      return result;
    });
  },

  updateRoutes: (token, clusterId, stops) => {
    const planName = clusterPlans.get(clusterId);
    if (!planName) {
      return Promise.reject(new Error("Reload plan mappings before editing this route."));
    }
    const expectedVersion = mappingVersions[planName] ?? 0;
    const expectedBusVersion = clusterBusRevisions.get(clusterId);
    if (!Number.isSafeInteger(expectedBusVersion)) {
      return Promise.reject(
        new Error("Reload plan mappings before editing this route."),
      );
    }
    const signature = `routes:${clusterId}:${JSON.stringify({
      stops,
      expectedVersion,
      expectedBusVersion,
    })}`;
    return fetchJson(
      `${API_BASE_URL}/api/bus/plan-mappings/${encodeURIComponent(clusterId)}/routes`,
      {
        method: "PUT",
        headers: mutationHeaders(token, signature),
        body: JSON.stringify({ stops, expectedVersion, expectedBusVersion }),
      },
    ).then((result) => {
      completeMutation(signature);
      if (result.version !== undefined) mappingVersions[planName] = result.version;
      if (result.busRevision !== undefined) {
        clusterBusRevisions.set(clusterId, result.busRevision);
      }
      return result;
    });
  },

  remove: (token, clusterId) => {
    const planName = clusterPlans.get(clusterId);
    if (!planName) {
      return Promise.reject(new Error("Reload plan mappings before deleting this cluster."));
    }
    const expectedVersion = mappingVersions[planName] ?? 0;
    const signature = `remove:${clusterId}:${expectedVersion}`;
    return fetchJson(
      `${API_BASE_URL}/api/bus/plan-mappings/${encodeURIComponent(clusterId)}`,
      {
        method: "DELETE",
        headers: {
          ...mutationHeaders(token, signature),
          "If-Match": `"${expectedVersion}"`,
        },
      },
    ).then((result) => {
      completeMutation(signature);
      if (result.version !== undefined) mappingVersions[planName] = result.version;
      clusterPlans.delete(clusterId);
      return result;
    });
  },

  setActivePlan: (token, plan) => {
    const expectedVersion = globalPlanVersion;
    const signature = `global-plan:${JSON.stringify({ plan, expectedVersion })}`;
    return fetchJson(`${API_BASE_URL}/api/bus/global-plan`, {
      method: "PUT",
      headers: {
        ...mutationHeaders(token, signature),
        "If-Match": `"${expectedVersion}"`,
      },
      body: JSON.stringify({ plan, expectedVersion }),
    }).then((result) => {
      completeMutation(signature);
      if (result.version !== undefined) globalPlanVersion = result.version;
      return result;
    });
  },
};

export default planMappingApi;
