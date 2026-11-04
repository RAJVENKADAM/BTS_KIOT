const TOKEN_KEY = "btms_token";
const LEGACY_TOKEN_KEY = "token";
const USER_KEY = "user";

const secureStorageError = () =>
  new Error("Secure sign-in storage is unavailable. Please try again.");

async function readToken({
  secureStore,
  asyncStorage,
  allowInsecureFallback = false,
}) {
  let token;
  let secureStoreUnavailable = false;
  try {
    token = await secureStore.getItemAsync(TOKEN_KEY);
  } catch {
    if (!allowInsecureFallback) throw secureStorageError();
    secureStoreUnavailable = true;
  }
  if (token) {
    try {
      await asyncStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      throw secureStorageError();
    }
    return token;
  }

  const legacyToken = await asyncStorage.getItem(LEGACY_TOKEN_KEY);
  if (!legacyToken) return null;
  if (secureStoreUnavailable && allowInsecureFallback) return legacyToken;

  try {
    await secureStore.setItemAsync(TOKEN_KEY, legacyToken, {
      keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await asyncStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    if (allowInsecureFallback) return legacyToken;
    let migratedToken = null;
    try {
      migratedToken = await secureStore.getItemAsync(TOKEN_KEY);
    } catch {}
    if (migratedToken === legacyToken) {
      try {
        await asyncStorage.removeItem(LEGACY_TOKEN_KEY);
        return migratedToken;
      } catch {
        throw secureStorageError();
      }
    }
    try {
      await asyncStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {}
    throw secureStorageError();
  }
  return legacyToken;
}

async function persistAuth({
  secureStore,
  asyncStorage,
  token,
  user,
  allowInsecureFallback = false,
}) {
  try {
    await secureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    if (allowInsecureFallback) {
      try {
        await asyncStorage.setItem(LEGACY_TOKEN_KEY, token);
        await asyncStorage.setItem(USER_KEY, JSON.stringify(user));
        return;
      } catch {
        await asyncStorage.multiRemove([LEGACY_TOKEN_KEY, USER_KEY]);
        throw new Error("Unable to persist authentication data. Please try again.");
      }
    }
    try {
      await secureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      throw secureStorageError();
    }
    throw secureStorageError();
  }
  try {
    await asyncStorage.setItem(USER_KEY, JSON.stringify(user));
    await asyncStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    try {
      await secureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      throw secureStorageError();
    }
    throw secureStorageError();
  }
}

async function clearAuthStorage({ secureStore, asyncStorage }) {
  const results = await Promise.allSettled([
    secureStore.deleteItemAsync(TOKEN_KEY),
    asyncStorage.multiRemove([LEGACY_TOKEN_KEY, USER_KEY]),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Unable to clear all stored authentication data");
  }
}

module.exports = { readToken, persistAuth, clearAuthStorage };
