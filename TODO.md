# Task Implementation Progress

## Goal

Add refresh button (socket/DB-based, no API re-fetch), keep searched bus number in search bar, and stop map re-zooming on every update.

## Steps

- [x] 1. Backend: Add `request-bus-location` socket handler in `trackSocket.js` (reads latest location from DB and emits `locationUpdate` back to requester).
- [x] 2. Backend: Emit `locationUpdate` socket event to `bus_<busNo>` room after each DB update in `gpsSyncWorker.js`.
- [x] 3. Frontend: Add socket `locationUpdate` listener in `HomeScreen.js` to update bus marker from DB (no HTTP API call).
- [x] 4. Frontend: Add refresh button in top bar (after search bar, before Organize/Profile based on role) that emits `request-bus-location`.
- [x] 5. Frontend: Remove `setSearchQuery("")` from `handleSearch` so the searched number stays in the bar.
- [x] 6. Frontend: Change `focusMap` in `OSMMap.js` to use `map.panTo` (preserve zoom) instead of `setView`.
