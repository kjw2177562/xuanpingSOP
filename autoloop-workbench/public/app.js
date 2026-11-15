/* Autoloop 工作台 — 前端
 * 每 30 秒向本机服务取一次快照；服务每次都会真的执行 CLI。
 */
'use strict';

const REFRESH_MS = 30000;
const $ = (id) => document.getElementById(id);

let latest = null;
let nextRefreshAt = Date.now() + REFRESH_MS;
let loading = false;
let outputs = new Map(); // rule -> { text, ok } 命令回显

/* ------------------------------- 小工具 -------------------------------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v) => Number(v || 0);
const fmtNum = (v) => num(v).toLocaleString('zh-CN');

function fmtCompact(v) {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function parseTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function fmtClock(iso) {
  const d = parseTime(iso);
  if (!d) return '—';
  const t = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${t}`;
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${t}`;
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${t}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

function fmtOnlyTime(iso) {
  const d = parseTime(iso);
  return d ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
}

function fmtDuration(ms, { future = false } = {}) {
  const s = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  if (s < 60) return future ? `${s} 秒后` : `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return future ? `${m} 分钟后` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return future ? `${h} 小时 ${m % 60} 分后` : `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return future ? `${d} 天 ${h % 24} 小时后` : `${d} 天 ${h % 24} 小时`;
}

function fmtAgo(iso) {
  const d = parseTime(iso);
  return d ? fmtDuration(Date.now() - d.getTime()) : '—';
}

function fmtUntil(iso) {
  const d = parseTime(iso);
  if (!d) return '';
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return '时间已到';
  return fmtDuration(diff, { future: true });
}

function stateLabel(s) {
  return ({ claimed: '运行中', running: '运行中', queued: '排队中', retrying: '等待重试',
    done: '完成', nothing: '无需处理', failed: '失败', unknown: '状态未知', stopping: '停止中' })[s] || s || '—';
}
function stateClass(s) {
  if (s === 'claimed' || s === 'running' || s === 'done' || s === 'nothing') return s === 'claimed' || s === 'running' ? 'running' : 'done';
  if (s === 'retrying') return 'retry';
  if (s === 'failed') return 'failed';
  if (s === 'queued') return 'queued';
  return '';
}

function empty(text, big) {
  return `<div class="empty-state">${big ? `<span class="big">${esc(big)}</span>` : ''}${esc(text)}</div>`;
}

function toast(ok, title, body) {
  const el = document.createElement('div');
  el.className = `toast ${ok ? 'ok' : 'err'}`;
  el.innerHTML = `<div class="toast-title">${esc(title)}</div>${body ? `<div class="toast-body">${esc(body)}</div>` : ''}`;
  $('toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

/* ------------------------------- 取数据 -------------------------------- */
async function refresh(manual = false) {
  if (loading) return;
  loading = true;
  const btn = $('refresh-btn');
  btn.disabled = true;
  btn.querySelector('svg').classList.add('spin-btn');
  nextRefreshAt = Date.now() + REFRESH_MS;
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latest = data;
    render(data);
    if (manual) toast(true, '已刷新', `读取时间 ${fmtOnlyTime(data.fetchedAt)}`);
  } catch (err) {
    $('conn-dot').className = 'dot bad';
    $('conn-text').textContent = '本机服务未响应';
    const b = $('banner');
    b.hidden = false;
    b.textContent = `读取本机服务失败：${err.message}。请确认工作台服务仍在运行。`;
  } finally {
    loading = false;
    btn.disabled = false;
    btn.querySelector('svg').classList.remove('spin-btn');
    $('last-update').textContent = `上次 ${fmtOnlyTime(new Date().toISOString())}`;
  }
}

function render(data) {
  const s = data.status;
  const problems = [];
  if (!s) problems.push(`status --json 读取失败：${data.errors?.status || '未知错误'}`);
  if (data.errors?.runs) problems.push(`runs --json 读取失败：${data.errors.runs}`);

  const banner = $('banner');
  banner.hidden = problems.length === 0;
  banner.textContent = problems.join('　|　');

  $('conn-dot').className = `dot ${!s ? 'bad' : problems.length ? 'warn' : 'ok'}`;
  $('conn-text').textContent = !s ? 'CLI 未连接' : problems.length ? '部分数据不可用' : '已连接 CLI';
  $('overview-note').textContent = s
    ? `状态序号 #${esc(s.seq)} · 时区 ${esc(s.timezone || '本机')}`
    : '—';

  if (!s) {
    ['kpi-rounds', 'kpi-tokens', 'kpi-cards', 'kpi-running'].forEach((id) => { $(id).textContent = '—'; });
    $('cards-grid').innerHTML = empty('暂时读不到状态，稍后会自动重试。');
    $('running-list').innerHTML = '';
    renderHistory(data.finishedRuns || []);
    renderRules([]);
    return;
  }

  renderOverview(s);
  renderCards(s);
  renderRunning(s);
  renderHistory(data.finishedRuns || []);
  renderRules(s);

  $('now-note').textContent = `${(s.cards || []).length} 张待处理 · ${(s.runs || []).length} 轮未结束 · ${(data.finishedRuns || []).length} 轮已归档`;
  $('rules-note').textContent = `${(s.lines || []).length} 条本机规则${(s.elsewhere || []).length ? ` · ${s.elsewhere.length} 条别处规则` : ''}`;
}

/* --------------------------------- 上 ---------------------------------- */
function renderOverview(s) {
  const today = s.spending?.today || {};
  const week = s.spending?.week || {};
  const totals = s.totals || {};
  const cards = s.cards || [];

  const rounds = Math.max(num(today.rounds), num(totals.doneToday));
  $('kpi-rounds').textContent = fmtNum(rounds);
  $('kpi-rounds-sub').textContent = `本周 ${fmtNum(week.rounds)} 轮 · 已完成 ${fmtNum(totals.doneToday)} 轮`;

  $('kpi-tokens').innerHTML = `${esc(fmtCompact(today.tokens))}<span class="unit">tokens</span>`;
  const cost = num(today.cost);
  $('kpi-tokens-sub').textContent =
    `精确 ${fmtNum(today.tokens)} · 缓存 ${fmtCompact(today.cached)} · 花费 $${cost.toFixed(2)}`;

  $('kpi-cards').textContent = fmtNum(cards.length);
  const oldest = cards.map((c) => parseTime(c.createdAt)?.getTime()).filter(Boolean).sort((a, b) => a - b)[0];
  $('kpi-cards-sub').textContent = cards.length
    ? `最久等了 ${oldest ? fmtDuration(Date.now() - oldest) : '—'}`
    : '没有需要你拍板的事';

  $('kpi-running').textContent = fmtNum(totals.running);
  $('kpi-running-sub').textContent = `排队 ${fmtNum(totals.queued)} · 重试 ${fmtNum(totals.retrying)} · 无结果 ${fmtNum(totals.nothing)}`;

  const agents = s.agents || [];
  const channels = s.channels || [];
  const onlineAgents = agents.filter((a) => a.online).length;
  const onlineChannels = channels.filter((c) => c.online).length;
  $('online-summary').textContent =
    `Agent ${onlineAgents}/${agents.length} 在线 · 机器人/通道 ${onlineChannels}/${channels.length} 在线`;

  $('agents-list').innerHTML = agents.length ? agents.map((a) => `
    <div class="chip ${a.online ? '' : 'off'}">
      <span class="dot ${a.online ? 'ok' : 'bad'}"></span>
      <span class="chip-name">${esc(a.name || a.id)}</span>
      <span class="chip-meta">${a.worker ? esc(a.worker) + ' · ' : ''}最后心跳 ${esc(fmtAgo(a.seenAt))}前</span>
    </div>`).join('') : '<div class="empty-inline">没有配置 Agent</div>';

  $('channels-list').innerHTML = channels.length ? channels.map((c) => `
    <div class="chip ${c.online ? '' : 'off'}">
      <span class="dot ${c.online ? 'ok' : 'bad'}"></span>
      <span class="chip-name">${esc(c.name || c.id)}</span>
      <span class="chip-meta">最后心跳 ${esc(fmtAgo(c.seenAt))}前</span>
    </div>`).join('') : '<div class="empty-inline">没有配置通道</div>';
}

