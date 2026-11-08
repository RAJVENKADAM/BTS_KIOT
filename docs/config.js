(() => {
  "use strict";

  const productionApiBaseUrl = "https://bts-kiot.onrender.com";
  const hostname = String(window.location.hostname || "")
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[|\]$/g, "");
  const ipv4 = hostname.split(".").map(Number);
  const validIpv4 =
    ipv4.length === 4 &&
    ipv4.every(
      (part, index) =>
        /^\d+$/.test(hostname.split(".")[index]) && part >= 0 && part <= 255,
    );
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (validIpv4 && ipv4[0] === 127);
  const isPrivateIpv4 =
    validIpv4 &&
    (ipv4[0] === 10 ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168));
  const localHost = isLoopback || isPrivateIpv4;
  const query = new URLSearchParams(window.location.search);
  const environment =
    window.BTMS_ENVIRONMENT ||
    query.get("btmsEnvironment") ||
    (localHost || window.location.protocol === "file:" ? "local" : "production");

  let apiBaseUrl;
  if (environment === "local") {
    if (!localHost) {
      throw new Error("The local dashboard must be opened from loopback or a private LAN address.");
    }
    const urlHost = hostname.includes(":") ? `[${hostname}]` : hostname;
    apiBaseUrl = `http://${urlHost}:5000`;
  } else if (environment === "remote-test") {
    if (
      query.get("allowRemoteTests") !== "YES" &&
      window.BTMS_ALLOW_REMOTE_TESTS !== "YES"
    ) {
      throw new Error("Remote Render tests require an explicit allowRemoteTests=YES opt-in.");
    }
    apiBaseUrl = productionApiBaseUrl;
  } else if (environment === "production") {
    apiBaseUrl = productionApiBaseUrl;
  } else {
    throw new Error("BTMS_ENVIRONMENT must be local, production, or remote-test.");
  }

  window.BTMS_CONFIG = Object.freeze({
    ENVIRONMENT: environment,
    API_BASE_URL: apiBaseUrl,
    SOCKET_BASE_URL: apiBaseUrl,
  });
})();
