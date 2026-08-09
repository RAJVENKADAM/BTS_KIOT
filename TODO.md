# Error Handling Improvement Task

Fix every error handling in the app so that network problems, server errors,
auth errors, and not-found cases are clearly and specifically reported to the user.

## Steps

- [x] 1. Analyze the app's error handling across all API modules and screens
- [x] 2. Create `frontend/src/utils/errorHandler.js` (centralized error classification)
- [x] 3. Update `frontend/src/api/busApi.js` (response.ok checks + network-error typing)
- [x] 4. Update `frontend/src/api/excelManagementApi.js` (response.ok + network typing)
- [x] 5. Update `frontend/src/api/importApi.js` (response.ok + network typing)
- [x] 6. Update `frontend/src/context/BusContext.js` (distinguish error types)
- [x] 7. Update `frontend/src/context/AuthContext.js` (specific network message)
- [x] 8. Update `frontend/src/screens/HomeScreen.js` (show specific problem, not "Bus Not Found")
- [x] 9. Update `frontend/src/screens/Organize/AddUsersScreen.js` (specific alert messages)
- [x] 10. Update `frontend/src/screens/Organize/AddBusesScreen.js` (specific alert messages)
- [x] 11. Verify all changes and review
