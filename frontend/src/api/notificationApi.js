import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

export const notificationApi = {
  getAll: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  markRead: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications/read`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    }),
};

export default notificationApi;
