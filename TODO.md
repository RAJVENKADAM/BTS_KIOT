# TODO - BTS backend bus_id migration cleanup

- [ ] Scan backend/src for any remaining `bus_no` usage.
- [ ] Update `busStateService.js` to use `bus_id` exclusively (queries, joins, inserts/updates).
- [ ] Update `trackingService.js` to map deviceId and mobile/user assignments to `bus_id` and insert into `bus_live_locations(bus_id, ...)`.
- [ ] Update `gpsService.js` to ensure parameter passing uses `bus_id` internally (keep regNo/busNo only at API boundary).
- [ ] Update `track.controller.js` to convert incoming busNo/user.bus_no into bus_id via helper before any DB operations.
- [ ] Update `bus.controller.js` queries/joins/inserts to remove all `bus_no` usage in relational clauses.
- [ ] Add a helper function `getBusIdByBusNo(busNo)` if needed (centralize in controller/service).
- [ ] Run grep to ensure no `bus_no` remains in backend/src.
- [ ] Run clean build / start locally (backend) and fix any runtime SQL errors.
- [ ] Commit changes.
- [ ] Push to GitHub `master` or `main` (detect correct default branch).

