"use strict";

const assert = require("node:assert/strict");
const proxyaddr = require("proxy-addr");
const { test } = require("node:test");
const { createProxyTrust } = require("../src/config/proxyTrust");

function resolveExpressClientIp(remoteAddress, forwardedFor, trustProxy) {
  const request = {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress },
    connection: { remoteAddress },
  };
  return proxyaddr(request, trustProxy);
}

test("direct connections ignore client-supplied X-Forwarded-For by default", () => {
  const trustProxy = createProxyTrust({});
  assert.equal(
    resolveExpressClientIp(
      "198.51.100.10",
      "203.0.113.99",
      trustProxy,
    ),
    "198.51.100.10",
  );
});

test("only configured immediate proxies are trusted to forward the client IP", () => {
  const trustProxy = createProxyTrust({
    TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
  });
  assert.equal(
    resolveExpressClientIp(
      "192.0.2.10",
      "203.0.113.27",
      trustProxy,
    ),
    "203.0.113.27",
  );
  assert.equal(
    resolveExpressClientIp(
      "198.51.100.10",
      "203.0.113.99",
      trustProxy,
    ),
    "198.51.100.10",
  );
  assert.equal(trustProxy("192.0.2.10", 0), true);
  assert.equal(trustProxy("198.51.100.10", 0), false);
});

test("untrusted hops later in a forwarded chain cannot replace the client address", () => {
  const trustProxy = createProxyTrust({
    TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
  });
  assert.equal(
    resolveExpressClientIp(
      "192.0.2.10",
      "203.0.113.27, 198.51.100.15",
      trustProxy,
    ),
    "198.51.100.15",
  );
});

test("invalid trusted-proxy ranges fail during configuration instead of broadening trust", () => {
  assert.throws(
    () => createProxyTrust({ TRUSTED_PROXY_CIDRS: "not-an-ip-range" }),
  );
});
