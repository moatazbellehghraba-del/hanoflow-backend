# Hybrid API infrastructure

## Implemented architecture

The NestJS modular monolith serves internal code-first GraphQL at POST /graphql and external versioned REST at /api/v1. ApiGraphqlModule owns Apollo configuration; feature modules own resolvers/controllers and their shared application services. HealthResolver and HealthController call the same HealthService.getLiveness(), while REST readiness calls HealthService.getReadiness(). Neither transport exposes Prisma directly. There are no business entities, production mutations, authentication or tenant resolution.

The installed integration is @nestjs/graphql 14.2.1, @nestjs/apollo 14.2.1, Apollo Server 5.5.2, @as-integrations/express5 1.1.2 and graphql 16.15.0. Peer ranges support Nest 12.6, TypeScript 6, Express 5 and the existing Node 24 runtime. Optional schema-first/federation/alternative-adapter peers are not installed. No forced peers, legacy Apollo packages or new overrides are used; the pre-existing Prisma Effect override is retained.

## Routes and schema generation

- POST /graphql executes GraphQL operations. It is not URI-versioned.
- GET /graphql serves GraphiQL only in development; normal GraphQL HTTP/CSRF rules otherwise apply.
- GET /api/v1/health returns application liveness without a database query.
- GET /api/v1/health/ready checks PostgreSQL and Redis connectivity.

The Apollo driver explicitly uses path /graphql and useGlobalPrefix false, registering an exact adapter route independently of Nest's REST prefix and versioning. No REST-prefix exclusion or duplicate /api/graphql, /api/v1/graphql or /graphql/extra endpoint is introduced. Tests verify those alternatives return 404.

Nest decorators define types and resolvers. Explicit decorator type functions avoid ambiguous ESM reflection. autoSchemaFile true builds the schema in memory at application initialization, and sortSchema true produces deterministic lexicographic order. No generated SDL file is committed or written at runtime. This avoids checkout drift, concurrent worker writes and writable-filesystem requirements in production. Compilation preserves decorator metadata; the compiled application generates the same operational schema at startup. Tests inspect GraphQLSchemaHost and compare its printed schema with a sorted schema. Future schema review artifacts can be exported in a separately approved tooling task.

The production verification schema is equivalent to:

```graphql
type HealthStatus {
  status: String!
}

type Query {
  health: HealthStatus!
}
```

## Environment policy

Configuration uses the existing ConfigService and validated NODE_ENV. No additional environment switches or production URLs are needed. Development enables GraphiQL (the current supported IDE) and introspection explicitly. Test and production disable both. Stack trace inclusion is disabled in every environment; error sanitization remains enabled even locally. Deprecated GraphQL Playground configuration is not used. Test-only verification resolvers are not included in the production module or build.

## Request context and correlation

Shared HTTP setup assigns a fresh UUID to every REST/GraphQL request, returns x-request-id and records a completion event with ID, method, query-free path, status and elapsed milliseconds. Incoming correlation headers are deliberately ignored. IDs are diagnostic metadata, never proof of identity. JSON formatting comes from the existing application logger. Request bodies, headers, variables, URL query strings and raw exceptions are not logged.

ApiGraphqlContext contains only req (the Express request) and requestId. The context factory reuses the server-assigned ID. An Apollo lifecycle plugin attaches it to GraphQL execution, parse and validation errors once an operation context exists. Earlier HTTP failures, including body-parser/CSRF/batching failures, may have only the response correlation header and completion log; clients should always retain x-request-id.

Future authentication must establish a trusted principal in a guard/middleware before exposing it through typed context. Future tenant resolution must derive tenant scope from that principal and explicit authorization. Arbitrary request headers/arguments, including any tenant identifier, must never establish trusted tenant context. No user, tenant, role or session objects are fabricated now.

## Validation and errors

The global ValidationPipe still transforms decorated DTOs, rejects unknown properties and excludes validation target/value objects. GraphQL input classes need @InputType/@Field plus class-validator rules; GraphQL type coercion alone does not enforce application constraints such as minimum length. Test-only input fixtures verify that the same global pipe runs during GraphQL execution. REST DTO behavior and its statusCode/message/path/timestamp error envelope are preserved.

The global exception filter checks transport before accessing request/response objects. REST keeps its existing envelope. GraphQL resolver exceptions become GraphQLError values with safe messages and codes; the filter never sends an HTTP response from a GraphQL execution context. Unexpected/server errors log only an event, safe code and correlation ID. Apollo's error logger also emits generic events rather than raw internal messages.

