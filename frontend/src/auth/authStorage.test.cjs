const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  clearAuthStorage,
  persistAuth,
  readToken,
} = require("./authStorage.cjs");
const { createStorageMutationQueue } = require("./storageMutationQueue.cjs");

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
    async multiRemove(keys) {
      keys.forEach((key) => values.delete(key));
    },
  };
}

function makeSecureStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
    async getItemAsync(key) {
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      values.set(key, value);
    },
    async deleteItemAsync(key) {
      values.delete(key);
    },
  };
}

test("login token is stored in SecureStore and logout removes all session data", async () => {
  const secureStore = makeSecureStore();
  const asyncStorage = makeStorage();
  const user = { id: "student-1", role: "student" };

  await persistAuth({
    secureStore,
    asyncStorage,
    token: "test-token",
    user,
  });

  assert.equal(secureStore.values.get("btms_token"), "test-token");
  assert.equal(asyncStorage.values.get("token"), undefined);
  assert.deepEqual(JSON.parse(asyncStorage.values.get("user")), user);

  await clearAuthStorage({ secureStore, asyncStorage });
  assert.equal(secureStore.values.has("btms_token"), false);
  assert.equal(asyncStorage.values.has("token"), false);
  assert.equal(asyncStorage.values.has("user"), false);
});

test("SecureStore failure returns a recoverable error without plaintext fallback", async () => {
  const secureStore = makeSecureStore();
  secureStore.setItemAsync = async () => {
    throw new Error("device keychain unavailable");
  };
  const asyncStorage = makeStorage();

  await assert.rejects(
    persistAuth({
      secureStore,
      asyncStorage,
      token: "test-token",
      user: { id: "student-1" },
    }),
    /Secure sign-in storage is unavailable/,
  );
  assert.equal(asyncStorage.values.has("token"), false);
  assert.equal(asyncStorage.values.has("user"), false);
});

test("legacy token migrates to SecureStore before the plaintext copy is removed", async () => {
  const secureStore = makeSecureStore();
  const asyncStorage = makeStorage({ token: "legacy-token" });

  const token = await readToken({ secureStore, asyncStorage });

  assert.equal(token, "legacy-token");
  assert.equal(secureStore.values.get("btms_token"), "legacy-token");
  assert.equal(asyncStorage.values.has("token"), false);
});

test("existing SecureStore token retries legacy-token cleanup before returning", async () => {
  const secureStore = makeSecureStore({ btms_token: "secure-token" });
  const asyncStorage = makeStorage({ token: "legacy-token" });
  const removeItem = asyncStorage.removeItem.bind(asyncStorage);
  let removalAttempts = 0;
  asyncStorage.removeItem = async (key) => {
    removalAttempts += 1;
    if (removalAttempts === 1) throw new Error("temporary storage failure");
    await removeItem(key);
  };

  await assert.rejects(
    readToken({ secureStore, asyncStorage }),
    /Secure sign-in storage is unavailable/,
  );
  assert.equal(secureStore.values.get("btms_token"), "secure-token");
  assert.equal(asyncStorage.values.get("token"), "legacy-token");

  assert.equal(await readToken({ secureStore, asyncStorage }), "secure-token");
  assert.equal(asyncStorage.values.has("token"), false);
  assert.equal(removalAttempts, 2);
});

test("migration retries a failed plaintext cleanup and retains the secure token", async () => {
  const secureStore = makeSecureStore();
  const asyncStorage = makeStorage({ token: "legacy-token" });
  const removeItem = asyncStorage.removeItem.bind(asyncStorage);
  let removalAttempts = 0;
  asyncStorage.removeItem = async (key) => {
    removalAttempts += 1;
    if (removalAttempts === 1) throw new Error("temporary storage failure");
    await removeItem(key);
  };

  assert.equal(await readToken({ secureStore, asyncStorage }), "legacy-token");
  assert.equal(secureStore.values.get("btms_token"), "legacy-token");
  assert.equal(asyncStorage.values.has("token"), false);
  assert.equal(removalAttempts, 2);
});

