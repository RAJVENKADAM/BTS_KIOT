# KIOT BTS Controlled Manual Test Checklist

**Purpose:** controlled, synthetic-account-first verification before any real-user pilot.
**Status:** preparation only. No manual or real-device tests have been run as part of this checklist.
**Release gate:** do not use production accounts or start student testing until the release verdict is at least `READY FOR CONTROLLED MANUAL USER TESTING`.

## Controlled first pilot scope

- Start with **2–3 authorized administrators** and **10–20 opted-in student accounts** in the approved pilot environment.
- Rehearse with synthetic accounts and buses first. Record consent and the approved pilot roster outside this checklist without placing personal data here.
- Expand only after the pilot owner reviews the evidence and all critical cases pass. This staged manual test is not a capacity/load test or production-readiness certification.
- Do not activate, spoof, or claim operation of the known inactive KIOT GPS device. Verify unavailable/stale states honestly.
- Automated unit/regression and isolated replica-set results are tracked in the final release report. They do **not** count as manual testing or production deployment.

## Test session record

| Field | Value |
|---|---|
| Build/version/commit | |
| Environment (isolated staging only) | |
| Backend instance count/configuration | |
| Tester(s) and role(s) | |
| Date/time and timezone | |
| Synthetic test account IDs | |
| Synthetic bus identifiers | |
| Device model / OS / app build | |
| Evidence location (no secrets or personal data) | |

For each case, fill the **Actual result**, **Pass/fail**, and **Evidence** fields. Use only synthetic accounts and staging data until a separate, approved KIOT-user pilot plan exists. Never record passwords, tokens, GPS-provider credentials, or real student personal information.

## Student workflows

### S-01 — Login and initial dashboard

**Preconditions:** active synthetic student; assigned bus; valid staging backend; app installed.

**Steps:** 1. Sign in. 2. Open the dashboard. 3. Record the displayed assignment and GPS status. 4. Navigate away and return. 5. Sign out and sign in again.

**Expected:** authenticated session; only the student's current assignment appears; GPS availability is honest; no technical error or unrelated fleet data appears.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-02 — Assigned-bus map and current location

**Preconditions:** S-01 passed; assigned bus has a known test location or is explicitly configured as unavailable.

**Steps:** 1. Open tracking. 2. Compare bus identity and location status to the staging fixture. 3. Wait for a live event or safe snapshot refresh. 4. Return to dashboard.

**Expected:** only assigned bus data is shown; snapshot/live versions do not move backwards; no previous-bus location is presented as current.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-03 — App background and foreground

**Preconditions:** S-02 passed; app is tracking the assigned bus.

**Steps:** 1. Background the app for at least 30 seconds. 2. Change only synthetic staging GPS state if available. 3. Foreground the app. 4. Observe socket reconnection and snapshot reconciliation.

**Expected:** authorization is revalidated; latest authoritative assignment/location is reconciled; no duplicate listeners or stale location is shown.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-04 — Internet disconnection and recovery

**Preconditions:** synthetic student logged in; assigned-bus screen open.

**Steps:** 1. Disable network connectivity. 2. Observe the UI. 3. Restore connectivity. 4. Wait for recovery or use the UI's safe read retry.

**Expected:** friendly offline/reconnecting state; no raw network exception; read recovery restores the authoritative state; no mutation is automatically replayed without the same idempotency key.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-05 — Socket disconnection and reconnection

**Preconditions:** S-02 passed; staging access to disconnect the test socket or temporarily block its network path.

**Steps:** 1. Disconnect socket connectivity while HTTP remains available if practical. 2. Observe socket state separately from GPS status. 3. Restore connectivity. 4. Confirm a fresh authorized snapshot arrives.

**Expected:** socket failure is not misreported as GPS failure; reconnect rechecks current assignment authorization; no old room access survives.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-06 — Assignment change / replacement while connected

**Preconditions:** two synthetic buses; student currently assigned to bus A; both GPS states recorded; authorized administrator available.

**Steps:** 1. Keep student connected and tracking A. 2. Administrator changes assignment/replacement to B. 3. Observe without logout, restart, reopening map, or manual refresh. 4. Reconnect once and observe again.

**Expected:** old bus authorization and coordinates are removed; the authoritative assignment revision advances; B is authorized; if B lacks fresh GPS, the UI says unavailable/stale rather than showing A's coordinates.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-07 — GPS unavailable/stale state

**Preconditions:** assigned synthetic bus with no fresh GPS sample. Do not impersonate or activate the real inactive KIOT device.

**Steps:** 1. Open the assigned bus screen. 2. Observe displayed location, freshness label, and retry affordance. 3. Wait beyond the configured freshness threshold.

**Expected:** bus assignment remains visible; location is explicitly unavailable/stale; old coordinates are not treated as fresh; no fabricated movement appears.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

### S-08 — Session expiry and unauthorized access attempts

**Preconditions:** synthetic student token in staging; a second synthetic bus is not assigned to that student.

**Steps:** 1. Expire/revoke the test session using staging controls. 2. Attempt an authenticated request with the expired session. 3. Attempt a direct location request and preview-room subscription for the unassigned bus. 4. Reauthenticate normally.

**Expected:** expired session is handled safely; unassigned bus REST/socket access is denied server-side; client-controlled identifiers do not grant access; response/UI contains no raw technical details.

