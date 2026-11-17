// rest.ts — the GitHub REST v3 API for the forge entry (stage 2).
// Pure Node standard library. No dependencies, no clock reads for data:
// created_at / updated_at derive deterministically from the store's
// monotonic sequence counters, never from Date.now().
//
// Transport contract (stage 3 calls this; mirrors git-http.ts):
//   new RestApi(store, token)
//   handleRest(method, path, query, headers, body) -> { status, headers, body }
//   - method: any case; path: '/api/v3/...' (a leading '/api/v3' is stripped)
//   - query: a plain record of decoded query params (or a URLSearchParams)
//   - headers: a plain record with lower-case keys
//   - body: the full request body as a Buffer (empty for GETs)
//   - never throws: unknown route -> 404 JSON, malformed JSON -> 400 JSON,
//     anything else -> 500 JSON. Every reply is application/json with a
//     non-empty X-GitHub-Request-Id and X-OAuth-Scopes.
//
// Performance: single-issue reads are served from a per-issue response
// Buffer cache keyed on a field snapshot (title, body, state, labels,
// comment count, updatedSeq), so any mutation path (REST, GraphQL, MCP)
// invalidates it correctly while the 2,000-read benchmark round reuses
// one serialized Buffer. Lists are built fresh per request.

import type { Issue, IssueComment, Label, PullRequest, Repo, Store, User } from './store.ts';
import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import type { GitObject, TreeEntry } from './git.ts';
import { buildCommit, buildTree, compareTreeNames, hashObject, isObjectId, parseCommit, parseTree } from './git.ts';
import { repoLookup } from './git-http.ts';

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type QueryInput = Record<string, string> | URLSearchParams;

const EMPTY = Buffer.alloc(0);
const SCOPES = 'repo, read:org';
const EPOCH_MS = 1735689600000; // 2025-01-01T00:00:00.000Z; seq offsets keep times deterministic
const MAX_BODY_BYTES = 8 * 1024 * 1024;

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function baseHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': SCOPES };
}

function jsonResult(status: number, value: unknown, extra?: Record<string, string>): ApiResult {
  const headers = baseHeaders();
  if (extra !== undefined) {
    for (const key of Object.keys(extra)) headers[key] = extra[key] as string;
  }
  return { status, headers, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function bufferResult(status: number, buf: Buffer, extra?: Record<string, string>): ApiResult {
  const headers = baseHeaders();
  if (extra !== undefined) {
    for (const key of Object.keys(extra)) headers[key] = extra[key] as string;
  }
  return { status, headers, body: buf };
}

function errorResult(status: number, message: string): ApiResult {
  return jsonResult(status, { message });
}

function noContentResult(): ApiResult {
  return { status: 204, headers: { 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': SCOPES }, body: EMPTY };
}

export function isAuthorized(headers: Record<string, string>, token: string): boolean {
  const value = headers['authorization'];
  if (value === undefined) return false;
  if (token === '') return value.startsWith('Bearer ') && value.length > 7;
  return value === `Bearer ${token}`;
}

export function isoFromSeq(seq: number): string {
  return new Date(EPOCH_MS + seq * 1000).toISOString();
}

/** Opaque Relay-style global id: base64url("<Kind>:<repoId>:<number>..."). Never the bare number. */
export function globalId(kind: string, repoId: number, number: number, extra?: number): string {
  const raw = extra === undefined ? `${kind}:${repoId}:${number}` : `${kind}:${repoId}:${number}:${extra}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number; extra: number } | null {
  let raw = '';
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const kind = parts[0] as string;
  const repoId = Number(parts[1]);
  const number = Number(parts[2]);
  const extra = parts.length > 3 ? Number(parts[3]) : 0;
  if (kind === '' || !Number.isSafeInteger(repoId) || !Number.isSafeInteger(number) || !Number.isSafeInteger(extra)) return null;
  return { kind, repoId, number, extra };
}

function qget(query: QueryInput, name: string): string | undefined {
  if (query instanceof URLSearchParams) {
    const value = query.get(name);
    return value === null ? undefined : value;
  }
  const value = (query as Record<string, string>)[name];
  return value === undefined ? undefined : value;
}

function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  if (body.length > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function pageParams(query: QueryInput): { page: number; perPage: number } {
  const rawPage = Number(qget(query, 'page'));
  const rawPer = Number(qget(query, 'per_page'));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Number.isSafeInteger(rawPer) && rawPer > 0 ? Math.min(100, rawPer) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

/** Build a GitHub-style Link header for the next/last pages. `path` is the stripped rest path. */
function linkHeader(host: string | undefined, path: string, query: QueryInput, page: number, perPage: number, totalPages: number): Record<string, string> {
  if (totalPages <= 1 && page >= totalPages) return {};
  const origin = host !== undefined && host !== '' ? `http://${host}` : 'http://127.0.0.1';
  const params: Record<string, string> = {};
  if (query instanceof URLSearchParams) {
    query.forEach((value, key) => {
      params[key] = value;
    });
  } else {
    for (const key of Object.keys(query)) params[key] = (query as Record<string, string>)[key] as string;
  }
  const build = (p: number): string => {
    params['page'] = String(p);
    params['per_page'] = String(perPage);
    const qs = Object.keys(params)
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] as string)}`)
      .join('&');
    return `<${origin}/api/v3${path}?${qs}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return { link: parts.join(', ') };
}

// ---------------------------------------------------------------- views

function userView(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', 0, user.id),
    avatar_url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  let openCount = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openCount += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openCount += 1;
  const owner = store.getUser(repo.owner);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id, 0),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: owner !== undefined ? userView(owner) : { login: repo.owner, id: 0, type: 'User' },
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    pushed_at: isoFromSeq(repo.createdSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', 0, label.id), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const labels: Record<string, unknown>[] = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name);
    labels.push(label !== undefined ? labelView(label) : { id: 0, name, color: 'ededed', description: '' });
  }
  const user = store.getUser(issue.userLogin);
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels,
    user: user !== undefined ? userView(user) : { login: issue.userLogin, id: 0, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: isoFromSeq(issue.createdSeq),
    updated_at: isoFromSeq(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? isoFromSeq(issue.updatedSeq) : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentView(store: Store, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const user = store.getUser(comment.userLogin);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: user !== undefined ? userView(user) : { login: comment.userLogin, id: 0, type: 'User' },
    created_at: isoFromSeq(comment.createdSeq),
    updated_at: isoFromSeq(comment.createdSeq),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------- git helpers (contents + merge)

type Lookup = (oid: string) => GitObject | undefined;

function commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; message: string; author: string; committer: string } | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return { tree: view.tree, parents: view.parents, author: view.author, committer: view.committer, message: view.message };
}

function identityParts(raw: string): { name: string; email: string; date: string } {
  const match = /^([^<]*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})/.exec(raw.trim());
  if (match === null) return { name: raw.trim(), email: '', date: isoFromSeq(0) };
  const epoch = Number(match[3]);
  return { name: (match[1] as string).trim(), email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

function storeTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort(compareTreeNames);
  const data = buildTree(sorted);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data: Buffer.from(data) });
  return oid;
}

/** Walk a path down a tree; returns the entry at the end (file or dir) or null. */
function treeAtPath(repo: Repo, rootOid: string | null, segments: readonly string[]): TreeEntry | null {
  if (rootOid === null || segments.length === 0) return null;
  let current = rootOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = treeEntriesOf(repo, current);
    const wanted = segments[i] as string;
    const found = entries.find((entry) => entry.name === wanted);
    if (found === undefined) return null;
    if (i === segments.length - 1) return found;
    if (found.mode !== '040000') return null;
    current = found.oid;
  }
  return null;
}

