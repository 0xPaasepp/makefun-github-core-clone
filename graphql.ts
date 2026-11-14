// Minimal GraphQL over POST /api/graphql: a small tokenizer + parser for
// the documents the suite sends, a hand-built schema, and an executor that
// reads and mutates the same store as REST. Batch bodies (an array of
// operations) return an array of results in order. Unknown fields produce
// HTTP 200 with an errors array naming the field, as real GraphQL does;
// an unknown repository yields data.repository null with no errors.

import {
  VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, b64encode, decodeGlobalId,
  globalId, stamp,
  type Issue, type PullRequest, type Repo, type Store,
} from './store.ts';
import { ZERO_OID } from './git.ts';

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'string' | 'punct' | 'spread';
interface Token { kind: TokenKind; value: string; }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

export interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: SelectionNode[];
}
export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentNode;
export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, FragmentNode>;

  constructor(tokens: Token[], variables: Record<string, unknown>, fragments: Map<string, FragmentNode>) {
    this.tokens = tokens;
    this.variables = variables;
    this.fragments = fragments;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (!t || t.kind !== 'punct' || t.value !== v) throw new Error(`expected "${v}"`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const nameTok = this.next();
        const onTok = this.next();
        const typeTok = this.next();
        if (!nameTok || !onTok || !typeTok) throw new Error('malformed fragment');
        const selections = this.parseSelectionSet();
        this.fragments.set(nameTok.value, { kind: 'fragment', typeCondition: typeTok.value, selections });
        continue;
      }
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n?.kind === 'name') { name = n.value; this.next(); }
      // Variable definitions ($x: Type = default) — skipped, values come from the body.
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (!tok) throw new Error('unterminated variable definitions');
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables: this.variables, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') { this.next(); break; }
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeTok = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition: typeTok?.value ?? null, selections };
      }
      if (next?.kind === 'name') {
        this.next();
        const frag = this.fragments.get(next.value);
        if (!frag) throw new Error(`unknown fragment ${next.value}`);
        return frag;
      }
      throw new Error('malformed fragment spread');
    }
    // Field: [alias :] name [( args )] [selection set]
    const first = this.next();
    if (!first || first.kind !== 'name') throw new Error('expected field name');
    let alias = first.value;
    let name = first.value;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      const n = this.next();
      if (!n || n.kind !== 'name') throw new Error('expected field name after alias');
      name = n.value;
    }
    const args: Record<string, unknown> = {};
    if (this.acceptPunct('(')) {
      while (true) {
        const at = this.peek();
        if (!at) throw new Error('unterminated arguments');
        if (at.kind === 'punct' && at.value === ')') { this.next(); break; }
        const argName = this.next();
        if (!argName || argName.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[argName.value] = this.parseValue();
      }
    }
    // Directives (@...) — skipped.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      const dirName = this.next();
      void dirName;
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (!tok) throw new Error('unterminated directive');
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): unknown {
    const t = this.next();
    if (!t) throw new Error('expected value');
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'punct' && t.value === '$') {
      const nameTok = this.next();
      if (!nameTok || nameTok.kind !== 'name') throw new Error('expected variable name');
      return this.variables[nameTok.value] ?? null;
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: unknown[] = [];
      while (true) {
        const n = this.peek();
        if (!n) throw new Error('unterminated list');
        if (n.kind === 'punct' && n.value === ']') { this.next(); break; }
        items.push(this.parseValue());
      }
      return items;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const n = this.peek();
        if (!n) throw new Error('unterminated input object');
        if (n.kind === 'punct' && n.value === '}') { this.next(); break; }
        const key = this.next();
        if (!key || key.kind !== 'name') throw new Error('expected input field name');
        this.expectPunct(':');
        obj[key.value] = this.parseValue();
      }
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum literal, kept as a string
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema (field lists for introspection + unknown-field errors)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'labels', 'comments', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['name', 'color'],
  Comment: ['id', 'body', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Viewer: 'OBJECT', Repository: 'OBJECT',
  Issue: 'OBJECT', PullRequest: 'OBJECT', User: 'OBJECT', Ref: 'OBJECT',
  IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT', PullRequestFileConnection: 'OBJECT',
  IssueEdge: 'OBJECT', PullRequestEdge: 'OBJECT', PullRequestFileEdge: 'OBJECT',
  PageInfo: 'OBJECT', Label: 'OBJECT', Comment: 'OBJECT', CommentEdge: 'OBJECT',
  CommentConnection: 'OBJECT', PullRequestFile: 'OBJECT',
  CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT', CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT', AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT', __Field: 'OBJECT', __EnumValue: 'OBJECT', __Schema: 'OBJECT',
  IssueState: 'ENUM', PullRequestState: 'ENUM', SearchType: 'ENUM',
  MergeableState: 'ENUM', MergeMethod: 'ENUM', OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM', PullRequestOrderField: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  errors: Array<{ message: string }>;
}

