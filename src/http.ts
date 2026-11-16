// Small HTTP helpers shared by the REST, GraphQL, MCP and git handlers:
// a request id counter (deterministic, no wall clock), JSON replies, auth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SHOP_TOKEN } from './scenario.ts';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(6, '0')}`;
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly segments: string[];
  readonly requestId: string;
  body: Buffer;
}

export function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function sendNoBody(ctx: Ctx, status: number, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end();
}

export function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

export function messageError(message: string): { message: string } {
  return { message };
}

/** Bearer auth against the trial token. Empty token env means "accept any" (local dev only). */
export function isAuthenticated(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  if (SHOP_TOKEN === '') return true;
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === SHOP_TOKEN;
}

export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, error: 'Invalid JSON in request body' };
  }
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
