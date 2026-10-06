import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

export const masterApi = {
  getRecommendation: async (token, latitude, longitude) => {
    const query = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
    }).toString();
    const data = await fetchJson(
      `${API_BASE_URL}/api/master/recommendation?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!data.success) {
      throw new Error(data.error || "Could not calculate your waiting stop.");
    }
    return data;
  },
};

export default masterApi;