type Value = Record<string, unknown> | null;

function cursorForNumber(n: number): string {
  return b64encode(`cursor:${n}`);
}
function numberFromCursor(after: unknown): number | null {
  if (typeof after !== 'string') return null;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function unknownField(ctx: ExecContext, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function checkFields(ctx: ExecContext, typeName: string, selections: SelectionNode[]): SelectionNode[] {
  const known = TYPE_FIELDS[typeName] ?? [];
  const out: SelectionNode[] = [];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      out.push(...checkFields(ctx, typeName, sel.selections));
      continue;
    }
    if (sel.name === '__typename') { out.push(sel); continue; }
    if (!known.includes(sel.name)) { unknownField(ctx, typeName, sel.name); continue; }
    out.push(sel);
  }
  return out;
}

function executeSelections(ctx: ExecContext, typeName: string, source: unknown, selections: SelectionNode[], resolve: (field: FieldNode, source: unknown) => unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const valid = checkFields(ctx, typeName, selections);
  for (const sel of valid) {
    if (sel.kind === 'fragment') continue; // flattened by checkFields
    if (sel.name === '__typename') { result[sel.alias] = typeName; continue; }
    const value = resolve(sel, source);
    result[sel.alias] = value;
  }
  return result;
}

// --- value builders ---------------------------------------------------------

function repoValue(ctx: ExecContext, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'Repository', repo, selections, (field, src) => {
    const r = src as Repo;
    switch (field.name) {
      case 'id': return globalId('R', `${r.owner}/${r.name}`);
      case 'databaseId': return r.id;
      case 'name': return r.name;
      case 'nameWithOwner': return `${r.owner}/${r.name}`;
      case 'description': return r.description;
      case 'isPrivate': return r.private;
      case 'owner': return executeSelections(ctx, 'User', null, field.selections, (f) => (f.name === 'login' ? r.owner : f.name === 'id' ? VIEWER_ID : null));
      case 'defaultBranchRef': {
        const tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
        if (!tip) return null;
        return executeSelections(ctx, 'Ref', null, field.selections, (f) => (f.name === 'name' ? r.defaultBranch : null));
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const n = field.args.number as number | undefined;
        const issue = r.issues.find((i) => i.number === n);
        if (!issue) return null;
        return issueValue(ctx, r, issue, field.selections);
      }
      case 'issues': return issuesConnection(ctx, r, field);
      case 'pullRequest': {
        const n = field.args.number as number | undefined;
        const pr = r.pulls.find((p) => p.number === n);
        if (!pr) return null;
        return prValue(ctx, r, pr, field.selections);
      }
      case 'pullRequests': return prsConnection(ctx, r, field);
      default: return null;
    }
  });
}

function issuesConnection(ctx: ExecContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = typeof field.args.first === 'number' ? field.args.first : 30;
  const after = numberFromCursor(field.args.after);
  const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
  let issues = [...repo.issues].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  if (after !== null) issues = issues.filter((i) => i.number < after);
  const page = issues.slice(0, first);
  const hasNext = issues.length > first;
  return connectionValue(ctx, field, page, (issue, sels) => issueValue(ctx, repo, issue, sels), hasNext, page.length > 0 ? cursorForNumber(page[page.length - 1]!.number) : null);
}

