import 'reflect-metadata';
import assert from 'node:assert/strict';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { NestFactory } from '@nestjs/core';
import { IdentityModule } from '../dist/modules/identity/identity.module.js';
import { PasswordHasher } from '../dist/modules/identity/passwords/password-hasher.service.js';
import {
  PASSWORD_HASH_OPTIONS,
  PASSWORD_CAPACITY,
} from '../dist/modules/identity/passwords/password.config.js';

// Offline benchmark: no persistence, HTTP, Redis or credential output.
async function benchmark() {
  const app = await NestFactory.createApplicationContext(IdentityModule, {
    logger: false,
  });
  const hasher = app.get(PasswordHasher);
  const input = 'Synthetic benchmark 😀 passphrase only';
  const samples = 20;
  const hashTimes = [];
  const verifyTimes = [];
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const timed = async (operation) => {
    const start = performance.now();
    const result = await operation();
    return { elapsed: performance.now() - start, result };
  };
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) =>
      Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(2));
    return {
      samples: sorted.length,
      medianMs: Number(((sorted[9] + sorted[10]) / 2).toFixed(2)),
      p95Ms: at(0.95),
      maxMs: at(1),
    };
  };
  try {
    // Warm-up native loading, random generation and one verification before timing.
    const warm = await hasher.hash(input);
    assert.equal((await hasher.verify(input, warm)).status, 'match');
    for (let index = 0; index < samples; index++) {
      const hashed = await timed(() => hasher.hash(input));
      hashTimes.push(hashed.elapsed);
      const verified = await timed(() => hasher.verify(input, hashed.result));
      assert.equal(verified.result.status, 'match');
      verifyTimes.push(verified.elapsed);
    }
    const start = performance.now();
    const burst = await Promise.allSettled(
      Array.from({ length: 4 }, () => hasher.hash(input)),
    );
    const burstMs = performance.now() - start;
    const rejected = burst.filter((value) => value.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'PASSWORD_CAPACITY_EXHAUSTED');
    console.log(
      JSON.stringify(
        {
          runtime: {
            node: process.version,
            platform: platform(),
            arch: arch(),
            osRelease: release(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
            uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'default (4)',
          },
          profile: PASSWORD_HASH_OPTIONS,
          capacity: PASSWORD_CAPACITY,
          hash: summary(hashTimes),
          verify: summary(verifyTimes),
          concurrentBurst: {
            submitted: 4,
            completed: 3,
            rejected: 1,
            elapsedMs: Number(burstMs.toFixed(2)),
            nativeConcurrency: PASSWORD_CAPACITY.active,
          },
          memory: {
            baselineRssMiB: Number((baselineRss / 1024 / 1024).toFixed(2)),
            sampledPeakRssMiB: Number((peakRss / 1024 / 1024).toFixed(2)),
            finalRssMiB: Number(
              (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
            ),
            samplingIntervalMs: 5,
          },
          limitations:
            'Local sequential samples plus one bounded burst; p95 uses nearest rank. RSS is whole-process sampled memory, not a production capacity guarantee.',
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(sampler);
    await app.close();
  }
}
benchmark().catch(() => {
  console.error(
    'Password benchmark failed; no credential diagnostics are emitted.',
  );
  process.exitCode = 1;
});
