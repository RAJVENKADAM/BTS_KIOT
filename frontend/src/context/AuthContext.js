import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CommonActions } from '@react-navigation/native';
import { API_BASE_URL } from '../api/api';
import { registerForPushNotificationsAsync } from '../services/notificationService';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const isLoggingOut = useRef(false); // Prevent concurrent logout attempts

  // Load auth data from storage on app start
  useEffect(() => {
    loadAuthData();
  }, []);

  const validateToken = async (token) => {
    if (!token) return false;

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        return data.valid === true;
      }
      return false;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  };

  const loadAuthData = async () => {
    try {
      const storedToken = await AsyncStorage.getItem('token');
      const storedUser = await AsyncStorage.getItem('user');
      
      if (storedToken && storedUser) {
        // Validate token before setting
        const isValid = await validateToken(storedToken);
        if (isValid) {
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        } else {
          // Invalid token - clear storage
          await AsyncStorage.multiRemove(['token', 'user']);
          console.log('Invalid/expired token cleared');
        }
      }
    } catch (error) {
      console.error('Load auth data error:', error);
      // Clear on error
      try {
        await AsyncStorage.multiRemove(['token', 'user']);
      } catch (clearError) {
        console.error('Clear storage error:', clearError);
      }
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
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
      console.log("RAW API RESPONSE (AuthContext):", rawText);

      const data = rawText ? JSON.parse(rawText) : {};

      if (response.ok) {
        // Save token and user data
        await AsyncStorage.setItem('token', data.token);
        await AsyncStorage.setItem('user', JSON.stringify(data.user));

        setToken(data.token);
        setUser(data.user);

        // Register push token AFTER login success (with bus_no)
        if (data.user?.bus_no) {
          try {
            console.log('[AuthContext] Registering push token post-login for bus:', data.user.bus_no);
            await registerForPushNotificationsAsync(data.user.bus_no);
          } catch (pushErr) {
            console.error('[AuthContext] Push token registration failed (non-blocking):', pushErr.message);
          }
        } else {
          console.log('[AuthContext] User has no bus_no assigned, skipping push registration');
        }

        return { success: true, data };
      } else {
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      console.error('Login network error details:', error);
      console.error('Attempted URL:', `${API_BASE_URL}/api/auth/login`);
      console.error('API Base URL:', API_BASE_URL);
      return { success: false, error: `Network error: ${error.message}. Please check your connection and server availability.` };
    }
  };

  const logout = async () => {
    // Prevent concurrent logout attempts
    if (isLoggingOut.current) {
      console.log('Logout already in progress, ignoring request');
      return;
    }

    isLoggingOut.current = true;

    try {
      // Attempt to call logout endpoint
      if (token) {
        try {
          await fetch(`${API_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          });
        } catch (apiError) {
          // Ignore API errors as we'll clear local storage regardless
          console.log('Logout API call failed (this is expected if token is expired):', apiError.message);
        }
      }

      // Clear local storage first
      await AsyncStorage.removeItem('token');
      await AsyncStorage.removeItem('user');

      // Update state immediately
      setToken(null);
      setUser(null);

      console.log('Logout completed successfully - user logged out and redirected to login');
    } catch (error) {
      console.error('Logout error:', error);
      // Still clear local data even if something goes wrong
      await AsyncStorage.removeItem('token');
      await AsyncStorage.removeItem('user');
      setToken(null);
      setUser(null);
    } finally {
      isLoggingOut.current = false;
    }
  };

  const updateUserData = async (userData) => {
    try {
      await AsyncStorage.setItem('user', JSON.stringify(userData));
      setUser(userData);
    } catch (error) {
      // Error silently handled
    }
  };



  const deleteAccount = async () => {
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
        // Clear local storage and state
        await AsyncStorage.removeItem('token');
        await AsyncStorage.removeItem('user');
        setToken(null);
        setUser(null);
        return { success: true, message: data.message };
      } else {
        return { success: false, error: data.error || 'Account deletion failed' };
      }
    } catch (error) {
      return { success: false, error: 'Network error occurred' };
    }
  };

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    updateUserData,
    deleteAccount,
    isAuthenticated: !!token && !!user
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};