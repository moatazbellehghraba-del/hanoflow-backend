# HanoFlow backend instructions

## Restricted database access — Task 2.6

Nest loads only .env.runtime; never import dotenv/config or Compose .env into runtime
code. Migration CLI loads .env.migrations or explicit HANOFLOW_MIGRATION_ENV and
requires DATABASE_MIGRATION_URL, with no privileged fallback. Test runtime loads
.env.test-runtime; only the explicit fixture helper/tool reads .env.test-fixture.
Keep all real credentials ignored and out of logs/process environments that do not
need them. Preserve the existing Compose/admin .env and administration password.

All twelve application tables now ENABLE/FORCE RLS. Preserve the four original
migrations and the applied fifth migration. Never alter applied SQL or disable RLS
to make tests pass. Use the restricted PrismaService singleton, identity verification
and same-transaction session/tenant context; do not construct feature clients or
set authority from headers/DTOs. Keep explicit tenant predicates, RBAC proof/current
checks, composite constraints and existing lock ordering/timeouts. User/Tenant IDs
are immutable through SECURITY INVOKER triggers despite lock-enabling UPDATE(id).
Do not add SECURITY DEFINER functions or broaden grants without separate approval.

Schema/credential fixtures use the isolated test client; application services never
receive it. Cleanup only run-owned IDs. Preserve privilege/policy/PID-reuse tests and
all prior test intent. Bootstrap is a separate controlled process, not normal runtime
authority. See docs/architecture/RLS.md for exact roles, policies, commands, recovery,
fresh-target prerequisites and the custom-setting threat-model limitation.

## Project and scope

HanoFlow is HanoLink's B2B multi-tenant delivery management SaaS. Its product name may change; keep branding in configuration and out of domain logic. This standalone repository contains the backend only. Update docs/development/PROGRESS.md after every task with changes, verification, decisions, issues, and the next task. Do not claim planned features are implemented.

## Stack

NestJS 12, strict TypeScript, npm, Node 24 LTS, Jest, ESLint, Prettier, Docker and GitHub Actions. PostgreSQL 18/Prisma 7 and code-first GraphQL/Apollo with versioned REST are implemented. Redis connectivity/readiness is implemented. BullMQ queue/worker infrastructure is implemented in Task 1.4.3 without production queues or workers. Authentication and business entities remain planned; introduce them only in separately authorized tasks.

## Architecture and modules

Use a modular monolith, not microservices. Feature modules live in src/modules/<feature>. Infrastructure adapters live in src/infrastructure; cross-cutting HTTP concerns in src/common; environment setup in src/config. Keep controllers thin; put use cases in injectable services when business logic exists. Import another module's public exports; never reach into its private persistence or providers. Do not create speculative abstractions or generic base repositories.

## Coding and dependency injection

Use strict types; avoid any, non-null assertions and unchecked casts. ESM relative imports end in .js. Use constructor injection and Nest provider tokens for interfaces; never instantiate application services manually or use global service locators. Prefer explicit module imports and exports. Only configuration is global by design, with the owner-approved narrow exception for upstream BullMQ internal core/configuration modules. HanoFlow-owned modules must remain non-global. Keep dependencies minimal, reviewed, and locked in package-lock.json. Use npm ci in CI.

## HTTP and security

GraphQL lives only at /graphql, independent of REST /api/v1. Keep resolvers/controllers thin and reuse shared application services. Schema generation is sorted and in memory; do not add runtime file writes or production verification mutations. Every GraphQL DTO needs explicit type decorators and class-validator constraints where applicable. Shared filters/interceptors must check transport before accessing HTTP objects.

Use typed GraphQL context with the request and server-assigned correlation ID; do not fabricate identity or trust client tenant headers. Preserve public machine codes while sanitizing messages/extensions; never return stack traces, raw driver errors or variable values. Keep GraphiQL/introspection disabled outside development and retain body/token/depth/field, batching and CSRF protections. Review cost/rate/authentication/tenant controls with real use cases before exposure. Correlation is not authorization. Resolve the documented production GraphQL Tools advisory through a reviewed compatible change; do not silently add overrides or force peer resolution.

Keep external REST under /api/v1 and apply shared setup to runtime and tests. Request DTOs must use validation decorators; the global ValidationPipe transforms DTOs, strips/rejects unknown fields and omits target/value from validation errors. Do not expose stack traces, secrets, raw configuration or credentials in errors/logs. Validate environment at startup. Do not log request bodies, authorization headers or query strings. Never commit .env or keys. Apply authorization and rate limiting when those features are introduced; never trust tenant IDs supplied by a caller.

## Tenant isolation (planned)

Resolve tenant context from authenticated trusted identity. Scope every tenant-owned read, write, join, background job, cache key, unique constraint and integration to that context. Test cross-tenant access denial, including indirect object references. Platform administration requires explicit separate authorization; never bypass isolation implicitly. Document any deliberate platform-wide access.

