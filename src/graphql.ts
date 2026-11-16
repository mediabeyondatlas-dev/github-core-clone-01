// GraphQL: /api/graphql. A small parser (operations, variables, aliases,
// inline fragments, input objects, enums) and an executor over the shared
// store. Unknown fields answer HTTP 200 with an errors array; unknown
// repositories answer data.repository null with no errors.

import { isAuthenticated, messageError, parseJsonBody, sendJson, type Ctx } from './http.ts';
import { TRIAL_NOW_ISO, VIEWER } from './scenario.ts';
import {
  b64decode,
  b64encode,
  commentGlobalId,
  issueGlobalId,
  mergeConflicts,
  parseGlobalId,
  pullFiles,
  pullGlobalId,
  repoGlobalId,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  readonly alias?: string;
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
  readonly selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name?: string;
  readonly variables: { name: string; defaultValue?: ValueNode }[];
  readonly selection: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, SelectionNode[]>;
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'string'; value: string }
  | { type: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  readonly tokens: Token[];
  pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
  }

  acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.type === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error('Expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peek();
        if (next?.type === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, selection);
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) variables.push({ name, defaultValue: this.parseValue() });
      else variables.push({ name });
    }
    return variables;
  }

  parseType(): void {
    const token = this.peek();
    if (token?.type === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek() as Token;
      if (token.type === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next?.type === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next?.type === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'inlineFragment', selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.type === 'punct' && (this.peek() as Token).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.type === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// --------------------------------------------------------------------------- execution

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      return variables[node.name];
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// The schema the __type probes describe (field names only; types are nominal).
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  IssueComment: 'OBJECT',
  User: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  OrderDirection: 'ENUM',
  OrderField: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  OrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

interface ExecContext {
  readonly store: Store;
  readonly variables: Variables;
  readonly fragments: Map<string, SelectionNode[]>;
  readonly errors: { message: string }[];
}

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function fieldError(ctx: ExecContext, typeName: string, fieldName: string): void {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
}

/** Execute a selection set against an object value of a named type. */
function executeSelection(
  ctx: ExecContext,
  typeName: string,
  value: Record<string, unknown> | null,
  selections: readonly SelectionNode[],
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName) continue;
      const nested = executeSelection(ctx, typeName, value, selection.selection);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        const nested = executeSelection(ctx, typeName, value, fragment);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    const field = selection.field;
    const responseName = field.alias ?? field.name;
    const resolved = resolveField(ctx, typeName, value, field);
    out[responseName] = resolved;
  }
  return out;
}

function resolveField(
  ctx: ExecContext,
  typeName: string,
  value: Record<string, unknown>,
  field: FieldNode,
): GqlValue {
  const args = argsOf(field, ctx.variables);
  const selection = field.selection ?? [];
  switch (typeName) {
    case 'Query':
      return resolveQueryField(ctx, field, args, selection);
    case 'Mutation':
      return resolveMutationField(ctx, field, args, selection);
    case 'Repository':
      return resolveRepositoryField(ctx, value, field, args, selection);
    case 'Issue':
      return resolveIssueField(ctx, value, field, args, selection);
    case 'PullRequest':
      return resolvePullRequestField(ctx, value, field, args, selection);
    case 'IssueComment':
      return resolveCommentField(ctx, value, field);
    case 'User':
      return resolveUserField(ctx, value, field);
    case '__Type':
      return resolveTypeField(value, field, selection, ctx);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      return resolveConnectionField(ctx, typeName, value, field, args, selection);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
      return resolvePayloadField(ctx, value, field, selection);
    case 'CommentEdge': {
      if (field.name === 'node') {
        const node = value.node as Record<string, unknown>;
        return executeSelection(ctx, node.__typename as string, node, field.selection ?? []);
      }
      if (field.name === 'cursor') return value.cursor as string | null;
      fieldError(ctx, 'CommentEdge', field.name);
      return null;
    }
    case 'Edge': {
      if (field.name === 'node') {
        const node = value.__node as Record<string, unknown>;
        const nodeType = value.__nodeType as string;
        return executeSelection(ctx, nodeType, node, field.selection ?? []);
      }
      if (field.name === 'cursor') return value.cursor as string;
      fieldError(ctx, 'Edge', field.name);
      return null;
    }
    case 'PageInfo':
    case 'Ref':
    case '__TypeField':
    case '__EnumValue':
    case 'Named': {
      const property = value[field.name];
      if (property === undefined) {
        fieldError(ctx, typeName, field.name);
        return null;
      }
      if (typeof property === 'object' && property !== null && !Array.isArray(property)) {
        return executeSelection(ctx, 'Named', property as Record<string, unknown>, field.selection ?? []);
      }
      return property as GqlValue;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return value.path as string;
      fieldError(ctx, 'PullRequestFile', field.name);
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType' || field.name === 'mutationType') {
        return executeSelection(ctx, 'Named', value[field.name] as Record<string, unknown>, field.selection ?? []);
      }
      if (field.name === 'types') {
        const types = (value.types as Record<string, unknown>[] | undefined) ?? [];
        return types.map((entry) => executeSelection(ctx, 'Named', entry, field.selection ?? []));
      }
      fieldError(ctx, '__Schema', field.name);
      return null;
    }
    default:
      fieldError(ctx, typeName, field.name);
      return null;
  }
}

