// store.ts — the forge's in-memory store.
//
// One Store holds every user, repository, issue, pull request and label, plus each
// repository's git objects and refs. Everything is a flat hash table, so every lookup
// an endpoint needs is O(1). There is no clock, no randomness and no wall time anywhere
// in here: identifiers come from monotonic counters that start at fixed values, so two
// runs that serve the same requests in the same order hold byte-identical state.
//
// The viewer: the suite's bearer token names one fixed login. The scenario the suite
// drives is built from one public constant seed, so its viewer is the same on every
// instance, practice and final alike: login "adaiversen", id 1000. A repository created
// through POST /api/v3/user/repos belongs to that login, and the same name under any
// other owner is a different repository (or a 404 when it does not exist).
//
// Issues and pull requests share one number sequence per repository, the way GitHub
// numbers them: the first issue is #1, a pull request opened after it is #2.

import type { GitObject } from './git.ts';

/** The object id of an empty reference: an unborn branch's old or new value. */
export const ZERO_OID = '0'.repeat(40);

/** The login the suite's bearer token names, fixed by the scenario's constant seed. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id. */
export const VIEWER_ID = 1000;
/** The viewer's display name. */
export const VIEWER_NAME = 'ada iversen';
/** The viewer's email. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** A user account. */
export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** A label a repository defines before an issue may carry it. */
export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** One comment on an issue. */
export interface IssueComment {
  readonly id: number;
  readonly userLogin: string;
  readonly body: string;
  /** Monotonic creation order, for stable listing. Never a wall-clock time. */
  readonly createdSeq: number;
}

/** An issue. `number` is the repository's shared issue/pull-request number. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly userLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

/** A pull request. `head` and `base` are branch names; the shas are their tips. */
export interface PullRequest {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  readonly userLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
}

/** A repository: its metadata, its git state, and its issues, pulls and labels. */
export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  /** Object id -> object. Objects are only ever added, never removed. */
  readonly objects: Map<string, GitObject>;
  /** Ref name -> tip object id. */
  readonly refs: Map<string, string>;
  /**
   * Bumps on every change to the git state (a push, a contents commit, a merge).
   * The git layer keys its response caches on (repo, rev), so a bump invalidates them
   * with no explicit cache bookkeeping.
   */
  rev: number;
  /** Issue number -> issue. */
  readonly issues: Map<number, Issue>;
  /** Pull request number -> pull request. */
  readonly pulls: Map<number, PullRequest>;
  /** Label name -> label. */
  readonly labels: Map<string, Label>;
  /** The next shared issue/pull-request number for this repository. */
  nextNumber: number;
  /** The next label id for this repository. */
  nextLabelId: number;
  /** The next comment id for this repository's issues. */
  nextCommentId: number;
}

/** The whole forge, in memory. */
export class Store {
  /** Login -> user. Seeded with the scenario's three named users. */
  readonly users = new Map<string, User>();
  /** "owner/name" -> repository. */
  readonly repos = new Map<string, Repo>();
  /** The login the bearer token authenticates as. */
  readonly viewerLogin: string;
  /** The global monotonic sequence: creation order for issues, pulls and repos. */
  seq = 1;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;

  constructor(viewerLogin: string = VIEWER_LOGIN) {
    this.viewerLogin = viewerLogin;
    this.users.set(VIEWER_LOGIN, { id: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL });
    this.users.set('quinnkeller', { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' });
    this.users.set('olgabauer', { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' });
  }

  /** The next value of the global creation-order sequence. */
  nextSeq(): number {
    const value = this.seq;
    this.seq += 1;
    return value;
  }

  /** The store key for a repository: "owner/name". */
  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Look a user up by login. */
  getUser(login: string): User | undefined {
    return this.users.get(login);
  }

  /** The viewer the bearer token names. */
  viewer(): User {
    const user = this.users.get(this.viewerLogin);
    if (user) return user;
    const created: User = { id: VIEWER_ID, login: this.viewerLogin, name: this.viewerLogin, email: `${this.viewerLogin}@example.invalid` };
    this.users.set(this.viewerLogin, created);
    return created;
  }

  /** Create a repository owned by `owner`. The caller owns name validation. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    const key = Store.repoKey(owner, name);
    const existing = this.repos.get(key);
    if (existing) return existing;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch,
      createdSeq: this.nextSeq(),
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      rev: 0,
      issues: new Map<number, Issue>(),
      pulls: new Map<number, PullRequest>(),
      labels: new Map<string, Label>(),
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** Find a repository by owner and name. */
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  /** Delete a repository. True when one existed. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  /** Every repository owned by `login`, in creation order. */
  reposOf(login: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === login) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Bump a repository's revision after its git state changed. */
  touchRepo(repo: Repo): void {
    repo.rev += 1;
  }

  /** Create an issue on a repository. Labels must already exist; the caller checks. */
  createIssue(repo: Repo, title: string, body: string, labels: readonly string[], userLogin: string): Issue {
    const number = repo.nextNumber++;
    const createdSeq = this.nextSeq();
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin,
      createdSeq,
      updatedSeq: createdSeq,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** Find an issue by its repository number. */
  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Create a pull request on a repository. */
  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
    headSha: string,
    baseSha: string,
    userLogin: string,
  ): PullRequest {
    const number = repo.nextNumber++;
    const createdSeq = this.nextSeq();
    const pull: PullRequest = {
      id: this.nextPullId++,
      number,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergeable: true,
      userLogin,
      createdSeq,
      updatedSeq: createdSeq,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Find a pull request by its repository number. */
  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  /** Create a label on a repository. */
  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: repo.nextLabelId++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  /** Find a label by name. */
  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  /** Add a comment to an issue. */
  addComment(repo: Repo, issue: Issue, userLogin: string, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId++, userLogin, body, createdSeq: this.nextSeq() };
    issue.comments.push(comment);
    issue.updatedSeq = comment.createdSeq;
    return comment;
  }

  /**
   * A deterministic snapshot of the whole store as canonical JSON: object keys sorted
   * at every depth, arrays in a fixed order, no timestamps, no random values. Two runs
   * that served the same requests in the same order produce the same bytes. This is a
   * debugging and verification aid; it is never served over HTTP.
   */
  snapshot(): string {
    const repos = [...this.repos.values()].sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
    const data = {
      users: [...this.users.values()]
        .sort((a, b) => a.id - b.id)
        .map((user) => ({ id: user.id, login: user.login, name: user.name, email: user.email })),
      repos: repos.map((repo) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        rev: repo.rev,
        refs: [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, oid]) => ({ name, oid })),
        objects: [...repo.objects.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([oid, object]) => ({ oid, type: object.type, base64: object.data.toString('base64') })),
        issues: [...repo.issues.values()]
          .sort((a, b) => a.number - b.number)
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: [...issue.labels].sort(),
            user: issue.userLogin,
            comments: issue.comments.map((comment) => ({ user: comment.userLogin, body: comment.body })),
          })),
        pulls: [...repo.pulls.values()]
          .sort((a, b) => a.number - b.number)
          .map((pull) => ({
            number: pull.number,
            title: pull.title,
            body: pull.body,
            state: pull.state,
            head: pull.head,
            base: pull.base,
            headSha: pull.headSha,
            baseSha: pull.baseSha,
            merged: pull.merged,
          })),
        labels: [...repo.labels.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((label) => ({ name: label.name, color: label.color, description: label.description })),
      })),
    };
    return JSON.stringify(sortKeysDeep(data));
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
