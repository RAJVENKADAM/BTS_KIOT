

/**
 * API configuration and health check utility.
 * Defines the base URL for all backend API calls.
 */
export const API_BASE_URL = "https://bts-bus-tracking-system-2.onrender.com";
//export const API_BASE_URL = "http://10.131.193.77:5000";

export const healthCheck = async () => {
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    const rawText = await res.text();
    return rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    console.error("Health check failed:", err.message);
    throw err;
  }
};

