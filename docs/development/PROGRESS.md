# Development progress

Updated: 2026-11-26 (Africa/Lagos).

## Current phase

Phase 2: core identity persistence implemented through Task 2.2.
Not production-ready; existing deployment restrictions remain in force.

## Current task

Task 2.2 complete: four identity models, reviewed initial migration, 42 new real PostgreSQL tests and documentation. All 212 tests passed. Production deployment remains blocked. Task 2.3 has not started; await explicit approval.

## Completed tasks

- Inspected an empty workspace and initialized a standalone npm/NestJS 12 backend.
- Added strict TypeScript, ESLint, Prettier, validated environment configuration, /api/v1 URI versioning, global DTO validation, safe API errors, JSON logging and shutdown hooks.
- Added only AppModule and HealthModule; GET /api/v1/health returns application liveness only.
- Added Jest environment and HTTP integration tests, architecture documentation, permanent AGENTS.md instructions and pull-request CI.
- Initialized local Git; no commit, remote, push or deployment.
- Corrected the backend repository location in Task 1.1.2 without losing files or Git metadata.
- Implemented Task 1.2 database infrastructure, readiness, developer scripts, separate real database tests and database CI configuration; see the detailed verification record below.
- Completed Task 1.2.1 on 2026-11-25: verified the portable Node/npm runtime, dedicated Docker PostgreSQL on host port 5434, isolated test database, real Prisma connectivity, readiness outage/recovery and all required quality gates.
- Completed Task 1.3: compatible code-first GraphQL/Apollo infrastructure, shared health logic, transport-aware validation/errors, request correlation/logging, request bounds, production policy, automated tests and live verification.

## Pending tasks

- Owner review of Task 2.2, then separately authorize Task 2.3. Authentication, trusted tenant context, RBAC/ownership, both onboarding workflows and RLS remain future work.
- Resolve the existing GraphQL Tools production advisory through a reviewed compatible dependency change before deployment; retain all existing exposure restrictions.

## Technical decisions

- Node 24 LTS (24.15+), npm 10.9+, NestJS 12 ESM and TypeScript 6.
- Jest and ESLint replace scaffold defaults; optional telemetry/agent bundles were removed.
- Built-in JSON ConsoleLogger avoids an additional logging dependency.
- class-validator/class-transformer validate environment and request DTOs.
- Config defaults enable local boot without external services; environment values are validated at startup.
- API errors redact server details and omit query strings; non-API paths are handled by the HTTP adapter.

## Historical Task 1.1 verification

- npm install and clean npm ci: passed.
- ESLint, tsc --noEmit and nest build: passed using Node 24.22.3.
- Jest: 2 suites, 17 tests passed (environment validation, liveness, URI routing, DTO validation, safe errors).
- Compiled production application startup: passed; live GET /api/v1/health returned HTTP 200 with { "status": "ok" } on an isolated available port. JSON startup logs verified. Smoke process stopped afterward.
- Formatting check: passed.
- HTTP test teardown closes the application; shutdown hooks enabled. Native OS signal handling was not separately exercised on Windows.
- Git initialized locally; CI workflow created but not run on GitHub.

## Known issues

- Local port 3000 was already serving another application; live verification used an available isolated port without stopping the existing service. Set PORT to a free port for local development.

- The earlier Docker startup and database authentication blockers are resolved for HanoFlow: its dedicated container uses port 5434. Existing PostgreSQL services on 5432 and 5433 remain untouched.
- System Node 22.17 remains intentionally installed. Each independent Windows shell must activate the portable C:\dev-tools\node24 runtime through process-local PATH; no permanent PATH changes were made.
- Current npm audit reports 18 moderate development findings and one existing high production finding in @graphql-tools/utils (GHSA-7mx3-vvmw-hjmv), confirmed during Tasks 1.4.2/1.4.3. Earlier Task 1.3 advisory descriptions below are historical. No forced fix, downgrade or new override was applied. The unauthenticated foundation is not production-secure.
- Jest ESM uses Node experimental VM modules and emits its standard experimental warning.

## Next recommended task

Review Task 1.4.4 and Phase 1 closure. Agree and explicitly approve any Phase 2 scope before implementation. Production advisory remediation remains required before deployment.

## Task 1.1.2 - Backend folder correction (2026-11-23)

- Inspected every parent entry, including hidden files. The destination did not exist; no unrelated files or projects were present. Git tracked no files and had no commits or remotes.
- Kept the main project directory unchanged at `D:\HANO LINK PROJECTSSSSS\HanoFlow or HanoShip` and moved all 23 backend entries into its dedicated `hanoflow-backend` directory.
- Preserved the existing `.git` directory, source, tests, documentation, CI, hidden configuration, `.env.example`, lockfile, dependencies, build output and TypeScript build metadata. No `.env` file existed in the inspected parent.
- Verified SHA256 hashes and the file count for all 22,635 moved files before documentation updates and build verification; all contents matched.
- Confirmed `package.json`, `src/main.ts` and `AGENTS.md` exist in the backend. Git now resolves its root to `hanoflow-backend`; the parent is not a Git repository and contains only that backend directory. No nested backend or frontend project was created.
- From the relocated backend, using existing Node 24.22.3 and dependencies: npm run lint, npm run typecheck, npm test (2 suites, 17 tests), npm run build and npm run format:check passed.
- The normal sandbox launcher failed, so authorized operations used elevated execution. Git ownership checks required a command-scoped safe.directory exception; no global Git settings were changed. No file locks, collisions or content mismatches occurred.
- No dependencies were installed, backend business logic changed, repository initialized, commits created or code pushed. Existing Jest ESM experimental warnings remain.
- Next: review the folder correction and run future backend commands from `hanoflow-backend`. Task 1.2 has not started.

## Task 1.2 - PostgreSQL and Prisma infrastructure (2026-11-23)

### Implementation and files

