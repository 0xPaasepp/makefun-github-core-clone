// graphql.ts — the GitHub GraphQL v4 API at POST /api/graphql (stage 2).
// Pure Node standard library. No GraphQL library: a small hand-rolled
// parser + executor covering exactly the document shapes the kit sends
// (viewer, repository, node, __type, issues/pulls connections, the five
// mutations, operation batching). Unknown fields are GraphQL errors on
// HTTP 200, never HTTP 400s; an unknown repository is data.repository
// null with no errors; ids are opaque base64url global ids, stable
// across reads (never the bare database id or number).
//
// Transport contract (stage 3 calls this; mirrors git-http.ts / rest.ts):
//   new GraphqlApi(store, token, rest)
//   handleGraphql(method, path, query, headers, body) -> { status, headers, body }
//   - path '/api/graphql' (a leading '/api/graphql' is expected; anything
//     else answers 404 JSON). body is the full request body as a Buffer.
//   - never throws: malformed JSON -> 400 JSON, anything else -> 500 JSON.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { decodeGlobalId, globalId, isAuthorized, isoFromSeq, nextRequestId } from './rest.ts';
import type { RestApi } from './rest.ts';

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function baseHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() };
}

function jsonResult(status: number, value: unknown): ApiResult {
  return { status, headers: baseHeaders(), body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; type: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): OperationNode {
    this.skipSpace();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.peekWord() === 'query' || this.peekWord() === 'mutation') {
      kind = this.readWord() as 'query' | 'mutation';
      this.skipSpace();
      const word = this.peekWord();
      if (word !== '' && word !== '{' && word !== '(') name = this.readWord();
      this.skipSpace();
    }
    if (this.peek() === '(') this.skipParens();
    this.skipSpace();
    const selections = this.parseSelections();
    return { kind, name, selections };
  }

  private peek(): string {
    return this.pos < this.src.length ? (this.src[this.pos] as string) : '';
  }

  private peekWord(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    return match === null ? '' : match[0];
  }

  private readWord(): string {
    const word = this.peekWord();
    if (word === '') throw new ParseError(`expected a name at offset ${this.pos}`);
    this.pos += word.length;
    return word;
  }

  private skipSpace(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]+/.test(this.src[this.pos] as string)) this.pos += 1;
      if (this.src.startsWith('#', this.pos)) {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private expect(char: string): void {
    this.skipSpace();
    if (this.peek() !== char) throw new ParseError(`expected '${char}' at offset ${this.pos}`);
    this.pos += 1;
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    let inString = false;
    while (this.pos < this.src.length && depth > 0) {
      const char = this.src[this.pos] as string;
      if (inString) {
        if (char === '\\') this.pos += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      this.pos += 1;
    }
    if (depth !== 0) throw new ParseError('unbalanced parentheses');
  }

  private parseSelections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    for (;;) {
      this.skipSpace();
      if (this.peek() === '}') {
        this.pos += 1;
        return out;
      }
      if (this.pos >= this.src.length) throw new ParseError('unterminated selection set');
      out.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    this.skipSpace();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipSpace();
      let type: string | null = null;
      if (this.peekWord() === 'on') {
        this.readWord();
        this.skipSpace();
        type = this.readWord();
        this.skipSpace();
      } else if (this.peekWord() !== '') {
        throw new ParseError('named fragment spreads are not supported');
      }
      return { kind: 'fragment', type, selections: this.parseSelections() };
    }
    const first = this.readWord();
    this.skipSpace();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      this.skipSpace();
      alias = first;
      name = this.readWord();
      this.skipSpace();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipSpace();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readWord();
        this.skipSpace();
        this.expect(':');
        this.skipSpace();
        args.push({ name: argName, value: this.parseValue() });
        this.skipSpace();
      }
    }
    this.skipSpace();
    if (this.peek() === '@') {
      this.pos += 1;
      this.readWord();
      this.skipSpace();
      if (this.peek() === '(') this.skipParens();
      this.skipSpace();
    }
    const selections = this.peek() === '{' ? this.parseSelections() : null;
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): ValueNode {
    this.skipSpace();
    const char = this.peek();
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readWord() };
    }
    if (char === '"') return { kind: 'string', value: this.parseString() };
    if (char === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skipSpace();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
        this.skipSpace();
      }
    }
    if (char === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        this.skipSpace();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readWord();
        this.skipSpace();
        this.expect(':');
        this.skipSpace();
        fields.push({ name, value: this.parseValue() });
        this.skipSpace();
      }
    }
    const word = this.peekWord();
    if (word === 'true') {
      this.pos += 4;
      return { kind: 'boolean', value: true };
    }
    if (word === 'false') {
      this.pos += 5;
      return { kind: 'boolean', value: false };
    }
    if (word === 'null') {
      this.pos += 4;
      return { kind: 'null' };
    }
    if (word !== '') {
      this.pos += word.length;
      return { kind: 'enum', value: word };
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (num !== null) {
      this.pos += num[0].length;
      const value = Number(num[0]);
      return num[0].includes('.') || num[0].includes('e') || num[0].includes('E') ? { kind: 'float', value } : { kind: 'int', value };
    }
    throw new ParseError(`unexpected value at offset ${this.pos}`);
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const char = this.src[this.pos] as string;
      if (char === '"') {
        this.pos += 1;
        return out;
      }
      if (char === '\\') {
        this.pos += 1;
        const esc = this.src[this.pos] as string;
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
      } else {
        out += char;
        this.pos += 1;
      }
    }
    throw new ParseError('unterminated string');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  for (const arg of field.args) {
    if (arg.name === name) return resolveValue(arg.value, variables);
  }
  return undefined;
}

