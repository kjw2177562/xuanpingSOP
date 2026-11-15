/**
 * Autoloop 工作台 — 本机服务
 *
 * 安全边界：
 *   - 只监听 127.0.0.1（不监听 0.0.0.0），并二次校验远端地址与 Host 头。
 *   - 只提供白名单静态文件与两个本地 API，无 CORS、无外部资源、无 outbound 请求。
 *   - 动作接口只允许 pause / resume / run，且规则名必须出现在 CLI 自己的 status 输出里。
 *   - 所有命令通过 spawn 的参数数组传递，不拼 shell 字符串。
 *
 * 数据来源：agent-autoloop status --json（前端每 30 秒取一次）
 *           agent-autoloop runs --json（同一刷新里补取最近 20 轮结论）
 */
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const mcp = require('./mcp-client');
const { buildInsights } = require('./insights');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const HOME = os.homedir();
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.AUTOLOOP_WORKBENCH_PORT || 8765);

/* ---------------------------------- CLI ---------------------------------- */

const DEFAULT_TS = path.join(HOME, '.agent-autoloop', 'app', 'bin', 'agent-autoloop.ts');

function resolveCli() {
  if (process.env.AUTOLOOP_CLI) {
    const p = process.env.AUTOLOOP_CLI;
    return p.endsWith('.ts')
      ? { mode: 'node', file: p, label: 'AUTOLOOP_CLI' }
      : { mode: 'bin', file: p, label: 'AUTOLOOP_CLI' };
  }
  if (existsSync(DEFAULT_TS)) {
    // 直接跑 CLI 的 TS 入口，等价于官方 .cmd shim，且绕开 Windows cmd/PATH 差异。
    return {
      mode: 'node',
      file: DEFAULT_TS,
      label: path.join('.agent-autoloop', 'app', 'bin', 'agent-autoloop.ts'),
    };
  }
  return {
    mode: 'bin',
    file: process.platform === 'win32' ? 'agent-autoloop.cmd' : 'agent-autoloop',
    label: 'agent-autoloop (PATH)',
  };
}

const CLI = resolveCli();

/** 调一次 CLI。返回 { ok, code, stdout, stderr, command }，永不抛错。 */
function invoke(args, timeout = 20000) {
  const command = `agent-autoloop ${args.join(' ')}`;
  return new Promise((resolve) => {
    const file = CLI.mode === 'node' ? process.execPath : CLI.file;
    const argv =
      CLI.mode === 'node'
        ? ['--disable-warning=ExperimentalWarning', CLI.file, ...args]
        : args;
    const opts = {
      cwd: HOME,
      env: process.env,
      windowsHide: true,
      // .cmd shim 在 Windows 上需要 shell 才能启动；node 模式完全不走 shell。
      shell: CLI.mode === 'bin' && process.platform === 'win32',
    };

    let child;
    try {
      child = spawn(file, argv, opts);
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: String(err.message || err), command });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n命令超时（${timeout / 1000}s）`.trim(), command });
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) =>
      finish({ ok: false, code: null, stdout, stderr: String(err.message || err), command }));
    child.on('close', (code) =>
      finish({ ok: code === 0, code, stdout, stderr, command }));
  });
}

/** CLI 有时会带日志行，截取最外层 JSON 对象。 */
function parseJsonLoose(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('CLI 没有返回 JSON');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`);
  }
}

let lastStatus = null;

async function snapshot() {
  const [state, history] = await Promise.all([
    invoke(['status', '--json']),
    invoke(['runs', '--json']),
  ]);
  const out = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    status: null,
    finishedRuns: [],
    errors: {},
    cli: CLI.label,
    commands: [state.command, history.command],
  };

  try {
    if (!state.ok) throw new Error((state.stderr || `退出码 ${state.code}`).trim().slice(0, 400));
    out.status = parseJsonLoose(state.stdout);
    lastStatus = out.status;
  } catch (err) {
    out.ok = false;
    out.errors.status = err.message;
  }

  try {
    if (!history.ok) throw new Error((history.stderr || `退出码 ${history.code}`).trim().slice(0, 400));
    const parsed = parseJsonLoose(history.stdout);
    out.finishedRuns = Array.isArray(parsed.runs) ? parsed.runs.slice(0, 20) : [];
  } catch (err) {
    out.errors.runs = err.message;
  }

  return out;
}

/* ---------------------------- 多宝鱼 MCP 数据 ---------------------------- */
// 店铺数据变化慢，缓存 5 分钟，别跟着页面 30 秒轮询去消耗 MCP 配额。
const DBY_TTL = 5 * 60 * 1000;
const DBY_RANGES = new Map(); // hours -> { cache, cacheAt, pending }

