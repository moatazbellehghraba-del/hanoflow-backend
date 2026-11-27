interface DatabaseTargetEnvironment {
  DATABASE_URL?: string;
  TEST_DATABASE_URL?: string;
  POSTGRES_PORT?: string;
  POSTGRES_USER?: string;
  DATABASE_RUNTIME_USER?: string;
}

// Run before creating any client: these tests are local/CI infrastructure tests,
// never a general-purpose probe of arbitrary databases.
export function getTestDatabaseUrl(env: DatabaseTargetEnvironment): string {
  const fail = (): never => {
    throw new Error(
      'Unsafe database test configuration: use distinct local development and hanoflow_test databases on the configured dedicated PostgreSQL port (default 5434)',
    );
  };
  if (!env.DATABASE_URL || !env.TEST_DATABASE_URL) return fail();
  try {
    const development = new URL(env.DATABASE_URL);
    const test = new URL(env.TEST_DATABASE_URL);
    const port = env.POSTGRES_PORT ?? '5434';
    if (
      !/^\d+$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65535 ||
      ['5432', '5433'].includes(port)
    )
      return fail();
    for (const url of [development, test]) {
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== port ||
        !url.username ||
        ((env.DATABASE_RUNTIME_USER ?? env.POSTGRES_USER) &&
          decodeURIComponent(url.username) !==
            (env.DATABASE_RUNTIME_USER ?? env.POSTGRES_USER))
      )
        return fail();
    }
    if (
      development.username !== test.username ||
      decodeURIComponent(test.pathname) !== '/hanoflow_test' ||
      decodeURIComponent(development.pathname) === '/hanoflow_test' ||
      development.pathname === '/'
    )
      return fail();
    return env.TEST_DATABASE_URL;
  } catch {
    return fail();
  }
}
