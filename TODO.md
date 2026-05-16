# TODO - Expo SDK 55 Android APK fix

## Step 1: Audit & plan approval
- [x] Read `frontend/package.json`, `frontend/app.json`, `frontend/eas.json`
- [x] Identify likely SDK-sensitive native module pins
- [x] Confirm plan to align versions via `expo install`

## Step 2: Dependency graph alignment
- [ ] Update `frontend/package.json` (remove SDK-sensitive guess pins; rely on `expo install`)
- [ ] Delete `frontend/node_modules` + `frontend/package-lock.json`
- [ ] Run `npx expo install` inside `frontend/`

## Step 3: Clean build environment
- [ ] Ensure single dependency tree after install (no duplicates)

## Step 4: Android config validation
- [ ] Verify Android SDK/target/build tools via app config (already expected)

## Step 5: Produce APK via EAS
- [ ] Run: `eas build -p android --profile preview --clear-cache`

## Step 6: Verify build output
- [ ] Confirm APK artifact produced successfully