// ---------------------------------------------------------------- introspection tables

interface TypeFieldDef {
  name: string;
  type: string;
}

const TYPE_FIELDS: Readonly<Record<string, readonly TypeFieldDef[]>> = {
  Issue: [
    { name: 'id', type: 'ID' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'IssueState' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'author', type: 'Actor' },
    { name: 'labels', type: 'LabelConnection' },
    { name: 'comments', type: 'IssueCommentConnection' },
    { name: 'repository', type: 'Repository' },
    { name: 'url', type: 'URI' },
  ],
  PullRequest: [
    { name: 'id', type: 'ID' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'PullRequestState' },
    { name: 'headRefName', type: 'String' },
    { name: 'baseRefName', type: 'String' },
    { name: 'mergeable', type: 'MergeableState' },
    { name: 'merged', type: 'Boolean' },
    { name: 'files', type: 'PullRequestChangedFileConnection' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'author', type: 'Actor' },
    { name: 'repository', type: 'Repository' },
    { name: 'url', type: 'URI' },
  ],
  Repository: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'name', type: 'String' },
    { name: 'nameWithOwner', type: 'String' },
    { name: 'owner', type: 'RepositoryOwner' },
    { name: 'defaultBranchRef', type: 'Ref' },
    { name: 'viewerPermission', type: 'RepositoryPermission' },
    { name: 'hasIssuesEnabled', type: 'Boolean' },
    { name: 'issue', type: 'Issue' },
    { name: 'issues', type: 'IssueConnection' },
    { name: 'pullRequests', type: 'PullRequestConnection' },
    { name: 'pullRequest', type: 'PullRequest' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'updatedAt', type: 'DateTime' },
    { name: 'description', type: 'String' },
    { name: 'url', type: 'URI' },
  ],
  SearchType: [],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function typeIntrospection(name: string): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  const isEnum = enums !== undefined;
  return {
    name,
    kind: isEnum ? 'ENUM' : 'OBJECT',
    fields: isEnum
      ? null
      : (fields as readonly TypeFieldDef[]).map((field) => ({ name: field.name, description: '', args: [], type: { kind: 'SCALAR', name: field.type, ofType: null } })),
    enumValues:
      enums === undefined
        ? []
        : (enums as readonly string[]).map((value) => ({ name: value, description: '', isDeprecated: false, deprecationReason: null })),
  };
}

// ---------------------------------------------------------------- executor

