import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';

import {config} from './config.js';
import {validatePublicUrl} from './security.js';
import {
  inspect,
  videoSelector,
  audioQuality
} from './extractor.js';
import {JobManager} from './jobs.js';

export const manager = new JobManager();

const publicDir = path.join(config.root, 'public');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const limits = new Map();

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );
  res.end(JSON.stringify(data));
}

function cors(req, res) {
  const origin = req.headers.origin;

  if (config.corsOrigins === '*') {
    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );
  } else if (
    origin &&
    config.corsOrigins
      .split(',')
      .map(x => x.trim())
      .includes(origin)
  ) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );
  }

  res.setHeader('Vary', 'Origin');

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,DELETE,OPTIONS'
  );
}

function auth(req, res) {
  if (!config.apiKey) {
    return true;
  }

  const ok =
    req.headers['x-api-key'] === config.apiKey ||
    req.headers.authorization ===
      `Bearer ${config.apiKey}`;

  if (!ok) {
    json(res, 401, {
      success: false,
      error: 'Invalid API key'
    });
  }

  return ok;
}

function limited(req, res) {
  const now = Date.now();
  const key = req.socket.remoteAddress || 'unknown';
  const x = limits.get(key);

  if (!x || now - x.start >= config.rateWindow) {
    limits.set(key, {
      start: now,
      count: 1
    });

    return true;
  }

  x.count++;

  if (x.count > config.rateMax) {
    json(res, 429, {
      success: false,
      error: 'Rate limit exceeded'
    });

    return false;
  }

  return true;
}

