# BTS Fixes TODO (end-to-end production stabilization)

## Phase 1 — Frontend Excel import reliability
- [ ] Inspect and replace `frontend/src/utils/excelImport.js` Excel file reading implementation.
  - [x] Remove/avoid deprecated `expo-file-system` APIs (no `readAsStringAsync`, no deprecated methods).
- [ ] Implement production-safe reading for DocumentPicker assets in APK/AAB/EAS.

## Phase 1b — Production networking for live GPS/search
- [x] Fix socket.io websocket connection failures in production builds (API_BASE_URL + socket path).


- [x] Fix current broken fallback logic.

- [ ] Validate Excel parsing outputs match backend expectations.
- [ ] Run/verify Excel import locally using backend endpoints (user import + bus import) to confirm summaries.



## Phase 2 — Backend import endpoint correctness
- [ ] Inspect import routes to ensure JSON controllers match frontend payloads.
- [ ] Fix any controller/route mismatches (e.g., multipart `req.file.buffer` vs JSON body).
- [ ] Ensure import summaries include: insertedRows, updatedRows, unchangedRows, failedRows, duplicateRows.

## Phase 3 — Backend GPS/search pipeline
- [ ] Audit bus search endpoints + mapping logic.
- [ ] Fix identifier matching: preview_number, bus_no, bus_name, reg_no.
- [ ] Ensure live GPS location returned corresponds to searched bus.
- [ ] Verify GPS device mapping between bus/reg_no/device_id/provider deviceId.

## Phase 4 — MongoDB Atlas schema/index integrity
- [ ] Audit all related collections/schemas.
- [ ] Add/adjust indexes and unique constraints needed for imports & GPS mapping.

## Phase 5 — Deployment/Render compatibility
- [ ] Verify env vars, API_BASE_URL handling, socket networking.
- [ ] Verify Render startup and health endpoints.

## Phase 6 — Verification
- [ ] Run backend tests: `backend/test-imports.js`, atlas verify/cleanup.
- [ ] Run smoke checks: login, user import, bus import, bus search, GPS tracking.
