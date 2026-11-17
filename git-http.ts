// git-http.ts — the git smart-HTTP layer.
//
// Serves a repository's git endpoints, over plain HTTP:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack  (v0 or v2 advertisement)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack (v0 advertisement only)
//   POST /{owner}/{repo}.git/git-upload-pack                     (fetch, v2 or v0)
//   POST /{owner}/{repo}.git/git-receive-pack                    (push, v0, with report-status)
//
// The wire contract comes from the kit (sdk/conformance), not from memory:
// - v0 advertisements carry the "# service=..." preamble and the capability list after
//   a NUL on the first ref line; peeled annotated tags appear as separate `oid ref^{}`
//   lines; HEAD is a bare `oid HEAD` line, its symref read from the `symref=` capability.
//   An empty repository advertises one `0000... capabilities^{}` pseudo-ref carrying
//   the capabilities. The receive-pack advertisement uses its own service name,
//   content type and capability set (report-status, side-band-64k, delete-refs).
// - v2 advertisements carry no refs at all: `version 2`, capability lines, delim, flush.
//   Refs come from the ls-refs command, one line per ref, with `symref-target:` on the
//   HEAD line and `peeled:` on an annotated tag's own line. Ref-prefix filtering is
//   server-side: a prefix answers only refs whose name starts with it (so HEAD drops
//   out of a `refs/heads/` answer). An empty repository answers the `unborn` argument
//   with `unborn HEAD symref-target:refs/heads/main`.
// - A v2 fetch answers four named sections in order — `acknowledgments`, `shallow-info`,
//   `wanted-refs`, `packfile` — each opened by its name as a pkt-line and closed by a
//   delimiter (the packfile section ends with a flush). A v0 fetch has no section
//   names: NAK/ACK/shallow lines first, then the sideband pack directly.
// - A push body is a pkt-line command list, a flush, then raw pack bytes. The command
//   parser therefore stops at the raw pack (allowTrailing) instead of trying to frame
//   it; a delete-only push carries no pack at all. A push applies per ref and reports
//   one status line per ref, after an `unpack ok` (or `unpack <detail>`) line. A
//   repository that does not exist is a 404 on every endpoint. A malformed body is a
//   400 and never kills the server: handleGitRequest never throws.
//
// Responses are capped by git's 65,520-byte pkt-line limit, and the object pack is
// built once per (repo, revision, request) and cached for the bounded window.

import { isObjectId, ZERO_OID, GitError } from './git.ts';
import type { GitObject, ObjectLookup } from './git.ts';
import {
  encodePktLine,
  encodePktLines,
  pktLineFlush,
  pktLineDelim,
  pktLineResponseEnd,
  decodePktLines,
  packetsToLines,
  writePack,
  readPack,
  parseCommit,
  parseTag,
  parseTree,
  isAncestor,
  planFetch,
} from './git.ts';
import type { Repo, Store } from './store.ts';

/** The largest pack-data chunk inside one sideband packet (one byte is the band). */
const SIDEBAND_MAX = 65519;
/** How many (repo, revision, route, params) responses the cache holds. */
const RESPONSE_CACHE_MAX = 256;

/** The two git services this layer serves. */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One of the three git endpoints, after the `{owner}/{repo}.git` prefix. */
export type GitEndpoint = 'info/refs' | 'git-upload-pack' | 'git-receive-pack';

/** What a route match gives back: the repository, the endpoint and its service. */
export interface RouteParts {
  readonly repo: Repo;
  readonly endpoint: GitEndpoint;
  readonly service: GitService;
}

/** A per-ref push status line. */
export type ReceiveStatus =
  | { readonly ref: string; readonly ok: true; readonly newOid: string }
  | { readonly ref: string; readonly ok: false; readonly error: string };

/** A parsed v2 fetch request. */
export interface V2FetchRequest {
  readonly command: string;
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | undefined;
  readonly filters: string[];
}

/** A parsed v0 fetch request. */
export interface V0FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | undefined;
}

/** A parsed push command list, one entry per ref. */
export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** An HTTP reply from the git layer: status, headers and body. */
export interface GitHttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

const NOT_FOUND_BODY = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');

function jsonResult(status: number, body: Buffer | string): GitHttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
  };
}

function notFoundResult(): GitHttpResult {
  return jsonResult(404, NOT_FOUND_BODY);
}

