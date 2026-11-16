// The in-memory forge: one store shared by REST, GraphQL, MCP and git smart
// HTTP. Repositories, refs, objects, issues, pull requests and labels all live
// here, so a repo created over REST is visible to a git clone and a PR opened
// over GraphQL is readable over REST.

import {
  buildCommit,
  buildTree,
  buildTag,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type Identity,
  type ObjectType,
  type TreeEntry,
} from './gitpack.ts';
import { TRIAL_NOW_ISO, TRIAL_NOW_SEC, VIEWER } from './scenario.ts';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** ref name -> commit oid (or tag oid for refs/tags/*). */
  readonly refs: Map<string, string>;
  /** oid -> object. */
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly comments: Map<number, Comment[]>;
  nextIssueNumber: number;
  nextPullNumber: number;
  /** Paths changed by each pull, for the files endpoint (number -> entries). */
  readonly pullFiles: Map<number, { path: string; status: 'added' | 'modified'; additions: number; deletions: number }[]>;
}

export const VIEWER_IDENTITY: Identity = { name: VIEWER.name, email: VIEWER.email };

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextLabelId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      pullFiles: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // ---------------------------------------------------------------- objects and refs

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return repo.refs.get(this.branchRef(repo.defaultBranch));
    }
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = repo.refs.get(this.branchRef(ref));
    if (branch !== undefined) return branch;
    return repo.refs.get(`refs/tags/${ref}`);
  }

  /** The commit a ref points at, peeling annotated tags. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    const oid = this.resolveRef(repo, ref);
    if (oid === undefined) return undefined;
    const object = repo.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      return tag.object;
    }
    if (object.type === 'commit') return oid;
    return undefined;
  }
}

/** A flattened tree: full path -> {mode, oid, type}. */
export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
  readonly type: ObjectType;
}

export function flattenTree(store: Store, repo: Repo, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [subPath, sub] of flattenTree(store, repo, entry.oid, path)) out.set(subPath, sub);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid, type: 'blob' });
    }
  }
  return out;
}

/** Rebuild nested trees from a flattened map; returns the root tree oid. */
export function buildTreeFromFlat(store: Store, repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  // Group paths by their first segment, recursively.
  const build = (paths: readonly string[], depth: number): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    for (const path of paths) {
      const segments = path.split('/');
      if (segments.length === depth + 1) {
        const entry = flat.get(path) as FlatEntry;
        entries.push({ mode: entry.mode, name: segments[depth] as string, oid: entry.oid });
      } else {
        const dir = segments[depth] as string;
        const list = dirs.get(dir) ?? [];
        list.push(path);
        dirs.set(dir, list);
      }
    }
    for (const [dir, subPaths] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(subPaths, depth + 1) });
    }
    return store.putObject(repo, 'tree', buildTree(entries));
  };
  return build([...flat.keys()], 0);
}

/** The flattened tree at a commit (empty when the repo is unborn). */
export function treeAtCommit(store: Store, repo: Repo, commitOid: string | undefined): Map<string, FlatEntry> {
  if (commitOid === undefined) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(store, repo, parseCommit(object.data).tree);
}

export function createCommit(
  store: Store,
  repo: Repo,
  options: { tree: string; parents: readonly string[]; message: string; epochSec?: number },
): string {
  const data = buildCommit({
    tree: options.tree,
    parents: options.parents,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    epochSec: options.epochSec ?? TRIAL_NOW_SEC,
    message: options.message,
  });
  return store.putObject(repo, 'commit', data);
}

/** All ancestors of `oid` (inclusive), following parents. */
export function ancestors(store: Store, repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: Store, repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  return ancestors(store, repo, oid).has(ancestor);
}

/** First common ancestor of a and b, or undefined. */
export function mergeBase(store: Store, repo: Repo, a: string, b: string): string | undefined {
  const aAncestors = ancestors(store, repo, a);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (aAncestors.has(current)) return current;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return undefined;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid?: string;
  readonly newOid?: string;
}

/** Files that differ between two flattened trees. */
export function diffFlat(
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) changes.push({ path, status: 'added', newOid: h.oid });
    else if (b !== undefined && h === undefined) changes.push({ path, status: 'removed', oldOid: b.oid });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return changes;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blob versions (multiset difference). */
