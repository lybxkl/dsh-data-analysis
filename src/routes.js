/**
 * 面板数据通道：同源 HTTP 路由（只读 + 工作区登记）。
 *
 * webServer 没有认证层，所以自带两道防护：只接受 loopback Host、带 Origin 时必须同源。
 */

import fs from 'node:fs';
import path from 'node:path';

import { withReadCache } from './read-scope.js';

const MAX_BODY = 128 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1', '[::ffff:127.0.0.1]', '::ffff:127.0.0.1']);

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.r': 'text/plain; charset=utf-8',
  '.jl': 'text/plain; charset=utf-8',
  '.do': 'text/plain; charset=utf-8',
  '.sps': 'text/plain; charset=utf-8',
};

function hostIsLoopback(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).toLowerCase();
  const bracket = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return LOOPBACK.has(`[${bracket[1]}]`) || LOOPBACK.has(bracket[1]);
  return LOOPBACK.has(host.split(':')[0]);
}

function normalizeLoopback(name) {
  const host = String(name || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback';
  return host;
}

function allowedOrigins(selfOrigin, hostHeader) {
  const out = new Set();
  const push = (value) => {
    try {
      const url = new URL(value);
      out.add(`${url.protocol}//${normalizeLoopback(url.hostname)}:${url.port}`);
    } catch {
      /* ignore */
    }
  };
  if (selfOrigin) push(selfOrigin);
  const host = String(hostHeader || '').trim();
  if (host) {
    push(`http://${host}`);
    push(`https://${host}`);
  }
  return out;
}

function originMatches(originHeader, allowed) {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    return allowed.has(`${origin.protocol}//${normalizeLoopback(origin.hostname)}:${origin.port}`);
  } catch {
    return false;
  }
}

function isTrue(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        try {
          req.resume();
        } catch {
          /* ignore */
        }
        const error = new Error('请求体过大');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('请求体不是合法 JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function send(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, file, { type = 'application/octet-stream', download = false, name = '', ascii = '' } = {}) {
  if (res.headersSent) return;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, { ok: false, error: '文件不存在' });
  }
  if (!stat.isFile()) return send(res, 404, { ok: false, error: '不是文件' });
  const headers = {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'private, max-age=60',
    'x-content-type-options': 'nosniff',
  };
  // 产物是不可信数据：HTML/SVG 一律不给同源脚本能力
  if (/^text\/html|^image\/svg/i.test(type)) {
    headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  }
  if (download) {
    // filename= 用英文回退（兼容老浏览器），filename*=UTF-8 用中文显示名（现代浏览器优先取它）
    const fallback = String(ascii || name || path.basename(file)).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
    const label = encodeURIComponent(name || path.basename(file)).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
    headers['content-disposition'] = `attachment; filename="${fallback}"; filename*=UTF-8''${label}`;
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.pipe(res);
}

