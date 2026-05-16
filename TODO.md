# TODO - Expo SDK 55 -> 54 Migration

## Step 1: Inspect current frontend config
- [x] Read `frontend/package.json`
- [x] Scan for Expo SDK 55 references

## Step 2: Prepare safe dependency downgrade
- [ ] Update `frontend/package.json` to Expo SDK 54 compatible versions
- [ ] Align `react`, `react-dom`, `react-native`, `react-native-*` versions with Expo SDK 54 expectations
- [ ] Fix `react-native-maps` and `react-native-vector-icons/@expo/vector-icons` compatibility handling



## Step 3: Clean lockfiles and reinstall
- [ ] Delete `frontend/package-lock.json` and `frontend/node_modules`
- [ ] Run exact npm install commands

## Step 4: Apply Expo-managed install
- [ ] Run exact `expo install` commands

## Step 5: Cache cleanup + rebuild
- [ ] Clear Expo/Metro caches
- [ ] Run `expo doctor`
- [ ] Run Android build: `expo run:android`
- [ ] Verify Expo Go launch without native crashes

## Step 6: Verification checklist
- [ ] Confirm sockets, AsyncStorage, notifications, maps, animations still work
- [ ] Confirm Android build and Expo Go testing are stable