test("persistent migration cleanup failure is recoverable and a later read completes cleanup", async () => {
  const secureStore = makeSecureStore();
  const asyncStorage = makeStorage({ token: "legacy-token" });
  const removeItem = asyncStorage.removeItem.bind(asyncStorage);
  let failRemoval = true;
  asyncStorage.removeItem = async (key) => {
    if (failRemoval) throw new Error("storage unavailable");
    await removeItem(key);
  };

  await assert.rejects(
    readToken({ secureStore, asyncStorage }),
    /Secure sign-in storage is unavailable/,
  );
  assert.equal(secureStore.values.get("btms_token"), "legacy-token");
  assert.equal(asyncStorage.values.get("token"), "legacy-token");

  failRemoval = false;
  assert.equal(await readToken({ secureStore, asyncStorage }), "legacy-token");
  assert.equal(asyncStorage.values.has("token"), false);
});

test("native migration fails closed and removes plaintext when SecureStore write fails", async () => {
  const secureStore = makeSecureStore();
  secureStore.setItemAsync = async () => {
    throw new Error("keychain unavailable");
  };
  const asyncStorage = makeStorage({ token: "legacy-token" });

  await assert.rejects(
    readToken({ secureStore, asyncStorage }),
    /Secure sign-in storage is unavailable/,
  );
  assert.equal(asyncStorage.values.has("token"), false);
});

test("native migration failure never returns the plaintext legacy token", async () => {
  const secureStore = makeSecureStore();
  secureStore.setItemAsync = async () => {
    throw new Error("keychain unavailable");
  };
  const asyncStorage = makeStorage({ token: "legacy-token" });

  await assert.rejects(readToken({ secureStore, asyncStorage }));
  assert.equal(asyncStorage.values.has("token"), false);
  assert.equal(await readToken({ secureStore, asyncStorage }), null);
});

test("SecureStore read failure does not fall back to plaintext token storage", async () => {
  const secureStore = makeSecureStore();
  secureStore.getItemAsync = async () => {
    throw new Error("device keychain unavailable");
  };
  const asyncStorage = makeStorage({ token: "legacy-token" });

  await assert.rejects(
    readToken({ secureStore, asyncStorage }),
    /Secure sign-in storage is unavailable/,
  );
});

test("web compatibility fallback is limited to callers that explicitly allow it", async () => {
  const secureStore = makeSecureStore();
  secureStore.getItemAsync = async () => {
    throw new Error("SecureStore unsupported");
  };
  secureStore.setItemAsync = async () => {
    throw new Error("SecureStore unsupported");
  };
  const asyncStorage = makeStorage();

  await persistAuth({
    secureStore,
    asyncStorage,
    token: "browser-token",
    user: { id: "student-1" },
    allowInsecureFallback: true,
  });
  assert.equal(asyncStorage.values.get("token"), "browser-token");
  assert.equal(await readToken({
    secureStore,
    asyncStorage,
    allowInsecureFallback: true,
  }), "browser-token");
});

test("serialized login persistence and logout clearing leave no overwritten credentials", async () => {
  const secureStore = makeSecureStore();
  const asyncStorage = makeStorage();
  const mutate = createStorageMutationQueue();
  let releaseWrite;
  const blockedWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const persist = mutate(async () => {
    await blockedWrite;
    await persistAuth({
      secureStore,
      asyncStorage,
      token: "login-token",
      user: { id: "student-1" },
    });
  });
  const clear = mutate(() => clearAuthStorage({ secureStore, asyncStorage }));

  releaseWrite();
  await Promise.all([persist, clear]);
  assert.equal(secureStore.values.has("btms_token"), false);
  assert.equal(asyncStorage.values.has("user"), false);
});
