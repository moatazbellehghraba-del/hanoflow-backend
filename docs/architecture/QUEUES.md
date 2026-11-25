# BullMQ infrastructure

Task 1.4.3 integrates BullMQ 6.7.10 and @nestjs/bullmq 12.0.2 with the existing
ioredis 6.1.0 transport. It introduces no business queues, enqueue endpoints,
workers in the production graph, schema changes or business operations.

## Modules and registration

AppModule explicitly imports the non-global QueuesModule once. Its asynchronous
BullModule root configuration uses validated ConfigService values but opens no
connections. Upstream BullModule internally makes its core/configuration global;
this narrow third-party exception was approved. All HanoFlow-owned modules remain
non-global and feature modules must import their queue dependencies explicitly.

The non-global private QueueCoreModule owns one shared QueueRuntime. Registration
modules import it directly, avoiding multiple resource registries and per-module
shutdown budgets. Infrastructure clients are instantiated only inside DI-owned
providers. The Redis readiness client remains separate and unchanged.

- `QueuesModule.registerQueue(name)` wraps native BullModule.registerQueueAsync,
  supplies a dedicated owned producer client and registers native Queue lifecycle
  with QueueRuntime. Native `@InjectQueue(name)` and typed `Queue` injection work.
- `QueuesModule.registerWorker(name, ProcessorClass, imports?)` registers an
  injectable class implementing `QueueProcessor<Data, Result, Name>`. Pass modules
  exporting its application-service dependencies in the imports argument. Workers
  use independent owned connections and start at application bootstrap, after
  event listeners have been attached. They do not block HTTP startup awaiting Redis.
- Use this managed worker convention rather than `@Processor`/WorkerHost or native
  inline processor options: upstream worker shutdown waits without a deadline and
  can inherit producer connection settings. Do not register the same processor
  through both mechanisms.
- Register each producer queue once in its owning feature queue module, and export
  that module's intentional API. Other features should consume the exported
  application service instead of registering duplicate producer ownership.

Future producer services inject their typed native Queue and QueueRuntime through
an explicit `registerQueue` import, then publish through the bounded wrapper:

```typescript
return this.runtime.publish(QUEUE_NAME, JOB_NAME, () =>
  this.queue.add(JOB_NAME, payload, { jobId: stableOperationId }),
);
```

Keep the operation closure limited to one queue write. Direct queue.add bypasses
the outer publication deadline/readiness guard. Map the safe `Queue unavailable`
error to the appropriate application response when actual endpoints are introduced.
No generic repository, business event bus, outbox or notification service is added.

## Configuration and connection ownership

Use existing REDIS_URL and QUEUE_PREFIX; no environment settings were added.
Local prefix is hanoflow-dev. Set distinct prefixes per environment; NODE_ENV does
not silently replace an explicitly configured prefix. Prefixes are namespacing,
not authentication or tenant isolation. Pass prefix through BullMQ, never through
ioredis keyPrefix. Redis remains local port 6380/database 0; test port 6381 is reserved.

| Policy                               | Producer                                     | Worker                                        |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------- |
| Connect timeout                      | 2 seconds                                    | 2 seconds                                     |
| Command timeout                      | 2 seconds                                    | None: blocking commands must remain supported |
| maxRetriesPerRequest                 | 0                                            | null, as required for BullMQ workers          |
| Offline queuing                      | Disabled                                     | Enabled for background reconnection           |
| Automatic unfulfilled-command replay | Disabled                                     | Driver default                                |
| Reconnect delay                      | Exponential with jitter, capped at 5 seconds | Same                                          |

QueueRuntime.publish rejects promptly unless the producer's owned connection is
ready, rejects new publication during shutdown and imposes an outer 2-second
deadline even while BullMQ initialization is pending. Driver/application errors
are replaced with a safe message. A timed-out write may already have reached Redis;
no cancellation or exactly-once delivery guarantee is implied.

OwnedRedis tracks both original connections and BullMQ's blocking duplicates.
Each producer has its own connection; each worker has an original and a separate
blocking connection. No connection is shared with Prisma or RedisService. Error
listeners are attached before network use. Owned connections then start without
blocking bootstrap, before BullMQ receives them: this avoids its lazy-client
initialization promise permanently caching the first failed connect attempt. ioredis legacy reply mapping is explicit
on these clients for stable BullMQ replies. No process-wide BullMQ constructor or
client-factory mutation is used.

## Names, payloads and defaults

Queue names are lowercase kebab-case capability names, maximum 64 characters.
Job names are versioned kebab-case operations, such as verify.v1, maximum 96
characters. Registration and the bounded publisher validate names without echoing
invalid values. Use small, serializable, versioned payloads and runtime validation
at the worker boundary. Do not place credentials or sensitive exception details in
payloads or thrown job errors: Redis retains job data and failure reasons.

