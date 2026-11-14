// Git object store and smart-HTTP protocol (upload-pack v2, upload-pack v0,
// receive-pack v0), implemented from scratch on the Node standard library.
//
// Object model: SHA-1 ids over "<type> <size>\0" + bytes. Packs are written
// plain (no deltas) and read with full OFS_DELTA / REF_DELTA resolution, so
// any client-built pack is accepted. The store is global and content
// addressed; refs live per repository in store.ts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { readonly type: GitObjectType; readonly data: Buffer; }

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function isOid(v: string): boolean {
  if (v.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = v.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const lower = c >= 97 && c <= 102;
    const upper = c >= 65 && c <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

/** The shared object store: every object every repository holds. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose oid is already known (skips re-hashing). */
  putKnown(type: GitObjectType, data: Buffer, oid: string): string {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

export interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string; }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView { readonly object: string; readonly type: GitObjectType; readonly tag: string; readonly tagger: string; readonly message: string; }

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(store: ObjectStore, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `tip` (commit ancestry, following parents)? */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** Peel a ref target to its commit (following annotated tags). */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface PktPacket { readonly kind: 'data' | 'flush' | 'delim' | 'response-end'; readonly payload?: Buffer; }

/** One hex digit's value, or -1 when the byte is not a hex digit. */
function hexVal(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

/** Decode a whole buffer into pkt-line packets; throws on malformed framing. */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    // Header is 4 hex digits; parsed by hand (no regex, no substring).
    const d0 = hexVal(buf[off]);
    const d1 = hexVal(buf[off + 1]);
    const d2 = hexVal(buf[off + 2]);
    const d3 = hexVal(buf[off + 3]);
    if (d0 < 0 || d1 < 0 || d2 < 0 || d3 < 0) throw new Error('invalid pkt-line header');
    const len = (d0 << 12) | (d1 << 8) | (d2 << 4) | d3;
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}

export function pktLinesText(packets: readonly PktPacket[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data' && p.payload) out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile; returns resolved objects (type + data). Throws on corruption. */
export function readPack(pack: Buffer, store: ObjectStore): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw { offset: number; code: number; size: number; data: Buffer; baseOff?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const h = readPackVarint(pack, off);
    off = h.next;
    const code = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOff, code, size: h.size, data: Buffer.alloc(0) };
    if (code === 6) {
      let byte = pack[off];
      let value = byte & 0x7f;
      off += 1;
      while (byte & 0x80) {
        byte = pack[off++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOff = entryOff - value;
    } else if (code === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[code]) {
      throw new Error(`unknown pack entry type ${code}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  if (off !== trailerStart) throw new Error('pack has trailing bytes');

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.code === 6) {
      const baseEntry = byOffset.get(entry.baseOff!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.code === 7) {
      const baseObj = store.get(entry.baseOid!);
      if (!baseObj) throw new Error(`ref-delta base ${entry.baseOid} not in store`);
      type = baseObj.type;
      data = applyDelta(baseObj.data, entry.data);
    } else {
      type = CODE_TYPE[entry.code];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a pack into sideband band-1 pkt-lines (chunked to the pkt-line max). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    // An empty pack still travels as one band-1 packet so the client sees a pack.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  }
  return Buffer.concat(parts);
}

/**
 * The fetch set: objects reachable from `wants` within `depth` commit edges
 * (depth undefined = unlimited), minus objects the client already holds.
 * `held` is computed from the client's haves, not traversing past the
 * client's shallow boundaries. Returns the objects to send and the new
 * shallow boundary commits (at exactly depth edges) plus the old shallow
 * commits that are now interior (unshallow).
 */
export function fetchSet(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // Commit distances from the wants (BFS over parents).
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const obj = store.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (!dist.has(w)) { dist.set(w, 0); queue.push([w, 0]); }
    }
  }
  // Tag wants resolve to their commit for distance purposes.
  for (const w of wants) {
    const obj = store.get(w);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(store, w);
      if (peeled && !dist.has(peeled)) { dist.set(peeled, 0); queue.push([peeled, 0]); }
    }
  }
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (depth !== undefined && d >= depth) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push([p, d + 1]); }
    }
  }
  // When depth is set, the boundary is the set of commits at distance depth:
  // they are included but their parents are not. BFS above marks d >= depth
  // as shallow; the boundary commits are those with d === depth - ... hmm:
  // with depth=1 only d=0 is included and d=0 is the boundary. Recompute:
  const boundary = new Set<string>();
  if (depth !== undefined) {
    for (const [oid, d] of dist) if (d === depth - 1) boundary.add(oid);
  }
  // Reachable objects from the included commits (+ tag objects wanted
  // directly), in ONE walk: a boundary commit contributes its tree and
  // blobs, never its parents. Shared subtrees are visited once.
  const wanted = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth === undefined || d < depth) wanted.add(oid);
  }
  const send = new Set<string>();
  const stack: string[] = [];
  for (const w of wants) {
    const obj = store.get(w);
    if (obj?.type === 'tag') stack.push(w);
  }
  for (const oid of wanted) stack.push(oid);
  while (stack.length) {
    const oid = stack.pop()!;
    if (send.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    send.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) if (wanted.has(p)) stack.push(p);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const tObj = store.get(target);
      if (tObj && (tObj.type !== 'commit' || wanted.has(target))) stack.push(target);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  // Held set: reachable from haves, but never past a client shallow boundary.
  const held = new Set<string>();
  const hqueue: string[] = [];
  const shallowClient = new Set(clientShallow);
  for (const h of haves) if (isOid(h)) hqueue.push(h);
  while (hqueue.length) {
    const oid = hqueue.pop()!;
    if (held.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (shallowClient.has(oid)) {
      // Boundary: include the commit + tree + blobs, but not its parents.
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        const treeHeld = collectReachable(store, [c.tree]);
        for (const t of treeHeld) held.add(t);
      } else if (obj.type === 'tag') {
        const peeled = peelToCommit(store, oid);
        if (peeled) {
          const c = store.get(peeled);
          if (c && c.type === 'commit') {
            const treeHeld = collectReachable(store, [parseCommit(c.data).tree]);
            for (const t of treeHeld) held.add(t);
          }
        }
      }
      continue;
    }
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      hqueue.push(c.tree);
      for (const p of c.parents) hqueue.push(p);
    } else if (obj.type === 'tag') {
      hqueue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') hqueue.push(e.oid);
    }
  }
  const toSend: Array<{ oid: string; obj: GitObject }> = [];
  for (const oid of send) {
    if (held.has(oid)) continue;
    const obj = store.get(oid);
    if (obj) toSend.push({ oid, obj });
  }
  // Deterministic order: commits, then trees, then tags, then blobs, by oid.
  const rank = (t: GitObjectType): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3);
  toSend.sort((a, b) => {
    const ra = rank(a.obj.type) - rank(b.obj.type);
    if (ra !== 0) return ra;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  const objects = toSend.map((e) => e.obj);
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    if (dist.has(s) && !boundary.has(s) && (depth === undefined || (dist.get(s)! < (depth - 1)))) {
      unshallow.push(s);
    }
  }
  return { objects, shallow: [...boundary].sort(), unshallow };
}