function badRequestResult(message: string): GitHttpResult {
  return jsonResult(400, JSON.stringify({ message }));
}

function internalErrorResult(message: string): GitHttpResult {
  return jsonResult(500, JSON.stringify({ message }));
}

function binaryResult(status: number, contentType: string, body: Buffer): GitHttpResult {
  return {
    status,
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    body,
  };
}

/** The content type of an info/refs advertisement for a service. */
export function advertisementContentType(service: GitService): string {
  return `application/x-${service}-advertisement`;
}

/** The content type of a fetch or push response body. */
export function resultContentType(service: GitService): string {
  return `application/x-${service}-result`;
}

/** The object lookup for one repository: a closure over its objects map. */
export function repoLookup(repo: Repo): ObjectLookup {
  return (oid) => repo.objects.get(oid);
}

function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

/**
 * Match a request path against the git endpoints. `info/refs` is two segments after
 * `{owner}/{repo}.git`, so it is four segments in total; the two pack endpoints are
 * one segment each. Returns null when the path is not a git path at all.
 */
export function parseGitPath(path: string): { owner: string; name: string; endpoint: GitEndpoint } | null {
  const parts = splitPath(path);
  if (parts.length < 3) return null;
  const [owner, repoName] = parts;
  if (!repoName.endsWith('.git')) return null;
  const name = repoName.slice(0, -4);
  if (parts.length === 4 && parts[2] === 'info' && parts[3] === 'refs') {
    return { owner, name, endpoint: 'info/refs' };
  }
  if (parts.length === 3 && (parts[2] === 'git-upload-pack' || parts[2] === 'git-receive-pack')) {
    return { owner, name, endpoint: parts[2] };
  }
  return null;
}

/** True when `name` is a syntactically valid ref name (short form, no `refs/` prefix). */
export function isValidRefName(name: string): boolean {
  if (!name || name.endsWith('/') || name.startsWith('/')) return false;
  if (name.includes('..') || name.includes(' ') || name.includes('\t') || name.includes('\n') || name.includes('\r')) return false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || code === 0x7f) return false;
    if (char === '~' || char === '^' || char === ':' || char === '?' || char === '*' || char === '[' || char === '\\') return false;
  }
  if (name.includes('//')) return false;
  return true;
}

/** True when `ref` is a full ref name `refs/...` with a valid short form after it. */
export function isValidFullRef(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  return isValidRefName(ref.slice(5));
}

/**
 * A ref entry for an advertisement or an ls-refs answer. An annotated tag carries its
 * peeled target here; the v0 formatter expands it into a separate `^{}` line, the v2
 * formatter puts `peeled:` on the tag's own line.
 */
export interface RefAdvertisement {
  readonly ref: string;
  readonly oid: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
}

const REF_SORT_ORDER: Readonly<Record<string, number>> = {
  'refs/heads/': 1,
  'refs/tags/': 2,
  'refs/remotes/': 3,
  'refs/notes/': 4,
};

