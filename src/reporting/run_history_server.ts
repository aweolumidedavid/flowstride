import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isLocalWorkspaceRequest } from '../security/localWorkspace';
import { latestNativeId, readLatestNativeRun } from './native_history';
import { listSavedRuns, readRunAttachment, readSavedRun } from './run_history';
import type { AttachmentType } from './run_history_types';

const historyRoute = '/api/run-history';
const extensions: Record<AttachmentType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'video/webm': 'webm', 'video/mp4': 'mp4',
  'application/zip': 'zip', 'application/json': 'json', 'text/plain': 'txt',
};

const sameOrigin = (req: http.IncomingMessage) => isLocalWorkspaceRequest(
  req.headers.host, req.headers.origin, req.socket.localPort,
  typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined,
);

export function historyCatalog(root: string, artifactDirectory?: string) {
  const entries = listSavedRuns(root);
  if (entries.some(run => run.source === 'flowstride')) return entries;
  const old = readLatestNativeRun(root, artifactDirectory);
  if (!old) return entries;
  const { id, source, name, status, startedAt, duration, counts } = old;
  return [...entries, { id, source, name, status, startedAt, duration, counts }]
    .sort((left, right) => right.startedAt - left.startedAt);
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** Handles the read-only history routes on both dashboard servers. */
export function serveRunHistory(req: http.IncomingMessage, res: http.ServerResponse, root: string, artifactDirectory?: string): boolean {
  const pathname = (req.url || '/').split('?', 1)[0]!;
  if (pathname !== historyRoute && !pathname.startsWith(historyRoute + '/')) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'This report is only available from the local dashboard.' });
    return true;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    json(res, 405, { error: 'Only GET is supported.' });
    return true;
  }
  if (pathname === historyRoute) {
    json(res, 200, { runs: historyCatalog(root, artifactDirectory) });
    return true;
  }
  const segments = pathname.slice(historyRoute.length).slice(1).split('/');
  const [id, sub, attachment] = segments;
  if (id && segments.length === 1) {
    const report = id === latestNativeId ? readLatestNativeRun(root, artifactDirectory) : readSavedRun(root, id);
    if (report) {
      json(res, 200, report);
      return true;
    }
  } else if (segments.length === 3 && id && sub === 'attachments' && attachment) {
    const media = readRunAttachment(root, id, attachment);
    if (media) {
      res.writeHead(200, {
        'Content-Type': media.attachment.contentType,
        'Content-Length': media.body.length,
        'Content-Disposition': 'attachment; filename="flowstride-' + attachment + '.' + extensions[media.attachment.contentType] + '"',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      });
      res.end(media.body);
      return true;
    }
  }
  json(res, 404, { error: 'Saved run or attachment was not found.' });
  return true;
}

const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export async function startRunHistoryServer(root: string, artifactDirectory?: string) {
  const bundle = path.resolve(__dirname, '../../src/ui/dist');
  if (!fs.existsSync(path.join(bundle, 'index.html'))) throw new Error('Flowstride dashboard assets are unavailable. Install a built Flowstride package.');

  const server = http.createServer((req, res) => {
    try {
      if (serveRunHistory(req, res, root, artifactDirectory)) return;
      if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
      const pathname = (req.url || '/').split('?', 1)[0]!;
      if (pathname === '/') { res.writeHead(302, { Location: '/run-reports' }).end(); return; }
      const file = pathname === '/run-reports' ? 'index.html' : pathname.slice(1);
      if (!/^(?:index\.html|favicon\.(?:svg|png|ico)|assets\/[a-zA-Z0-9_.-]+)$/.test(file)) { res.writeHead(404).end(); return; }
      const type = staticTypes[path.extname(file)];
      if (!type) { res.writeHead(404).end(); return; }
      const data = fs.readFileSync(path.join(bundle, file));
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the local reports server.');
  return { server, url: 'http://127.0.0.1:' + address.port + '/run-reports' };
}
