import { API_BASE_URL } from './api';

export async function importUsersExcelJson({ token, users }) {
  const response = await fetch(`${API_BASE_URL}/api/superadmin/import-users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users }),
  });

  const rawText = await response.text();
  const data = rawText ? JSON.parse(rawText) : {};

  if (!response.ok) {
    throw new Error(data?.error || 'User import failed');
  }

  return data;
}

export async function importBusRoutesExcelJson({ token, busPayload }) {
  const response = await fetch(`${API_BASE_URL}/api/bus/import-routes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(busPayload),
  });

  const rawText = await response.text();
  const data = rawText ? JSON.parse(rawText) : {};

  if (!response.ok) {
    throw new Error(data?.error || 'Bus routes import failed');
  }

  return data;
}

