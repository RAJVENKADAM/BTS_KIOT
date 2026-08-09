/**
 * excelManagementApi — CRUD operations for Excel uploads and user management.
 * Used by AddUsersScreen for importing/managing users via Excel.
 */
import { API_BASE_URL } from "./api";
import {
  fetchJson,
  isNetworkError,
  getErrorMessage,
} from "../utils/errorHandler";

export const excelManagementApi = {
  // Get all Excel uploads
  getAllUploads: async (token) => {
    try {
      const data = await fetchJson(`${API_BASE_URL}/api/excel-management`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      return data;
    } catch (error) {
      console.error("Get Excel uploads error:", error);
      throw error;
    }
  },

  // Get specific Excel upload
  getUpload: async (token, id) => {
    try {
      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      return data;
    } catch (error) {
      console.error("Get Excel upload error:", error);
      throw error;
    }
  },

  // Re-upload Excel file
  reupload: async (token, id, file) => {
    try {
      const formData = new FormData();
      formData.append("file", {
        uri: file.uri,
        name: file.name || "users.xlsx",
        type:
          file.type ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        },
      );
      return data;
    } catch (error) {
      console.error("Re-upload Excel error:", error);
      throw error;
    }
  },

  // Delete Excel upload
  deleteUpload: async (token, id) => {
    try {
      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      return data;
    } catch (error) {
      console.error("Delete Excel upload error:", error);
      throw error;
    }
  },

  // Get users by Excel upload
  getUsersByUpload: async (token, id) => {
    try {
      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}/users`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      return data;
    } catch (error) {
      console.error("Get users by upload error:", error);
      throw error;
    }
  },

  // Update user (superadmin)
  updateUser: async (token, userId, payload) => {
    const data = await fetchJson(
      `${API_BASE_URL}/api/superadmin/users/${userId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    return data;
  },

  // Deactivate user (superadmin)
  deactivateUser: async (token, userId) => {
    const data = await fetchJson(
      `${API_BASE_URL}/api/superadmin/users/${userId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    return data;
  },
};