- Added compose.yaml with PostgreSQL 18, required environment-supplied initialization settings, a project-scoped persistent volume mounted at /var/lib/postgresql, a pg_isready health check and a loopback-only host binding.
- Added prisma.config.ts, prisma/schema.prisma and prisma/migrations/migration_lock.toml. The model-free schema generates an ignored ESM client under src/generated/prisma. The URL is configured through the current Prisma 7 config API, not a deprecated schema datasource URL.
- Added src/infrastructure/database/database.module.ts, prisma.service.ts and prisma.service.spec.ts. DatabaseModule exports one DI-owned client with PrismaPg, connection/query bounds and Nest initialization/shutdown hooks.
- Added HealthService and updated health module/controller wiring. Liveness never queries PostgreSQL; readiness queries SELECT 1 and returns a safe 503 on failure. HTTP error filtering supplies a generic service-unavailable response without raw driver details. Transient database unavailability leaves the application live and permits later recovery; malformed/missing DATABASE_URL fails configuration validation.
- Updated environment configuration/tests and .env.example. Added separate Jest database configuration, real PostgreSQL tests, offline setup and readiness success/failure/recovery tests. Default tests do not need a database; the real suite requires TEST_DATABASE_URL and does not mock or skip connectivity.
- Updated npm scripts/lockfile, generated-file ignore rules, ESLint/TypeScript configuration and CI. Added database architecture documentation; updated README, AGENTS.md, architecture overview and this progress record.

### Dependencies and decisions

- Matching stable versions: prisma, @prisma/client and @prisma/adapter-pg 7.10.1. The latest Prisma CLI tag resolves to an 8.0.0 release candidate, so it was intentionally not selected.
- Added pg 8.23.1, dotenv 18.0.10, @types/pg 8.23.1 and explicit @jest/globals 30.5.2.
- Scoped @prisma/config's Effect dependency to the compatible 3.22.1 patch using an npm override, resolving the newly introduced high-severity advisory. Prisma validation/generation and installation passed with the override. Audit now reports the existing 18 moderate Jest tooling findings and zero production vulnerabilities.
- No seed or SQL migration was invented. The schema has no models, and Prisma's diff from empty returns only an empty-migration comment. Keep the provider lock; create the first meaningful SQL migration with the first approved schema change. No database migration was applied locally.
- Future design: shared PostgreSQL database with tenant-scoped records, explicit authorization and tenant-aware constraints; exact financial arithmetic and transactional/idempotent postings. No business models, tenant entities, authorization or RLS are implemented.

### Executed verification

- npm install: passed, including automatic postinstall Prisma Client generation. No database secrets or .env file were created or committed.
- npm run db:validate and npm run db:generate: passed. Prisma formatting and empty-schema migration diff also passed.
- npm run typecheck, npm run lint, npm test, npm run build and npm run format:check: passed using Node 24.22.3. Default tests: 3 suites, 27 tests passed. These include mocked readiness success/failure/recovery; they do not establish real PostgreSQL success.
- docker compose --env-file .env.example config --quiet: passed.
- Attempted hidden Docker Desktop startup and docker compose --env-file .env.example up -d --wait postgres: failed because the daemon is unavailable. Docker's startup log reports access denied launching com.docker.build.exe. No containers or volumes were reset/deleted.
- Ran npm run test:db with the documented example TEST_DATABASE_URL: failed (2 tests). A PostgreSQL server at 127.0.0.1:5432 returned authentication failure 28P01 for the example user; readiness returned 503. No real successful query or healthy database readiness is claimed. No accounts or tables were created/modified.
- Compiled production application smoke check on an isolated free HTTP port and deliberately unreachable database: passed startup, liveness HTTP 200, readiness HTTP 503 and secret-free error/log checks. The smoke process was stopped afterward. An initial log read hit a Windows sharing lock; rechecking after process shutdown succeeded.
- The CI workflow now includes a PostgreSQL 18 database job, but no GitHub run was executed. Production migration deployment and healthy readiness remain unverified locally pending an accessible dedicated database.
- No authentication, business entities, GraphQL, Redis/BullMQ, frontend, data reset, commits, pushes or deployments were introduced.

## Task 1.2.1 - Infrastructure finalization and live verification (2026-11-25)

### Runtime and dependency compatibility

- Independently verified Node 24.22.3 and npm 11.19.1 using C:\dev-tools\node24 through process-local PATH. process.execPath and a node child launched by npm exec both resolve to C:\dev-tools\node24\node.exe. where.exe lists the portable launchers before system Node/npm.
- Checked all 748 lockfile entries, including production, development and optional/transitive packages. Of these, 467 declare engine requirements; no declared Node/npm ranges are incompatible with Node 24.22.3/npm 11.19.1. npm ls --depth=0 passes with no missing/invalid direct dependencies.
- System Node C:\Program Files\nodejs\node.exe still reports 22.17.0. No installation, upgrade, NVM, permanent PATH modification, package version change or engine requirement change was performed. Package and lockfile were preserved.
- The restricted sandbox could not read Docker configuration/access its named pipe. Approved elevated command execution successfully accessed Docker Desktop 4.100.1, Engine 29.9.3 (Linux) and Compose 5.7.1; docker version and docker info passed. This is an execution permission requirement, not an unresolved Docker outage.

### Review findings and targeted corrections

- Existing PostgreSQL 18 volume convention, persistent named volume, health check, Prisma 7 ESM configuration, PostgreSQL adapter, singleton DI, lifecycle handling and safe readiness error strategy were retained. No production application logic required changes.
- Corrected compose.yaml, .env.example, local ignored .env, CI and documentation from the old host port to 5434. Internal container port remains 5432 and host exposure remains loopback-only. Port 5434 had no listener, a bind probe passed, and Windows IPv4 excluded ranges did not include it. Docker binding then succeeded.
- Added test/helpers/database-target.ts and offline guard tests. Before any client opens, the real suite requires loopback development/test URLs on the configured dedicated port (default 5434; 5432/5433 forbidden), matching usernames and a distinct exact hanoflow_test database. It verifies POSTGRES_USER when set. CI now provisions distinct development/test databases rather than sharing one target.
- Extended real integration tests with current_database() and the actual PostgreSQL statement_timeout setting (2s). Existing SELECT 1 and real HTTP tests remain unmocked and enabled. No tests were skipped or weakened.
- Updated README.md, AGENTS.md, docs/architecture/OVERVIEW.md, docs/architecture/DATABASE.md and this file. Runtime-specific paths remain documentation only, not application code, cross-platform scripts, CI or package engines.

### Dedicated database and isolation

- The initial Docker inventory contained only the user's exited hello-world container and default networks; there were no conflicting HanoFlow resources. No existing containers, networks or volumes were removed.
- No .env existed. Created an ignored local .env with a cryptographically generated dedicated password; no password or credential-bearing URL was displayed or committed. Existing secrets were not overwritten.
- Started only Compose project hanoflow-backend's postgres service. Final container: hanoflow-backend-postgres-1, image postgres:18, observed PostgreSQL 18.7, healthy, mapped 127.0.0.1:5434 to 5432/tcp. Persistent mount: hanoflow-backend_postgres-data at /var/lib/postgresql; project network: hanoflow-backend_default.
- Authenticated over the host TCP mapping and verified current database hanoflow, user hanoflow and internal server port 5432. Created only the additive separate logical database hanoflow_test and verified its identity and SELECT 1. Both use the dedicated container; neither uses unrelated host services.
- The same pre-existing listeners remain on ports 5432 (PID 7820) and 5433 (PID 6948). No unrelated PostgreSQL service was stopped, reconfigured or queried by the live tests. The temporary NestJS process used free application port 49291 and was stopped afterward; PostgreSQL was left healthy.