interface Executor {
  store: Store;
  rest: RestApi;
  viewerLogin: string;
  errors: Array<{ message: string }>;
}

function repoOf(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

function findRepoById(store: Store, repoId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

function issueStateOut(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOut(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`n:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^n:(\d+)$/.exec(raw);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveSelections(ctx: Executor, typeName: string, source: unknown, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type !== null && selection.type !== typeName) continue;
      const nested = resolveSelections(ctx, typeName, source, selection.selections, variables);
      for (const key of Object.keys(nested)) out[key] = nested[key];
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, typeName, source, field, variables);
    out[key] = value;
  }
  return out;
}

function unknownField(ctx: Executor, typeName: string, field: FieldNode): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function resolveField(ctx: Executor, typeName: string, source: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  // Mutation payload objects resolve through their own branch.
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload' || typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload' || typeName === 'AddCommentPayload') {
    return resolvePayloadField(ctx, typeName, source, field, variables);
  }
  if (typeName === 'Query') {
    if (name === 'viewer') {
      if (field.selections === null) return null;
      return resolveSelections(ctx, 'User', { login: ctx.viewerLogin }, field.selections, variables);
    }
    if (name === 'repository') {
      const owner = argValue(field, 'owner', variables);
      const repoName = argValue(field, 'name', variables);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = repoOf(ctx.store, owner, repoName);
      if (repo === undefined) return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, 'Repository', repo, field.selections, variables);
    }
    if (name === 'node') {
      const id = argValue(field, 'id', variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.store, decoded.repoId);
        if (repo === undefined) return null;
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'Repository', repo, field.selections, variables);
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoById(ctx.store, decoded.repoId);
        const issue = repo === undefined ? undefined : ctx.store.getIssue(repo, decoded.number);
        if (issue === undefined || repo === undefined) return null;
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'Issue', { repo, issue }, field.selections, variables);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, decoded.repoId);
        const pull = repo === undefined ? undefined : ctx.store.getPull(repo, decoded.number);
        if (pull === undefined || repo === undefined) return null;
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'PullRequest', { repo, pull }, field.selections, variables);
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = argValue(field, 'name', variables);
      if (typeof typeNameArg !== 'string') return null;
      const info = typeIntrospection(typeNameArg);
      if (info === null) return null;
      if (field.selections === null) return info;
      return resolveSelections(ctx, '__Type', info, field.selections, variables);
    }
    if (name === '__schema') {
      const info: Record<string, unknown> = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
      if (field.selections === null) return info;
      return resolveSelections(ctx, '__Schema', info, field.selections, variables);
    }
    return unknownField(ctx, typeName, field);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, field, variables);
  }

  if (typeName === 'User') {
    const user = source as { login: string };
    if (name === 'login') return user.login;
    if (name === 'id') return globalId('User', 0, ctx.store.getUser(user.login)?.id ?? 0);
    return unknownField(ctx, typeName, field);
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    switch (name) {
      case 'id':
        return globalId('Repository', repo.id, 0);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        if (field.selections === null) return { login: repo.owner };
        return resolveSelections(ctx, 'User', { login: repo.owner }, field.selections, variables);
      case 'defaultBranchRef':
        if (field.selections === null) return { name: repo.defaultBranch };
        return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch }, field.selections, variables);
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'createdAt':
        return isoFromSeq(repo.createdSeq);
      case 'updatedAt':
        return isoFromSeq(repo.createdSeq);
      case 'url':
        return '';
      case 'issue': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const issue = ctx.store.getIssue(repo, number);
        if (issue === undefined) return null;
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'Issue', { repo, issue }, field.selections, variables);
      }
      case 'issues': {
        if (field.selections === null) return null;
        return resolveIssueConnection(ctx, repo, field, variables);
      }
      case 'pullRequests': {
        if (field.selections === null) return null;
        return resolvePullConnection(ctx, repo, field, variables);
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const pull = ctx.store.getPull(repo, number);
        if (pull === undefined) return null;
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'PullRequest', { repo, pull }, field.selections, variables);
      }
      default:
        return unknownField(ctx, typeName, field);
    }
  }

  if (typeName === 'Issue') {
    const wrapped = source as { repo: Repo; issue: Issue };
    const issue = wrapped.issue;
    const repo = wrapped.repo;
    switch (name) {
      case 'id':
        return globalId('Issue', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issueStateOut(issue.state);
      case 'createdAt':
        return isoFromSeq(issue.createdSeq);
      case 'updatedAt':
        return isoFromSeq(issue.updatedSeq);
      case 'author':
        if (field.selections === null) return { login: issue.userLogin };
        return resolveSelections(ctx, 'User', { login: issue.userLogin }, field.selections, variables);
      case 'repository':
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'Repository', repo, field.selections, variables);
      case 'url':
        return '';
      case 'labels':
        return { nodes: issue.labels.map((label) => ({ name: label })) };
      case 'comments':
        return { nodes: issue.comments.map((comment) => ({ id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body })) };
      default:
        return unknownField(ctx, typeName, field);
    }
  }

  if (typeName === 'PullRequest') {
    const wrapped = source as { repo: Repo; pull: PullRequest };
    const pull = wrapped.pull;
    const repo = wrapped.repo;
    switch (name) {
      case 'id':
        return globalId('PullRequest', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullStateOut(pull);
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable': {
        const mergeable = ctx.rest.mergeableOf(repo, pull);
        return mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'merged':
        return pull.merged;
      case 'createdAt':
        return isoFromSeq(pull.createdSeq);
      case 'updatedAt':
        return isoFromSeq(pull.updatedSeq);
      case 'author':
        if (field.selections === null) return { login: pull.userLogin };
        return resolveSelections(ctx, 'User', { login: pull.userLogin }, field.selections, variables);
      case 'repository':
        if (field.selections === null) return null;
        return resolveSelections(ctx, 'Repository', repo, field.selections, variables);
      case 'url':
        return '';
      case 'files': {
        if (field.selections === null) return null;
        const first = argValue(field, 'first', variables);
        const files = ctx.rest.pullFiles(repo, pull);
        const limited = typeof first === 'number' && first >= 0 ? files.slice(0, first) : files;
        const nodes = limited.map((file) => ({ path: file['filename'] }));
        const out: Record<string, unknown> = {};
        for (const selection of field.selections) {
          if (selection.kind === 'fragment') continue;
          if (selection.field.name === 'nodes') {
            const nodeSelections = selection.field.selections;
            out['nodes'] = nodeSelections === null ? nodes : nodes.map((node) => resolveSelections(ctx, 'PullRequestFile', node, nodeSelections, variables));
          } else if (selection.field.name === 'totalCount') {
            out['totalCount'] = files.length;
          } else {
            ctx.errors.push({ message: `Cannot query field "${selection.field.name}" on type "PullRequestChangedFileConnection".` });
            out[selection.field.alias ?? selection.field.name] = null;
          }
        }
        return out;
      }
      default:
        return unknownField(ctx, typeName, field);
    }
  }

  if (typeName === 'Ref') {
    const ref = source as { name: string };
    if (name === 'name') return ref.name;
    if (name === 'prefix') return 'refs/heads/';
    return unknownField(ctx, typeName, field);
  }

  if (typeName === 'PullRequestFile') {
    const file = source as { path: string };
    if (name === 'path') return file.path;
    return unknownField(ctx, typeName, field);
  }

  if (typeName === 'IssueComment') {
    const comment = source as { id: string; body: string };
    if (name === 'id') return comment.id;
    if (name === 'body') return comment.body;
    return unknownField(ctx, typeName, field);
  }

  if (typeName === '__Type') {
    const info = source as Record<string, unknown>;
    if (name === 'name' || name === 'kind') return info[name] ?? null;
    if (name === 'fields') {
      const fields = info['fields'];
      if (!Array.isArray(fields)) return null;
      if (field.selections === null) return fields;
      return fields.map((entry) => resolveSelections(ctx, '__Field', entry as Record<string, unknown>, field.selections as SelectionNode[], variables));
    }
    if (name === 'enumValues') {
      const values = info['enumValues'];
      if (!Array.isArray(values)) return null;
      if (field.selections === null) return values;
      return values.map((entry) => resolveSelections(ctx, '__EnumValue', entry as Record<string, unknown>, field.selections as SelectionNode[], variables));
    }
    return unknownField(ctx, typeName, field);
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    const entry = source as Record<string, unknown>;
    if (name === 'name') return entry['name'] ?? null;
    if (name === 'description') return entry['description'] ?? '';
    if (name === 'isDeprecated') return entry['isDeprecated'] ?? false;
    if (name === 'deprecationReason') return entry['deprecationReason'] ?? null;
    if (name === 'args') return entry['args'] ?? [];
    if (name === 'type') return entry['type'] ?? null;
    return unknownField(ctx, typeName, field);
  }

  if (typeName === '__Schema') {
    const info = source as Record<string, unknown>;
    if (name === 'queryType' || name === 'mutationType') {
      const value = info[name];
      if (!isRecord(value)) return null;
      if (field.selections === null) return value;
      return resolveSelections(ctx, '__Type', value, field.selections, variables);
    }
    if (name === 'types') return [];
    return unknownField(ctx, typeName, field);
  }

  return unknownField(ctx, typeName, field);
}

function resolveIssueConnection(ctx: Executor, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = argValue(field, 'states', variables);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = argValue(field, 'orderBy', variables);
  let direction = 'DESC';
  if (isRecord(orderBy) && typeof orderBy['direction'] === 'string') direction = orderBy['direction'] as string;
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = argValue(field, 'first', variables);
  const after = argValue(field, 'after', variables);
  let start = 0;
  const afterNumber = decodeCursor(after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const limit = typeof first === 'number' && first >= 0 ? first : issues.length;
  const page = issues.slice(start, start + limit);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  const out: Record<string, unknown> = {};
  for (const selection of field.selections ?? []) {
    if (selection.kind === 'fragment') continue;
    const sub = selection.field;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') {
      if (sub.selections === null) out[key] = [];
      else out[key] = page.map((issue) => resolveSelections(ctx, 'Issue', { repo, issue }, sub.selections as SelectionNode[], variables));
    } else if (sub.name === 'pageInfo') {
      if (sub.selections === null) out[key] = { hasNextPage, endCursor };
      else {
        const info: Record<string, unknown> = {};
        for (const infoSel of sub.selections) {
          if (infoSel.kind === 'field') {
            if (infoSel.field.name === 'hasNextPage') info[infoSel.field.alias ?? 'hasNextPage'] = hasNextPage;
            else if (infoSel.field.name === 'endCursor') info[infoSel.field.alias ?? 'endCursor'] = endCursor;
            else if (infoSel.field.name === 'hasPreviousPage') info[infoSel.field.alias ?? 'hasPreviousPage'] = start > 0;
            else if (infoSel.field.name === 'startCursor') info[infoSel.field.alias ?? 'startCursor'] = page.length > 0 ? encodeCursor((page[0] as Issue).number) : null;
          }
        }
        out[key] = info;
      }
    } else if (sub.name === 'totalCount') {
      out[key] = issues.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "IssueConnection".` });
      out[key] = null;
    }
  }
  return out;
}

