/**
 * importApi — Functions for importing users and bus routes via Excel JSON payloads.
 * Used by AddUsersScreen and AddBusesScreen.
 */
import { API_BASE_URL } from "./api";
import { fetchJson, getErrorMessage } from "../utils/errorHandler";

export async function importUsersExcelJson({ token, users, excelCustomName }) {
  const data = await fetchJson(`${API_BASE_URL}/api/superadmin/import-users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users, excelCustomName }),
  });
  return data;
}

export async function importBusRoutesExcelJson({ token, busPayload }) {
  const data = await fetchJson(`${API_BASE_URL}/api/bus/import-routes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(busPayload),
  });
  return data;
}