### Quality gates and live acceptance evidence

| Check                                                  | Result                                                 |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Portable runtime and npm child executable              | Passed: Node 24.22.3 / npm 11.19.1                     |
| Locked engines / installed direct dependencies         | Passed: no incompatible declared ranges, npm ls exit 0 |
| Docker Engine / Compose / dedicated port / health      | Passed                                                 |
| Prisma schema validation and client generation         | Passed                                                 |
| Prisma real SELECT 1 / test identity / session timeout | Passed                                                 |
| Offline tests                                          | 4 suites, 39 tests passed                              |
| Real PostgreSQL tests                                  | 1 suite, 4 tests passed, no mocks                      |
| TypeScript / ESLint / formatting / production build    | Passed                                                 |
| Healthy HTTP liveness / readiness                      | 200 / 200                                              |
| Dedicated database stopped: liveness / readiness       | 200 / 503, safe generic response                       |
| Database restarted: liveness / readiness               | 200 / 200, same NestJS PID 14404 throughout            |
| Credentials in HTTP responses or application logs      | None detected                                          |
| Final dedicated container status                       | Healthy on 127.0.0.1:5434                              |
| Existing services                                      | Original listener PIDs unchanged                       |

- Real test initialization and app.close teardown exercised database client creation/cleanup; the test process exited without forced exit or leaked-handle warnings. The outage test restored only HanoFlow's service before stopping the temporary application.
- npm audit reports 18 moderate development findings, zero high/critical findings; npm audit --omit=dev reports zero findings. No audit fix or dependency changes were applied. GitHub Actions was not executed; its updated job remains unverified on GitHub.

### Migration status and remaining concerns

- The Prisma schema still has no models. Migration diff from empty succeeds and returns only an empty-migration comment. No SQL migrations, artificial tables, seeds, baselines or resets were introduced.
- db:migrate:status connects to hanoflow on 5434 and exits 1 with no migrations found/current database not managed by Prisma Migrate. This accurately reflects the intentionally absent initial history, not a connectivity failure. Create the first meaningful migration only when a separately approved schema change exists.
- Non-blocking concerns remain: 18 moderate development audit findings, Jest's ESM experimental VM warning, workstation-specific runtime activation and unexecuted GitHub Actions. All Task 1.2.1 acceptance criteria were verified locally.
- No authentication, tenants, business entities, GraphQL, Redis/BullMQ, frontend changes, data deletion, commits, pushes or Task 1.3 work were performed.

## Task 1.3 - GraphQL and REST API infrastructure (2026-11-25)

### Initial state, runtime and dependencies

- Repository root: D:\HANO LINK PROJECTSSSSS\HanoFlow or HanoShip\hanoflow-backend; branch master. HEAD had no commit and all project files were untracked. Existing files and user work were preserved; no commits, staging, remotes or pushes were created.
- Verified Node 24.22.3 / npm 11.19.1 and process.execPath C:\dev-tools\node24\node.exe before npm commands, activating PATH only inside each command process. System Node 22.17 and permanent PATH remain unchanged.
- Evaluated official Nest GraphQL/Apollo package peers and optional peers before installation. Installed exact stable versions: @nestjs/graphql 14.2.1, @nestjs/apollo 14.2.1, @apollo/server 5.5.2, @as-integrations/express5 1.1.2 and graphql 16.15.0. They support existing Nest 12.6, TypeScript 6, Express 5 and Node 24. No legacy server, federation, optional alternative adapter, forced peers or new overrides were introduced.
- npm ls --depth=0 and the complete npm ls --all tree passed. Checked 825 lockfile entries / 515 engine declarations; no Node/npm incompatibilities. Existing direct framework/database/tool versions were retained.

### Implementation and files

- Added src/infrastructure/graphql/api-graphql.module.ts, graphql.config.ts, graphql-context.ts, graphql-errors.ts, query-limits.ts and query-limits.spec.ts. Apollo serves only /graphql, uses code-first decorators and generates a sorted schema in memory; no SDL artifact/runtime file writes.
- Added src/modules/health/health.resolver.ts. Added shared liveness logic to HealthService and reused it from REST and GraphQL. Updated AppModule and HealthModule wiring; no Prisma schema/business models or production mutations were added.
- Added src/common/http/request-metadata.ts and updated shared setup: server-generated correlation UUIDs, x-request-id response headers, safe structured completion logs and explicit 100 KB body limits.
- Updated the existing exception filter to branch on transport. REST envelopes remain unchanged. GraphQL uses standard data/errors responses, safe codes/messages and request IDs; arbitrary internal extensions, variable values, SQL/credentials and stack traces are removed. Unexpected errors log metadata only.
- Existing validated NODE_ENV determines GraphQL IDE/introspection policy: development only. Test/production disable them. No extra environment variables, hardcoded production URL or deprecated Playground setting was needed.
- Apollo CSRF prevention remains enabled; batching and automatic persisted queries are disabled. Coarse ceilings: 2,000 parse tokens, depth 20 and 500 expanded fields per operation, counting aliases and fragments with cycle termination. A standard full introspection query measured depth 15 / 220 fields; ceilings were adjusted after a new test exposed overly restrictive initial values. Full development tooling and oversized-query tests both pass.
- Added test/graphql.e2e-spec.ts with test-only DTO/resolver fixtures. Updated package.json/package-lock.json for the five required dependencies. No existing tests were removed or weakened. README.md, AGENTS.md, architecture OVERVIEW.md and this file were updated; docs/architecture/API.md was created.

### Verification

