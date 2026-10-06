import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

const headersFor = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export const stopApi = {
  getCoordinateSheet: (token) =>
    fetchJson(`${API_BASE_URL}/api/stops/coordinates`, {
      headers: headersFor(token),
      timeoutMs: 60000,
    }),

  importCoordinates: (token, stops) =>
    fetchJson(`${API_BASE_URL}/api/stops/coordinates/import`, {
      method: "POST",
      headers: headersFor(token),
      body: JSON.stringify({ stops }),
    }),
};
