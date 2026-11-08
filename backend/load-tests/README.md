# BTMS capacity test preparation

These are manual, bounded test runners. They are never imported or launched by
the application, `npm test`, or another runner. **Production is permanently
blocked in code.** There is no production confirmation variable or interactive
bypass. No production load test is authorized by this documentation.

## Runners and fixtures

- `student-login-capacity-test.js` sends one concurrent login request for each
  of exactly 50 unique accounts in the Git-ignored
  `student-login-capacity-accounts.json`.
- `student-capacity-test.js` runs exactly one selected `login`, `active`,
  `endurance`, or `recovery` scenario per invocation at one stage (20, 50,
  100, 250, or 500 virtual clients). Its Git-ignored `accounts.json` fixture
  may contain fewer accounts than virtual clients. The runner reports unique
  accounts and reuse separately: 500 clients backed by 20 accounts means 20
  distinct students and 480 reused virtual-client assignments, not 500
  students. Active clients log in once per unique account and reuse JWTs for
  separate sockets; the login scenario sends one login per virtual client and
  cycles through fixture accounts.

Use only authorized, dedicated test identities. Never put real student
passwords, production credentials, or tokens in source control. The scripts
do not print credentials, email addresses, tokens, response bodies, or
location coordinates. They do not create or mutate accounts, request GPS
provider updates, or execute database migrations. Local cleanup disconnects
their sockets and does not revoke JWTs.

## Target safety

The default target is `http://127.0.0.1:5000`. HTTP is permitted only on
`localhost`, IPv4 loopback, or IPv6 loopback, and only on backend port 5000.
Remote targets require HTTPS on the default port, an exact hostname in
`BTMS_CAPACITY_STAGING_HOSTS`, and `BTMS_CAPACITY_CONFIRM_STAGING=YES`.
Hostnames are normalized for case, trailing dots, and URL/IDNA parsing before
comparison. `bts-kiot.onrender.com` is rejected regardless of case, trailing
dot, scheme, port, or confirmation variables. Arbitrary remote HTTP targets,
credentials in URLs, paths, query strings, and fragments are rejected.

The allowlist is an operator assertion, not a way to prove environment
identity. Add only a dedicated staging hostname whose DNS and backend
configuration have been independently confirmed to use isolated test data.
Do not allowlist production aliases. Remote requests are not made by automated
tests.

Required variables for an explicitly authorized staging run:

| Variable | Purpose |
|---|---|
| `BTMS_CAPACITY_BASE_URL` | Active-runner origin |
| `BTMS_LOGIN_CAPACITY_BASE_URL` | 50-account login-runner origin |
| `BTMS_CAPACITY_STAGING_HOSTS` | Comma-separated exact staging hostnames |
| `BTMS_CAPACITY_CONFIRM_STAGING` | Must equal `YES` for a remote staging run |

No secrets are needed in these target variables. The runners read their
credentials from local Git-ignored fixture JSON files.

## Safe local commands (PowerShell)

Run synthetic runner tests without network access:

```powershell
Set-Location 'E:\My Works\College Products\BTS\backend'
node --test .\test\student-login-capacity-test.test.js
node --test .\test\student-capacity-test.test.js
```

For intentional local testing, first start a local backend with an isolated
test database and populate the appropriate local fixture. Review the
requested workload before running a command:

```powershell
Set-Location 'E:\My Works\College Products\BTS\backend'
node .\load-tests\student-login-capacity-test.js
node .\load-tests\student-capacity-test.js --scenario login --clients 20
node .\load-tests\student-capacity-test.js --scenario active --clients 20 --ramp-ms 60000 --hold-ms 300000
```

The 50-account runner sends 50 simultaneous login requests. The staged runner
caps virtual clients at 500, ramp input at 10 minutes, hold input at 2 hours,
HTTP/socket/event timeouts at 2 minutes, reconnection attempts at 5, and
calculated total duration (including timeout/reconnect allowance) at 2 hours.
The total-duration limit means the maximum usable hold is less than 2 hours.
Defaults use 15-second HTTP, 30-second socket, and 2-minute location-event
timeouts. Login burst, sustained authenticated sessions, recovery, and
endurance remain separate scenarios. The endurance scenario requires at least
60 minutes of hold time.

For staging, set the exact approved hostname and allowlist only for the
current PowerShell session, then clear the variables:

```powershell
$env:BTMS_CAPACITY_BASE_URL = 'https://<approved-staging-host>'
$env:BTMS_LOGIN_CAPACITY_BASE_URL = 'https://<approved-staging-host>'
$env:BTMS_CAPACITY_STAGING_HOSTS = '<approved-staging-host>'
$env:BTMS_CAPACITY_CONFIRM_STAGING = 'YES'
try {
    node .\load-tests\student-capacity-test.js --scenario active --clients 20 --ramp-ms 60000 --hold-ms 300000
}
finally {
    Remove-Item Env:\BTMS_CAPACITY_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\BTMS_LOGIN_CAPACITY_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\BTMS_CAPACITY_STAGING_HOSTS -ErrorAction SilentlyContinue
    Remove-Item Env:\BTMS_CAPACITY_CONFIRM_STAGING -ErrorAction SilentlyContinue
}
```

Load tests create real backend load and can affect other users. Automated
coverage uses synthetic accounts and injected HTTP/socket implementations;
it proves validation and runner behavior, not backend capacity or staging
isolation. Review reports and monitor the authorized test environment before
choosing another stage.
