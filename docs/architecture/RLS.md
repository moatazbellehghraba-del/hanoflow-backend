# Restricted PostgreSQL runtime and RLS — Task 2.6

## Boundary

The modular monolith retains shared tables, explicit tenant predicates, composite
foreign keys and current-state application authorization. PostgreSQL RLS adds
defense in depth against accidental scope omissions. It does not replace RBAC,
resource policies, session validation or application invariants.

Custom PostgreSQL settings are trusted application inputs, not independently
authenticated database identities. A compromised runtime connection able to issue
arbitrary SQL can change these settings. This design does not claim protection
against that attacker, database owners, superusers or BYPASSRLS roles. Tenant
selection is not platform authorization. Production deployment remains blocked by
the previously documented authentication, exposure and dependency restrictions.

## Database identities

| Identity                | Purpose and authority                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hanoflow`              | Existing local superuser/database owner; controlled provisioning/recovery only. Password unchanged.                                                                                                  |
| `hanoflow_migrator`     | Application table/type/schema owner and reviewed migration login. No SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/replication. Can explicitly SET ROLE to bootstrap, without inheritance or ADMIN option. |
| `hanoflow_runtime`      | Normal Nest process and application integration tests. No ownership, DDL, role memberships, privileged role switching or bypass.                                                                     |
| `hanoflow_bootstrap`    | NOLOGIN capability for the separate provisioning process; no general administration or normal runtime membership.                                                                                    |
| `hanoflow_test_fixture` | Test-only fixture login, no role memberships or bypass; cannot CONNECT to development. Broader fixture DML policies exist only in exact `hanoflow_test`.                                             |

All new roles are NOINHERIT. There is no login per tenant/user and no administrative
Prisma client in application modules. Ownership and migration deliberately share
one controlled login; a separate NOLOGIN owner is not used. Runtime identity is
verified from PostgreSQL metadata, not inferred from URL text. The verifier rejects
unexpected login/current role, privileged attributes, effective role switching or
inheritance, ownership, schema/database creation, temporary tables, excessive
table/column access, executable application SECURITY DEFINER functions and missing
RLS/FORCE flags. It runs at initialization, readiness and service transaction entry.

Security misconfiguration fails startup closed. Ordinary network unavailability
keeps dependency-free REST/GraphQL liveness available and readiness unready. A
recovery attempt rechecks identity before protected use. There is no privileged
fallback. Query parameters, credentials and raw database errors are not logged.

## Credential files

| Ignored file               | Consumer                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.env`                     | Existing Compose administration configuration and controlled provisioning/recovery only; preserved verbatim.                |
| `.env.runtime`             | Nest ConfigModule: runtime URL and nonprivileged application settings.                                                      |
| `.env.migrations`          | Prisma CLI: `DATABASE_MIGRATION_URL` for development.                                                                       |
| `.env.test-runtime`        | Database tests: development/test runtime URLs, expected runtime user and dedicated port.                                    |
| `.env.test-migrations`     | Prisma CLI test migration URL.                                                                                              |
| `.env.test-fixture`        | Explicit fixture helper/tool only: `TEST_DATABASE_FIXTURE_URL`; parsed locally, not exported into test runtime environment. |
| `.env.rls-test-acceptance` | Noncredential acceptance marker tied to fifth migration SHA-256.                                                            |

The runtime does not load `.env`. Migration tooling does not fall back to runtime
or administration URLs. Runtime configuration rejects privileged database secret
variables. Do not launch Nest from a shell containing migration/fixture/admin
credentials. CI scopes administration credentials to the provisioning step.
Never print files, URLs or passwords. Ignore rules are checked before writes;
provisioning uses independent 48-byte random passwords and exclusive file creation.
On Windows, POSIX file mode does not replace NTFS access control: protect the local
workspace/account and use reviewed host secret management for eventual deployment.

Provisioning refuses unexpected existing roles/files instead of adopting them or
rotating passwords silently. A partial failure requires inspection and targeted
recovery; never delete existing data/volumes or rotate the administrator account.
For credential rotation, use a reviewed controlled operation, update only that
identity's scoped secret file and restart its consumers. No automatic rotation or
secret-printing command is provided.

