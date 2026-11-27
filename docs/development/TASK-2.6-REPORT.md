# Task 2.6 implementation and verification report

Verified 2026-11-27, Africa/Lagos. Task 2.6B/2.6C are complete locally and await
owner review. Task 2.7 has not started. No staging, commit, push, merge or deployment
was performed. GitHub Actions has not been executed by this agent.

## Starting point and authorization

Repository: hanoflow-backend. Branch: feature/postgresql-rls, based on merged Task2.5
commit 9c64364. The original clean baseline and later documentation-only working
changes were independently checked. Node24.22.3/npm11.19.1 use the approved portable
runtime. Nest12, strict TypeScript6/ESM, PostgreSQL18.7, Prisma7.10.1, Redis8.2.11,
BullMQ6.7.10, @nestjs/bullmq12.0.2 and Argon2 0.45.2 dependencies remain unchanged.
Package manifest, lockfile, schema and the four original migration files have no diff.

Both actual database targets on 127.0.0.1:5434 matched the approved identities,
schema, four migration checksums and baseline data: five Permission rows and no
other application records. All 388 prior tests passed before implementation.
PostgreSQL, development Redis6380 and marked test Redis6381 were independently
verified healthy. No unrelated service was stopped or modified.

Originally runtime and CLI both used hanoflow, the database/table/type owner,
superuser and BYPASSRLS login. PUBLIC had default CONNECT/TEMPORARY; application
policies/functions did not exist. Runtime credentials are now separated.

The owner approved the five-role architecture and exact early development
`REVOKE CONNECT ON DATABASE hanoflow FROM PUBLIC`. Before that revocation only the
owner/admin could LOGIN, current application/tooling configuration used that same
identity, and no additional legitimate connection depended exclusively on PUBLIC.
The exact before/after ACL was NULL -> `{=T/hanoflow,hanoflow=CTc/hanoflow}`. Fresh
admin/application connections still worked. All other development security changes
waited for full restricted test acceptance. See the [sequencing review](../architecture/RLS-IMPLEMENTATION-REVIEW.md).

## Final role and credential architecture

| Role                  | Final use                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hanoflow              | Existing unchanged administration/recovery login and logical database owner; never normal application runtime.                                                                          |
| hanoflow_migrator     | Controlled migration login; application public/helper schemas, tables, migration metadata, enums and functions owner. No superuser/bypass/create-role/create-db/replication; NOINHERIT. |
| hanoflow_runtime      | Actual Nest/application-test login; no ownership, privileged attributes, role memberships, DDL or privileged role switching.                                                            |
| hanoflow_bootstrap    | NOLOGIN capability; only migrator may explicitly SET ROLE, INHERIT FALSE and ADMIN FALSE.                                                                                               |
| hanoflow_test_fixture | Independent test-only login; no ownership/memberships/bypass; development CONNECT denied; approved broad fixture DML only in exact test database.                                       |

CONNECT and schema privileges are explicit. PUBLIC database/schema access is
removed from both accepted targets; runtime cannot create schemas or temporary
tables. Runtime receives no migration metadata access, DELETE/TRUNCATE/REFERENCES/
TRIGGER/DDL, unrestricted catalog writes or inherited authority. Dedicated migrator
function defaults revoke PUBLIC EXECUTE; future tables receive no automatic runtime
grants. Existing global built-ins and unrelated databases/roles/schemas are untouched.

Scoped ignored files: original .env for Compose/admin; .env.runtime for Nest;
.env.migrations and .env.test-migrations for CLI; .env.test-runtime for test runtime;
.env.test-fixture for the explicit fixture helper; .env.rls-test-acceptance for the
nonsecret migration-hash acceptance marker. Privileged files are parsed only by
their separate consumer, not exported into runtime process.env. Runtime rejects
privileged credential variables. No original administration password rotation or
actual .env replacement occurred. Strong independent login passwords were generated
in memory after verifying ignore rules, never printed. No privileged fallback exists.

## Final table matrix

All twelve tables ENABLE and FORCE RLS. The development database has 28 explicit
application/bootstrap policies; test has the same 28 plus 12 fixture-only policies.

| Table              | Runtime operations and scope                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| User               | SELECT id/status/emailVerifiedAt for self or users in verified tenant; UPDATE(id) only for own row locking.                |
| PasswordCredential | None; fixture-only persistence tests, future Auth access deferred.                                                         |
| Session            | Own session/identity SELECT/INSERT and approved context/lifecycle UPDATE columns; no user/id/absolute-expiry reassignment. |
| AccessToken        | Digest/current-session SELECT and current-session/version INSERT.                                                          |
| RefreshToken       | Digest/current-session SELECT/INSERT and UPDATE(consumedAt), retaining consumed replay evidence.                           |
| Tenant             | Verified tenant or own relationship registry SELECT; UPDATE(id) for locks only.                                            |
| Membership         | Verified tenant or own session-path relationship SELECT; tenant-only UPDATE status/removedAt/updatedAt.                    |
| Role               | Verified-tenant SELECT. Controlled pending bootstrap INSERT separately.                                                    |
| MembershipRole     | Tenant SELECT/INSERT; UPDATE removal fields only, with verified actor and unchanged scope/keys.                            |
| RolePermission     | Tenant SELECT. Controlled pending bootstrap INSERT separately.                                                             |
| Permission         | SELECT existing five TENANT codes only.                                                                                    |
| AuditEvent         | Scoped/allowlisted INSERT only, no returning-row SELECT or mutation privileges.                                            |