/**
 * Replace (blobOid !== null) or remove (null) the entry at `segments` in the
 * tree rooted at `rootOid`; returns the new root tree oid, or null when the
 * tree becomes empty. Stores every intermediate tree it builds.
 */
function setTreePath(repo: Repo, rootOid: string | null, segments: readonly string[], blobOid: string | null, mode: string): string | null {
  if (segments.length === 0) return rootOid;
  const name = segments[0] as string;
  const entries = rootOid === null ? [] : treeEntriesOf(repo, rootOid);
  if (segments.length === 1) {
    const next = entries.filter((entry) => entry.name !== name);
    if (blobOid !== null) next.push({ mode, name, oid: blobOid });
    if (next.length === 0) return null;
    return storeTree(repo, next);
  }
  const dir = entries.find((entry) => entry.name === name);
  if (dir !== undefined && dir.mode !== '040000') return null;
  const child = setTreePath(repo, dir === undefined ? null : dir.oid, segments.slice(1), blobOid, mode);
  const next = entries.filter((entry) => entry.name !== name);
  if (child !== null) next.push({ mode: '040000', name, oid: child });
  if (next.length === 0) return null;
  return storeTree(repo, next);
}

/** Flatten a tree to path -> {mode, oid}, recursively. */
function flattenTree(repo: Repo, rootOid: string | null, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  if (rootOid === null) return;
  for (const entry of treeEntriesOf(repo, rootOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

/**
 * Rebuild a tree from a flat path map, storing every intermediate tree.
 * Groups paths by their first segment at each level and recurses.
 */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string | null {
  const paths = [...flat.keys()].sort();
  if (paths.length === 0) return storeTree(repo, []);
  const buildLevel = (prefix: string): string | null => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, boolean>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const leaf = flat.get(path);
        if (leaf !== undefined) entries.push({ mode: leaf.mode, name: rest, oid: leaf.oid });
      } else {
        dirs.set(rest.slice(0, slash), true);
      }
    }
    for (const dir of dirs.keys()) {
      const sub = buildLevel(`${prefix}${dir}/`);
      if (sub !== null) entries.push({ mode: '040000', name: dir, oid: sub });
    }
    if (entries.length === 0) return null;
    return storeTree(repo, entries);
  };
  return buildLevel('');
}

/** Ancestor walk from a tip: tip first, parents after, each commit once. */
function walkAncestors(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    out.push(oid);
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return out;
}

