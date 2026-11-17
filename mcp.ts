// mcp.ts — the Model Context Protocol endpoint at POST /mcp (stage 2).
// JSON-RPC 2.0 Streamable HTTP. Speaks the modern revision 2026-07-28
// (server/discover, no handshake, no session) and also answers the
// legacy initialize handshake (2025-11-25 and earlier) for clients that
// predate discover. Pure Node standard library.
//
// Transport contract (stage 3 calls this; mirrors git-http.ts / rest.ts):
//   new McpApi(store, token, rest)
//   handleMcp(method, path, query, headers, body) -> { status, headers, body }
//   - path '/mcp'. body is the full request body as a Buffer.
//   - never throws: non-JSON body -> HTTP 400 with JSON-RPC -32700,
//     unknown tool -> -32602, missing args -> -32602, unknown method
//     -> -32601, no/invalid token -> HTTP 401. Notifications (no id)
//     are answered 202 with an empty body.
//   - tools/list is byte-identical across calls: the tool table is one
//     frozen literal, serialized fresh from the same object each time.
//   - every tool result carries both a text block (the JSON value, so
//     clients that only read text see titles and numbers) and
//     structuredContent (so clients that parse JSON get the object).

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { isAuthorized, nextRequestId } from './rest.ts';
import type { RestApi } from './rest.ts';

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const EMPTY = Buffer.alloc(0);
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue in a repository by its number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        issue_number: Object.freeze({ type: 'number', description: 'The issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_repos',
    description: 'List repositories owned by a user (the authenticated user by default).',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The user login whose repositories to list.' }),
      }),
      required: Object.freeze([]),
      additionalProperties: false,
    }),
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() };
}

function rpcResult(id: string | number | null, result: unknown): ApiResult {
  return { status: 200, headers: jsonHeaders(), body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8') };
}

function rpcError(status: number, id: string | number | null, code: number, message: string): ApiResult {
  return { status, headers: jsonHeaders(), body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8') };
}

function toolOk(id: string | number | null, value: unknown): ApiResult {
  return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
}

function toolFail(id: string | number | null, message: string): ApiResult {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.userLogin },
    comments: issue.comments.length,
  };
}

function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: pull.mergeable,
  };
}

export class McpApi {
  readonly store: Store;
  readonly token: string;
  readonly rest: RestApi;

  constructor(store: Store, token: string, rest: RestApi) {
    this.store = store;
    this.token = token;
    this.rest = rest;
  }

