# TODO — Bus Creation & Plan Management Improvements

## Steps
- [x] 1. Fix white text on bus create modal inputs (AddBusesScreen)
- [x] 2. Backend: allow bus creation with 0 routes + replaceRoutes flag (importBusRoutes.controller.js)
- [x] 3. Backend: add getBusRoutes + updateBusDetails controllers, currentPlan in location responses, socket emit on plan change (bus.controller.js)
- [x] 4. Backend: add socket join-bus/leave-bus handlers (socket/trackSocket.js) + register in app.js
- [x] 5. Backend: register new routes (bus.routes.js)
- [x] 6. Frontend: add busApi functions (getBusRoutes, updatePlan, updateBusDetails)
- [x] 7. Frontend: rewrite AddBusesScreen — Excel column-based plans, editable options (details/routes/plan)
- [x] 8. Frontend: HomeScreen bottom sheet — current plan chip + stops modal + admin plan switcher
- [x] 9. Verify syntax (node -c backend, no lint errors)
- [x] 10. Show plan/stops even when bus is offline or has no valid GPS coordinates — plan card with "The bus's last plan is X" + offline notice (HomeScreen + backend trackByPreview always returns 200 for found buses)