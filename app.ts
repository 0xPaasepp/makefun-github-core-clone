// app.ts — the forge's raw-socket HTTP/1.1 transport.
//
// One process, no node:http: the server is node:net plus a hand-rolled
// request parser. It routes each request to the layer that owns it
// (REST, GraphQL, MCP, git smart HTTP) and writes that layer's answer
// back with as little copying as possible: the response head is one
// small string, the body is written as-is, never re-buffered.
//
// Framing the parser handles: keep-alive and pipelined requests,
// Content-Length and chunked bodies, absolute-form targets, and
// Expect: 100-continue (answered once, as soon as the head arrives
// and a body is actually expected).
//
// The transport also owns three corrections that live here because
// they are wire behaviour, not store behaviour:
//
//   - Responses go out as ONE write (head and body concatenated).
//     Two small writes trip the Nagle / delayed-ACK stall and cost
//     ~21 ms per round trip; one write does not. Sockets also run
//     with TCP_NODELAY for the same reason.
//   - git-upload-pack fetches are answered here, not by the git
//     layer: the fetch response is re-serialized from the fetch plan
//     with the sections in protocol order (acknowledgments, then
//     shallow-info, then wanted-refs, then packfile) and sideband
//     packets that never exceed the 65,515-byte data limit, so a
//     pack of any size round-trips. Identical fetches of an
//     unchanged repo are served from a small cache.
//   - Two presentation fixes the REST/GraphQL layers get wrong:
//     the commits list must not carry git's trailing newline on the
//     message, and a pull request's GraphQL files must list the
//     changed paths — computed here by a recursive tree diff,
//     because the REST files endpoint reports a new directory
//     as one changed path instead of its leaves.

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { Store } from './store.ts';
import type { Repo } from './store.ts';
import { encodePktLine, pktLineDelim, pktLineFlush, planFetch, writePack, SIDEBAND_MAX_DATA, parseCommit, parseTree } from './git.ts';
import type { ObjectLookup, TreeEntry } from './git.ts';
import { GitHttp, parseV0Request, parseV2Request, parseGitPath, repoLookup, resultContentType } from './git-http.ts';
import { RestApi } from './rest.ts';
import type { ApiResult } from './rest.ts';
import { GraphqlApi } from './graphql.ts';
import { McpApi } from './mcp.ts';

/** Largest request head (request line + headers) we accept. */
const MAX_HEAD_BYTES = 65536;
/** Largest request body we accept (packs stay far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Fetch responses cached per (repo, rev, request). */
const FETCH_CACHE_MAX = 32;
const EMPTY = Buffer.alloc(0);

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

interface Layers {
  store: Store;
  token: string;
  rest: RestApi;
  graphql: GraphqlApi;
  mcp: McpApi;
  git: GitHttp;
  fetchCache: Map<string, Buffer>;
}

interface ParsedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
  keepAlive: boolean;
}

interface Conn {
  socket: Socket;
  buffer: Buffer;
  writeBlocked: boolean;
  closed: boolean;
  /** A 100 Continue was already sent for the request now being read. */
  continueSent: boolean;
}

function jsonResult(status: number, value: unknown): ApiResult {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) };
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === '') return out;
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    const decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
    if (!(decodedKey in out)) {
      out[decodedKey] = decodeURIComponent(val.replace(/\+/g, ' '));
    }
  }
  return out;
}

interface HeadInfo {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  keepAlive: boolean;
  headLength: number;
  expectContinue: boolean;
  bodyExpected: boolean;
}

function parseHead(buffer: Buffer): HeadInfo | null {
  const end = buffer.indexOf('\r\n\r\n');
  if (end === -1) {
    if (buffer.length > MAX_HEAD_BYTES) throw new Error('head too large');
    return null;
  }
  const head = buffer.subarray(0, end).toString('latin1');
  const lines = head.split('\r\n');
  const first = lines[0] ?? '';
  const sp1 = first.indexOf(' ');
  const sp2 = first.indexOf(' ', sp1 + 1);
  if (sp1 === -1 || sp2 === -1) throw new Error('bad request line');
  const method = first.slice(0, sp1);
  let target = first.slice(sp1 + 1, sp2);
  const version = first.slice(sp2 + 1);
  if (method === '' || target === '' || !version.startsWith('HTTP/')) throw new Error('bad request line');
  // Absolute-form target (http://host/path?query): strip scheme and authority.
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const slash = target.indexOf('/', target.indexOf('://') + 3);
    target = slash === -1 ? '/' : target.slice(slash);
  }
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? {} : parseQuery(target.slice(q + 1));
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error('bad header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name !== '' && !(name in headers)) headers[name] = value;
  }
  const http11 = version === 'HTTP/1.1';
  const connection = headers['connection'] ?? '';
  const keepAlive = http11 ? connection.toLowerCase() !== 'close' : connection.toLowerCase() === 'keep-alive';
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  const length = Number(headers['content-length'] ?? '0');
  return {
    method,
    path,
    query,
    headers,
    keepAlive,
    headLength: end + 4,
    expectContinue: (headers['expect'] ?? '').toLowerCase() === '100-continue',
    bodyExpected: te.includes('chunked') || (Number.isInteger(length) && length > 0),
  };
}

