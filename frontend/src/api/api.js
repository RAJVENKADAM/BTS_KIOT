/**
 * API configuration and health check utility.
 * Defines the base URL for all backend API calls.
 */
import { fetchJson } from "../utils/errorHandler";

export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://bts-kiot.onrender.com"
).replace(/\/+$/, "");

export const healthCheck = async () => {
  try {
    return await fetchJson(`${API_BASE_URL}/health`, { timeoutMs: 10000 });
  } catch (err) {
    console.error("Health check failed:", err.message);
    throw err;
  }
};
