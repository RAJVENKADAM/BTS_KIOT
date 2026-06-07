# TODO.md

## Fix Real-time Bus Plan + Movement Status System

- [ ] Implement coordinate-based state machine in `frontend/src/screens/HomeScreen.js` (STOPPED at 10, WAITING at 3, MOVING on coordinate change; priority STOPPED > WAITING > MOVING)
- [ ] Enforce strict reset of coordinate tracking only on new bus search / preview number change
- [ ] Fix socket `bus-update` plan updates in `frontend/src/screens/HomeScreen.js`:
  - [ ] Accept key variants: `busNo`, `bus_no`, `busNumber`
  - [ ] Match against selected bus
  - [ ] Update `busData` immutably with `_updatedAt: Date.now()` and never overwrite other fields
  - [ ] Prevent stale closure using `selectedBusNoRef`
- [ ] Update bottom sheet Plan interaction so tapping shows route stops for that bus's current live plan

- [ ] Run frontend checks/build and validate real-time updates + status transitions

