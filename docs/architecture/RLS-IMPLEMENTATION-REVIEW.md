# Task 2.6 implementation review

Status: sequencing exception approved and implemented; both databases migrated
after restricted test acceptance. See RLS.md and TASK-2.6-VERIFICATION.json for
current implementation and actual catalog evidence. The original review follows
as historical context.

## Approved exception and actual verification

The owner explicitly approved only early `REVOKE CONNECT ON DATABASE hanoflow FROM
PUBLIC`. Before mutation, the URL and actual connection identified the approved
127.0.0.1:5434 server, database hanoflow, PostgreSQL18.7 and administration identity
hanoflow. Only hanoflow could LOGIN; no HanoFlow memberships or other active
application/tooling identities existed. Administration/application configuration
used that same owner/superuser, independent of PUBLIC CONNECT.

Before ACL: NULL (default PUBLIC CONNECT/TEMPORARY and owner privileges). After
the exact revocation: `{=T/hanoflow,hanoflow=CTc/hanoflow}`. PUBLIC retained TEMPORARY
at this stage; no other early ACL change occurred. New administrator/application
connections to development and test both succeeded. Guarded provisioning then
verified fixture development login rejection (42501) and successful test login.
Effective memberships and privileges were inspected, not just direct grants.

Only after full test acceptance did the controlled development preparation change
ownership/schema/other ACLs and apply the fifth migration. The four original
checksums and existing Permission rows were preserved. The final report records
both databases' effective role/policy/privilege state and count-only data inventory.

Recovery must retain owner access. Regranting PUBLIC CONNECT after fixture LOGIN
would reopen development access and is not an automatic rollback; any such
security-weakening recovery requires separate approval. Prefer reviewed grants to
specific legitimate roles. No administration password or server-wide authentication
configuration changed.

## Original sequencing review

The approved fixture login and test-first sequencing need an explicit operational
decision before role provisioning. Both existing databases currently grant CONNECT
through PUBLIC. PostgreSQL has no per-role DENY that overrides a PUBLIC grant.
Consequently, creating an enabled fixture login before development acceptance
would permit that login to connect to development. Revoking CONNECT from just the
fixture role would not remove the PUBLIC entitlement.

The development ACL must remain unchanged until restricted test acceptance.
Possible resolutions are:

1. Keep the fixture role NOLOGIN during test acceptance. A dedicated controlled
   fixture process connects to the exact test database as the existing local
   administrator and immediately SET ROLEs to the fixture capability. Application
   acceptance connections still authenticate directly as restricted runtime.
   After acceptance, harden development ACLs before enabling fixture LOGIN and
   writing its independent credential file.
2. Approve an early, narrowly scoped development database CONNECT ACL change:
   `REVOKE CONNECT ON DATABASE hanoflow FROM PUBLIC;` Existing owner/admin access
   remains available. Grant no fixture CONNECT on development. Other development
   ownership, ACL, schema and policy changes remain deferred until test acceptance.

Option 2 is recommended because it avoids a temporary administrator-authenticated
fixture path. It is an explicit exception to the approved test-first ACL ordering.
Option 1 preserves the required development database change ordering, but adds a
temporary administration-authenticated fixture connection path. It requires
explicit review of its credential handling and inability to escape the fixture
boundary. Neither option has been implemented.

The proposed User/Tenant identifier protection is a SECURITY INVOKER BEFORE UPDATE
trigger rejecting NEW.id IS DISTINCT FROM OLD.id with a sanitized constraint
error. This preserves UPDATE(id) locking privilege without allowing reassignment,
including unreferenced rows. It requires referenced/unreferenced restricted-role
tests before acceptance. No SECURITY DEFINER function is proposed.

## Reverification on 2026-11-27 (Africa/Lagos)

- Branch feature/postgresql-rls; initial working tree clean.
- PostgreSQL 5434, development Redis 6380 and marked test Redis 6381 healthy.
- Both actual database identities, all four migration checksums and schema diffs
  match the accepted baseline. Only Permission has records (five rows).
- Existing hanoflow login remains superuser/BYPASSRLS and application object owner.
- PUBLIC CONNECT/TEMPORARY grants independently confirmed on both databases.
- No HanoFlow role memberships; no new roles provisioned.
- Dependency consistency command exits zero.
- Offline: 235 tests / 20 suites, 46.216 s.
- PostgreSQL: 142 tests / 5 suites, 18.562 s.
- Redis/BullMQ: 11 tests / 1 suite, 82.847 s.
- Total: 388 passing tests / 26 suites.
- No database security/configuration/source/migration changes have been made.
