// REST v3: /api/v3. JSON always, X-GitHub-Request-Id on every reply, Bearer
// auth on every route, a repo under another owner is 404 (never 403).

import { parseCommit, parseTree } from './gitpack.ts';
import { isAuthenticated, messageError, parseJsonBody, sendJson, sendNoBody, type Ctx } from './http.ts';
import { TRIAL_NOW_ISO, VIEWER } from './scenario.ts';
import {
  VIEWER_IDENTITY,
  buildTreeFromFlat,
  createCommit,
  mergeConflicts,
  pullFiles,
  squashMerge,
  treeAtCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    language: null,
    homepage: null,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER.id } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER.id } },
    merged: pull.merged,
    mergeable: pull.state === 'open' && !mergeConflicts(store, repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    draft: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Look up a repo by owner+name: 404 unless the owner is the token's login. */
export function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(name) ?? null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

export async function handleRest(store: Store, ctx: Ctx): Promise<boolean> {
  if (!ctx.path.startsWith('/api/v3')) return false;
  if (!isAuthenticated(ctx)) {
    sendJson(ctx, 401, messageError('Requires authentication'));
    return true;
  }
  const seg = ctx.segments; // ['', 'api', 'v3', ...]
  const rest = seg.slice(3).filter((segment) => segment !== '');
  const method = ctx.method;

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return notFound(ctx);
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'x-oauth-scopes': 'repo, read:user' });
    return true;
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return notFound(ctx);
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return notFound(ctx);
    sendJson(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `https://example.invalid/${VIEWER.login}`,
    });
    return true;
  }
  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') return createUserRepo(store, ctx);
    if (method === 'GET') return listUserRepos(store, ctx);
    return notFound(ctx);
  }
  // /api/v3/repos/{owner}/{name}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    return handleRepoRoute(store, ctx, owner, name, rest.slice(3));
  }
  return notFound(ctx);
}

function notFound(ctx: Ctx): boolean {
  sendJson(ctx, 404, messageError('Not Found'));
  return true;
}

async function createUserRepo(store: Store, ctx: Ctx): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const name = stringField(body, 'name');
  if (name === undefined || name === '') {
    sendJson(ctx, 422, messageError('name is required'));
    return true;
  }
  if (store.getRepo(name) !== undefined) {
    sendJson(ctx, 422, messageError('Repository already exists'));
    return true;
  }
  const repo = store.createRepo(name, stringField(body, 'description') ?? '', boolField(body, 'private', false));
  sendJson(ctx, 201, repoJson(repo));
  return true;
}

