# TODO BUILD PROGRESS

- [ ] Step 0: Repo scan + plan confirmation
- [ ] Step 1: Create busId helper (getBusIdByBusNo)
- [x] Step 1: Create busId helper (getBusIdByBusNo)
- [ ] Step 2: Update busStateService.js to use bus_id
- [x] Step 3: Update trackingService.js to use bus_id (DB inserts/updates and internal maps)


- [ ] Step 4: Update gpsService.js parameter passing
- [x] Step 5: Update track.controller.js to convert identifiers to bus_id before DB operations

- [ ] Step 5b: Update bus.controller.js queries to convert identifiers to bus_id before DB operations


- [ ] Step 6: Grep backend/src for remaining bus_no and fix all

- [ ] Step 7: npm clean build/start and resolve SQL runtime errors
- [ ] Step 8: Commit + push to GitHub (branch master/main)