async function body(req) {
  let s = '';

  for await (const c of req) {
    s += c;

    if (s.length > 1_048_576) {
      throw new Error('Request body too large');
    }
  }

  if (!s) {
    return {};
  }

  try {
    return JSON.parse(s);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function jobData(j) {
  return {
    id: j.id,
    status: j.status,
    progress: j.progress,
    title: j.title,
    thumbnail: j.thumbnail,
    error: j.error,
    poll: `/v1/jobs/${j.id}`,
    events: `/v1/jobs/${j.id}/events`,
    file:
      j.status === 'completed'
        ? `/v1/jobs/${j.id}/file`
        : null,
    size: j.size
  };
}

function requestData(b) {
  const type = b?.type ?? 'video';
  const format =
    b?.format ??
    (type === 'audio' ? 'mp3' : 'mp4');
  const quality = b?.quality ?? 'best';

  if (typeof b?.url !== 'string') {
    throw new Error('url is required');
  }

  if (!['video', 'audio'].includes(type)) {
    throw new Error(
      'type must be video or audio'
    );
  }

  if (type === 'video') {
    if (!['mp4', 'webm'].includes(format)) {
      throw new Error(
        'Video format must be mp4 or webm'
      );
    }

    videoSelector(quality);
  } else {
    if (!['mp3', 'm4a'].includes(format)) {
      throw new Error(
        'Audio format must be mp3 or m4a'
      );
    }

    audioQuality(quality);
  }

  return {
    url: b.url,
    type,
    format,
    quality
  };
}

function terminal(type) {
  return [
    'completed',
    'failed',
    'cancelled'
  ].includes(type);
}

async function route(req, res) {
  cors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!limited(req, res) || !auth(req, res)) {
    return;
  }

  const u = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const p = u.pathname;

  if (
    req.method === 'GET' &&
    p === '/health'
  ) {
    return json(res, 200, {
      success: true,
      status: 'ok',
      version: config.version,
      active: manager.active,
      queued: manager.queue.length,
      jobs: manager.jobs.size
    });
  }

  if (
    req.method === 'GET' &&
    p === '/docs'
  ) {
    return json(res, 200, {
      success: true,
      version: config.version,
      endpoints: {
        info: 'POST /v1/info',
        inspect: 'POST /v1/inspect',
        download: 'POST /v1/download',
        status: 'GET /v1/jobs/:id',
        events: 'GET /v1/jobs/:id/events',
        file: 'GET /v1/jobs/:id/file',
        cancel: 'DELETE /v1/jobs/:id',
        formats: 'GET /v1/formats'
      }
    });
  }

  if (
    req.method === 'GET' &&
    p === '/v1/formats'
  ) {
    return json(res, 200, {
      success: true,
      data: {
        video: [
          144,
          240,
          360,
          480,
          720,
          1080,
          1440,
          2160
        ]
          .map(n => ({
            id: String(n),
            label: `${n}p`
          }))
          .concat({
            id: 'best',
            label: 'Best available'
          }),

        audio: [
          64,
          96,
          128,
          160,
          192,
          256,
          320
        ]
          .map(n => ({
            id: String(n),
            label: `${n}k`
          }))
          .concat({
            id: 'best',
            label: 'Best audio'
          })
      }
    });
  }

  if (
    req.method === 'POST' &&
    (p === '/v1/info' ||
      p === '/v1/inspect')
  ) {
    const b = await body(req);
    const url = await validatePublicUrl(b.url);

    return json(res, 200, {
      success: true,
      data: await inspect(url)
    });
  }

  if (
    req.method === 'POST' &&
    p === '/v1/download'
  ) {
    const r = requestData(await body(req));

    r.url = await validatePublicUrl(r.url);

    return json(res, 202, {
      success: true,
      data: jobData(manager.create(r))
    });
  }

  const m = p.match(
    /^\/v1\/jobs\/([^/]+)(?:\/(events|file))?$/
  );

  if (m) {
    const j = manager.get(m[1]);

    if (!j) {
      return json(res, 404, {
        success: false,
        error: 'Job not found'
      });
    }

    if (
      req.method === 'GET' &&
      !m[2]
    ) {
      return json(res, 200, {
        success: true,
        data: jobData(j)
      });
    }

    if (
      req.method === 'GET' &&
      m[2] === 'events'
    ) {
      res.statusCode = 200;

      res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache, no-transform'
      );

      res.setHeader(
        'Connection',
        'keep-alive'
      );

      res.setHeader(
        'X-Accel-Buffering',
        'no'
      );

      res.flushHeaders?.();

      let closed = false;

      const writeEvent = event => {
        if (closed) {
          return;
        }

        try {
          res.write(
            `data: ${JSON.stringify(event)}\n\n`
          );

          if (terminal(event.type)) {
            close();
          }
        } catch {
          close();
        }
      };

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;

        clearInterval(heartbeat);

        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }

        try {
          res.end();
        } catch {}
      };

      // Replay events that happened before SSE connected.
      for (const event of j.events) {
        writeEvent(event);

        if (closed) {
          break;
        }
      }

      let unsubscribe = null;

      if (!closed && !terminal(j.status)) {
        unsubscribe = manager.subscribe(
          j,
          writeEvent
        );
      }

      // Keep long-lived SSE connections alive.
      const heartbeat = setInterval(() => {
        if (closed) {
          return;
        }

        try {
          res.write(': heartbeat\n\n');
        } catch {
          close();
        }
      }, 15000);

      req.on('close', close);

      return;
    }

    if (
      req.method === 'GET' &&
      m[2] === 'file'
    ) {
      if (
        j.status !== 'completed' ||
        !j.file
      ) {
        return json(res, 404, {
          success: false,
          error: 'File not ready'
        });
      }

      try {
        const st = await fs.stat(j.file);

        res.statusCode = 200;

        res.setHeader(
          'Content-Type',
          'application/octet-stream'
        );

        res.setHeader(
          'Content-Length',
          st.size
        );

        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(
            j.fileName
          )}`
        );

        createReadStream(j.file).pipe(res);

        return;
      } catch {
        return json(res, 404, {
          success: false,
          error: 'File expired'
        });
      }
    }

    if (req.method === 'DELETE') {
      manager.cancel(j.id);

      return json(res, 200, {
        success: true,
        data: jobData(j)
      });
    }
  }

  if (req.method === 'GET') {
    const rel =
      p === '/'
        ? 'index.html'
        : p.slice(1);

    if (
      rel.includes('..') ||
      path.isAbsolute(rel)
    ) {
      return json(res, 404, {
        success: false,
        error: 'Not found'
      });
    }

    try {
      const file = path.join(
        publicDir,
        rel
      );

      const st = await fs.stat(file);

      if (!st.isFile()) {
        throw Error();
      }

      res.statusCode = 200;

      res.setHeader(
        'Content-Type',
        mime[path.extname(file)] ||
          'application/octet-stream'
      );

      return res.end(
        await fs.readFile(file)
      );
    } catch {
      return json(res, 404, {
        success: false,
        error: 'Not found'
      });
    }
  }

  return json(res, 404, {
    success: false,
    error: 'Not found'
  });
}

export const server = http.createServer(
  (req, res) =>
    route(req, res).catch(e => {
      if (!res.headersSent) {
        json(res, 400, {
          success: false,
          error: e.message
        });
      } else {
        res.destroy();
      }
    })
);

const cleanupTimer = setInterval(
  () =>
    manager
      .cleanup()
      .catch(() => {}),
  60_000
);

cleanupTimer.unref();

server.listen(
  config.port,
  config.host,
  () =>
    console.log(
      `Cobalt Premium API v${config.version} running on http://${config.host}:${config.port}`
    )
);

function shutdown() {
  clearInterval(cleanupTimer);
  manager.stop();

  server.close(() =>
    process.exit(0)
  );

  setTimeout(
    () => process.exit(1),
    5000
  ).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