## Table and privilege matrix

All twelve tables ENABLE and FORCE RLS. Policies target explicit roles. Metadata
table `_prisma_migrations` is ACL protected, with no runtime access. No runtime
DELETE, TRUNCATE, REFERENCES, TRIGGER or DDL capability is granted.

| Table              | Runtime grants and policy context                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User               | SELECT id/status/emailVerifiedAt for current identity or users in verified tenant; UPDATE(id) only for identity row locks. No email or credential lookup workflow.                                                                       |
| PasswordCredential | No runtime access. PasswordHasher remains independent of persistence.                                                                                                                                                                    |
| Session            | SELECT/INSERT plus UPDATE scope/tenantId/membershipId/contextVersion/lastActivityAt/idleExpiresAt/revokedAt/revocationReason. Own identity/session context; inserts IDENTITY-only. Absolute expiry/user ownership immutable through ACL. |
| AccessToken        | SELECT/INSERT; initial digest lookup, then current session; inserts require current session user/version.                                                                                                                                |
| RefreshToken       | SELECT/INSERT and UPDATE(consumedAt); digest lookup includes consumed replay evidence, then current session.                                                                                                                             |
| Tenant             | SELECT verified tenant or own relationship registry during session checks; UPDATE(id) for locks only.                                                                                                                                    |
| Membership         | SELECT verified tenant or own relationship rows in private session path; UPDATE status/removedAt/updatedAt only within verified tenant.                                                                                                  |
| Role               | Tenant-scoped SELECT only. Bootstrap has selected-tenant SELECT/INSERT, with PENDING required for insertion.                                                                                                                             |
| MembershipRole     | Tenant SELECT/INSERT and UPDATE removedAt/removedByUserId; actor matches current identity, no key reassignment/deletion.                                                                                                                 |
| RolePermission     | Tenant SELECT only; controlled pending bootstrap INSERT separately.                                                                                                                                                                      |
| Permission         | SELECT only the existing five TENANT codes, including bootstrap. No catalog expansion or runtime writes.                                                                                                                                 |
| AuditEvent         | INSERT only; approved session/tenant actions and scope/actor/target checks. No SELECT/UPDATE/DELETE/TRUNCATE.                                                                                                                            |

The authoritative policy SQL and explicit names/commands/roles/USING/WITH CHECK
expressions are in [the fifth migration](../../prisma/migrations/20261127210000_restricted_runtime_rls/migration.sql).
Each runtime operation has an explicit predicate. SELECT uses USING; INSERT uses
WITH CHECK; UPDATE checks old-row eligibility with USING and resulting scope with
WITH CHECK. Cross-tenant reassignment is additionally denied by column ACLs and
composite FKs. No runtime tenant policy uses USING(true). Fixture policies are a
separate deliberate test capability gated by exact current_database(), not PUBLIC
policies or runtime bypass. They receive no development grants or DDL.

FORCE applies to normal owner DML but cannot prevent an owner from altering RLS.
Controlled data migrations therefore require reviewed policies/access, never an
automatic RLS-disable fallback. Global Permission seeding occurs before RLS in
the unchanged fourth migration on fresh databases.

## Identifier immutability and locks

User/Tenant UPDATE(id) grants permit existing PostgreSQL FOR SHARE/FOR UPDATE
queries. SECURITY INVOKER BEFORE UPDATE OF id triggers reject NEW.id IS DISTINCT
FROM OLD.id with SQLSTATE 23514, including rows with no references. Setting id=id
and row locking work; real tests cover referenced and unreferenced rows. This is
independent of primary/FK constraints. No SECURITY DEFINER function is used.
An administrator able to remove triggers is outside this guarantee.

## Policy dependency graph and contexts

Policies have an acyclic dependency graph: User/Tenant -> Membership; token INSERT
checks -> Session; bootstrap Role/RolePermission/AuditEvent -> Tenant. Membership
and Session policies read only settings, not User/Tenant/token tables. Helpers read
settings only, with fixed pg_catalog search_path, schema-qualified calls and
restricted execution. There is no SECURITY DEFINER helper.