| Check                                                           | Result                                           |
| --------------------------------------------------------------- | ------------------------------------------------ |
| Peer/engine compatibility and complete npm tree                 | Passed                                           |
| Prisma validation / client generation                           | Passed                                           |
| Offline unit/application tests                                  | 6 suites, 65 tests passed (39 previous + 26 new) |
| Real PostgreSQL integration tests                               | 1 suite, all 4 tests passed, no mocks            |
| TypeScript / ESLint / formatting / production build             | Passed                                           |
| Deterministic in-memory schema and compiled startup             | Passed                                           |
| Global GraphQL DTO validation / public codes / sanitized errors | Passed                                           |
| Context request / correlation / secret-free logging             | Passed                                           |
| Development full introspection / GraphiQL                       | Passed                                           |
| Production introspection and interactive tooling disabled       | Passed                                           |
| Body/field bounds, CSRF and batching                            | Passed                                           |
| Duplicate/prefixed GraphQL routes absent                        | Passed                                           |

- Compiled production entrypoint live POST /graphql returned HTTP 200 with data.health.status ok. The same running application returned HTTP 200 for /api/v1/health and /api/v1/health/ready against the dedicated PostgreSQL database.
- Live invalid GraphQL documents returned a sanitized/correlated HTTP 400, and production introspection was blocked. A separate temporary launcher injected one health-service exception in memory: the resolver returned HTTP 200 with data null, INTERNAL_SERVER_ERROR and matching correlation ID, without its injected credentials/SQL. The next health query recovered. No production source, schema or endpoint was modified for fault injection.
- Both temporary application processes were stopped; application logs and responses were checked for credential leakage. The existing hanoflow-backend PostgreSQL container remains healthy on 127.0.0.1:5434. No database stop/reset, port change or unrelated service modification was performed in this task.
- Executed package metadata queries, npm install, npm ls, engine checks, Prisma scripts, typecheck/lint/tests/build/format checks, live HTTP requests and audits. A targeted npm update of @graphql-tools/utils made no resolving change. GitHub Actions was not executed; its existing scripts automatically discover the new offline tests.

### Audit and deferred security

- Full audit: 19 findings (18 existing moderate development findings plus 1 new high finding). Production-only audit: 1 high finding, zero other findings.
- The new production advisory is GHSA-c4qx-w738-7hr3, prototype pollution in @graphql-tools/utils mergeIncrementalResult. Apollo 5.5.2 resolves the affected 12.0.1 branch and its declared range excludes patched 12.0.2+. Nest GraphQL separately resolves 12.1.0. A range-compatible update did not resolve the Apollo copy. No forced fix, dependency downgrade or new override was applied, and exploitability of unused paths is not assumed away. Resolve through a reviewed compatible change before deployment.
- Authentication, authorization, trusted tenant scope, schema-aware cost/pagination, rate limits and production exposure policy remain future work. Coarse operation limits are not database-cost protection. The API is not claimed production-secure. Existing Jest experimental VM warnings and the production advisory remain technical debt.
- No system Node/permanent PATH changes, PostgreSQL port/data changes, business entities, authentication, federation, frontend, Redis/BullMQ, commits, pushes or Task 1.4 work were introduced.

## Task 1.3 — Manual Recovery Closure

**Status:** Functionally completed for local development.

**Date:** 25 November 2026

### Verification results

- Dependency configuration restored.
- Backup creation and integrity verification completed.
- Unfinished maintenance work archived outside the repository.
- TypeScript, ESLint, Prettier and build checks passed.
- Prisma schema validation passed.
- Application tests: 65/65 passed.
- PostgreSQL integration tests: 4/4 passed.
- PostgreSQL container healthy.
- Total: 69/69 tests passed.

### Outstanding technical debt

- One high-severity production dependency advisory: GHSA-7mx3-vvmw-hjmv.
- 18 moderate dependency findings.
- Four npm install-script warnings.
- Exact original lockfile restoration is not guaranteed.

The project owner approved temporary local development continuation. Production deployment remains blocked until the outstanding production security advisory is resolved.

### Next task

Task 1.4 — Redis and BullMQ infrastructure.

## Task 1.4.2 - Redis infrastructure (2026-11-25)

### Scope and preflight

- Implemented only the owner-approved Redis subtask. Backend root verified using
  Git. Portable Node 24.22.3/npm 11.19.1 and process.execPath verified with
  process-local PATH; system Node/permanent PATH unchanged.
- Before changes, npm ls --depth=0 passed; audit reported 18 moderate development
  findings and one high production finding. Current advisory is
  GHSA-7mx3-vvmw-hjmv (GraphQL Tools mergeDeep), confirming the recovery closure;
  older Task 1.3 advisory descriptions remain preserved as historical records.
- Docker inventory showed only healthy HanoFlow PostgreSQL and exited hello-world.
  Port 6380 had no listener. Docker/registry checks required elevated execution.

### Implementation

- Installed exact runtime ioredis 6.1.0 with scripts disabled for this additive
  installation. Added five lockfile entries. Compared every existing lockfile
  package version against the pre-install snapshot: none changed. Existing
  package constraints and Prisma Effect 3.22.1 override retained.
- Added compose Redis service: redis:8.2.11-bookworm, 127.0.0.1:6380 -> 6379,
  dedicated hanoflow-backend_redis-data at /data, AOF yes/everysec, maxmemory
  268435456 bytes, noeviction, PING health check, 30s stop grace. No restart
  policy, matching PostgreSQL. Started only Redis with --no-deps.
- Added non-global RedisModule, private lazy-client DI provider, typed URL/probe
  configuration, RedisService and unit tests. Initial connection wait bounded at
  2s, PING at 1s; no offline queuing/replay or command retries. Jittered automatic
  reconnect capped at 5s. Safe transition-only logging and immediate read-only
  probe disconnect on shutdown. No queue or cache operations.
- Added required REDIS_URL and QUEUE_PREFIX validation; updated .env.example and
  appended missing Redis settings to ignored local .env without replacing existing
  credential values. REDIS_PORT is Compose-only; prefix hanoflow-dev is validated
  but unused. Explicit database indexes 0–15 are supported; URL options/fragments
  are rejected rather than passed through to ioredis.
- HealthModule explicitly imports RedisModule. Readiness probes PostgreSQL and
  Redis concurrently and adds redis: up on success. Either failure returns safe 503. REST liveness and GraphQL schema/liveness remain unchanged.
- Updated offline HTTP/GraphQL fixtures and PostgreSQL suite fixtures. The four
  database tests retain real Prisma, target guard and separate hanoflow_test;
  only Redis is overridden. No default test contacts Redis.

### Verification