function resolvePullConnection(ctx: Executor, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = argValue(field, 'first', variables);
  const limit = typeof first === 'number' && first >= 0 ? first : pulls.length;
  const page = pulls.slice(0, limit);
  const out: Record<string, unknown> = {};
  for (const selection of field.selections ?? []) {
    if (selection.kind === 'fragment') continue;
    const sub = selection.field;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') {
      if (sub.selections === null) out[key] = [];
      else out[key] = page.map((pull) => resolveSelections(ctx, 'PullRequest', { repo, pull }, sub.selections as SelectionNode[], variables));
    } else if (sub.name === 'pageInfo') {
      out[key] = { hasNextPage: page.length < pulls.length, endCursor: null };
    } else if (sub.name === 'totalCount') {
      out[key] = pulls.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "PullRequestConnection".` });
      out[key] = null;
    }
  }
  return out;
}

function resolveMutation(ctx: Executor, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  const input = argValue(field, 'input', variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: `Field "${name}" argument "input" of type "${name}Input!" is required, but it was not provided.` });
    return null;
  }
  const selections = field.selections;
  if (name === 'createIssue') {
    const repositoryId = input['repositoryId'];
    const title = input['title'];
    if (typeof repositoryId !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createIssue requires repositoryId and title.' });
      return null;
    }
    const decoded = decodeGlobalId(repositoryId);
    const repo = decoded === null ? undefined : findRepoById(ctx.store, decoded.repoId);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: repository not found.' });
      return null;
    }
    const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
    const issue = ctx.store.createIssue(repo, title, body, [], ctx.viewerLogin);
    if (selections === null) return { issue: { number: issue.number, id: globalId('Issue', repo.id, issue.number) } };
    return resolveSelections(ctx, 'CreateIssuePayload', { repo, issue }, selections, variables);
  }
  if (name === 'closeIssue') {
    const issueId = input['issueId'];
    if (typeof issueId !== 'string') {
      ctx.errors.push({ message: 'closeIssue requires issueId.' });
      return null;
    }
    const decoded = decodeGlobalId(issueId);
    const repo = decoded === null ? undefined : findRepoById(ctx.store, decoded.repoId);
    const issue = repo === undefined || decoded === null ? undefined : ctx.store.getIssue(repo, decoded.number);
    if (issue === undefined || repo === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found.' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedSeq = ctx.store.nextSeq();
    if (selections === null) return { issue: { number: issue.number, id: globalId('Issue', repo.id, issue.number), state: 'CLOSED' } };
    return resolveSelections(ctx, 'CloseIssuePayload', { repo, issue }, selections, variables);
  }
  if (name === 'createPullRequest') {
    const repositoryId = input['repositoryId'];
    const baseRefName = input['baseRefName'];
    const headRefName = input['headRefName'];
    const title = input['title'];
    if (typeof repositoryId !== 'string' || typeof baseRefName !== 'string' || typeof headRefName !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createPullRequest requires repositoryId, baseRefName, headRefName and title.' });
      return null;
    }
    const decoded = decodeGlobalId(repositoryId);
    const repo = decoded === null ? undefined : findRepoById(ctx.store, decoded.repoId);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: repository not found.' });
      return null;
    }
    const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
    const opened = ctx.rest.openPull(repo, title, body, headRefName, baseRefName, ctx.viewerLogin);
    if ('error' in opened) {
      ctx.errors.push({ message: `createPullRequest: ${opened.error}` });
      return null;
    }
    const pull = opened.pull;
    if (selections === null) {
      return { pullRequest: { number: pull.number, id: globalId('PullRequest', repo.id, pull.number), state: 'OPEN', headRefName: pull.head, baseRefName: pull.base } };
    }
    return resolveSelections(ctx, 'CreatePullRequestPayload', { repo, pull }, selections, variables);
  }
  if (name === 'mergePullRequest') {
    const pullRequestId = input['pullRequestId'];
    if (typeof pullRequestId !== 'string') {
      ctx.errors.push({ message: 'mergePullRequest requires pullRequestId.' });
      return null;
    }
    const decoded = decodeGlobalId(pullRequestId);
    const repo = decoded === null ? undefined : findRepoById(ctx.store, decoded.repoId);
    if (repo === undefined || decoded === null) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
      return null;
    }
    const method = typeof input['mergeMethod'] === 'string' ? (input['mergeMethod'] as string) : 'SQUASH';
    const merged = ctx.rest.mergePull(repo, decoded.number, method);
    if ('error' in merged) {
      ctx.errors.push({ message: `mergePullRequest: ${merged.error}` });
      return null;
    }
    const pull = merged.pull;
    if (selections === null) return { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } };
    return resolveSelections(ctx, 'MergePullRequestPayload', { repo, pull }, selections, variables);
  }
  if (name === 'addComment') {
    const subjectId = input['subjectId'];
    const body = input['body'];
    if (typeof subjectId !== 'string' || typeof body !== 'string') {
      ctx.errors.push({ message: 'addComment requires subjectId and body.' });
      return null;
    }
    const decoded = decodeGlobalId(subjectId);
    const repo = decoded === null ? undefined : findRepoById(ctx.store, decoded.repoId);
    const issue = repo === undefined || decoded === null ? undefined : ctx.store.getIssue(repo, decoded.number);
    if (issue === undefined || repo === undefined) {
      ctx.errors.push({ message: 'addComment: subject not found.' });
      return null;
    }
    const comment = ctx.store.addComment(repo, issue, ctx.viewerLogin, body);
    const node = { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body };
    if (selections === null) return { commentEdge: { node } };
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      const sub = selection.field;
      const key = sub.alias ?? sub.name;
      if (sub.name === 'commentEdge') {
        if (sub.selections === null) out[key] = { node };
        else {
          const edge: Record<string, unknown> = {};
          for (const edgeSel of sub.selections) {
            if (edgeSel.kind === 'fragment') continue;
            if (edgeSel.field.name === 'node') {
              edge[edgeSel.field.alias ?? 'node'] = edgeSel.field.selections === null ? node : resolveSelections(ctx, 'IssueComment', node, edgeSel.field.selections, variables);
            }
          }
          out[key] = edge;
        }
      } else {
        ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "AddCommentPayload".` });
        out[key] = null;
      }
    }
    return out;
  }
  return unknownField(ctx, 'Mutation', field);
}

