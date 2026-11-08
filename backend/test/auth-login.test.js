const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const {
  runLimitedPasswordCheck,
  runLimitedImportPasswordHash,
} = require('../src/utils/authProtection');
const limiter = require('../src/utils/loginAttemptLimiter');

process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters';

const users = new Map();
const accountAttempts = new Map();
let nextReservationId = 0;
const prune = (attempts, now = Date.now()) =>
  attempts.filter((attempt) => now - attempt.createdAt < 15 * 60 * 1000);
limiter.reserveLoginAttempt = async (email) => {
  const account = prune(accountAttempts.get(email) || []);
  if (account.length >= 10) {
    return { allowed: false, source: 'account', retryAfter: 60 };
  }
  const reservationId = `test-reservation-${++nextReservationId}`;
  const reservation = { reservationId, createdAt: Date.now(), state: 'pending' };
  accountAttempts.set(email, [...account, reservation]);
  return { allowed: true, reservationId, source: 'account' };
};
limiter.markLoginAttemptFailed = async (email, reservationId) => {
  accountAttempts.set(
    email,
    (accountAttempts.get(email) || []).map((attempt) =>
      attempt.reservationId === reservationId
        ? { ...attempt, state: 'failed' }
        : attempt,
    ),
  );
};
limiter.completeLoginAttempt = async (email, reservationId) => {
  accountAttempts.set(
    email,
    (accountAttempts.get(email) || []).filter(
      (attempt) =>
        attempt.state === 'pending' &&
        attempt.reservationId !== reservationId,
    ),
  );
};
limiter.releaseLoginAttempt = async (email, reservationId) => {
  accountAttempts.set(
    email,
    (accountAttempts.get(email) || []).filter(
      (attempt) => attempt.reservationId !== reservationId,
    ),
  );
};

const passwordHash = bcrypt.hash('correct-password', 12);
let activePasswordChecks = 0;
let maxActivePasswordChecks = 0;

User.findOne = ({ email }) => ({
  select: async () => users.get(email) || null,
});

test('50 valid accounts sharing one campus IP can log in concurrently', async () => {
  const emails = Array.from({ length: 50 }, (_, index) =>
    `campus-burst-${index}@example.edu`,
  );
  for (const email of emails) users.set(email, makeUser(email));

  const originalInfo = console.info;
  console.info = () => {};
  let responses;
  try {
    responses = await Promise.all(
      emails.map((email) =>
        attemptLogin(email, 'correct-password', { ip: '198.51.100.40' }),
      ),
    );
  } finally {
    console.info = originalInfo;
  }

  assert.ok(responses.every((response) => response.statusCode === 200));
  assert.ok([...accountAttempts.values()].every((attempts) =>
    attempts.every((attempt) => attempt.state !== 'pending'),
  ));
});

test('multiple devices can authenticate the same account concurrently', async () => {
  const email = 'multiple-devices-auth-test@example.edu';
  users.set(email, makeUser(email));
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      attemptLogin(email, 'correct-password', {
        ip: `198.51.100.${index + 1}`,
      }),
    ),
  );
  assert.ok(responses.every((response) => response.statusCode === 200));
});

const { login, getClientIp } = require('../src/controllers/auth.controller');

const responseDouble = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  set(name, value) {
    this.headers[name] = value;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    this.body = value;
    return this;
  },
});

const makeUser = (email, { delayMs = 0 } = {}) => ({
  _id: `id-${email}`,
  name: 'Test Student',
  email,
  role: 'student',
  bus_no: null,
  is_active: true,
  temp_password: false,
  deleted_by_user: false,
  async comparePassword(password) {
    activePasswordChecks += 1;
    maxActivePasswordChecks = Math.max(
      maxActivePasswordChecks,
      activePasswordChecks,
    );
    try {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return bcrypt.compare(password, await passwordHash);
    } finally {
      activePasswordChecks -= 1;
    }
  },
});

test('login source identity comes from Express req.ip, never a forwarded header', () => {
  assert.equal(getClientIp({
    ip: '198.51.100.27',
    headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.1' },
    socket: { remoteAddress: '192.0.2.10' },
  }), '198.51.100.27');
  assert.equal(getClientIp({
    headers: { 'x-forwarded-for': '203.0.113.99' },
    socket: { remoteAddress: '192.0.2.10' },
  }), null);
});

const attemptLogin = async (email, password, overrides = {}) => {
  const res = responseDouble();
  const ipOctet = Math.abs(
    [...email].reduce((sum, character) => sum + character.charCodeAt(0), 0),
  ) % 200 + 1;
  await login({
    body: { email, password },
    ip: `203.0.113.${ipOctet}`,
    ...overrides,
  }, res);
  return res;
};

test('successful login returns the established token and user shape', async () => {
  const email = 'success-auth-test@example.edu';
  users.set(email, makeUser(email));

  const response = await attemptLogin(email, 'correct-password');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.message, 'Login successful');
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.user.role, 'student');
  const payload = jwt.verify(response.body.token, process.env.JWT_SECRET);
  assert.equal(payload.id, `id-${email}`);
  assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
});