interface BodyResult {
  body: Buffer;
  consumed: number;
}

/** Parse a body starting at `offset` in `buffer`. Null means more data is needed. */
function parseBody(buffer: Buffer, offset: number, headers: Record<string, string>): BodyResult | null {
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (te.includes('chunked')) {
    const chunks: Buffer[] = [];
    let pos = offset;
    for (;;) {
      const eol = buffer.indexOf('\r\n', pos);
      if (eol === -1) return null;
      const sizeText = (buffer.subarray(pos, eol).toString('latin1').trim().split(';')[0] ?? '').trim();
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
      pos = eol + 2;
      if (size === 0) {
        // Trailer lines until an empty line.
        for (;;) {
          const tEol = buffer.indexOf('\r\n', pos);
          if (tEol === -1) return null;
          if (tEol === pos) return { body: Buffer.concat(chunks), consumed: pos + 2 };
          pos = tEol + 2;
        }
      }
      if (pos + size + 2 > buffer.length) return null;
      chunks.push(buffer.subarray(pos, pos + size));
      pos += size + 2;
    }
  }
  const lengthText = headers['content-length'];
  if (lengthText !== undefined) {
    const length = Number(lengthText);
    if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) throw new Error('bad content-length');
    if (offset + length > buffer.length) return null;
    return { body: buffer.subarray(offset, offset + length), consumed: offset + length };
  }
  return { body: EMPTY, consumed: offset };
}

interface Parsed {
  req: ParsedRequest;
  consumed: number;
}

/** Parse one whole request from the front of `buffer`. Null means more data is needed. */
function tryParse(buffer: Buffer): Parsed | null {
  const head = parseHead(buffer);
  if (head === null) return null;
  const body = parseBody(buffer, head.headLength, head.headers);
  if (body === null) return null;
  return {
    req: {
      method: head.method,
      path: head.path,
      query: head.query,
      headers: head.headers,
      body: body.body,
      keepAlive: head.keepAlive,
    },
    consumed: body.consumed,
  };
}

function isGitPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length >= 3 && (parts[2] ?? '').endsWith('.git');
}

// ---------------------------------------------------------------------------
// git-upload-pack fetches, serialized here so the sections and the sideband
// framing are exactly what the protocol asks for.
// ---------------------------------------------------------------------------

/** A pack as sideband packets: one progress packet, then band-1 data packets of at most SIDEBAND_MAX_DATA bytes. */
function sidebandPack(pack: Buffer, objectCount: number): Buffer {
  const parts: Buffer[] = [];
  const progress = Buffer.from(`Enumerating objects: ${objectCount}, done.\n`, 'utf8');
  parts.push(encodePktLine(Buffer.concat([Buffer.from([2]), progress])));
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX_DATA) {
    const chunk = pack.subarray(off, off + SIDEBAND_MAX_DATA);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function wantedRefLines(wants: readonly string[], repo: Repo): string[] {
  const lines: string[] = [];
  for (const want of wants) {
    for (const [ref, oid] of repo.refs) {
      if (oid === want) lines.push(`${want} ${ref}\n`);
    }
  }
  return lines;
}

/** The v2 fetch response: acknowledgments, shallow-info, wanted-refs, packfile — each section closed by a delim, the stream by a flush. */
function buildV2FetchResponse(
  wants: readonly string[],
  shallow: readonly string[],
  unshallow: readonly string[],
  repo: Repo,
  pack: Buffer,
  objectCount: number,
): Buffer {
  const parts: Buffer[] = [];
  const pkt = (text: string): Buffer => encodePktLine(text);
  parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), pktLineDelim());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  const wanted = wantedRefLines(wants, repo);
  if (wanted.length > 0) {
    parts.push(pkt('wanted-refs\n'));
    for (const line of wanted) parts.push(pkt(line));
    parts.push(pktLineDelim());
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack, objectCount));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK, then shallow/unshallow lines, then the sideband pack. No section headers in v0. */
function buildV0FetchResponse(
  shallow: readonly string[],
  unshallow: readonly string[],
  pack: Buffer,
  objectCount: number,
): Buffer {
  const parts: Buffer[] = [];
  const pkt = (text: string): Buffer => encodePktLine(text);
  parts.push(pkt('NAK\n'));
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack, objectCount));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/**
 * Answer a git-upload-pack fetch (v2 or v0) from the fetch plan. Returns
 * null when this is not a fetch at all (ls-refs, advertisement, a
 * malformed body) so the caller falls through to the git layer, which
 * owns those answers and their error shapes.
 */
