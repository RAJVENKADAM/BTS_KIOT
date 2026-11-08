"use strict";

const proxyaddr = require("proxy-addr");

function createProxyTrust(env = process.env) {
  const trustedRanges = String(env.TRUSTED_PROXY_CIDRS || "")
    .split(",")
    .map((range) => range.trim())
    .filter(Boolean);

  if (trustedRanges.length === 0) return () => false;

  const isTrusted = proxyaddr.compile(trustedRanges);
  return (address, hop) => hop === 0 && isTrusted(address);
}

module.exports = { createProxyTrust };