| Check                                                  | Result                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| Existing locked dependency versions / Prisma override  | Preserved                                          |
| Dependency tree after install                          | Passed                                             |
| TypeScript / ESLint                                    | Passed                                             |
| Application tests                                      | 8 suites, 97 tests passed (65 existing + 32 added) |
| Real PostgreSQL integration                            | 1 suite, 4 tests passed                            |
| Production build / Prisma validation                   | Passed                                             |
| Redis PING / settings / health / volume / loopback     | Passed                                             |
| Compiled dist/main.js REST liveness                    | 200, status ok                                     |
| Compiled REST readiness with real PostgreSQL and Redis | 200, status ok/database up/redis up                |
| Compiled production GraphQL health                     | 200, data.health.status ok                         |
| Real compiled Nest init/app.close lifecycle            | Passed                                             |
| Captured compiled application logs                     | No configured secret values detected               |

- First checks exposed test-only lint/type issues and a fake-timer assertion
  affected by workstation Console Ninja instrumentation. Corrected spy typing and
  excluded nextTick/setImmediate from fake timers; no behavior tests removed.
- Full audit after installation: unchanged 19 findings (18 moderate, 1 high).
  Production audit: unchanged 1 high, zero other findings. No audit fixes applied.
- Both containers left healthy; PostgreSQL was not restarted, reconfigured or
  modified. Temporary application processes were stopped and verification
  launchers removed. Windows native signal delivery was not separately verified;
  explicit real app.close and unit lifecycle cleanup were verified.
- Automated real Redis outage/restart/persistence recovery remains Task 1.4.4;
  only offline failure/recovery and healthy live connectivity were exercised.
  GitHub Actions was not run. Existing Jest experimental VM warning remains.

Final Prettier formatting check passed. The original package manifest is identical
apart from the approved ioredis addition; every pre-existing lockfile package entry
is unchanged, including metadata. Redis reports version 8.2.11, AOF enabled and
successful AOF write/rewrite status. PostgreSQL's original start time and binding
were preserved. Final compiled healthy checks and app.close passed after review.

### Boundaries and next task

No decisions beyond approved infrastructure scope. Probe-only immediate disconnect
is appropriate because there are no writes to drain. BullMQ and @nestjs/bullmq
were not installed; no workers, queues, business models, migrations, authentication,
tenant features, data deletion, commits, staging, pushes or deployment occurred.
Production remains blocked by the existing high advisory. Task 1.4.3 has not
started; await owner review and explicit approval.

## Task 1.4.3 - BullMQ integration and worker foundation (2026-11-25)

### Authorization, baseline and dependencies

- Implemented only the approved Task 1.4.3. Read current guidance, README, progress,
  API/overview/Redis architecture and approved Task 1.4.1 conversation plan.
- Verified Git repository root, portable Node 24.22.3/npm 11.19.1 and executable
  path through process-local PATH. No system runtime or permanent PATH change.
- PostgreSQL and Redis healthy before/after; original container start times and
  bindings preserved. No isolated Redis test container/listener on port 6381.
- Registry peers explicitly accept Nest 12, BullMQ 6 and ioredis >=5. Node engine
  checks accept the existing Node 24 runtime. Installed exactly bullmq 6.7.10 and
  @nestjs/bullmq 12.0.2 with scripts disabled. Existing ioredis remains 6.1.0.
- Installation added 13 packages on this platform and 18 lockfile entries,
  including optional platform packages. Compared all original package versions:
  none changed. Existing manifest constraints and Prisma Effect override preserved.
  Some existing dev-only dependency metadata now reflects production reachability;
  no package version was upgraded. New declared Node/npm engines are compatible.
- npm ls --depth=0 and full npm ls --all passed. Baseline and final audit both
  report 18 moderate development findings plus one high production finding.
  Production-only audit remains one high: GHSA-7mx3-vvmw-hjmv. No fixes/overrides.
- New install warning: transitive node-abort-controller 3.1.1 is deprecated because
  supported Node versions supply AbortController. No replacement was forced.

### Implementation and decisions

- Added queues.module.ts, queue.config.ts, queue.constants.ts, owned-redis.ts,
  queue-runtime.service.ts and associated tests under src/infrastructure/queues.
  AppModule explicitly imports QueuesModule. Root configuration creates no
  producer, worker, job or queue Redis connection.
- Native BullModule.registerQueueAsync supplies injectable typed Queue providers.
  QueuesModule.registerWorker registers DI-owned processor classes through a
  shared non-global core/runtime rather than upstream unbounded WorkerHost close.
  Optional explicit dependency-module imports support future application services.
  Approved upstream internal global/configuration exception is documented;
  HanoFlow modules remain non-global. No global constructor/client-factory mutation.
- Existing REDIS_URL/QUEUE_PREFIX are reused. Producer commands have 2s connect
  and publication budgets, zero command retries, no offline buffering/replay.
  Workers use independent original/blocking connections, maxRetriesPerRequest
  null, no short command timeout and jittered reconnect capped at 5s.
- Defaults: 3 attempts, exponential backoff from 1000ms, concurrency 1, completion
  retention 86400s/1000 jobs and failure retention 604800s/5000 jobs. BullMQ prefix
  is used, never ioredis keyPrefix. Queue/job names are validated/versioned.
- Shared lifecycle rejects publication, pauses workers, drains active jobs up to
  29s and reserves the remaining second of a single 30s budget for cleanup.
  Calls worker.close(true) only after managed drain, then closes native queues.
  Finally aborts cooperative signals and disconnects all owned originals/duplicates.
  Shutdown is idempotent; error/timeout cleanup does not merely leave reconnecting
  clients behind. Root queue-module teardown precedes deeper persistence teardown.
- Safe logs include resource/queue, allowlisted job/operation, attemptsMade,
  duration when observed and UUID correlation metadata. Raw errors, job payloads,
  results and credentials are omitted. No identity/tenant authorization inferred.
- Added test-only InfrastructureQueueModule and InfrastructureProcessor outside
  production compilation. A nonce payload returns deterministic verified true;
  optional failUntilAttempt supports controlled failures before the third attempt.
  No enqueue endpoint or GraphQL mutation. GraphQL offline config fixture includes
  existing Redis/prefix fields for the new root config provider.
- Supporting runtime/ownership files and the managed worker registration convention
  adapt the proposed structure to enforce deadlines; no scope expansion.

### Actual verification

| Check                                               | Result                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| Dependency peers/tree/new engines/existing versions | Passed/preserved                                     |
| TypeScript / ESLint                                 | Passed                                               |
| Application tests                                   | 12 suites, 140 tests passed (97 previous + 43 added) |
| Real PostgreSQL integration                         | 1 suite, 4 tests passed; real Prisma/guard preserved |
| Production build / Prisma validation                | Passed                                               |
| Compiled dist/main.js REST liveness                 | 200, status ok                                       |
| Compiled REST readiness, live PostgreSQL + Redis    | 200, database up and redis up                        |
| Compiled production GraphQL health                  | 200, unchanged data.health.status ok                 |
| Compiled Nest init/app.close                        | Passed, no queues registered                         |
| Captured compiled application logs                  | No configured secret values detected                 |
| Final audit                                         | Unchanged: 18 moderate / 1 high / 0 critical         |

