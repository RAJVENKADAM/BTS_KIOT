

export const API_BASE_URL = "https://bts-bus-tracking-system-2.onrender.com";

export const healthCheck = async () => {
  console.log("Attempting health check to:", `${API_BASE_URL}/health`);
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    console.log("Health check response status:", res.status);

    // SAFELY handle response
    const rawText = await res.text();
    console.log("RAW HEALTH RESPONSE:", rawText);

    const data = rawText ? JSON.parse(rawText) : {};
    console.log("Health check response data:", data);
    return data;
  } catch (err) {
    console.log("API BASE URL:", API_BASE_URL);
    console.error("Health check failed:", err.message);
    console.error("Full error object:", err);
    throw err;
  }
};

