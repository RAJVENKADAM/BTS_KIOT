import { API_BASE_URL } from "./api";
import { fetchJson } from "../utils/errorHandler";

export const notificationApi = {
  getAll: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  getUnreadCount: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  markRead: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications/read`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    }),
  markOneRead: (token, id) =>
    fetchJson(`${API_BASE_URL}/api/notifications/${encodeURIComponent(id)}/read`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    }),
  remove: (token, id) =>
    fetchJson(`${API_BASE_URL}/api/notifications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  removeAll: (token) =>
    fetchJson(`${API_BASE_URL}/api/notifications`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
};

export default notificationApi;
