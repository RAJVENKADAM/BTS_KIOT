# Push Notification Implementation TODO

## Progress Tracker

- [x] 0. Scan and analyze project
- [x] 1. Frontend: Update `notificationService.js` (token generation, registration with bus_no, listeners)
- [x] 2. Frontend: Update `AuthContext.js` (post-login token registration)
- [x] 3. Frontend: Update `App.js` (remove premature token registration)
- [x] 4. Backend: Create migration `014_add_push_token_to_users.sql`
- [x] 5. Backend: Update `notificationService.js` (token storage, bus-based sending, retry, error handling)
- [x] 6. Backend: Update `bus.controller.js` (`savePushToken` endpoint, `registerDeviceToken` fix)
- [x] 7. Backend: Update `bus.routes.js` (add `/save-push-token` route)
- [x] 8. Backend: Fix `excelBusService.js` SQL bug in `changeBusPlan`
- [x] 9. Verify SDK 54 config (app.json, eas.json, package.json)
- [x] 10. Update `busApi.js` frontend to include `savePushToken`
- [x] 11. Final review and testing guide