/** Sort refs the way a reference git advertisement lists them: HEAD first, then heads, tags, the rest. */
export function sortRefsForAdvertisement(refs: readonly RefAdvertisement[]): RefAdvertisement[] {
  const orderOf = (ref: string): number => {
    if (ref === 'HEAD') return 0;
    for (const [prefix, order] of Object.entries(REF_SORT_ORDER)) if (ref.startsWith(prefix)) return order;
    return 5;
  };
  return [...refs].sort((a, b) => {
    const orderA = orderOf(a.ref);
    const orderB = orderOf(b.ref);
    if (orderA !== orderB) return orderA - orderB;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
}

/**
 * Build the ref list for a repository: the default branch's tip (with the HEAD symref
 * line first), every other ref, and the peeled target on an annotated tag's entry.
 * `lookup` resolves tags so their peeled targets are known.
 */
export function buildRefAdvertisement(repo: Repo, lookup: ObjectLookup): RefAdvertisement[] {
  const refs: RefAdvertisement[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid) {
    refs.push({ ref: 'HEAD', oid: headOid, symrefTarget: headRef });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = lookup(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isObjectId(target)) {
        refs.push({ ref: name, oid, peeled: target });
        continue;
      }
    }
    refs.push({ ref: name, oid });
  }
  return sortRefsForAdvertisement(refs);
}

/**
 * One v0 advertisement line: `oid SP name`, with the capability list after a NUL on the
 * first line only. HEAD carries no `symref-target` attribute here — the v0 client reads
 * the symref from the `symref=` capability instead.
 */
function v0AdvertisementLine(ref: RefAdvertisement, capabilities?: string): string {
  const line = `${ref.oid} ${ref.ref}`;
  if (capabilities) return `${line}\u0000${capabilities}\n`;
  return `${line}\n`;
}

/**
 * One v2 ref line: `oid SP name` plus `symref-target:` on the HEAD line and `peeled:`
 * on an annotated tag's own line.
 */
export function v2RefLine(ref: RefAdvertisement): string {
  let line = `${ref.oid} ${ref.ref}`;
  if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
  if (ref.peeled) line += ` peeled:${ref.peeled}`;
  return `${line}\n`;
}

/**
 * The v0 advertisement: `# service=...` preamble, then ref lines, then flush. An empty
 * repository advertises one `capabilities^{}` pseudo-ref carrying the capabilities.
 */
export function buildV0Advertisement(
  repo: Repo,
  lookup: ObjectLookup,
  capabilities: readonly string[],
  service: GitService,
): Buffer {
  const preamble = encodePktLine(`# service=${service}\n`);
  const flush = pktLineFlush();
  const head = Buffer.concat([preamble, flush]);
  const refs = buildRefAdvertisement(repo, lookup);
  const capsText = capabilities.join(' ');
  if (!refs.length) {
    return Buffer.concat([
      head,
      encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capsText}\n`),
      flush,
    ]);
  }
  const parts: Buffer[] = [head];
  refs.forEach((ref, index) => {
    parts.push(encodePktLine(v0AdvertisementLine(ref, index === 0 ? capsText : undefined)));
    if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.ref}^{}\n`));
  });
  parts.push(flush);
  return Buffer.concat(parts);
}

/**
 * The v2 advertisement: `version 2`, then capability lines, then delim, then flush.
 * It carries no refs — those come from the ls-refs command.
 */
export function buildV2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine('agent=forge/1.0\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineDelim(),
    pktLineFlush(),
  ]);
}

/**
 * Build a sideband pack section: the raw pack bytes split into band-1 packets, each
 * under the 65,520-byte limit, with a band-2 progress line before them. An empty pack
 * still yields a single zero-length band-1 packet, so the client sees one pack.
 */
export function buildSidebandPack(pack: Buffer, progress: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  if (!pack.length) {
    parts.push(encodePktLine(Buffer.from([1])));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_MAX, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/**
 * Build a sideband report-status section: the `unpack` line, then one `ok`/`ng` line
 * per ref, then a blank line, all band 1. `unpackDetail` is 'ok' on success and the
 * failure detail when the pack did not unpack.
 */
export function buildSidebandReportStatus(statuses: readonly ReceiveStatus[], unpackDetail = 'ok'): Buffer {
  const parts: Buffer[] = [
    encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`unpack ${unpackDetail}\n`, 'utf8')])),
  ];
  for (const status of statuses) {
    const line = status.ok ? `ok ${status.ref}\n` : `ng ${status.ref} ${status.error}\n`;
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
  }
  parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from('\n', 'utf8')])));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch acknowledgement lines: NAK, then shallow and unshallow lines. */
export function buildV0Acknowledgements(plan: { shallow: readonly string[]; unshallow: readonly string[] }): Buffer {
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  return Buffer.concat(parts);
}

/** The v2 fetch acknowledgement section: name line, NAK, shallow and unshallow lines, then delim. */
export function buildV2Acknowledgements(plan: { shallow: readonly string[]; unshallow: readonly string[] }): Buffer {
  const parts: Buffer[] = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktLineDelim());
  return Buffer.concat(parts);
}

