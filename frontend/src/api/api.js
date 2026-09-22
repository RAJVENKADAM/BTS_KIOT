/**
 * API configuration and health check utility.
 * Defines the base URL for all backend API calls.
 */
export const API_BASE_URL = "https://bts-kiot.onrender.com";
//export const API_BASE_URL = "http://10.107.1.77:5000";

export const healthCheck = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(`${API_BASE_URL}/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`Health check failed (${res.status})`);
    const rawText = await res.text();
    return rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    console.error("Health check failed:", err.message);
    throw err;
  }
};