// 全部是只读工具；密钥与端点只留在服务端，不出现在页面里。
function dbyTools(hours) {
  return [
    ['stores', 'meta_list_stores', {}],
    ['orders', 'orders_get_recent', { hours }],
    ['stockout', 'restock_get_stockout_alerts', { top: 5 }],
    ['usage', 'meta_get_usage', {}],
  ];
}

async function dbySnapshot(hours) {
  const pairs = await Promise.all(dbyTools(hours).map(async ([key, tool, args]) => {
    try {
      return [key, { ok: true, data: await mcp.callTool(tool, args) }];
    } catch (err) {
      return [key, { ok: false, error: String(err.message || err) }];
    }
  }));
  return {
    ok: pairs.every(([, value]) => value.ok),
    hours,
    fetchedAt: new Date().toISOString(),
    data: Object.fromEntries(pairs),
    target: mcp.endpointInfo(),
    tools: dbyTools(hours).map(([, tool]) => tool),
  };
}

async function duobaoyu(force = false, hours = 24) {
  if (![24, 168, 720].includes(hours)) hours = 24;
  let slot = DBY_RANGES.get(hours);
  if (!slot) { slot = { cache: null, cacheAt: 0, pending: null }; DBY_RANGES.set(hours, slot); }
  if (!force && slot.cache && Date.now() - slot.cacheAt < DBY_TTL) {
    return { ...slot.cache, cached: true, ageMs: Date.now() - slot.cacheAt };
  }
  if (slot.pending) return slot.pending;
  slot.pending = dbySnapshot(hours)
    .then((result) => {
      if (result.ok) { slot.cache = result; slot.cacheAt = Date.now(); }
      return result;
    })
    .catch((err) => ({
      ok: false, hours, fetchedAt: new Date().toISOString(), data: {},
      error: String(err.message || err), target: mcp.endpointInfo(),
    }))
    .finally(() => { slot.pending = null; });
  return slot.pending;
}

/* ---------------------- 多宝鱼洞察（广告/店铺/产品） ---------------------- */
// 广告报表与推荐按天更新，余额/反馈变化也不快：缓存 10 分钟。
const INS_TTL = 10 * 60 * 1000;
let insCache = null;
let insCacheAt = 0;
let insPending = null;

async function insights(force = false) {
  if (!force && insCache && Date.now() - insCacheAt < INS_TTL) {
    return { ...insCache, cached: true, ageMs: Date.now() - insCacheAt };
  }
  if (insPending) return insPending;
  insPending = buildInsights()
    .then((result) => {
      // 部分失败也缓存：免得 30 秒轮询反复打 MCP；ok 标志会如实显示哪些分区失败
      insCache = result;
      insCacheAt = Date.now();
      lastAdsScope = result.profile?.id || lastAdsScope;
      return result;
    })
    .catch((err) => ({
      ok: false, fetchedAt: new Date().toISOString(), data: {},
      error: String(err.message || err), target: mcp.endpointInfo(),
    }))
    .finally(() => { insPending = null; });
  return insPending;
}

let lastAdsScope = null;

/* ---------------------- 广告操作（同步 / 标记 / 写入） ---------------------- */
// 写入走三步：prepare（不写）→ 页面确认 → execute；只允许 sp_update_campaign 的
// 预算与启停，且 campaignId 必须出现在本工作台已缓存的广告活动清单里。

const PREPARED_PLANS = new Map(); // plan_id -> { at, count }

function mcpResult(data) {
  if (data && data.error != null) {
    const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    const hint = data.hint ? `（${data.hint}）` : '';
    return { ok: false, error: `${detail}${hint}` };
  }
  return { ok: true, data };
}

async function currentAdsScope() {
  if (lastAdsScope) return lastAdsScope;
  const conn = await mcp.callTool('ads_get_connection_status', {}, 60000);
  const profiles = (conn && conn.profiles) || [];
  const enabled = profiles.filter((p) => p.enabled);
  const picked = enabled.find((p) => p.marketplace === 'US') || enabled[0];
  if (!picked) throw new Error('没有已启用的广告 profile');
  lastAdsScope = picked.id;
  return lastAdsScope;
}

function knownCampaignIds() {
  const items = (insCache?.data?.campaigns?.data?.items) || [];
  return new Set(items.map((c) => String(c.campaignId)));
}

