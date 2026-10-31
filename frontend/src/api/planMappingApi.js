import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

const planMappingApi = {
  get: (token) =>
    fetchJson(`${API_BASE_URL}/api/bus/plan-mappings`, {
      cache: "no-store",
      headers: authHeaders(token),
    }),

  save: (token, mapping) =>
    fetchJson(`${API_BASE_URL}/api/bus/plan-mappings`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(mapping),
    }),

  remove: (token, clusterId) =>
    fetchJson(
      `${API_BASE_URL}/api/bus/plan-mappings/${encodeURIComponent(clusterId)}`,
      {
        method: "DELETE",
        headers: authHeaders(token),
      },
    ),

  setActivePlan: (token, plan) =>
    fetchJson(`${API_BASE_URL}/api/bus/global-plan`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ plan }),
    }),
};

export default planMappingApi;
