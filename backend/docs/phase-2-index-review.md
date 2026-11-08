# Phase 2 MongoDB index decisions

These are Mongoose model declarations, not confirmation that indexes have
been built in any database. No database or production index inspection was
performed. Execution-plan claims are provisional because no safe non-production
MongoDB environment was configured.

Removing a Mongoose declaration does not itself drop a physical index that may
already exist in a database. No index deletion or migration was executed.
Inspect deployed indexes and use a separately reviewed, approved change if
physical cleanup is needed.

## Retained changed index

### `BusRoute` / `busroutes`

Declared index:

```js
{ bus_id: 1, plan_name: 1, stop_order: 1 }
```

The batched route read in `src/utils/busReadContext.js` filters with
`{ bus_id: { $in: routeBusIds } }` and sorts with
`{ plan_name: 1, stop_order: 1 }`. The `bus_id` prefix supports the filter.
Appending `plan_name` and `stop_order` may provide ordered scans for a single
bus or a small `$in` set. The previous `{ bus_id: 1, plan_name: 1 }` index
could not supply `stop_order`; this index replaces it rather than adding a
second copy. MongoDB's ability to satisfy the sort across multiple bus IDs has
not been measured, so this is provisional pending `explain("executionStats")`
on representative non-production data. It adds one key to every route index
entry and increases storage and route-write work.

## Restored or unchanged declarations

- `Bus` retains its existing `{ altered_to_bus_id: 1, alteration_type: 1 }`
  declaration. The incoming-change query in `busReadContext.js` filters with
  `$in` on both fields and sorts by `bus_no: 1`. The index supports the filter
  prefix but does not establish that the sort is covered; the prior
  `bus_no` extension was removed because no execution plan justified its
  additional storage and write cost.
- `StopMaster` retains its existing unique `{ stopId: 1 }`, single-field
  `status`, `{ name: 1, status: 1 }`, and `{ aliases: 1, status: 1 }`
  declarations. The ID lookup filters `stopId: { $in: stopIds }`; the unique
  index supports it. The legacy lookup combines `status` equality with
  case-insensitive anchored regexes over `name` and `aliases`. Regex selectivity
  and the `$or` plan have not been measured. No reversed-order `status/name`
  or `status/aliases` indexes are retained.
- `PlanMapping` retains its original `{ plan_name: 1, root_bus_id: 1 }` and
  `{ plan_name: 1, member_bus_ids: 1 }` declarations. The Phase 2
  `location_bus_id` and `cluster_name` indexes were removed because reviewed
  application queries did not use those fields as leading filters and the
  cluster-first order does not support the full list's
  `{ plan_name: 1, cluster_name: 1 }` sort.
- `BusLiveLocation` retains only the existing unique `{ bus_id: 1 }` index.
  Reviewed reads look up by `bus_id`; the Phase 2 `is_online/lastUpdated` and
  `lastSuccessfulGpsUpdate` indexes had no matching timestamp filters or
  sorts and would add write/storage overhead to GPS updates.
- The Phase 2 `{ bus_id: 1, plan_name: 1, stopId: 1 }` `BusRoute` index was
  removed. No reviewed route query filters by `stopId`; current stop-ID
  lookups are on `StopMaster`.