| Default             | Value                         |
| ------------------- | ----------------------------- |
| Attempts            | 3 total                       |
| Backoff             | Exponential, initial 1,000 ms |
| Worker concurrency  | 1                             |
| Completed retention | 24 hours or 1,000 jobs        |
| Failed retention    | 7 days or 5,000 jobs          |

Retention is lazy cleanup, not a bound on pending backlog. Retention and stable job
IDs do not replace business idempotency. Future handlers must tolerate duplicate
execution and concurrent attempts. Database/queue atomicity may require an outbox
in a separately approved business task. No QueueScheduler is required or added.

## Logging and correlation

Safe logs contain event/resource/validated queue name, allowlisted job ID and
operation, attemptsMade, and elapsed duration when an active event was observed.
Payload contents, results, variables, credentials and raw errors are omitted.
QueueJobMetadata carries requestId; log it only when it has UUID form. Future HTTP
producers propagate the existing server-assigned ID; non-HTTP producers generate
an operational ID. This metadata provides correlation only, never authorization.

## Shutdown

The root QueuesModule destruction hook invokes the shared runtime before deeper
persistence modules close. QueueCore also has an idempotent fallback destroy hook.
Keep QueuesModule directly in AppModule; feature registration modules import the
core without moving root lifecycle ownership deeper into the graph.

One 30-second budget covers all managed resources:

1. Reject new publication and pause local workers without globally pausing queues.
2. Drain active jobs, tracked through completed/failed events, for up to 29 seconds.
3. Reserve the remaining time for worker close(true) and native queue closure.
4. At completion or deadline, abort cooperative processor signals and forcibly
   disconnect every owned client, including blocking duplicates. Close failures
   are logged safely and do not prevent disconnect cleanup.

The runtime deliberately does not start worker.close(false) and later call
close(true): BullMQ memoizes its first close promise, so that pattern cannot enforce
the deadline. The separate drain phase permits genuine cleanup after timeout.
Native producer shutdown hooks subsequently see already-closed resources.

JavaScript cannot forcibly terminate arbitrary non-cooperative processor code or
undo external side effects. Future processors must honor the supplied AbortSignal,
bound external I/O and remain idempotent. Real outage/shutdown behavior is exercised separately against isolated Redis in
Task 1.4.4; unit mocks alone are not that evidence.

## Test-only fixtures and verification status

`test/fixtures/infrastructure-queue.module.ts` and `infrastructure.processor.ts`
define an infrastructure-verification queue and verify.v1 processor. They are
outside production compilation and are never imported by AppModule. The payload
contains a nonce and requestId, with optional failUntilAttempt from 0 through 2.
The result is deterministic: nonce plus verified true. Controlled failures permit
two failures followed by success on the third attempt.

Offline tests invoke the processor directly, verify module wiring with overridden
queue/runtime providers, and verify policies, deadlines, error sanitization and
shutdown using non-networked clients/mocked workers. They do not execute jobs in
Redis or demonstrate BullMQ retry scheduling.

At Task 1.4.3 closure, no isolated test Redis service existed. Do not initialize the fixture module
against development Redis. Real enqueue/processing, retry timing, stalled recovery,
reconnection, persistence, real deadline cleanup and Redis CI remain Task 1.4.4.
That task must establish a dedicated guarded loopback test instance on 6381,
verified instance identity and per-run prefixes before constructing real queues.
No live Redis job tests were skipped or claimed passed in Task 1.4.3; no such suite
is introduced yet. See PROGRESS.md for actual results.

Production deployment remains blocked by the existing GraphQL Tools advisory.
Authentication, tenant scope, rate/cost controls and business behavior remain future
work. Phase 2 requires separate approval.

## Task 1.4.4 real suite

The dedicated test project, marker, guarded lifecycle commands and real queue suite
are now implemented; see [testing and CI](../development/TESTING.md). Test fixtures
add test-only permanent-failure and held-job controls. Held jobs can be released
for drain verification or cooperatively cancelled at shutdown. None is included in
production compilation. Native BullMQ 6 backend APIs and Redis client inventories
verify closure without accessing protected fields or forcing Jest exit.

Real startup-outage verification found that giving BullMQ an untouched lazy client
let its initialization cache the first connect rejection despite later driver
reconnection. QueueRuntime now starts owned connections after error listeners and
before handing them off. The application still does not await Redis indefinitely;
the same queue and worker can initialize after recovery. Offline and real
regressions cover this narrow correction; dependencies/architecture are unchanged.

Queue connections now have prefix/role names for operational cleanup verification.
Current-run cleanup revalidates identity and unlinks only its generated prefixes.
The marker and other prefixes are preserved. Readiness, liveness and production
schema contracts remain unchanged. See PROGRESS.md for results, timings and limits.