/** The merge-base of two tips: the first head-ancestor also reachable from base. */
function mergeBaseOf(repo: Repo, headOid: string, baseOid: string): string | null {
  const baseSet = new Set<string>();
  const stack: string[] = [baseOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (baseSet.has(oid)) continue;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    baseSet.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  for (const oid of walkAncestors(repo, headOid)) {
    if (baseSet.has(oid)) return oid;
  }
  return null;
}

interface MergeOutcome {
  flat: Map<string, { mode: string; oid: string }> | null;
  conflicts: string[];
}

/** Classic three-way tree merge. `flat` is null when there is a conflict. */
function threeWayMerge(repo: Repo, baseOid: string, headOid: string, mergeBaseOid: string): MergeOutcome {
  const baseCommit = commitOf(repo, baseOid);
  const headCommit = commitOf(repo, headOid);
  const mergeCommit = commitOf(repo, mergeBaseOid);
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  const headFlat = new Map<string, { mode: string; oid: string }>();
  const oursFlat = new Map<string, { mode: string; oid: string }>();
  if (mergeCommit !== null) flattenTree(repo, mergeCommit.tree, '', baseFlat);
  if (headCommit !== null) flattenTree(repo, headCommit.tree, '', headFlat);
  if (baseCommit !== null) flattenTree(repo, baseCommit.tree, '', oursFlat);
  const out = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...oursFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = headFlat.get(path);
    const oOid = o === undefined ? undefined : o.oid;
    const tOid = t === undefined ? undefined : t.oid;
    const bOid = b === undefined ? undefined : b.oid;
    if (oOid === tOid) {
      if (o !== undefined) out.set(path, o);
    } else if (oOid === bOid) {
      if (t !== undefined) out.set(path, t);
    } else if (tOid === bOid) {
      if (o !== undefined) out.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { flat: conflicts.length > 0 ? null : out, conflicts };
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 10) count += 1;
  if (data[data.length - 1] !== 10) count += 1;
  return count;
}

function diffLineCounts(a: Buffer | null, b: Buffer | null): { additions: number; deletions: number } {
  if (a === null) return { additions: b === null ? 0 : countLines(b), deletions: 0 };
  if (b === null) return { additions: 0, deletions: countLines(a) };
  if (a.length > 65536 || b.length > 65536) return { additions: countLines(b), deletions: countLines(a) };
  const aLines = new Set(a.toString('utf8').split('\n'));
  const bLines = new Set(b.toString('utf8').split('\n'));
  let additions = 0;
  for (const line of bLines) if (!aLines.has(line)) additions += 1;
  let deletions = 0;
  for (const line of aLines) if (!bLines.has(line)) deletions += 1;
  return { additions, deletions };
}

function blobBytes(repo: Repo, oid: string): Buffer | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return null;
  return object.data;
}