The session boundary validates raw token format in memory, sets a transaction-local
digest, locates its token, then session, then persisted user. The untrusted tenant
selector never establishes tenant authority. User -> Session -> sorted Tenant ->
Membership -> RefreshToken lock ordering is preserved. Eligibility, lifetimes,
context versions and both credentials are verified from current state before tenant
binding. Identity-only establishment/revocation retain their existing trusted
internal identity contract, not a new public authentication flow.

Authorization uses its existing private WeakMap proof, fresh session validation
and current persisted permissions before setting tenant/member context. Copied or
stale objects deny. `requireIn` keeps checks and future resource writes on the
caller's same bounded transaction. No root-client fallback or nested transaction
is added. Conflicting tenant/member binding is rejected. Transaction clients cannot
be used after Prisma closes their transaction.

Settings: app.access_path, app.token_digest, app.session_id, app.user_id,
app.tenant_id, app.membership_id; controlled bootstrap uses app.bootstrap_tenant_id.
Parameterized set_config(...,true) is transaction-local; no session-level context
SET, mutable global actor state, request-header authority or whole-request
transaction is introduced. UUID/digest helpers return NULL for missing/invalid
values. A deterministic one-connection real test verifies backend PID reuse and no
usable context after commit, rollback, exceptions and transaction timeouts.

## Preserved service guarantees

Both current access and refresh tokens from one eligible session/current context
remain required for tenant transitions. Rotation, contextVersion increments,
absolute expiry, strict replay revocation and commit-before-error replay audit
remain intact. No password, digest or raw token enters diagnostics/audit metadata.
Membership discovery is private to the authenticated identity; eligibility filtering
remains required for any future discovery API. Global email/password authentication
and public transports remain deferred, not silently granted unrestricted access.

All eligible owners in the verified tenant remain visible to owner counting,
including other users' minimal eligibility fields. Tenant write-lock serialization,
delegation, current authority, retained history and removal/reactivation behavior
remain unchanged. RLS does not enforce last-owner invariants against arbitrary SQL.
Future global User/email/role lifecycle changes must integrate the existing
multi-tenant locking/invariant obligations.

Audit writers use createMany for one row, avoiding SELECT for RETURNING. Mutations
and audit remain atomic; global replay events retain the null system actor. Runtime
cannot read even its own audit entries, so neither global nor other-tenant audit is
exposed. Append-only means restricted-runtime privileges, not owner-proof immutable
storage. No public audit API or new application permission exists.

## Provisioning, commands and test-first deployment

Activate the portable Node24 runtime in each Windows shell as documented in README.
These commands operate on the existing approved local target, never arbitrary hosts.

1. Independently verify targets, data, four checksums, roles and healthy services.
2. Apply the specifically approved early PUBLIC CONNECT revocation on development;
   retain administration access. See the implementation review for before/after.
3. `node scripts/database-security.mjs prepare-test` creates approved cluster roles
   and scoped ignored files and prepares test ownership/schema/ACL only. It refuses
   unexpected role/file collisions and data/history mismatches. It verifies fixture
   development connection denial and successful test connection.
4. Set `$env:HANOFLOW_MIGRATION_ENV='.env.test-migrations'`, then
   `npm run db:migrate:deploy` and `node scripts/database-security.mjs test-fixtures`.
5. `npm run build`, then `node scripts/database-acceptance.mjs` verifies actual
   excessive-privilege/owner rejection, controlled bootstrap, offline tests and all
   restricted database suites. It writes a migration-hash acceptance marker only
   after all commands pass.
6. Reverify development schema/data/history and test acceptance. Then run
   `node scripts/database-security.mjs development`. Only now are development
   ownership/ACL/helper-schema prerequisites changed.
7. Remove the test CLI override with `Remove-Item Env:HANOFLOW_MIGRATION_ENV`, then
   `npm run db:migrate:deploy` using `.env.migrations`. Verify actual policies,
   flags, ownership, effective grants, checksums and preserved records.
