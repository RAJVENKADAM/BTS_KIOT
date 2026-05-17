- [ ] Inspect push notification related code paths (frontend + backend) (already done)
- [ ] Create edit plan and confirm with user (already done)
- [x] Delete frontend/src/services/notificationService.js

- [x] Update frontend/src/context/AuthContext.js to remove push registration after login

- [x] Update backend/src/services/notificationService.js to only emit socket.io bus-update events (no Expo / push token logic)

- [x] Update backend/src/controllers/bus.controller.js to remove push-token endpoints from exports/handlers

- [x] Update backend/src/routes/bus.routes.js to remove /save-push-token and /register-device-token routes

- [x] Verify there are no remaining imports/references to removed push code

- [x] Run backend start / frontend build (as available)

