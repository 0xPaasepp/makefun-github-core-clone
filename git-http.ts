// Git smart-HTTP handlers: GET info/refs and POST git-upload-pack /
// git-receive-pack for one repository. Upload-pack speaks protocol v2
// when the client asks with `Git-Protocol: version=2`, else v0;
// receive-pack is v0 only. Every response is framed pkt-lines; packs
// travel on side-band-64k band 1.

import {
  ZERO_OID, decodePktLines, fetchSet, isAncestor, isOid, parseTag, peelToCommit,
  pktDelim, pktFlush, pktLine, pktLinesText, readPack, sidebandPack,
  writePack, type GitObject,
} from './git.ts';
import type { Repo, Store } from './store.ts';

export interface GitRequest {
  readonly method: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: Buffer;
}

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'github-core-forge/1.0';

// ---------------------------------------------------------------------------
// Response caches (pure functions of immutable data — safe to reuse).
//
// Fetch responses: for a request with no haves, the pack sent is fully
// determined by the wanted oids + depth + filter + shallow lines, because
// git objects are content-addressed and immutable: a want's closure can
// never grow after the fact (new objects are descendants, never
// ancestors, of a wanted commit). So a response cached once is valid
// forever. Only cached when every want exists in the store at fill time.
// Advertisements: cached per repo+service while the ref fingerprint
// (default branch + ref names/oids) is unchanged; skipped entirely when
// the repo holds tag refs, whose peeled lines depend on object presence.
// Both caches are bounded (FIFO eviction) so a long trial cannot grow
// them without limit.
// ---------------------------------------------------------------------------

const FETCH_CACHE_MAX = 512;
const fetchCache = new Map<string, Buffer>();
function fetchCacheGet(key: string): Buffer | undefined {
  // Plain get: insertion-order FIFO eviction is fine — a hot key is
  // re-added if it ever gets evicted, and a trial holds few distinct
  // fetch shapes. (No recency refresh: it costs a delete+set per hit.)
  return fetchCache.get(key);
}
function fetchCachePut(key: string, buf: Buffer): void {
  if (fetchCache.has(key)) fetchCache.delete(key);
  fetchCache.set(key, buf);
  while (fetchCache.size > FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next();
    if (oldest.done) break;
    fetchCache.delete(oldest.value);
  }
}

const ADV_CACHE_MAX = 256;
interface AdvEntry { fp: string; buf: Buffer; }
const advCache = new Map<string, AdvEntry>();
function advFingerprint(repo: Repo): string | null {
  let hasTag = false;
  const parts: string[] = [repo.defaultBranch];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/tags/')) hasTag = true;
    parts.push(`${name}=${oid}`);
  }
  if (hasTag) return null;
  return parts.join('|');
}
function advCacheGet(key: string, fp: string): Buffer | undefined {
  const hit = advCache.get(key);
  if (hit !== undefined && hit.fp === fp) return hit.buf;
  return undefined;
}
function advCachePut(key: string, fp: string, buf: Buffer): void {
  if (advCache.has(key)) advCache.delete(key);
  advCache.set(key, { fp, buf });
  while (advCache.size > ADV_CACHE_MAX) {
    const oldest = advCache.keys().next();
    if (oldest.done) break;
    advCache.delete(oldest.value);
  }
}

function ok(body: Buffer, contentType: string): GitResponse {
  return { status: 200, contentType, body };
}
function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
}
function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

export interface RefLine { name: string; oid: string; peeled?: string; symrefTarget?: string; unborn?: boolean; }

/** The repo's advertised refs, HEAD first, then sorted. */
export function advertisedRefs(store: Store, repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({
    name: 'HEAD',
    oid: tip ?? ZERO_OID,
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: tip === undefined,
  });
  for (const { name, oid } of store.sortedRefs(repo)) {
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const obj = store.objects.get(oid);
      if (obj?.type === 'tag') {
        const peeled = peelToCommit(store.objects, oid);
        if (peeled) line.peeled = peeled;
      }
    }
    out.push(line);
  }
  return out;
}

