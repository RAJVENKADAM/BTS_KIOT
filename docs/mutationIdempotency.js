(() => {
  "use strict";

  function createIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function createKeyStore() {
    const keys = new Map();
    return {
      get(requestBody) {
        let key = keys.get(requestBody);
        if (!key) {
          key = createIdempotencyKey();
          keys.set(requestBody, key);
        }
        return key;
      },
      complete(requestBody) {
        keys.delete(requestBody);
      },
    };
  }

  function setHeader(headers, idempotencyKey) {
    if (typeof idempotencyKey === "string" && idempotencyKey) {
      headers.set("Idempotency-Key", idempotencyKey);
    }
  }

  globalThis.BTMS_IDEMPOTENCY = Object.freeze({
    createKeyStore,
    setHeader,
  });
})();