## Database and financial integrity (planned)

Use the exported singleton PrismaService through DatabaseModule; never create extra clients in feature code or expose Prisma through controllers. The Prisma 7 ESM client is generated into src/generated/prisma; do not edit or commit generated code. Use prisma.config.ts for CLI connection configuration and the PostgreSQL driver adapter at runtime. Keep CLI, client and adapter on compatible stable major versions; do not follow a prerelease latest tag blindly.

Commit reviewed migrations and migration_lock.toml. Use db:migrate:dev only on disposable development databases; cancel any reset prompt unless reset is explicitly authorized. Use db:migrate:deploy in a controlled release step, never in application startup. Do not replace migration history with db push or delete volumes/data. Task 2.2 introduces the first migration, 20261126190000_core_identity. Preserve its SQL-only checks and canonical-email collation; never edit applied history. No shadow database or new privileges were used or authorized for this task.

The design is a shared PostgreSQL database with tenant-scoped records. Tasks 2.2/2.3 implement User, Tenant, Membership, minimum AuditEvent and PasswordCredential persistence. Follow docs/architecture/IDENTITY.md for UUIDv4, Unicode email normalization, lifecycle invariants, restricted FKs and future composite references. Both controlled and self-service onboarding are approved directions; no workflows exist. Task 2.5 adds internal tenant RBAC and service-enforced owner protection. Public authentication workflows and RLS remain unimplemented. Do not expose tenant-data APIs before dedicated access/isolation work. Enforce constraints in the database; wrap related writes in transactions with deliberate isolation/concurrency control. Do not use floating point for money; use integer minor units or exact decimals with explicit currency and rounding. COD, settlements and reconciliation require auditable records, idempotent processing and protection from duplicate/concurrent postings. Use transactional outbox patterns when atomic database and event consistency becomes necessary.

Keep /health and GraphQL health as dependency-free liveness; /health/ready must query PostgreSQL and Redis and return a safe 503 on either failure. Missing/malformed DATABASE_URL fails startup; an unreachable database leaves the process live but unready. Never log connection strings or raw driver errors. Use TEST_DATABASE_URL for the separate real database suite; do not mock that suite or silently skip it when PostgreSQL is unavailable. Default unit/HTTP tests must remain independent of PostgreSQL and Redis. Override both RedisService and its private REDIS_PROBE_CLIENT provider. The real PostgreSQL suite overrides Redis only and must retain real Prisma connectivity.

## Verification and change management

For this workstation, the existing portable Node 24 runtime is C:\dev-tools\node24. Prepend it to process-local PATH in every independent PowerShell execution before npm commands; verify node/npm versions and process.execPath rather than assuming IDE terminal inheritance. Preserve system Node 22 and permanent PATH. Do not put this workstation path into application code, package engines, npm scripts or CI.

HanoFlow's local PostgreSQL host port defaults to 5434, bound only to 127.0.0.1, with internal port 5432. Existing host services on 5432/5433 are unrelated; never stop or reconfigure them. Preserve local .env secrets. Real integration tests require a distinct hanoflow_test database and enforce loopback, the dedicated port and matching user before connecting. Do not weaken that guard or mock the real suite to obtain passing tests. Restore only HanoFlow's database to a healthy state after outage tests. No dependency version changes without demonstrated need and explicit approval.

Add focused Jest tests for changed behavior; keep unit tests beside source and HTTP integration tests in test/. Use shared application setup so tests enforce runtime conventions. Run npm run format:check, npm run lint, npm run typecheck, npm test and npm run build. For database changes also run db:validate, db:generate and test:db against a dedicated PostgreSQL database when available. Verify startup/health for bootstrap changes. Record failures or unavailable commands accurately. No automatic commits, pushes, remote creation or deployments. Inspect existing code before editing. Stop at the authorized task boundary.

## Password credential foundation

Task 2.3 adds PasswordCredential with userId as its UUID shared primary key,
restricted User FK, encoded passwordHash and separate passwordChangedAt/updatedAt.
Never expose/hash-log credential models or include them in audit metadata. Use the
non-global IdentityModule exports PasswordPolicy/PasswordHasher; keep native engine
and capacity private. Fixed Argon2id profile is 65536 KiB / 3 / 1 / 32 bytes, v19,
library-generated salt, argon2 exactly 0.45.2. Preserve bounded native admission
(one active, two waiting, 1s waiting deadline), PHC verification bounds and safe
operational errors. Never weaken costs for tests or release a slot before native
work ends. Hash outside DB transactions. No public credential workflows exist.
Compromised-password screening remains unimplemented and required for production.
No npm script permission was granted; native prebuilt loading worked under existing
protections. Stop before new build permissions/toolchains. See PASSWORDS.md for
Unicode, legacy verification, rehash compare-and-swap and benchmark limitations.