The final GraphQL formatter whitelists message, locations, path and safe code/requestId extensions. It omits stack traces, originalError, SQL details, variable values and arbitrary extensions. HTTP exceptions map to BAD_USER_INPUT, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT or SERVICE_UNAVAILABLE as appropriate. Unexpected failures use INTERNAL_SERVER_ERROR. Deliberate public client-error codes supplied via an HttpException response code field are preserved if they match the documented uppercase identifier syntax; their raw messages are still masked. Treat such codes as a public contract, never as a place for private data.

GraphQL keeps standard HTTP semantics: malformed/invalid documents and variable coercion failures return 400; execution failures return a GraphQL data/errors response with HTTP 200, including null propagation. REST readiness remains HTTP 503. Transport failures before GraphQL execution, such as oversized bodies, use HTTP errors and need not have a GraphQL operation response. GraphQL errors are never forced into the REST envelope.

## Security foundations and deferred work

Implemented coarse protections:

- Explicit 100 KB JSON and URL-encoded body limits in shared Express setup.
- Apollo CSRF prevention enabled; clients should POST application/json.
- HTTP operation batching disabled; automatic persisted queries disabled until a reviewed policy exists.
- Maximum 2,000 parse tokens, depth 20 and 500 expanded fields per operation. Fragment use and aliases count each time; cyclic fragments cannot recurse indefinitely in the custom rule and are rejected by standard GraphQL validation.
- Explicit environment-specific introspection/IDE policy and sanitized errors/logging.

The standard graphql-js introspection query expands to depth 15 and 220 fields, so the coarse ceilings intentionally accommodate normal development tooling. A full introspection HTTP test prevents accidental tooling breakage. These limits bound syntax/traversal, not database cost: list cardinality, fan-out, authorization and expensive resolver work need schema-aware controls.

Authentication, authorization, trusted tenant scope, rate limits, pagination/cost budgets, execution deadlines and production network exposure policy belong to separately approved follow-up work before business APIs are exposed. Revisit ceilings and operation allowlisting/persisted-query policy with real application workloads. There are no subscriptions, federation, uploads, business mutations or gateway deployments in this task. This unauthenticated operational foundation is not a claim of production security.

There is one new high production dependency finding: GHSA-c4qx-w738-7hr3 in Apollo's transitive @graphql-tools/utils 12.0.1. Apollo 5.5.2 declares ^10.9.1 || ^11.0.0 || >=12.0.0 <12.0.2; the installed vulnerable branch excludes the patched 12.0.2+ releases. A range-compatible npm update did not resolve it. No forced audit fix, downgrade or new override was applied. Resolve this through a reviewed compatible upstream update before deployment; this task does not assert that the affected code path is unreachable. The existing 18 moderate development findings remain.

## Example requests

```sh
curl -H 'Content-Type: application/json' \
  --data '{"query":"query { health { status } }"}' \
  http://localhost:3000/graphql
# {"data":{"health":{"status":"ok"}}}

curl http://localhost:3000/api/v1/health
# {"status":"ok"}

curl http://localhost:3000/api/v1/health/ready
# {"status":"ok","database":"up","redis":"up"}
```

Use an available PORT if 3000 is occupied. The PostgreSQL host binding remains 127.0.0.1:5434. Keep the existing portable Node activation and ignored credentials documented in README; neither system Node nor permanent PATH is changed.

## Verification strategy

Default offline tests retain all previous cases and add schema initialization/determinism, real HTTP query execution, DTO validation, context metadata, public codes, error and logging sanitization, routing coexistence, size/field/CSRF/batching protections, full development introspection and production IDE/introspection policy. Operational failure/input fixtures are confined to tests. The separate four-test PostgreSQL suite remains real and unmocked.

Live verification uses the compiled production entrypoint against the dedicated development database. It exercises GraphQL and both REST health URLs concurrently, invalid document sanitization/correlation and production introspection. A separate temporary launcher injects one failure into the in-memory health service to test resolver error handling and recovery without adding a production endpoint or modifying source/schema. Temporary application processes are stopped afterward; PostgreSQL stays healthy. See PROGRESS.md for exact executed results. No GitHub Actions execution is claimed.

## References

- [Nest GraphQL quick start and current Apollo integration](https://docs.nestjs.com/graphql/quick-start)
- [GraphQL Tools advisory](https://github.com/advisories/GHSA-c4qx-w738-7hr3)

## Task 1.4.2 health update

GraphQL health schema and liveness semantics are unchanged. REST readiness now
requires PostgreSQL and Redis and adds redis: up to successful responses. Either
dependency failure retains the sanitized 503 envelope. See [Redis architecture](REDIS.md).
The current Task 1.4.2 audit confirms GHSA-7mx3-vvmw-hjmv in Apollo's installed
GraphQL Tools dependency; earlier advisory details above are historical. No security
dependency remediation was performed; production deployment remains blocked.