function buildChange(change) {
  if (!change || typeof change !== 'object') return { error: '变更项不是对象' };
  const campaignId = String(change.campaignId || '');
  if (!/^\d{5,25}$/.test(campaignId)) return { error: 'campaignId 不合法' };
  const known = knownCampaignIds();
  if (!known.size) return { error: '广告活动清单还没准备好，请先刷新洞察数据' };
  if (!known.has(campaignId)) {
    return { error: `活动 ${campaignId} 不在当前广告活动清单中，请刷新后再试` };
  }
  const payload = { campaignId };
  let touched = 0;
  if (change.state !== undefined) {
    if (change.state !== 'ENABLED' && change.state !== 'PAUSED') return { error: 'state 只允许 ENABLED / PAUSED' };
    payload.state = change.state;
    touched++;
  }
  if (change.budget !== undefined) {
    const budget = Number(change.budget);
    if (!Number.isFinite(budget) || budget < 0.5 || budget > 10000) {
      return { error: '预算需在 $0.5 - $10000 之间' };
    }
    payload.budget = { budget, budgetType: 'DAILY' };
    touched++;
  }
  if (!touched) return { error: '变更项缺少 state 或 budget' };
  return { change: { kind: 'sp_update_campaign', payload } };
}

async function adsAction(body) {
  const op = body?.op;
  try {
    if (op === 'sync') {
      const rawDays = body.days === undefined || body.days === null ? 30 : Number(body.days);
      if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 95) return { ok: false, error: 'days 需在 1-95 之间' };
      const days = rawDays;
      const scope = await currentAdsScope();
      const r = mcpResult(await mcp.callTool('ads_start_sync', { store_scope: scope, days }, 90000));
      insCache = null; // 数据要重新拉
      return r.ok
        ? { ok: true, action: 'sync', message: '已在后台开始拉取广告报表，几分钟后刷新洞察查看', data: r.data }
        : r;
    }

    if (op === 'mark') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 20) : [];
      const status = body.status === 'ignored' ? 'ignored' : body.status === 'done' ? 'done' : null;
      if (!status) return { ok: false, error: 'status 只允许 done / ignored' };
      if (!ids.length || ids.some((i) => typeof i !== 'string' || !/^[\w-]{5,64}$/.test(i))) {
        return { ok: false, error: 'ids 不合法' };
      }
      const scope = await currentAdsScope();
      const results = await Promise.all(ids.map(async (id) => {
        const r = mcpResult(await mcp.callTool('ads_mark_recommendation', { store_scope: scope, recommendation_id: id, handled_status: status }, 60000));
        return [id, r.ok ? 'ok' : (r.error || '失败')];
      }));
      const failed = results.filter(([, v]) => v !== 'ok');
      insCache = null;
      return { ok: failed.length === 0, action: 'mark', status, results, error: failed.length ? failed.map(([i, e]) => `${i}: ${e}`).join('；') : null };
    }

    if (op === 'prepare') {
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, 10) : [];
      if (!changes.length) return { ok: false, error: '没有可执行的变更' };
      const built = [];
      for (const c of changes) {
        const r = buildChange(c);
        if (r.error) return { ok: false, error: r.error };
        built.push(r.change);
      }
      const scope = await currentAdsScope();
      const raw = await mcp.callTool('ads_prepare_changes', { store_scope: scope, changes_json: JSON.stringify(built) }, 90000);
      const r = mcpResult(raw);
      if (!r.ok) return r;
      PREPARED_PLANS.set(r.data.plan_id, { at: Date.now(), count: r.data.count || built.length });
      for (const [id, meta] of PREPARED_PLANS) {
        if (Date.now() - meta.at > 35 * 60 * 1000) PREPARED_PLANS.delete(id);
      }
      return { ok: true, action: 'prepare', plan: r.data };
    }

    if (op === 'apply') {
      const planId = String(body?.plan_id || '');
      if (!PREPARED_PLANS.has(planId)) {
        return { ok: false, error: '该计划不是本工作台生成的或已过期（30 分钟），请重新预览' };
      }
      const scope = await currentAdsScope();
      const raw = await mcp.callTool('ads_execute_changes', {
        store_scope: scope, plan_id: planId, confirm: 'CONFIRM AMAZON WRITE',
      }, 150000);
      const r = mcpResult(raw);
      PREPARED_PLANS.delete(planId);
      insCache = null;
      return r.ok ? { ok: true, action: 'apply', result: r.data } : r;
    }

    return { ok: false, error: '不支持的操作' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

const ACTIONS = new Set(['pause', 'resume', 'run']);

function ruleNames(status) {
  const lines = (status && Array.isArray(status.lines)) ? status.lines : [];
  return new Set(lines.map((l) => String(l.name ?? l.id ?? '')).filter(Boolean));
}

async function act(action, rule) {
  if (!ACTIONS.has(action)) return { ok: false, error: '不支持的动作' };
  if (typeof rule !== 'string' || !rule.trim() || rule.length > 200) {
    return { ok: false, error: '规则名不合法' };
  }

  let allowed = ruleNames(lastStatus);
  if (!allowed.has(rule)) {
    // 规则可能刚新增，重新读一次 CLI 状态再校验（白名单始终来自 CLI 自身）。
    const fresh = await invoke(['status', '--json']);
    if (fresh.ok) {
      try { lastStatus = parseJsonLoose(fresh.stdout); } catch (_) { /* keep old */ }
      allowed = ruleNames(lastStatus);
    }
  }
  if (!allowed.has(rule)) {
    return { ok: false, error: `规则「${rule}」不在当前状态中，请刷新后再试` };
  }

  const result = await invoke([action, rule], 25000);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return {
    ok: result.ok,
    action,
    rule,
    command: result.command,
    code: result.code,
    output: output || (result.ok ? '（命令已执行，没有输出）' : '（命令执行失败，没有输出）'),
  };
}

/* --------------------------------- HTTP ---------------------------------- */

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // 不设 frame-ancestors：内置预览面板用 iframe 嵌入本机页面，DENY 会导致白屏。
  // 服务只监听 loopback 且校验 Host / 远端地址，页面仍不会被外部站点访问。
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

function isLocal(req) {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (addr !== HOST && addr !== '::1' && addr !== '0:0:0:0:0:0:0:1') return false;
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  const reqUrl = new URL(req.url, `http://${HOST}`);
  const pathname = reqUrl.pathname;
  if (!isLocal(req)) {
    console.warn(`[拒绝] ${req.method} ${req.socket.remoteAddress} Host=${req.headers.host || '-'} ${pathname}`);
    return send(res, 403, JSON.stringify({ error: '仅限本机访问' }));
  }
  if (pathname.startsWith('/api/')) {
    console.log(`[api] ${req.method} ${req.socket.remoteAddress} Host=${req.headers.host || '-'} ${pathname}`);
  }

  try {
    // 预览面板 / 健康检查常用 HEAD 探活，之前只认 GET 会误判成 404「没在监听」。
    if (req.method === 'HEAD') {
      if (STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        const content = await readFile(path.join(PUBLIC, file));
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': content.length });
        return res.end();
      }
      if (pathname === '/api/status' || pathname === '/api/duobaoyu' || pathname === '/api/insights') {
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
        return res.end();
      }
      res.writeHead(404, BASE_HEADERS);
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, JSON.stringify(await snapshot()));
    }

    if (req.method === 'GET' && pathname === '/api/duobaoyu') {
      const force = reqUrl.searchParams.get('force') === '1';
      const hours = Number(reqUrl.searchParams.get('hours')) || 24;
      return send(res, 200, JSON.stringify(await duobaoyu(force, hours)));
    }

    if (req.method === 'GET' && pathname === '/api/insights') {
      const force = reqUrl.searchParams.get('force') === '1';
      return send(res, 200, JSON.stringify(await insights(force)));
    }

    if (req.method === 'POST' && pathname === '/api/ads-action') {
      const body = await readBody(req);
      return send(res, 200, JSON.stringify(await adsAction(body)));
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readBody(req);
      return send(res, 200, JSON.stringify(await act(body.action, body.rule)));
    }

    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      const content = await readFile(path.join(PUBLIC, file));
      return send(res, 200, content, type);
    }

    return send(res, 404, JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    return send(res, 500, JSON.stringify({ error: String(err.message || err) }));
  }
};

/**
 * IPv4 与 IPv6 两个回环地址都监听。
 * 浏览器 / 预览面板把 localhost 解析成 ::1 时，只听 127.0.0.1 会连不上；
 * 两个地址都不对外，仍然只在本机。
 */
function start(port) {
  const v4 = http.createServer(handler);
  v4.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < START_PORT + 20) {
      setTimeout(() => start(port + 1), 80);
    } else {
      console.error('IPv4 监听失败：', err.message);
      process.exitCode = 1;
    }
  });
  v4.listen(port, '127.0.0.1', () => {
    const v6 = http.createServer(handler);
    v6.on('error', (err) => {
      if (!v6.listening) console.log(`IPv6 回环不可用（${err.code}），仅 IPv4`);
    });
    v6.listen(port, '::1');
    setTimeout(() => {
      console.log(`READY http://127.0.0.1:${port}/`);
      console.log(`READY http://localhost:${port}/  (IPv6 ${v6.listening ? '已监听' : '不可用'})`);
      console.log(`CLI   ${CLI.file} [${CLI.mode}]`);
    }, 60);
  });
}

start(START_PORT);
