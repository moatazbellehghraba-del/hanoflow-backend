# Database infrastructure

## Implemented boundary

PostgreSQL 18 is the local persistence target. Prisma CLI, Client and PrismaPg adapter are on stable 7.10.1; the Prisma 8 release candidate is deliberately excluded. `prisma.config.ts` owns schema/migration locations and the CLI URL. It explicitly loads .env; absent DATABASE_URL does not block generation/validation, but database CLI operations need a URL. Runtime Nest configuration separately requires a valid PostgreSQL DATABASE_URL before creating the application.

The `prisma-client` generator emits ignored ESM TypeScript under src/generated/prisma, with .js import extensions so Nest's NodeNext compilation produces runnable dist code. npm postinstall generates the client. Never edit generated code; regenerate after dependency/schema changes. Build tooling and CLI migrations require development dependencies; runtime uses compiled generated code plus production packages.

DatabaseModule imports ConfigModule, owns one PrismaService provider and exports it explicitly. HealthModule imports DatabaseModule; HealthService consumes the client while the controller depends on HealthService. Future features must import the module rather than construct clients. The module is not global and contains no business models or tenant logic.

PrismaService constructs one PrismaPg adapter and pool (maximum five connections per application process), with two-second connection and statement timeouts, three-second client query timeout and a 30-second idle timeout. Pool capacity is a starting development setting; production connection budgeting must account for all replicas and reserve operational capacity. TLS remains enabled/verified according to deployment configuration; no global certificate bypass is installed. Secrets must be provided by the host's secret management.

Nest initializes the connection and disconnects during shutdown. A syntactically invalid/missing URL fails configuration validation. An unreachable database produces only a safe warning event and leaves the HTTP process running; every readiness request reattempts a lightweight SELECT 1 query so recovery needs no process restart. No raw driver errors, SQL parameters or connection strings are logged. No migrations run at startup.

## Health contract

- GET /api/v1/health returns 200 with status ok without querying PostgreSQL.
- GET /api/v1/health/ready queries PostgreSQL and Redis concurrently and returns 200 with status ok, database up and redis up, or a safe 503 envelope through the existing global filter.
- Readiness is connectivity only; it does not prove schema migrations, authorization, tenant isolation or other external service availability. Route production traffic only to ready instances; use liveness for process health.

## Local operation and storage

See README for exact setup, start/stop, fresh-volume reset and test-database commands. Compose uses a named project-scoped volume, a PostgreSQL health check, required POSTGRES_DB/USER/PASSWORD values and a loopback-only host port. PostgreSQL 18 uses a version-specific PGDATA under /var/lib/postgresql, so that parent is the mounted volume. Never delete existing volumes or reuse a data directory across unsupported major upgrades. Plan backups, restore tests and a reviewed major-upgrade procedure before production.

Compose initialization variables apply only to a new empty volume. Updating .env does not rotate existing credentials. DATABASE_URL and TEST_DATABASE_URL are explicit URLs: keep the host, port, database and percent-encoded credentials synchronized with the target. Applications outside Docker use 127.0.0.1; an eventual containerized application would use its network's service hostname. No application container or production database is deployed by this task.

The dedicated Compose project is hanoflow-backend. The default host mapping is 127.0.0.1:5434 to container port 5432, configurable through POSTGRES_PORT. Ports 5432 and 5433 on this Windows host are reserved for existing unrelated PostgreSQL services; never reuse, stop or modify them. Development uses hanoflow and integration tests use the separate logical database hanoflow_test in HanoFlow's container. Credentials are supplied from an ignored .env and are never printed. Creating the test database is additive and must not reset existing databases or volumes.

On this workstation, C:\dev-tools\node24 contains the portable Node 24.22.3/npm 11.19.1 runtime. Each independent PowerShell command process must prepend that directory to its own PATH; npm child processes inherit it. The system Node 22.17 installation and permanent Windows PATH are preserved. This environment-specific path is documented only; package engines, cross-platform scripts and CI retain portable runtime requirements. See README for activation and verification commands.

## Migration decision and workflow

