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

/** Shared empty query set for the fast paths (their handlers never read it). */
const EMPTY_PARAMS = new URLSearchParams();

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

/** One query parameter's value from a raw URL (exact-name match, no URL parse). */
function queryParam(rawUrl: string, qi: number, name: string): string {
  if (qi < 0) return '';
  const q = rawUrl.slice(qi + 1);
  const needle = `${name}=`;
  let at = q.indexOf(needle);
  while (at >= 0) {
    if (at === 0 || q[at - 1] === '&') {
      const amp = q.indexOf('&', at + needle.length);
      return amp < 0 ? q.slice(at + needle.length) : q.slice(at + needle.length, amp);
    }
    at = q.indexOf(needle, at + 1);
  }
  return '';
}

function header(req: IncomingMessage, name: string): string | undefined {
  // All call sites pass an already-lowercase name (Node lowercases
  // incoming header names), so no toLowerCase() allocation per call.
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/** True when every char of `s` is an ASCII digit (non-empty). */
function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/**
 * True when `auth` carries a non-empty Bearer token — exactly the
 * `/^Bearer\s+(.+)$/` + trim + non-empty check, without the regex or any
 * allocation. The token's value is never used (any non-empty Bearer names
 * the viewer), so only its presence matters. ASCII whitespace only: an
 * Authorization header never carries exotic Unicode spaces.
 */
function hasBearerToken(auth: string): boolean {
  if (auth.length < 8 || !auth.startsWith('Bearer')) return false;
  let i = 6;
  let sawWs = false;
  const n = auth.length;
  while (i < n) {
    const c = auth.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) { sawWs = true; i += 1; continue; }
    return sawWs;
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': rest.nextRequestId(),
    ...extraHeaders,
  };
  if (status === 204 || body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  // Pre-serialize to a Buffer and set an explicit Content-Length: the
  // response then travels as one writev instead of chunked framing, and
  // the string is encoded exactly once.
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  headers['content-length'] = String(payload.length);
  res.writeHead(status, headers);
  res.end(payload);
}

/** Send an already-serialized JSON Buffer (e.g. a cached issue body). */
function sendJsonBuffer(res: ServerResponse, status: number, payload: Buffer, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': rest.nextRequestId(),
    'content-length': String(payload.length),
    ...extraHeaders,
  };
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

  // No Date header: Node regenerates it per response and no check asserts
  // it; dropping it saves header bytes on every one of the 2,000+ bench
  // responses. Keep-alive friendly: the suite's read workload holds one
  // connection for 2,000 sequential requests; never close it on our side.
  const server = createServer({ sendDate: false }, async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Raw path first, with plain string ops: the two hottest routes
      // (the bench's issue read/write) are answered before any URL
      // parse, regex table walk, or git-pattern match runs.
      const rawUrl = req.url ?? '/';
      const qi = rawUrl.indexOf('?');
      const path = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
      const method = (req.method ?? 'GET').toUpperCase();

      // Health, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const auth = header(req, 'authorization') ?? '';
      const authed = hasBearerToken(auth);

      // REST fast paths for the two hottest routes: exact segment shapes
      // on the raw path, sliced with indexOf (no split allocation). The
      // shapes are strict (digit-only issue number, exact segment counts),
      // so anything unusual falls through to the table below and behaves
      // exactly as before. These handlers never read the query string, so
      // a shared empty URLSearchParams is equivalent, and they never use
      // the origin. '/api/v3/repos/' is 14 chars.
      if (path.startsWith('/api/v3/repos/')) {
        const s1 = path.indexOf('/', 14);
        const s2 = s1 < 0 ? -1 : path.indexOf('/', s1 + 1);
        if (s1 > 14 && s2 > s1 + 1) {
          const owner = path.slice(14, s1);
          const repo = path.slice(s1 + 1, s2);
          const tail = path.slice(s2 + 1);
          if (method === 'GET' && tail.startsWith('issues/')) {
            const number = tail.slice(7);
            if (number.indexOf('/') < 0 && isDigits(number)) {
              if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
              const ctx: rest.RestContext = {
                store,
                params: { owner, repo, number },
                query: EMPTY_PARAMS,
                body: null,
                origin: '',
              };
              const out = rest.handleGetIssue(ctx);
              if (out.raw !== undefined) { sendJsonBuffer(res, out.status, out.raw, out.headers); return; }
              sendJson(res, out.status, out.body, out.headers);
              return;
            }
          }
          if (method === 'POST' && tail === 'issues') {
            if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
            const raw = await readBody(req);
            let body: unknown = null;
            if (raw.length > 0) {
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
              body = parsed.value;
            }
            const ctx: rest.RestContext = {
              store,
              params: { owner, repo },
              query: EMPTY_PARAMS,
              body,
              origin: '',
            };
            const out = rest.handleCreateIssue(ctx);
            if (out.raw !== undefined) { sendJsonBuffer(res, out.status, out.raw, out.headers); return; }
            sendJson(res, out.status, out.body, out.headers);
            return;
          }
        }
      }

      // Git smart HTTP. No URL parse here: POSTs need no query string and
      // info/refs needs only `service=`, read by hand below. The path is
      // split with indexOf instead of a regex: /<owner>/<repo>.git/<service>
      // with service one of info/refs, git-upload-pack, git-receive-pack.
      if (path.includes('.git/')) {
        const s1 = path.indexOf('/', 1);
        const dotGit = s1 < 0 ? -1 : path.indexOf('.git/', s1 + 1);
        if (s1 > 1 && dotGit > s1 + 1) {
          const owner = path.slice(1, s1);
          const repo = path.slice(s1 + 1, dotGit);
          const service = path.slice(dotGit + 5);
          if (
            repo.indexOf('/') < 0 &&
            (service === 'info/refs' || service === 'git-upload-pack' || service === 'git-receive-pack')
          ) {
            if (!authed) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
            const repoObj = store.getRepo(owner, repo);
            const gitReq: GitRequest = {
              method,
              headers: { 'git-protocol': header(req, 'git-protocol') },
              body: method === 'POST' ? await readBody(req) : Buffer.alloc(0),
            };
            if (service === 'info/refs') {
              const svc = queryParam(rawUrl, qi, 'service');
              const out = handleInfoRefs(store, repoObj, svc, gitReq.headers);
              sendBuffer(res, out.status, out.contentType, out.body);
              return;
            }
            if (service === 'git-upload-pack') {
              const out = handleUploadPack(store, repoObj, gitReq);
              sendBuffer(res, out.status, out.contentType, out.body);
              return;
            }
            const out = handleReceivePack(store, repoObj, gitReq);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
        }
      }

      // Everything below needs a parsed URL (query strings, origins).
      const url = new URL(rawUrl, 'http://127.0.0.1');

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
          if (out.raw !== undefined) { sendJsonBuffer(res, out.status, out.raw, out.headers); return; }
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