/** The v2 fetch shallow-info section: name line, shallow and unshallow lines, then delim. */
export function buildV2ShallowInfo(plan: { shallow: readonly string[]; unshallow: readonly string[] }): Buffer {
  const parts: Buffer[] = [encodePktLine('shallow-info\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktLineDelim());
  return Buffer.concat(parts);
}

/** The v2 fetch wanted-refs section: name line, one line per want that names a ref, then delim. */
export function buildV2WantedRefs(wants: readonly string[], repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine('wanted-refs\n')];
  for (const want of wants) {
    const ref = [...repo.refs.entries()].find(([, oid]) => oid === want)?.[0];
    if (ref) parts.push(encodePktLine(`${want} ${ref}\n`));
  }
  parts.push(pktLineDelim());
  return Buffer.concat(parts);
}

/**
 * Parse a v2 request body into its command and parameters. The request mixes two
 * shapes: `command=fetch` / `agent=` / `object-format=` are `key=value`, while
 * `want <oid>`, `have <oid>`, `shallow <oid>`, `deepen <n>`, `filter <spec>`,
 * `ref-prefix <prefix>` and the bare words (`thin-pack`, `done`, `peel`, `unborn`)
 * are space-separated. A body that is not pkt-line framed at all throws, so the
 * caller answers 400.
 */
export function parseV2Request(body: Uint8Array): V2FetchRequest {
  const lines = packetsToLines(decodePktLines(body));
  const request: {
    command: string;
    wants: string[];
    haves: string[];
    shallow: string[];
    depth: number | undefined;
    filters: string[];
  } = { command: '', wants: [], haves: [], shallow: [], depth: undefined, filters: [] };
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (line.startsWith('command=')) {
      request.command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) {
      request.wants.push(line.slice(5).trim());
      continue;
    }
    if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
      continue;
    }
    if (line.startsWith('shallow ')) {
      request.shallow.push(line.slice(8).trim());
      continue;
    }
    if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new GitError(`bad deepen value ${JSON.stringify(line.slice(7))}`, 'fetch-deepen');
      request.depth = parsed;
      continue;
    }
    if (line.startsWith('filter ')) {
      request.filters.push(line.slice(7));
      continue;
    }
    if (line === 'done' || line.startsWith('agent=') || line.startsWith('object-format=') || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') {
      continue;
    }
    if (line.startsWith('ref-prefix ') || line === 'peel' || line === 'symrefs' || line === 'unborn') {
      continue;
    }
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      continue;
    }
    throw new GitError(`unexpected line in v2 request: ${JSON.stringify(line)}`, 'fetch-v2-line');
  }
  if (request.command !== 'fetch' && request.command !== 'ls-refs') {
    throw new GitError(`unsupported v2 command ${JSON.stringify(request.command)}`, 'fetch-command');
  }
  if (request.command === 'fetch' && !request.wants.length) throw new GitError('fetch request has no want lines', 'fetch-want');
  return request;
}

/**
 * Parse a v0 fetch request body into its wants, haves, shallow lines and depth. The
 * first want line may carry the capability list after the object id (`want <oid>
 * side-band-64k ...`); only the first token is the want. The body is two sections:
 * wants (+ shallow/deepen) up to a flush, then haves and done up to a second flush.
 */
export function parseV0Request(body: Uint8Array): V0FetchRequest {
  const lines = packetsToLines(decodePktLines(body));
  const request: { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined } = {
    wants: [],
    haves: [],
    shallow: [],
    depth: undefined,
  };
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (line === 'done') continue;
    if (line.startsWith('want ')) {
      request.wants.push(line.slice(5).trim().split(' ')[0]);
      continue;
    }
    if (line.startsWith('shallow ')) {
      request.shallow.push(line.slice(8).trim());
      continue;
    }
    if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new GitError(`bad deepen value ${JSON.stringify(line.slice(7))}`, 'fetch-deepen');
      request.depth = parsed;
      continue;
    }
    if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim().split(' ')[0]);
      continue;
    }
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      continue;
    }
    throw new GitError(`unexpected line in v0 fetch request: ${JSON.stringify(line)}`, 'fetch-v0-line');
  }
  if (!request.wants.length) throw new GitError('fetch request has no want lines', 'fetch-want');
  return request;
}

/**
 * Parse a push command list: one `old new ref` line per ref, capabilities after NUL
 * on the first. The body continues with raw pack bytes after the flush that ends the
 * commands, so framing stops there (allowTrailing) instead of trying to parse the
 * pack as pkt-lines.
 */
