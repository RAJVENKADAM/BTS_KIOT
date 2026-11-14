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
import { createMutationKey } from "../utils/mutationKey";

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

  // Delete Excel upload
  deleteUpload: async (token, id, expectedVersion, idempotencyKey) => {
    try {
      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "If-Match": `"${expectedVersion}"`,
          },
          idempotencyKey,
        },
      );
      return data;
    } catch (error) {
      console.error("Delete Excel upload error:", error);
      throw error;
    }
  },

  // Get users by Excel upload
  getUsersByUpload: async (
    token,
    id,
    { page, limit = 100, cursor, cursorMode = false } = {},
  ) => {
    try {
      const params = [`limit=${encodeURIComponent(String(limit))}`];
      if (cursorMode || cursor) params.push("cursorMode=true");
      if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
      else if (page !== undefined) {
        params.push(`page=${encodeURIComponent(String(page))}`);
      }
      const data = await fetchJson(
        `${API_BASE_URL}/api/excel-management/${id}/users?${params.join("&")}`,
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
  updateUser: async (
    token,
    userId,
    payload,
    idempotencyKey = createMutationKey(),
  ) => {
    const body = {
      ...payload,
      expectedVersion: payload.expectedVersion,
      ...(payload.bus_no !== undefined || payload.role !== undefined
        ? { expectedAssignmentRevision: payload.assignmentRevision }
        : {}),
    };
    const data = await fetchJson(
      `${API_BASE_URL}/api/superadmin/users/${userId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        idempotencyKey,
      },
    );
    return data;
  },

  // Deactivate user (superadmin)
  deactivateUser: async (
    token,
    user,
    idempotencyKey = createMutationKey(),
  ) => {
    const userId = typeof user === "object" ? user.id : user;
    const versionedUser = typeof user === "object" ? user : null;
    const data = await fetchJson(
      `${API_BASE_URL}/api/superadmin/users/${userId}`,
      {
        method: "DELETE",
        idempotencyKey,
        body: JSON.stringify({
          expectedVersions: {
            [userId]: versionedUser?.resourceVersion,
          },
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    return data;
  },
};