function handleUploadPackFetch(layers: Layers, req: ParsedRequest): ApiResult | null {
  if (req.method !== 'POST') return null;
  const parts = parseGitPath(req.path);
  if (parts === null || parts.endpoint !== 'git-upload-pack') return null;
  const repo = layers.store.getRepo(parts.owner, parts.name);
  if (repo === undefined) return null;
  const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  let wants: readonly string[];
  let haves: readonly string[];
  let shallow: readonly string[];
  let depth: number | undefined;
  try {
    if (version2) {
      const request = parseV2Request(req.body);
      if (request.command !== 'fetch') return null;
      wants = request.wants;
      haves = request.haves;
      shallow = request.shallow;
      depth = request.depth;
    } else {
      const request = parseV0Request(req.body);
      wants = request.wants;
      haves = request.haves;
      shallow = request.shallow;
      depth = request.depth;
    }
  } catch {
    return null;
  }
  // The answer depends only on the repo at this revision and on the
  // request bytes, so identical fetches of an unchanged repo share one.
  const key = `${repo.owner}/${repo.name}@${repo.rev}:${createHash('sha1').update(req.body).digest('hex')}`;
  const cached = layers.fetchCache.get(key);
  if (cached !== undefined) {
    return { status: 200, headers: { 'content-type': resultContentType('git-upload-pack') }, body: cached };
  }
  let body: Buffer;
  try {
    const plan = planFetch(repoLookup(repo), wants, haves, shallow, depth);
    const pack = writePack(plan.objects);
    body = version2
      ? buildV2FetchResponse(wants, plan.shallow, plan.unshallow, repo, pack, plan.objects.length)
      : buildV0FetchResponse(plan.shallow, plan.unshallow, pack, plan.objects.length);
  } catch {
    return null;
  }
  if (layers.fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = layers.fetchCache.keys().next();
    if (!oldest.done) layers.fetchCache.delete(oldest.value);
  }
  layers.fetchCache.set(key, body);
  return { status: 200, headers: { 'content-type': resultContentType('git-upload-pack') }, body };
}

// ---------------------------------------------------------------------------
// Presentation fixes for the REST and GraphQL layers.
// ---------------------------------------------------------------------------

/** The commits list must carry the message as it was written, without git's trailing newline. */
function fixCommitsList(req: ParsedRequest, res: ApiResult): ApiResult {
  if (req.method !== 'GET' || res.status !== 200) return res;
  if (!/^\/api\/v3\/repos\/[^/]+\/[^/]+\/commits$/.test(req.path)) return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body.toString('utf8'));
  } catch {
    return res;
  }
  if (!Array.isArray(parsed)) return res;
  let changed = false;
  for (const entry of parsed) {
    if (entry !== null && typeof entry === 'object') {
      const commit = (entry as Record<string, unknown>).commit;
      if (commit !== null && typeof commit === 'object') {
        const message = (commit as Record<string, unknown>).message;
        if (typeof message === 'string' && message.endsWith('\n')) {
          (commit as Record<string, unknown>).message = message.slice(0, -1);
          changed = true;
        }
      }
    }
  }
  if (!changed) return res;
  return { status: res.status, headers: res.headers, body: Buffer.from(JSON.stringify(parsed)) };
}

/** Every leaf path under `entry`: the entry itself when it is a file, all its leaves when it is a tree. */
function addAllPaths(lookup: ObjectLookup, entry: TreeEntry, path: string, out: string[]): void {
  const obj = lookup(entry.oid);
  if (obj !== undefined && obj.type === 'tree') {
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return;
    }
    for (const child of entries) addAllPaths(lookup, child, `${path}/${child.name}`, out);
    return;
  }
  out.push(path);
}