## Sessions foundation

Task 2.4 adds non-global SessionsModule with only internal SessionsService exported;
AuditModule owns its narrow transactional writer. No Identity/Sessions cycle,
public authentication endpoints, guards, transports or elevated scope.
Require ACTIVE user + verified email from current database state. PostgreSQL owns
all session/token state; never use Redis as authority. Tokens are 32 random bytes,
purpose-prefixed canonical Base64URL, SHA256 digests only in storage. Never log,
export or audit raw tokens/digests. Only committed issuance results carry secrets.
Preserve User -> Session -> RefreshToken lock order and shared validation locks,
750ms lock timeout, bounded Prisma transactions, strict replay commit-before-return,
one-unconsumed partial index, lineage checks and both prior migration checksums.
Only refresh extends idle; absolute expiry stays fixed. Revoke-all is serialized
with creation on User. No automatic retries on ambiguous commits or retention jobs.
See SESSIONS.md for policy, trusted callers, concurrency guarantees and limitations.

## Authorization foundation

Task 2.5 adds non-global AuthorizationModule, tenant-aware Role/Permission/
MembershipRole/RolePermission and runtime-minted frozen contexts. Only validated
TENANT sessions can mint contexts; copied objects/actor IDs never prove authority.
Always use current PostgreSQL mappings intersected with the closed template ceiling,
default-deny unknown/empty requirements, no wildcard/platform/financial grants.
Revalidate inside mutations; use requireIn for future resource checks/writes in the
same transaction. Preserve User -> Session -> sorted Tenant -> Membership -> Refresh
lock order and acquire tenant write locks immediately for administrative mutations.
Both current access/refresh credentials are mandatory for tenant transitions;
rotate/version them atomically and preserve strict replay revocation. Keep last-owner
checks for active tenants, and integrate future global user/email/role lifecycle
changes across every affected tenant. Provisioning is bootstrap-only, never startup
business seeding or normal admin authority. See AUTHORIZATION.md. No RLS, public
guards/management endpoints or Task 2.6 implementation without separate approval.

## Redis infrastructure

Use non-global RedisModule and exported RedisService for the dedicated readiness
probe. Keep Redis at loopback port 6380/database 0 locally; use 6381 only for the dedicated
isolated integration tests. Never flush unrelated Redis or delete volumes. Preserve
AOF everysec, noeviction and the dedicated redis-data volume. Probe startup is
bounded at 2 seconds and PING at 1 second; offline queuing/replay are disabled.
Do not log URLs, credentials or raw Redis errors. Queue prefix is validated and
consumed by the approved BullMQ infrastructure. Do not reuse the probe client
for future producers/workers. No BullMQ packages or queues exist in Task 1.4.2.

## BullMQ foundation

Keep QueuesModule directly imported by AppModule, with no production demo queues.
Feature queue modules use QueuesModule.registerQueue and explicit @InjectQueue;
publication goes through QueueRuntime.publish for its outer 2s deadline and safe
failure behavior. Register each producer once. Workers use registerWorker with
an injectable QueueProcessor and explicit dependency-module imports, not duplicate
@Processor/inline registrations. Worker connections retry indefinitely with
maxRetriesPerRequest null and no short command timeout. Producer command retries
are finite and offline buffering/replay disabled. Never reuse the readiness client.

One 30s shutdown budget covers managed workers and queues. Preserve root-level
drain before persistence teardown, blocking-client ownership, cooperative signals
and forced client disconnect. Do not replace it with only Promise.race or attempt
to upgrade an already-pending BullMQ close(false) with close(true).
No real test jobs may run against development Redis. Test-only fixtures are outside
production; the guarded real Redis suite is separate from offline tests.
See docs/architecture/QUEUES.md for registration, names, defaults and limitations.

## Real Redis integration safety

Use npm run redis:test:up/inspect/stop and the separate compose.redis-test.yaml
project, never the development Redis. test:redis requires explicit TEST_REDIS_URL
exactly redis://127.0.0.1:6381/0 and TEST_REDIS_INSTANCE_ID from ignored
.env.redis-test. Verify its marker before queue creation; retain verified container
identity across deliberate outages. Container lifecycle must pass the dedicated
project/service/image/volume/loopback-binding/instance-ID checks. Never bypass those
guards, adopt a mismatched instance, flush databases or delete volumes. Cleanup
must close apps and touch only prefixes generated by the current run.

The real Redis suite overrides PostgreSQL only; preserve real Redis operations.
The real PostgreSQL suite still requires its actual guarded database. Keep the
30-second real shutdown test and observable finite polling; do not use forced exit
to conceal leaked resources. Start owned queue clients after attaching listeners
and before handing them to BullMQ so cold-start connection failure can recover.
See docs/development/TESTING.md for commands, CI and actual verification boundaries.
