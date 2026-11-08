"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  MAX_REQUEST_TIMEOUT_MS,
  validateCapacityLimits,
  validatePositiveSafeInteger,
  validateTarget: validateCapacityTarget,
} = require("./capacity-test-core.cjs");

const ACCOUNT_COUNT = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const ACCOUNT_FILE = path.join(
  __dirname,
  "student-login-capacity-accounts.json",
);

function validateTarget(env = process.env) {
  const configuredUrl =
    env.BTMS_LOGIN_CAPACITY_BASE_URL || "http://127.0.0.1:5000";
  return validateCapacityTarget(configuredUrl, env);
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length !== ACCOUNT_COUNT) {
    throw new Error(
      `The local account file must contain exactly ${ACCOUNT_COUNT} accounts.`,
    );
  }

  const emails = new Set();
  for (const account of accounts) {
    if (
      typeof account?.email !== "string" ||
      typeof account?.password !== "string" ||
      !account.email.trim() ||
      !account.password
    ) {
      throw new Error("Each local account must have an email and password.");
    }

    const email = account.email.trim().toLowerCase();
    if (emails.has(email)) {
      throw new Error("Local account emails must be unique.");
    }
    emails.add(email);
  }
  return accounts;
}

function readAccounts(filePath = ACCOUNT_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(
      "Could not read the local login-capacity account file. See load-tests/README.md.",
    );
  }
  return validateAccounts(parsed?.accounts);
}

function percentile(sortedSamples, quantile) {
  return sortedSamples[Math.max(0, Math.ceil(quantile * sortedSamples.length) - 1)];
}

async function runLoginCapacityTest({
  baseUrl,
  accounts,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  validateAccounts(accounts);
  const target = validateCapacityTarget(baseUrl);
  validatePositiveSafeInteger(
    timeoutMs,
    "Request timeout",
    MAX_REQUEST_TIMEOUT_MS,
  );
  validateCapacityLimits({
    clients: ACCOUNT_COUNT,
    rampMs: 0,
    holdMs: 0,
    requestTimeoutMs: timeoutMs,
    reconnectionAttempts: 0,
    totalDurationMs: timeoutMs,
  });
  const metrics = {
    successes: 0,
    failures: 0,
    httpStatuses: new Map(),
    failureCategories: new Map(),
    failuresByClient: [],
    durationsMs: [],
    firstRequestStartedAt: null,
    lastRequestStartedAt: null,
  };
  const testStartedAt = performance.now();
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });

  const requests = accounts.map(async (account, index) => {
    const client = `Account ${String(index + 1).padStart(2, "0")}`;
    await startGate;
    const startedAt = performance.now();
    if (metrics.firstRequestStartedAt === null) {
      metrics.firstRequestStartedAt = startedAt;
    }
    metrics.lastRequestStartedAt = startedAt;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let status = null;
    let failureCategory = null;
    let responseData = null;

    try {
      const response = await fetchImpl(`${target}/api/auth/login`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: account.email.trim(),
          password: account.password,
        }),
        signal: controller.signal,
      });
      status = response.status;
      metrics.httpStatuses.set(
        String(status),
        (metrics.httpStatuses.get(String(status)) || 0) + 1,
      );

      if (status === 401) failureCategory = "HTTP 401";
      else if (status === 403) failureCategory = "HTTP 403";
      else if (status === 429) failureCategory = "HTTP 429";
      else if (status >= 500) failureCategory = "HTTP 5xx";
      else if (!response.ok) failureCategory = `HTTP ${status}`;
      else {
        try {
          responseData = await response.json();
        } catch {
          failureCategory = "invalid login response";
        }

        if (
          !failureCategory &&
          (typeof responseData?.token !== "string" ||
            responseData?.user?.role !== "student" ||
            responseData?.user?.is_active !== true)
        ) {
          failureCategory = "account not confirmed as active student";
        }
      }
    } catch (error) {
      failureCategory =
        controller.signal.aborted || error?.name === "AbortError"
          ? "timeout"
          : "network error";
    } finally {
      clearTimeout(timeout);
      responseData = null;
    }

    const durationMs = performance.now() - startedAt;
    metrics.durationsMs.push(durationMs);
    if (failureCategory) {
      metrics.failures += 1;
      metrics.failureCategories.set(
        failureCategory,
        (metrics.failureCategories.get(failureCategory) || 0) + 1,
      );
      metrics.failuresByClient.push({ client, status, failureCategory });
    } else {
      metrics.successes += 1;
    }
  });

  releaseStart();
  await Promise.all(requests);
  metrics.requestStartSpreadMs =
    metrics.lastRequestStartedAt - metrics.firstRequestStartedAt;
  delete metrics.firstRequestStartedAt;
  delete metrics.lastRequestStartedAt;
  metrics.totalDurationMs = performance.now() - testStartedAt;
  return metrics;
}

function printCounts(title, counts) {
  console.log(`\n${title}`);
  if (!counts.size) {
    console.log("  None");
    return;
  }
  for (const [label, count] of [...counts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  ${label}: ${count}`);
  }
}

function printSummary(metrics) {
  const sorted = [...metrics.durationsMs].sort((a, b) => a - b);
  const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  console.log("\n=== BTMS student login capacity summary ===");
  console.log(`Successful active-student logins: ${metrics.successes}/${ACCOUNT_COUNT}`);
  console.log(`Failed logins: ${metrics.failures}`);
  console.log(`Total test duration: ${(metrics.totalDurationMs / 1000).toFixed(2)} seconds`);
  console.log(`Concurrent request start spread: ${metrics.requestStartSpreadMs.toFixed(2)} ms`);

  if (sorted.length) {
    console.log(
      `Login latency (ms): avg=${average.toFixed(1)}, p50=${percentile(sorted, 0.50).toFixed(1)}, p95=${percentile(sorted, 0.95).toFixed(1)}, p99=${percentile(sorted, 0.99).toFixed(1)}, min=${sorted[0].toFixed(1)}, max=${sorted.at(-1).toFixed(1)}`,
    );
  }

  printCounts("HTTP status codes", metrics.httpStatuses);
  printCounts("Failure categories", metrics.failureCategories);
  console.log("\nFailed requests (non-identifying account labels)");
  if (!metrics.failuresByClient.length) {
    console.log("  None");
  } else {
    for (const failure of metrics.failuresByClient) {
      const status = failure.status === null ? "" : `, HTTP ${failure.status}`;
      console.log(`  ${failure.client}: ${failure.failureCategory}${status}`);
    }
  }
}

async function main() {
  const baseUrl = validateTarget();
  const accounts = readAccounts();

  console.log(`Target: ${baseUrl}`);
  console.log(`Launching ${ACCOUNT_COUNT} login requests together (one per unique account).`);
  const metrics = await runLoginCapacityTest({ baseUrl, accounts });
  printSummary(metrics);
  return metrics.failures === 0 ? 0 : 1;
}

const invokedEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isDirectScriptEntry =
  require.main === module && invokedEntry && invokedEntry === __filename;

if (isDirectScriptEntry) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Login capacity test not started: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  ACCOUNT_COUNT,
  readAccounts,
  runLoginCapacityTest,
  validateAccounts,
  validateTarget,
};
