// MCP: /mcp, JSON-RPC 2.0 Streamable HTTP. Both eras are served:
// server/discover (2026-07-28) and initialize + notifications/initialized
// (2025-11-25). Tools share the REST store, so ids are stable across reads.

import { isAuthenticated, messageError, parseJsonBody, sendJson, type Ctx } from './http.ts';
import { TRIAL_NOW_ISO, VIEWER } from './scenario.ts';
import {
  issueJson,
  pullJson,
  repoJson,
  findRepo,
} from './rest.ts';
import {
  mergeConflicts,
  squashMerge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['owner', 'name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
    },
    required: ['owner'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'string', description: 'Comma-separated label names the issue carries.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
];

function toolsList(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isRecord(value) ? value : { value },
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Map a call's arguments onto the tool's declared properties (synonyms included). */
function pickArgs(tool: ToolDef, args: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  const synonyms: Record<string, string[]> = {
    owner: ['owner_login', 'org', 'user_login'],
    repo: ['repository', 'repo_name'],
    name: ['repo_name'],
    title: ['name'],
    body: ['description', 'content'],
    head: ['head_ref', 'head_branch', 'source'],
    base: ['base_ref', 'base_branch', 'target'],
    pull_number: ['pr_number', 'number', 'pullNumber'],
    issue_number: ['number', 'issueNumber'],
  };
  for (const key of Object.keys(tool.properties)) {
    if (args[key] !== undefined) {
      out[key] = args[key];
      continue;
    }
    for (const alias of synonyms[key] ?? []) {
      if (args[alias] !== undefined) {
        out[key] = args[alias];
        break;
      }
    }
  }
  // A full_name "owner/repo" fills owner and repo when either is missing.
  const fullName = args.full_name;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (out.owner === undefined) out.owner = owner;
    if (out.repo === undefined) out.repo = repo;
  }
  return out;
}

function stringArg(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function numberArg(args: JsonRecord, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function resolveRepo(store: Store, args: JsonRecord): Repo | null {
  const owner = stringArg(args, 'owner');
  const repoName = stringArg(args, 'repo') ?? stringArg(args, 'name');
  if (owner === undefined || repoName === undefined) return null;
  return findRepo(store, owner, repoName);
}

function callTool(store: Store, name: string, rawArgs: unknown): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (tool === undefined) return rpcError(null, -32602, `Unknown tool: ${name}`);
  const args = pickArgs(tool, isRecord(rawArgs) ? rawArgs : {});
  const missing = tool.required.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return { jsonrpc: '2.0', id: null, result: toolError(`Missing required argument(s): ${missing.join(', ')}`) };
  }
  try {
    const result = runTool(store, tool.name, args);
    return { jsonrpc: '2.0', id: null, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id: null, result: toolError(message) };
  }
}

function runTool(store: Store, name: string, args: JsonRecord): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const owner = stringArg(args, 'owner') as string;
      const repoName = stringArg(args, 'name') as string;
      if (owner !== VIEWER.login) return toolError('Repository not found');
      if (store.getRepo(repoName) !== undefined) return toolError('Repository already exists');
      const description = stringArg(args, 'description') ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = store.createRepo(repoName, description, isPrivate);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'list_repos': {
      const owner = stringArg(args, 'owner');
      if (owner !== VIEWER.login) return toolError('Repository not found');
      const repos = [...store.repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
      return toolResult({ repositories: repos });
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = stringArg(args, 'title') as string;
      const body = stringArg(args, 'body') ?? '';
      const labelsRaw = stringArg(args, 'labels') ?? '';
      const labels: Label[] = [];
      for (const labelName of labelsRaw.split(',').map((part) => part.trim()).filter(Boolean)) {
        const label = repo.labels.get(labelName);
        if (label === undefined) return toolError(`Label "${labelName}" does not exist`);
        labels.push(label);
      }
      return createIssueMcp(store, repo, title, body, labels);
    }
    case 'get_issue': {
      const repo = resolveRepo(store, args);
      const number = numberArg(args, 'issue_number');
      if (repo === null || number === undefined) return toolError('Issue not found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return toolError('Issue not found');
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const list = issues.map((issue) => issueJson(repo, issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: { issues: list },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = stringArg(args, 'title') as string;
      const body = stringArg(args, 'body') ?? '';
      const head = stringArg(args, 'head') as string;
      const base = stringArg(args, 'base') as string;
      const headSha = store.resolveCommit(repo, head);
      const baseSha = store.resolveCommit(repo, base);
      if (headSha === undefined || baseSha === undefined) {
        return toolError('head or base branch does not exist');
      }
      const pull: Pull = {
        id: store.nextPullId,
        number: repo.nextPullNumber,
        title,
        body,
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
      };
      store.nextPullId += 1;
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      const list = pulls.map((pull) => pullJson(store, repo, pull));
      return {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: { pull_requests: list },
        isError: false,
      };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      const number = numberArg(args, 'pull_number');
      if (repo === null || number === undefined) return toolError('Pull request not found');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open') return toolError('Pull request is already closed');
      if (mergeConflicts(store, repo, pull)) return toolError('Merge conflict');
      const mergeSha = squashMerge(store, repo, pull);
      if (mergeSha === null) return toolError('Merge conflict');
      return toolResult({ sha: mergeSha, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` });
    }
    case 'create_comment': {
      const repo = resolveRepo(store, args);
      const number = numberArg(args, 'issue_number');
      const body = stringArg(args, 'body');
      if (repo === null || number === undefined || body === undefined) return toolError('Issue not found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return toolError('Issue not found');
      const comment = { id: store.nextCommentId, body, createdAt: TRIAL_NOW_ISO };
      store.nextCommentId += 1;
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return toolResult({ id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id }, created_at: comment.createdAt });
    }
    default:
      return toolError(`Tool not implemented: ${name}`);
  }
}

function createIssueMcp(store: Store, repo: Repo, title: string, body: string, labels: Label[]): Record<string, unknown> {
  const issue: Issue = {
    id: store.nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
    closedAt: null,
  };
  store.nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return toolResult(issueJson(repo, issue));
}

export async function handleMcp(store: Store, ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, messageError('Method Not Allowed'));
    return true;
  }
  if (!isAuthenticated(ctx)) {
    sendJson(ctx, 401, messageError('Requires authentication'));
    return true;
  }
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    sendJson(ctx, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  // Notifications (no id) are acknowledged with an empty 202.
  if (body.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return true;
    }
    sendJson(ctx, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  if (method === 'server/discover') {
    const info = serverInfo();
    sendJson(ctx, 200, rpcResult(id, {
      protocolVersion: MODERN_VERSION,
      supportedVersions: [MODERN_VERSION, LEGACY_VERSION],
      serverInfo: info,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    }));
    return true;
  }
  if (method === 'initialize') {
    const params = isRecord(body.params) ? body.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MODERN_VERSION;
    const negotiated = requested === LEGACY_VERSION ? LEGACY_VERSION : MODERN_VERSION;
    const info = serverInfo();
    sendJson(ctx, 200, rpcResult(id, {
      protocolVersion: negotiated,
      serverInfo: info,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    }));
    return true;
  }
  if (method === 'ping') {
    sendJson(ctx, 200, rpcResult(id, {}));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(ctx, 200, rpcResult(id, { tools: toolsList() }));
    return true;
  }
  if (method === 'tools/call') {
    const params = isRecord(body.params) ? body.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const result = callTool(store, name, params.arguments);
    // callTool builds its own envelope with id null; set the real id.
    const envelope = result.error !== undefined
      ? rpcError(id, (result.error as JsonRecord).code as number, (result.error as JsonRecord).message as string)
      : rpcResult(id, result.result);
    sendJson(ctx, 200, envelope);
    return true;
  }
  sendJson(ctx, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
