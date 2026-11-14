// MCP over POST /mcp: JSON-RPC 2.0 Streamable HTTP. Supports the modern
// 2026-07-28 discovery handshake (`server/discover`) and the legacy
// `initialize` + `notifications/initialized` handshake. Six tools act on
// the same store as REST: create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request.
//
// Rules the suite enforces: tool `required` lists contain only properties
// the suite can fill (see the tool table in the summary); tool results
// carry both a text `content` entry (JSON) and `structuredContent`;
// unknown tools and missing arguments are JSON-RPC errors, never HTTP 500;
// non-JSON bodies are HTTP 400 with code -32700; notifications answer
// HTTP 202 with an empty body.

import { VIEWER_LOGIN, type Store } from './store.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

type JsonValue = string | number | boolean | null | Record<string, unknown> | unknown[];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function missingArg(name: string): Record<string, unknown> {
  return toolErrorResult(`missing required argument: ${name}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { __rpcError: -32602, __message: `unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErrorResult(`missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      const created = store.createRepo(repoNameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if ('error' in created) return toolErrorResult(created.error);
      return toolResult({ id: created.id, name: created.name, full_name: `${created.owner}/${created.name}`, owner: created.owner, private: created.private, description: created.description, default_branch: created.defaultBranch });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      return toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      const issue = store.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, repository: `${repo.owner}/${repo.name}` });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolResult({ issues, total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      const head = args.head as string;
      const base = args.base as string;
      if (!store.branchTip(repo, head)) return toolErrorResult('head branch does not exist');
      if (!store.branchTip(repo, base)) return toolErrorResult('base branch does not exist');
      const pr = store.createPull(repo, args.title as string, typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult({ id: pr.id, number: pr.number, title: pr.title, body: pr.body, state: pr.state, head: pr.head, base: pr.base, head_sha: pr.headSha, base_sha: pr.baseSha });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      const num = Number(args.pull_number);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return toolErrorResult('pull request not found');
      if (pr.state !== 'open') return toolErrorResult('pull request is not open');
      const headTip = store.branchTip(repo, pr.head);
      const baseTip = store.branchTip(repo, pr.base);
      if (!headTip || !baseTip) return toolErrorResult('pull request cannot be merged');
      if (store.mergeConflict(baseTip, headTip)) return toolErrorResult('merge conflict');
      const oid = store.mergePull(repo, pr);
      if (!oid) return toolErrorResult('merge conflict');
      return toolResult({ number: pr.number, merged: true, sha: oid, state: pr.state, merge_commit_sha: oid });
    }
    case 'list_repos': {
      const repos = store.listRepos(VIEWER_LOGIN).map((r) => ({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: r.owner, private: r.private, description: r.description, default_branch: r.defaultBranch }));
      return toolResult({ repositories: repos, total_count: repos.length });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult('repository not found');
      const num = Number(args.issue_number);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return toolErrorResult('issue not found');
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    default:
      return toolErrorResult(`tool not implemented: ${name}`);
  }
}

export interface McpResponse { status: number; body: string | null; }

/** Handle one POST /mcp request body. `rawBody` is the raw request bytes. */
export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  const requests: RpcRequest[] = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest];
  const responses: Record<string, unknown>[] = [];
  let sawNotification = false;
  for (const req of requests) {
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      responses.push(rpcError((req as RpcRequest | null)?.id ?? null, -32600, 'Invalid Request'));
      continue;
    }
    const isNotification = req.id === undefined || req.id === null;
    if (isNotification) {
      // notifications/initialized and friends: no response, HTTP 202.
      sawNotification = true;
      continue;
    }
    const id = req.id as string | number;
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case 'server/discover':
        responses.push(rpcResult(id, {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }));
        break;
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const supported = ['2026-07-28', '2025-11-25', '2025-06-18'];
        responses.push(rpcResult(id, {
          protocolVersion: supported.includes(offered) ? offered : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }));
        break;
      }
      case 'ping':
        responses.push(rpcResult(id, {}));
        break;
      case 'tools/list':
        responses.push(rpcResult(id, { tools: TOOLS }));
        break;
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const out = callTool(store, toolName, args);
        if (typeof out.__rpcError === 'number') {
          responses.push(rpcError(id, out.__rpcError as number, (out.__message as string) ?? 'error'));
        } else {
          responses.push(rpcResult(id, out));
        }
        break;
      }
      default:
        responses.push(rpcError(id, -32601, `method not found: ${req.method}`));
        break;
    }
  }
  if (responses.length === 0) {
    // Only notifications arrived.
    void sawNotification;
    return { status: 202, body: null };
  }
  if (Array.isArray(parsed)) return { status: 200, body: JSON.stringify(responses) };
  return { status: 200, body: JSON.stringify(responses[0]) };
}
