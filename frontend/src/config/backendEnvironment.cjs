"use strict";

const PRODUCTION_API_BASE_URL = "https://bts-kiot.onrender.com";
const PRODUCTION_HOSTNAME = "bts-kiot.onrender.com";
const BACKEND_PORT = "5000";

function stripTrailingDots(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[|\]$/g, "");
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part, index) => !/^\d+$/.test(hostname.split(".")[index]) || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Backend URL must be a valid origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Backend URL must be an HTTP(S) origin without credentials or path.");
  }
  return url;
}

function resolveBackendEnvironment({
  environment,
  nodeEnvironment,
  platform = "unknown",
  apiBaseUrl,
  allowRemoteTests,
} = {}) {
  if (
    nodeEnvironment === "production" &&
    environment &&
    environment !== "production"
  ) {
    throw new Error("Production builds must select the production backend environment.");
  }
  const selectedEnvironment =
    environment || (nodeEnvironment === "production" ? "production" : "local");

  if (selectedEnvironment === "production") {
    if (apiBaseUrl && apiBaseUrl.replace(/\/+$/, "") !== PRODUCTION_API_BASE_URL) {
      throw new Error("Production builds must use the configured production API origin.");
    }
    return {
      environment: selectedEnvironment,
      apiBaseUrl: PRODUCTION_API_BASE_URL,
    };
  }

  if (selectedEnvironment === "remote-test") {
    if (allowRemoteTests !== "YES") {
      throw new Error("Remote Render tests require EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES.");
    }
    if (apiBaseUrl && apiBaseUrl.replace(/\/+$/, "") !== PRODUCTION_API_BASE_URL) {
      throw new Error("Remote tests must use the configured Render origin.");
    }
    return {
      environment: selectedEnvironment,
      apiBaseUrl: PRODUCTION_API_BASE_URL,
    };
  }

  if (selectedEnvironment !== "local") {
    throw new Error("EXPO_PUBLIC_BTMS_ENV must be local, production, or remote-test.");
  }

  if (!apiBaseUrl) {
    return {
      environment: "local",
      apiBaseUrl:
        platform === "android"
          ? `http://10.0.2.2:${BACKEND_PORT}`
          : `http://127.0.0.1:${BACKEND_PORT}`,
    };
  }

  const url = parseOrigin(apiBaseUrl);
  const hostname = stripTrailingDots(url.hostname);
  if (hostname === PRODUCTION_HOSTNAME) {
    throw new Error("Local configuration cannot target the production Render host.");
  }
  if (url.port !== BACKEND_PORT) {
    throw new Error("Local backend URLs must use port 5000.");
  }
  const ipv4Parts = hostname.split(".");
  const isIpv4 =
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
      (part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    );
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIpv4 && Number(ipv4Parts[0]) === 127);
  if (!loopback && !isPrivateIPv4(hostname)) {
    throw new Error("Local backend URLs must use loopback or a private LAN IPv4 address.");
  }

  return {
    environment: "local",
    apiBaseUrl: url.origin.replace(/\/+$/, ""),
  };
}

module.exports = {
  PRODUCTION_API_BASE_URL,
  resolveBackendEnvironment,
};
