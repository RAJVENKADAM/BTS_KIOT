import { API_BASE_URL } from './api';

export const excelManagementApi = {
  // Get all Excel uploads
  getAllUploads: async (token) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/excel-management`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch Excel uploads');
      }

      return data;
    } catch (error) {
      console.error('Get Excel uploads error:', error);
      throw error;
    }
  },

  // Get specific Excel upload
  getUpload: async (token, id) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/excel-management/${id}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch Excel upload');
      }

      return data;
    } catch (error) {
      console.error('Get Excel upload error:', error);
      throw error;
    }
  },

  // Re-upload Excel file
  reupload: async (token, id, file) => {
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: file.uri,
        name: file.name || 'users.xlsx',
        type: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const response = await fetch(`${API_BASE_URL}/api/excel-management/${id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });

      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        throw new Error(data.error || 'Failed to re-upload Excel file');
      }

      return data;
    } catch (error) {
      console.error('Re-upload Excel error:', error);
      throw error;
    }
  },

  // Delete Excel upload
  deleteUpload: async (token, id) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/excel-management/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete Excel upload');
      }

      return data;
    } catch (error) {
      console.error('Delete Excel upload error:', error);
      throw error;
    }
  },

  // Get users by Excel upload
  getUsersByUpload: async (token, id) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/excel-management/${id}/users`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch users');
      }

      return data;
    } catch (error) {
      console.error('Get users by upload error:', error);
      throw error;
    }
  }
};