  handleMcp(method: string, _path: string, _query: Record<string, string>, headers: Record<string, string>, body: Buffer): ApiResult {
    try {
      const verb = method.toUpperCase();
      if (verb === 'DELETE') return { status: 204, headers: { 'x-github-request-id': nextRequestId() }, body: EMPTY };
      if (verb !== 'POST') return rpcError(405, null, -32600, 'Method Not Allowed');
      if (!isAuthorized(headers, this.token)) {
        return { status: 401, headers: jsonHeaders(), body: Buffer.from(JSON.stringify({ message: 'Bad credentials' }), 'utf8') };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        return rpcError(400, null, -32700, 'Parse error');
      }
      if (!isRecord(parsed) || typeof parsed['method'] !== 'string') {
        const id = isRecord(parsed) && (typeof parsed['id'] === 'string' || typeof parsed['id'] === 'number') ? (parsed['id'] as string | number) : null;
        return rpcError(400, id, -32600, 'Invalid Request');
      }
      const id = parsed['id'] === undefined ? null : (parsed['id'] as string | number | null);
      const rpcMethod = parsed['method'] as string;
      const params = isRecord(parsed['params']) ? (parsed['params'] as Record<string, unknown>) : {};
      // Notifications carry no id: acknowledge with 202 and no body.
      if (id === null && rpcMethod.startsWith('notifications/')) {
        return { status: 202, headers: { 'x-github-request-id': nextRequestId() }, body: EMPTY };
      }
      if (rpcMethod === 'server/discover') {
        return rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          instructions: 'GitHub-compatible forge MCP server.',
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        });
      }
      if (rpcMethod === 'initialize') {
        const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : SUPPORTED_VERSIONS[0] as string;
        return rpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      if (rpcMethod === 'ping') return rpcResult(id, {});
      if (rpcMethod === 'tools/list') {
        return rpcResult(id, { tools: TOOLS });
      }
      if (rpcMethod === 'tools/call') {
        return this.callTool(id, params);
      }
      if (rpcMethod.startsWith('notifications/')) {
        return rpcResult(id, {});
      }
      return rpcError(200, id, -32601, `Method not found: ${rpcMethod}`);
    } catch {
      return rpcError(500, null, -32603, 'Internal error');
    }
  }

  private callTool(id: string | number | null, params: Record<string, unknown>): ApiResult {
    const name = params['name'];
    const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    if (typeof name !== 'string' || name === '') return rpcError(200, id, -32602, 'Invalid params: tools/call needs a tool name');
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return rpcError(200, id, -32602, `Unknown tool: ${name}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcError(200, id, -32602, `Invalid params: missing required argument '${required}' for tool '${name}'`);
      }
    }
    switch (name) {
      case 'create_repo':
        return this.createRepo(id, args);
      case 'get_repo':
        return this.getRepo(id, args);
      case 'create_issue':
        return this.createIssue(id, args);
      case 'get_issue':
        return this.getIssue(id, args);
      case 'list_issues':
        return this.listIssues(id, args);
      case 'create_pull_request':
        return this.createPullRequest(id, args);
      case 'merge_pull_request':
        return this.mergePullRequest(id, args);
      case 'list_repos':
        return this.listRepos(id, args);
      default:
        return rpcError(200, id, -32602, `Unknown tool: ${name}`);
    }
  }

  private repoArg(args: Record<string, unknown>): Repo | null {
    const owner = args['owner'];
    const repo = args['repo'];
    if (typeof owner !== 'string' || typeof repo !== 'string') return null;
    return this.store.getRepo(owner, repo) ?? null;
  }

  private createRepo(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const name = args['name'] as string;
    const owner = this.store.viewerLogin;
    if (this.store.getRepo(owner, name) !== undefined) return toolFail(id, `Repository ${owner}/${name} already exists`);
    const description = typeof args['description'] === 'string' ? (args['description'] as string) : '';
    const isPrivate = args['private'] === true;
    const repo = this.store.createRepo(owner, name, description, isPrivate);
    return toolOk(id, repoView(repo));
  }

  private getRepo(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    return toolOk(id, repoView(repo));
  }

  private createIssue(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    const title = args['title'] as string;
    const body = typeof args['body'] === 'string' ? (args['body'] as string) : '';
    const issue = this.store.createIssue(repo, title, body, [], this.store.viewerLogin);
    return toolOk(id, issueView(repo, issue));
  }

  private getIssue(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    const number = args['issue_number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) return rpcError(200, id, -32602, 'Invalid params: issue_number must be an integer');
    const issue = this.store.getIssue(repo, number);
    if (issue === undefined) return toolFail(id, `Issue #${number} not found in ${repo.fullName}`);
    return toolOk(id, issueView(repo, issue));
  }

  private listIssues(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    const state = typeof args['state'] === 'string' ? (args['state'] as string).toLowerCase() : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.createdSeq - a.createdSeq);
    return toolOk(id, issues.map((issue) => issueView(repo, issue)));
  }

  private createPullRequest(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    const title = args['title'] as string;
    const body = typeof args['body'] === 'string' ? (args['body'] as string) : '';
    const head = args['head'] as string;
    const base = args['base'] as string;
    const opened = this.rest.openPull(repo, title, body, head, base, this.store.viewerLogin);
    if ('error' in opened) return toolFail(id, opened.error);
    return toolOk(id, pullView(repo, opened.pull));
  }

  private mergePullRequest(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const repo = this.repoArg(args);
    if (repo === null) return toolFail(id, `Repository ${String(args['owner'])}/${String(args['repo'])} not found`);
    const number = args['pull_number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) return rpcError(200, id, -32602, 'Invalid params: pull_number must be an integer');
    const merged = this.rest.mergePull(repo, number, 'squash');
    if ('error' in merged) return toolFail(id, merged.error);
    return toolOk(id, { number: merged.pull.number, merged: true, state: merged.pull.state, sha: merged.sha });
  }

  private listRepos(id: string | number | null, args: Record<string, unknown>): ApiResult {
    const owner = typeof args['owner'] === 'string' && args['owner'] !== '' ? (args['owner'] as string) : this.store.viewerLogin;
    const repos = this.store.reposOf(owner).sort((a, b) => b.createdSeq - a.createdSeq);
    return toolOk(id, repos.map((repo) => repoView(repo)));
  }
}
