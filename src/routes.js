/**
 * 面板数据通道：同源 HTTP 路由（与工具共用 Workbench）。
 *
 * webServer 没有认证层，所以自带两道防护：只接受 loopback Host、带 Origin 时必须同源。
 * 面板是「浏览与操作」的另一个入口，不是第二套规则。
 */

const MAX_BODY = 128 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1']);

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

/** JSON 里的布尔偶尔会被写成字符串；`Boolean('false')` 是 true，破坏性开关不能这么转。 */
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

function headerValue(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function registerRoutes(ctx, workbench, helpers = {}) {
  const { logger, basePath = '/data-analysis', assistant, tasks = [] } = helpers;

  const routes = [
    {
      path: `${basePath}/api/state`,
      method: 'GET',
      handler: () => ({ ok: true, state: workbench.snapshot() }),
    },
    {
      // 原生对话里的徽章轮询它：只回摘要，避免每 8 秒搬一次图表清单。
      path: `${basePath}/api/summary`,
      method: 'GET',
      handler: () => workbench.summary(),
    },
    {
      path: `${basePath}/api/project/create`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.createProject(body?.dir, body?.name);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, project: result.project, root: result.root, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/project/open`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.openProject(body?.dir);
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, project: result.project, root: result.path, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/project/close`,
      method: 'POST',
      handler: () => {
        workbench.closeProject();
        return { ok: true, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/project/forget`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.forgetProject(String(body?.id || ''));
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return {
          ok: true,
          id: result.id,
          name: result.name,
          path: result.path,
          active: result.active,
          cancelled: result.cancelled,
          removed: result.removed,
          // 明确告诉面板「磁盘没动」：这条不改，用户会以为点的是删文件
          diskKept: true,
          state: result.state,
        };
      },
    },
    {
      path: `${basePath}/api/project/session`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.bindSession(String(body?.sessionId || ''));
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, sessionId: result.sessionId, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/task-card`,
      method: 'GET',
      handler: (_body, query) => {
        const result = workbench.taskCard(String(query?.stageId || ''));
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return result;
      },
    },
    {
      path: `${basePath}/api/stage/run`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.runStage(String(body?.stageId || ''), { force: isTrue(body?.force) });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error, blockers: result.blockers || [] } };
        return { ok: true, run: result.run, command: result.command, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/stage/cancel`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.cancelStage(String(body?.stageId || ''));
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error } };
        return { ok: true, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/run/log`,
      method: 'GET',
      handler: (body, query) => {
        const result = workbench.runLog(String(query?.id || ''), Math.min(500, Math.max(10, Number(query?.limit) || 200)));
        if (!result.ok) return { status: 404, payload: { ok: false, error: '找不到这次运行' } };
        return { ok: true, run: result.run, lines: result.lines };
      },
    },
    {
      path: `${basePath}/api/adjudicate`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.adjudicate({
          stageId: String(body?.stageId || ''),
          gateId: String(body?.gateId || ''),
          status: String(body?.status || ''),
          note: body?.note,
        });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, adjudications: result.adjudications, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/config`,
      method: 'POST',
      handler: async (body) => {
        const patch = body?.patch || body || {};
        const result = await workbench.updateConfig(patch);
        return { ok: true, config: result.config, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/preflight`,
      method: 'GET',
      handler: async () => {
        await workbench.ensurePreflight();
        return { ok: true, preflight: workbench.preflightSummary() };
      },
    },
    {
      path: `${basePath}/api/preflight/refresh`,
      method: 'POST',
      handler: async () => {
        await workbench.ensurePreflight({ force: true });
        return { ok: true, preflight: workbench.preflightSummary(), state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/assistant/models`,
      method: 'GET',
      handler: async (_body, query) => {
        if (!assistant) return { ok: false, error: '模型服务不可用' };
        const models = await assistant.models({ force: query?.refresh === '1' });
        return { ok: models.ok !== false, ...models, tasks, config: workbench.snapshot().config };
      },
    },
    {
      path: `${basePath}/api/assistant/draft`,
      method: 'POST',
      handler: async (body) => {
        if (!assistant) return { ok: false, error: '模型服务不可用' };
        const result = await assistant.draft({ taskId: body.taskId, instruction: body.instruction });
        return result;
      },
    },
    {
      path: `${basePath}/api/assistant/save`,
      method: 'POST',
      handler: async (body) => {
        if (!assistant) return { ok: false, error: '模型服务不可用' };
        const result = assistant.save({ taskId: body.taskId, text: body.text });
        if (result.ok) result.state = workbench.snapshot();
        return result;
      },
    },
    {
      path: `${basePath}/api/recheck`,
      method: 'GET',
      handler: () => workbench.recheckState(),
    },
    {
      // 模型审计用的证据包：只读、受控截断，不搬整份语料
      path: `${basePath}/api/recheck/evidence`,
      method: 'GET',
      handler: () => workbench.recheckEvidence(),
    },
    {
      path: `${basePath}/api/recheck/issue`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.updateIssue({
          id: String(body?.id || ''),
          status: String(body?.status || ''),
          note: body?.note,
        });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, issue: result.issue, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/recheck/apply`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.applyIssue(String(body?.id || ''), { advance: body?.advance !== false });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error } };
        return { ok: true, ...result, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/recheck/cancel-chain`,
      method: 'POST',
      handler: () => {
        const result = workbench.cancelChain();
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error } };
        return { ok: true, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials`,
      method: 'GET',
      handler: () => {
        const state = workbench.mountsStateSafe();
        return {
          ok: true,
          sources: workbench.sources(),
          platform: process.platform,
          isWindows: process.platform === 'win32',
          ...state,
          vision: workbench.visionStatus(),
        };
      },
    },
    {
      path: `${basePath}/api/materials/card`,
      method: 'GET',
      handler: () => {
        // 面板「让 AI 处理这些材料」拿这张卡再投进研究对话；解析由会话决定
        const result = workbench.materialsCard();
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return result;
      },
    },
    {
      path: `${basePath}/api/materials/add`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.addSource({ label: body?.label, path: body?.path, note: body?.note });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, source: result.source, sources: result.sources, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/scan`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.rescanSource(String(body?.id || ''));
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, source: result.source, sources: workbench.sources(), state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/remove`,
      method: 'POST',
      handler: (body) => {
        const result = workbench.removeSource(String(body?.id || ''), { force: isTrue(body?.force) });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error, usedBy: result.usedBy || [] } };
        return { ok: true, sources: result.sources, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/mount`,
      method: 'POST',
      handler: async (body) => {
        const entries = Array.isArray(body?.entries)
          ? body.entries
          : String(body?.entries || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
        const result = await workbench.mountSource({ sourceId: String(body?.sourceId || ''), entries, as: body?.as });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, mounts: result.mounts, note: result.note, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/unmount`,
      method: 'POST',
      handler: async (body) => {
        const result = await workbench.unmountSource({ as: String(body?.as || '') });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, removed: result.removed, note: result.note, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/repair`,
      method: 'POST',
      handler: async () => {
        const result = await workbench.repairMounts();
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, fixed: result.fixed, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/migrate`,
      method: 'POST',
      handler: async (body) => {
        const entries = Array.isArray(body?.entries)
          ? body.entries
          : String(body?.entries || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
        const result = await workbench.migrateSource({ sourceId: String(body?.sourceId || ''), entries, as: body?.as || '', apply: isTrue(body?.apply) });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error, report: result.report || [] } };
        return { ok: true, ...result, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/materials/vision`,
      method: 'GET',
      handler: () => { const status = workbench.visionStatus(); const plan = workbench.visionPlan(); return { ok: plan.ok !== false, ...status, plan, ...(plan.ok === false ? { error: plan.error } : {}) }; },
    },
    {
      path: `${basePath}/api/materials/vision/run`,
      method: 'POST',
      handler: async (body) => {
        const result = await workbench.startVision({
          limit: Number(body?.limit) || 40,
          pages: String(body?.pages || ''),
          wait: isTrue(body?.wait),
        });
        if (!result.ok) return { status: 409, payload: { ok: false, error: result.error, plan: result.plan || null } };
        return result;
      },
    },
    {
      path: `${basePath}/api/materials/vision/cancel`,
      method: 'POST',
      handler: () => {
        const result = workbench.cancelVision();
        if (!result.ok) return { status: 409, payload: result };
        return result;
      },
    },
    {
      path: `${basePath}/api/materials/vision/verify`,
      method: 'POST',
      handler: (body) => {
        const relPaths = Array.isArray(body?.relPaths)
          ? body.relPaths
          : String(body?.relPaths || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
        const result = workbench.verifyVision({ relPaths, all: isTrue(body?.all) });
        if (!result.ok) return { status: 400, payload: { ok: false, error: result.error } };
        return { ok: true, ...result, state: workbench.snapshot() };
      },
    },
    {
      path: `${basePath}/api/health`,
      method: 'GET',
      handler: () => ({ ok: true, version: '0.1.0', skill: workbench.skill().ok }),
    },
  ];

  const table = new Map(routes.map((route) => [route.path, route]));

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
          const remoteLoopback = /^(::1|::ffff:127\.|127\.)/.test(remote) || remote === '';
          // 缺少 Host 时不能直接放行（那是 fail-open）：有 Host 就按 Host 判，没有 Host 就必须
          // 来自 loopback 套接字，两道门不能同时失效。
          if (hostHeader ? !hostIsLoopback(hostHeader) : !remoteLoopback) {
            return send(res, 403, { ok: false, error: '仅允许本机访问' });
          }
          if (!originMatches(headerValue(req, 'origin'), allowedOrigins(selfOrigin, hostHeader))) {
            return send(res, 403, { ok: false, error: '跨源请求被拒绝' });
          }
          const url = new URL(req.url || '/', 'http://localhost');
          const route = table.get(url.pathname);
          if (!route) return send(res, 404, { ok: false, error: `未知接口 ${url.pathname}` });
          if (req.method !== route.method) {
            res.setHeader?.('allow', route.method);
            return send(res, 405, { ok: false, error: `只支持 ${route.method}` });
          }
          let body = {};
          if (route.method === 'POST') {
            const contentType = String(headerValue(req, 'content-type') || '').toLowerCase();
            if (!contentType.includes('application/json')) {
              return send(res, 415, { ok: false, error: '只接受 application/json' });
            }
            body = await readBody(req);
          }
          const query = Object.fromEntries(url.searchParams.entries());
          const result = await route.handler(body || {}, query);
          if (result && result.status && result.payload) return send(res, result.status, result.payload);
          return send(res, 200, result);
        } catch (error) {
          const message = String(error?.message || error);
          // 只有 readBody 会带 status（400/413）；其余都是内部异常，必须按 500 报并且留日志，
          // 否则前端看到「400 参数错」、宿主日志里一行没有。
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