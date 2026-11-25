# Redis infrastructure

Task 1.4.2 adds Redis connectivity and readiness only. At completion of Task 1.4.2, BullMQ, workers and queues remained unimplemented.
Task 1.4.3 adds their infrastructure foundation without production registrations;
see [queue architecture](QUEUES.md). Caching, business models, authentication and
tenant resolution remain unimplemented.

## Local infrastructure

Compose service `redis` uses `redis:8.2.11-bookworm`, bound only to
`127.0.0.1:6380` by default (`REDIS_PORT`). Internal port is 6379. The
project-scoped `redis-data` volume mounts at `/data`, independently of PostgreSQL.
AOF is enabled with `appendfsync everysec`; default RDB snapshotting is retained.
The memory limit is 256 MiB with `noeviction`: memory pressure rejects writes
rather than silently deleting future queue keys. Redis process overhead and
persistence rewrites need additional host memory. Retention and capacity monitoring
will be required when queues exist. AOF everysec may lose roughly one second of
recent writes after abrupt host failure; this is not a zero-loss guarantee.

PING health checks run every five seconds with a three-second timeout, ten retries
and a ten-second start period. Stop grace is 30 seconds. No automatic restart
policy is configured, matching PostgreSQL. Port 6381 is reserved for future isolated
Redis tests. Task 1.4.4 adds its independent test service; development storage is unchanged.

```sh
docker compose up -d --no-deps --wait redis
docker compose ps
docker compose exec -T redis redis-cli PING
docker compose exec -T redis redis-cli CONFIG GET appendonly appendfsync maxmemory maxmemory-policy
```

The Redis service is unauthenticated local development infrastructure. Keep it
loopback-only and do not expose it publicly. Production requires reviewed
credentials/ACLs, TLS, networking, backups, capacity and recovery procedures.
Do not use `down -v`, flush databases, delete volumes or stop unrelated services.
Starting only Redis does not require restarting PostgreSQL.

## Application boundary

Non-global `RedisModule` explicitly imports configuration and exports only
`RedisService`. Its private `REDIS_PROBE_CLIENT` provider owns one lazy ioredis
6.1.0 client. `HealthModule` explicitly imports RedisModule and DatabaseModule.
There is no application-wide Redis service locator or exported raw client.

Validated `REDIS_URL` is required; the local value is
`redis://127.0.0.1:6380/0`. Supported schemes are redis/rediss, with an explicit
database index 0 through 15. Credentials are decoded; rediss retains normal TLS
certificate verification. Query options, fragments, malformed credentials and
invalid ports are rejected. URLs are parsed through an allowlist rather than
passing arbitrary URL options to the driver. Failures disclose property names only.

`QUEUE_PREFIX` is required and validated as 1–64 lowercase letters/digits/hyphens,
starting with a letter. Local value: `hanoflow-dev`. Task 1.4.3 consumes it through BullMQ configuration; no production queue or key
namespace is created without explicit feature registration. `REDIS_PORT` configures Compose
only: keep the explicit URL synchronized when changing the host port.

The probe disables offline queuing and automatic command replay, allows zero
command retries, bounds connection attempts/initialization at two seconds and
PING commands at one second. An outer deadline also bounds initialization
handshake/DNS delays. Initialization failure is caught; background reconnection
continues with jittered exponential delay capped at five seconds. Readiness fails
immediately unless the client is ready. Errors and connection transitions log only
safe event names, never driver errors, URLs or credentials.

Shutdown immediately disconnects the read-only probe, cancelling reconnection
timers and rejecting pending commands. There are no queued writes to drain.
BullMQ producers and workers use separate connection policies and
ownership; this readiness client must not become a shared worker connection.

## Health contract

- REST `/api/v1/health` stays dependency-free liveness.
- GraphQL `health { status }` retains its schema and liveness semantics.
- REST `/api/v1/health/ready` runs PostgreSQL SELECT 1 and Redis PING concurrently.
  Success is `{"status":"ok","database":"up","redis":"up"}`. Either failure
  returns the existing sanitized HTTP 503 envelope.
- Missing/malformed configuration fails startup. Unreachable Redis permits HTTP
  startup after a bounded attempt, remaining live but unready. Reconnection permits
  later readiness without restarting the application.

PING demonstrates connectivity only; it does not prove disk durability, memory
capacity, available workers, schema state, authorization or tenant isolation.

## Verification boundaries

Default application tests override RedisService and its private client provider;
they cannot contact local Redis. Unit tests use a lazy client with mocked network
methods to verify lifecycle, timeout, recovery-state and cleanup behavior. The
four-test real PostgreSQL suite retains its actual Prisma client and guarded test
database, but overrides only Redis so that it remains PostgreSQL-specific.

Task 1.4.2 verifies development Redis settings and compiled REST/GraphQL health
against live PostgreSQL and Redis. Dedicated automated Redis outage/restart,
persistence recovery and isolated integration tests belong to Task 1.4.4. Neither
database nor Redis is stopped for this task. See PROGRESS.md for exact results.

See [real test setup and CI](../development/TESTING.md) for Task 1.4.4.

Production deployment remains blocked by the pre-existing GraphQL Tools advisory.
Task 1.4.3 was separately approved and adds the BullMQ foundation. Production
deployment remains prohibited; Phase 2 requires separate approval.

## Task 1.4.4 isolated verification

compose.redis-test.yaml uses independent project hanoflow-redis-test, service
redis-test and persistent redis-test-data volume on 127.0.0.1:6381. AOF everysec,
noeviction, memory and health policies match the approved test setup. Its identity
marker is provisioned only after Docker target validation and checked before real
queue construction. The Redis suite verifies actual outages and normal restart
persistence using only this test container; development Redis/PostgreSQL are never
stopped. See the latest progress record for executed acceptance results.
