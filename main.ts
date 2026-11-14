// github-core-clone-01 entry: a standalone GitHub-compatible git forge.
//
// One process, Node standard library only, no git binary, no outside service.
// It binds an ephemeral port, registers that port with the suite (the env),
// serves git smart HTTP, REST v3, GraphQL and MCP from its own in-memory
// store, long-polls the env's /done, and exits 0 when the trial is over.
//
// Lifecycle (the harness's contract, wire.ts):
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to talk to, so the program exits 1 at once.
//   2. Bind listen(0): the kernel picks a free port. Never 8080 (the env's).
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. First register wins;
//      a 409 means another entry already registered; keep waiting anyway.
//   4. GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0.
// A failed or slow poll is retried with a short exponential backoff; the
// process never exits before the env says done.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  let logged = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) return;
      if (res.status === 409) {
        // Another entry already registered; keep serving and wait for done.
        process.stdout.write('[entry] register answered 409 (already registered); waiting for done\n');
        return;
      }
      if (!logged) {
        process.stderr.write(`[entry] register answered HTTP ${res.status}; retrying\n`);
        logged = true;
      }
    } catch {
      // The env is not answering yet: retry.
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  // A SIGTERM from the harness means the trial is over: close cleanly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