- New tests cover configuration/defaults, prefixes/names, policy separation,
  publication deadlines, safe errors/logs, original/blocking duplicate cleanup,
  drain/forced shutdown, idempotency, root-before-persistence hook ordering and
  explicit Nest producer/processor registration using overrides.
- Processor result/retry contract was tested by direct offline invocation. Native
  Queue/Worker execution, Redis job persistence and BullMQ retry scheduling were
  not executed and are not claimed passed. No isolated test Redis environment exists.
- Implementation checks initially exposed test-only literal typing/lint issues and
  ioredis/BullMQ option declaration differences. Narrowed the option allowlist and
  explicitly retained legacy replies without casts, version changes or suppressions.
  Final strict checks passed. Existing Jest experimental VM and Console Ninja
  instrumentation output remain; no configuration changes were made for them.
- Existing REST/GraphQL, Redis readiness implementation, PostgreSQL, environment
  validation and structured logging were preserved. No container was started,
  stopped, modified or recreated. Temporary verification launcher was removed.

Final Prettier formatting check passed. The final 140 application tests plus four
real PostgreSQL tests total 144 passing tests. Both containers retained their
original start times and loopback bindings. Production dist contains no test-only
queue/processor fixtures. All original manifest fields are unchanged apart from
the two exact approved dependency additions.

### Remaining work and boundaries

Task 1.4.4 must establish a guarded isolated Redis instance on loopback port 6381,
verify instance identity and per-run prefixes before constructing real queues,
then verify enqueue/execution/retry timing, outage/recovery, persistence, real
shutdown and CI. No real test jobs were executed against development Redis.
This task did not create that environment or a real queue suite. GitHub Actions
and native Windows signal delivery were not executed.

Timeouts can have ambiguous enqueue outcomes. Future business processors must be
idempotent, honor AbortSignal and bound external I/O; JavaScript cannot terminate
arbitrary non-cooperative callbacks. Retention is lazy, not a backlog capacity cap.
Production remains blocked by the unchanged advisory and exposure/security work.

No business queues/operations, models/migrations, authentication/authorization,
multi-tenancy, caching, notifications, outbox, dependency upgrades, forced peers,
new overrides, staging, commits, pushes or deployment. Task 1.4.4 has not started;
await owner review and explicit approval.

## Task 1.4.4 - Real Redis/BullMQ integration and foundation closure (2026-11-25)

### Scope, environment and isolation

- Read current AGENTS, README, progress, Redis/queue/overview/API architecture,
  source lifecycle, test fixtures and CI conventions. Verified backend root,
  portable Node 24.22.3/npm 11.19.1/process.execPath. Existing PostgreSQL and
  development Redis were healthy; port 6381 had no listener before setup.
- No dependencies installed or upgraded. The lockfile and all existing dependency
  configuration/Prisma override remain unchanged. Added only npm test/setup scripts.
- Added compose.redis-test.yaml: independent hanoflow-redis-test project/service
  redis-test, redis:8.2.11-bookworm, 127.0.0.1:6381 -> 6379, own persistent
  hanoflow-redis-test_redis-test-data at /data, AOF everysec, 256MiB/noeviction,
  PING health check and 30s stop grace. Existing development services untouched.
- scripts/redis-test.mjs creates ignored .env.redis-test only if absent, validates
  fixed endpoint/UUID, checks container project/service/image/volume/binding and
  environment identity, and provisions a marker with SET NX without overwriting.
  Lifecycle actions additionally enforce the previously verified exact container ID.
- Added test/helpers/redis-target.ts, offline guards, real Jest configuration,
  setup-redis-env.ts and queues.redis-spec.ts. Explicit TEST_REDIS_URL has no
  REDIS_URL fallback. Every queue prefix is unique to run/application; cleanup
  verifies identity and unlinks only current-run prefixes, never global databases.
- Real Redis tests use AppModule and test-only fixtures, substituting PostgreSQL
  only. Four real PostgreSQL tests retain actual Prisma and their target guard.
  Default application tests remain independent of live infrastructure.

### Corrections and implementation details

- Extended only test fixtures with permanent failure and held/released/cancelled
  job controls. Production compilation contains no fixtures or test endpoints.
- Added prefix/role connection names to make owned-client cleanup observable.
- Initial real-suite iteration failed due to harness use of removed Queue.client
  and protected closure properties. Corrected tests to use public BullMQ 6 backend
  APIs and observable Redis client inventories. No library internals were patched.
- Subsequent full suite passed 10/11 checks but exposed cold-start queue recovery:
  BullMQ cached the first connect rejection from an untouched lazy client, even
  though ioredis later reconnected. Narrow correction: attach safe listeners, start
  each owned connection without awaiting it, then hand an already-connecting client
  to BullMQ. Its initialization now waits for ready/end across reconnects.
  Added an offline ordering regression; the real cold-start recovery case passed
  on the same application after correction. No architecture/dependency changes.
- All marker/container checks precede queue creation or lifecycle operations;
  deliberately unavailable startup retains identity verified immediately before
  stopping that exact test container. No arbitrary instance adoption.
- Added a separate Redis GitHub Actions job using the same pinned Compose setup
  and guarded npm lifecycle commands. Existing application/database jobs preserved.
  GitHub Actions was not executed; local configuration validation is separate.

### Verification record

| Check                                               | Final result                            | Reported test duration    |
| --------------------------------------------------- | --------------------------------------- | ------------------------- |
| Offline application/unit/HTTP/GraphQL               | 13 suites, 155/155 passed               | 10.705s                   |
| Real PostgreSQL                                     | 1 suite, 4/4 passed                     | 3.925s                    |
| Real Redis/BullMQ                                   | 1 suite, 11/11 passed, no skipped tests | 64.386s                   |
| Combined                                            | 15 suites, 170/170 passed               | Per-suite durations above |
| TypeScript / ESLint                                 | Passed                                  | —                         |
| Production build / Prisma validation                | Passed                                  | —                         |
| Dependency tree                                     | Passed, no problems                     | —                         |
| Lockfile / dependency constraints / Prisma override | Unchanged                               | —                         |
| Workflow YAML/jobs/always cleanup / Compose config  | Locally validated                       | —                         |
| Compiled production REST liveness/readiness         | 200 / 200, unchanged contracts          | —                         |
| Compiled production GraphQL health                  | 200, data.health.status ok              | —                         |
| Real compiled init/app.close                        | Passed                                  | —                         |
| Captured compiled logs                              | No configured secret values detected    | —                         |