/* ---------------------------- 中：等人点 ------------------------------- */
function cardSender(card, s) {
  if (card.by) {
    const ag = (s.agents || []).find((a) => a.id === card.by || a.name === card.by);
    return ag ? (ag.name || ag.id) : String(card.by);
  }
  const line = (s.lines || []).find((l) => l.name === card.rule || l.id === card.rule);
  if (line?.agent) {
    const ag = (s.agents || []).find((a) => a.id === line.agent);
    if (ag) return ag.name || ag.id;
    return String(line.agent);
  }
  return '中台';
}

function renderCards(s) {
  const cards = (s.cards || []).filter((c) => c.state !== 'closed');
  $('cards-count').textContent = String(cards.length);
  $('cards-count').className = `count-badge ${cards.length ? 'alert' : ''}`;
  if (!cards.length) {
    $('cards-grid').innerHTML = empty('没有等你拍板的卡片，Agent 自己往下跑。', '都处理完了');
    return;
  }
  $('cards-grid').innerHTML = cards.map((c) => {
    const ageMs = Date.now() - (parseTime(c.createdAt)?.getTime() || Date.now());
    const urgent = ageMs >= 4 * 3600 * 1000;
    const sender = cardSender(c, s);
    const options = (c.options || []).length
      ? `<div class="option-chips">${c.options.map((o) => `<span class="option-chip">${esc(o)}</span>`).join('')}</div>` : '';
    return `
      <article class="wait-card ${urgent ? 'urgent' : ''}">
        <div class="wait-from" title="来自 ${esc(sender)}">来自 ${esc(sender)}</div>
        <div class="wait-title">${esc(c.title || `卡片 #${c.id}`)}</div>
        <div class="wait-text">${esc(c.text || '(没有正文)')}</div>
        ${options}
        <div class="wait-meta">
          <span class="wait-age">已等 ${esc(fmtDuration(ageMs))}</span>
          <span>#${esc(c.id)}</span>
          <span>${c.rule ? `规则 ${esc(c.rule)}` : esc(c.kind || '通知')}</span>
          <span>${esc(fmtClock(c.createdAt))}</span>
        </div>
      </article>`;
  }).join('');
}

/* ---------------------------- 中：正在跑 ------------------------------- */
function renderRunning(s) {
  const runs = (s.runs || []).filter((r) => r.state !== 'done');
  $('running-count').textContent = String(runs.length);
  if (!runs.length) {
    $('running-list').innerHTML = empty('现在没有在跑或排队的轮次。', '空闲中');
    return;
  }
  $('running-list').innerHTML = runs.map((r) => {
    const retrying = r.attempts > 1 || (r.notBefore && parseTime(r.notBefore)?.getTime() > Date.now());
    const state = retrying && r.state === 'queued' ? 'retrying' : r.state;
    const line = r.error || r.summary || '还没留下结果';
    const bits = [];
    bits.push(`<span>第 ${esc(r.attempts || 1)} 次尝试</span>`);
    if (r.agent) bits.push(`<span>${esc(r.agent)}</span>`);
    if (r.notBefore && retrying) bits.push(`<span class="warn">下次重试 ${esc(fmtClock(r.notBefore))}（${esc(fmtUntil(r.notBefore))}）</span>`);
    if (r.stopping) bits.push('<span class="warn">正在停止</span>');
    if (r.manual) bits.push('<span>手动触发</span>');
    return `
      <div class="run-item">
        <div class="run-top">
          <span class="run-id">#${esc(r.id)}</span>
          <span class="run-rule">${esc(r.rule || '未命名规则')}</span>
          <span class="run-state ${esc(stateClass(state))}">${esc(stateLabel(state))}</span>
          <span class="run-time">${esc(fmtAgo(r.createdAt))}前建</span>
        </div>
        <div class="run-line ${r.error ? '' : 'dim'}">${esc(line)}</div>
        <div class="run-sub">${bits.join('')}</div>
      </div>`;
  }).join('');
}

/* -------------------------- 中：最近 20 轮 ----------------------------- */
function renderHistory(runs) {
  $('history-count').textContent = String(runs.length);
  if (!runs.length) {
    $('history-list').innerHTML = empty('跑完一轮后，这里会出现一句结论。', '还没有做完的轮次');
    return;
  }
  $('history-list').innerHTML = runs.slice(0, 20).map((r) => {
    const failed = !!r.error;
    const line = r.summary || r.error || '（这一轮没留下结论）';
    const state = failed ? 'failed' : (r.state || 'done');
    return `
      <div class="run-item">
        <div class="run-top">
          <span class="run-id">#${esc(r.id)}</span>
          <span class="run-rule">${esc(r.rule || '未命名规则')}</span>
          <span class="run-state ${esc(stateClass(state))}">${esc(stateLabel(state))}</span>
          <span class="run-time">${esc(fmtClock(r.finishedAt))}</span>
        </div>
        <div class="run-line" title="${esc(line)}">${esc(line)}</div>
      </div>`;
  }).join('');
}

/* ---------------------------- 下：规则区 ------------------------------- */
function isPaused(line, s) {
  if (line.paused) return true;
  return (s.pauses || []).some((p) =>
    (typeof p === 'string' ? p : (p?.rule || p?.name || p?.id)) === (line.name || line.id));
}

function nextText(line) {
  if (line.next) {
    const until = fmtUntil(line.next);
    const overdue = parseTime(line.next)?.getTime() <= Date.now();
    return { html: `<span class="fact ${overdue ? 'overdue' : 'soon'}">下次 <b>${esc(fmtClock(line.next))}</b>${until ? ` · ${esc(until)}` : ''}</span>`, soon: true };
  }
  const types = (line.types || []).join('、');
  return {
    html: `<span class="fact">${line.every ? `每 ${esc(line.every)}` : `事件触发${types ? `（${esc(types)}）` : ''}`} · <b>无固定时刻</b></span>`,
    soon: false,
  };
}

function renderRules(s) {
  const lines = s?.lines || [];
  const elsewhere = s?.elsewhere || [];
  if (!lines.length && !elsewhere.length) {
    $('rules-list').innerHTML = empty('rules.json 里还没有生效的规则。', '没有规则');
    return;
  }
  const clockIcon = `<svg class="fact-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5" stroke-linecap="round"/></svg>`;
  const boltIcon = `<svg class="fact-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M9 1.8 3.8 8.7h3.5L6.9 14.2 12.2 7H8.6z"/></svg>`;

  const localHtml = lines.map((line) => {
    const name = String(line.name ?? line.id ?? '');
    const paused = isPaused(line, s);
    const t = line.totals || {};
    const next = nextText(line);
    const out = outputs.get(name);
    return `
      <article class="rule-card ${paused ? 'paused' : ''}" data-rule="${esc(name)}">
        <div class="rule-main">
          <div class="rule-title-row">
            <span class="rule-name">${esc(name)}</span>
            <span class="pill ${paused ? 'paused' : 'active'}">${paused ? '已暂停' : '运行中'}</span>
          </div>
          <div class="rule-facts">
            ${clockIcon}${next.html}
            ${boltIcon}<span class="fact">派给 <b>${esc(line.agent || '—')}</b></span>
            <span class="fact">今日完成 <b>${esc(fmtNum(t.doneToday))}</b> · 跑着 <b>${esc(fmtNum(t.running))}</b> · 排队 <b>${esc(fmtNum(t.queued))}</b></span>
            ${line.skippedAt ? `<span class="fact">上次跳过 ${esc(fmtClock(line.skippedAt))}</span>` : ''}
          </div>
        </div>
        <div class="rule-actions">
          <button class="btn btn-mini btn-danger-soft" data-action="pause" data-rule="${esc(name)}" ${paused ? 'disabled' : ''}>暂停</button>
          <button class="btn btn-mini btn-ok-soft" data-action="resume" data-rule="${esc(name)}" ${paused ? '' : 'disabled'}>恢复</button>
          <button class="btn btn-mini btn-primary" data-action="run" data-rule="${esc(name)}">马上跑一次</button>
        </div>
        ${out ? `<div class="rule-output"><code>${esc(out.command)}</code>\n${esc(out.text)}</div>` : ''}
      </article>`;
  });

  const elsewhereHtml = elsewhere.map((e) => `
    <article class="rule-card paused">
      <div class="rule-main">
        <div class="rule-title-row">
          <span class="rule-name">${esc(e.name || e.id || '别处规则')}</span>
          <span class="pill">不在本机</span>
        </div>
        <div class="rule-facts">
          ${clockIcon}<span class="fact ${e.next ? 'soon' : ''}">下次 <b>${esc(e.next ? fmtClock(e.next) : '未定')}</b>${e.next ? ' · ' + esc(fmtUntil(e.next)) : ''}</span>
          <span class="fact">${e.every ? `每 ${esc(e.every)}` : '事件触发'}</span>
        </div>
      </div>
      <div class="rule-actions"><span class="muted">在所属机器上操作</span></div>
    </article>`);

  $('rules-list').innerHTML = [...localHtml, ...elsewhereHtml].join('');
}

/* ------------------------------- 动作 ---------------------------------- */
const ACTION_TEXT = { pause: '暂停', resume: '恢复', run: '马上跑一次' };

async function doAction(action, rule, button) {
  if (!button || button.disabled) return;
  const buttons = document.querySelectorAll(`.rule-card[data-rule="${CSS.escape(rule)}"] button`);
  buttons.forEach((b) => { b.disabled = true; });
  const original = button.textContent;
  button.textContent = '执行中…';
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, rule }),
    });
    const data = await res.json();
    outputs.set(rule, { command: data.command || `agent-autoloop ${action} ${rule}`, text: data.output || data.error || '' });
    toast(!!data.ok, `${ACTION_TEXT[action]} · ${rule}`,
      data.ok ? (data.output || '命令已执行').split('\n').slice(0, 3).join('\n') : (data.error || '执行失败'));
  } catch (err) {
    outputs.set(rule, { command: `agent-autoloop ${action} ${rule}`, text: String(err.message || err) });
    toast(false, `${ACTION_TEXT[action]} · ${rule}`, String(err.message || err));
  } finally {
    button.textContent = original;
    if (latest?.status) renderRules(latest.status);
    refresh();
    setTimeout(() => refresh(), 2200);
  }
}

$('rules-list').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  doAction(button.dataset.action, button.dataset.rule, button);
});

$('refresh-btn').addEventListener('click', () => refresh(true));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() >= nextRefreshAt) refresh();
});

setInterval(() => {
  const left = Math.max(0, nextRefreshAt - Date.now());
  $('countdown').textContent = `${Math.ceil(left / 1000)}s 后刷新`;
  $('refresh-bar').style.width = `${Math.min(100, ((REFRESH_MS - left) / REFRESH_MS) * 100)}%`;
  if (left <= 0 && !document.hidden) refresh();
}, 1000);

/* --------------------------- 多宝鱼 MCP 面板 --------------------------- */
const DBY_REFRESH_MS = 5 * 60 * 1000;
let dbyLoading = false;
let dbyHours = 24;

const dbyPart = (p, key) => (p?.data?.[key]?.ok ? p.data[key].data : null);

const RANGE_LABEL = { 24: '近 24 小时', 168: '近 7 天', 720: '近 30 天' };

function money(amount, currency) {
  const value = num(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === 'USD' ? '$' : (currency ? currency + ' ' : '')}${value}`;
}

async function refreshDby(manual = false) {
  if (dbyLoading) return;
  dbyLoading = true;
  const btn = $('dby-refresh-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const q = `${dbyHours !== 24 ? `hours=${dbyHours}&` : ''}${manual ? 'force=1' : ''}`;
    const res = await fetch(`/api/duobaoyu${q ? '?' + q.replace(/&$/, '') : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderDby(await res.json());
    if (manual) toast(true, '多宝鱼数据已刷新', '已绕过 5 分钟缓存重新读取 MCP');
  } catch (err) {
    $('dby-note').textContent = 'MCP 读取失败';
    $('dby-orders').innerHTML = `<div class="dby-error">${esc(err.message || err)}</div>`;
    $('dby-stockout').innerHTML = '';
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    dbyLoading = false;
  }
}

function renderDby(p) {
  const stores = dbyPart(p, 'stores');
  const orders = dbyPart(p, 'orders');
  const stockout = dbyPart(p, 'stockout');
  const usage = dbyPart(p, 'usage');
  const failed = Object.entries(p.data || {}).filter(([, v]) => !v.ok).map(([k, v]) => `${k}：${v.error}`);
  const hours = p.hours || 24;
  const rangeLabel = RANGE_LABEL[hours] || `${hours} 小时`;
  $('dby-orders-label').textContent = `${rangeLabel}订单`;
  document.getElementById('dby-sales-label').textContent = `${rangeLabel}销售额`;

  document.querySelectorAll('#dby-range .range-tab').forEach((t) =>
    t.classList.toggle('active', Number(t.dataset.hours) === hours));

  $('dby-note').textContent =
    `${p.ok ? 'MCP 已连接' : '部分数据不可用'} · ${p.target?.host || '未配置端点'} · ${fmtOnlyTime(p.fetchedAt)}` +
    `${p.cached ? ` · 缓存 ${fmtDuration(p.ageMs || 0)}` : ' · 刚读取'}`;

  // KPI
  $('dby-orders-count').textContent = orders ? fmtNum(orders.order_count) : '—';
  $('dby-orders-sub').textContent = orders ? `统计窗口 ${hours >= 48 ? rangeLabel.replace('近 ', '') : hours + ' 小时'}` : (failed.find((f) => f.startsWith('orders')) || '—');

  const totals = Object.entries(orders?.totals || {});
  if (totals.length) {
    const [currency, value] = totals[0];
    $('dby-sales').textContent = money(value?.grand_total, currency);
    $('dby-sales-sub').textContent =
      `商品小计 ${money(value?.item_subtotal, currency)}${totals.length > 1 ? ` · 另有 ${totals.length - 1} 个币种` : ''}`;
  } else {
    $('dby-sales').textContent = '—';
    $('dby-sales-sub').textContent = '—';
  }

  const alerts = stockout?.items || [];
  $('dby-alerts').textContent = stockout ? fmtNum(stockout.total_alerts ?? alerts.length) : '—';
  $('dby-alerts-sub').textContent = stockout ? `本次列出 ${alerts.length} 条 · 站点 ${stockout.pool || '—'}` : '—';
  $('dby-alert-count').textContent = String(alerts.length);
  $('dby-alert-count').className = `count-badge ${alerts.length ? 'alert' : ''}`;

  const storeList = stores?.stores || [];
  const labels = [...new Set(storeList.map((s) => s.label || s.connection).filter(Boolean))];
  $('dby-stores').textContent = stores ? fmtNum(storeList.length) : '—';
  $('dby-stores-sub').textContent = stores ? `${labels.length} 个店铺 · ${labels.slice(0, 2).join('、') || '—'}` : '—';

  // 左：订单状态 + 热销 SKU
  const statusNames = { PENDING: '待处理', SHIPPED: '已发货', CANCELLED: '已取消', UNSHIPPED: '未发货', PARTIALLY_SHIPPED: '部分发货' };
  const statusClass = { SHIPPED: 'shipped', PENDING: 'pending', CANCELLED: 'cancelled' };
  const statusHtml = Object.entries(orders?.status || {}).map(([key, value]) =>
    `<span class="status-chip ${statusClass[key] || ''}">${esc(statusNames[key] || key)}<b>${esc(fmtNum(value))}</b></span>`).join('');

  const skus = (orders?.top_skus || []).slice(0, 5);
  const skuHtml = skus.length ? `<div class="sku-list">${skus.map((s, i) => `
    <div class="sku-row">
      <span class="sku-rank">${i + 1}</span>
      <span class="sku-name" title="${esc(s.sku || s.title)}">${esc(s.sku || s.title || '—')}</span>
      <span class="sku-nums"><b>${esc(fmtNum(s.units))}</b> 件 · ${esc(money(s.amount, s.currency))}</span>
    </div>`).join('')}</div>` : '';

  const day = usage?.last_30_days?.days?.[0];
  const foot = [
    p.cached ? `5 分钟缓存` : '刚从 MCP 读取',
    day ? `今日 MCP 调用 ${fmtNum(day.calls)} 次 · 积分 ${fmtNum(day.credits)}` : '',
    `只读工具 ${(p.tools || []).length} 个`,
  ].filter(Boolean).join('　·　');

  $('dby-orders').innerHTML =
    (failed.length ? `<div class="dby-error" style="margin-bottom:10px">${esc(failed.join('　|　'))}</div>` : '') +
    (statusHtml ? `<div class="status-chips">${statusHtml}</div>` : '') +
    (skuHtml || empty('这个窗口里没有订单数据。')) +
    `<div class="dby-foot">${esc(foot)}</div>`;

  // 右：断货预警
  $('dby-stockout').innerHTML = alerts.length ? alerts.slice(0, 5).map((a) => {
    const critical = String(a.status || '').includes('断货') && num(a.days_left) <= 0;
    return `
      <div class="alert-row ${critical ? 'critical' : ''}">
        <div class="alert-top">
          <span class="alert-sku">${esc(a.sku || '—')}</span>
          <span class="alert-tag">${esc(a.status || '预警')}</span>
        </div>
        <div class="alert-meta">
          <span>库存 <b>${esc(fmtNum(a.current_stock))}</b></span>
          <span>缺口 <b>${esc(fmtNum(a.gap_units))}</b> 件</span>
          ${a.suggested_air_qty ? `<span>建议空运 <b>${esc(fmtNum(a.suggested_air_qty))}</b> 件</span>` : ''}
          ${a.eta_if_order_today ? `<span>今天下单预计 <b>${esc(a.eta_if_order_today)}</b></span>` : ''}
        </div>
      </div>`;
  }).join('') : empty('当前没有断货预警。', '库存正常');
}

$('dby-refresh-btn').addEventListener('click', () => refreshDby(true));
setInterval(() => { if (!document.hidden) refreshDby(); }, DBY_REFRESH_MS);

/* ------------------------ 洞察：广告 / 店铺 / 产品 ------------------------ */
const INS_REFRESH_MS = 10 * 60 * 1000;
let insLoading = false;

const insPart = (p, key) => (p?.data?.[key]?.ok ? p.data[key].data : null);

const REC_TYPE = {
  negative: ['否词', '该词烧钱没出单，加精确否定止损'],
  bid_increase: ['提竞价', '出单好的词，加竞价抢排名'],
  bid_decrease: ['降竞价', 'ACOS 超标，降竞价控成本'],
  budget: ['预算', '预算卡住出单时段，该加就加'],
  harvest: ['收获', '出单搜索词移到精准组培养'],
};
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };

function recTypeLabel(type) {
  const hit = REC_TYPE[type];
  return hit ? hit[0] : (type || '建议');
}

async function refreshInsights(manual = false) {
  if (insLoading) return;
  insLoading = true;
  const btn = $('ins-refresh-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const res = await fetch(`/api/insights${manual ? '?force=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderInsights(await res.json());
    if (manual) toast(true, '洞察数据已刷新', '已绕过 10 分钟缓存重新读取 MCP');
  } catch (err) {
    $('ads-note').textContent = 'MCP 读取失败';
    $('ads-campaigns').innerHTML = `<div class="dby-error">${esc(err.message || err)}</div>`;
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    insLoading = false;
  }
}

function healthLabel(status) {
  return ({ ok: '正常', warning: '有警告', blocked: '受阻' })[status] || status || '—';
}

const CHECK_LABELS = {
  latest_sync_successful: '最近同步成功',
  expected_reports_present: '报表齐全',
  all_reports_downloaded: '报表已下载',
  all_raw_json_parseable: '原始数据可解析',
  required_fields_present: '必要字段齐全',
  nonzero_rows: '报表非空',
  date_ranges_match: '日期区间一致',
  sync_fresh_enough: '数据够新',
  unmapped_fields_low: '未映射字段少',
};

function renderInsights(p) {
  const conn = insPart(p, 'connection');
  const profile = p.profile;
  const sync = insPart(p, 'sync');
  const health = insPart(p, 'health');
  const settings = insPart(p, 'settings')?.settings;
  const campaigns = insPart(p, 'campaigns');
  const recs = insPart(p, 'recommendations');
  const balances = insPart(p, 'balances');
  const products = insPart(p, 'products') || [];

  const cacheNote = p.cached ? `缓存 ${fmtDuration(p.ageMs || 0)}` : '刚读取';
  const base = `${p.ok ? 'MCP 已连接' : '部分数据不可用'} · ${cacheNote} · ${fmtOnlyTime(p.fetchedAt)}`;

  /* ── 广告分析 ── */
  $('ads-note').textContent = base + (profile ? ` · 站点 ${profile.marketplace || '—'}` : '');
  const connections = conn?.connections || [];
  $('ads-conn').textContent = conn ? (conn.connection === 'active' ? '已连接' : String(conn.connection || '—')) : '—';
  $('ads-conn-sub').textContent = conn
    ? `${connections.length} 个授权 · ${(conn.profiles || []).length} 个 profile（启用 ${(conn.profiles || []).filter((x) => x.enabled).length} 个）`
    : (p.data?.connection?.error || '—');

  const lastRun = sync?.runs?.[0];
  $('ads-sync').textContent = lastRun ? (lastRun.status === 'success' ? '成功' : String(lastRun.status)) : '—';
  $('ads-sync-sub').textContent = lastRun
    ? `${lastRun.trigger === 'scheduled' ? '定时' : lastRun.trigger} · ${esc(fmtAgo(lastRun.finished_at))}前 · ${fmtNum(lastRun.rows_total)} 行`
    : (p.data?.sync?.error || '—');

  $('ads-health').textContent = health ? healthLabel(health.status) : '—';
  const failedChecks = (health?.checks || []).filter((c) => !c.passed);
  $('ads-health-sub').textContent = health
    ? (failedChecks.length
        ? failedChecks.map((c) => c.message || CHECK_LABELS[c.name] || c.name).join('；')
        : '全部检查通过')
    : (p.data?.health?.error || '—');

  $('ads-acos').textContent = settings ? `${Math.round(num(settings.target_acos) * 100)}%` : '—';
  $('ads-acos-sub').textContent = settings
    ? `零单击门限 ${settings.zero_order_min_clicks} 次 / $${settings.zero_order_min_cost} · 提价 +${settings.bid_increase_pct}%`
    : (p.data?.settings?.error || '—');

  /* 广告表现（近 7 / 30 天） */
  const perf = insPart(p, 'performance');
  const perfCard = (row, errText, title) => {
    if (!row) {
      return `<div class="perf-card"><div class="perf-title">${esc(title)}</div><div class="dby-error">${esc(errText || '暂无数据')}</div></div>`;
    }
    const ctr = row.impressions ? (row.clicks / row.impressions) * 100 : 0;
    const cpc = row.clicks ? row.cost / row.clicks : 0;
    const acos = row.sales ? (row.cost / row.sales) * 100 : 0;
    const roas = row.cost ? row.sales / row.cost : 0;
    const acosBad = acos > (settings ? num(settings.target_acos) * 100 : 35);
    return `
      <div class="perf-card">
        <div class="perf-title">${esc(title)}</div>
        <div class="perf-metrics">
          <div class="pm"><i>曝光</i><b>${esc(fmtCompact(row.impressions))}</b></div>
          <div class="pm"><i>点击</i><b>${esc(fmtNum(row.clicks))}</b></div>
          <div class="pm"><i>CTR</i><b>${ctr.toFixed(2)}%</b></div>
          <div class="pm"><i>CPC</i><b>$${cpc.toFixed(2)}</b></div>
          <div class="pm"><i>花费</i><b>$${esc(fmtNum(Math.round(row.cost)))}</b></div>
          <div class="pm"><i>销售额</i><b>$${esc(fmtNum(Math.round(row.sales)))}</b></div>
          <div class="pm"><i>订单</i><b>${esc(fmtNum(row.purchases))}</b></div>
          <div class="pm ${acosBad ? 'bad' : 'good'}"><i>ACOS</i><b>${acos.toFixed(1)}%</b></div>
          <div class="pm"><i>ROAS</i><b>${roas.toFixed(2)}</b></div>
        </div>
      </div>`;
  };
  $('ads-perf').innerHTML = perf
    ? perfCard(perf.perf7, perf.perf7Error, '近 7 天') + perfCard(perf.perf30, perf.perf30Error, '近 30 天')
    : '<div class="empty-inline">暂无广告表现数据</div>';

  /* 预算预警 */
  const budgetHot = perf?.budgetHot || [];
  $('ads-budget-count').textContent = String(budgetHot.length);
  $('ads-budget-count').className = `count-badge ${budgetHot.length ? 'alert' : ''}`;
  $('ads-budget').innerHTML = budgetHot.length ? budgetHot.map((b) => {
    const over = b.usage_percent > 100;
    const est = b.budget * b.usage_percent / 100;
    return `
      <div class="run-item">
        <div class="run-top">
          <span class="run-rule camp-name" title="${esc(b.campaign_name)}">${esc(b.campaign_name)}</span>
          <span class="run-state ${over ? 'failed' : 'queued'}">${b.usage_percent.toFixed(0)}%</span>
        </div>
        <div class="run-sub"><span>日预算 $${esc(fmtNum(b.budget))}</span><span>今日已烧约 $${est.toFixed(1)}</span><span>${esc(fmtAgo(b.updated_at))}前更新</span></div>
      </div>`;
  }).join('') : empty('今天没有预算消耗超过 80% 的活动。', '预算正常');

  const campItems = campaigns?.items || [];
  $('ads-camp-count').textContent = String(campItems.length);
  $('ads-campaigns').innerHTML = campItems.length ? campItems.map((c) => {
    const paused = String(c.state || '').toUpperCase() === 'PAUSED';
    return `
      <div class="run-item">
        <div class="run-top">
          <span class="run-rule camp-name" title="${esc(c.name)}">${esc(c.name || c.campaignId)}</span>
          <span class="run-state ${paused ? 'queued' : 'running'}">${paused ? '已暂停' : '投放中'}</span>
          <span class="run-time">日预算 $${esc(fmtNum(c.budget))}</span>
        </div>
        <div class="run-sub">
          <span>${esc(c.targetingType === 'MANUAL' ? '手动' : c.targetingType === 'AUTO' ? '自动' : c.targetingType || '—')}</span>
          <span>ID ${esc(c.campaignId)}</span>
        </div>
        <div class="camp-actions">
          <button class="btn btn-mini ${paused ? 'btn-ok-soft' : 'btn-danger-soft'}" data-camp-toggle="${esc(c.campaignId)}" data-camp-state="${paused ? 'ENABLED' : 'PAUSED'}" data-camp-name="${esc(c.name || '')}" type="button">${paused ? '启用' : '暂停'}</button>
          <button class="btn btn-mini btn-ghost" data-camp-budget="${esc(c.campaignId)}" data-camp-cur="${esc(String(c.budget ?? ''))}" data-camp-name="${esc(c.name || '')}" type="button">改预算</button>
        </div>
      </div>`;
  }).join('') : empty(p.data?.campaigns?.error || '没有拉到 SP 广告活动。');

  const syncRuns = sync?.runs || [];
  $('ads-sync-runs').innerHTML = syncRuns.length ? syncRuns.map((r) => `
      <div class="run-item">
        <div class="run-top">
          <span class="run-id">${esc(r.trigger === 'scheduled' ? '定时' : r.trigger || '同步')}</span>
          <span class="run-state ${r.status === 'success' ? 'done' : 'failed'}">${r.status === 'success' ? '成功' : String(r.status)}</span>
          <span class="run-time">${esc(fmtClock(r.finished_at))}</span>
        </div>
        <div class="run-line dim">数据区间 ${esc(r.date_start)} → ${esc(r.date_end)} · ${fmtNum(r.rows_total)} 行</div>
        <div class="run-sub">${(r.families || []).map((f) => `<span>${esc(f.key)} ${f.done}/${f.planned}</span>`).join('')}</div>
      </div>`).join('') +
    (failedChecks.length ? `<div class="plan-item warn">
      <div class="plan-title">数据健康未通过</div>
      ${failedChecks.map((c) => `<div class="plan-line">${esc(CHECK_LABELS[c.name] || c.name)}${c.message ? '：' + esc(c.message) : ''}（${esc(c.severity)}）</div>`).join('')}
    </div>` : '')
    : empty(p.data?.sync?.error || '没有同步记录。');

  /* ── 广告优化方案 ── */
  const batch = recs?.batch;
  const recList = (recs?.recommendations || [])
    .slice()
    .sort((a, b) => (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9));
  $('adplan-note').textContent = batch
    ? `批次 ${esc(fmtClock(batch.created_at))} · 数据区间 ${esc(batch.data_date_start)} → ${esc(batch.data_date_end)} · ${base}`
    : (p.data?.recommendations?.error || base);

  $('adplan-total').textContent = batch ? fmtNum(batch.total_count) : '—';
  $('adplan-total-sub').textContent = batch ? `${recList.length} 条最新 · ${String(batch.summary_text || '').slice(0, 60)}` : '—';
  $('adplan-waste').textContent = batch ? fmtNum(batch.waste_count) : '—';
  $('adplan-opp').textContent = batch ? fmtNum(batch.opportunity_count) : '—';
  $('adplan-watch').textContent = batch ? fmtNum(batch.watch_count) : '—';

  $('adplan-count').textContent = String(recList.length);
  $('adplan-count').className = `count-badge ${recList.length ? 'alert' : ''}`;
  $('adplan-list').innerHTML = recList.length ? recList.map((r) => {
    const [typeLabel, typeHint] = REC_TYPE[r.recommendation_type] || [r.recommendation_type, ''];
    const prio = r.priority === 'high' ? 'high' : (r.priority === 'medium' ? 'medium' : 'low');
    const done = r.handled_status !== 'pending';
    return `
      <div class="rec-card ${prio} ${done ? 'done' : ''}">
        <div class="run-top">
          <input type="checkbox" class="rec-check" data-rec-id="${esc(r.id)}" ${done ? 'disabled' : ''} aria-label="选择这条推荐">
          <span class="prio-pill ${prio}">${r.priority === 'high' ? '高优先' : r.priority === 'medium' ? '中优先' : '低优先'}</span>
          <span class="rec-type">${esc(typeLabel)}</span>
          <span class="run-rule rec-target" title="${esc(r.target_id)}">${esc(r.target_id || '—')}</span>
          <span class="run-time">${done ? (r.handled_status === 'done' ? '已处理' : '已忽略') : '待处理'}</span>
        </div>
        <div class="run-line">${esc(r.summary || '')}</div>
        ${typeHint ? `<div class="run-sub dim">${esc(typeHint)}</div>` : ''}
      </div>`;
  }).join('') : empty('没有待处理的广告推荐，或最近还没生成过推荐批次。', '暂无推荐');

  /* ── 店铺优化方案 ── */
  const issues = [];
  (failedChecks || []).forEach((c) => {
    if (String(c.message || '').includes('缺报表')) {
      issues.push({
        level: 'high', title: '广告报表不全',
        text: `${c.message} — 点击广告分析区的「重跑同步」重新拉取报表，否则优化方案建立在缺数据上。`,
      });
    } else if (String(c.message || '').includes('空报表')) {
      issues.push({
        level: 'medium', title: '报表为空',
        text: `${c.message} — 该时段可能确实没有投放数据，或广告账户未产生报表；核对后再判断。`,
      });
    }
  });
  (perf?.budgetHot || []).slice(0, 2).forEach((b) => {
    if (b.usage_percent >= 100) {
      issues.push({
        level: 'medium', title: `预算烧穿：${b.campaign_name}`,
        text: `今日已消耗约 $${(b.budget * b.usage_percent / 100).toFixed(1)}（${b.usage_percent.toFixed(0)}%）。超预算说明出单时段可能被截断：有转化就加预算，没转化就降竞价或暂停。`,
      });
    }
  });
  const usdBal = balances || [];
  const avail = usdBal.find((b) => b.balance_type === 'AVAILABLE');
  const reserved = usdBal.find((b) => b.balance_type === 'RESERVED');
  if (avail && reserved && num(avail.amount) < 100 && num(reserved.amount) > num(avail.amount)) {
    issues.push({
      level: 'medium', title: '可放款余额偏少',
      text: `可用 $${avail.amount.toFixed(2)}，预留 $${reserved.amount.toFixed(2)} — 预留占比高，检查是否有纠纷/退货积压，必要时压一下补货节奏。`,
    });
  }
  if (!issues.length) issues.push({ level: 'ok', title: '暂无待处理问题', text: '数据健康、余额都在正常范围；有新预警会出现在这里。' });

  $('store-note').textContent = base;
  $('store-issue-count').textContent = String(issues.length);
  $('store-issue-count').className = `count-badge ${issues.some((i) => i.level === 'high' || i.level === 'medium') ? 'alert' : ''}`;
  $('store-issues').innerHTML = issues.map((i) => `
    <div class="plan-item ${i.level === 'high' ? 'warn' : i.level === 'medium' ? 'soft' : ''}">
      <div class="plan-title">${esc(i.title)}</div>
      <div class="plan-line">${esc(i.text)}</div>
    </div>`).join('');

  const balNames = { TOTAL: '账户总额', AVAILABLE: '可放款', RESERVED: '预留', DEFERRED: '递延', ACCOUNT_LEVEL_RESERVE: '账户级预留' };
  $('store-balances').innerHTML = usdBal.length
    ? usdBal.filter((b) => ['TOTAL', 'AVAILABLE', 'RESERVED'].includes(b.balance_type)).map((b) => `
      <div class="run-item">
        <div class="run-top">
          <span class="run-rule">${esc(balNames[b.balance_type] || b.balance_type)}</span>
          <span class="run-time">${money(b.amount, b.currency)}</span>
        </div>
        ${b.marketplace ? `<div class="run-sub"><span>站点 ${esc(b.marketplace)}</span>${b.account_type ? `<span>账户 ${esc(b.account_type)}</span>` : ''}</div>` : ''}
      </div>`).join('')
    : empty(p.data?.balances?.error || '没有 USD 余额记录。');

  /* 补货建议 / 需求预测 */
  const forecast = insPart(p, 'forecast');
  const fMonths = forecast?.forecast_by_month || [];
  const fHistory = forecast?.monthly_sales_history || [];
  $('forecast-note').textContent = forecast
    ? `${fmtNum(forecast.styles_missing_season_count)} 个款式缺季节性数据 · 预测为月度去季节化后再季节化`
    : (p.data?.forecast?.error || '正在读取…');
  $('store-forecast').innerHTML = forecast
    ? (forecast.timeline ? `<div class="plan-item soft"><div class="plan-title">今天下单的补货时间线</div><div class="plan-line">${esc(forecast.timeline)}</div></div>` : '') +
      (fMonths.length ? `
      <div class="fc-grid">
        ${fMonths.slice(0, 6).map((m) => `
          <div class="fc-month">
            <span class="fc-m">${esc(String(m.month).slice(2))}</span>
            <b class="fc-q">${esc(fmtNum(m.qty))}</b>
            <span class="fc-l">件/月</span>
          </div>`).join('')}
      </div>
      ${fHistory.length ? `<div class="plan-line" style="margin-top:8px">历史月销：${fHistory.map((h) => `${String(h.month).slice(2)} ${fmtNum(h.qty)} 件`).join(' · ')}</div>` : ''}` : '')
    : empty(p.data?.forecast?.error || '暂无补货预测数据。');

  /* ── 产品优化方案 ── */
  $('product-note').textContent = products.length
    ? `近 24h 热销前 ${products.length} 个 ASIN · 买家反馈 + Listing 体检 ${'· ' + base}`
    : (p.data?.products?.error || base);
  $('product-list').innerHTML = products.length ? products.map((pr) => {
    const d = pr.data;
    const fb = d.feedback;
    const detail = d.detail;
    const facts = [];
    if (detail) {
      facts.push(`<span>价格 <b>$${esc(fmtNum(detail.price))}</b></span>`);
      facts.push(`<span>评分 <b>${detail.rating ?? '—'}</b>（${fmtNum(detail.ratings)} 评）</span>`);
      if (detail.lqs != null) facts.push(`<span>Listing 质量 <b>${esc(detail.lqs)}</b>/100</span>`);
      if (detail.bsrRank) facts.push(`<span>BSR <b>#${fmtNum(detail.bsrRank)}</b> ${esc((detail.subcategories || [])[0]?.label || detail.bsrLabel || '')}</span>`);
    }
    const negTopics = (fb?.negative_topics || []);
    const posTopics = (fb?.positive_topics || []);
    const topicPct = (t) => (t?.occurrence_pct != null ? `${Math.round(t.occurrence_pct)}%` : '—');
    const topicsHtml = [
      negTopics.length
        ? `<div class="topic-group neg"><div class="group-label">差评主题 · 优先改进</div>${negTopics.map((t) => `
            <div class="topic-row">
              <span class="topic-name">${esc(t.topic)}</span>
              <span class="topic-meta">${fmtNum(t.mentions)} 次提及 · ${topicPct(t)}</span>
            </div>`).join('')}</div>`
        : '',
      posTopics.length
        ? `<div class="topic-group pos"><div class="group-label">好评主题 · 继续放大</div>${posTopics.map((t) => `
            <div class="topic-row">
              <span class="topic-name">${esc(t.topic)}</span>
              <span class="topic-meta">${fmtNum(t.mentions)} 次提及 · ${topicPct(t)}</span>
            </div>`).join('')}</div>`
        : '',
    ].join('');

    /* 主题走势（近几个月占比） */
    const trends = d.trends;
    const trendLine = (t) => {
      const pts = (t.points || []).filter((x) => x.asin_pct != null);
      if (pts.length < 2) return '';
      const first = pts[pts.length - 1], last = pts[0];
      const arrow = last.asin_pct > first.asin_pct ? '↑' : last.asin_pct < first.asin_pct ? '↓' : '→';
      return `${t.topic}：${first.asin_pct}% → ${last.asin_pct}% ${arrow}`;
    };
    const trendHtml = trends && (trends.negative_topics?.length || trends.positive_topics?.length)
      ? `<div class="topic-group"><div class="group-label">近 6 个月主题占比走势</div>${[
          ...(trends.negative_topics || []).map(trendLine),
          ...(trends.positive_topics || []).map(trendLine),
        ].filter(Boolean).slice(0, 4).map((l) => `<div class="topic-row"><span class="topic-name">${esc(l)}</span></div>`).join('')}</div>`
      : '';

    /* SQP 搜索词漏斗 */
    const sqp = d.sqp;
    const STAGE_LABEL = { impression: '曝光', click: '点击', cart_add: '加购', purchase: '购买' };
    const sqpHtml = sqp && sqp.rows?.length
      ? `<div class="topic-group"><div class="group-label">搜索词漏斗（月度）· 我 vs 市场</div>${sqp.rows.map((r) => `
          <div class="topic-row">
            <span class="topic-name">${esc(r.query)}</span>
            <span class="topic-meta">月搜 ${esc(fmtCompact(r.query_volume))} · 我的份额 曝光${r.share_impressions != null ? (r.share_impressions * 100).toFixed(1) : '0'}% / 购买${r.share_purchases != null ? (r.share_purchases * 100).toFixed(1) : '0'}%${r.weakest_stage ? ` · 最弱环节：${esc(STAGE_LABEL[r.weakest_stage] || r.weakest_stage)}` : ''}</span>
          </div>`).join('')}</div>`
      : (d.sqpError ? `<div class="empty-inline">搜索词漏斗：${esc(d.sqpError)}</div>` : '');
    const advice = [];
    if (detail && detail.lqs != null && detail.lqs < 80) advice.push(`Listing 质量分 ${detail.lqs}：补齐五点描述、A+ 和关键词埋词。`);
    if (negTopics.length) advice.push(`优先解决「${negTopics[0].topic}」：写进卖点与售后卡，必要时改产品/包装。`);
    if (fb?.thin_sample) advice.push('评论样本还少，差评主题不稳定：先用 Vine / 售后邮件积累真实反馈。');
    const weakRow = (d.sqp?.rows || []).find((r) => r.weakest_stage);
    if (weakRow) advice.push(`搜索词「${weakRow.query}」最弱环节是${esc(STAGE_LABEL[weakRow.weakest_stage] || weakRow.weakest_stage)}：${weakRow.weakest_stage === 'impression' ? '曝光份额太低，考虑提竞价或加大预算拿展示。' : weakRow.weakest_stage === 'click' ? '点击竞争力不足：优化主图和价格，检查竞价是否过低。' : '流量进来了但转化不足：对照主图、价格、评论，与市场对手找差异。'}`);
    if (!advice.length) advice.push('评分与 Listing 都健康：保持补评论节奏，盯住差评主题变化即可。');
    return `
      <article class="product-card">
        <div class="wait-from">热销 ${esc(fmtNum(d.units))} 件 · ${esc(money(d.amount, d.currency))} / 24h</div>
        <div class="wait-title">${esc(d.title || d.sku)}</div>
        <div class="run-sub">${facts.join('')}</div>
        ${topicsHtml || `<div class="empty-inline">${esc(d.feedbackError || d.detailError || '暂无买家反馈数据（需品牌备案）')}</div>`}
        ${trendHtml}
        ${sqpHtml}
        <div class="plan-item soft">
          <div class="plan-title">建议动作</div>
          ${advice.map((a) => `<div class="plan-line">· ${esc(a)}</div>`).join('')}
        </div>
        <div class="wait-meta"><span>ASIN ${esc(d.asin)}</span><span>SKU ${esc(d.sku)}</span></div>
      </article>`;
  }).join('') : empty('近 24 小时没有出单商品可分析。', '暂无产品');
}

$('ins-refresh-btn').addEventListener('click', () => refreshInsights(true));
setInterval(() => { if (!document.hidden) refreshInsights(); }, INS_REFRESH_MS);

/* ------------------------- 时间范围切换（店铺数据） ------------------------- */
$('dby-range').addEventListener('click', (e) => {
  const tab = e.target.closest('button[data-hours]');
  if (!tab) return;
  const hours = Number(tab.dataset.hours);
  if (hours === dbyHours) return;
  dbyHours = hours;
  refreshDby(true);
});

/* ---------------------------- 广告操作（写入类） ---------------------------- */
async function adsAction(body) {
  const res = await fetch('/api/ads-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* 重跑广告同步 */
$('ads-sync-btn').addEventListener('click', async () => {
  if (!window.confirm('从亚马逊重新拉取近 30 天广告报表？大约需要 1-2 分钟，期间洞察数据会更新。')) return;
  const btn = $('ads-sync-btn');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const r = await adsAction({ op: 'sync', days: 30 });
    toast(r.ok, r.ok ? '广告同步已开始' : '广告同步失败', r.ok ? r.message : (r.error || '未知错误'));
  } catch (err) {
    toast(false, '广告同步失败', String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = '重跑同步';
  }
});

/* 推荐勾选 + 批量标记 */
function selectedRecIds() {
  return [...document.querySelectorAll('.rec-check:checked')].map((c) => c.dataset.recId);
}

function updateRecToolbar() {
  const n = selectedRecIds().length;
  $('rec-mark-done').disabled = !n;
  $('rec-mark-ignore').disabled = !n;
  $('rec-mark-done').textContent = n ? `标记已处理(${n})` : '标记已处理';
  $('rec-mark-ignore').textContent = n ? `标记忽略(${n})` : '标记忽略';
}

$('adplan-list').addEventListener('change', (e) => {
  if (e.target.classList.contains('rec-check')) updateRecToolbar();
});

async function markSelected(status) {
  const ids = selectedRecIds();
  if (!ids.length) return;
  const btn = status === 'done' ? $('rec-mark-done') : $('rec-mark-ignore');
  btn.disabled = true;
  btn.textContent = '标记中…';
  try {
    const r = await adsAction({ op: 'mark', ids, status });
    toast(r.ok, r.ok ? `已标记 ${ids.length} 条` : '标记失败', r.ok ? '' : (r.error || '未知错误'));
  } catch (err) {
    toast(false, '标记失败', String(err.message || err));
  } finally {
    refreshInsights(true);
  }
}

$('rec-mark-done').addEventListener('click', () => markSelected('done'));
$('rec-mark-ignore').addEventListener('click', () => markSelected('ignored'));

/* 广告活动快捷操作：启停 / 改预算 → prepare → 弹窗确认 → apply */
let pendingPlan = null;

function planDesc(change) {
  const name = change.campName || change.campaignId;
  const bits = [];
  if (change.state) bits.push(change.state === 'PAUSED' ? '暂停' : '启用');
  if (change.budget !== undefined) bits.push(`日预算改为 $${change.budget}`);
  return `${name}：${bits.join('，')}`;
}

async function prepareChanges(changes) {
  for (const c of changes) {
    const ok = window.confirm(
      `即将向亚马逊广告账户提交变更（先预览，确认后才写入）：\n\n${planDesc(c)}\n\n继续？`);
    if (!ok) return;
  }
  try {
    const r = await adsAction({ op: 'prepare', changes });
    if (!r.ok) { toast(false, '生成变更计划失败', r.error || '未知错误'); return; }
    pendingPlan = { plan_id: r.plan.plan_id, changes };
    $('plan-modal-body').innerHTML = `
      ${(r.plan.preview || []).map((item, i) => `
        <div class="plan-item warn">
          <div class="plan-title">${i + 1}. ${esc(item.summary || item.kind)}</div>
          <div class="plan-line"><code>${esc(JSON.stringify(item.payload))}</code></div>
        </div>`).join('')}
      <div class="plan-line">共 ${esc(fmtNum(r.plan.count || changes.length))} 条 · 计划 30 分钟内有效</div>`;
    $('plan-modal').hidden = false;
  } catch (err) {
    toast(false, '生成变更计划失败', String(err.message || err));
  }
}

$('ads-campaigns').addEventListener('click', (e) => {
  const toggle = e.target.closest('button[data-camp-toggle]');
  if (toggle) {
    prepareChanges([{
      campaignId: toggle.dataset.campToggle,
      state: toggle.dataset.campState,
      campName: toggle.dataset.campName,
    }]);
    return;
  }
  const budget = e.target.closest('button[data-camp-budget]');
  if (budget) {
    const cur = budget.dataset.campCur;
    const input = window.prompt(
      `把「${budget.dataset.campName}」的日预算改为多少美元？\n（当前 $${cur}，范围 $0.5 - $10000）`, cur);
    if (input === null) return;
    const val = Number(input);
    if (!Number.isFinite(val) || val < 0.5 || val > 10000) {
      toast(false, '预算不合法', '需要 $0.5 - $10000 之间的数字');
      return;
    }
    if (val === Number(cur)) { toast(true, '预算没变', '新预算与当前相同，未提交'); return; }
    prepareChanges([{
      campaignId: budget.dataset.campBudget,
      budget: val,
      campName: budget.dataset.campName,
    }]);
  }
});

$('plan-cancel').addEventListener('click', () => {
  pendingPlan = null;
  $('plan-modal').hidden = true;
});

$('plan-modal').addEventListener('click', (e) => {
  if (e.target === $('plan-modal')) $('plan-cancel').click();
});

$('plan-confirm').addEventListener('click', async () => {
  if (!pendingPlan) return;
  const btn = $('plan-confirm');
  btn.disabled = true;
  btn.textContent = '写入中…';
  try {
    const r = await adsAction({ op: 'apply', plan_id: pendingPlan.plan_id });
    const applied = (r.result?.items || []).filter((x) => x.status === 'success').length;
    toast(!!r.ok, r.ok ? `已写入 ${applied} 条变更` : '写入失败',
      r.ok ? '稍后刷新洞察回读确认' : (r.error || '未知错误'));
  } catch (err) {
    toast(false, '写入失败', String(err.message || err));
  } finally {
    pendingPlan = null;
    $('plan-modal').hidden = true;
    btn.disabled = false;
    btn.textContent = '确认执行';
    refreshInsights(true);
  }
});

refresh();
refreshDby();
refreshInsights();