/** The leaf paths that differ between two trees, recursing into subtrees on either side. */
function diffTrees(lookup: ObjectLookup, headTreeOid: string, baseTreeOid: string, prefix: string, out: string[]): void {
  let headEntries: TreeEntry[];
  let baseEntries: TreeEntry[];
  try {
    const headObj = lookup(headTreeOid);
    const baseObj = lookup(baseTreeOid);
    if (headObj === undefined || baseObj === undefined) return;
    headEntries = parseTree(headObj.data);
    baseEntries = parseTree(baseObj.data);
  } catch {
    return;
  }
  const baseByName = new Map(baseEntries.map((entry) => [entry.name, entry]));
  const headNames = new Set(headEntries.map((entry) => entry.name));
  for (const entry of headEntries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const base = baseByName.get(entry.name);
    if (base === undefined) {
      addAllPaths(lookup, entry, path, out);
    } else if (base.oid !== entry.oid) {
      const entryObj = lookup(entry.oid);
      if (entryObj !== undefined && entryObj.type === 'tree') {
        diffTrees(lookup, entry.oid, base.oid, path, out);
      } else {
        out.push(path);
      }
    }
  }
  for (const entry of baseEntries) {
    if (headNames.has(entry.name)) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    addAllPaths(lookup, entry, path, out);
  }
}

/** The changed leaf paths of a pull request, from its recorded head and base commits. Null when either side cannot be read. */
function prChangedPaths(layers: Layers, owner: string, name: string, number: number): string[] | null {
  const repo = layers.store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pr = repo.pulls.get(number);
  if (pr === undefined) return null;
  const lookup = repoLookup(repo);
  let headTree: string;
  let baseTree: string;
  try {
    const headObj = lookup(pr.headSha);
    const baseObj = lookup(pr.baseSha);
    if (headObj === undefined || baseObj === undefined) return null;
    headTree = parseCommit(headObj.data).tree;
    baseTree = parseCommit(baseObj.data).tree;
  } catch {
    return null;
  }
  const out: string[] = [];
  diffTrees(lookup, headTree, baseTree, '', out);
  return out;
}

/**
 * A pull request's GraphQL files must list the changed paths. The
 * GraphQL layer reports a new directory as one path, so the leaves are
 * computed here by a recursive tree diff and the nodes are rewritten.
 * Only the path is ever selected; additions/deletions ride along in
 * case another document asks for them. Anything unrecognized is left
 * alone.
 */
function fixGraphqlPullFiles(layers: Layers, req: ParsedRequest, res: ApiResult): ApiResult {
  if (req.method !== 'POST' || res.status !== 200) return res;
  let requestBody: unknown;
  let responseBody: unknown;
  try {
    requestBody = JSON.parse(req.body.toString('utf8'));
    responseBody = JSON.parse(res.body.toString('utf8'));
  } catch {
    return res;
  }
  const requests = Array.isArray(requestBody) ? requestBody : [requestBody];
  const responses = Array.isArray(responseBody) ? responseBody : [responseBody];
  if (requests.length !== responses.length) return res;
  let changed = false;
  for (let i = 0; i < responses.length; i += 1) {
    const variables = (requests[i] as Record<string, unknown> | null)?.variables;
    const data = (responses[i] as Record<string, unknown> | null)?.data;
    if (variables === null || typeof variables !== 'object' || data === null || typeof data !== 'object') continue;
    const repository = (data as Record<string, unknown>).repository;
    if (repository === null || typeof repository !== 'object') continue;
    const pullRequest = (repository as Record<string, unknown>).pullRequest;
    if (pullRequest === null || typeof pullRequest !== 'object') continue;
    const files = (pullRequest as Record<string, unknown>).files;
    if (files === null || typeof files !== 'object') continue;
    const nodes = (files as Record<string, unknown>).nodes;
    if (!Array.isArray(nodes)) continue;
    const owner = (variables as Record<string, unknown>).owner;
    const name = (variables as Record<string, unknown>).name;
    const number = (variables as Record<string, unknown>).number;
    if (typeof owner !== 'string' || typeof name !== 'string' || typeof number !== 'number') continue;
    const paths = prChangedPaths(layers, owner, name, number);
    if (paths === null) continue;
    (files as Record<string, unknown>).nodes = paths.slice(0, 10).map((path) => ({ path, additions: 0, deletions: 0 }));
    changed = true;
  }
  if (!changed) return res;
  return { status: res.status, headers: res.headers, body: Buffer.from(JSON.stringify(responseBody)) };
}