- All original 144 tests/coverage preserved. Added 14 offline target-guard cases,
  one offline cold-start ordering regression and 11 real Redis/BullMQ cases.
- Real successful publication, waiting/active/completed transitions, deterministic
  return value and correlation persistence passed. Identical job IDs remained
  independent across prefixes, including after cleaning one prefix.
- Two controlled failures followed by success passed with final observed gaps of
  1017ms and 2014ms. Terminal failure stopped after exactly three real attempts.
- Liveness and GraphQL health stayed 200 during isolated Redis outage; readiness
  returned safe 503. Producers failed within budget. Existing workers/readiness
  reconnected; cold-start initialization while unavailable recovered on the same
  app after the correction. Only the isolated container was controlled.
- A paused waiting job and instance marker survived a normal Redis restart and
  processed successfully afterward. This does not claim crash/power-loss testing.
- Active work drained on release; new publication was rejected during shutdown.
  The real deadline/cancellation case took 29022ms, within the 30s budget and test
  scheduling tolerance. Real shutdown while Redis was unavailable also passed.
  Worker/queue connections closed and inventories returned to one test observer
  after every case. Jest exited normally with detectOpenHandles and no leaked-
  handle warning or forced exit.
- A mismatched marker was rejected and a deliberately wrong container ID could
  not stop Redis. Cleanup left only the identity marker (DBSIZE 1) in the isolated
  instance. No infrastructure-verification keys were found in development Redis.
- Final full audit is unchanged: 18 moderate, one high, zero critical. Existing
  production GraphQL Tools advisory GHSA-7mx3-vvmw-hjmv remains unresolved.
- PostgreSQL start time remained 2026-11-25T12:12:17.353549675Z; development Redis
  remained 2026-11-25T15:12:48.942612454Z, with healthy original loopback bindings
  5434/6380. The independent test Redis is left healthy on 6381 with storage intact.
- Initial API-mismatch harness failures and the subsequent 10-pass/1-fail cold-start
  run are documented above. The corrected cold-start focused regression passed,
  followed by the unfiltered 11/11 final suite. A temporary CI validator initially
  referenced unavailable npm yaml; used pre-existing Python PyYAML instead without
  installing anything. Intermittent sandbox launcher failures required elevated
  execution; no unrelated process/service or permanent system setting was changed.

### Foundation closure and limitations

Phase 1 is functionally complete for local development only after all local
acceptance checks passed. Final Prettier formatting and lifecycle-tool syntax
verification passed.
GitHub Actions execution and native Windows signal delivery were not performed.
Normal AOF restart persistence is verified; abrupt crash/power-loss durability,
production HA/capacity/backups/security remain outside this task. Cancellation is
cooperative; future business handlers require bounded I/O and idempotency.

Updated README, AGENTS, Redis/queue/overview architecture and new TESTING.md with
setup, identity, commands, CI and verification boundaries. No extra dependencies,
version upgrades/overrides, business features/queues, authentication/authorization,
tenant logic, schema/migrations, caching, notifications, outbox, volume deletion,
Git staging/commits/pushes or deployments. Phase 2 has not started. Stop for owner
review and explicit approval of any next implementation scope.

## Task 2.2 — Core identity schema and first migration (2026-11-26)

### Authorization and pre-implementation review

- Owner accepted Task 2.1 architecture and explicitly authorized only Task 2.2.
  Both platform-controlled and self-service onboarding are approved directions.
  The earlier Docker-unavailable review stopped before implementation; owner
  started the existing services and explicitly resumed this task.
- Re-read the full Task 2.2 attachment, AGENTS, README, progress, architecture,
  Prisma/configuration, DatabaseModule/PrismaService, target guards, real tests,
  Compose, manifest/lock and CI. Repository hanoflow-backend, clean initial tree,
  branch feature/phase-2-identity, HEAD b1b23c0 were verified.
- Portable runtime verified: Node 24.22.3, npm 11.19.1,
  C:\dev-tools\node24\node.exe; process-local PATH only. Dependencies/Prisma override
  unchanged. No installation, upgrade, shadow database or new privilege request.
- Docker inspections found the original PostgreSQL/Redis/test Redis healthy on
  loopback 5434/6380/6381. Existing PG services on 5432/5433 were untouched.
- Before writing schema, read-only transactions inspected BOTH actual databases:
  hanoflow and hanoflow_test, user hanoflow, PostgreSQL 18.7, public schema, UTC,
  en_US.utf8 locale, UTF8 Unicode collation support. Catalog inventory found no
  non-system relations, migration table, enums, public routines/domains or data.
  Only public schema and the standard plpgsql extension existed. No conflicts or
  drift were found. URL guards ran before connecting; deployment additionally
  required exact 127.0.0.1:5434, expected database and only schema=public options.

### Implemented schema and technical decisions

- Four models only: global User, company Tenant, Membership and minimum AuditEvent.
  Native UUIDv4 comes from PostgreSQL gen_random_uuid() for Prisma and direct SQL;
  timestamptz(3) stores instants. Prisma maintains updatedAt on Prisma writes;
  direct SQL writers must do so explicitly. No extension/trigger was introduced.
- User/tenant begin PENDING. All approved lifecycle states are native enums.
  Canonical email remains unique after deactivation; slugs remain unique after
  closure. No email/slug reuse or release policy/workflow was silently added.
- Display email is preserved; canonical email trims exact outer ASCII whitespace
  then uses PostgreSQL 18 pg_unicode_fast Unicode full lowercasing. C collation
  provides byte-exact validation/uniqueness independent of cluster locale/ICU.
  SQL rejects blank/mismatched canonical values. No provider-specific rewriting,
  ownership verification, full syntax validator or SMTP policy was added.
- Slug is 1–100 lowercase ASCII alphanumeric characters with single hyphen
  separators; name is bounded and nonblank. Limits and normalization are technical
  defaults within approved scope; no onboarding policy or owner field exists.
- Membership unique (tenantId,userId), unique (tenantId,id), user/status and
  tenant/status/id indexes. REMOVED iff removedAt exists; removal cannot predate
  first joinedAt. Future reactivation must reuse the row, clear removedAt and
  audit the transition; no workflow or automatic audit writer exists now.