test('login timing diagnostics include stages without credentials or personal data', async () => {
  const email = 'timing-auth-test@example.edu';
  const password = 'correct-password';
  users.set(email, makeUser(email));
  const originalInfo = console.info;
  const logEntries = [];
  console.info = (...values) => logEntries.push(values.join(' '));

  let response;
  try {
    response = await attemptLogin(email, password);
  } finally {
    console.info = originalInfo;
  }

  const timingLog = logEntries.find((entry) => entry.startsWith('[login-timing] '));
  assert.ok(timingLog);
  const timing = JSON.parse(timingLog.slice('[login-timing] '.length));
  assert.equal(timing.outcome, 'success');
  assert.equal(typeof timing.totalMs, 'number');
  assert.equal(typeof timing.authQueueWaitMs, 'number');
  assert.equal(typeof timing.accountLookupMs, 'number');
  assert.equal(typeof timing.accountStateCheckMs, 'number');
  assert.equal(typeof timing.passwordQueueWaitMs, 'number');
  assert.equal(typeof timing.passwordVerificationMs, 'number');
  assert.equal(typeof timing.jwtSigningMs, 'number');
  assert.equal(typeof timing.busPreviewLookupMs, 'number');
  assert.equal(timing.busPreviewQueryCount, 0);

  const serializedLog = JSON.stringify(timing);
  assert.equal(serializedLog.includes(email), false);
  assert.equal(serializedLog.includes(password), false);
  assert.equal(serializedLog.includes(response.body.token), false);
});

test('missing credentials are rejected and nonexistent users receive the generic 401', async () => {
  const missing = await attemptLogin("", "");
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, "INVALID_CREDENTIALS");

  const nonexistent = await attemptLogin("not-registered@example.edu", "random-password");
  assert.equal(nonexistent.statusCode, 401);
  assert.equal(nonexistent.body.code, "INVALID_CREDENTIALS");
  assert.equal(nonexistent.body.error, "Invalid credentials");
});

test('login fails closed with a safe retryable response when shared limiter storage fails', async () => {
  const originalReserve = limiter.reserveLoginAttempt;
  const originalFindOne = User.findOne;
  let accountLookupCount = 0;
  limiter.reserveLoginAttempt = async () => {
    const error = new Error('private MongoDB transaction detail');
    error.status = 503;
    error.code = 'LOGIN_LIMITER_UNAVAILABLE';
    error.retryAfter = 2;
    throw error;
  };
  User.findOne = (...args) => {
    accountLookupCount += 1;
    return originalFindOne(...args);
  };

  let response;
  try {
    response = await attemptLogin(
      'limiter-failure-auth-test@example.edu',
      'correct-password',
    );
  } finally {
    limiter.reserveLoginAttempt = originalReserve;
    User.findOne = originalFindOne;
  }

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'LOGIN_LIMITER_UNAVAILABLE');
  assert.equal(response.headers['Retry-After'], '2');
  assert.equal(accountLookupCount, 0);
  assert.equal(
    JSON.stringify(response.body).includes('private MongoDB transaction detail'),
    false,
  );
});

test('incorrect credentials return 401 and repeated attempts are throttled per account', async () => {
  const email = 'failed-auth-test@example.edu';
  users.set(email, makeUser(email));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await attemptLogin(email, 'incorrect-password');
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'INVALID_CREDENTIALS');
  }

  const limited = await attemptLogin(email, 'incorrect-password');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, 'LOGIN_RATE_LIMITED');
  assert.ok(Number(limited.headers['Retry-After']) > 0);
});

test('concurrent attempts cannot exceed the password-check concurrency limit', async () => {
  const email = 'concurrent-auth-test@example.edu';
  users.set(email, makeUser(email, { delayMs: 10 }));
  maxActivePasswordChecks = 0;

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => attemptLogin(email, 'incorrect-password')),
  );

  assert.ok(responses.every((response) => response.statusCode === 401));
  assert.ok(maxActivePasswordChecks <= 4);
});

test('password-check saturation is bounded and returns a retryable 503', async () => {
  let releaseChecks;
  const gate = new Promise((resolve) => {
    releaseChecks = resolve;
  });
  const queuedChecks = Array.from({ length: 68 }, () =>
    runLimitedPasswordCheck(() => gate),
  );

  await assert.rejects(
    runLimitedPasswordCheck(() => gate),
    (error) => error.status === 503 && error.code === 'AUTH_BUSY',
  );

  releaseChecks();
  await Promise.all(queuedChecks);
});

test('import password hashes are bounded and capacity is released after failures', async () => {
  let releaseHashes;
  const gate = new Promise((resolve) => {
    releaseHashes = resolve;
  });
  let activeHashes = 0;
  let maximumActiveHashes = 0;
  const hashes = Array.from({ length: 6 }, (_, index) =>
    runLimitedImportPasswordHash(async () => {
      activeHashes += 1;
      maximumActiveHashes = Math.max(maximumActiveHashes, activeHashes);
      try {
        await gate;
        if (index === 0) throw new Error('simulated hash failure');
      } finally {
        activeHashes -= 1;
      }
    }),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActiveHashes, 4);
  releaseHashes();
  const results = await Promise.allSettled(hashes);

  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(activeHashes, 0);
  assert.ok(maximumActiveHashes <= 4);
});

test('import password hash queue is bounded and rejects only excess concurrent work', async () => {
  let releaseHashes;
  const gate = new Promise((resolve) => {
    releaseHashes = resolve;
  });
  const queuedHashes = Array.from({ length: 68 }, () =>
    runLimitedImportPasswordHash(() => gate),
  );

  await assert.rejects(
    runLimitedImportPasswordHash(() => gate),
    (error) => error.status === 503 && error.code === 'AUTH_BUSY',
  );

  releaseHashes();
  await Promise.all(queuedHashes);
  const retried = await runLimitedImportPasswordHash(async () => 'hashed');
  assert.equal(retried, 'hashed');
});