export function lineDiff(
  store: Store,
  repo: Repo,
  oldOid: string | undefined,
  newOid: string | undefined,
): { additions: number; deletions: number } {
  const oldLines = oldOid === undefined ? [] : countLines((repo.objects.get(oldOid)?.data ?? Buffer.alloc(0)) as Buffer);
  const newLines = newOid === undefined ? [] : countLines((repo.objects.get(newOid)?.data ?? Buffer.alloc(0)) as Buffer);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

/** Would a squash merge of `pull` onto its base tip conflict? (3-way check.) */
export function mergeConflicts(store: Store, repo: Repo, pull: Pull): boolean {
  const headCommit = pull.headSha;
  const baseTip = store.resolveCommit(repo, pull.baseRef);
  if (baseTip === undefined) return true;
  const base = mergeBase(store, repo, headCommit, baseTip);
  if (base === undefined) return true;
  const baseFlat = treeAtCommit(store, repo, base);
  const headFlat = treeAtCommit(store, repo, headCommit);
  const tipFlat = treeAtCommit(store, repo, baseTip);
  for (const change of diffFlat(baseFlat, headFlat)) {
    if (change.status === 'removed') continue;
    const tipEntry = tipFlat.get(change.path);
    const baseEntry = baseFlat.get(change.path);
    const tipOid = tipEntry?.oid;
    const baseOid = baseEntry?.oid;
    if (tipOid !== baseOid && tipOid !== change.newOid) return true;
  }
  return false;
}

/** Squash-merge a pull onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (mergeConflicts(store, repo, pull)) return null;
  const baseTip = store.resolveCommit(repo, pull.baseRef);
  if (baseTip === undefined) return null;
  const headFlat = treeAtCommit(store, repo, pull.headSha);
  const tree = buildTreeFromFlat(store, repo, headFlat);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = createCommit(store, repo, { tree, parents: [baseTip], message });
  store.setRef(repo, store.branchRef(pull.baseRef), mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.baseSha = mergeSha;
  pull.updatedAt = TRIAL_NOW_ISO;
  repo.updatedAt = TRIAL_NOW_ISO;
  return mergeSha;
}

/** The file list a pull request changes (merge-base -> head), with line counts. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): {
  path: string;
  status: 'added' | 'modified';
  additions: number;
  deletions: number;
}[] {
  const cached = repo.pullFiles.get(pull.number);
  if (cached !== undefined) return cached;
  const baseTip = store.resolveCommit(repo, pull.baseRef);
  const base = baseTip === undefined ? undefined : mergeBase(store, repo, pull.headSha, baseTip);
  const baseFlat = base === undefined ? new Map<string, FlatEntry>() : treeAtCommit(store, repo, base);
  const headFlat = treeAtCommit(store, repo, pull.headSha);
  const files: { path: string; status: 'added' | 'modified'; additions: number; deletions: number }[] = [];
  for (const change of diffFlat(baseFlat, headFlat)) {
    if (change.status === 'removed') continue;
    const { additions, deletions } = lineDiff(store, repo, change.oldOid, change.newOid);
    files.push({
      path: change.path,
      status: change.status === 'added' ? 'added' : 'modified',
      additions: Math.max(additions, change.status === 'added' ? 1 : 0),
      deletions,
    });
  }
  repo.pullFiles.set(pull.number, files);
  return files;
}

// ---------------------------------------------------------------- opaque global ids

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

export function repoGlobalId(repo: Repo): string {
  return b64encode(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64encode(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64encode(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, comment: Comment): string {
  return b64encode(`IssueComment:${repo.owner}/${repo.name}:${issueNumber}:${comment.id}`);
}

/** Decode an opaque global id into {kind, owner, name, number?, commentId?}. */
export function parseGlobalId(id: string): {
  kind: string;
  owner: string;
  name: string;
  number?: number;
  commentId?: number;
} | null {
  try {
    const text = b64decode(id);
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const ownerName = parts[1] as string;
    const slash = ownerName.indexOf('/');
    if (slash < 0) return null;
    const owner = ownerName.slice(0, slash);
    const name = ownerName.slice(slash + 1);
    const out: { kind: string; owner: string; name: string; number?: number; commentId?: number } = { kind, owner, name };
    if (parts.length >= 3 && parts[2] !== '') {
      const number = Number(parts[2]);
      if (Number.isInteger(number)) out.number = number;
    }
    if (parts.length >= 4) {
      const commentId = Number(parts[3]);
      if (Number.isInteger(commentId)) out.commentId = commentId;
    }
    return out;
  } catch {
    return null;
  }
}

export { buildTag };