8. Run static/build/format checks, all suites and compiled REST/GraphQL smoke checks.

Never repeat prepare-test against an initialized installation. Status/validation
commands do not provision or rotate anything. The provisioner creates the exact
hf_security schema as administrator, owned by migrator; migrator receives no database
CREATE privilege. Both logical database owners remain the recovery administrator.

Explicit pending-tenant provisioning after build:
`node scripts/provision-tenant-roles.mjs <existing-pending-tenant-uuid> [--test]`.
This separate process loads only its scoped migration file, uses one bounded
connection, verifies identity, SET LOCAL ROLEs to bootstrap and invokes the injected
RoleProvisioner in the same transaction. It creates no tenant/user/membership/owner,
does not overwrite drift and remains idempotent. Future onboarding requires its own
reviewed capability for atomic tenant/member/initial-owner creation and activation.

## Tests, CI and resource budget

Fixture helpers load their own secret without exporting it or providing their
client to feature DI. Cleanup uses only run-owned IDs/correlations. Application
services remain on independently connected restricted runtime pools; physical PID
checks preserve multi-instance concurrency verification. Schema/credential tests
deliberately use the explicit fixture capability. Existing tests retain their
intent; identifier rejection now reports the stronger CHECK before FK rejection.

The negative-check command injects excess Permission/User/Audit privileges only
inside one uncommitted test transaction, switches SESSION AUTHORIZATION to the
actual runtime identity for verification, then always rolls back. No other
connection receives the injected privilege and no cluster role attributes change.

CI preserves offline and Redis jobs. Its database job creates an isolated test
database, provisions restricted identities, applies all migrations as migrator and
runs the same acceptance gate. CI-only fresh provisioning requires empty targets;
it is not a reset path for existing databases. GitHub execution must be reported
separately from local verification.

Runtime pool5, connection/statement2s, client query3s, idle30s, lock750ms,
transaction acquire1s and transaction5s remain unchanged. Fixture/bootstrap/specific
reuse-test pools use one connection each; none is a second runtime admin pool.
No dependencies, versions, overrides, containers, ports or volumes are changed.

## Recovery and future tables

Role provisioning, per-database ownership/ACL prerequisites and migration DDL have
separate transactions; files and two databases cannot share one atomic transaction.
On partial provisioning, retain files/roles, inspect exact completed steps and use
approved targeted corrections. Do not automatically adopt roles, reset passwords,
drop databases or delete volumes. Startup failure does not enable privileged
fallback. Fix exact grants/credentials using the controlled recovery identity.
Security-weakening recovery or disabling RLS requires separate approval.

The first test migration attempt lacked permission to create its helper schema.
Its transaction rolled back without schema/RLS residue. After verifying that state,
the administrator provisioned the exact schema; Prisma marked only that failed
attempt rolled back and successfully deployed the reviewed migration. Historical
four migration files/rows remain unchanged; the failed fifth attempt remains in
history, not hidden or deleted. Future applied migrations use forward corrections.

For an explicitly approved fresh local installation with both exact named databases
already created and independently verified empty, use `prepare-test --empty` and
later `development --empty` in the same sequence above. Empty mode verifies no
application tables/views/sequences/enums/routines before proceeding; migrations
then create all five stages as migrator. It never creates/resets a database or
adopts existing roles/files. Do not use empty mode on the current installation.
The CI path exercises the equivalent guarded empty-target ordering without granting
CREATEDB or broad schema privileges. Managed PostgreSQL
requires provider-supported role/schema provisioning, secret/TLS configuration,
backup/restore testing and connection budgeting; these local scripts intentionally
refuse remote targets.

Every future tenant-owned table requires: trusted tenant identifier; explicit
application authorization/resource predicates; composite tenant keys/FKs; reviewed
ENABLE/FORCE policies and explicit grants; nonrecursive joins; scoped job/cache
keys; real restricted-role read/write/pool tests. No blanket future runtime table
grants are installed. New global/platform access requires explicit separate review.
