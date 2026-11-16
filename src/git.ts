// Git smart HTTP: /{owner}/{repo}.git. upload-pack protocol v2 (with a v0
// fallback when the client does not ask for v2), receive-pack v0, packfiles,
// shallow fetch, per-ref fast-forward rules. No auth on this surface.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitpack.ts';
import { sendRaw, type Ctx } from './http.ts';
import { VIEWER } from './scenario.ts';
import { ancestors, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0';

function gitNotFound(ctx: Ctx): boolean {
  sendRaw(ctx, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found', 'utf8'));
  return true;
}

function findGitRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  const base = name.endsWith('.git') ? name.slice(0, -4) : name;
  return store.getRepo(base) ?? null;
}

/** All refs of a repo: HEAD first, then every ref (heads and tags), sorted. */
function allRefs(repo: Repo): { name: string; oid: string }[] {
  const refs: { name: string; oid: string }[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) refs.push({ name: 'HEAD', oid: head });
  for (const name of [...repo.refs.keys()].sort()) {
    refs.push({ name, oid: repo.refs.get(name) as string });
  }
  return refs;
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

function v2Advertisement(): Buffer {
  const lines: string[] = ['version 2\n', ...UPLOAD_V2_CAPS.map((cap) => `${cap}\n`)];
  return encodePktLines([...lines, 'flush']);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`)];
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined && ref.name.startsWith('refs/tags/')) {
        parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export async function handleGit(store: Store, ctx: Ctx): Promise<boolean> {
  const seg = ctx.segments;
  // /{owner}/{repo}.git/...
  if (seg.length < 2) return false;
  const repoPart = seg[2] as string;
  if (!repoPart.endsWith('.git')) return false;
  const owner = seg[1] as string;
  const repo = findGitRepo(store, owner, repoPart);
  const tail = seg.slice(3);
  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') {
    if (repo === null) return gitNotFound(ctx);
    return infoRefs(ctx, repo);
  }
  if (repo === null) return gitNotFound(ctx);
  if (tail.length === 1 && tail[0] === 'git-upload-pack' && ctx.method === 'POST') {
    return uploadPack(store, ctx, repo);
  }
  if (tail.length === 1 && tail[0] === 'git-receive-pack' && ctx.method === 'POST') {
    return receivePack(store, ctx, repo);
  }
  return gitNotFound(ctx);
}

function infoRefs(ctx: Ctx, repo: Repo): boolean {
  const service = ctx.url.searchParams.get('service');
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      sendRaw(ctx, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendRaw(ctx, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
    }
    return true;
  }
  if (service === 'git-receive-pack') {
    sendRaw(ctx, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return true;
  }
  return gitNotFound(ctx);
}

/** ls-refs (protocol v2): refs, HEAD symref, peeled tags, prefix filtering. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip === undefined) {
    if (unborn && matches('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else if (prefixes.length === 0) {
    lines.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const peeled = peel ? peeledOid(repo, oid) : undefined;
    if (peeled !== undefined) line += ` peeled:${peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth?: number;
}

function parseFetchLines(packets: readonly { kind: string; payload?: Buffer }[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  return { wants, haves, shallow, depth };
}

/** The commits a fetch delivers, and the shallow/unshallow boundary report. */
function computeFetch(
  store: Store,
  repo: Repo,
  request: FetchRequest,
): { commits: Set<string>; shallow: string[]; unshallow: string[] } {
  const included = new Set<string>();
  if (request.depth !== undefined) {
    // Breadth-first from the wants, cutting at the depth limit.
    const queue: { oid: string; distance: number }[] = request.wants.map((oid) => ({ oid, distance: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      if (seen.has(oid) || distance >= request.depth) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.add(oid);
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  } else {
    const wantAncestors = new Set<string>();
    for (const want of request.wants) {
      for (const oid of ancestors(store, repo, want)) wantAncestors.add(oid);
    }
    const haveAncestors = new Set<string>();
    for (const have of request.haves) {
      for (const oid of ancestors(store, repo, have)) haveAncestors.add(oid);
    }
    for (const oid of wantAncestors) {
      if (!haveAncestors.has(oid)) included.add(oid);
    }
  }
  // Shallow boundaries: included commits whose parents are not included stay
  // shallow; previously-shallow commits now fully included become unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const boundaryOf = (oid: string): boolean => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return false;
    return parseCommit(object.data).parents.some((parent) => !included.has(parent));
  };
  if (request.depth !== undefined) {
    for (const oid of included) {
      if (boundaryOf(oid)) shallow.push(oid);
    }
  }
  for (const old of request.shallow) {
    if (!included.has(old)) continue;
    if (boundaryOf(old)) {
      if (!shallow.includes(old)) shallow.push(old);
    } else {
      unshallow.push(old);
    }
  }
  return { commits: included, shallow, unshallow };
}

/** Every object reachable from the included commits (plus tag targets for tag wants). */
function collectFetchObjects(repo: Repo, request: FetchRequest, included: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || out.has(oid)) return;
    out.set(oid, object);
    if (object.type === 'commit') {
      const parts = parseCommit(object.data);
      addObject(parts.tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addObject(entry.oid);
    } else if (object.type === 'tag') {
      addObject(parseTag(object.data).object);
    }
  };
  for (const oid of included) addObject(oid);
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') addObject(want);
  }
  // The client already holds everything reachable from its haves: do not resend it.
  const held = new Set<string>();
  const markHeld = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || held.has(oid)) return;
    held.add(oid);
    if (object.type === 'commit') {
      const parts = parseCommit(object.data);
      markHeld(parts.tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) markHeld(entry.oid);
    } else if (object.type === 'tag') {
      markHeld(parseTag(object.data).object);
    }
  };
  for (const have of request.haves) markHeld(have);
  for (const oid of [...held]) out.delete(oid);
  return out;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, offset + 65515);
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(framed));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

function uploadPack(store: Store, ctx: Ctx, repo: Repo): boolean {
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (!wantsV2) return uploadPackV0(store, ctx, repo);
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line', 'utf8'));
    return true;
  }
  const first = packets[0];
  if (first === undefined || first.kind !== 'data') return gitNotFound(ctx);
  const command = first.payload.toString('utf8').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    const args: string[] = [];
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const body = lsRefs(repo, args);
    sendRaw(ctx, 200, 'application/x-git-upload-pack-result', body);
    return true;
  }
  if (command !== 'command=fetch') return gitNotFound(ctx);
  const request = parseFetchLines(packets);
  return sendFetchV2(store, ctx, repo, request);
}

