import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectPath, videoFileName } from '../utils/projectPaths';

export function localVideoPath(root: string, fileName: string): string {
  return path.join(root, '.flowstride', 'mock-cloud', videoFileName(fileName));
}

function parseByteRange(range: string, size: number) {
  const bounds = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!bounds || (!bounds[1] && !bounds[2])) return;
  const start = bounds[1] ? Number(bounds[1]) : Math.max(0, size - Number(bounds[2]));
  const end = bounds[1] && bounds[2] ? Math.min(size - 1, Number(bounds[2])) : size - 1;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end) {
    return { start, end };
  }
}

/** Expose only recordings finalized for the current dashboard execution. */
export function serveLocalVideo(req: IncomingMessage, res: ServerResponse, root: string, available: ReadonlySet<string>): boolean {
  if (!req.url?.startsWith('/videos/')) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return true;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(req.url.slice('/videos/'.length).split('?')[0]!);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  if (!available.has(fileName)) {
    res.writeHead(404).end();
    return true;
  }

  let descriptor: number | undefined;
  try {
    const file = projectPath(root, localVideoPath(root, fileName));
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size === 0) {
      res.writeHead(404).end();
      return true;
    }

    const range = req.headers.range;
    const bounds = range ? parseByteRange(range, info.size) : { start: 0, end: info.size - 1 };
    if (!bounds) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end();
      return true;
    }

    const { start, end } = bounds;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/webm',
      'Content-Length': end - start + 1,
      ...(range && { 'Content-Range': 'bytes ' + start + '-' + end + '/' + info.size }),
    };
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
    } else {
      const stream = fs.createReadStream(file, { fd: descriptor, start, end });
      descriptor = undefined; // The stream owns this descriptor.
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    }
  } catch {
    if (res.headersSent) res.destroy();
    else res.writeHead(404).end();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return true;
}