User/Tenant BEFORE UPDATE OF id SECURITY INVOKER triggers explicitly reject actual
identifier changes, including unreferenced records. UPDATE(id=id), FOR SHARE and
FOR UPDATE still work. Primary/FK constraints are preserved and are not relied on
as the identifier immutability mechanism. No SECURITY DEFINER function was added.

Policy dependencies are acyclic: User/Tenant -> Membership; token inserts ->
Session; bootstrap records -> Tenant. Membership/Session policies and helpers do
not query back into their dependents. Functions use fixed search_path and qualified
references. Missing/invalid settings yield no authority; explicit old/new predicates
and column ACLs prevent reassignment. No runtime tenant USING(true) convenience
policy exists. [Exact SQL](../../prisma/migrations/20261127210000_restricted_runtime_rls/migration.sql)
and [actual PostgreSQL catalog evidence](TASK-2.6-VERIFICATION.json) include names,
commands, target roles, USING/WITH CHECK expressions, ownership and grants.

## Sessions, authorization, pools and audit

Credential lookup proceeds digest -> session -> persisted user within one bounded
transaction before tenant authority. Tenant binding follows current eligibility,
version and runtime WeakMap proof validation. Both current access and refresh
credentials from the same eligible session/context remain mandatory for transitions.
Rotation, old-context rejection, strict consumed-token replay revocation and absolute
expiry are preserved. No headers/DTOs or copied context objects prove authority.

set_config(...,true) and protected queries share the same Prisma transaction client.
Conflicting tenant/member binding denies; expired transaction clients cannot escape
Prisma lifetime. No root-client fallback, nested transaction, password hashing or
network call was introduced inside production database transactions.

Lock order remains User -> Session -> sorted Tenant -> Membership -> RefreshToken.
All eligible owners in the verified tenant remain visible for owner counting.
Current-state permission resolution, delegation, self-promotion denial, ADMIN/OWNER
separation, retained assignment history and owner concurrency protections pass.
Future global User/email lifecycle operations retain their documented obligations.

One runtime pool remains max5, connect/statement2s, query3s, idle30s; transaction
acquire1s/timeout5s and lock750ms are unchanged. Separate CLI/fixture/test-reuse pools
are max1. Real tests prove same-backend PID reuse after commit, rollback, exception
and timeout and two simultaneous distinct-backend tenant transactions without leaks.

The separate RoleProvisioningModule/CLI consumes only its scoped migration file,
opens one controlled connection and SET LOCAL ROLEs to bootstrap. Seven-role creation,
idempotence, active matching state and drift rejection were tested. It creates no
tenant/user/member/owner and exposes no public endpoint. Future atomic onboarding
requires a separately reviewed capability.

Audit inserts and mutations remain atomic. createMany avoids SELECT for RETURNING.
Global replay has null system actor; tenant paths cannot read global/other tenant
audit because runtime has no audit SELECT at all. Append-only is enforced against
restricted runtime, not privileged owners/admins. No permission code or role ceiling
changed. No credential material is stored in audit metadata or reports.

## Migration and recovery results

Fifth migration: 20261127210000_restricted_runtime_rls. Four prior migration files
and checksums remain unchanged on both databases. Both report five active applied
migrations, up-to-date status and no Prisma schema difference. Custom RLS/ACL/trigger
metadata is checked separately because Prisma schema comparison is insufficient.

The first test attempt failed on helper-schema creation and rolled back completely.
After verifying no partial schema/RLS objects, controlled administration created
that exact schema owned by migrator instead of granting database CREATE. Only the
failed fifth attempt was marked rolled back with Prisma; its history remains visible.
The reviewed fifth migration then applied successfully to test. The complete test
gate passed before development ownership/ACL preparation and migration deployment.
Development migration succeeded on the first attempt.

Both final databases retain exactly five Permission rows; all other application
tables are empty after owned fixture cleanup. Existing 26 CHECK constraints remain.
Fixture development CONNECT is effectively false and a new actual connection is
rejected with 42501; authorized test connections work. Administration recovery access
remains functional. No reset, db push, shadow database, extension, volume deletion,
unrelated role/database changes or existing migration rewrite occurred.

Per-database DDL/security changes are transactional; cluster roles and ignored files
cannot share one atomic transaction across both databases. On partial failure,
inspect recorded state and apply only reviewed targeted corrections. Never silently
adopt roles, rotate passwords, grant broad privileges, use migration credentials as
runtime or disable RLS. Regranting PUBLIC CONNECT would reopen fixture development
access and requires explicit security-weakening approval. Use forward corrective
migrations for applied SQL. Full operational instructions are in [RLS.md](../architecture/RLS.md).