export function parsePushCommands(body: Uint8Array): PushCommand[] {
  const lines = packetsToLines(decodePktLines(body, { allowTrailing: true }));
  const commands: PushCommand[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
    if (!line) break;
    const nul = line.indexOf('\u0000');
    const commandText = nul < 0 ? line : line.slice(0, nul);
    const parts = commandText.split(' ');
    if (parts.length !== 3) throw new GitError(`bad push command ${JSON.stringify(commandText)}`, 'push-command');
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new GitError(`push command has a bad object id: ${JSON.stringify(commandText)}`, 'push-command');
    }
    if (!isValidFullRef(ref)) throw new GitError(`push command names an invalid ref ${JSON.stringify(ref)}`, 'push-ref');
    commands.push({ oldOid, newOid, ref });
  }
  if (!commands.length) throw new GitError('push command list is empty', 'push-command');
  return commands;
}

/** Read a packfile off the end of a push body: everything after the flush that ended the commands. */
export function extractPackFromBody(body: Uint8Array): Buffer {
  const packets = decodePktLines(body, { allowTrailing: true });
  const offset = packets.reduce((total, packet) => total + (packet.kind === 'data' ? packet.raw.length : 4), 0);
  return Buffer.from(body).subarray(offset);
}

/**
 * The class that serves git smart HTTP for a store. Route the request into
 * `handleGitRequest`, which never throws.
 */
export class GitHttp {
  /** Bounded cache of advertisement/fetch responses, keyed by repo/rev/route/params. */
  private responseCache = new Map<string, GitHttpResult>();
  /** The store this layer serves. */
  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** The number of entries currently held in the response cache (for tests and tuning). */
  cacheSize(): number {
    return this.responseCache.size;
  }

  /** Empty the response cache. */
  clearCache(): void {
    this.responseCache.clear();
  }

  /** Look a repository up by owner and name from a request path. */
  route(path: string): RouteParts | null {
    const matched = parseGitPath(path);
    if (!matched) return null;
    const repo = this.store.getRepo(matched.owner, matched.name);
    if (!repo) return null;
    const service: GitService = matched.endpoint === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
    return { repo, endpoint: matched.endpoint, service };
  }

  /** Match the repository and service for a git request path. */
  matchRoute(path: string): { repo: Repo; service: GitService } | null {
    const matched = this.route(path);
    if (!matched) return null;
    return { repo: matched.repo, service: matched.service };
  }

  /**
   * Build the advertisement for a repo and service: v2 when the request asks for it
   * (upload-pack only — receive-pack is v0-only), v0 otherwise. The content type and
   * preamble follow the service.
   */
  advertisement(repo: Repo, version2: boolean, service: GitService): GitHttpResult {
    const lookup = repoLookup(repo);
    if (version2 && service === 'git-upload-pack') {
      return binaryResult(200, advertisementContentType(service), buildV2Advertisement());
    }
    const capabilities = service === 'git-receive-pack' ? V0_RECEIVE_CAPABILITIES : V0_UPLOAD_CAPABILITIES;
    return binaryResult(200, advertisementContentType(service), buildV0Advertisement(repo, lookup, capabilities, service));
  }

  /** The v2 fetch: plan, then pack, then the four named sections in order. */
  fetchV2(repo: Repo, request: V2FetchRequest): GitHttpResult {
    const lookup = repoLookup(repo);
    const plan = planFetch(lookup, request.wants, request.haves, request.shallow, request.depth);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [
      buildV2Acknowledgements(plan),
      buildV2ShallowInfo(plan),
      buildV2WantedRefs(request.wants, repo),
      encodePktLine('packfile\n'),
      buildSidebandPack(pack, `Enumerating objects: ${plan.objects.length}, done.\n`),
    ];
    return binaryResult(200, resultContentType('git-upload-pack'), Buffer.concat(parts));
  }

  /** The v0 fetch: NAK/shallow lines, then the sideband pack. */
  fetchV0(repo: Repo, request: V0FetchRequest): GitHttpResult {
    const lookup = repoLookup(repo);
    const plan = planFetch(lookup, request.wants, request.haves, request.shallow, request.depth);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [
      buildV0Acknowledgements(plan),
      buildSidebandPack(pack, `Enumerating objects: ${plan.objects.length}, done.\n`),
    ];
    return binaryResult(200, resultContentType('git-upload-pack'), Buffer.concat(parts));
  }