function resolveQueryField(
  ctx: ExecContext,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  if (field.name === 'viewer') {
    const viewer = { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    return executeSelection(ctx, 'User', viewer as unknown as Record<string, unknown>, selection);
  }
  if (field.name === 'repository') {
    const owner = args.owner as string | undefined;
    const name = args.name as string | undefined;
    if (owner === undefined || name === undefined) return null;
    if (owner !== VIEWER.login) return null;
    const repo = ctx.store.getRepo(name);
    if (repo === undefined) return null;
    return executeSelection(ctx, 'Repository', repositoryValue(repo), selection);
  }
  if (field.name === 'node') {
    const id = args.id as string | undefined;
    if (id === undefined) return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    const node = nodeValue(ctx.store, parsed);
    if (node === null) return null;
    return executeSelection(ctx, node.type, node.value, selection);
  }
  if (field.name === '__type') {
    const name = args.name as string | undefined;
    if (name === undefined) return null;
    const kind = TYPE_KINDS[name];
    if (kind === undefined) return null;
    const value: Record<string, unknown> = {
      name,
      kind,
      fields: (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ name: fieldName })),
      enumValues: (ENUM_VALUES[name] ?? []).map((enumName) => ({ name: enumName })),
    };
    return executeSelection(ctx, '__Type', value, selection);
  }
  if (field.name === '__schema') {
    const value: Record<string, unknown> = {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: Object.keys(TYPE_KINDS).map((typeName) => ({ name: typeName, kind: TYPE_KINDS[typeName] })),
    };
    return executeSelection(ctx, '__Schema', value, selection);
  }
  fieldError(ctx, 'Query', field.name);
  return null;
}

// --------------------------------------------------------------------------- values

