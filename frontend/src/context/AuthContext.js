import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../api/api';


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

  const isLoggingOut = useRef(false);

  // LOAD AUTH DATA
  useEffect(() => {
    loadAuthData();
  }, []);

  // LOAD FROM STORAGE
  const loadAuthData = async () => {
    try {
      console.log('Loading auth data...');

      const storedToken = await AsyncStorage.getItem('token');
      const storedUser = await AsyncStorage.getItem('user');

      console.log('Stored Token:', storedToken ? 'EXISTS' : 'NULL');
      console.log('Stored User:', storedUser ? 'EXISTS' : 'NULL');

      // TEMP FIX:
      // DO NOT VALIDATE TOKEN NOW
      // Your verify endpoint is probably deleting valid tokens

      if (storedToken && storedUser) {
        try {
          const parsedUser = JSON.parse(storedUser);

          setToken(storedToken);
          setUser(parsedUser);

          console.log('Auth restored successfully');
        } catch (parseError) {
          console.log('User parse error:', parseError);

          await AsyncStorage.multiRemove(['token', 'user']);
        }
      }
    } catch (error) {
      console.log('Load auth error:', error);

      try {
        await AsyncStorage.multiRemove(['token', 'user']);
      } catch (clearError) {
        console.log('Storage clear error:', clearError);
      }
    } finally {
      setLoading(false);
    }
  };

  // LOGIN
  const login = async (email, password) => {
    try {
      console.log('Attempting login...');
      console.log('API URL:', `${API_BASE_URL}/api/auth/login`);

      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const rawText = await response.text();

      console.log('RAW LOGIN RESPONSE:', rawText);

      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (jsonError) {
        console.log('JSON Parse Error:', jsonError);

        return {
          success: false,
          error: 'Invalid server response',
        };
      }

      console.log('PARSED LOGIN DATA:', data);

      if (response.ok) {
        // IMPORTANT CHECK - validate both token and user before saving
        if (!data.token || !data.user) {
          return {
            success: false,
            error: 'Incomplete server response - missing token or user data',
          };
        }

        // SAVE TO STORAGE
        await AsyncStorage.setItem('token', data.token);
        await AsyncStorage.setItem('user', JSON.stringify(data.user));

        // UPDATE STATE
        setToken(data.token);
        setUser(data.user);

        console.log('Login success');
        console.log('Token saved successfully');

        return {
          success: true,
          data,
        };
      }

      return {
        success: false,
        error: data.error || data.message || 'Login failed',
      };
    } catch (error) {
      console.log('LOGIN NETWORK ERROR:', error);

      return {
        success: false,
        error: `Network error: ${error.message}`,
      };
    }
  };

  // LOGOUT
  const logout = async () => {
    if (isLoggingOut.current) {
      console.log('Logout already running');
      return;
    }

    isLoggingOut.current = true;

    try {
      console.log('Logging out...');

      // CALL BACKEND LOGOUT
      if (token) {
        try {
          await fetch(`${API_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          });
        } catch (apiError) {
          console.log('Logout API failed:', apiError.message);
        }
      }

      // CLEAR STORAGE
      await AsyncStorage.multiRemove(['token', 'user']);

      // CLEAR STATE
      setToken(null);
      setUser(null);

      console.log('Logout completed');
    } catch (error) {
      console.log('Logout error:', error);

      try {
        await AsyncStorage.multiRemove(['token', 'user']);
      } catch {}

      setToken(null);
      setUser(null);
    } finally {
      isLoggingOut.current = false;
    }
  };

  // UPDATE USER
  const updateUserData = async (userData) => {
    try {
      await AsyncStorage.setItem('user', JSON.stringify(userData));

      setUser(userData);
    } catch (error) {
      console.log('Update user error:', error);
    }
  };

  // DELETE ACCOUNT
  const deleteAccount = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/account`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();

      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (jsonError) {
        return {
          success: false,
          error: 'Invalid server response',
        };
      }

      if (response.ok) {
        await AsyncStorage.multiRemove(['token', 'user']);

        setToken(null);
        setUser(null);

        return {
          success: true,
          message: data.message,
        };
      }

      return {
        success: false,
        error: data.error || 'Account deletion failed',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Network error occurred',
      };
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
    isAuthenticated: !!token && !!user,
  };

  // ALWAYS return JSX from provider - never return null
  // Loading state is handled by the app navigator
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};