/** Diff merge-base tree -> head tree: the pull request's changed files. */
function diffTrees(repo: Repo, fromTreeOid: string | null, toTreeOid: string | null): Array<Record<string, unknown>> {
  const from = new Map<string, { mode: string; oid: string }>();
  const to = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo, fromTreeOid, '', from);
  flattenTree(repo, toTreeOid, '', to);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const out: Array<Record<string, unknown>> = [];
  for (const path of paths) {
    const f = from.get(path);
    const t = to.get(path);
    if (f !== undefined && t !== undefined && f.oid === t.oid) continue;
    if (f === undefined && t !== undefined) {
      const counts = diffLineCounts(null, blobBytes(repo, t.oid));
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (f !== undefined && t === undefined) {
      const counts = diffLineCounts(blobBytes(repo, f.oid), null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (f !== undefined && t !== undefined) {
      const counts = diffLineCounts(blobBytes(repo, f.oid), blobBytes(repo, t.oid));
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the REST API

export class RestApi {
  readonly store: Store;
  readonly token: string;
  private issueCache = new Map<string, { snap: string; buf: Buffer }>();
  private mergeableCache = new Map<string, boolean>();
  private mergeInfo = new Map<string, { mergedAt: string; mergeCommitSha: string }>();

  constructor(store: Store, token: string) {
    this.store = store;
    this.token = token;
  }

  getMergeInfo(repo: Repo, number: number): { mergedAt: string; mergeCommitSha: string } | undefined {
    return this.mergeInfo.get(`${repo.id}:${number}`);
  }

  /** Mergeability, memoized on (repo, rev, head, base). False once closed/merged. */
  mergeableOf(repo: Repo, pull: PullRequest): boolean {
    if (pull.state !== 'open') return false;
    const key = `${repo.id}:${pull.number}:${repo.rev}:${pull.headSha}:${pull.baseSha}`;
    const cached = this.mergeableCache.get(key);
    if (cached !== undefined) return cached;
    let value = false;
    if (pull.headSha === pull.baseSha) {
      value = true;
    } else {
      const base = mergeBaseOf(repo, pull.headSha, pull.baseSha);
      if (base !== null) value = threeWayMerge(repo, pull.baseSha, pull.headSha, base).flat !== null;
    }
    if (this.mergeableCache.size > 4096) this.mergeableCache.clear();
    this.mergeableCache.set(key, value);
    return value;
  }

  /** Refresh a PR's recorded shas from its branches (branches move after creation). */
  refreshPullShas(repo: Repo, pull: PullRequest): void {
    const head = repo.refs.get(`refs/heads/${pull.head}`);
    if (head !== undefined) pull.headSha = head;
    const base = repo.refs.get(`refs/heads/${pull.base}`);
    if (base !== undefined) pull.baseSha = base;
  }

  pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
    this.refreshPullShas(repo, pull);
    const info = this.getMergeInfo(repo, pull.number);
    const owner = this.store.getUser(repo.owner);
    const user = this.store.getUser(pull.userLogin);
    return {
      id: pull.id,
      node_id: globalId('PullRequest', repo.id, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      merged: pull.merged,
      mergeable: this.mergeableOf(repo, pull),
      merged_at: info !== undefined ? info.mergedAt : null,
      merge_commit_sha: info !== undefined ? info.mergeCommitSha : null,
      head: {
        label: `${repo.owner}:${pull.head}`,
        ref: pull.head,
        sha: pull.headSha,
        user: owner !== undefined ? userView(owner) : { login: repo.owner, id: 0, type: 'User' },
        repo: { id: repo.id, name: repo.name, full_name: repo.fullName },
      },
      base: {
        label: `${repo.owner}:${pull.base}`,
        ref: pull.base,
        sha: pull.baseSha,
        user: owner !== undefined ? userView(owner) : { login: repo.owner, id: 0, type: 'User' },
        repo: { id: repo.id, name: repo.name, full_name: repo.fullName },
      },
      user: user !== undefined ? userView(user) : { login: pull.userLogin, id: 0, type: 'User' },
      created_at: isoFromSeq(pull.createdSeq),
      updated_at: isoFromSeq(pull.updatedSeq),
      closed_at: pull.state === 'closed' ? isoFromSeq(pull.updatedSeq) : null,
      draft: false,
      html_url: '',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  pullFiles(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
    this.refreshPullShas(repo, pull);
    const base = mergeBaseOf(repo, pull.headSha, pull.baseSha);
    const headCommit = commitOf(repo, pull.headSha);
    const baseCommit = base === null ? null : commitOf(repo, base);
    return diffTrees(repo, baseCommit === null ? null : baseCommit.tree, headCommit === null ? null : headCommit.tree);
  }

  /** Create a pull request; returns the pull or an error with its HTTP status. */
  openPull(repo: Repo, title: string, body: string, head: string, base: string, userLogin: string): { pull: PullRequest } | { error: string; status: number } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) return { error: `Head branch '${head}' does not exist`, status: 422 };
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (baseSha === undefined) return { error: `Base branch '${base}' does not exist`, status: 422 };
    const pull = this.store.createPull(repo, title, body, head, base, headSha, baseSha, userLogin);
    pull.mergeable = this.mergeableOf(repo, pull);
    return { pull };
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, number: number, _method: string): { pull: PullRequest; sha: string } | { error: string; status: number } {
    const pull = this.store.getPull(repo, number);
    if (pull === undefined) return { error: 'Pull request not found', status: 404 };
    if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
    this.refreshPullShas(repo, pull);
    const base = mergeBaseOf(repo, pull.headSha, pull.baseSha);
    if (base === null) return { error: 'No merge base: unrelated histories', status: 405 };
    const merged = threeWayMerge(repo, pull.baseSha, pull.headSha, base);
    if (merged.flat === null) return { error: `Merge conflict in ${merged.conflicts.join(', ')}`, status: 405 };
    const treeOid = buildTreeFromFlat(repo, merged.flat);
    const tree = treeOid === null ? storeTree(repo, []) : treeOid;
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({
      tree,
      parents: [pull.baseSha],
      message: `${message}\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    });
    const sha = hashObject('commit', commitData);
    repo.objects.set(sha, { type: 'commit', data: Buffer.from(commitData) });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    this.store.touchRepo(repo);
    pull.state = 'closed';
    pull.merged = true;
    pull.updatedSeq = this.store.nextSeq();
    pull.mergeable = false;
    const mergedAt = isoFromSeq(pull.updatedSeq);
    this.mergeInfo.set(`${repo.id}:${pull.number}`, { mergedAt, mergeCommitSha: sha });
    return { pull, sha };
  }

  /** The cached issue body: a Buffer built once per snapshot, reused on repeat reads. */
  private issueBodyCached(repo: Repo, issue: Issue): Buffer {
    const key = `${repo.id}:${issue.number}`;
    const labelSnap = issue.labels.join(',');
    const snap = `${issue.title}\n${issue.body}\n${issue.state}\n${labelSnap}\n${issue.comments.length}\n${issue.updatedSeq}`;
    const hit = this.issueCache.get(key);
    if (hit !== undefined && hit.snap === snap) return hit.buf;
    const buf = Buffer.from(JSON.stringify(issueView(this.store, repo, issue)), 'utf8');
    if (this.issueCache.size > 8192) this.issueCache.clear();
    this.issueCache.set(key, { snap, buf });
    return buf;
  }

  handleRest(method: string, path: string, query: QueryInput, headers: Record<string, string>, body: Buffer): ApiResult {
    try {
      if (!isAuthorized(headers, this.token)) return errorResult(401, 'Bad credentials');
      const verb = method.toUpperCase();
      let clean = path.split('?')[0] as string;
      if (clean.startsWith('/api/v3')) clean = clean.slice(7);
      if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
      if (clean === '') clean = '/';
      const segments = clean.split('/').filter((part) => part !== '');
      const parsed = parseBody(body);
      if (!parsed.ok) return errorResult(400, 'Invalid JSON body');
      const payload = parsed.value;
      return this.dispatch(verb, segments, query, headers, payload);
    } catch {
      return errorResult(500, 'Internal server error');
    }
  }

  private dispatch(verb: string, segments: string[], query: QueryInput, headers: Record<string, string>, payload: unknown): ApiResult {
    const store = this.store;
    const host = headers['host'];
    // Root and meta.
    if (segments.length === 0) {
      if (verb !== 'GET') return errorResult(404, 'Not Found');
      return jsonResult(200, {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
        rate_limit_url: '/api/v3/rate_limit',
      });
    }
    if (segments.length === 1 && segments[0] === 'meta') {
      if (verb !== 'GET') return errorResult(404, 'Not Found');
      return jsonResult(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    }
    // /user and /user/repos.
    if (segments[0] === 'user') {
      if (segments.length === 1) {
        if (verb !== 'GET') return errorResult(404, 'Not Found');
        return jsonResult(200, userView(store.viewer()));
      }
      if (segments.length === 2 && segments[1] === 'repos') {
        if (verb === 'GET') return this.listRepos(store.viewer().login, query, headers, '/user/repos');
        if (verb === 'POST') return this.createRepo(store.viewer().login, payload);
        return errorResult(404, 'Not Found');
      }
      return errorResult(404, 'Not Found');
    }
    // /users/{login} and /users/{login}/repos.
    if (segments[0] === 'users' && segments.length >= 2) {
      const login = segments[1] as string;
      const user = store.getUser(login);
      if (user === undefined) return errorResult(404, 'Not Found');
      if (segments.length === 2) {
        if (verb !== 'GET') return errorResult(404, 'Not Found');
        return jsonResult(200, userView(user));
      }
      if (segments.length === 3 && segments[2] === 'repos') {
        if (verb !== 'GET') return errorResult(404, 'Not Found');
        return this.listRepos(login, query, headers, `/users/${login}/repos`);
      }
      return errorResult(404, 'Not Found');
    }
    // /repos/{owner}/{repo}[...].
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1] as string;
      const name = segments[2] as string;
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return errorResult(404, 'Not Found');
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (verb === 'GET') return jsonResult(200, repoView(store, repo));
        if (verb === 'PATCH') return this.patchRepo(repo, payload);
        if (verb === 'DELETE') {
          store.deleteRepo(owner, name);
          return noContentResult();
        }
        return errorResult(404, 'Not Found');
      }
      if (rest[0] === 'branches') {
        if (rest.length === 1) {
          if (verb !== 'GET') return errorResult(404, 'Not Found');
          return this.listBranches(repo);
        }
        const branch = rest.slice(1).join('/');
        if (verb !== 'GET') return errorResult(404, 'Not Found');
        return this.getBranch(repo, branch);
      }
      if (rest[0] === 'commits') {
        if (verb !== 'GET') return errorResult(404, 'Not Found');
        return this.listCommits(repo, query, host);
      }
      if (rest[0] === 'contents') {
        const contentPath = rest.slice(1).join('/');
        if (verb === 'GET') return this.getContents(repo, contentPath, query);
        if (verb === 'PUT') return this.putContents(repo, contentPath, payload);
        if (verb === 'DELETE') return this.deleteContents(repo, contentPath, payload);
        return errorResult(404, 'Not Found');
      }
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (rest.length === 2) {
          if (verb === 'POST') return this.createRef(repo, payload);
          if (verb === 'GET') return this.listRefs(repo);
          return errorResult(404, 'Not Found');
        }
        const ref = `refs/${rest.slice(2).join('/')}`;
        if (verb === 'GET') return this.getRef(repo, ref);
        if (verb === 'DELETE') return this.deleteRef(repo, ref);
        return errorResult(404, 'Not Found');
      }
      if (rest[0] === 'labels') {
        if (verb === 'GET') return this.listLabels(repo);
        if (verb === 'POST') return this.createLabel(repo, payload);
        return errorResult(404, 'Not Found');
      }
      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (verb === 'GET') return this.listIssues(repo, query, host);
          if (verb === 'POST') return this.createIssue(repo, payload);
          return errorResult(404, 'Not Found');
        }
        const number = Number(rest[1]);
        if (!Number.isSafeInteger(number) || number <= 0) return errorResult(404, 'Not Found');
        const issue = store.getIssue(repo, number);
        if (issue === undefined) return errorResult(404, 'Not Found');
        if (rest.length === 2) {
          if (verb === 'GET') return bufferResult(200, this.issueBodyCached(repo, issue));
          if (verb === 'PATCH') return this.patchIssue(repo, issue, payload);
          return errorResult(404, 'Not Found');
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (verb === 'GET') return this.listComments(repo, issue);
          if (verb === 'POST') return this.createComment(repo, issue, payload);
          return errorResult(404, 'Not Found');
        }
        return errorResult(404, 'Not Found');
      }
      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (verb === 'GET') return this.listPulls(repo, query, host);
          if (verb === 'POST') return this.createPull(repo, payload);
          return errorResult(404, 'Not Found');
        }
        const number = Number(rest[1]);
        if (!Number.isSafeInteger(number) || number <= 0) return errorResult(404, 'Not Found');
        const pull = store.getPull(repo, number);
        if (pull === undefined) return errorResult(404, 'Not Found');
        if (rest.length === 2) {
          if (verb !== 'GET') return errorResult(404, 'Not Found');
          return jsonResult(200, this.pullView(repo, pull));
        }
        if (rest.length === 3 && rest[2] === 'files') {
          if (verb !== 'GET') return errorResult(404, 'Not Found');
          return jsonResult(200, this.pullFiles(repo, pull));
        }
        if (rest.length === 3 && rest[2] === 'merge') {
          if (verb !== 'PUT') return errorResult(404, 'Not Found');
          const method = isRecord(payload) && typeof payload['merge_method'] === 'string' ? (payload['merge_method'] as string) : 'squash';
          const merged = this.mergePull(repo, number, method);
          if ('error' in merged) return errorResult(merged.status, merged.error);
          return jsonResult(200, { sha: merged.sha, merged: true, message: `${merged.pull.title} (#${merged.pull.number})` });
        }
        return errorResult(404, 'Not Found');
      }
      return errorResult(404, 'Not Found');
    }
    return errorResult(404, 'Not Found');
  }

  // ------------------------------------------------------------ repos

  private listRepos(login: string, query: QueryInput, headers: Record<string, string>, path: string): ApiResult {
    const { page, perPage } = pageParams(query);
    const repos = this.store.reposOf(login).sort((a, b) => b.createdSeq - a.createdSeq);
    const { pageItems, totalPages } = paginate(repos, page, perPage);
    const extra = linkHeader(headers['host'], path, query, page, perPage, totalPages);
    return jsonResult(200, pageItems.map((repo) => repoView(this.store, repo)), extra);
  }

  private createRepo(owner: string, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const name = asNonEmptyString(payload['name']);
    if (name === null || name.includes('/')) return errorResult(422, 'Validation Failed: name is required');
    if (this.store.getRepo(owner, name) !== undefined) return errorResult(422, 'Repository already exists');
    const description = typeof payload['description'] === 'string' ? (payload['description'] as string) : '';
    const isPrivate = payload['private'] === true;
    const repo = this.store.createRepo(owner, name, description, isPrivate);
    return jsonResult(201, repoView(this.store, repo));
  }

  private patchRepo(repo: Repo, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    if (typeof payload['description'] === 'string') repo.description = payload['description'] as string;
    if (typeof payload['private'] === 'boolean') repo.private = payload['private'] as boolean;
    return jsonResult(200, repoView(this.store, repo));
  }

  private listBranches(repo: Repo): ApiResult {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice(11));
    }
    names.sort();
    const out = names.map((name) => {
      const sha = repo.refs.get(`refs/heads/${name}`) as string;
      return { name, commit: { sha }, sha, protected: false };
    });
    return jsonResult(200, out);
  }

  private getBranch(repo: Repo, branch: string): ApiResult {
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, { name: branch, commit: { sha }, sha, protected: false });
  }

  private listCommits(repo: Repo, query: QueryInput, host: string | undefined): ApiResult {
    const ref = qget(query, 'sha') ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip === undefined && isObjectId(ref)) tip = repo.objects.has(ref) ? ref : undefined;
    if (tip === undefined) return errorResult(404, 'Not Found');
    const { page, perPage } = pageParams(query);
    const walked = walkAncestors(repo, tip);
    const { pageItems, totalPages } = paginate(walked, page, perPage);
    const path = `/repos/${repo.owner}/${repo.name}/commits`;
    const extra = linkHeader(host, path, query, page, perPage, totalPages);
    const out = pageItems.map((sha) => {
      const commit = commitOf(repo, sha);
      const author = commit === null ? { name: '', email: '', date: isoFromSeq(0) } : identityParts(commit.author);
      const committer = commit === null ? { name: '', email: '', date: isoFromSeq(0) } : identityParts(commit.committer);
      return {
        sha,
        commit: { message: commit === null ? '' : commit.message, author, committer },
        author: null,
        committer: null,
        parents: commit === null ? [] : commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return jsonResult(200, out, extra);
  }

  // ------------------------------------------------------------ contents

  private branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  private commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string, parent: string | null): string {
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    });
    const sha = hashObject('commit', commitData);
    repo.objects.set(sha, { type: 'commit', data: Buffer.from(commitData) });
    repo.refs.set(`refs/heads/${branch}`, sha);
    this.store.touchRepo(repo);
    return sha;
  }

  private getContents(repo: Repo, contentPath: string, query: QueryInput): ApiResult {
    const ref = qget(query, 'ref') ?? repo.defaultBranch;
    const tip = this.branchTip(repo, ref);
    if (tip === undefined) return errorResult(404, 'Not Found');
    const commit = commitOf(repo, tip);
    if (commit === null) return errorResult(404, 'Not Found');
    const segments = contentPath === '' ? [] : contentPath.split('/');
    if (segments.length === 0) {
      return jsonResult(200, this.directoryListing(repo, commit.tree, ''));
    }
    const entry = treeAtPath(repo, commit.tree, segments);
    if (entry === null) return errorResult(404, 'Not Found');
    if (entry.mode === '040000') {
      return jsonResult(200, this.directoryListing(repo, entry.oid, contentPath));
    }
    const bytes = blobBytes(repo, entry.oid);
    if (bytes === null) return errorResult(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: segments[segments.length - 1],
      path: contentPath,
      sha: entry.oid,
      content: bytes.toString('base64'),
    });
  }

  private directoryListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
    const entries = treeEntriesOf(repo, treeOid).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries.map((entry) => {
      const isDir = entry.mode === '040000';
      const bytes = isDir ? null : blobBytes(repo, entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        size: bytes === null ? 0 : bytes.length,
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
      };
    });
  }

  private putContents(repo: Repo, contentPath: string, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const message = asNonEmptyString(payload['message']) ?? `Update ${contentPath}`;
    const content = payload['content'];
    if (typeof content !== 'string') return errorResult(422, 'Validation Failed: content is required');
    const branch = typeof payload['branch'] === 'string' && payload['branch'] !== '' ? (payload['branch'] as string) : repo.defaultBranch;
    const segments = contentPath.split('/').filter((part) => part !== '');
    if (segments.length === 0) return errorResult(422, 'Validation Failed: path is required');
    const tip = this.branchTip(repo, branch);
    const parentCommit = tip === undefined ? null : commitOf(repo, tip);
    const existing = parentCommit === null ? null : treeAtPath(repo, parentCommit.tree, segments);
    if (existing !== null && existing.mode === '040000') return errorResult(422, 'Validation Failed: path is a directory');
    if (existing !== null) {
      const givenSha = payload['sha'];
      if (typeof givenSha !== 'string') return errorResult(422, 'Validation Failed: sha is required to update a file');
      if (givenSha !== existing.oid) return errorResult(409, 'Conflict: sha does not match the current file');
    }
    const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = hashObject('blob', bytes);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: bytes });
    const rootTree = parentCommit === null ? null : parentCommit.tree;
    const newRoot = setTreePath(repo, rootTree, segments, blobOid, '100644');
    const treeOid = newRoot === null ? storeTree(repo, []) : newRoot;
    const commitSha = this.commitOnBranch(repo, branch, treeOid, message, tip ?? null);
    const name = segments[segments.length - 1] as string;
    return jsonResult(existing === null ? 201 : 200, {
      content: { name, path: contentPath, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  private deleteContents(repo: Repo, contentPath: string, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const message = asNonEmptyString(payload['message']) ?? `Delete ${contentPath}`;
    const branch = typeof payload['branch'] === 'string' && payload['branch'] !== '' ? (payload['branch'] as string) : repo.defaultBranch;
    const segments = contentPath.split('/').filter((part) => part !== '');
    if (segments.length === 0) return errorResult(422, 'Validation Failed: path is required');
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return errorResult(404, 'Not Found');
    const parentCommit = commitOf(repo, tip);
    if (parentCommit === null) return errorResult(404, 'Not Found');
    const existing = treeAtPath(repo, parentCommit.tree, segments);
    if (existing === null || existing.mode === '040000') return errorResult(404, 'Not Found');
    const givenSha = payload['sha'];
    if (typeof givenSha !== 'string') return errorResult(422, 'Validation Failed: sha is required to delete a file');
    if (givenSha !== existing.oid) return errorResult(409, 'Conflict: sha does not match the current file');
    const newRoot = setTreePath(repo, parentCommit.tree, segments, null, '100644');
    const treeOid = newRoot === null ? storeTree(repo, []) : newRoot;
    const commitSha = this.commitOnBranch(repo, branch, treeOid, message, tip);
    return jsonResult(200, { content: null, commit: { sha: commitSha, message } });
  }

  // ------------------------------------------------------------ git refs

  private refObjectType(repo: Repo, sha: string): string {
    const object = repo.objects.get(sha);
    return object === undefined ? 'commit' : object.type;
  }

  private createRef(repo: Repo, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const ref = asNonEmptyString(payload['ref']);
    const sha = asNonEmptyString(payload['sha']);
    if (ref === null || !ref.startsWith('refs/') || sha === null || !isObjectId(sha)) return errorResult(422, 'Validation Failed');
    if (!repo.objects.has(sha)) return errorResult(422, 'Validation Failed: sha does not exist');
    if (repo.refs.has(ref)) return errorResult(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    this.store.touchRepo(repo);
    return jsonResult(201, { ref, object: { sha, type: this.refObjectType(repo, sha) } });
  }

  private listRefs(repo: Repo): ApiResult {
    const refs = [...repo.refs.keys()].sort();
    return jsonResult(200, refs.map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string, type: this.refObjectType(repo, repo.refs.get(ref) as string) } })));
  }

  private getRef(repo: Repo, ref: string): ApiResult {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, { ref, object: { sha, type: this.refObjectType(repo, sha) } });
  }

  private deleteRef(repo: Repo, ref: string): ApiResult {
    if (!repo.refs.has(ref)) return errorResult(404, 'Not Found');
    if (ref === `refs/heads/${repo.defaultBranch}`) return errorResult(422, 'Validation Failed: cannot delete the default branch');
    repo.refs.delete(ref);
    this.store.touchRepo(repo);
    return noContentResult();
  }

  // ------------------------------------------------------------ labels

  private listLabels(repo: Repo): ApiResult {
    const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return jsonResult(200, labels.map((label) => labelView(label)));
  }

  private createLabel(repo: Repo, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const name = asNonEmptyString(payload['name']);
    if (name === null) return errorResult(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return errorResult(422, 'Label already exists');
    const color = typeof payload['color'] === 'string' && payload['color'] !== '' ? (payload['color'] as string) : 'ededed';
    const description = typeof payload['description'] === 'string' ? (payload['description'] as string) : '';
    const label = this.store.createLabel(repo, name, color, description);
    return jsonResult(201, labelView(label));
  }

  // ------------------------------------------------------------ issues

  private listIssues(repo: Repo, query: QueryInput, host: string | undefined): ApiResult {
    const state = qget(query, 'state') ?? 'open';
    const sort = qget(query, 'sort') ?? 'created';
    const direction = qget(query, 'direction') ?? 'desc';
    const { page, perPage } = pageParams(query);
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    else if (state !== 'all') return errorResult(422, 'Validation Failed: unknown state');
    const key = sort === 'updated' ? (issue: Issue): number => issue.updatedSeq : (issue: Issue): number => issue.createdSeq;
    issues.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
    const { pageItems, totalPages } = paginate(issues, page, perPage);
    const path = `/repos/${repo.owner}/${repo.name}/issues`;
    const extra = linkHeader(host, path, query, page, perPage, totalPages);
    return jsonResult(200, pageItems.map((issue) => issueView(this.store, repo, issue)), extra);
  }

  private createIssue(repo: Repo, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const title = asNonEmptyString(payload['title']);
    if (title === null) return errorResult(422, 'Validation Failed: title is required');
    const body = typeof payload['body'] === 'string' ? (payload['body'] as string) : '';
    const rawLabels = payload['labels'];
    const labelNames: string[] = [];
    if (Array.isArray(rawLabels)) {
      for (const entry of rawLabels) {
        if (typeof entry === 'string') labelNames.push(entry);
        else if (isRecord(entry) && typeof entry['name'] === 'string') labelNames.push(entry['name'] as string);
      }
    }
    for (const name of labelNames) {
      if (repo.labels.get(name) === undefined) return errorResult(422, `Validation Failed: label '${name}' does not exist`);
    }
    const issue = this.store.createIssue(repo, title, body, labelNames, this.store.viewerLogin);
    return jsonResult(201, issueView(this.store, repo, issue));
  }

  private patchIssue(repo: Repo, issue: Issue, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    if (payload['state'] !== undefined) {
      if (payload['state'] !== 'open' && payload['state'] !== 'closed') return errorResult(422, 'Validation Failed: unknown state');
      issue.state = payload['state'] as 'open' | 'closed';
    }
    if (typeof payload['title'] === 'string' && payload['title'] !== '') issue.title = payload['title'] as string;
    if (typeof payload['body'] === 'string') issue.body = payload['body'] as string;
    if (Array.isArray(payload['labels'])) {
      const names: string[] = [];
      for (const entry of payload['labels'] as unknown[]) {
        if (typeof entry === 'string') names.push(entry);
        else if (isRecord(entry) && typeof entry['name'] === 'string') names.push(entry['name'] as string);
      }
      for (const name of names) {
        if (repo.labels.get(name) === undefined) return errorResult(422, `Validation Failed: label '${name}' does not exist`);
      }
      issue.labels = names;
    }
    issue.updatedSeq = this.store.nextSeq();
    return jsonResult(200, issueView(this.store, repo, issue));
  }

  private listComments(repo: Repo, issue: Issue): ApiResult {
    return jsonResult(200, issue.comments.map((comment) => commentView(this.store, repo, issue, comment)));
  }

  private createComment(repo: Repo, issue: Issue, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const body = asNonEmptyString(payload['body']);
    if (body === null) return errorResult(422, 'Validation Failed: body is required');
    const comment = this.store.addComment(repo, issue, this.store.viewerLogin, body);
    return jsonResult(201, commentView(this.store, repo, issue, comment));
  }

  // ------------------------------------------------------------ pulls

  private listPulls(repo: Repo, query: QueryInput, host: string | undefined): ApiResult {
    const state = qget(query, 'state') ?? 'open';
    const { page, perPage } = pageParams(query);
    let pulls = [...repo.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    else if (state !== 'all') return errorResult(422, 'Validation Failed: unknown state');
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    const { pageItems, totalPages } = paginate(pulls, page, perPage);
    const path = `/repos/${repo.owner}/${repo.name}/pulls`;
    const extra = linkHeader(host, path, query, page, perPage, totalPages);
    return jsonResult(200, pageItems.map((pull) => this.pullView(repo, pull)), extra);
  }

  private createPull(repo: Repo, payload: unknown): ApiResult {
    if (!isRecord(payload)) return errorResult(422, 'Validation Failed');
    const title = asNonEmptyString(payload['title']);
    const head = asNonEmptyString(payload['head']);
    const base = asNonEmptyString(payload['base']);
    if (title === null || head === null || base === null) return errorResult(422, 'Validation Failed: title, head and base are required');
    const body = typeof payload['body'] === 'string' ? (payload['body'] as string) : '';
    const opened = this.openPull(repo, title, body, head, base, this.store.viewerLogin);
    if ('error' in opened) return errorResult(opened.status, opened.error);
    return jsonResult(201, this.pullView(repo, opened.pull));
  }
}