| Actual result | Pass/fail | Evidence |
|---|---|---|
| | | |

## Administrator workflows

Use authorized synthetic administrator accounts and a staging-only dataset. Capture before/after revisions and audit/outbox state without capturing private user data.

| ID | Workflow and steps | Expected result | Actual result | Pass/fail | Evidence |
|---|---|---|---|---|---|
| A-01 | Add a synthetic bus; read it back; inspect assignment resolution for a previously unresolved synthetic student. | One bus created; revisions and route/mapping state consistent; applicable unresolved assignment resolves once. | | | |
| A-02 | Edit bus details/metadata, then bus number and preview number independently. | Authorized changes only; stale versions conflict; mappings/assignments and client views reconcile; GPS identity is not accidentally transferred. | | | |
| A-03 | Update a bus route, then attempt a conflicting update from a stale revision. | Current revision succeeds once; stale update gets conflict; route recipients/outbox are consistent. | | | |
| A-04 | Assign one synthetic student to a different bus while the student remains connected. | Assignment revision advances; old room/access revoked; current snapshot and new bus authorization agree. | | | |
| A-05 | Bulk role change on synthetic users with per-user expected versions; retry same action with the same key; retry key with changed payload. | Same request replays without a second mutation; changed payload returns conflict; only actually changed roles revoke sessions. | | | |
| A-06 | Bulk delete synthetic users with expected versions; repeat request after simulated uncertain response. | Each selected resource is conditionally deleted once; unrelated accounts remain; access is revoked. | | | |
| A-07 | Deactivate a synthetic student; try a new REST request and socket reconnection using the prior session. | Both are denied; old bus room access is removed. | | | |
| A-08 | Change global active plan and a plan mapping while synthetic assigned students are connected. | Effective assignments reconcile to authoritative mapping; old authorization/location is removed; revisions and outbox agree. | | | |
| A-09 | Combine/separate buses, replace/alter a bus, and use supported rollback/restore paths. | Each operation is version-guarded; student assignments and socket rooms reconcile; no previous bus coordinates are displayed under the new identity. | | | |
| A-10 | Import synthetic users; simulate an interrupted test upload; resubmit the same key/content and then the same key with changed content. | Completed rows do not repeat; retryable rows resume; content mismatch conflicts; status is visible only to the authorized owner. Use test-only accounts and data. | | | |
| A-11 | Import bus routes for a new bus and an existing bus; test unchanged, metadata-only, route-change, and stale-revision cases. | Per-row expected-version conflicts are reported; new-bus unresolved assignments reconcile; duplicate notifications are not created. Use test-only buses and data. | | | |
| A-12 | Inspect outbox status as Primary Admin, then attempt replay; inspect and replay as Superadmin with a reason; repeat/concurrently replay. | Primary Admin can inspect but cannot replay; Superadmin replay is audited, resumable, and duplicate/concurrent-safe. | | | |
| A-13 | Deactivate a synthetic Excel upload with linked synthetic users; retry with the same key and attempt a stale revision. | Upload and linked users deactivate once; audit/outbox are present; same-key retry replays; stale revision conflicts. | | | |
| A-14 | Attempt stop-coordinate replacement and Excel-upload re-upload using the legacy UI/API path. | Retired stop-coordinate replacement returns HTTP 410 without writes; metadata-only Excel re-upload is unavailable/returns HTTP 410; no upload action remains in the UI. | | | |
| A-15 | Activate/deactivate a synthetic bus; change its route/plan mapping while students are connected. | Current bus/route/mapping revisions are respected; assignment and socket authorization reconcile; no stale bus location is misattributed. | | | |
| A-16 | Run the pilot flows on the lowest-supported Android devices and a constrained network. | Screens remain responsive; reconnect is understandable; map updates do not repeatedly reload the full map or download fleet-wide locations. | | | |

## Critical acceptance cases

| ID | Acceptance case and verification | Expected result | Actual result | Pass/fail | Evidence |
|---|---|---|---|---|---|
| C-A | Student attempts arbitrary bus REST and socket access. | No access to another bus. | | | |
| C-B | Reassign a connected student without restarting or reopening tracking. | Old bus disappears from effective view; new authoritative assignment is shown. | | | |
| C-C | Reassign to bus with no fresh GPS sample. | No old-bus coordinates are presented for the new bus. | | | |
| C-D | Submit two administrative writes with the same expected revision. | At most one succeeds; stale write receives conflict. | | | |
| C-E | Retry an uncertain mutation using its original idempotency key and payload. | Original result is replayed; no duplicate change or notification. | | | |
| C-F | Retry an interrupted import with same key/content. | Completed rows are not processed again; retryable rows resume; changed content with the same key conflicts. | | | |
| C-G | Deactivate a student, then use an existing connection and reconnect. | Existing access revoked and reconnect denied. | | | |
| C-H | Track an assigned bus with inactive/no-fresh GPS. | Honest unavailable/stale status; no fabricated coordinates. | | | |

## Sign-off

| Role | Name/ID | Result | Date |
|---|---|---|---|
| Backend reviewer | | | |
| Mobile reviewer | | | |
| Security reviewer | | | |
| KIOT pilot owner | | | |

Any failed critical case blocks the pilot until the defect is fixed and the case is rerun. Attach sanitized request IDs, revisions, screenshots, and staging logs as evidence; redact all tokens, credentials, and personal data.
