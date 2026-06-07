// Dedicated bus API module
import { API_BASE_URL } from './api';

export const busApi = {
  /**
   * Track bus by preview number (live GPS) - legacy
   */
  trackByPreview: async (token, previewNumber) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/track-by-preview/${previewNumber}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.json();
  },

  /**
   * Get live location for bus by busNo - new scalable endpoint
   */
  getBusLocation: async (token, busNo) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/location/${busNo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!data.success) {
      const msg = data.message || `No live data (${data.status || data.source || 'unknown'})`;
      throw new Error(msg);
    }
    return data;
  },

  validatePreview: async (token, previewNumber) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/validate-preview/${previewNumber}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return response.json();
  },

  updatePreview: async (token, busNo, previewNumber) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/update-preview/${busNo}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ previewNumber }),
    });
    return response.json();
  },

};

// Export for convenience
export default busApi;

