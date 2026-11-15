/**
 * 生成一份自包含的离线快照页面（双击即可看，不需要启动服务）。
 * 数据来自真实的 agent-autoloop CLI 与多宝鱼 MCP；按钮在离线页面里会给出提示。
 * 用法：node make-snapshot.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const mcp = require('./mcp-client');
const { buildInsights } = require('./insights');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'workbench-snapshot.html');
const CLI = path.join(os.homedir(), '.agent-autoloop', 'app', 'bin', 'agent-autoloop.ts');

function cli(args) {
  const out = execFileSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', CLI, ...args],
    { cwd: os.homedir(), encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

const DBY_TOOLS = [
  ['stores', 'meta_list_stores', {}],
  ['orders', 'orders_get_recent', { hours: 24 }],
  ['stockout', 'restock_get_stockout_alerts', { top: 5 }],
  ['usage', 'meta_get_usage', {}],
];

async function main() {
  let status = null;
  let finishedRuns = [];
  const errors = {};
  try {
    status = cli(['status', '--json']);
  } catch (err) { errors.status = String(err.message || err); }
  try {
    finishedRuns = (cli(['runs', '--json']).runs || []).slice(0, 20);
  } catch (err) { errors.runs = String(err.message || err); }

  const pairs = await Promise.all(DBY_TOOLS.map(async ([key, tool, args]) => {
    try { return [key, { ok: true, data: await mcp.callTool(tool, args) }]; }
    catch (err) { return [key, { ok: false, error: String(err.message || err) }]; }
  }));

  const now = new Date().toISOString();
  const statusPayload = {
    ok: !errors.status, fetchedAt: now, status, finishedRuns, errors,
    cli: 'agent-autoloop.ts',
    commands: ['agent-autoloop status --json', 'agent-autoloop runs --json'],
  };
  const dbyPayload = {
    ok: pairs.every(([, v]) => v.ok), fetchedAt: now,
    data: Object.fromEntries(pairs), target: mcp.endpointInfo(),
    tools: DBY_TOOLS.map(([, tool]) => tool),
  };

  const insightsPayload = await buildInsights().catch((err) => ({
    ok: false, fetchedAt: now, data: {}, error: String(err.message || err),
  }));

  const payload = JSON.stringify({ status: statusPayload, dby: dbyPayload, insights: insightsPayload })
    .replace(/</g, '\\u003c');

  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  // 必须用函数式替换：字符串替换会把 app.js 里的 '$' / '$${...}' 当成 $-序列解释掉。
  html = html.replace(/<link rel="icon"[^>]*>/, () => '');
  html = html.replace('<link rel="stylesheet" href="/style.css">', () => `<style>\n${css}\n</style>`);
  html = html.replace(
    '<script src="/app.js" defer></script>',
    () => `<script>window.__SNAPSHOT__=${payload};
window.fetch=function(url){
  var u=String(url);
  if(u.indexOf('/api/action')>=0) return Promise.resolve({ok:true,json:function(){return Promise.resolve({ok:false,error:'离线快照：请运行 open.cmd 打开实时工作台后再操作规则'})}});
  if(u.indexOf('/api/ads-action')>=0) return Promise.resolve({ok:true,json:function(){return Promise.resolve({ok:false,error:'离线快照：广告写入与同步只能在实时工作台里操作'})}});
  var body=u.indexOf('/api/insights')>=0?(window.__SNAPSHOT__.insights||{}):(u.indexOf('/api/duobaoyu')>=0?window.__SNAPSHOT__.dby:window.__SNAPSHOT__.status);
  return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(body)}});
};
</script>\n<script>\n${js}\n</script>`,
  );

  fs.writeFileSync(OUT, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`SNAPSHOT ${OUT} (${kb} KB)`);
  console.log(`status: ${status ? 'ok' : 'failed'} · finishedRuns=${finishedRuns.length} · dby: ${dbyPayload.ok ? 'ok' : 'partial'}`);
}

main().catch((err) => { console.error('生成失败：', err.message); process.exitCode = 1; });
