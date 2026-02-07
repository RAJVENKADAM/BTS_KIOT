import { API_BASE_URL } from './api';

export const login = async (email, password) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    // SAFELY handle response
    const rawText = await response.text();
    console.log("RAW API RESPONSE (authApi):", rawText);

    const data = rawText ? JSON.parse(rawText) : {};

    if (response.ok) {
      return { success: true, data };
    } else {
      return { success: false, error: data.error || 'Login failed' };
    }
  } catch (error) {
    console.error('Login API error details:', error);
    console.error('Attempted URL:', `${API_BASE_URL}/api/auth/login`);
    console.error('API Base URL:', API_BASE_URL);
    return { success: false, error: 'Network error occurred' };
  }
};

export const logout = async (token) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    // SAFELY handle response
    const rawText = await response.text();
    const data = rawText ? JSON.parse(rawText) : {};

    if (response.ok) {
      return { success: true, data };
    } else {
      return { success: false, error: data.error || 'Logout failed' };
    }
  } catch (error) {
    console.error('Logout API error:', error);
    return { success: false, error: 'Network error occurred' };
  }
};



export const deleteAccount = async (token) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/account`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    // SAFELY handle response
    const rawText = await response.text();
    const data = rawText ? JSON.parse(rawText) : {};

    if (response.ok) {
      return { success: true, data };
    } else {
      return { success: false, error: data.error || 'Account deletion failed' };
    }
  } catch (error) {
    console.error('Delete account API error:', error);
    return { success: false, error: 'Network error occurred' };
  }
};