function prsConnection(ctx: ExecContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = typeof field.args.first === 'number' ? field.args.first : 30;
  const after = numberFromCursor(field.args.after);
  const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
  let prs = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    prs = prs.filter((p) => wanted.has(p.state));
  }
  if (after !== null) prs = prs.filter((p) => p.number < after);
  const page = prs.slice(0, first);
  const hasNext = prs.length > first;
  return connectionValue(ctx, field, page, (pr, sels) => prValue(ctx, repo, pr, sels), hasNext, page.length > 0 ? cursorForNumber(page[page.length - 1]!.number) : null);
}

function connectionValue<T>(
  ctx: ExecContext,
  field: FieldNode,
  page: T[],
  nodeValue: (item: T, selections: SelectionNode[]) => Record<string, unknown>,
  hasNext: boolean,
  endCursor: string | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const sel of field.selections) {
    if (sel.kind === 'fragment') continue;
    if (sel.name === 'nodes') {
      result[sel.alias] = page.map((item) => nodeValue(item, sel.selections));
    } else if (sel.name === 'edges') {
      result[sel.alias] = page.map((item) => executeSelections(ctx, 'IssueEdge', null, sel.selections, (f) => {
        if (f.name === 'node') return nodeValue(item, f.selections);
        if (f.name === 'cursor') return endCursor;
        return null;
      }));
    } else if (sel.name === 'pageInfo') {
      result[sel.alias] = executeSelections(ctx, 'PageInfo', null, sel.selections, (f) => {
        if (f.name === 'hasNextPage') return hasNext;
        if (f.name === 'endCursor') return endCursor;
        if (f.name === 'hasPreviousPage') return false;
        if (f.name === 'startCursor') return page.length > 0 ? endCursor : null;
        return null;
      });
    } else if (sel.name === 'totalCount') {
      result[sel.alias] = page.length;
    }
  }
  return result;
}

function issueValue(ctx: ExecContext, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'Issue', issue, selections, (field, src) => {
    const i = src as Issue;
    switch (field.name) {
      case 'id': return globalId('I', `${repo.owner}/${repo.name}:${i.number}`);
      case 'number': return i.number;
      case 'title': return i.title;
      case 'body': return i.body;
      case 'state': return i.state.toUpperCase();
      case 'createdAt': return i.createdAt;
      case 'updatedAt': return i.updatedAt;
      case 'labels': return i.labels.map((l) => executeSelections(ctx, 'Label', null, field.selections, (f) => (f.name === 'name' ? l.name : f.name === 'color' ? l.color : null)));
      case 'comments': {
        const first = typeof field.args.first === 'number' ? field.args.first : 30;
        const comments = i.comments.slice(0, first);
        return connectionValue(ctx, field, comments, (c, sels) => executeSelections(ctx, 'Comment', null, sels, (f) => {
          if (f.name === 'id') return c.id;
          if (f.name === 'body') return c.body;
          if (f.name === 'createdAt') return c.createdAt;
          return null;
        }), i.comments.length > first, comments.length > 0 ? cursorForNumber(comments[comments.length - 1]!.id) : null);
      }
      default: return null;
    }
  });
}

function prValue(ctx: ExecContext, repo: Repo, pr: PullRequest, selections: SelectionNode[]): Record<string, unknown> {
  return executeSelections(ctx, 'PullRequest', pr, selections, (field, src) => {
    const p = src as PullRequest;
    switch (field.name) {
      case 'id': return globalId('P', `${repo.owner}/${repo.name}:${p.number}`);
      case 'number': return p.number;
      case 'title': return p.title;
      case 'body': return p.body;
      case 'state': return p.merged ? 'MERGED' : p.state.toUpperCase();
      case 'merged': return p.merged;
      case 'headRefName': return p.head;
      case 'baseRefName': return p.base;
      case 'createdAt': return p.createdAt;
      case 'updatedAt': return p.updatedAt;
      case 'mergeable': {
        const headTip = ctx.store.branchTip(repo, p.head);
        const baseTip = ctx.store.branchTip(repo, p.base);
        if (!headTip || !baseTip) return 'UNKNOWN';
        return ctx.store.mergeConflict(baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const first = typeof field.args.first === 'number' ? field.args.first : 30;
        const baseTree = ctx.store.treeAtCommit(p.baseSha);
        const headTree = ctx.store.treeAtCommit(p.headSha);
        if (baseTree === null || headTree === null) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const diff = ctx.store.diffTrees(baseTree, headTree);
        const page = diff.slice(0, first);
        return connectionValue(ctx, field, page, (d, sels) => executeSelections(ctx, 'PullRequestFile', null, sels, (f) => {
          if (f.name === 'path') return d.path;
          if (f.name === 'additions') return ctx.store.lineCount(d.newOid);
          if (f.name === 'deletions') return ctx.store.lineCount(d.oldOid);
          if (f.name === 'changes') return ctx.store.lineCount(d.newOid) + ctx.store.lineCount(d.oldOid);
          return null;
        }), diff.length > first, null);
      }
      default: return null;
    }
  });
}

// --- mutations --------------------------------------------------------------

function resolveRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const [owner, name] = decoded.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function resolveIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'I') return null;
  const [ownerName, num] = decoded.key.split(':');
  const [owner, name] = (ownerName ?? '').split('/');
  if (!owner || !name) return null;
  const repo = store.getRepo(owner, name);
  const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
  if (!repo || !issue) return null;
  return { repo, issue };
}