function sendFetchV2(store: Store, ctx: Ctx, repo: Repo, request: FetchRequest): boolean {
  const { commits, shallow, unshallow } = computeFetch(store, repo, request);
  const objects = collectFetchObjects(repo, request, commits);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  const knownHaves = request.haves.filter((have) => repo.objects.has(have));
  if (knownHaves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of knownHaves) parts.push(encodePktLine(`ACK ${have}\n`));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // packfile
  if (objects.size > 0) {
    parts.push(encodePktLine('packfile\n'));
    const pack = writePack(sortedObjects(objects));
    parts.push(sidebandPack(pack));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

function uploadPackV0(store: Store, ctx: Ctx, repo: Repo): boolean {
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    sendRaw(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line', 'utf8'));
    return true;
  }
  const request = parseFetchLines(packets);
  if (request.wants.length === 0) {
    sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.from('0000', 'ascii'));
    return true;
  }
  const { commits, shallow, unshallow } = computeFetch(store, repo, request);
  const objects = collectFetchObjects(repo, request, commits);
  const parts: Buffer[] = [];
  const knownHaves = request.haves.filter((have) => repo.objects.has(have));
  if (knownHaves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of knownHaves) parts.push(encodePktLine(`ACK ${have}\n`));
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (objects.size > 0) {
    const pack = writePack(sortedObjects(objects));
    parts.push(sidebandPack(pack));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

/** Objects sorted by oid, so pack bytes are deterministic for a given set. */
function sortedObjects(objects: ReadonlyMap<string, GitObject>): GitObject[] {
  return [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, object]) => object);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function receivePack(store: Store, ctx: Ctx, repo: Repo): boolean {
  const body = ctx.body;
  // Commands are pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities = '';
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = line.indexOf('\0');
    const text = (nul < 0 ? line : line.slice(0, nul)).replace(/\n$/, '');
    if (nul >= 0 && capabilities === '') capabilities = line.slice(nul + 1).replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const unpacked = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) unpacked.set(oid, object);
    } catch {
      unpackOk = false;
      unpackDetail = 'error';
    }
  }
  // Store every unpacked object, even for refused refs.
  if (unpackOk) {
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const sideband = capabilities.includes('side-band-64k');
  void sideband;
  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyPushCommand(store, repo, command);
      if (result.ok) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${result.reason}\n`);
    }
  }
  const report = encodePktLines(reportLines);
  const framed = sidebandPack(report);
  const bodyOut = Buffer.concat([framed, Buffer.from('0000', 'ascii')]);
  sendRaw(ctx, 200, 'application/x-git-receive-pack-result', bodyOut);
  return true;
}

/** Validate and apply one push command. Refused refs leave the store untouched. */
function applyPushCommand(store: Store, repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  const currentOid = current ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
    if (command.oldOid !== currentOid) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'non-fast-forward' };
  } else {
    if (command.oldOid !== currentOid) return { ok: false, reason: 'non-fast-forward' };
    if (command.newOid !== command.oldOid) {
      // Fast-forward: the new tip must descend from the old one.
      if (!isFastForward(store, repo, currentOid, command.newOid)) {
        return { ok: false, reason: 'non-fast-forward' };
      }
    }
  }
  // The new tip's closure must be present (in the store now, after unpacking).
  if (repo.objects.get(command.newOid) === undefined) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

function isFastForward(store: Store, repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const object = repo.objects.get(newOid);
  if (object === undefined) return false;
  // Tags are not fast-forwardable to a different object.
  if (object.type === 'tag') return false;
  if (object.type !== 'commit') return false;
  return ancestors(store, repo, newOid).has(oldOid);
}