- Audit scopes PLATFORM/TENANT express namespace, null actor expresses a system
  event in either namespace; scope and tenant presence must agree. Outcomes are
  SUCCESS/FAILURE/DENIED. Correlation UUID persists; target identifier may be null
  when no target exists. Bounded metadata accepts only an object up to 4096 bytes
  in PostgreSQL JSONB text representation. Future writers require per-action safe
  allowlists/redaction; shape/size cannot recognize secrets. No public writer.
- Four FKs all restrict delete/update, preserving identity references/history.
  Audit has no updatedAt; append-only permissions are NOT implemented. No RLS,
  roles, credentials, owner invariants or complete tenant-isolation claim.
- Detailed field/index/check definitions, ER diagram, deferred product policies,
  future requirements and migration/Studio instructions are in IDENTITY.md.

### Migration safety and deployment sequence

- Created 20261126190000_core_identity with installed Prisma migrate diff
  --from-empty --to-schema prisma/schema.prisma --script, without a datasource or
  shadow database. Reviewed all SQL before application: only four tables, five
  enums, thirteen identity indexes including primary keys, four FKs and eight
  SQL-only CHECK constraints. Added canonical column C collation and transactional
  BEGIN/COMMIT. No DROP, reset, db push, extension/role changes or existing data
  deletion. Preserve this reviewed applied SQL unchanged.
- Initial stricter temporary URL check refused existing schema=public before
  connecting/deploying; allowlisted only that known option after review. An inline
  PowerShell/Node quoting error affected a read-only diagnostic, corrected using
  a temporary script. Neither event changed database state.
- Guarded hanoflow_test migration succeeded first; status up to date, Prisma diff
  empty. All 46 real DB tests passed before development application. Rechecked
  development still empty, then deployed identical SQL; status up to date and
  Prisma diff empty. No new credentials, privileges or shadow database required.
- Both migration records finished successfully with no rollback and identical SHA256
  2c83680416255de3c430b30238525fc9b02b4dfedf96006e245cec3ccfb93bda.
  Final exact row counts in User/Tenant/Membership/AuditEvent are 0 in BOTH databases;
  all owned test fixtures were removed, migration records retained.

### Actual verification

| Command/check                                                                                       | Actual result                                                     | Reported test duration    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| npm test                                                                                            | 13 suites, 155/155 passed, original coverage retained             | 18.567s                   |
| npm run test:db                                                                                     | 2 suites, 46/46 passed (4 original + 42 new)                      | 38.955s                   |
| npm run test:redis                                                                                  | 1 suite, 11/11 passed, normal exit with detectOpenHandles         | 60.982s                   |
| Total                                                                                               | 16 suites, 212/212 passed, no skipped tests                       | Per-layer durations above |
| npm run db:format / db:validate / db:generate                                                       | Passed; client 7.10.1 generated into ignored src/generated/prisma | —                         |
| npm run typecheck / lint / build                                                                    | Passed                                                            | —                         |
| npm ls --all --json                                                                                 | Passed, consistent dependency tree                                | —                         |
| db:migrate:deploy / status (test, then development)                                                 | Both succeeded, up to date                                        | —                         |
| Installed Prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | Both targets exit 0, no difference                                | —                         |
| Compiled production AppModule/bootstrap setup                                                       | Initialized/listened on ephemeral loopback, closed normally       | —                         |
| Compiled REST health / readiness                                                                    | HTTP 200 / 200; real PostgreSQL and Redis up                      | —                         |
| Compiled GraphQL health                                                                             | HTTP 200, data.health.status ok                                   | —                         |
| Package/lock preservation                                                                           | SHA256 identical to pre-implementation snapshots                  | —                         |

The 42 new real tests cover UUID defaults including direct SQL, Unicode/trim email,
duplicate/inconsistent addresses, all lifecycle values/invalid enums, tenant slug
constraints, many-to-many relationships, duplicate/FK/composite references,
removal chronology and same-row reactivation support, unrelated lifecycle
preservation, audit scope/correlation/optional actor/history/metadata, exact
migration checksum and expected tables/checks/indexes/collation. Cleanup uses only
allocated UUIDs; one direct SQL fixture is rolled back in its own transaction.
No offline test duplicates database constraints; original offline guards remain.

Real Redis regression observed retry gaps 1006ms/2020ms and active shutdown budget
29018ms. Only the verified test container was stopped/restarted by existing tests;
it was restored healthy and marker identity verified afterward. Development PG
start time remained 2026-11-26T18:03:22.348485469Z; development Redis remained
2026-11-26T18:03:22.110054088Z. All original bindings and volumes remain intact.
No development jobs were published. Compiled smoke used real development
dependencies, ephemeral loopback HTTP and normal app.close, without public models.

Final `npm run format:check` and `git diff --check` passed. Temporary scripts were
removed, generated/build files remain ignored, and the Git staging area is empty.

### Files, CI and handoff

- Created prisma/migrations/20261126190000_core_identity/migration.sql,
  test/identity.database-spec.ts and docs/architecture/IDENTITY.md.
- Updated prisma/schema.prisma, README.md, AGENTS.md, architecture DATABASE.md and
  OVERVIEW.md, development TESTING.md and this progress record.
- CI change is limited to setting DATABASE_URL to TEST_DATABASE_URL for the
  existing database migration step. Previously it migrated hanoflow while tests
  queried hanoflow_test. Other jobs/checks remain intact. GitHub Actions was NOT
  executed by this agent; owner-reported earlier success remains separate evidence.
- Temporary safety/smoke scripts are removed before handoff. Generated client and
  compiled output stay ignored. No manifest/lock/override, Compose, runtime module,
  target-guard or existing test changes. Existing security advisory and production
  deployment restrictions remain; resolving them requires separate approval.
- Future requirements: credentials/authentication and opaque sessions, RBAC and
  multi-owner invariant, both onboarding workflows, trusted tenant context and
  staged RLS before tenant APIs, retention/anonymization/email and slug reuse
  policies, audit writer/allowlists/immutability and reviewed PostgreSQL upgrades.
- Manual checks: activate Node24, db:validate/generate/typecheck, npm test,
  test:db with original distinct guarded URLs, redis:test:inspect/test:redis, build,
  and existing health queries. Optional Studio instructions are in IDENTITY.md;
  Studio can modify data, so inspect only and verify its listener is loopback.
- No Git staging, commits, pushes, merges or deployments. No Task 2.3 work started.
  Recommend owner review of Task 2.2 before separately specifying/authorizing 2.3.
