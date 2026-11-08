"use strict";

const LOGIN_ATTEMPT_COLLECTION = "loginattemptbuckets";
const LOGIN_ATTEMPT_INDEX_NAME = "ttl_expires_at";
const LOGIN_ATTEMPT_INDEX_KEYS = { expiresAt: 1 };
const LOGIN_ATTEMPT_INDEX_OPTIONS = {
  name: LOGIN_ATTEMPT_INDEX_NAME,
  expireAfterSeconds: 0,
};

module.exports = {
  LOGIN_ATTEMPT_COLLECTION,
  LOGIN_ATTEMPT_INDEX_NAME,
  LOGIN_ATTEMPT_INDEX_KEYS,
  LOGIN_ATTEMPT_INDEX_OPTIONS,
};