## Verification

| Layer               |      Tests | Suites | Final duration |
| ------------------- | ---------: | -----: | -------------: |
| Offline unit/HTTP   | 241 passed |     20 |       10.524 s |
| Actual PostgreSQL   | 168 passed |      6 |       19.704 s |
| Actual Redis/BullMQ |  11 passed |      1 |       60.041 s |
| Total               | 420 passed |     27 |                |

All original 388 tests retain their verification intent. Six offline and 26 real
database tests were added. Existing identifier-update assertions now expect the
stronger immutable-id CHECK rejection; deletion/FK checks remain intact. Existing
physical multi-application backend checks still use actual runtime pools.

Additional real checks (outside Jest counts): six independently injected excessive
table/column privilege cases rejected as the actual runtime identity, plus owner/
superuser rejection, all inside rolled-back isolated transactions; bootstrap checks
above; fresh fixture development denial; compiled healthy/unavailable/unsafe-identity
checks. Normal compiled runtime actually reports hanoflow_runtime with privileged
environment variables absent. Healthy REST liveness/readiness and GraphQL:200/200/200;
database unavailable:200/503/200; unsafe fixture identity:startup rejected. Application
close completes within the smoke command's 5s bound. Native Windows OS signal delivery
was not separately exercised.

Passed: dependency consistency, Prisma formatting/validation/generation, both migration
statuses, both schema diffs, actual policy/role/grant/trigger/constraint inspection,
TypeScript, ESLint, Prettier, production build, compiled smoke, git diff checks and
unchanged dependency/schema/four-migration comparisons. All three containers are
healthy with original ports/volumes. Test Redis restarts are only the existing guarded
suite's intended behavior; development PostgreSQL/Redis were not restarted.

CI preserves offline/Redis jobs and provisions isolated roles and scoped files for
migrator deployment and restricted-runtime acceptance. Fresh empty-target guards
refuse existing objects/roles/files; they are not a reset. GitHub Actions and the
fresh CI environment were not executed here; verified rollout used existing local
databases. Existing Linux/native-load and production deployment restrictions remain.

## Files and implementation decisions

Created:

- Architecture: RLS.md and RLS-IMPLEMENTATION-REVIEW.md.
- Evidence/report: TASK-2.6-VERIFICATION.json and this report.
- Fifth migration SQL.
- Infrastructure: database-context.ts and runtime-identity.ts.
- Authorization: role-provisioning.module.ts.
- Tests: setup-database-env.ts, helpers/database-fixture.ts, rls.database-spec.ts.
- Scripts: database-security.mjs, database-ci-prepare.mjs, database-acceptance.mjs,
  database-negative-check.mjs, database-bootstrap-check.mjs,
  database-security-report.mjs, provision-tenant-roles.mjs, runtime-smoke.mjs.

Modified:

- .env.example, .github/workflows/ci.yml, AGENTS.md, README.md, prisma.config.ts.
- Architecture DATABASE/IDENTITY/PASSWORDS/SESSIONS/AUTHORIZATION/OVERVIEW docs;
  development PROGRESS.md and TESTING.md.
- AppModule, environment validation/tests, PrismaService/tests, HealthService.
- SessionService/tests, AuthorizationModule/Service, RoleProvisioner and both audit writers.
- Existing authorization/session/identity/password/database integration suites;
  HTTP/GraphQL and Redis overrides; database target guard.
- Approved ignored scoped credential/acceptance files were created; original .env
  was preserved. Generated Prisma Client was regenerated and remains ignored.

Implementation choices within approval: SECURITY INVOKER immutable-id trigger;
administrator-created exact helper schema rather than broader migrator database
CREATE; staged token lookup; createMany audit insert; separate no-pool provisioning
module; runtime actual table/column/parameter privilege checks; uncommitted negative
fault injection; explicit empty-target provisioning and deterministic test pool.
No new dependencies, permission codes, application role templates or SECURITY DEFINER
functions were introduced.

## Manual review and remaining boundaries

With Node24 activated and the three existing services healthy:

```powershell
npm run db:validate
npm run typecheck
npm run lint
npm run format:check
npm run build
node scripts/database-acceptance.mjs
npm run redis:test:inspect
npm run test:redis
node scripts/runtime-smoke.mjs
npm run db:migrate:status
$env:HANOFLOW_MIGRATION_ENV='.env.test-migrations'
npm run db:migrate:status
Remove-Item Env:HANOFLOW_MIGRATION_ENV
git diff --check
```

Do not repeat provisioning on the initialized installation or print secret files.
Review the actual catalog JSON, migration SQL and matrix against the approved design.
Custom settings are not independently authenticated: arbitrary SQL compromise,
privileged administrators and resource/business authorization remain outside the
claimed RLS guarantee. Public authentication/transports/guards, onboarding, global
lifecycle workflows, compromised-password screening, production exposure/security
advisory remediation and deployment readiness remain separately scoped.

Next action: owner review of Task2.6. Task2.7 requires separate authorization and has
not started. No outstanding local infrastructure or implementation blocker remains.