function repositoryValue(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function issueValue(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function commentValue(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return { __typename: 'IssueComment', __repo: repo, __issueNumber: issueNumber, __comment: comment };
}

function nodeValue(
  store: Store,
  parsed: { kind: string; owner: string; name: string; number?: number; commentId?: number },
): { type: string; value: Record<string, unknown> } | null {
  if (parsed.owner !== VIEWER.login) return null;
  const repo = store.getRepo(parsed.name);
  if (repo === undefined) return null;
  if (parsed.kind === 'Repository') return { type: 'Repository', value: repositoryValue(repo) };
  if (parsed.kind === 'Issue' && parsed.number !== undefined) {
    const issue = repo.issues.find((candidate) => candidate.number === parsed.number);
    if (issue === undefined) return null;
    return { type: 'Issue', value: issueValue(repo, issue) };
  }
  if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
    const pull = repo.pulls.find((candidate) => candidate.number === parsed.number);
    if (pull === undefined) return null;
    return { type: 'PullRequest', value: pullValue(repo, pull) };
  }
  if (parsed.kind === 'IssueComment' && parsed.number !== undefined && parsed.commentId !== undefined) {
    const comment = (repo.comments.get(parsed.number) ?? []).find((candidate) => candidate.id === parsed.commentId);
    if (comment === undefined) return null;
    return { type: 'IssueComment', value: commentValue(repo, parsed.number, comment) };
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(number: number): string {
  return b64encode(`cursor:${number}`);
}

function numberAfterCursor(after: unknown): number | undefined {
  if (typeof after !== 'string') return undefined;
  try {
    const text = b64decode(after);
    if (!text.startsWith('cursor:')) return undefined;
    const number = Number(text.slice('cursor:'.length));
    return Number.isInteger(number) ? number : undefined;
  } catch {
    return undefined;
  }
}

interface ConnectionResult {
  nodes: Record<string, unknown>[];
  pageInfo: Record<string, unknown>;
}

function paginate<T extends { number: number }>(
  items: readonly T[],
  first: unknown,
  after: unknown,
  toValue: (item: T) => Record<string, unknown>,
): ConnectionResult {
  const afterNumber = numberAfterCursor(after);
  let start = 0;
  if (afterNumber !== undefined) {
    const index = items.findIndex((item) => item.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const rest = items.slice(start);
  const total = items.length;
  const limit = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : rest.length;
  const page = rest.slice(0, limit);
  const hasNextPage = rest.length > page.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as T).number) : null;
  return {
    nodes: page.map(toValue),
    pageInfo: {
      hasNextPage,
      endCursor,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor((page[0] as T).number) : null,
    },
    totalCount: total,
  };
}

interface ConnectionResult {
  nodes: Record<string, unknown>[];
  pageInfo: Record<string, unknown>;
  totalCount: number;
}

function connectionValue(typeName: string, result: ConnectionResult): Record<string, unknown> {
  return { __typename: typeName, __nodes: result.nodes, __pageInfo: result.pageInfo, __totalCount: result.totalCount };
}

function resolveRepositoryField(
  ctx: ExecContext,
  value: Record<string, unknown>,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  const repo = value.__repo as Repo;
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return executeSelection(ctx, 'User', { login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, selection);
    case 'defaultBranchRef': {
      const tip = ctx.store.resolveCommit(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return executeSelection(ctx, 'Ref', { name: repo.defaultBranch }, selection);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return null;
      return executeSelection(ctx, 'Issue', issueValue(repo, issue), selection);
    }
    case 'issues': {
      let issues = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states !== undefined) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction ?? 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const result = paginate(issues, args.first, args.after, (issue) => issueValue(repo, issue));
      return executeSelection(ctx, 'IssueConnection', connectionValue('IssueConnection', result), selection);
    }
    case 'pullRequest': {
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return null;
      return executeSelection(ctx, 'PullRequest', pullValue(repo, pull), selection);
    }
    case 'pullRequests': {
      const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
      const result = paginate(pulls, args.first, args.after, (pull) => pullValue(repo, pull));
      return executeSelection(ctx, 'PullRequestConnection', connectionValue('PullRequestConnection', result), selection);
    }
    default:
      fieldError(ctx, 'Repository', field.name);
      return null;
  }
}

function resolveIssueField(
  ctx: ExecContext,
  value: Record<string, unknown>,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  const repo = value.__repo as Repo;
  const issue = value.__issue as Issue;
  switch (field.name) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issueState(issue);
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'closedAt':
      return issue.closedAt;
    case 'author':
      return executeSelection(ctx, 'User', { login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, selection);
    case 'labels':
      return issue.labels.map((label) => ({ name: label.name, color: label.color }));
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'repository':
      return executeSelection(ctx, 'Repository', repositoryValue(repo), selection);
    default:
      fieldError(ctx, 'Issue', field.name);
      return null;
  }
}

function resolvePullRequestField(
  ctx: ExecContext,
  value: Record<string, unknown>,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  const repo = value.__repo as Repo;
  const pull = value.__pull as Pull;
  switch (field.name) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      if (pull.state !== 'open') return 'UNKNOWN';
      return mergeConflicts(ctx.store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit': {
      if (pull.mergeCommitSha === null) return null;
      return { oid: pull.mergeCommitSha };
    }
    case 'files': {
      const files = pullFiles(ctx.store, repo, pull);
      const first = args.first as number | undefined;
      const nodes = (typeof first === 'number' ? files.slice(0, first) : files).map((file) => ({ __typename: 'PullRequestFile', path: file.path }));
      const result: ConnectionResult = {
        nodes: nodes as unknown as Record<string, unknown>[],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        totalCount: files.length,
      };
      return executeSelection(ctx, 'PullRequestFileConnection', connectionValue('PullRequestFileConnection', result), selection);
    }
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author':
      return executeSelection(ctx, 'User', { login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, selection);
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    default:
      fieldError(ctx, 'PullRequest', field.name);
      return null;
  }
}

function resolveCommentField(ctx: ExecContext, value: Record<string, unknown>, field: FieldNode): GqlValue {
  const repo = value.__repo as Repo;
  const issueNumber = value.__issueNumber as number;
  const comment = value.__comment as { id: number; body: string; createdAt: string };
  switch (field.name) {
    case 'id':
      return commentGlobalId(repo, issueNumber, comment);
    case 'databaseId':
      return comment.id;
    case 'body':
      return comment.body;
    case 'createdAt':
      return comment.createdAt;
    case 'updatedAt':
      return comment.createdAt;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`;
    default:
      fieldError(ctx, 'IssueComment', field.name);
      return null;
  }
}

function resolveUserField(ctx: ExecContext, value: Record<string, unknown>, field: FieldNode): GqlValue {
  switch (field.name) {
    case 'login':
      return value.login as string;
    case 'id':
      return value.id as number;
    case 'name':
      return value.name as string;
    case 'email':
      return value.email as string;
    default:
      fieldError(ctx, 'User', field.name);
      return null;
  }
}

function resolveTypeField(
  value: Record<string, unknown>,
  field: FieldNode,
  selection: SelectionNode[],
  ctx: ExecContext,
): GqlValue {
  switch (field.name) {
    case 'name':
      return value.name as string;
    case 'kind':
      return value.kind as string;
    case 'description':
      return null;
    case 'fields': {
      const fields = (value.fields as { name: string }[] | undefined) ?? [];
      return fields.map((entry) => executeSelection(ctx, '__TypeField', { name: entry.name }, selection) ?? { name: entry.name });
    }
    case 'enumValues': {
      const values = (value.enumValues as { name: string }[] | undefined) ?? [];
      return values.map((entry) => executeSelection(ctx, '__EnumValue', { name: entry.name }, selection) ?? { name: entry.name });
    }
    default:
      fieldError(ctx, '__Type', field.name);
      return null;
  }
}

function resolveConnectionField(
  ctx: ExecContext,
  typeName: string,
  value: Record<string, unknown>,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  switch (field.name) {
    case 'nodes': {
      const nodes = (value.__nodes as Record<string, unknown>[] | undefined) ?? [];
      const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
      return nodes.map((node) => executeSelection(ctx, itemType, node, selection));
    }
    case 'edges': {
      const nodes = (value.__nodes as Record<string, unknown>[] | undefined) ?? [];
      const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
      return nodes.map((node) => {
        const number = (node.__issue as Issue | undefined)?.number ?? (node.__pull as Pull | undefined)?.number ?? 0;
        return executeSelection(ctx, 'Edge', { __node: node, __nodeType: itemType, cursor: cursorFor(number) }, selection);
      });
    }
    case 'pageInfo': {
      const pageInfo = (value.__pageInfo as Record<string, unknown> | undefined) ?? {};
      return executeSelection(ctx, 'PageInfo', pageInfo, selection);
    }
    case 'totalCount':
      return (value.__totalCount as number | undefined) ?? 0;
    default:
      fieldError(ctx, typeName, field.name);
      return null;
  }
}

// --------------------------------------------------------------------------- mutations

function resolveMutationField(
  ctx: ExecContext,
  field: FieldNode,
  args: Record<string, unknown>,
  selection: SelectionNode[],
): GqlValue {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = input.repositoryId as string | undefined;
      const title = input.title as string | undefined;
      const body = (input.body as string | undefined) ?? '';
      if (repositoryId === undefined || title === undefined) {
        ctx.errors.push({ message: 'createIssue requires repositoryId and title.' });
        return null;
      }
      const parsed = parseGlobalId(repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: unknown repository.' });
        return null;
      }
      const repo = ctx.store.getRepo(parsed.name);
      if (repo === undefined || parsed.owner !== VIEWER.login) {
        ctx.errors.push({ message: 'createIssue: unknown repository.' });
        return null;
      }
      const issue: Issue = {
        id: ctx.store.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body,
        state: 'open',
        labels: [],
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
        closedAt: null,
      };
      ctx.store.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return executeSelection(ctx, 'CreateIssuePayload', { issue: issueValue(repo, issue) }, selection);
    }
    case 'closeIssue': {
      const issueId = input.issueId as string | undefined;
      if (issueId === undefined) {
        ctx.errors.push({ message: 'closeIssue requires issueId.' });
        return null;
      }
      const parsed = parseGlobalId(issueId);
      if (parsed === null || parsed.kind !== 'Issue' || parsed.number === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue.' });
        return null;
      }
      const repo = ctx.store.getRepo(parsed.name);
      const issue = repo?.issues.find((candidate) => candidate.number === parsed.number);
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue.' });
        return null;
      }
      issue.state = 'closed';
      issue.closedAt = TRIAL_NOW_ISO;
      issue.updatedAt = TRIAL_NOW_ISO;
      return executeSelection(ctx, 'CloseIssuePayload', { issue: issueValue(repo, issue) }, selection);
    }
    case 'createPullRequest': {
      const repositoryId = input.repositoryId as string | undefined;
      const baseRefName = input.baseRefName as string | undefined;
      const headRefName = input.headRefName as string | undefined;
      const title = input.title as string | undefined;
      const body = (input.body as string | undefined) ?? '';
      if (repositoryId === undefined || baseRefName === undefined || headRefName === undefined || title === undefined) {
        ctx.errors.push({ message: 'createPullRequest requires repositoryId, baseRefName, headRefName and title.' });
        return null;
      }
      const parsed = parseGlobalId(repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository.' });
        return null;
      }
      const repo = ctx.store.getRepo(parsed.name);
      if (repo === undefined || parsed.owner !== VIEWER.login) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository.' });
        return null;
      }
      const headSha = ctx.store.resolveCommit(repo, headRefName);
      const baseSha = ctx.store.resolveCommit(repo, baseRefName);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
        return null;
      }
      const pull: Pull = {
        id: ctx.store.nextPullId,
        number: repo.nextPullNumber,
        title,
        body,
        state: 'open',
        merged: false,
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: TRIAL_NOW_ISO,
        updatedAt: TRIAL_NOW_ISO,
      };
      ctx.store.nextPullId += 1;
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      return executeSelection(ctx, 'CreatePullRequestPayload', { pullRequest: pullValue(repo, pull) }, selection);
    }
    case 'mergePullRequest': {
      const pullRequestId = input.pullRequestId as string | undefined;
      if (pullRequestId === undefined) {
        ctx.errors.push({ message: 'mergePullRequest requires pullRequestId.' });
        return null;
      }
      const parsed = parseGlobalId(pullRequestId);
      if (parsed === null || parsed.kind !== 'PullRequest' || parsed.number === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request.' });
        return null;
      }
      const repo = ctx.store.getRepo(parsed.name);
      const pull = repo?.pulls.find((candidate) => candidate.number === parsed.number);
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request.' });
        return null;
      }
      if (pull.state !== 'open' || mergeConflicts(ctx.store, repo, pull)) {
        ctx.errors.push({ message: 'mergePullRequest: pull request cannot be merged.' });
        return null;
      }
      squashMerge(ctx.store, repo, pull);
      return executeSelection(ctx, 'MergePullRequestPayload', { pullRequest: pullValue(repo, pull) }, selection);
    }
    case 'addComment': {
      const subjectId = input.subjectId as string | undefined;
      const body = input.body as string | undefined;
      if (subjectId === undefined || body === undefined) {
        ctx.errors.push({ message: 'addComment requires subjectId and body.' });
        return null;
      }
      const parsed = parseGlobalId(subjectId);
      if (parsed === null || parsed.kind !== 'Issue' || parsed.number === undefined) {
        ctx.errors.push({ message: 'addComment: unknown subject.' });
        return null;
      }
      const repo = ctx.store.getRepo(parsed.name);
      const issue = repo?.issues.find((candidate) => candidate.number === parsed.number);
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'addComment: unknown subject.' });
        return null;
      }
      const comment = { id: ctx.store.nextCommentId, body, createdAt: TRIAL_NOW_ISO };
      ctx.store.nextCommentId += 1;
      const list = repo.comments.get(parsed.number) ?? [];
      list.push(comment);
      repo.comments.set(parsed.number, list);
      const node = commentValue(repo, parsed.number, comment);
      return executeSelection(ctx, 'AddCommentPayload', { commentEdge: { __typename: 'CommentEdge', node } }, selection);
    }
    default:
      fieldError(ctx, 'Mutation', field.name);
      return null;
  }
}

// Payload objects resolve their single field by delegating to the nested value.
function resolvePayloadField(
  ctx: ExecContext,
  value: Record<string, unknown>,
  field: FieldNode,
  selection: SelectionNode[],
): GqlValue {
  const nested = value[field.name];
  if (nested === undefined) {
    fieldError(ctx, 'Payload', field.name);
    return null;
  }
  if (typeof nested === 'object' && nested !== null) {
    const record = nested as Record<string, unknown>;
    if (typeof record.__typename === 'string') {
      return executeSelection(ctx, record.__typename, record, selection);
    }
    if (field.name === 'commentEdge') {
      return executeSelection(ctx, 'CommentEdge', record, selection);
    }
  }
  return nested as GqlValue;
}

// --------------------------------------------------------------------------- HTTP

function executeDocument(store: Store, document: DocumentNode, variables: Variables): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const data: Record<string, unknown> = {};
  for (const operation of document.operations) {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const resolved = executeSelection(ctx, rootType, {}, operation.selection);
    if (resolved !== null) Object.assign(data, resolved);
  }
  const out: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export async function handleGraphql(store: Store, ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/api/graphql') return false;
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
    sendJson(ctx, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
    return true;
  }
  const bodies = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results: unknown[] = [];
  for (const item of bodies) {
    if (typeof item !== 'object' || item === null || typeof (item as Record<string, unknown>).query !== 'string') {
      results.push({ data: null, errors: [{ message: 'Request must carry a query string.' }] });
      continue;
    }
    const record = item as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables as Variables | undefined) ?? {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    let document: DocumentNode;
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    if (operationName !== undefined) {
      const named = document.operations.find((operation) => operation.name === operationName);
      if (named !== undefined) document = { operations: [named], fragments: document.fragments };
    }
    // Variable defaults.
    const mergedVariables: Variables = { ...variables };
    for (const operation of document.operations) {
      for (const variable of operation.variables) {
        if (mergedVariables[variable.name] === undefined && variable.defaultValue !== undefined) {
          mergedVariables[variable.name] = resolveValue(variable.defaultValue, mergedVariables);
        }
      }
    }
    results.push(executeDocument(store, document, mergedVariables));
  }
  sendJson(ctx, 200, Array.isArray(parsed.value) ? results : results[0]);
  return true;
}