async function listUserRepos(store: Store, ctx: Ctx): Promise<boolean> {
  const params = ctx.url.searchParams;
  const perPage = Math.max(1, Math.min(100, Number(params.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const base = `${ctx.url.origin}/api/v3/user/repos`;
    const next = `${base}?per_page=${perPage}&page=${page + 1}`;
    const last = `${base}?per_page=${perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(ctx, 200, items.map(repoJson), headers);
  return true;
}

async function handleRepoRoute(store: Store, ctx: Ctx, owner: string, name: string, tail: string[]): Promise<boolean> {
  const method = ctx.method;
  const repo = findRepo(store, owner, name);
  // Repo-level GET/PATCH/DELETE.
  if (tail.length === 0) {
    if (repo === null) return notFound(ctx);
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') return patchRepo(store, ctx, repo);
    if (method === 'DELETE') {
      store.deleteRepo(name);
      sendNoBody(ctx, 204);
      return true;
    }
    return notFound(ctx);
  }
  if (repo === null) return notFound(ctx);
  const head = tail[0] as string;
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) return createRef(store, ctx, repo);
    if (method === 'GET' && tail.length >= 3) return getRef(store, ctx, repo, tail.slice(2));
    return notFound(ctx);
  }
  if (head === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string },
        protected: false,
      }));
    sendJson(ctx, 200, branches);
    return true;
  }
  if (head === 'commits' && tail.length === 1 && method === 'GET') return listCommits(store, ctx, repo);
  if (head === 'contents') return handleContents(store, ctx, repo, tail.slice(1));
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 1) return createLabel(store, ctx, repo);
    return notFound(ctx);
  }
  if (head === 'issues') return handleIssues(store, ctx, repo, tail.slice(1));
  if (head === 'pulls') return handlePulls(store, ctx, repo, tail.slice(1));
  return notFound(ctx);
}

async function patchRepo(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  const isPrivate = body.private;
  if (typeof isPrivate === 'boolean') repo.private = isPrivate;
  repo.updatedAt = TRIAL_NOW_ISO;
  sendJson(ctx, 200, repoJson(repo));
  return true;
}

async function createRef(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  const ref = body === null ? undefined : stringField(body, 'ref');
  const sha = body === null ? undefined : stringField(body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    sendJson(ctx, 422, messageError('ref and sha are required'));
    return true;
  }
  if (repo.refs.has(ref)) {
    sendJson(ctx, 422, messageError('Reference already exists'));
    return true;
  }
  if (repo.objects.get(sha) === undefined) {
    sendJson(ctx, 422, messageError('Object does not exist'));
    return true;
  }
  store.setRef(repo, ref, sha);
  sendJson(ctx, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  return true;
}

async function getRef(store: Store, ctx: Ctx, repo: Repo, tail: string[]): Promise<boolean> {
  const ref = `refs/${tail.join('/')}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound(ctx);
  sendJson(ctx, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  return true;
}

async function listCommits(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const shaParam = ctx.url.searchParams.get('sha');
  const tip = shaParam === null ? store.resolveCommit(repo, repo.defaultBranch) : store.resolveCommit(repo, shaParam);
  const commits: Record<string, unknown>[] = [];
  if (tip !== undefined) {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parts = parseCommit(object.data);
      commits.push({
        sha: oid,
        commit: {
          message: parts.message,
          author: { name: VIEWER_IDENTITY.name, email: VIEWER_IDENTITY.email, date: TRIAL_NOW_ISO },
          committer: { name: VIEWER_IDENTITY.name, email: VIEWER_IDENTITY.email, date: TRIAL_NOW_ISO },
        },
        author: { login: VIEWER.login, id: VIEWER.id },
        committer: { login: VIEWER.login, id: VIEWER.id },
      });
      for (const parent of parts.parents) queue.push(parent);
    }
  }
  sendJson(ctx, 200, commits);
  return true;
}

async function handleContents(store: Store, ctx: Ctx, repo: Repo, tail: string[]): Promise<boolean> {
  const method = ctx.method;
  if (tail.length === 0) return notFound(ctx);
  const path = tail.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
  if (method === 'GET') return getContents(store, ctx, repo, path);
  if (method === 'PUT') return putContents(store, ctx, repo, path);
  if (method === 'DELETE') return deleteContents(store, ctx, repo, path);
  return notFound(ctx);
}

function contentsAtRef(store: Store, repo: Repo, ref: string | null): { tip: string | undefined; flat: Map<string, { mode: string; oid: string; type: 'blob' }> } {
  const tip = ref === null ? store.resolveCommit(repo, repo.defaultBranch) : store.resolveCommit(repo, ref);
  return { tip, flat: treeAtCommit(store, repo, tip) };
}

async function getContents(store: Store, ctx: Ctx, repo: Repo, path: string): Promise<boolean> {
  const ref = ctx.url.searchParams.get('ref');
  const { flat } = contentsAtRef(store, repo, ref);
  const entry = flat.get(path);
  if (entry !== undefined) {
    const object = repo.objects.get(entry.oid);
    if (object === undefined) return notFound(ctx);
    const name = path.split('/').pop() as string;
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name,
      path,
      content: object.data.toString('base64'),
      sha: entry.oid,
    });
    return true;
  }
  // Directory listing: immediate children of `path`.
  const prefix = `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
  for (const [filePath, file] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0] as string;
    const childPath = `${path}/${first}`;
    if (rest.includes('/')) {
      if (!children.has(first)) children.set(first, { type: 'dir', name: first, path: childPath, sha: '' });
    } else {
      const object = repo.objects.get(file.oid);
      children.set(first, { type: 'file', name: first, path: childPath, sha: file.oid, size: object?.data.length ?? 0 });
    }
  }
  if (children.size === 0) return notFound(ctx);
  // Directory entries need a sha; use the tree oid of that directory.
  const dirEntries = [...children.values()].map((child) => {
    if (child.type === 'dir') {
      const { tip } = contentsAtRef(store, repo, ref);
      const treeOid = tip === undefined ? '' : dirTreeOid(store, repo, tip, child.path);
      return { ...child, sha: treeOid };
    }
    return child;
  });
  sendJson(ctx, 200, dirEntries);
  return true;
}

function dirTreeOid(store: Store, repo: Repo, commitOid: string, dirPath: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  let treeOid = parseCommit(object.data).tree;
  for (const segment of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return '';
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

async function putContents(store: Store, ctx: Ctx, repo: Repo, path: string): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const message = stringField(body, 'message') ?? 'Update file';
  const contentB64 = stringField(body, 'content');
  if (contentB64 === undefined) {
    sendJson(ctx, 422, messageError('content is required'));
    return true;
  }
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const sha = stringField(body, 'sha');
  const tip = store.resolveCommit(repo, branch);
  if (branch !== repo.defaultBranch && tip === undefined && repo.refs.has(store.branchRef(branch)) === false) {
    return notFound(ctx);
  }
  const flat = treeAtCommit(store, repo, tip);
  const existing = flat.get(path);
  if (existing !== undefined) {
    if (sha === undefined) {
      sendJson(ctx, 422, messageError('sha is required to update a file'));
      return true;
    }
    if (sha !== existing.oid) {
      sendJson(ctx, 409, messageError('sha does not match the current blob'));
      return true;
    }
  } else if (sha !== undefined) {
    return notFound(ctx);
  }
  const blob = Buffer.from(contentB64, 'base64');
  const blobOid = store.putObject(repo, 'blob', blob);
  flat.set(path, { mode: '100644', oid: blobOid, type: 'blob' });
  const tree = buildTreeFromFlat(store, repo, flat);
  const commitSha = createCommit(store, repo, {
    tree,
    parents: tip === undefined ? [] : [tip],
    message,
  });
  store.setRef(repo, store.branchRef(branch), commitSha);
  repo.updatedAt = TRIAL_NOW_ISO;
  sendJson(ctx, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: blob.length,
      name: path.split('/').pop() as string,
      path,
      content: contentB64,
      sha: blobOid,
    },
    commit: { sha: commitSha, message },
  });
  return true;
}

async function deleteContents(store: Store, ctx: Ctx, repo: Repo, path: string): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const message = stringField(body, 'message') ?? 'Delete file';
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const sha = stringField(body, 'sha');
  const tip = store.resolveCommit(repo, branch);
  const flat = treeAtCommit(store, repo, tip);
  const existing = flat.get(path);
  if (existing === undefined) return notFound(ctx);
  if (sha !== undefined && sha !== existing.oid) {
    sendJson(ctx, 409, messageError('sha does not match the current blob'));
    return true;
  }
  flat.delete(path);
  const tree = buildTreeFromFlat(store, repo, flat);
  const commitSha = createCommit(store, repo, {
    tree,
    parents: tip === undefined ? [] : [tip],
    message,
  });
  store.setRef(repo, store.branchRef(branch), commitSha);
  repo.updatedAt = TRIAL_NOW_ISO;
  sendJson(ctx, 200, { commit: { sha: commitSha, message } });
  return true;
}

async function createLabel(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  const name = body === null ? undefined : stringField(body, 'name');
  if (name === undefined || name === '') {
    sendJson(ctx, 422, messageError('name is required'));
    return true;
  }
  if (repo.labels.has(name)) {
    sendJson(ctx, 422, messageError('Label already exists'));
    return true;
  }
  const label: Label = { id: store.nextLabelId, name, color: stringField(body, 'color') ?? 'ededed' };
  store.nextLabelId += 1;
  repo.labels.set(name, label);
  sendJson(ctx, 201, labelJson(label));
  return true;
}

async function handleIssues(store: Store, ctx: Ctx, repo: Repo, tail: string[]): Promise<boolean> {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') return createIssue(store, ctx, repo);
    if (method === 'GET') return listIssues(store, ctx, repo);
    return notFound(ctx);
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound(ctx);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) return notFound(ctx);
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') return patchIssue(store, ctx, repo, issue);
    return notFound(ctx);
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') return createComment(store, ctx, repo, issue);
    if (method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: repo.owner, id: VIEWER.id },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      }));
      sendJson(ctx, 200, comments);
      return true;
    }
    return notFound(ctx);
  }
  return notFound(ctx);
}

async function createIssue(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const title = stringField(body, 'title');
  if (title === undefined || title === '') {
    sendJson(ctx, 422, messageError('title is required'));
    return true;
  }
  const labelNames = Array.isArray(body.labels) ? body.labels : [];
  const labels: Label[] = [];
  for (const raw of labelNames) {
    const name = typeof raw === 'string' ? raw : (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).name : undefined);
    if (typeof name !== 'string') continue;
    const label = repo.labels.get(name);
    if (label === undefined) {
      sendJson(ctx, 422, messageError(`Label "${name}" does not exist`));
      return true;
    }
    labels.push(label);
  }
  const issue: Issue = {
    id: store.nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body: stringField(body, 'body') ?? '',
    state: 'open',
    labels,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
    closedAt: null,
  };
  store.nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  sendJson(ctx, 201, issueJson(repo, issue));
  return true;
}

async function listIssues(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const params = ctx.url.searchParams;
  const state = params.get('state') ?? 'open';
  const sort = params.get('sort') ?? 'created';
  const direction = params.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  sendJson(ctx, 200, issues.map((issue) => issueJson(repo, issue)));
  return true;
}

async function patchIssue(store: Store, ctx: Ctx, repo: Repo, issue: Issue): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? TRIAL_NOW_ISO : null;
    issue.updatedAt = TRIAL_NOW_ISO;
  }
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  sendJson(ctx, 200, issueJson(repo, issue));
  return true;
}

async function createComment(store: Store, ctx: Ctx, repo: Repo, issue: Issue): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  const text = body === null ? undefined : stringField(body, 'body');
  if (text === undefined || text === '') {
    sendJson(ctx, 422, messageError('body is required'));
    return true;
  }
  const comment = { id: store.nextCommentId, body: text, createdAt: TRIAL_NOW_ISO };
  store.nextCommentId += 1;
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  sendJson(ctx, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  });
  return true;
}

async function handlePulls(store: Store, ctx: Ctx, repo: Repo, tail: string[]): Promise<boolean> {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'POST') return createPull(store, ctx, repo);
    if (method === 'GET') return listPulls(store, ctx, repo);
    return notFound(ctx);
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound(ctx);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return notFound(ctx);
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, pullJson(store, repo, pull));
      return true;
    }
    return notFound(ctx);
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(store, repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
    }));
    sendJson(ctx, 200, files);
    return true;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') return mergePullEndpoint(store, ctx, repo, pull);
  return notFound(ctx);
}

async function createPull(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendJson(ctx, 400, messageError(parsed.error));
    return true;
  }
  const body = jsonObject(parsed.value);
  if (body === null) {
    sendJson(ctx, 400, messageError('Request body must be a JSON object'));
    return true;
  }
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  const title = stringField(body, 'title');
  if (head === undefined || base === undefined || title === undefined) {
    sendJson(ctx, 422, messageError('head, base and title are required'));
    return true;
  }
  const headSha = store.resolveCommit(repo, head);
  const baseSha = store.resolveCommit(repo, base);
  if (headSha === undefined || baseSha === undefined) {
    sendJson(ctx, 422, messageError('head or base branch does not exist'));
    return true;
  }
  const pull: Pull = {
    id: store.nextPullId,
    number: repo.nextPullNumber,
    title,
    body: stringField(body, 'body') ?? '',
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
  sendJson(ctx, 201, pullJson(store, repo, pull));
  return true;
}

async function listPulls(store: Store, ctx: Ctx, repo: Repo): Promise<boolean> {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  sendJson(ctx, 200, pulls.map((pull) => pullJson(store, repo, pull)));
  return true;
}

async function mergePullEndpoint(store: Store, ctx: Ctx, repo: Repo, pull: Pull): Promise<boolean> {
  if (pull.state !== 'open') {
    sendJson(ctx, 405, messageError('Pull request is already closed'));
    return true;
  }
  if (mergeConflicts(store, repo, pull)) {
    sendJson(ctx, 405, messageError('Merge conflict'));
    return true;
  }
  const mergeSha = squashMerge(store, repo, pull);
  if (mergeSha === null) {
    sendJson(ctx, 405, messageError('Merge conflict'));
    return true;
  }
  sendJson(ctx, 200, {
    sha: mergeSha,
    merged: true,
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
  });
  return true;
}
