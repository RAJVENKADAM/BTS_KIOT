/**
 * API configuration and health check utility.
 * Defines the base URL for all backend API calls.
 */
import { fetchJson } from "../utils/errorHandler";
import { Platform } from "react-native";
const { resolveBackendEnvironment } = require("../config/backendEnvironment.cjs");

const backendEnvironment = resolveBackendEnvironment({
  environment: process.env.EXPO_PUBLIC_BTMS_ENV,
  nodeEnvironment: process.env.NODE_ENV,
  platform: Platform.OS,
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  allowRemoteTests: process.env.EXPO_PUBLIC_ALLOW_REMOTE_TESTS,
});

export const API_BASE_URL = backendEnvironment.apiBaseUrl;
export const SOCKET_BASE_URL = API_BASE_URL;
export const BACKEND_ENVIRONMENT = backendEnvironment.environment;

export const healthCheck = async () => {
  try {
    return await fetchJson(`${API_BASE_URL}/health`, { timeoutMs: 10000 });
  } catch (err) {
    console.error("Health check failed:", err.message);
    throw err;
  }
};
