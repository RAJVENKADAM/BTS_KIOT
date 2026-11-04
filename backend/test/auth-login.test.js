const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const {
  runLimitedPasswordCheck,
  runLimitedImportPasswordHash,
} = require('../src/utils/authProtection');

process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters';

const users = new Map();
const passwordHash = bcrypt.hash('correct-password', 12);
let activePasswordChecks = 0;
let maxActivePasswordChecks = 0;

User.findOne = ({ email }) => ({
  select: async () => users.get(email) || null,
});

const { login } = require('../src/controllers/auth.controller');

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

const attemptLogin = async (email, password) => {
  const res = responseDouble();
  await login({ body: { email, password } }, res);
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

test('missing credentials are rejected and nonexistent users receive the generic 401', async () => {
  const missing = await attemptLogin("", "");
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, "INVALID_CREDENTIALS");

  const nonexistent = await attemptLogin("not-registered@example.edu", "random-password");
  assert.equal(nonexistent.statusCode, 401);
  assert.equal(nonexistent.body.code, "INVALID_CREDENTIALS");
  assert.equal(nonexistent.body.error, "Invalid credentials");
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
