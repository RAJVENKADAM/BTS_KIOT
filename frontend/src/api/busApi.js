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
   * 
   * ⚠️ VALIDATION: Verifies the returned busNo matches the requested busNo.
   * If the backend returns data for a different bus, it's treated as "Bus Not Found"
   * to prevent displaying another bus's location.
   */
  getBusLocation: async (token, busNo) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/location/${busNo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    
    // Validate that the response belongs to the requested bus
    const returnedBusNo = data.busNo ?? data.bus_no ?? data.busNumber;
    const normalizedRequested = busNo.toUpperCase().trim();
    const normalizedReturned = returnedBusNo ? String(returnedBusNo).toUpperCase().trim() : null;
    
    if (normalizedReturned && normalizedReturned !== normalizedRequested) {
      console.warn(
        `busApi.getBusLocation: Mismatch! Requested ${normalizedRequested}, got ${normalizedReturned}. Treating as not found.`
      );
      const err = new Error('Bus not found');
      err.code = 'BUS_MISMATCH';
      throw err;
    }
    
    if (!data.success) {
      const msg = data.error || data.message || `No live data (${data.status || data.source || 'unknown'})`;
      const err = new Error(msg);
      err.code = data.error === 'Bus not found' ? 'BUS_NOT_FOUND' : 'NO_DATA';
      throw err;
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

  // Get plans + stops for a bus (current plan, plan names, all stops)
  getBusRoutes: async (token, busNo) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/routes/${busNo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to load routes');
    }
    return data;
  },

  // Change the current plan (superadmin)
  updatePlan: async (token, busNo, plan) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/update-plan/${busNo}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to update plan');
    }
    return data;
  },

  // Update bus details (preview number, GPS device id, reg no)
  updateBusDetails: async (token, busNo, payload) => {
    const response = await fetch(`${API_BASE_URL}/api/bus/update-bus-details/${busNo}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to update bus');
    }
    return data;
  },

};

// Export for convenience
export default busApi;