function resolvePullByGlobalId(store: Store, id: unknown): { repo: Repo; pr: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'P') return null;
  const [ownerName, num] = decoded.key.split(':');
  const [owner, name] = (ownerName ?? '').split('/');
  if (!owner || !name) return null;
  const repo = store.getRepo(owner, name);
  const pr = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
  if (!repo || !pr) return null;
  return { repo, pr };
}

function executeMutation(ctx: ExecContext, field: FieldNode): Record<string, unknown> | null {
  const input = (field.args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) return null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, []);
      return executeSelections(ctx, 'CreateIssuePayload', null, field.selections, (f) =>
        f.name === 'issue' ? issueValue(ctx, repo, issue, f.selections) : null);
    }
    case 'closeIssue': {
      const found = resolveIssueByGlobalId(ctx.store, input.issueId);
      if (!found) return null;
      found.issue.state = 'closed';
      found.issue.updatedAt = stamp();
      found.issue.cachedJson = null; // REST view cache is stale now
      return executeSelections(ctx, 'CloseIssuePayload', null, field.selections, (f) =>
        f.name === 'issue' ? issueValue(ctx, found.repo, found.issue, f.selections) : null);
    }
    case 'createPullRequest': {
      const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) return null;
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!ctx.store.branchTip(repo, head) || !ctx.store.branchTip(repo, base)) return null;
      const pr = ctx.store.createPull(repo, title, body, head, base);
      return executeSelections(ctx, 'CreatePullRequestPayload', null, field.selections, (f) =>
        f.name === 'pullRequest' ? prValue(ctx, repo, pr, f.selections) : null);
    }
    case 'mergePullRequest': {
      const found = resolvePullByGlobalId(ctx.store, input.pullRequestId);
      if (!found) return null;
      const { repo, pr } = found;
      if (pr.state === 'open') {
        const headTip = ctx.store.branchTip(repo, pr.head);
        const baseTip = ctx.store.branchTip(repo, pr.base);
        if (headTip && baseTip && !ctx.store.mergeConflict(baseTip, headTip)) {
          ctx.store.mergePull(repo, pr);
        }
      }
      return executeSelections(ctx, 'MergePullRequestPayload', null, field.selections, (f) =>
        f.name === 'pullRequest' ? prValue(ctx, repo, pr, f.selections) : null);
    }
    case 'addComment': {
      const found = resolveIssueByGlobalId(ctx.store, input.subjectId);
      const body = typeof input.body === 'string' ? input.body : '';
      if (!found) return null;
      const id = ctx.store.nextCommentId();
      const comment = { id, body, createdAt: stamp() };
      found.issue.comments.push(comment);
      found.issue.cachedJson = null; // comments count changed
      return executeSelections(ctx, 'AddCommentPayload', null, field.selections, (f) => {
        if (f.name !== 'commentEdge') return null;
        return executeSelections(ctx, 'CommentEdge', null, f.selections, (ef) => {
          if (ef.name !== 'node') return null;
          return executeSelections(ctx, 'Comment', null, ef.selections, (cf) => {
            if (cf.name === 'id') return globalId('C', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${id}`);
            if (cf.name === 'body') return body;
            return null;
          });
        });
      });
    }
    default: return null;
  }
}

// --- top-level --------------------------------------------------------------

function executeQuery(ctx: ExecContext, op: Operation): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const valid = checkFields(ctx, 'Query', op.selections);
  for (const sel of valid) {
    if (sel.kind === 'fragment') continue;
    if (sel.name === '__typename') { result[sel.alias] = 'Query'; continue; }
    switch (sel.name) {
      case 'viewer':
        result[sel.alias] = executeSelections(ctx, 'Viewer', null, sel.selections, (f) => {
          if (f.name === 'login') return VIEWER_LOGIN;
          if (f.name === 'id') return VIEWER_ID;
          if (f.name === 'name') return VIEWER_NAME;
          if (f.name === 'email') return VIEWER_EMAIL;
          return null;
        });
        break;
      case 'repository': {
        const owner = sel.args.owner as string | undefined;
        const name = sel.args.name as string | undefined;
        const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
        result[sel.alias] = repo ? repoValue(ctx, repo, sel.selections) : null;
        break;
      }
      case 'node': {
        const id = sel.args.id as string | undefined;
        const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
        if (!decoded) { result[sel.alias] = null; break; }
        if (decoded.kind === 'R') {
          const [owner, name] = decoded.key.split('/');
          const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
          result[sel.alias] = repo ? repoValue(ctx, repo, sel.selections) : null;
        } else if (decoded.kind === 'I') {
          const found = resolveIssueByGlobalId(ctx.store, id);
          result[sel.alias] = found ? issueValue(ctx, found.repo, found.issue, sel.selections) : null;
        } else if (decoded.kind === 'P') {
          const found = resolvePullByGlobalId(ctx.store, id);
          result[sel.alias] = found ? prValue(ctx, found.repo, found.pr, sel.selections) : null;
        } else {
          result[sel.alias] = null;
        }
        break;
      }
      case '__type': {
        const name = sel.args.name as string | undefined;
        const kind = name ? TYPE_KINDS[name] : undefined;
        if (!name || !kind) { result[sel.alias] = null; break; }
        const fields = TYPE_FIELDS[name] ?? [];
        const enumValues = ENUM_VALUES[name] ?? [];
        result[sel.alias] = executeSelections(ctx, '__Type', null, sel.selections, (f) => {
          if (f.name === 'name') return name;
          if (f.name === 'kind') return kind;
          if (f.name === 'fields') {
            return fields.map((fn) => executeSelections(ctx, '__Field', null, f.selections, (ff) => (ff.name === 'name' ? fn : null)));
          }
          if (f.name === 'enumValues') {
            return enumValues.map((ev) => executeSelections(ctx, '__EnumValue', null, f.selections, (ff) => (ff.name === 'name' ? ev : null)));
          }
          return null;
        });
        break;
      }
      case '__schema':
        result[sel.alias] = executeSelections(ctx, '__Schema', null, sel.selections, () => null);
        break;
      default:
        result[sel.alias] = null;
        break;
    }
  }
  return result;
}

export interface GraphQLResult { data?: Record<string, unknown>; errors?: Array<{ message: string }>; }

export function executeGraphQL(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  const runOne = (doc: { query?: unknown; variables?: unknown }): GraphQLResult => {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = doc.variables && typeof doc.variables === 'object' && !Array.isArray(doc.variables)
      ? (doc.variables as Record<string, unknown>)
      : {};
    const ctx: ExecContext = { store, errors: [] };
    let operations: Operation[];
    try {
      const parser = new Parser(tokenize(query), variables, new Map());
      operations = parser.parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'empty query' }] };
    const data: Record<string, unknown> = {};
    for (const op of operations) {
      if (op.kind === 'mutation') {
        const valid = checkFields(ctx, 'Mutation', op.selections);
        for (const sel of valid) {
          if (sel.kind === 'fragment') continue;
          data[sel.alias] = executeMutation(ctx, sel);
        }
      } else {
        Object.assign(data, executeQuery(ctx, op));
      }
    }
    const out: GraphQLResult = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };
  if (Array.isArray(body)) return body.map((doc) => runOne(doc as { query?: unknown; variables?: unknown }));
  return runOne(body as { query?: unknown; variables?: unknown });
}

export { ZERO_OID };
