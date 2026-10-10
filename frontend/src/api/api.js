/**
 * API configuration and health check utility.
 * Defines the base URL for all backend API calls.
 */
import { fetchJson } from "../utils/errorHandler";

export const API_BASE_URL = "https://bts-kiot.onrender.com";
//export const API_BASE_URL = "http://10.227.91.77:5000";

export const healthCheck = async () => {
  try {
    return await fetchJson(`${API_BASE_URL}/health`, { timeoutMs: 10000 });
  } catch (err) {
    console.error("Health check failed:", err.message);
    throw err;
  }
};