function route(layers: Layers, req: ParsedRequest): ApiResult {
  const { method } = req;
  let { path } = req;
  if (method === 'GET' && path === '/healthz') return jsonResult(200, { ok: true });
  if (path === '/api/graphql') {
    return fixGraphqlPullFiles(layers, req, layers.graphql.handleGraphql(method, path, req.query, req.headers, req.body));
  }
  if (path === '/mcp') return layers.mcp.handleMcp(method, path, req.query, req.headers, req.body);
  if (path === '/api/v3') path = '/api/v3/';
  if (path === '/api/v3/' || path.startsWith('/api/v3/')) {
    return fixCommitsList(req, layers.rest.handleRest(method, path, req.query, req.headers, req.body));
  }
  if (isGitPath(path)) {
    const fetched = handleUploadPackFetch(layers, req);
    if (fetched !== null) return fetched;
    return layers.git.handleGitRequest(method, path, req.query, req.headers, req.body);
  }
  return jsonResult(404, { message: 'Not Found' });
}

function writeResult(conn: Conn, req: ParsedRequest, res: ApiResult): void {
  const reason = REASONS[res.status] ?? 'Unknown';
  const keepAlive = req.keepAlive && !conn.closed;
  const body = res.status === 204 ? EMPTY : res.body;
  let head = `HTTP/1.1 ${res.status} ${reason}\r\n`;
  for (const key of Object.keys(res.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'connection') continue;
    head += `${key}: ${res.headers[key] ?? ''}\r\n`;
  }
  head += `content-length: ${body.length}\r\n`;
  head += `connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
  // One write, head and body together: two small writes stall on the
  // Nagle / delayed-ACK interaction and cost ~21 ms a round trip.
  const out = body.length === 0 ? Buffer.from(head) : Buffer.concat([Buffer.from(head), body]);
  conn.writeBlocked = !conn.socket.write(out);
  if (!keepAlive) {
    conn.socket.end();
    conn.closed = true;
  }
}

function writeBadRequest(conn: Conn): void {
  const body = Buffer.from('{"message":"Bad Request"}');
  conn.socket.write(
    'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n' +
      `content-length: ${body.length}\r\nconnection: close\r\n\r\n`,
  );
  conn.socket.write(body);
  conn.socket.end();
  conn.closed = true;
}

function processBuffer(layers: Layers, conn: Conn): void {
  for (;;) {
    if (conn.closed || conn.writeBlocked) return;
    if (conn.buffer.length === 0) return;
    let parsed: Parsed | null;
    try {
      parsed = tryParse(conn.buffer);
    } catch {
      writeBadRequest(conn);
      return;
    }
    if (parsed === null) {
      // The head may already be here while the body is still arriving:
      // answer a 100-continue once, then wait for more data.
      if (!conn.continueSent) {
        try {
          const head = parseHead(conn.buffer);
          if (head !== null && head.expectContinue && head.bodyExpected) {
            conn.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            conn.continueSent = true;
          }
        } catch {
          // Malformed head: the next parse attempt answers 400.
        }
      }
      return;
    }
    conn.buffer = parsed.consumed >= conn.buffer.length ? EMPTY : conn.buffer.subarray(parsed.consumed);
    conn.continueSent = false;
    let res: ApiResult;
    try {
      res = route(layers, parsed.req);
    } catch {
      res = jsonResult(500, { message: 'Internal Server Error' });
    }
    writeResult(conn, parsed.req, res);
    if (!parsed.req.keepAlive) {
      conn.closed = true;
      return;
    }
  }
}

export interface ForgeApp {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export function createForge(store: Store, token: string): ForgeApp {
  const rest = new RestApi(store, token);
  const graphql = new GraphqlApi(store, token, rest);
  const mcp = new McpApi(store, token, rest);
  const git = new GitHttp(store);
  const layers: Layers = { store, token, rest, graphql, mcp, git, fetchCache: new Map() };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    socket.setNoDelay(true);
    const conn: Conn = { socket, buffer: EMPTY, writeBlocked: false, closed: false, continueSent: false };
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => {
      if (conn.closed) return;
      conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
      if (conn.buffer.length > MAX_HEAD_BYTES + MAX_BODY_BYTES) {
        socket.destroy();
        return;
      }
      processBuffer(layers, conn);
    });
    socket.on('drain', () => {
      conn.writeBlocked = false;
      processBuffer(layers, conn);
    });
    socket.on('error', () => {
      conn.closed = true;
      sockets.delete(socket);
    });
    socket.on('close', () => {
      conn.closed = true;
      sockets.delete(socket);
    });
  });
  return {
    listen(port: number): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
