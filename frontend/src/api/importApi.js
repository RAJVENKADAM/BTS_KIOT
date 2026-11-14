/**
 * importApi — Functions for importing users and bus routes via Excel JSON payloads.
 * Used by AddUsersScreen and AddBusesScreen.
 */
import { API_BASE_URL } from "./api";
import { fetchJson, getErrorMessage } from "../utils/errorHandler";

export async function importUsersExcelJson({
  token,
  users,
  excelCustomName,
  idempotencyKey,
}) {
  const data = await fetchJson(`${API_BASE_URL}/api/superadmin/import-users`, {
    timeoutMs: 120000,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users, excelCustomName }),
    idempotencyKey,
  });
  return data;
}

export async function uploadUsersExcelWorkbook({
  token,
  file,
  excelCustomName,
  idempotencyKey,
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
    idempotencyKey,
  });
}

export async function getImportOperation({ token, uploadId }) {
  return fetchJson(
    `${API_BASE_URL}/api/superadmin/imports/${encodeURIComponent(uploadId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
}

export async function importBusRoutesExcelJson({
  token,
  busPayload,
  idempotencyKey,
}) {
  const data = await fetchJson(`${API_BASE_URL}/api/bus/import-routes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(busPayload),
    idempotencyKey,
  });
  return data;
}
