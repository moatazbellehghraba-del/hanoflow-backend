# HanoFlow backend

A standalone NestJS modular monolith for HanoLink's planned multi-tenant delivery management platform. The application foundation, PostgreSQL/Prisma infrastructure and hybrid GraphQL/REST API infrastructure are implemented. Redis connectivity/readiness and BullMQ queue/worker infrastructure are implemented without production queue or worker registration. Task 2.2 adds User, Tenant, Membership and minimum AuditEvent persistence only. Public authentication/authorization endpoints, onboarding workflows and business operations are not implemented. See [identity architecture](docs/architecture/IDENTITY.md).

Task 2.3 adds PasswordCredential persistence and a non-global internal identity
module with Argon2id hashing/verification, structural password policy, upgrade
detection and bounded capacity. There are no authentication endpoints or workflows.
See [password architecture and benchmark](docs/architecture/PASSWORDS.md).

Task 2.4 adds internal PostgreSQL-backed identity sessions, digest-only opaque
access/refresh tokens, transactional rotation/replay revocation and safe audit
events. There are no public authentication transports or guards. See [session architecture](docs/architecture/SESSIONS.md).

Task 2.5 adds tenant RBAC, runtime-proven tenant contexts, both-credential context
rotation and transactional owner/delegation protections. No RLS or business-resource
authorization is claimed. See [authorization architecture](docs/architecture/AUTHORIZATION.md).

## Requirements and setup

Run commands from the dedicated `hanoflow-backend` repository directory. Use Node 24 LTS (24.15+), npm 10.9+, Git and Docker Compose v2 for local PostgreSQL. The npm lockfile records exact installed dependencies. System Node 22.17 does not meet this project's engine requirement.

For this Windows workstation, activate the existing portable runtime in each new PowerShell session (including independent automation shells):

```powershell
$env:Path = "C:\dev-tools\node24;$env:Path"
node -v
npm -v
where.exe node
where.exe npm
node -p "process.execPath"
```

