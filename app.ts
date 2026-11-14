// HTTP server: routing, body reading, auth, and JSON plumbing for the
// forge. Dispatches to the REST, GraphQL, MCP and git smart-HTTP modules.
//
// Auth: any non-empty `Authorization: Bearer <token>` names the viewer
// ("adaiversen"); a missing or empty token is 401 on every surface except
// GET /healthz. The suite's token is opaque and the scenario is fixed, so
// no token database is needed.
//
// Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id, including errors. Unknown routes are 404 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './git-http.ts';
import * as rest from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': rest.nextRequestId(),
    ...extraHeaders,
  };
  const payload = status === 204 || body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, headers);
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: rest.RestContext) => rest.RestResult;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/v3\/$/, handler: rest.handleRoot },
  { method: 'GET', pattern: /^\/api\/v3\/meta$/, handler: rest.handleMeta },
  { method: 'GET', pattern: /^\/api\/v3\/user$/, handler: rest.handleUser },
  { method: 'POST', pattern: /^\/api\/v3\/user\/repos$/, handler: rest.handleCreateRepo },
  { method: 'GET', pattern: /^\/api\/v3\/user\/repos$/, handler: rest.handleListUserRepos },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/, handler: rest.handleGetRepo },
  { method: 'PATCH', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/, handler: rest.handlePatchRepo },
  { method: 'DELETE', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/, handler: rest.handleDeleteRepo },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/contents\/?(?<path>.*)$/, handler: rest.handleGetContents },
  { method: 'PUT', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/contents\/(?<path>.+)$/, handler: rest.handlePutContents },
  { method: 'DELETE', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/contents\/(?<path>.+)$/, handler: rest.handleDeleteContents },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/git\/refs$/, handler: rest.handleCreateRef },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/branches$/, handler: rest.handleListBranches },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/branches\/(?<branch>.+)$/, handler: rest.handleGetBranch },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/git\/refs\/heads\/(?<branch>.+)$/, handler: rest.handleGetRef },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/commits$/, handler: rest.handleListCommits },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/labels$/, handler: rest.handleCreateLabel },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/labels$/, handler: rest.handleListLabels },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues$/, handler: rest.handleCreateIssue },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues$/, handler: rest.handleListIssues },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<number>\d+)$/, handler: rest.handleGetIssue },
  { method: 'PATCH', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<number>\d+)$/, handler: rest.handlePatchIssue },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<number>\d+)\/comments$/, handler: rest.handleCreateComment },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<number>\d+)\/comments$/, handler: rest.handleListComments },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls$/, handler: rest.handleCreatePull },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls$/, handler: rest.handleListPulls },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls\/(?<number>\d+)$/, handler: rest.handleGetPull },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls\/(?<number>\d+)\/files$/, handler: rest.handleListPullFiles },
  { method: 'PUT', pattern: /^\/api\/v3\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls\/(?<number>\d+)\/merge$/, handler: rest.handleMergePull },
];

export function createApp(): Server {
  const store = new Store();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      // Health, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const auth = header(req, 'authorization') ?? '';
      const bearer = /^Bearer\s+(.+)$/.exec(auth);
      const token = bearer ? bearer[1].trim() : '';
      const authed = token.length > 0;

      // Git smart HTTP.
      const gitMatch = /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\.git\/(?<service>info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch?.groups) {
        if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const repo = store.getRepo(gitMatch.groups.owner, gitMatch.groups.repo);
        const gitReq: GitRequest = {
          method,
          headers: { 'git-protocol': header(req, 'git-protocol') },
          body: method === 'POST' ? await readBody(req) : Buffer.alloc(0),
        };
        if (gitMatch.groups.service === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          const out = handleInfoRefs(store, repo, service, gitReq.headers);
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        if (gitMatch.groups.service === 'git-upload-pack') {
          const out = handleUploadPack(store, repo, gitReq);
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        const out = handleReceivePack(store, repo, gitReq);
        sendBuffer(res, out.status, out.contentType, out.body);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (method === 'DELETE') { sendJson(res, 200, {}); return; }
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const raw = await readBody(req);
        const out = handleMcp(store, raw);
        if (out.body === null) {
          res.writeHead(202, { 'content-type': 'application/json', 'x-github-request-id': rest.nextRequestId() });
          res.end();
          return;
        }
        res.writeHead(out.status, { 'content-type': 'application/json', 'x-github-request-id': rest.nextRequestId() });
        res.end(out.body);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
        const result = executeGraphQL(store, parsed.value);
        sendJson(res, 200, result);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        let body: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
            body = parsed.value;
          }
        }
        // Fast path for the two hottest routes (the bench's read/write):
        // exact segment shapes on the raw path, no regex table walk.
        // The shapes are strict (digit-only issue number, exact segment
        // counts), so anything unusual falls through to the table below
        // and behaves exactly as before. These handlers never read the
        // query string, so an empty URLSearchParams is equivalent.
        const rawUrl = req.url ?? '/';
        const qi = rawUrl.indexOf('?');
        const rawPath = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
        if (rawPath.startsWith('/api/v3/repos/')) {
          const seg = rawPath.split('/');
          if (seg.length === 8 && seg[6] === 'issues' && method === 'GET' && /^\d+$/.test(seg[7])) {
            const ctx: rest.RestContext = {
              store,
              params: { owner: seg[4], repo: seg[5], number: seg[7] },
              query: new URLSearchParams(),
              body,
              origin: `http://${header(req, 'host') ?? '127.0.0.1'}`,
            };
            const out = rest.handleGetIssue(ctx);
            sendJson(res, out.status, out.body, out.headers);
            return;
          }
          if (seg.length === 7 && seg[6] === 'issues' && method === 'POST') {
            const ctx: rest.RestContext = {
              store,
              params: { owner: seg[4], repo: seg[5] },
              query: new URLSearchParams(),
              body,
              origin: `http://${header(req, 'host') ?? '127.0.0.1'}`,
            };
            const out = rest.handleCreateIssue(ctx);
            sendJson(res, out.status, out.body, out.headers);
            return;
          }
        }
        for (const route of routes) {
          if (route.method !== method) continue;
          const m = route.pattern.exec(path);
          if (!m) continue;
          const ctx: rest.RestContext = {
            store,
            params: (m.groups ?? {}) as Record<string, string>,
            query: url.searchParams,
            body,
            origin: `http://${header(req, 'host') ?? '127.0.0.1'}`,
          };
          const out = route.handler(ctx);
          sendJson(res, out.status, out.body, out.headers);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // The socket is gone; nothing more to do.
      }
    }
  });

  // Keep-alive friendly: the suite's read workload holds one connection
  // for 2,000 sequential requests; never close it on our side.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  void VIEWER_LOGIN;
  return server;
}
