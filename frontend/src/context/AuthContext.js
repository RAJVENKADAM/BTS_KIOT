/**
 * AuthContext — Global authentication state management.
 * Provides login, logout, secure token persistence,
 * and exposes user, token, loading, isAuthenticated to the app tree.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
} from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "../api/api";
import { fetchJson, getErrorMessage } from "../utils/errorHandler";
const { shouldClearAuthSession } = require("../auth/sessionPolicy.cjs");
const authStorage = require("../auth/authStorage.cjs");
const { restoreCachedSession } = require("../auth/sessionRestore.cjs");
const { createStorageMutationQueue } = require("../auth/storageMutationQueue.cjs");

const fetchWithTimeout = (url, options, timeoutMs) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((error) => {
      if (!timedOut) throw error;
      const timeoutError = new Error("Request timed out");
      timeoutError.isNetwork = true;
      timeoutError.isTimeout = true;
      throw timeoutError;
    })
    .finally(() => clearTimeout(timeoutId));
};

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
  const storageMutationQueueRef = useRef(null);
  if (!storageMutationQueueRef.current) {
    storageMutationQueueRef.current = createStorageMutationQueue();
  }

  const readToken = () =>
    authStorage.readToken({
      secureStore: SecureStore,
      asyncStorage: AsyncStorage,
      allowInsecureFallback: Platform.OS === "web",
    });

  const persistAuth = (value, userData) =>
    storageMutationQueueRef.current(async () => {
      await authStorage.persistAuth({
        secureStore: SecureStore,
        asyncStorage: AsyncStorage,
        token: value,
        user: userData,
        allowInsecureFallback: Platform.OS === "web",
      });
    });

  const persistUserData = (userData) =>
    storageMutationQueueRef.current(() =>
      AsyncStorage.setItem("user", JSON.stringify(userData)),
    );

  const clearAuthStorage = () =>
    storageMutationQueueRef.current(() =>
      authStorage.clearAuthStorage({
        secureStore: SecureStore,
        asyncStorage: AsyncStorage,
      }),
    );

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

    let verificationInFlight = false;
    const verifySession = async () => {
      if (verificationInFlight) return;
      verificationInFlight = true;
      const generation = sessionGenerationRef.current;
      try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
        }, 10000);

        const data = await response.json().catch(() => ({}));
        if (
          data?.valid === true &&
          typeof data.user?.role === "string" &&
          generation === sessionGenerationRef.current
        ) {
          setUser((currentUser) =>
            currentUser ? { ...currentUser, role: data.user.role } : currentUser,
          );
        }
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
      const session = await restoreCachedSession({
        token: storedToken,
        storedUser,
        verify: async (value) => {
          const response = await fetchWithTimeout(
            `${API_BASE_URL}/api/auth/verify`,
            { headers: { Authorization: `Bearer ${value}` } },
            10000,
          );
          return {
            status: response.status,
            data: await response.json().catch(() => ({})),
          };
        },
        clear: clearAuthStorage,
        shouldClear: shouldClearAuthSession,
      });
      if (session) {
        setToken(session.token);
        setUser(session.user);
      }
    } catch (error) {
      console.warn("Unable to restore authentication session:", error?.message);
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
          timeoutMs: 60000,
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
          void fetchWithTimeout(
            `${API_BASE_URL}/api/auth/logout`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            },
            10000,
          ).catch((apiError) =>
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
      throw error;
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
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/auth/account`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        15000,
      );

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
