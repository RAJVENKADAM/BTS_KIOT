/**
 * importApi — Functions for importing users and bus routes via Excel JSON payloads.
 * Used by AddUsersScreen and AddBusesScreen.
 */
import { API_BASE_URL } from "./api";
import { fetchJson, getErrorMessage } from "../utils/errorHandler";

export async function importUsersExcelJson({ token, users, excelCustomName }) {
  const data = await fetchJson(`${API_BASE_URL}/api/superadmin/import-users`, {
    timeoutMs: 120000,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users, excelCustomName }),
  });
  return data;
}

export async function uploadUsersExcelWorkbook({
  token,
  file,
  excelCustomName,
}) {
  const formData = new FormData();
  const fileName = file.name || "users.xlsx";
  if (file.file) {
    formData.append("file", file.file, fileName);
  } else {
    formData.append("file", {
      uri: file.uri,
      name: fileName,
      type:
        file.mimeType ||
        file.type ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
  formData.append("excelCustomName", excelCustomName);

  return fetchJson(`${API_BASE_URL}/api/superadmin/import-users-excel`, {
    timeoutMs: 0,
    method: "POST",
    headers: {
      Authorization: `******
    },
    body: formData,
  });
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
