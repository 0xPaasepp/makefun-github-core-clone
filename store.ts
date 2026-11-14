// The forge's store: repositories, issues, pull requests, labels and the
// git refs that back them, over the object store in git.ts.
//
// Identity: the suite's bearer token always names the same viewer,
// "adaiversen" (the fixed, public scenario's viewer login). Every
// repository belongs to that login; the same name under another owner is
// 404, never 403. Timestamps are deterministic (a counter off a fixed
// epoch) so two runs on the same requests leave the same state.

import {
  ObjectStore, ZERO_OID, buildCommit, buildTree, collectReachable, hashObject,
  isAncestor, isOid, parseCommit, parseTag, parseTree, peelToCommit,
  type GitObject, type GitObjectType, type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

let seq = 0;
export function nextSeq(): number { seq += 1; return seq; }
/** Deterministic ISO timestamp: 2025-01-01T00:00:00Z + seq seconds. */
export function stamp(n?: number): string {
  const s = n ?? nextSeq();
  return new Date((1735689600 + s) * 1000).toISOString();
}
/** Deterministic git ident line: "ada iversen <adaiversen@example.invalid> <ts> +0000". */
export function ident(n?: number): string {
  const s = n ?? nextSeq();
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${1700000000 + s} +0000`;
}

export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** Opaque Relay global id: base64url of "<kind>:<key>", never the raw number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export interface Label { name: string; color: string; }
export interface Comment { id: number; body: string; createdAt: string; }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; comments: Comment[];
  createdAt: string; updatedAt: string; createdSeq: number;
}
export interface PullRequest {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  mergeCommitSha: string | null; head: string; base: string;
  headSha: string; baseSha: string;
  createdAt: string; updatedAt: string; createdSeq: number;
}

export interface Repo {
  id: number; name: string; owner: string; description: string;
  private: boolean; defaultBranch: string;
  refs: Map<string, string>; // full ref name -> oid
  labels: Map<string, Label>;
  issues: Issue[]; pulls: PullRequest[];
  nextNumber: number; createdSeq: number;
}

export class Store {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>(); // "owner/name" -> Repo
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentIdValue = 1;

  nextCommentId(): number { return this.nextCommentIdValue++; }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | { error: string } {
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return { error: 'already exists' };
    const repo: Repo = {
      id: this.nextRepoId++,
      name, owner: VIEWER_LOGIN,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: [], pulls: [],
      nextNumber: 1, createdSeq: nextSeq(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  repoGlobalId(repo: Repo): string {
    return globalId('R', `${repo.owner}/${repo.name}`);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All refs sorted the way git advertises them: HEAD handled by callers. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ---------------------------------------------------------- git trees

  /** The tree oid at a ref (or the empty tree when the ref is unborn). */
  treeAt(repo: Repo, refName: string): { tree: string; commit: string | null } {
    const tip = repo.refs.get(refName);
    if (!tip) return { tree: this.emptyTree(), commit: null };
    const obj = this.objects.get(tip);
    if (!obj) return { tree: this.emptyTree(), commit: null };
    if (obj.type === 'commit') return { tree: parseCommit(obj.data).tree, commit: tip };
    const peeled = peelToCommit(this.objects, tip);
    if (peeled) {
      const c = this.objects.get(peeled);
      if (c && c.type === 'commit') return { tree: parseCommit(c.data).tree, commit: peeled };
    }
    return { tree: this.emptyTree(), commit: null };
  }

  emptyTree(): string {
    return this.objects.put('tree', Buffer.alloc(0));
  }

  /** Read the file map (path -> {oid, mode}) of a tree, recursively. */
  readTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, pre: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = pre === '' ? e.name : `${pre}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree from a file map. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const s = segs[i];
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.objects.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Commit one file change on `branch` (creating the branch from the
   * default tip when it does not exist yet). Returns the new commit oid.
   */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
    const refName = `refs/heads/${branch}`;
    const { tree, commit } = this.treeAt(repo, refName);
    const baseTree = branch === repo.defaultBranch || repo.refs.has(refName)
      ? tree
      : this.treeAt(repo, `refs/heads/${repo.defaultBranch}`).tree;
    const files = this.readTree(baseTree);
    if (content === null) files.delete(path);
    else files.set(path, { oid: this.objects.put('blob', content), mode: '100644' });
    const newTree = this.buildTreeFromFiles(files);
    const parents: string[] = [];
    const tip = repo.refs.get(refName);
    if (tip) parents.push(tip);
    else if (branch !== repo.defaultBranch) {
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (baseTip) parents.push(baseTip);
    }
    const n = nextSeq();
    const who = ident(n);
    const commitData = buildCommit(newTree, parents, who, who, message.endsWith('\n') ? message : `${message}\n`);
    const oid = this.objects.put('commit', commitData);
    repo.refs.set(refName, oid);
    return oid;
  }

  /** Commits reachable from a ref, tip first. */
  commitsOf(repo: Repo, refName: string): string[] {
    const tip = repo.refs.get(refName);
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') { queue.push(parseTag(obj.data).object); continue; }
      if (obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }

  /** First common ancestor of two commits (linear histories: walk both sides). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const qa = [a];
    while (qa.length) {
      const oid = qa.shift()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
    }
    const qb = [b];
    const seen = new Set<string>();
    while (qb.length) {
      const oid = qb.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
    }
    return null;
  }

  /** Files differing between two trees: path -> {status, oldOid, newOid}. */
  diffTrees(oldTree: string, newTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const oldFiles = this.readTree(oldTree);
    const newFiles = this.readTree(newTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, e] of newFiles) {
      const o = oldFiles.get(path);
      if (!o) out.push({ path, status: 'added', oldOid: null, newOid: e.oid });
      else if (o.oid !== e.oid) out.push({ path, status: 'modified', oldOid: o.oid, newOid: e.oid });
    }
    for (const [path, e] of oldFiles) {
      if (!newFiles.has(path)) out.push({ path, status: 'removed', oldOid: e.oid, newOid: null });
    }
    out.sort((x, y) => (x.path < y.path ? -1 : 1));
    return out;
  }

  lineCount(oid: string | null): number {
    if (!oid) return 0;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'blob') return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** Would squashing `headSha` onto `baseSha` conflict? */
  mergeConflict(baseSha: string, headSha: string): boolean {
    const base = mergeBaseOf(this, baseSha, headSha);
    if (!base) return false;
    const baseTree = this.treeAtCommit(base);
    const baseTipTree = this.treeAtCommit(baseSha);
    const headTree = this.treeAtCommit(headSha);
    if (baseTree === null || baseTipTree === null || headTree === null) return false;
    const changedOnBase = this.diffTrees(baseTree, baseTipTree);
    const changedOnHead = this.diffTrees(baseTree, headTree);
    const headByPath = new Map(changedOnHead.map((d) => [d.path, d]));
    for (const d of changedOnBase) {
      const h = headByPath.get(d.path);
      if (h && h.newOid !== d.newOid) return true;
    }
    return false;
  }

  treeAtCommit(commitOid: string): string | null {
    const obj = this.objects.get(commitOid);
    if (!obj) return null;
    if (obj.type === 'commit') return parseCommit(obj.data).tree;
    const peeled = peelToCommit(this.objects, commitOid);
    if (!peeled) return null;
    const c = this.objects.get(peeled);
    return c && c.type === 'commit' ? parseCommit(c.data).tree : null;
  }

  // ---------------------------------------------------------- issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const n = nextSeq();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title, body: body ?? '',
      state: 'open', labels, comments: [],
      createdAt: stamp(n), updatedAt: stamp(n), createdSeq: n,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    const n = nextSeq();
    const pr: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title, body: body ?? '',
      state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      head, base,
      headSha: this.branchTip(repo, head) ?? ZERO_OID,
      baseSha: this.branchTip(repo, base) ?? ZERO_OID,
      createdAt: stamp(n), updatedAt: stamp(n), createdSeq: n,
    };
    repo.pulls.push(pr);
    return pr;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    const headTip = this.branchTip(repo, pr.head);
    const baseTip = this.branchTip(repo, pr.base);
    if (!headTip || !baseTip) return null;
    if (this.mergeConflict(baseTip, headTip)) return null;
    const headTree = this.treeAtCommit(headTip);
    if (headTree === null) return null;
    const n = nextSeq();
    const who = ident(n);
    const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}\n`;
    const data = buildCommit(headTree, [baseTip], who, who, message);
    const oid = this.objects.put('commit', data);
    repo.refs.set(`refs/heads/${pr.base}`, oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = stamp(n);
    pr.mergeCommitSha = oid;
    pr.updatedAt = stamp(n);
    pr.baseSha = oid;
    return oid;
  }

  /** The git object id of a blob's bytes (for contents sha checks). */
  blobOid(data: Buffer): string {
    return hashObject('blob', data);
  }
}

function mergeBaseOf(store: Store, a: string, b: string): string | null {
  return store.mergeBase(a, b);
}

export type { GitObject, GitObjectType };
export { ZERO_OID, isOid };
