import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const marker = '.env.rls-test-acceptance';
execFileSync('git', ['check-ignore', '--quiet', '--', marker]);
if (existsSync(marker)) unlinkSync(marker);
// Direct Node execution avoids shell interpolation and does not load any
// administration/migration/fixture configuration into the runtime environment.
for (const args of [
  ['scripts/database-negative-check.mjs'],
  ['scripts/database-bootstrap-check.mjs'],
  ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--runInBand'],
  [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config',
    'jest.database.config.mjs',
    '--runInBand',
  ],
]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeFileSync(
  marker,
  JSON.stringify({
    accepted: true,
    migrationSha256: createHash('sha256')
      .update(
        readFileSync(
          'prisma/migrations/20261127210000_restricted_runtime_rls/migration.sql',
        ),
      )
      .digest('hex'),
    verifiedAt: new Date().toISOString(),
  }),
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Offline and all restricted database suites passed; guarded development acceptance marker written.',
);