function resolvePayloadField(ctx: Executor, typeName: string, source: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  const wrapped = source as { repo: Repo; issue?: Issue; pull?: PullRequest };
  const name = field.name;
  if (name === 'issue' && wrapped.issue !== undefined) {
    if (field.selections === null) return { number: wrapped.issue.number, id: globalId('Issue', wrapped.repo.id, wrapped.issue.number) };
    return resolveSelections(ctx, 'Issue', { repo: wrapped.repo, issue: wrapped.issue }, field.selections, variables);
  }
  if (name === 'pullRequest' && wrapped.pull !== undefined) {
    if (field.selections === null) {
      return { number: wrapped.pull.number, id: globalId('PullRequest', wrapped.repo.id, wrapped.pull.number), state: pullStateOut(wrapped.pull) };
    }
    return resolveSelections(ctx, 'PullRequest', { repo: wrapped.repo, pull: wrapped.pull }, field.selections, variables);
  }
  if (name === 'clientMutationId') return null;
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

// ---------------------------------------------------------------- the API

export class GraphqlApi {
  readonly store: Store;
  readonly token: string;
  readonly rest: RestApi;

  constructor(store: Store, token: string, rest: RestApi) {
    this.store = store;
    this.token = token;
    this.rest = rest;
  }

  handleGraphql(method: string, _path: string, _query: Record<string, string>, headers: Record<string, string>, body: Buffer): ApiResult {
    try {
      if (method.toUpperCase() !== 'POST') return jsonResult(405, { message: 'Method Not Allowed' });
      if (!isAuthorized(headers, this.token)) return jsonResult(401, { message: 'Bad credentials' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        return jsonResult(400, { message: 'Invalid JSON body' });
      }
      if (Array.isArray(parsed)) {
        const out = parsed.map((entry) => this.executeOne(entry));
        return jsonResult(200, out);
      }
      return jsonResult(200, this.executeOne(parsed));
    } catch {
      return jsonResult(500, { message: 'Internal server error' });
    }
  }

  private executeOne(entry: unknown): Record<string, unknown> {
    if (!isRecord(entry) || typeof entry['query'] !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    const variables = isRecord(entry['variables']) ? (entry['variables'] as Record<string, unknown>) : {};
    const ctx: Executor = { store: this.store, rest: this.rest, viewerLogin: this.store.viewerLogin, errors: [] };
    let operation: OperationNode;
    try {
      operation = new Parser(entry['query'] as string).parse();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = resolveSelections(ctx, rootType, null, operation.selections, variables);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  }
}
