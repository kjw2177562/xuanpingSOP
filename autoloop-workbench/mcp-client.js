/**
 * 多宝鱼 MCP 客户端（零依赖，Streamable HTTP / JSON-RPC）
 *
 * - 端点从 ~/.workbuddy/mcp.json 的 mcpServers.duobaoyu.url 读取，也可用
 *   DUOBAOYU_MCP_URL 覆盖。URL 里含密钥，只在服务端使用，绝不下发到页面。
 * - 只调用只读工具；任何写入类工具都不在这里注册。
 * - 服务端无会话（initialize 不返回 session id），响应可能是 JSON 或 SSE。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let seq = 0;
let endpointCache;
let initPromise;

function endpoint() {
  if (endpointCache) return endpointCache;
  const fromEnv = process.env.DUOBAOYU_MCP_URL;
  if (fromEnv) return (endpointCache = fromEnv);
  const file = path.join(os.homedir(), '.workbuddy', 'mcp.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读不到 MCP 配置 ${file}：${err.message}`);
  }
  const entry = cfg?.mcpServers?.duobaoyu;
  if (!entry?.url) throw new Error('mcp.json 里没有 mcpServers.duobaoyu.url');
  if (entry.transport && entry.transport !== 'http') {
    throw new Error(`暂不支持 transport=${entry.transport} 的多宝鱼 MCP`);
  }
  return (endpointCache = entry.url);
}

/** 只暴露主机名，方便页面/日志显示连接目标而不泄露密钥。 */
function endpointInfo() {
  try {
    return { host: new URL(endpoint()).host, configured: true };
  } catch (err) {
    return { host: null, configured: false, error: err.message };
  }
}

function parseBody(raw) {
  const text = String(raw || '').trimStart();
  if (text.startsWith('{')) return JSON.parse(text);
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    return JSON.parse(payload);
  }
  throw new Error('MCP 返回的既不是 JSON 也不是 SSE');
}

async function rpc(method, params, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params: params || {} }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}：${raw.slice(0, 200)}`);
    const message = parseBody(raw);
    if (message.error) throw new Error(message.error.message || JSON.stringify(message.error));
    return message.result;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`MCP 请求超时（${timeoutMs / 1000}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'autoloop-workbench', version: '1.0' },
    }).then(() => true).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/** 调一个只读工具，把 content[0].text 解析成对象（非 JSON 时返回 { raw }）。 */
async function callTool(name, args = {}, timeoutMs = 60000) {
  await ensureInit();
  const result = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  const text = (result?.content || [])
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (result?.isError) throw new Error(text.slice(0, 300) || 'MCP 工具返回错误');
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

module.exports = { callTool, endpointInfo };
