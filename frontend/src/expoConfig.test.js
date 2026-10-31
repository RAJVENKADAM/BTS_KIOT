const assert = require("node:assert/strict");
const { test } = require("node:test");
const appConfig = require("../app.json");
const packageJson = require("../package.json");

test("Expo SDK 58 dependencies and app plugins are configured", () => {
  assert.match(packageJson.dependencies.expo, /^~58\./);
  assert.equal(packageJson.dependencies.react, "19.3.0");
  assert.equal(packageJson.dependencies["react-native"], "0.88.1");
  assert.equal(appConfig.expo.name, "BTMS");
  assert.ok(appConfig.expo.plugins.includes("expo-location"));
  assert.ok(appConfig.expo.plugins.includes("expo-secure-store"));
});