function headerValue(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function registerRoutes(ctx, services, helpers = {}) {
  const { logger, basePath = '/data-analysis', getConfig = () => ({}), setDataDir = async () => {} } = helpers;
  const { store, viewer, workspace } = services;

  const buildState = (wsId = '') => {
    const requested = String(wsId || '');
    const activeId = requested || String(store.get('activeWorkspaceId') || '');
    let snap = viewer.snapshot(activeId);
    // 面板手里的选择可能已过期：退回台账里的当前工作区，不让界面卡在空态
    if (!snap.ok && requested) snap = viewer.snapshot('');
    return {
      workspaces: workspace.list(),
      active: snap.workspace || null,
      activeError: snap.ok ? '' : snap.error,
      progress: snap.progress || [],
      layout: snap.layout || { ok: false, groups: [], stray: [] },
      tree: snap.tree || null,
      config: getConfig(),
    };
  };

  const routes = [
    {
      path: `${basePath}/api/health`,
      method: 'GET',
      handler: () => ({ ok: true, plugin: 'data-analysis', viewer: true, workspaces: workspace.workspaces().length }),
    },
    {
      path: `${basePath}/api/state`,
      method: 'GET',
      handler: (_body, query) => ({ ok: true, state: withReadCache(() => buildState(String(query?.workspaceId || ''))) }),
    },
    {
      path: `${basePath}/api/artifacts/tree`,
      method: 'GET',
      handler: (_body, query) => {
        const wsId = String(query?.workspaceId || '');
        const limit = Number(query?.limit) || 800;
        const result = viewer.artifactTree({ limit }, wsId);
        if (!result.ok && wsId) return viewer.artifactTree({ limit }, '');
        return result;
      },
    },
    {
      path: `${basePath}/api/artifacts/file`,
      method: 'GET',
      handler: (_body, query) => {
        const result = viewer.artifactRead(String(query?.path || ''), { limit: Number(query?.limit) || 200 }, String(query?.workspaceId || ''));
        if (!result.ok) return { status: 404, payload: { ok: false, error: result.error } };
        return result;
      },
    },
    {
      path: `${basePath}/api/artifacts/raw`,
      method: 'GET',
      handler: (_body, query) => {
        const result = viewer.artifactResolve(String(query?.path || ''), String(query?.workspaceId || ''));
        if (!result.ok) {
          const error = new Error(result.error);
          error.status = 404;
          throw error;
        }
        const wantDownload = isTrue(query?.download) || result.ext === '.html';
        // 只有下载才需要中文文件名；内联缩略图/预览不必读 figure_map/manuscript，省掉每张图两次解析
        const dn = wantDownload
          ? viewer.downloadName(result.rel, String(query?.workspaceId || ''))
          : { name: path.basename(result.abs), ascii: '' };
        return {
          __file: result.abs,
          __type: MIME[result.ext] || 'application/octet-stream',
          __download: wantDownload,
          __name: dn.name,
          __ascii: dn.ascii,
        };
      },
    },
    {
      path: `${basePath}/api/workspace`,
      method: 'POST',
      handler: (body) => {
        if (body?.id && !body?.dir) {
          const selected = workspace.select(String(body.id));
          if (!selected.ok) return { status: 404, payload: { ok: false, error: selected.error } };
          return { ok: true, workspace: selected.workspace, state: buildState(selected.workspace.id) };
        }
        const result = workspace.bind({ dir: body?.dir, name: body?.name, sessionId: body?.sessionId });
        if (!result.ok) {
          return { status: 400, payload: { ok: false, code: result.code, error: result.error, text: result.text } };
        }
        return {
          ok: true,
          workspace: result.workspace,
          already: result.already,
          movedFrom: result.movedFrom,
          text: result.text,
          state: buildState(result.workspace.id),
        };
      },
    },
    {
      path: `${basePath}/api/workspace/list`,
      method: 'GET',
      handler: () => ({ ok: true, workspaces: workspace.list() }),
    },
    {
      path: `${basePath}/api/workspace/forget`,
      method: 'POST',
      handler: (body) => {
        const result = workspace.forget(String(body?.id || ''));
        if (!result.ok) return { status: 404, payload: { ok: false, error: result.error } };
        return { ok: true, ...result, state: buildState() };
      },
    },
    {
      path: `${basePath}/api/session/project`,
      method: 'GET',
      handler: (_body, query) => {
        const sessionId = String(query?.sessionId || '').trim();
        if (!sessionId) return { status: 400, payload: { ok: false, error: '缺 sessionId' } };
        const hit = workspace.forSession(sessionId);
        return {
          ok: true,
          sessionId,
          workspace: hit ? { id: hit.id, name: hit.name, root: hit.root } : null,
        };
      },
    },
    {
      path: `${basePath}/api/config`,
      method: 'GET',
      handler: () => ({ ok: true, config: getConfig() }),
    },
    {
      path: `${basePath}/api/config`,
      method: 'POST',
      handler: async (body) => {
        const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body || {};
        if (typeof patch.dataDir !== 'string') {
          return { status: 400, payload: { ok: false, error: '只支持 dataDir' } };
        }
        if (workspace.isInsideWorkspace(patch.dataDir)) {
          return { status: 409, payload: { ok: false, error: '台账目录不能放在工作区内（插件只读研究目录）' } };
        }
        await setDataDir(patch.dataDir);
        return { ok: true, config: getConfig(), state: buildState() };
      },
    },
  ];

  const table = new Map();
  for (const route of routes) {
    const list = table.get(route.path) || [];
    list.push(route);
    table.set(route.path, list);
  }

  const dispose = ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer');
    if (!webServer?.register) {
      logger?.warn?.('[data-analysis] 宿主没有 webServer 服务，面板将无法读取数据');
      return () => {};
    }
    let selfOrigin = null;
    try {
      selfOrigin = webServer.getOrigin?.() ?? null;
    } catch {
      selfOrigin = null;
    }

    return webServer.register({
      kind: 'prefix',
      path: basePath,
      handler: async (req, res) => {
        try {
          const hostHeader = headerValue(req, 'host');
          const remote = String(req.socket?.remoteAddress || '');
          // 远程地址必须是 loopback；Host 只是第二道检查，不能因为 Host 可伪造就跳过远程检查。
          if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) {
            return send(res, 403, { ok: false, error: '仅允许本机访问' });
          }
          if (hostHeader && !hostIsLoopback(hostHeader)) {
            return send(res, 403, { ok: false, error: '仅允许本机访问' });
          }
          if (!originMatches(headerValue(req, 'origin'), allowedOrigins(selfOrigin, hostHeader))) {
            return send(res, 403, { ok: false, error: '跨源请求被拒绝' });
          }
          const url = new URL(req.url || '/', 'http://localhost');
          const candidates = table.get(url.pathname);
          if (!candidates) return send(res, 404, { ok: false, error: `未知接口 ${url.pathname}` });
          const route = candidates.find((item) => item.method === req.method);
          if (!route) {
            res.setHeader?.('allow', candidates.map((item) => item.method).join(', '));
            return send(res, 405, { ok: false, error: `只支持 ${candidates.map((item) => item.method).join(' / ')}` });
          }
          let body = {};
          if (route.method === 'POST') {
            const contentType = String(headerValue(req, 'content-type') || '').trim().toLowerCase();
            if (!/^application\/json(?:\s*;.*)?$/.test(contentType)) {
              return send(res, 415, { ok: false, error: '只接受 application/json' });
            }
            body = await readBody(req);
          }
          const query = Object.fromEntries(url.searchParams.entries());
          const result = await route.handler(body || {}, query);
          if (result && result.__file) {
            return sendFile(res, result.__file, {
              type: result.__type || 'application/octet-stream',
              download: result.__download === true,
              name: result.__name || '',
              ascii: result.__ascii || '',
            });
          }
          if (result && result.status && result.payload) return send(res, result.status, result.payload);
          return send(res, 200, result);
        } catch (error) {
          const message = String(error?.message || error);
          const status = Number(error?.status) || 500;
          if (status >= 500) logger?.error?.(`[data-analysis] 路由处理失败：${message}`, error?.stack || '');
          else logger?.warn?.(`[data-analysis] 路由请求被拒：${message}`);
          return send(res, status, { ok: false, error: message });
        }
      },
    });
  }, 'data-analysis: panel API route');

  return () => {
    try {
      dispose?.();
    } catch {
      /* ignore */
    }
  };
}