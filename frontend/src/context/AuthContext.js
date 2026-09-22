/**
 * AuthContext — Global authentication state management.
 * Provides login, logout, token persistence via AsyncStorage,
 * and exposes user, token, loading, isAuthenticated to the app tree.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "../api/api";
import { isNetworkError } from "../utils/errorHandler";

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  const isLoggingOut = useRef(false);
  const verifyIntervalRef = useRef(null);
  const sessionGenerationRef = useRef(0);

  const readToken = async () => {
    try {
      const secureToken = await SecureStore.getItemAsync("btms_token");
      if (secureToken) return secureToken;
    } catch (error) {
      console.warn("Secure token storage unavailable:", error?.message);
    }
    // One-time migration for sessions created by older builds.
    return AsyncStorage.getItem("token");
  };

  const writeToken = async (value) => {
    try {
      await SecureStore.setItemAsync("btms_token", value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      await AsyncStorage.removeItem("token");
    } catch (error) {
      console.warn("Secure token storage unavailable; using compatibility storage:", error?.message);
      await AsyncStorage.setItem("token", value);
    }
  };

  const clearAuthStorage = async () => {
    await Promise.allSettled([
      SecureStore.deleteItemAsync("btms_token"),
      AsyncStorage.multiRemove(["token", "user"]),
    ]);
  };

  // LOAD AUTH DATA
  useEffect(() => {
    loadAuthData();
  }, []);

  // PERIODIC TOKEN VERIFICATION — force logout if account is deactivated
  useEffect(() => {
    if (!token) {
      if (verifyIntervalRef.current) {
        clearInterval(verifyIntervalRef.current);
        verifyIntervalRef.current = null;
      }
      return;
    }

    const generation = ++sessionGenerationRef.current;
    const verifySession = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        // Any non-OK status (401/403) means the token is invalid or expired.
        // Force logout so the user can sign in again and get a fresh token.
        if (!response.ok) {
          console.log(
            "Session invalid — token rejected by server. Logging out.",
          );
          if (generation !== sessionGenerationRef.current) return;
          await clearAuthStorage();
          setToken(null);
          setUser(null);
          return;
        }

        const data = await response.json();
        if (data.deactivated === true || data.valid === false) {
          console.log(
            "Session invalid — account deactivated or token expired. Logging out.",
          );
          if (generation !== sessionGenerationRef.current) return;
          await clearAuthStorage();
          setToken(null);
          setUser(null);
        }
      } catch (err) {
        console.log("Token verify network error:", err.message);
      }
    };

    verifyIntervalRef.current = setInterval(verifySession, 30000);

    return () => {
      if (verifyIntervalRef.current) {
        clearInterval(verifyIntervalRef.current);
        verifyIntervalRef.current = null;
      }
    };
  }, [token]);

  // LOAD FROM STORAGE — validates token with backend before restoring session
  const loadAuthData = async () => {
    try {
      const storedToken = await readToken();
      const storedUser = await AsyncStorage.getItem("user");

      if (storedToken && storedUser) {
        try {
          const parsedUser = JSON.parse(storedUser);

          // Verify token with backend before restoring session
          const verifyRes = await fetch(`${API_BASE_URL}/api/auth/verify`, {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          // Non-OK response (401/403) means the stored token is invalid/expired.
          // Clear the session and send the user to the login screen.
          if (!verifyRes.ok) {
            console.log("Stored token rejected on startup — clearing session.");
            await clearAuthStorage();
            return;
          }

          const verifyData = await verifyRes.json();

          if (verifyData.deactivated === true || verifyData.valid === false) {
            await clearAuthStorage();
            return;
          }

          setToken(storedToken);
          setUser(parsedUser);
        } catch (verifyError) {
          // Network error on startup verify — restore cached session anyway,
          // periodic check will handle it if account gets deactivated later
          console.log(
            "Token verify failed on startup (network), restoring cached session",
          );
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        }
      }
    } catch (error) {
      console.log("Load auth error:", error);
      try {
        await AsyncStorage.multiRemove(["token", "user"]);
      } catch (clearError) {
        console.log("Storage clear error:", clearError);
      }
    } finally {
      setLoading(false);
    }
  };

  // LOGIN
  const login = async (email, password) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (jsonError) {
        return {
          success: false,
          error: "Invalid server response",
        };
      }

      if (response.ok) {
        if (!data.token || !data.user) {
          return {
            success: false,
            error: "Incomplete server response - missing token or user data",
          };
        }

        if (typeof data.user.role !== "string" || typeof data.user.is_active !== "boolean") {
          return { success: false, error: "Invalid account data returned by server" };
        }
        if (!data.user.is_active && data.user.role.toLowerCase() !== "superadmin") {
          return { success: false, error: "Account deactivated. Contact admin." };
        }
        await writeToken(data.token);
        await AsyncStorage.setItem("user", JSON.stringify(data.user));

        setToken(data.token);
        setUser(data.user);

        return {
          success: true,
          data,
        };
      }

      return {
        success: false,
        error: data.error || data.message || "Login failed",
      };
    } catch (error) {
      return {
        success: false,
        error: isNetworkError(error)
          ? "Cannot connect to the server. Please check your internet connection."
          : `Login failed: ${error.message}`,
      };
    }
  };

  // LOGOUT
  const logout = async () => {
    if (isLoggingOut.current) {
      return;
    }

    isLoggingOut.current = true;
    sessionGenerationRef.current += 1;

    try {
      if (token) {
        try {
          await fetch(`${API_BASE_URL}/api/auth/logout`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          });
        } catch (apiError) {
          // Best-effort logout
        }
      }

      await clearAuthStorage();

      setToken(null);
      setUser(null);
    } catch (error) {
      try {
        await clearAuthStorage();
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
      await AsyncStorage.setItem("user", JSON.stringify(userData));
      setUser(userData);
    } catch (error) {
      console.log("Update user error:", error);
    }
  };

  // DELETE ACCOUNT
  const deleteAccount = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/account`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const rawText = await response.text();

      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (jsonError) {
        return {
          success: false,
          error: "Invalid server response",
        };
      }

      if (response.ok) {
        await clearAuthStorage();
        setToken(null);
        setUser(null);

        return {
          success: true,
          message: data.message,
        };
      }

      return {
        success: false,
        error: data.error || "Account deletion failed",
      };
    } catch (error) {
      return {
        success: false,
        error: isNetworkError(error)
          ? "Cannot connect to the server. Please check your internet connection."
          : error.message || "Account deletion failed",
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
