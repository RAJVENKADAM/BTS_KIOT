# Task TODO - Excel Import Redesign

## Plan step list
1. Create React Native Excel import utility (`frontend/src/utils/excelImport.js`) to read xlsx locally (no FormData, no uploadAsync, no Blob).
2. Add new backend bulk import endpoints:
   - `POST /api/superadmin/import-users`
   - `POST /api/bus/import-routes`
3. Implement backend import logic with:
   - validation
   - upsert-based create/update (intelligent)
   - bulk insert/update using `insertMany()` and/or `bulkWrite()`
   - import summary: totalRows, insertedRows, updatedRows, unchangedRows, failedRows
4. Add/adjust Mongoose models/indexes as needed for uniqueness (users: email; buses: bus_no; routes: bus_no+plan_name+stop_order).
5. Refactor `AddUsersScreen.js` to use local Excel reading -> JSON -> `/import-users`.
6. Refactor `AddBusesScreen.js` to use local Excel reading -> JSON -> `/import-routes` (no FormData).
7. Verify front-end payload mapping to backend unique keys and handle import summary UI.

7. Remove/ignore old FormData-based upload paths in those screens.
8. Run backend/frontend lint/build checks and do a quick runtime sanity test.

