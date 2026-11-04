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
import { fetchJson, getErrorMessage } from "../utils/errorHandler";
const { shouldClearAuthSession } = require("../auth/sessionPolicy.cjs");

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
  const verifyTimeoutRef = useRef(null);
  const sessionGenerationRef = useRef(0);
  const loginPromiseRef = useRef(null);
  const storageMutationRef = useRef(Promise.resolve());

  const mutateAuthStorage = (operation) => {
    const result = storageMutationRef.current.then(operation, operation);
    storageMutationRef.current = result.catch(() => {});
    return result;
  };

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

  const persistAuth = (value, userData) =>
    mutateAuthStorage(async () => {
      await AsyncStorage.setItem("user", JSON.stringify(userData));
      try {
        await SecureStore.setItemAsync("btms_token", value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await AsyncStorage.removeItem("token");
      } catch (error) {
        console.warn(
          "Secure token storage unavailable; using compatibility storage:",
          error?.message,
        );
        await AsyncStorage.setItem("token", value);
      }
    });

  const persistUserData = (userData) =>
    mutateAuthStorage(() =>
      AsyncStorage.setItem("user", JSON.stringify(userData)),
    );

  const clearAuthStorage = () =>
    mutateAuthStorage(async () => {
      const results = await Promise.allSettled([
        SecureStore.deleteItemAsync("btms_token"),
        AsyncStorage.multiRemove(["token", "user"]),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Unable to clear all stored authentication data");
      }
    });

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
      if (verifyTimeoutRef.current) {
        clearTimeout(verifyTimeoutRef.current);
        verifyTimeoutRef.current = null;
      }
      return;
    }

    const generation = sessionGenerationRef.current;
    let verificationInFlight = false;
    const verifySession = async () => {
      if (verificationInFlight) return;
      verificationInFlight = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const data = await response.json().catch(() => ({}));
        if (shouldClearAuthSession(response.status, data)) {
          console.log(
            "Session invalid — account deactivated or token expired. Logging out.",
          );
          if (generation !== sessionGenerationRef.current) return;
          try {
            await clearAuthStorage();
          } catch (error) {
            console.error("Unable to clear invalid auth session:", error);
          }
          setToken(null);
          setUser(null);
        }
      } catch (err) {
        console.log("Token verify network error:", err.message);
      } finally {
        verificationInFlight = false;
      }
    };

    verifyTimeoutRef.current = setTimeout(() => {
      verifySession();
      verifyIntervalRef.current = setInterval(verifySession, 5 * 60 * 1000);
    }, Math.random() * 60 * 1000);

    return () => {
      if (verifyTimeoutRef.current) {
        clearTimeout(verifyTimeoutRef.current);
        verifyTimeoutRef.current = null;
      }
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
        let sessionInvalid = false;
        try {
          const parsedUser = JSON.parse(storedUser);
          if (
            typeof parsedUser?.role === "string" &&
            parsedUser.role.toLowerCase() === "superadmin"
          ) {
            sessionInvalid = true;
            await clearAuthStorage();
            return;
          }

          // Verify token with backend before restoring session
          const verifyRes = await fetch(`${API_BASE_URL}/api/auth/verify`, {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          const verifyData = await verifyRes.json().catch(() => ({}));
          if (shouldClearAuthSession(verifyRes.status, verifyData)) {
            sessionInvalid = true;
            await clearAuthStorage();
            return;
          }

          setToken(storedToken);
          setUser(parsedUser);
        } catch (verifyError) {
          if (sessionInvalid) return;
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
    } finally {
      setLoading(false);
    }
  };

  // LOGIN
  const login = (email, password) => {
    if (isLoggingOut.current) {
      return Promise.resolve({
        success: false,
        error: "Sign out is still in progress. Please try again.",
      });
    }
    if (loginPromiseRef.current) return loginPromiseRef.current;

    const operation = ++sessionGenerationRef.current;
    const request = (async () => {
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
          }),
        });

        if (!data.token || !data.user) {
          return {
            success: false,
            error: "The server returned an incomplete sign-in response. Please try again.",
          };
        }

        if (
          typeof data.user.role !== "string" ||
          typeof data.user.is_active !== "boolean"
        ) {
          return {
            success: false,
            error: "The server returned invalid account details. Please try again.",
          };
        }
        if (data.user.role.toLowerCase() === "superadmin") {
          return {
            success: false,
            error: "Super Admin management is available on the web dashboard only.",
          };
        }
        if (!data.user.is_active) {
          return { success: false, error: "Account deactivated. Contact admin." };
        }
        if (operation !== sessionGenerationRef.current) {
          return { success: false, error: "Sign-in was cancelled." };
        }

        await persistAuth(data.token, data.user);
        if (operation !== sessionGenerationRef.current) {
          return { success: false, error: "Sign-in was cancelled." };
        }

        setToken(data.token);
        setUser(data.user);
        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error:
            error?.status === 401
              ? "Email or password is incorrect."
              : getErrorMessage(error, "Unable to sign in. Please try again."),
        };
      }
    })();

    loginPromiseRef.current = request;
    return request.finally(() => {
      if (loginPromiseRef.current === request) {
        loginPromiseRef.current = null;
      }
    });
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
          void fetch(`${API_BASE_URL}/api/auth/logout`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }).catch((apiError) =>
            console.warn("Server logout request failed:", apiError?.message),
          );
        } catch (apiError) {
          console.warn("Server logout request failed:", apiError?.message);
        }
      }

      await clearAuthStorage();

      setToken(null);
      setUser(null);
    } catch (error) {
      console.error("Unable to clear auth storage during logout:", error);
      setToken(null);
      setUser(null);
    } finally {
      isLoggingOut.current = false;
    }
  };

  // UPDATE USER
  const updateUserData = async (userData) => {
    if (isLoggingOut.current || !token) return;
    const operation = sessionGenerationRef.current;
    try {
      await persistUserData(userData);
      if (operation !== sessionGenerationRef.current || isLoggingOut.current) {
        return;
      }
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
        error: getErrorMessage(
          {
            status: response.status,
            message: data.error || data.message,
          },
          "Could not delete your account. Please try again.",
        ),
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(
          error,
          "Could not delete your account. Please try again.",
        ),
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
