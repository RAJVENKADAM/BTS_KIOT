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

  function createRequestKeyStore() {
    const keys = new Map();
    const objectIds = new WeakMap();
    let nextObjectId = 0;

    function objectId(value) {
      let id = objectIds.get(value);
      if (!id) {
        id = ++nextObjectId;
        objectIds.set(value, id);
      }
      return id;
    }

    function bodySignature(body) {
      if (typeof body === "string") return body;
      if (
        typeof URLSearchParams !== "undefined" &&
        body instanceof URLSearchParams
      ) {
        return body.toString();
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        return JSON.stringify(
          [...body.entries()].map(([name, value]) =>
            typeof value === "string"
              ? [name, value]
              : [
                  name,
                  objectId(value),
                  value.name || "",
                  value.size ?? null,
                  value.type || "",
                  value.lastModified ?? null,
                ],
          ),
        );
      }
      return body == null ? "" : `${typeof body}:${String(body)}`;
    }

    return {
      prepare(headers, method, url, body, explicitKey) {
        const verb = String(method || "GET").toUpperCase();
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(verb)) {
          setHeader(headers, explicitKey);
          return null;
        }
        if (explicitKey) {
          setHeader(headers, explicitKey);
          return null;
        }

        const signature = JSON.stringify([verb, url, bodySignature(body)]);
        let key = keys.get(signature);
        if (!key) {
          key = createIdempotencyKey();
          keys.set(signature, key);
        }
        setHeader(headers, key);
        return signature;
      },
      complete(signature) {
        if (signature) keys.delete(signature);
      },
    };
  }

  globalThis.BTMS_IDEMPOTENCY = Object.freeze({
    createKeyStore,
    createRequestKeyStore,
    setHeader,
  });
})();
