// The HTTP server: one store, four surfaces, one router. Git smart HTTP
// first (its paths are not under /api), then GraphQL, MCP, REST, and a JSON
// 404 for anything else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleRest } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { messageError, nextRequestId, readBody, sendJson, type Ctx } from './http.ts';
import { Store } from './store.ts';

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      try {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[forge] unhandled request error: ${message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
        } else {
          res.destroy();
        }
      } catch {
        res.destroy();
      }
    });
  });
  // Keep-alive long enough for the read workload's 2,000 sequential GETs.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return { server, store };
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(rawUrl, `http://${host}`);
  const path = url.pathname;
  const segments = path.split('/');
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const ctx: Ctx = {
    req,
    res,
    method,
    url,
    path,
    segments,
    requestId: nextRequestId(),
    body,
  };
  // Health probe used by the harness boot check (not part of the REST API).
  if (method === 'GET' && path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }
  if (path.endsWith('.git') || path.includes('.git/')) {
    if (await handleGit(store, ctx)) return;
  }
  if (path === '/api/graphql') {
    if (await handleGraphql(store, ctx)) return;
  }
  if (path === '/mcp') {
    if (await handleMcp(store, ctx)) return;
  }
  if (path.startsWith('/api/v3')) {
    if (await handleRest(store, ctx)) return;
  }
  sendJson(ctx, 404, messageError('Not Found'));
}
