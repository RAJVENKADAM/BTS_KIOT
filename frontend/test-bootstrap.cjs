"use strict";

process.env.NODE_ENV = "test";
process.env.EXPO_PUBLIC_BTMS_ENV = "local";
delete process.env.EXPO_PUBLIC_API_BASE_URL;
delete process.env.EXPO_PUBLIC_ALLOW_REMOTE_TESTS;