Expected here: Node 24.22.3, npm 11.19.1 and C:\dev-tools\node24\node.exe. npm scripts inherit this process-local PATH. This changes neither the system Node 22.17 installation nor permanent Windows PATH. The portable path is workstation-specific; other environments only need a compatible Node 24 on PATH. Application code, npm scripts and CI do not depend on that absolute path.

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres redis
npm run start:dev
```

On PowerShell use `Copy-Item .env.example .env` only when `.env` does not already exist. Edit its local password and matching URL-encoded password in DATABASE_URL before starting PostgreSQL. Environment variables override .env. Defaults: NODE_ENV=development, PORT=3000, APP_NAME=HanoFlow. NODE_ENV accepts development, test or production; PORT must be an integer from 1 to 65535. DATABASE_URL is required and must be a PostgreSQL URL. APP_NAME keeps branding separate from domain behavior.

```sh
curl http://localhost:3000/api/v1/health
# {"status":"ok"}
curl http://localhost:3000/api/v1/health/ready
# {"status":"ok","database":"up","redis":"up"} when both dependencies are reachable
```

`/health` remains application liveness only. `/health/ready` executes PostgreSQL SELECT 1 and Redis PING concurrently, returning HTTP 503 with a generic error when either is unavailable. Unknown routes return 404. An unreachable database permits startup in an unready state; malformed or missing database configuration fails startup.

## Local database workflow

Compose pins `postgres:18`, binds only to `127.0.0.1:5434` by default, uses a health check and persists data in the project-scoped `postgres-data` volume mounted at `/var/lib/postgresql`. POSTGRES_DB, POSTGRES_USER and POSTGRES_PASSWORD are required; POSTGRES_PORT defaults to 5434 and the container still listens on 5432. Existing host services on 5432 and 5433 belong to other projects and must remain untouched. Keep DATABASE_URL and TEST_DATABASE_URL on the same configured HanoFlow host port, with distinct database names. Changing initialization variables does not change accounts or databases in an existing volume. A local ignored .env is used for credentials; never print or commit its values.

```sh
docker compose up -d --wait postgres
docker compose ps
docker compose stop postgres
docker compose down
```

Stop and down preserve the volume. Do not use `down -v` or volume pruning. For a fresh local database without deleting existing data, stop the original project, then start a separate Compose project:

```sh
docker compose down
docker compose -p hanoflow-backend-fresh up -d --wait postgres
# Stop the fresh project before returning to the original:
docker compose -p hanoflow-backend-fresh down
docker compose up -d --wait postgres
```

The new project creates a separate empty volume; the original data remains intact. Choose a previously unused project name each time. This is the documented local reset workflow; no destructive reset is automated.

## Prisma and migration workflow

`npm ci` generates the ignored ESM Prisma Client via postinstall. `prisma.config.ts` loads .env for CLI commands; database URLs live in configuration, not the schema. Runtime uses PrismaPg and Nest's ConfigService. The first meaningful migration is `20261126190000_core_identity`, with four approved identity tables and reviewed SQL-only invariants. There is no seed. Verify target, existing schema/data and migration history before deployment; test on guarded hanoflow_test first. See [migration and inspection instructions](docs/architecture/IDENTITY.md#migration-and-inspection). No migration runs at application startup.

```sh
npm run db:validate
npm run db:generate
# Only with separately approved disposable/shadow database access:
npm run db:migrate:dev -- --name describe_change
npm run db:generate
# In a controlled deployment/release step:
npm run db:migrate:deploy
npm run db:migrate:status
npm run db:studio
```

Review migration SQL and commit it with schema changes. Do not use db push or accept an unexpected migration-reset prompt. Studio is a local administrative tool; do not expose it publicly. Production builds need generation before TypeScript compilation; release migration tooling requires the CLI dev dependency. Build with `npm ci` and `npm run build`, then deploy compiled dist plus runtime dependencies; if installing runtime dependencies separately, use `npm ci --omit=dev --ignore-scripts` because the generated client is already compiled into dist. Supply DATABASE_URL through deployment secrets, use verified TLS as required by the host, and separate migration privileges from runtime privileges. Never use example credentials in production.

## Real PostgreSQL tests

`npm test` and `npm run test:e2e` use an overridden Prisma provider and never contact a database. `npm run test:db` is a separate suite using a real Prisma client with no database mocks. It requires both DATABASE_URL (development) and TEST_DATABASE_URL (test) and fails if unavailable; it never silently skips. Before opening any client, its target guard requires loopback URLs, the same database user, the configured POSTGRES_PORT (default 5434, never 5432/5433), the exact test database name hanoflow_test and a distinct development database. If POSTGRES_USER is configured, both URLs must use that user. This suite intentionally does not accept arbitrary remote/production targets. Create the test database once in a fresh local cluster:

```sh
docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" hanoflow_test'
# Deploy reviewed migrations to the verified test target first (workflow below).
npm run test:db
```

Set TEST_DATABASE_URL in .env to match that database and the configured credentials/port. Development uses hanoflow; tests use hanoflow_test in the same dedicated container. Do not repeat createdb if the database already exists. Deploy reviewed migrations to the guarded test target before test:db, then restore the original development environment so the guard sees distinct targets. Tests verify current_database(), real schema constraints and migration checksum; they clean up only exact IDs created by the current run, without truncation/reset. CI creates and migrates its separate test database before running tests. See [database architecture](docs/architecture/DATABASE.md) and [testing instructions](docs/development/TESTING.md).

## GraphQL and REST

Internal GraphQL uses POST /graphql; external REST remains under /api/v1. Both health transports share application logic. The code-first schema is generated deterministically in memory at startup, including when running compiled dist output; no generated SDL file is stored. Development enables GraphiQL and introspection; test/production disable them using the existing validated NODE_ENV. No new environment switches are needed.

```sh
curl -H 'Content-Type: application/json' --data '{"query":"{ health { status } }"}' http://localhost:3000/graphql
# {"data":{"health":{"status":"ok"}}}
```

Every HTTP request receives a server-generated x-request-id. Structured completion logs exclude bodies, variables, headers and URL query strings. GraphQL errors preserve the standard data/errors response, safe machine-readable codes and correlation IDs where context exists; REST error envelopes remain unchanged. Shared setup enforces a 100 KB body limit. GraphQL disables batching and automatic persisted queries, retains CSRF checks and applies coarse token/depth/field limits compatible with full development introspection.

See [API architecture](docs/architecture/API.md) for context, validation, error semantics, production policy, examples, testing and deferred security work. The operational API remains unauthenticated; it must not be represented as production-secure. A new high production audit finding in Apollo's transitive GraphQL Tools dependency is documented there and must be addressed before deployment; no forced fix or new override was added.

## Commands

- `npm run start:dev`: watch mode.
- `npm run build` then `npm run start:prod`: compile and run production output.
- `npm run lint`: ESLint with type-aware rules.
- `npm run typecheck`: strict TypeScript including tests.
- `npm run build` then `npm run benchmark:passwords`: offline synthetic Argon2 benchmark; prints aggregate metrics only.
- `npm test`: Jest unit and HTTP integration tests.
- `npm run test:e2e`: HTTP integration tests only.
- `npm run format:check` / `npm run format`: check/apply Prettier.

## HTTP and runtime conventions

REST uses URI versioning under /api/v1. Global DTO validation transforms decorated DTOs and rejects unexpected properties. HTTP errors have statusCode, message, path and timestamp fields. Unexpected/server errors use a generic message. Paths omit query strings. Nest's built-in JSON ConsoleLogger writes structured application logs without a hosted telemetry dependency. SIGINT/SIGTERM trigger Nest shutdown hooks and HTTP server cleanup.

Environment validation fails startup rather than serving with invalid settings. The endpoint does not disclose environment or branding values. No authentication or business endpoints exist yet.

## Layout

```text
src/
  main.ts
  app.module.ts
  config/
  common/{filters,interceptors,pipes}/
  modules/health/
  infrastructure/