  /**
   * The v2 ls-refs command: one line per ref, filtered server-side by the request's
   * ref prefixes (a ref answers only when its name starts with a prefix). HEAD is
   * included with its symref-target when no prefix excludes it; an annotated tag's
   * line carries `peeled:`. An empty repository answers `unborn` with the unborn HEAD
   * line.
   */
  lsRefsV2(repo: Repo, request: V2FetchRequest, rawBody: Uint8Array): GitHttpResult {
    const lines = packetsToLines(decodePktLines(rawBody));
    const prefixes: string[] = [];
    let unborn = false;
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      else if (line === 'unborn') unborn = true;
    }
    void request;
    const lookup = repoLookup(repo);
    const refs = buildRefAdvertisement(repo, lookup);
    const parts: Buffer[] = [];
    let any = false;
    for (const ref of refs) {
      if (prefixes.length && !prefixes.some((prefix) => ref.ref.startsWith(prefix))) continue;
      parts.push(encodePktLine(v2RefLine(ref)));
      any = true;
    }
    if (!any && unborn && !repo.refs.size) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    parts.push(pktLineFlush());
    return binaryResult(200, resultContentType('git-upload-pack'), Buffer.concat(parts));
  }

  /** Apply one push's refs, in order, reporting one status line per ref. */
  receivePack(repo: Repo, commands: readonly PushCommand[], packBytes: Buffer): GitHttpResult {
    const lookup = repoLookup(repo);
    const newObjects = new Map<string, GitObject>();
    if (packBytes.length) {
      let read;
      try {
        read = readPack(packBytes, { resolveBase: lookup });
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'pack parse failed';
        const statuses: ReceiveStatus[] = commands.map((command) => ({ ref: command.ref, ok: false, error: `unpack ${detail}` }));
        return binaryResult(200, resultContentType('git-receive-pack'), buildSidebandReportStatus(statuses, detail));
      }
      for (const [oid, object] of read.objects) newObjects.set(oid, object);
    }
    const statuses: ReceiveStatus[] = [];
    let changed = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      const isCreate = command.oldOid === ZERO_OID;
      const isDelete = command.newOid === ZERO_OID;
      if (isCreate && current !== undefined) {
        statuses.push({ ref: command.ref, ok: false, error: 'already exists' });
        continue;
      }
      if (!isCreate && current === undefined) {
        statuses.push({ ref: command.ref, ok: false, error: 'cannot lock ref' });
        continue;
      }
      if (!isCreate && !isDelete && current !== command.oldOid) {
        statuses.push({ ref: command.ref, ok: false, error: 'non-fast-forward' });
        continue;
      }
      if (!isCreate && !isDelete && !isAncestor(command.oldOid, command.newOid, (oid) => newObjects.get(oid) ?? lookup(oid))) {
        statuses.push({ ref: command.ref, ok: false, error: 'non-fast-forward' });
        continue;
      }
      if (!isDelete && !newObjects.has(command.newOid) && !lookup(command.newOid)) {
        statuses.push({ ref: command.ref, ok: false, error: 'unpack object not found' });
        continue;
      }
      if (isDelete) {
        if (repo.refs.delete(command.ref)) changed = true;
      } else {
        if (repo.refs.get(command.ref) !== command.newOid) {
          repo.refs.set(command.ref, command.newOid);
          changed = true;
        }
      }
      statuses.push({ ref: command.ref, ok: true, newOid: command.newOid });
    }
    for (const [oid, object] of newObjects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        changed = true;
      }
    }
    if (changed) this.store.touchRepo(repo);
    return binaryResult(200, resultContentType('git-receive-pack'), buildSidebandReportStatus(statuses));
  }

  /**
   * Route and serve one git request. Never throws: a missing repository is a 404, a
   * malformed body is a 400, anything unexpected is a 500, and the server keeps serving.
   */
  handleGitRequest(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: Buffer): GitHttpResult {
    try {
      const upper = method.toUpperCase();
      const matched = parseGitPath(path);
      if (!matched) return notFoundResult();
      const repo = this.store.getRepo(matched.owner, matched.name);
      if (!repo) return notFoundResult();
      const endpoint = matched.endpoint;

      if (endpoint === 'info/refs') {
        if (upper !== 'GET') return jsonResult(405, JSON.stringify({ message: 'Method Not Allowed' }));
        const service = query.service ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return badRequestResult('service parameter is required');
        const version2 = service === 'git-upload-pack' && (headers['git-protocol'] ?? '').includes('version=2');
        const key = `${repo.fullName}|${repo.rev}|info/refs|${version2 ? 'v2' : 'v0'}|${service}`;
        const cached = this.responseCache.get(key);
        if (cached) return cached;
        const result = this.advertisement(repo, version2, service);
        if (this.responseCache.size >= RESPONSE_CACHE_MAX) {
          const firstKey = this.responseCache.keys().next().value;
          if (firstKey !== undefined) this.responseCache.delete(firstKey);
        }
        this.responseCache.set(key, result);
        return result;
      }

      if (endpoint === 'git-upload-pack') {
        if (upper !== 'POST') return jsonResult(405, JSON.stringify({ message: 'Method Not Allowed' }));
        const version2 = (headers['git-protocol'] ?? '').includes('version=2');
        if (version2) {
          let request: V2FetchRequest;
          try {
            request = parseV2Request(body);
          } catch (err) {
            return badRequestResult(err instanceof Error ? err.message : 'malformed v2 request');
          }
          if (request.command === 'ls-refs') return this.lsRefsV2(repo, request, body);
          if (request.command !== 'fetch') return badRequestResult(`unsupported v2 command ${JSON.stringify(request.command)}`);
          const key = `${repo.fullName}|${repo.rev}|fetch-v2|${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
          const cached = this.responseCache.get(key);
          if (cached) return cached;
          let result: GitHttpResult;
          try {
            result = this.fetchV2(repo, request);
          } catch (err) {
            if (err instanceof GitError) return badRequestResult(err.message);
            return internalErrorResult(err instanceof Error ? err.message : 'fetch failed');
          }
          if (this.responseCache.size >= RESPONSE_CACHE_MAX) {
            const firstKey = this.responseCache.keys().next().value;
            if (firstKey !== undefined) this.responseCache.delete(firstKey);
          }
          this.responseCache.set(key, result);
          return result;
        }
        let request: V0FetchRequest;
        try {
          request = parseV0Request(body);
        } catch (err) {
          return badRequestResult(err instanceof Error ? err.message : 'malformed v0 request');
        }
        const key = `${repo.fullName}|${repo.rev}|fetch-v0|${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
        const cached = this.responseCache.get(key);
        if (cached) return cached;
        let result: GitHttpResult;
        try {
          result = this.fetchV0(repo, request);
        } catch (err) {
          if (err instanceof GitError) return badRequestResult(err.message);
          return internalErrorResult(err instanceof Error ? err.message : 'fetch failed');
        }
        if (this.responseCache.size >= RESPONSE_CACHE_MAX) {
          const firstKey = this.responseCache.keys().next().value;
          if (firstKey !== undefined) this.responseCache.delete(firstKey);
        }
        this.responseCache.set(key, result);
        return result;
      }

      if (endpoint === 'git-receive-pack') {
        if (upper !== 'POST') return jsonResult(405, JSON.stringify({ message: 'Method Not Allowed' }));
        let commands: PushCommand[];
        try {
          commands = parsePushCommands(body);
        } catch (err) {
          return badRequestResult(err instanceof Error ? err.message : 'malformed push command list');
        }
        const packBytes = extractPackFromBody(body);
        try {
          return this.receivePack(repo, commands, packBytes);
        } catch (err) {
          return internalErrorResult(err instanceof Error ? err.message : 'receive-pack failed');
        }
      }
      return notFoundResult();
    } catch (err) {
      return internalErrorResult(err instanceof Error ? err.message : 'git request failed');
    }
  }
}

/** The capabilities the v0 upload-pack advertisement lists on its first ref line. */
export const V0_UPLOAD_CAPABILITIES: readonly string[] = [
  'side-band-64k',
  'shallow',
  'thin-pack',
  'ofs-delta',
  'multi_ack',
  'symref=HEAD:refs/heads/main',
];

/** The capabilities the v0 receive-pack advertisement lists on its first ref line. */
export const V0_RECEIVE_CAPABILITIES: readonly string[] = [
  'report-status',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
];

/** The v2 upload-pack capabilities the advertisement lists. */
export const V2_UPLOAD_CAPABILITIES: readonly string[] = [
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow',
  'object-format=sha1',
];

/**
 * The sideband pack a v0 fetch sends for one object: the pack data in band-1 packets,
 * preceded by one band-2 progress packet. Empty packs send one zero-length band-1 packet.
 */
export function buildSidebandPackForObjects(objects: readonly GitObject[], progress: string): Buffer {
  return buildSidebandPack(writePack(objects), progress);
}
