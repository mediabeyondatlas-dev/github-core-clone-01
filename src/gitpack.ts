// Git objects, pkt-lines and packfiles. Standard library only (node:crypto,
// node:zlib). Every object this forge builds or stores is addressed by its
// git SHA-1, so a pushed object and a cloned object are byte-identical.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The git SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function objectIdBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

export function bytesToOid(bytes: Buffer, offset = 0): string {
  return bytes.subarray(offset, offset + 20).toString('hex');
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Git's tree sort: entries compare by name, directories as if suffixed with '/'. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(objectIdBytes(entry.oid));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = bytesToOid(data, nul + 1);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// --------------------------------------------------------------------------- commits and tags

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly message: string;
}

export function identityLine(identity: Identity, epochSec: number): string {
  return `${identity.name} <${identity.email}> ${epochSec} +0000`;
}

export function buildCommit(parts: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  epochSec: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(parts.author, parts.epochSec)}`);
  lines.push(`committer ${identityLine(parts.committer, parts.epochSec)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function buildTag(parts: {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: Identity;
  epochSec: number;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${parts.object}\ntype ${parts.type}\ntag ${parts.tag}\n` +
      `tagger ${identityLine(parts.tagger, parts.epochSec)}\n\n${parts.message}`,
    'utf8',
  );
}

export interface TagParts {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly taggerLine: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let taggerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) taggerLine = line.slice(7);
  }
  return { object, type, tag, taggerLine, message };
}

// --------------------------------------------------------------------------- pkt-lines

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' };

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode one packet stream into packets (no validation of the payload). */
export function decodePktLines(buffer: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('malformed pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Incremental pkt-line decoder for streamed request bodies. */
export class PktLineDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  next(): GitPacket | null {
    if (this.#buffer.length < 4) return null;
    const length = parseInt(this.#buffer.subarray(0, 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('malformed pkt-line length');
    if (length === 0) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim' };
    }
    if (length < 4 || this.#buffer.length < length) return null;
    const payload = this.#buffer.subarray(4, length);
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload };
  }

  finish(): void {
    if (this.#buffer.length > 0) throw new Error('truncated pkt-line stream');
  }

  /** Bytes not yet consumed as a packet (the pack after a flush, for receive-pack). */
  remainder(): Buffer {
    return this.#buffer;
  }
}

// --------------------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A plain packfile (version 2, no deltas): PACK + count + zlib entries + SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    const header: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly declaredCount: number;
  readonly version: number;
  readonly deltaCount: number;
}

/** Parse a packfile of plain (non-delta) entries. Delta entries are rejected. */
export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < declaredCount; i += 1) {
    if (offset >= pack.length - 20) throw new Error('pack truncated');
    const first = pack[offset] as number;
    const typeId = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while ((pack[offset - 1] as number) & 0x80) {
      if (offset >= pack.length - 20) throw new Error('pack truncated');
      size |= ((pack[offset] as number) & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    if (typeId === 6 || typeId === 7) {
      // Delta entries are never sent by this suite's client; refuse rather than guess.
      deltaCount += 1;
      throw new Error('delta pack entries are not supported');
    }
    const type = PACK_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    const data = inflateSync(pack.subarray(offset));
    if (data.length !== size) throw new Error('pack object size mismatch');
    // inflateSync stops at the stream end and ignores what follows, so find the consumed
    // length by binary search for the first end offset that inflates cleanly.
    offset = packEndOfZlib(pack, offset);
    objects.set(hashObject(type, data), { type, data });
  }
  if (offset !== pack.length - 20) throw new Error('pack has trailing bytes');
  return { objects, declaredCount, version, deltaCount };
}

/** Offset just past the zlib stream that starts at `start` (zlib streams end with a sync flush). */
function packEndOfZlib(pack: Buffer, start: number): number {
  // Walk the deflate stream with a raw inflater that reports its consumed input.
  // Node's zlib does not expose that, so inflate in slices until the output length is stable:
  // instead, use the fact that inflateSync on a truncated buffer throws, and binary-search the
  // smallest end offset that inflates cleanly to a complete stream.
  let low = start;
  let high = pack.length - 20;
  // The stream must end at or before high; find the first offset that inflates without error.
  while (low < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(pack.subarray(start, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}
