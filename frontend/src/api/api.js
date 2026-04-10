import Constants from "expo-constants";

const getApiBaseUrl = () => {
  // Use your actual PC IP address
  return "http://10.197.120.77:5000";

  // FOR TESTING: Force localhost
  // return "http://localhost:5000";

  // Works reliably in Expo Go
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.manifest2?.extra?.expoClient?.hostUri;

  if (hostUri) {
    const host = hostUri.split(":")[0];
    // Try to get the correct IP - if it's localhost, try to detect the actual IP
    if (host === "localhost" || host === "127.0.0.1") {
      // In development, try to get the actual IP from the manifest
      const actualHost = Constants.manifest?.debuggerHost?.split(":")[0];
      if (actualHost && actualHost !== "localhost" && actualHost !== "127.0.0.1") {
        return `http://${actualHost}:5000`;
      }
    }
    return `http://${host}:5000`;
  }

  // Try to get the debugger host from manifest
  const debuggerHost = Constants.manifest?.debuggerHost;
  if (debuggerHost) {
    const host = debuggerHost.split(":")[0];
    return `http://${host}:5000`;
  }

  // FINAL fallback (your PC IP)
  return "http://10.12.232.134:5000";
};

export const API_BASE_URL = getApiBaseUrl();

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

