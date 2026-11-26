# Backend architecture

## Existing implementation - Tasks 1.1 through 2.3

A single NestJS 12 process with Express transport and strict TypeScript/ESM. AppModule imports global validated ConfigModule, HealthModule and non-global QueuesModule, and registers a global HTTP exception filter. HealthModule owns GET /api/v1/health, returning only { "status": "ok" }, and GET /api/v1/health/ready, which queries PostgreSQL and Redis and returns 503 on either dependency failure. REST and GraphQL liveness remain dependency-free.

Bootstrap applies the /api prefix, URI version 1, global DTO ValidationPipe, JSON ConsoleLogger and graceful shutdown hooks. Shared setup is used in HTTP tests. AppModule, HealthModule and DatabaseModule are the production application modules. HealthModule imports DatabaseModule and the non-global RedisModule; HealthService mediates between the controller and the exported PrismaService.

src/config owns validated environment and bootstrap conventions. src/common/filters owns transport-aware HTTP/GraphQL error normalization; src/common/http owns request correlation and safe structured completion logs. src/infrastructure/database owns the singleton Prisma 7 client, PostgreSQL adapter and connection lifecycle. PostgreSQL 18 and the first reviewed migration now provide User, Tenant, Membership and minimum AuditEvent persistence. There are no identity API modules or public model types. src/common/interceptors and src/common/pipes remain reserved. Authentication, authorization, tenant resolution and financial logic remain future work. See [database architecture](DATABASE.md) and [identity architecture](IDENTITY.md).

ApiGraphqlModule owns code-first Apollo configuration, generating a sorted schema in memory and serving only /graphql independently of REST prefix/versioning. HealthResolver and HealthController share HealthService liveness logic. Typed request context carries the request and correlation ID, not identity. GraphQL uses its standard response shape and safe error codes; REST preserves its existing envelope. Development-only tooling/introspection, bounded requests, CSRF checks and disabled batching form an initial security foundation, not a production-security guarantee. See [API architecture](API.md) for policies, deferred authentication/tenant/cost controls and the unresolved transitive production advisory.

Task 1.2.1 standardizes the dedicated local PostgreSQL host binding to 127.0.0.1:5434 (container port 5432). Development and integration tests use separate logical databases, hanoflow and hanoflow_test, inside that Compose project. Test target safeguards reject unrelated hosts/ports and shared development/test targets before connecting. Existing PostgreSQL services on host ports 5432/5433 remain separate. Windows development uses a process-local Node 24 activation; there is no workstation-specific runtime path in application code or CI.

Task 2.3 adds PasswordCredential persistence and the non-global IdentityModule,
explicitly imported by AppModule. It exports internal password policy/hashing
services with private native engine/capacity providers. No public model, endpoint,
authentication workflow or extra Prisma client is created. See [password architecture](PASSWORDS.md).

## Planned architecture — not implemented

The modular monolith will group capabilities into explicit feature boundaries: platform tenants/subscriptions; company branches/employees; merchants; shipments/tracking; couriers/assignments; warehouse operations; COD; settlements/reconciliation; notifications/integrations; analytics/reporting. These are conceptual boundaries, not generated modules or entities.

Internal applications will use the implemented GraphQL foundation; external integrations will use the versioned REST foundation. Business operations are not implemented; future controllers/resolvers must call shared application use cases. PostgreSQL through Prisma is configured as persistence infrastructure. Redis connectivity/readiness and the BullMQ producer/worker foundation are implemented; business background processing remains planned. Inject infrastructure behind explicit boundaries and export only intentional module APIs. Frontend lives in a separate repository.

## Planned isolation and integrity

Trusted authenticated tenant context must constrain all data operations, jobs, cache entries and integration calls. Platform administration must have explicit authorization. Add cross-tenant denial tests as capabilities are introduced.

Financial use cases need exact currency arithmetic, transactional invariants, auditability and idempotency. Transaction boundaries belong around complete use cases, not arbitrary individual writes. Choose concurrency controls and outbox delivery when persistence and messaging are introduced.

## Decisions

Use npm and a committed lockfile; Node 24 LTS and NestJS 12 ESM; Jest rather than scaffold-default Vitest; ESLint rather than scaffold-default Oxlint. Built-in JSON logging avoids a third-party logging/telemetry service. DTO and environment validation share class-validator/class-transformer. Runtime dependencies remain limited to the current foundation.

Task 1.4.2 adds a single private ioredis readiness client with bounded startup/PING,
safe transition logs, automatic reconnection and immediate shutdown cleanup.
Redis Compose uses loopback port 6380 and its own persistent volume without
changing PostgreSQL. See [Redis architecture](REDIS.md). No worker or queue exists.

Task 1.4.3 adds centralized BullMQ defaults and explicit native Nest producer
registration, managed worker registration and one shared connection/lifecycle
registry. Production registers no queues or workers. The owner-approved upstream
global core/configuration exception does not make HanoFlow modules global.
See [queue architecture](QUEUES.md), including the isolated real execution checks
deferred to Task 1.4.4 and unchanged deployment restrictions.

Task 1.4.4 adds separate marked Redis integration infrastructure on port 6381,
real queue/outage/restart/shutdown acceptance tests and an independent CI job.
The original offline and real PostgreSQL layers remain separate. Startup recovery
uses proactive owned-client connection initiation before BullMQ handoff, without
blocking HTTP bootstrap. No production queue or business feature is introduced.
See [testing and CI](../development/TESTING.md) and PROGRESS.md for acceptance status.

Phase 1 local acceptance passed in Task 1.4.4: 170 tests plus required quality and
compiled health checks. This is functional local-development closure only, not
production readiness. The existing advisory/exposure restrictions remain; Phase 2
was separately approved through Task 2.3 identity/password persistence and internal
password primitives. Task 2.4 has not started.