test/
docs/{architecture,decisions,development}/
.github/workflows/
```

See [architecture](docs/architecture/OVERVIEW.md), [API architecture](docs/architecture/API.md), [progress](docs/development/PROGRESS.md) and [agent instructions](AGENTS.md). Prisma and GraphQL/REST infrastructure are present. BullMQ infrastructure is implemented; authentication, trusted tenant resolution and business modules remain planned. Redis connectivity is implemented; see [Redis architecture](docs/architecture/REDIS.md).

CI runs formatting, lint, type checks, tests and build on pull requests using Node 24 and npm ci, plus a separate real PostgreSQL job. Prisma's Effect dependency is overridden to the compatible 3.22.1 patch to address GHSA-7589-6fvf-x4pw. Existing moderate Jest tooling findings remain; see progress for actual verification results and environment limitations.

Historical Task 1.2.1 verification on 2026-11-25 passed: 39 offline tests, four real database tests, all static/build gates, and HTTP healthy/outage/recovery checks against PostgreSQL 18.7. Liveness stayed 200; readiness changed 200 to 503 and recovered without application restart. At that stage the model-free database intentionally had no migration history. Task 2.2 supersedes that schema state with the reviewed identity migration; see PROGRESS.md for current results. GitHub Actions was not run by this agent.

## Redis local configuration (Task 1.4.2)

Required settings are REDIS_URL=redis://127.0.0.1:6380/0 and
QUEUE_PREFIX=hanoflow-dev. REDIS_PORT=6380 controls only the Compose binding;
keep the URL synchronized. Add these settings to an existing .env without replacing
its PostgreSQL credentials. Port 6381 is dedicated to the isolated Redis test project; see [testing](docs/development/TESTING.md).

Redis uses redis:8.2.11-bookworm, persistent redis-data storage, AOF everysec,
256 MiB maxmemory and noeviction. It has no automatic restart policy, matching
PostgreSQL. Start only Redis with `docker compose up -d --no-deps --wait redis`;
verify using `docker compose exec -T redis redis-cli PING` and `docker compose ps`.
Do not delete volumes or flush Redis. The local service has no authentication;
keep it loopback-only. Production deployment remains blocked.

Malformed Redis configuration fails startup safely. Unreachable Redis leaves HTTP
live but unready after a bounded initial attempt; the client reconnects automatically.
Default tests use overrides and do not require Redis. The real PostgreSQL suite
continues to use a real dedicated database and overrides Redis only. Task 1.4.2
live healthy checks passed; Task 1.4.4 later verified isolated Redis outage/recovery.
See [Redis architecture](docs/architecture/REDIS.md) and the latest progress entry.

## BullMQ foundation (Task 1.4.3)

Exact runtime packages bullmq 6.7.10 and @nestjs/bullmq 12.0.2 use existing
ioredis 6.1.0. The non-global QueuesModule is explicitly imported by AppModule;
its root configuration opens no queue connections and registers no production
queues, workers, enqueue endpoints or GraphQL mutations. No additional environment
settings are required. Redis readiness and all health contracts remain unchanged.

Feature modules can explicitly register producers and managed workers through
QueuesModule. Defaults: 3 attempts, exponential backoff starting at 1s, concurrency
1, completed retention 24h/1000 jobs and failed retention 7d/5000 jobs. Producers
have a 2s budget; workers reconnect without short command timeouts. Shared shutdown
drains and disconnects owned originals/blocking duplicates within a 30s budget.
See [queue architecture](docs/architecture/QUEUES.md) for integration conventions.

At Task 1.4.3 closure, verification passed 140 application tests and four real PostgreSQL tests. The test-only
nonce processor was invoked directly offline; it has not executed in BullMQ.
At that closure, no isolated test Redis instance existed. Real enqueue/retry/outage/recovery and
Redis CI checks were deferred to Task 1.4.4. Never run test jobs against development Redis.
The existing production security advisory still blocks deployment.

## Real Redis and BullMQ acceptance (Task 1.4.4)

Run from this repository with Node 24 active:

```sh
npm run redis:test:up
npm run redis:test:inspect
npm run test:redis
npm run redis:test:stop
```

The separate compose.redis-test.yaml project uses Redis 8.2.11, loopback port
6381 and an independent persistent volume. The up command creates ignored
.env.redis-test with explicit TEST_REDIS_URL and a generated instance identity.
Do not replace that file while retaining its container/volume. Every real queue
test verifies the instance marker and uses a new prefix; Docker lifecycle checks
also enforce project/service/volume/binding/container identity. No test job runs
against development Redis. Stop preserves test storage and never touches the
development services. No global Redis cleanup commands are used.

The suite covers actual jobs, retries, terminal failures, isolation, startup and
outage recovery, restart persistence and real shutdown deadlines. PostgreSQL is
overridden only in this Redis-specific suite; test:db remains real and unmocked.
Default npm test remains independent of live services. The existing application
and database CI jobs are preserved; the new Redis job uses the same guarded setup.
See [testing and CI](docs/development/TESTING.md) and the latest progress entry for
executed results and limitations. Local acceptance is not production readiness.

Task 1.4.4 final local acceptance passed: 155 application tests, four real
PostgreSQL tests and 11 real Redis/BullMQ tests (170 total). Observed retry gaps
were 1017ms/2014ms; real active-job shutdown took 29022ms. Initial startup-outage
testing exposed cached first-connect rejection; the corrected owned-client handoff
now recovers on the same app. Build, static gates, Prisma validation and compiled
REST/GraphQL smoke checks passed. Phase 1 is functionally complete for local
development only. GitHub Actions was not run; deployment remains blocked and
Phase 2 identity/password persistence and internal session/token operations are implemented through Task 2.5; see [identity architecture](docs/architecture/IDENTITY.md), [password architecture](docs/architecture/PASSWORDS.md), [session architecture](docs/architecture/SESSIONS.md) and PROGRESS.md. Task 2.6 requires separate approval. Compromised-password screening remains required before a complete production password policy can be claimed.