The schema has no models. Prisma validation and generation succeed; `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` returns only `-- This is an empty migration.` There is no meaningful initial SQL to apply. Retain migration_lock.toml with provider postgresql, and defer the first SQL migration to the first approved model. Do not invent tables, enum sentinels or a meaningless SQL baseline just to populate the directory. There is no seed because there are no records to seed.

After an approved model change, run db:migrate:dev on a disposable development database, review SQL, regenerate the client and commit schema plus migration history together. Prisma development migrations use a shadow database; the local development role may create it. Production runtime roles must not have those broad privileges. Do not accept reset prompts for existing data. Release automation uses db:migrate:deploy with a suitable migration role and backups, independently of application startup. Do not use db push instead of migrations, modify applied history, or run development/reset commands in production. Use forward migrations for corrective changes.

## Tests and actual verification

Default unit/HTTP tests use a fake URL and an overridden Prisma provider; they verify lifecycle, DI, safe failure behavior and readiness responses without PostgreSQL. The separate test:db suite uses a real PrismaService, an explicitly required TEST_DATABASE_URL, SELECT 1 and real HTTP readiness. It is read-only and never resets the database. It fails when configuration or connectivity is missing rather than silently skipping. CI includes an ephemeral PostgreSQL 18 job. A configured CI job is not evidence of a completed GitHub run; see PROGRESS.md for executed checks and any local Docker blockers.

Task 1.2.1 adds a pre-connection test target guard. Both development and test URLs are required, must target loopback on the configured dedicated port (default 5434, with 5432/5433 forbidden), and must use the same username. POSTGRES_USER, when present, must match both. The test database must be exactly hanoflow_test, distinct from the development database. Tests also query current_database() to verify identity. CI provisions distinct logical databases and uses the same host port/guard. The helper deliberately refuses remote integration targets; extending that scope requires a separately reviewed configuration design. Pure offline tests verify the guard's rejection cases without opening connections.

Live verification on 2026-11-25 passed against PostgreSQL 18.7: 39 offline tests, four real database tests, Prisma SELECT 1, test database identity and a real 2s statement_timeout setting. The compiled NestJS process returned liveness/readiness 200/200, then 200/503 while only HanoFlow's database was stopped, then 200/200 after its restart without restarting NestJS. The dedicated container was restored healthy; unrelated services remained untouched. See PROGRESS.md for complete environment/quality results. The database has no migration metadata yet: migrate status returns exit 1 (unmanaged, no migration files), while the model-free schema diff is empty. This is intentional; do not create a fake baseline to change that status.

## Future tenant design - not implemented

Use a shared PostgreSQL database with tenant-scoped records. Resolve tenant context from trusted authenticated identity, not arbitrary request fields. Apply authorization and tenant predicates to reads, writes, joins, aggregates, cache keys, integrations and background jobs. Use composite unique constraints and tenant-aware foreign keys to prevent relationships crossing tenants. Platform-wide operations need explicit separate authorization and auditability. Test direct and indirect cross-tenant access denial, including concurrent operations. No tenant entities, tenant constraints, authentication or Row-Level Security exist yet; readiness is not an isolation guarantee.

## Future transactions and finance - not implemented

Transactions must encompass complete use-case invariants. Use Prisma transaction APIs with bounded duration, deliberate isolation and concurrency control; avoid external network calls inside open transactions. Retry only identified transient conflicts, using idempotency to prevent duplicate effects. Atomic outbox records should bridge database commits and eventual queue delivery when messaging arrives.

Represent money in integer minor units or exact decimal types with explicit currency/scale and rounding; never use floating point. COD, reconciliation and settlement flows require auditable postings, uniqueness/idempotency constraints, balance invariants and explicit handling of corrections. Protect against concurrent duplicate settlement, reconcile totals transactionally and retain an audit trail. None of these entities or rules are implemented in Task 1.2.

## References

- [Prisma 7 config API](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference)
- [Prisma 7 client generator](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators)
- [PostgreSQL version support](https://www.postgresql.org/support/versioning/)
- [Official PostgreSQL image storage conventions](https://github.com/docker-library/docs/blob/master/postgres/README.md)

Task 1.4.2 preserves the real four-test PostgreSQL suite and test-target guard.
Only Redis is overridden in that suite so it remains independent of Redis; Prisma
queries are still real and unmocked. See [Redis architecture](REDIS.md).
