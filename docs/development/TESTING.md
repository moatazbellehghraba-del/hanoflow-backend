# Backend testing

Use Node 24 LTS and the locked npm dependencies. On this workstation activate
the portable runtime through process-local PATH as documented in README.

## Separate verification layers

| Command            | Infrastructure                      | Scope                                                                             |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------- |
| npm test           | None                                | Unit/HTTP/GraphQL tests and offline target guards                                 |
| npm run test:db    | Dedicated PostgreSQL, hanoflow_test | Real Prisma queries and HTTP readiness; Redis overridden                          |
| npm run test:redis | Dedicated Redis on 127.0.0.1:6381   | Real Redis/BullMQ execution, outages, restart and shutdown; PostgreSQL overridden |

Default tests do not contact PostgreSQL or Redis. The separate real suites fail
when their infrastructure or required identity/configuration is unavailable; they
do not silently skip or replace their target with mocks. The Redis suite uses the
production AppModule plus test-only queue/processor fixtures. Its PostgreSQL
provider is substituted only so the Redis CI job does not require a database.
Compiled production smoke verification separately checks both real development
dependencies and existing REST/GraphQL health.

## Guarded PostgreSQL identity tests

Both DATABASE_URL (development) and TEST_DATABASE_URL (hanoflow_test) are required.
The existing pre-connection target guard remains unchanged: matching local user,
loopback, configured dedicated port, exact distinct test database. Deploy reviewed
migrations to the verified test target first; restore the development environment
before `npm run test:db`. See [safe deployment workflow](../architecture/IDENTITY.md#migration-and-inspection).

The original four connectivity/readiness tests remain. Task 2.2 adds 42 real
identity tests covering UUID defaults, Unicode canonical email, uniqueness,
lifecycle enums, memberships/composite keys/FKs, removal/reactivation support,
audit scope/correlation/metadata/history, migration checksum, tables, checks,
indexes and explicit collation. Only per-test allocated UUIDs are cleaned up,
in FK-safe order; one direct SQL fixture uses transaction rollback. Never truncate
tables, reset, seed unrelated records or run this suite on development. Apply
migrations separately; tests never repair a missing schema silently.

No new offline test duplicates database constraints. The existing offline layer
continues to verify guards, configuration, dependency-free health and lifecycle.
CI deploys migrations specifically to its ephemeral test URL before test:db.

## Password tests and benchmarks

Task 2.3 adds 36 offline password tests with real native Argon2 and controlled
capacity/failure fixtures, plus 10 guarded PostgreSQL credential tests. Creation
policy, Unicode, exact parameters, historical verification, PHC resource bounds,
capacity overflow/timeout/release, one-to-one/FK/timestamps and stale rehash support
are covered. Existing identity catalog tests now expect the additional reviewed
migration/table/constraint without losing their original assertions. Default
tests still require neither PostgreSQL nor Redis. Only exact run-owned UUIDs are
removed in the real DB suite, with credentials before users. Assertions never
dump PHC values or raw credential Prisma errors. No secret snapshots are used.

`npm run build`, then `npm run benchmark:passwords`, performs the separate offline
synthetic benchmark with aggregate output only. See PASSWORDS.md and PROGRESS.md
for actual environment, counts, durations and limits; benchmarking is not CI load
testing or production sizing. No CI job changes were needed for Task 2.3.

## Dedicated Redis test environment

Run from the backend repository:

```powershell
$env:Path = "C:\dev-tools\node24;$env:Path"
npm run redis:test:up
npm run redis:test:inspect
npm run test:redis
npm run redis:test:stop
```

The up command creates ignored `.env.redis-test` only if absent. It contains
explicit TEST_REDIS_URL=redis://127.0.0.1:6381/0 and a generated UUID
TEST_REDIS_INSTANCE_ID. Existing files are not overwritten. This file is separate
from development `.env`; neither PostgreSQL credentials nor development Redis
configuration is changed. Environment variables take precedence, so contradictory
values fail verification instead of silently switching targets.

Compose uses `compose.redis-test.yaml`, fixed project `hanoflow-redis-test`, service
`redis-test`, pinned `redis:8.2.11-bookworm`, loopback host port 6381/internal 6379,
its own `hanoflow-redis-test_redis-test-data` volume, AOF everysec, 256 MiB maxmemory,
noeviction, PING health checks and 30-second stop grace. There is no automatic
restart policy. Stop preserves the container and volume; up can restart this same
verified environment. No volume deletion or global database cleanup is provided.

Do not delete/recreate `.env.redis-test` while retaining its container/volume:
the marker will no longer match, and the tools deliberately refuse to adopt it.
Resolve identity mismatches through an explicitly reviewed recovery procedure.

## Identity and lifecycle safety

- TEST_REDIS_URL is mandatory and must exactly match the approved test endpoint.
  There is no fallback to REDIS_URL, alternate port/database, remote host or URL
  query option. TEST_REDIS_INSTANCE_ID must be an explicit UUID.
- The up tool verifies Docker labels, exact image, binding, dedicated volume and
  container environment before seeding `hanoflow:test-instance` using SET NX. It
  never overwrites an existing marker. The marker value includes the project/UUID.
- The suite verifies the marker through a real read before constructing queues.
  Before deliberate outages, that verified identity is retained together with the
  exact container ID. Creating an app while Redis is stopped uses this established
  identity and cannot switch the target.
- Every stop/start/restart goes through scripts/redis-test.mjs. It checks project,
  service, image, loopback port, volume, instance environment and expected container
  ID. Running containers must also pass the Redis marker check before lifecycle
  operations. No arbitrary container argument is accepted.
- Every application instance gets a fresh prefix containing run and instance UUIDs.
  Cleanup first closes its app, rechecks identity, and scans/unlinks only prefixes
  created by the current run. No FLUSHALL, FLUSHDB or unrelated key deletion.
- Failure teardown restores only the verified isolated container and releases test
  processor gates. Development Redis/PostgreSQL are never stopped or restarted.

## Real acceptance coverage

The real suite verifies server settings, job publication/state transitions/result,
correlation persistence, two failures followed by success, terminal three-attempt
failure, exponential backoff with timing tolerances, and identical job IDs in
independent prefixes. Retry timing is observed through worker active events.

Controlled outage checks verify bounded producer failure, dependency-free REST and
GraphQL liveness, safe readiness 503, bounded initialization without Redis and
readiness/worker recovery on the same application. A normal Redis restart verifies
waiting-job and instance-marker persistence with AOF enabled.

Shutdown checks cover rejecting new publication, draining a held active job,
cooperative cancellation at the real deadline, normal worker/queue closure and
shutdown while Redis is unavailable. Client inventories must return to the single
test observer after every case. `--detectOpenHandles` is enabled; there is no forced
Jest exit. Tests use finite state polling and deadlines rather than long sleeps.

The full active-job timeout case intentionally consumes about 29 seconds to test
the real approved 30-second budget; do not shorten it to claim equivalent coverage.

## CI and limits

GitHub Actions retains the existing application and real PostgreSQL jobs. A separate
Redis job uses the same pinned Compose file and npm setup/inspection/stop commands,
so identity and lifecycle checks match local execution. It creates its own test
identity and runs the full real suite. Always-run cleanup stops only that verified
container. Workflow configuration can be checked locally, but local execution is
not evidence of a GitHub Actions run.

Normal restart persistence is not a crash/power-loss durability test. AOF everysec
may lose recent writes after abrupt host failure. Timing checks allow scheduling
variation, not unlimited delays. Cancellation is cooperative, and future business
handlers still require idempotency, bounded external I/O and tenant authorization.
The foundation is for local development, not production readiness. Existing
security advisories and deployment restrictions remain in force.

See PROGRESS.md for exact executed counts, durations, corrections and outcomes.