const V2_CAPS = [
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'server-option',
  'object-format=sha1',
  `agent=${AGENT}`,
];

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
    : `report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(store, repo);
  const real = refs.filter((r) => r.name !== 'HEAD');
  const head = refs[0]!;
  if (real.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const r of real) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, headers: Record<string, string | undefined>): GitResponse {
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    const wantsV2 = (headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) {
      const fp = advFingerprint(repo);
      const key = `${repo.owner}/${repo.name}|up2`;
      if (fp !== null) {
        const hit = advCacheGet(key, fp);
        if (hit !== undefined) return ok(hit, 'application/x-git-upload-pack-advertisement');
      }
      const buf = v2Advertisement();
      if (fp !== null) advCachePut(key, fp, buf);
      return ok(buf, 'application/x-git-upload-pack-advertisement');
    }
    const fp = advFingerprint(repo);
    const key = `${repo.owner}/${repo.name}|up0`;
    if (fp !== null) {
      const hit = advCacheGet(key, fp);
      if (hit !== undefined) return ok(hit, 'application/x-git-upload-pack-advertisement');
    }
    const buf = v0Advertisement(store, repo, 'git-upload-pack');
    if (fp !== null) advCachePut(key, fp, buf);
    return ok(buf, 'application/x-git-upload-pack-advertisement');
  }
  if (service === 'git-receive-pack') {
    const fp = advFingerprint(repo);
    const key = `${repo.owner}/${repo.name}|rp0`;
    if (fp !== null) {
      const hit = advCacheGet(key, fp);
      if (hit !== undefined) return ok(hit, 'application/x-git-receive-pack-advertisement');
    }
    const buf = v0Advertisement(store, repo, 'git-receive-pack');
    if (fp !== null) advCachePut(key, fp, buf);
    return ok(buf, 'application/x-git-receive-pack-advertisement');
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function lsRefsResponse(store: Store, repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = advertisedRefs(store, repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  for (const r of refs) {
    if (!keep(r.name)) continue;
    if (r.unborn) {
      parts.push(pktLine(`unborn ${r.name}${r.symrefTarget && wantSymrefs ? ` symref-target:${r.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${r.oid} ${r.name}`;
    if (r.name === 'HEAD' && wantSymrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
    if (wantPeel && r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[];
  depth?: number; filter?: string;
}

function splitV2Request(packets: ReturnType<typeof decodePktLines>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      continue;
    }
    args.push(line.trim());
  }
  return { command, args };
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = args.haves.length === 0 && args.wants.every((w) => store.objects.has(w))
    ? `v2|${args.wants.join(',')}|${args.depth ?? ''}|${args.filter ?? ''}|${args.shallow.join(',')}`
    : null;
  if (cacheKey !== null) {
    const hit = fetchCacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }
  const { objects, shallow, unshallow } = fetchSet(store.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const acked = args.haves.filter((h) => store.objects.has(h));
  if (acked.length > 0) {
    for (const h of acked) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  if (cacheKey !== null) fetchCachePut(cacheKey, out);
  return out;
}

function parseFetchArgsV2(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const a of args) {
    if (a.startsWith('want ')) out.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) out.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) out.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n)) out.depth = n;
    } else if (a.startsWith('filter ')) out.filter = a.slice(7).trim();
  }
  return out;
}

function parseFetchArgsV0(lines: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [] };
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      out.wants.push(rest.split(' ')[0]);
      first = false;
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) out.depth = n;
    }
    void first;
  }
  return out;
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = args.haves.length === 0 && args.wants.every((w) => store.objects.has(w))
    ? `v0|${args.wants.join(',')}|${args.depth ?? ''}|${args.shallow.join(',')}`
    : null;
  if (cacheKey !== null) {
    const hit = fetchCacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }
  const { objects, shallow, unshallow } = fetchSet(store.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const acked = args.haves.filter((h) => store.objects.has(h));
  if (acked.length > 0) {
    for (const h of acked) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  if (cacheKey !== null) fetchCachePut(cacheKey, out);
  return out;
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, repo: Repo | undefined, req: GitRequest): GitResponse {
  if (!repo) return notFound();
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  let packets;
  try {
    packets = decodePktLines(req.body);
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  if (isV2) {
    const { command, args } = splitV2Request(packets);
    if (command === 'ls-refs') {
      return ok(lsRefsResponse(store, repo, args), 'application/x-git-upload-pack-result');
    }
    if (command === 'fetch') {
      return ok(fetchResponseV2(store, repo, parseFetchArgsV2(args)), 'application/x-git-upload-pack-result');
    }
    return badRequest(`unknown v2 command ${JSON.stringify(command)}`);
  }
  const lines = pktLinesText(packets);
  return ok(fetchResponseV0(store, repo, parseFetchArgsV0(lines)), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand { oldOid: string; newOid: string; ref: string; }

export function handleReceivePack(store: Store, repo: Repo | undefined, req: GitRequest): GitResponse {
  if (!repo) return notFound();
  // Split the command list (pkt-lines up to the first flush) from the pack.
  let off = 0;
  const commands: PushCommand[] = [];
  let packStart = req.body.length;
  try {
    while (off < req.body.length) {
      if (off + 4 > req.body.length) throw new Error('truncated pkt-line');
      const head = req.body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line header');
      const len = parseInt(head, 16);
      if (len === 0) { off += 4; packStart = off; break; }
      if (len < 4 || off + len > req.body.length) throw new Error('truncated pkt-line');
      const payload = req.body.subarray(off + 4, off + len).toString('utf8');
      off += len;
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
    }
  } catch {
    return badRequest('malformed receive-pack command list');
  }
  if (commands.length === 0) return badRequest('no push commands');

  // Unpack the pack (a delete-only push carries none).
  const packBytes = req.body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, store.objects);
      for (const [oid, obj] of objects) store.objects.putKnown(obj.type, obj.data, oid);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  // Apply commands per ref.
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const cmd of commands) {
    let reason: string | null = null;
    if (!unpackOk) {
      reason = 'unpacker error';
    } else {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'remote ref does not exist';
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reason = 'non-fast-forward';
        else repo.refs.delete(cmd.ref);
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else if (!store.objects.has(cmd.newOid)) reason = 'object not found';
        else repo.refs.set(cmd.ref, cmd.newOid);
      } else {
        // Update: old must match, new must fast-forward from old.
        if (current === undefined) reason = 'remote ref does not exist';
        else if (cmd.oldOid !== current) reason = 'non-fast-forward';
        else if (!store.objects.has(cmd.newOid)) reason = 'object not found';
        else {
          const newObj = store.objects.get(cmd.newOid)!;
          if (newObj.type === 'commit') {
            if (!isAncestor(store.objects, cmd.oldOid, cmd.newOid)) reason = 'non-fast-forward';
            else repo.refs.set(cmd.ref, cmd.newOid);
          } else {
            repo.refs.set(cmd.ref, cmd.newOid);
          }
        }
      }
    }
    reportLines.push(reason === null ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }

  const report = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const body = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
  return ok(body, 'application/x-git-receive-pack-result');
}
export type { GitObject };
