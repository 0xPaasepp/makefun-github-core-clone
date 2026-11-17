// main.ts — the entrypoint: the lifecycle the env settles.
//
// The forge is a server, not a script that finishes: it binds an
// ephemeral port, tells the env that port, then waits until the env
// says the trial is over and exits 0. It imports its own server and
// nothing else: no package, no Node built-in beyond fetch, no model call.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is
//      nothing to talk to, so the program exits 1 at once.
//   2. Create the forge and listen(0): the kernel picks a free port.
//      Never 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register
//      wins; a 409 means another entry already registered, and this
//      process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}.
//      The env answers at once ({"done": false} while the suite runs),
//      so this is a poll, never a held-open request. A failed or slow
//      poll is retried with a short exponential backoff; the process
//      never exits before the env says done.
//   5. Close the forge and exit 0.
//
// The one stderr line (the bound port) is diagnostics only; the env
// never reads it, and nothing in it reaches the state export.

import { Store } from './store.ts';
import { createForge } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one env request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First wait between retries, and the longest. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * One JSON call against the env, retried until it answers. `ok` decides
 * which statuses end the call; anything else is retried, except the
 * statuses in `fatal`, which throw at once.
 */
async function callEnv(
  path: string,
  method: string,
  body: unknown,
  ok: (status: number) => boolean,
  fatal: ReadonlySet<number>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetch(`${ENV_URL}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      res = null;
    }
    if (res !== null) {
      if (ok(res.status)) return res;
      if (fatal.has(res.status)) {
        throw new Error(`env ${method} ${path} answered HTTP ${res.status}: ${await res.text()}`);
      }
    }
    await sleep(retryDelay(attempt));
  }
}

/** Tell the env the port the forge bound. 200 is normal; 409 means a first register already won. */
async function register(port: number): Promise<void> {
  await callEnv('/register', 'POST', { port }, (s) => s === 200 || s === 409, new Set([400, 405]));
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
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

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const store = new Store();
  const forge = createForge(store, TOKEN);
  const port = await forge.listen(0);
  process.stderr.write(`[entry] forge listening on port ${port}\n`);
  await register(port);
  await waitForDone();
  await forge.close();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
