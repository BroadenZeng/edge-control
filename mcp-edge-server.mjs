#!/usr/bin/env node
// MCP 服务器：把「本机进程权限 + Edge CDP」暴露给任何支持 MCP 的模型客户端。
// 传输：stdio（不监听任何网络端口，只有拉起它的那个进程能调）。
// 用法：node mcp-edge-server.mjs
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import { CFG } from './config.mjs';
import { extraTools, extraCall } from './browser-tools.mjs';
import { createConsentController } from './auto-consent.mjs';
import { join } from 'node:path';
const EDGE = CFG.browser;
const PROFILE = CFG.userDataDir;
const PORT = CFG.cdpPort;
const BASE = `http://127.0.0.1:${PORT}`;
const ACTIVE_PORT_FILE = CFG.activePortFile;
const HTTP_PORT = Number(process.argv[process.argv.indexOf('--http') + 1]) || Number(process.env.MCP_HTTP_PORT || 0);

function activeEndpoint() {
  const [port, path] = readFileSync(ACTIVE_PORT_FILE, 'utf8').trim().split(/\r?\n/);
  const number = Number(port);
  if (!/^\d+$/.test(port) || number < 1 || number > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || '')) {
    throw new Error('Invalid Edge DevToolsActivePort file');
  }
  return { port: number, webSocketDebuggerUrl: `ws://127.0.0.1:${number}${path}` };
}

const log = (...a) => process.stderr.write(`[mcp-edge] ${a.join(' ')}\n`);

// ---------- CDP ----------
async function cdpVersion() {
  if (ACTIVE_PORT_FILE) return activeEndpoint();
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const KEEP_CDP = !!ACTIVE_PORT_FILE && (process.env.EDGE_KEEP_CDP === '1' || HTTP_PORT > 0);
let sharedBrowserPromise = null;
let sharedBrowserSocket = null;
const consent = createConsentController({ stateRoot: process.platform === 'win32' ? process.env.LOCALAPPDATA : '', kitDir: CFG.kitDir, profileDir: PROFILE, watcherPath: join(CFG.kitDir, 'auto-allow-debug.ps1') });

async function openBrowserConnection() {
  const v = await cdpVersion();
  const stopWatcher = (ACTIVE_PORT_FILE && HTTP_PORT > 0) ? consent.start() : () => {};
  let ws;
  try { ws = new WebSocket(v.webSocketDebuggerUrl); } catch (e) { stopWatcher(); throw e; }
  let seq = 0;
  const pending = new Map();
  const observers = new Set();
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method) for (const observer of observers) { try { observer(m); } catch {} }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
    pending.clear();
    if (sharedBrowserSocket === ws) {
      sharedBrowserSocket = null;
      sharedBrowserPromise = null;
    }
  });
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败：请确认 Edge 正在运行且已为当前实例启用远程调试；端口文件可能过期。先查看 AI-GUIDE.md 的排错步骤，不要删除浏览器配置或强制关闭 Edge。')), { once: true });
    });
    if (ACTIVE_PORT_FILE && HTTP_PORT > 0) consent.markConnected();
  } finally { stopWatcher(); }
  call.subscribe = (fn) => { observers.add(fn); return () => observers.delete(fn); };
  call.isOpen = () => ws.readyState === WebSocket.OPEN;
  call.persistent = KEEP_CDP;
  return { call, ws };
}

async function withBrowser(fn) {
  let connection;
  if (KEEP_CDP) {
    if (!sharedBrowserPromise) {
      sharedBrowserPromise = openBrowserConnection().then((c) => { sharedBrowserSocket = c.ws; return c; }).catch((e) => { sharedBrowserPromise = null; throw e; });
    }
    connection = await sharedBrowserPromise;
  } else {
    connection = await openBrowserConnection();
  }
  try {
    return await fn(connection.call);
  } finally {
    if (!KEEP_CDP) try { connection.ws.close(); } catch (e) {}
  }
}

const listTabs = async () => {
  if (ACTIVE_PORT_FILE) return withBrowser(async (call) => {
    const { targetInfos } = await call('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
  });
  const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  return j.filter((t) => t.type === 'page').map((t) => ({ id: t.id, title: t.title, url: t.url }));
};

// tab 参数：序号（"0"）或 URL 子串
async function resolveTab(call, tab) {
  // The active-browser flow asks for consent on each new CDP connection.
  // Reuse this call's existing browser connection to resolve its target.
  const tabs = ACTIVE_PORT_FILE
    ? (await call('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, title: t.title, url: t.url }))
    : await listTabs();
  if (!tabs.length) throw new Error('没有可用的标签页');
  if (tab === undefined || tab === null || tab === '') return tabs[0].id;
  const s = String(tab);
  if (/^\d+$/.test(s)) { const match = tabs[Number(s)]; if (!match) throw new Error('Target tab index not found: ' + s); return match.id; }
  const hits = tabs.filter((t) => (t.url || '').includes(s) || (t.title || '').includes(s));
  if (!hits.length) throw new Error('Target tab not found: ' + s);
  if (hits.length > 1) throw new Error('Multiple matching tabs; provide a more specific identifier');
  return hits[0].id;
}

// ---------- 工具 ----------
const TOOLS = [
  ...extraTools,
  {
    name: 'edge_status',
    description: '检查受控 Edge 是否在跑、版本、当前标签页列表',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'edge_open',
    description: '如 Edge 未运行，正常启动已安装的 Microsoft Edge；不启用调试或创建独立配置',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'edge_auto_reset',
    description: '重置自动授权状态，下次连接时需手动处理授权',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tabs_list',
    description: '列出全部页面标签',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tab_open',
    description: '新开标签页',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'tab_eval',
    description: '在指定标签页执行任意 JS 并返回结果（页面上下文，能力等同于 DevTools 控制台）',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: '序号或 URL/标题子串；空为第一个' },
        expression: { type: 'string', description: 'JS 表达式，可返回 Promise' },
        userGesture: { type: 'boolean', description: '当作真实用户手势，绕过部分点击限制' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'tab_click',
    description: '在标签页内按坐标点击（CSS 像素）',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'tab_screenshot',
    description: '截取标签页，保存到本地文件并返回路径',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string' }, savePath: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } },
      required: ['savePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'tab_cookies',
    description: '读取浏览器 cookie（可筛域名），含 httpOnly',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string' }, domainFilter: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tm_scripts',
    description: '读取篡改猴里已安装的全部用户脚本源码（从扩展页的 chrome.storage 取，不需要打开扩展界面）',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '只取某一份脚本的内部 id；留空返回全部' },
        includeCode: { type: 'boolean', description: '是否返回代码全文，默认 true' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tm_verify',
    description: '对账篡改猴里实际安装的脚本与磁盘文件：只返回版本、字节数、sha256 和是否一致，不返回任何源码',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要比对的本地脚本文件，必填' },
        uuid: { type: 'string', description: '指定某一份已装脚本的内部 id；必填' },
      },
      required: ['filePath', 'uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_push',
    description: '将本地脚本写入指定油猴脚本并重载扩展；可选刷新指定网页',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要部署的本地脚本文件，必填' },
        uuid: { type: 'string', description: '目标脚本内部 id；必填已装脚本' },
        reloadTabs: { type: 'boolean', description: '是否刷新匹配页面，默认 false' },
        tabFilter: { type: 'string', description: '刷新哪些标签（URL 子串），刷新时必填' },
        probe: { type: 'string', description: '注入后用来读回的表达式，可选' },
      },
      required: ['filePath', 'uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'fs_read',
    description: '读本地文本文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxBytes: { type: 'number' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'fs_write',
    description: '写本地文本文件（自动建目录）',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: '以当前用户身份执行本机命令，返回 stdout/stderr/退出码',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（经 cmd /c 或 bash -lc）' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', description: '默认 60000' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

function runCommand(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // Windows 上必须原样把命令行交给 cmd，否则 Node 会二次转义，引号变成 \"
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          cwd: cwd || process.cwd(),
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn('bash', ['-lc', command], { cwd: cwd || process.cwd() });
    let out = [];
    let err = [];
    // cmd 的本地化输出是 GBK；按字节判断，UTF-8 解不开就退回 GBK
    const decodeBuf = (chunks) => {
      const buf = Buffer.concat(chunks);
      const utf8 = buf.toString('utf8');
      if (!utf8.includes('\uFFFD')) return utf8;
      try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
    };
    child.stdout.on('data', (d) => { out.push(d); });
    child.stderr.on('data', (d) => { err.push(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: decodeBuf(out).slice(0, 20000), stderr: decodeBuf(err).slice(0, 8000) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: decodeBuf(out), stderr: String(e.message) });
    });
  });
}

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function callTool(name, args = {}) {
  if (extraTools.some((tool) => tool.name === name)) return text(await extraCall(name, args, { withBrowser, resolveTab }));
  switch (name) {
    case 'edge_status': {
      if (ACTIVE_PORT_FILE) return withBrowser(async (call) => {
        const [v, result] = await Promise.all([call('Browser.getVersion'), call('Target.getTargets')]);
        const tabs = result.targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
        return text({ browser: v.product, protocol: v.protocolVersion, port: activeEndpoint().port, tabs });
      });
      const v = await cdpVersion();
      const tabs = await listTabs();
      return text({ browser: v.Browser, protocol: v['Protocol-Version'], port: PORT, tabs });
    }
    case 'edge_open': {
      if (process.platform !== 'win32') throw new Error('edge_open is supported on Windows only');
      const running = await runCommand('tasklist /FI "IMAGENAME eq msedge.exe" /NH', undefined, 10000);
      if (running.code !== 0) throw new Error('Unable to check whether Edge is running');
      if (/msedge\.exe/i.test(running.stdout)) return text({ launched: false, reason: 'Edge is already running' });
      if (!CFG.browserFound || !/(?:^|[\\/])msedge\.exe$/i.test(EDGE)) throw new Error('Microsoft Edge executable not found; check EDGE_PATH');
      await new Promise((resolveLaunch, rejectLaunch) => {
        const child = spawn(EDGE, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', rejectLaunch);
        child.once('spawn', () => { child.unref(); resolveLaunch(); });
      });
      return text({ launched: true, note: 'Edge started normally; remote debugging must be enabled separately and connection checked with edge_status.' });
    }
    case 'edge_auto_reset':
      return text({ removed: consent.reset(), note: 'The next new connection will not start automatic approval.' });
    case 'tabs_list':
      return text(await listTabs());
    case 'tab_open':
      return withBrowser(async (call) => {
        const r = await call('Target.createTarget', { url: args.url });
        return text({ targetId: r.targetId, url: args.url });
      });
    case 'tab_eval':
      return withBrowser(async (call) => {
        const targetId = await resolveTab(call, args.tab);
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        const r = await call('Runtime.evaluate', {
          expression: args.expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: !!args.userGesture,
        }, sessionId);
        if (r.exceptionDetails) {
          return { ...text({ error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }), isError: true };
        }
        return text(r.result.value === undefined ? 'undefined' : r.result.value);
      });
    case 'tab_click':
      return withBrowser(async (call) => {
        const targetId = await resolveTab(call, args.tab);
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: args.x, y: args.y, button: 'left', clickCount: 1 }, sessionId);
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: args.x, y: args.y, button: 'left', clickCount: 1 }, sessionId);
        return text({ ok: true, x: args.x, y: args.y });
      });
    case 'tab_screenshot':
      return withBrowser(async (call) => {
        const targetId = await resolveTab(call, args.tab);
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        if (args.width && args.height) {
          await call('Emulation.setDeviceMetricsOverride', { width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false }, sessionId);
        }
        const shot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
        mkdirSync(dirname(args.savePath), { recursive: true });
        const buf = Buffer.from(shot.data, 'base64');
        writeFileSync(args.savePath, buf);
        return text({ ok: true, path: args.savePath, bytes: buf.length });
      });
    case 'tab_cookies':
      return withBrowser(async (call) => {
        const targetId = await resolveTab(call, args.tab);
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Network.enable', {}, sessionId);
        const { cookies } = await call('Network.getAllCookies', {}, sessionId);
        const rel = args.domainFilter ? cookies.filter((c) => c.domain.includes(args.domainFilter)) : cookies;
        return text({ count: rel.length, cookies: rel.slice(0, 200) });
      });
    case 'tm_scripts': {
      const extId = process.env.TM_EXT_ID || 'iikmkjmpaadaobahmlepeloendndfphd';
      const wantUrl = `chrome-extension://${extId}/options.html`;
      return withBrowser(async (call) => {
        const tabs = (await call('Target.getTargets')).targetInfos.filter((x) => x.type === 'page');
        let targetId = tabs.find((x) => (x.url || '').startsWith(`chrome-extension://${extId}/`))?.targetId;
        if (!targetId) {
          const created = await call('Target.createTarget', { url: `${wantUrl}#nav=dashboard` });
          targetId = created.targetId;
          await new Promise((r) => setTimeout(r, 2500));
        }
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        const expr = `(async () => {
          if (!(window.chrome && chrome.storage && chrome.storage.local)) return JSON.stringify({ error: 'no chrome.storage' });
          const all = await chrome.storage.local.get(null);
          return JSON.stringify(Object.keys(all).map(k => ({ key: k, type: typeof all[k] })));
        })()`;
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval failed');
        const keys = JSON.parse(r.result.value || '[]');
        if (keys.error) throw new Error(keys.error);
        const uuids = keys
          .filter((k) => k.key.startsWith('!extdb.@source#'))
          .map((k) => k.key.slice('!extdb.@source#'.length))
          .filter((u) => !args.uuid || u === args.uuid);
        if (!uuids.length) return text({ count: 0, scripts: [], note: '该 profile 的篡改猴里没有已安装脚本' });
        const includeCode = args.includeCode !== false;
        const dump = `(async () => {
          const all = await chrome.storage.local.get(null);
          const out = [];
          for (const u of ${JSON.stringify(uuids)}) {
            const src = all['!extdb.@source#' + u];
            const meta = all['!extdb.@meta#' + u];
            let code = null;
            const pick = (v) => {
              if (typeof v === 'string') return v;
              if (v && typeof v === 'object') {
                if (typeof v.value === 'string') return v.value;
                if (v.value && typeof v.value === 'object') {
                  for (const k of ['code', 'source', 'content', 'text']) if (typeof v.value[k] === 'string') return v.value[k];
                }
                for (const k of ['code', 'source', 'content', 'text']) if (typeof v[k] === 'string') return v[k];
              }
              return null;
            };
            code = pick(src);
            const m = meta && meta.value && typeof meta.value === 'object' ? meta.value : meta;
            out.push({
              uuid: u,
              name: m && m.name ? m.name : null,
              version: m && m.version ? m.version : null,
              enabled: m && typeof m.enabled === 'boolean' ? m.enabled : null,
              description: m && m.description ? m.description : null,
              header: m && m.header ? m.header : null,
              codeLen: code ? code.length : 0,
              code: code,
            });
          }
          return JSON.stringify(out);
        })()`;
        const r2 = await call('Runtime.evaluate', { expression: dump, returnByValue: true, awaitPromise: true }, sessionId);
        if (r2.exceptionDetails) throw new Error((r2.exceptionDetails.exception && r2.exceptionDetails.exception.description) || 'dump failed');
        const list = JSON.parse(r2.result.value || '[]');
        const shaped = list.map((s) => ({
          uuid: s.uuid,
          name: s.name,
          version: s.version,
          enabled: s.enabled,
          description: s.description,
          codeLen: s.codeLen,
          ...(includeCode ? { code: s.code } : { header: s.header }),
        }));
        return text({ count: shaped.length, scripts: shaped });
      });
    }
    case 'tm_verify': {
      const extId = process.env.TM_EXT_ID || 'iikmkjmpaadaobahmlepeloendndfphd';
      if (!args.filePath || !args.uuid) throw new Error('filePath and uuid are required');
      const diskPath = args.filePath;
      return withBrowser(async (call) => {
        const tabs = (await call('Target.getTargets')).targetInfos.filter((x) => x.type === 'page');
        let targetId = tabs.find((x) => (x.url || '').startsWith(`chrome-extension://${extId}/`))?.targetId;
        let spawned = false;
        if (!targetId) {
          const created = await call('Target.createTarget', { url: `chrome-extension://${extId}/options.html#nav=dashboard` });
          targetId = created.targetId;
          spawned = true;
          await new Promise((r) => setTimeout(r, 2500));
        }
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        const expr = `(async () => {
          const all = await chrome.storage.local.get(null);
          const pick = ${JSON.stringify(args.uuid || '')};
          const keys = Object.keys(all).filter(k => k.startsWith('!extdb.@source#'));
          const key = pick ? '!extdb.@source#' + pick : keys[0];
          if (!key || !all[key]) return JSON.stringify({ error: '该 profile 的篡改猴里没有已安装脚本' });
          const u = key.slice('!extdb.@source#'.length);
          const src = all[key];
          const meta = all['!extdb.@meta#' + u];
          const grab = (v) => {
            if (typeof v === 'string') return v;
            if (v && typeof v === 'object') {
              if (typeof v.value === 'string') return v.value;
              if (v.value && typeof v.value === 'object') for (const k of ['code','source','content','text']) if (typeof v.value[k] === 'string') return v.value[k];
              for (const k of ['code','source','content','text']) if (typeof v[k] === 'string') return v[k];
            }
            return null;
          };
          const code = grab(src);
          const m = meta && meta.value && typeof meta.value === 'object' ? meta.value : meta;
          return JSON.stringify({
            uuid: u,
            name: m && m.name ? m.name : null,
            version: m && m.version ? m.version : null,
            enabled: m && typeof m.enabled === 'boolean' ? m.enabled : null,
            fileURL: m && m.fileURL ? m.fileURL : null,
            code,
          });
        })()`;
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval failed');
        const data = JSON.parse(r.result.value || '{}');
        if (data.error) return text({ ok: false, msg: data.error });

        const sha = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
        const installedSha = data.code ? sha(data.code) : null;
        let disk = null;
        try {
          const buf = readFileSync(diskPath);
          disk = { path: diskPath, bytes: buf.length, sha256: sha(buf.toString('utf8')) };
        } catch (e) {
          disk = { path: diskPath, error: String(e.message) };
        }
        return text({
          ok: true,
          installed: {
            uuid: data.uuid,
            name: data.name,
            version: data.version,
            enabled: data.enabled,
            fileURL: data.fileURL,
            chars: data.code ? data.code.length : 0,
            sha256: installedSha,
          },
          disk,
          matchesDiskFile: !!(disk && disk.sha256 && installedSha && disk.sha256 === installedSha),
          note: data.code ? undefined : '取不到源码，无法计算哈希',
          openedExtensionTab: spawned,
        });
      });
    }
    case 'tm_push': {
      const extId = process.env.TM_EXT_ID || 'iikmkjmpaadaobahmlepeloendndfphd';
      if (!args.filePath || !args.uuid) throw new Error('filePath and uuid are required');
      const diskPath = args.filePath;
      if (args.reloadTabs === true && !args.tabFilter) throw new Error('tabFilter is required when reloading tabs');
      const code = readFileSync(diskPath, 'utf8');
      const version = (code.match(/@version\s+([\d.]+)/) || [])[1] || null;
      const sha = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
      return withBrowser(async (call) => {
        const targets = (await call('Target.getTargets')).targetInfos.filter((x) => x.type === 'page');
        let extTarget = targets.find((x) => (x.url || '').startsWith(`chrome-extension://${extId}/`));
        if (!extTarget) {
          const created = await call('Target.createTarget', { url: `chrome-extension://${extId}/options.html#nav=dashboard` });
          await new Promise((r) => setTimeout(r, 2500));
          extTarget = { targetId: created.targetId };
        }
        const { sessionId } = await call('Target.attachToTarget', { targetId: extTarget.targetId, flatten: true });

        const fn = `async (codeText, verText, wantUuid) => {
          const all = await chrome.storage.local.get(null);
          const keys = Object.keys(all).filter(k => k.startsWith('!extdb.@source#'));
          const key = wantUuid ? '!extdb.@source#' + wantUuid : keys[0];
          if (!key || !all[key]) return JSON.stringify({ error: '该 profile 的篡改猴里没有已安装脚本' });
          const uuid = key.slice('!extdb.@source#'.length);
          const src = all[key];
          const metaKey = '!extdb.@meta#' + uuid;
          const meta = all[metaKey];
          const before = meta && meta.value ? meta.value.version : null;
          const patch = {};
          patch[key] = Object.assign({}, typeof src === 'object' && src ? src : { origin: 'normal' }, { value: codeText });
          if (meta && meta.value) {
            patch[metaKey] = Object.assign({}, meta, { value: Object.assign({}, meta.value, { version: verText, lastModified: Date.now() }) });
          }
          await chrome.storage.local.set(patch);
          const after = await chrome.storage.local.get([key, metaKey]);
          const got = after[key];
          const gotCode = typeof got === 'string' ? got : (got && got.value) || '';
          return JSON.stringify({ uuid, beforeVersion: before, afterVersion: after[metaKey] && after[metaKey].value ? after[metaKey].value.version : null, storedCode: gotCode });
        }`;
        const r = await call('Runtime.evaluate', {
          expression: `(${fn})(${JSON.stringify(code)}, ${JSON.stringify(version)}, ${JSON.stringify(args.uuid || '')})`,
          returnByValue: true,
          awaitPromise: true,
        }, sessionId);
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'write failed');
        const res = JSON.parse(r.result.value || '{}');
        if (res.error) return text({ ok: false, msg: res.error });

        const storedSame = sha(res.storedCode || '') === sha(code);
        const out = {
          ok: true,
          uuid: res.uuid,
          file: diskPath,
          version,
          chars: code.length,
          storedSame,
          previousVersion: res.beforeVersion,
          extensionReloaded: false,
          pageChecks: [],
        };

        // 篡改猴把脚本源码缓存在后台进程里，直接写存储不会让它失效；
        // 必须重载扩展，之后新建/刷新的页面才会注入新代码。
        try {
          await call('Runtime.evaluate', { expression: 'chrome.runtime.reload()', returnByValue: true }, sessionId);
          out.extensionReloaded = true;
        } catch (e) {
          out.extensionReloadError = e.message;
        }
        await new Promise((r2) => setTimeout(r2, 4500));

        if (args.reloadTabs === true) {
          const filter = args.tabFilter;
          const pages = (await call('Target.getTargets')).targetInfos.filter(
            (x) => x.type === 'page' && (x.url || '').includes(filter) && !(x.url || '').startsWith('chrome-extension://'),
          );
          const picked = pages.slice(0, 4);
          // 刷新所有匹配页面，但只对前两个做读回，避免单个调用被拖过客户端超时
          for (const p of picked) {
            try {
              const s = await call('Target.attachToTarget', { targetId: p.targetId, flatten: true });
              await call('Page.reload', {}, s.sessionId);
              out.pageChecks.push({ url: (p.url || '').slice(0, 60), reloaded: true });
            } catch (e) {
              out.pageChecks.push({ url: (p.url || '').slice(0, 60), reloaded: false, error: e.message });
            }
          }
          const verifyCount = Math.min(2, out.pageChecks.length);
          if (verifyCount) {
            await new Promise((r2) => setTimeout(r2, 5000));
            for (let i = 0; i < verifyCount; i += 1) {
              const p = picked[i];
              let got = null;
              for (let attempt = 0; attempt < 5 && got === null; attempt += 1) {
                if (attempt) await new Promise((r3) => setTimeout(r3, 2000));
                try {
                  const s = await call('Target.attachToTarget', { targetId: p.targetId, flatten: true });
                  const ev = await call('Runtime.evaluate', {
                    expression: args.probe || `JSON.stringify({ ready: document.readyState })`,
                    returnByValue: true,
                  }, s.sessionId);
                  const parsed = JSON.parse(ev.result.value || '{}');
                  got = parsed.version !== undefined ? parsed.version : (parsed.value !== undefined ? parsed.value : parsed);
                  out.pageChecks[i].readyState = parsed.ready;
                } catch (e) {
                  out.pageChecks[i].error = e.message;
                }
              }
              out.pageChecks[i].runningVersion = got;
            }
            for (let i = verifyCount; i < out.pageChecks.length; i += 1) out.pageChecks[i].verified = false;
          }
        }
        return text(out);
      });
    }
    case 'fs_read': {
      const max = args.maxBytes || 200000;
      const buf = readFileSync(args.path);
      return text(buf.slice(0, max).toString('utf8'));
    }
    case 'fs_write':
      mkdirSync(dirname(args.path), { recursive: true });
      writeFileSync(args.path, args.content, 'utf8');
      return text({ ok: true, path: args.path, bytes: Buffer.byteLength(args.content) });
    case 'run_command': {
      const r = await runCommand(args.command, args.cwd, args.timeoutMs);
      return text(r);
    }
    default:
      return { ...text({ error: 'unknown tool: ' + name }), isError: true };
  }
}

// ---------- JSON-RPC 分发（stdio 与 HTTP 共用）----------
async function dispatch(req) {
  const { id, method, params } = req || {};
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'edge-control', version: '1.0.0' },
    } };
  }
  if (method && method.startsWith('notifications/')) return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const out = await callTool(params && params.name, (params && params.arguments) || {});
    return { jsonrpc: '2.0', id, result: out };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

// ---------- stdio ----------
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('close', () => { try { sharedBrowserSocket?.close(); } catch {} });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch (e) { log('bad json'); return; }
  try {
    const res = await dispatch(req);
    if (res) send(res);
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
});

// ---------- 按需启动（--ensure）----------
// 用法：node mcp-edge-server.mjs --ensure '{"jsonrpc":...}'
// 桥没在跑就顺手起一个（后台、留着），然后把这次请求转发过去并退出。
// 桥一旦被杀，再起就是新连接，授权会重新弹——所以要让它活着。
const ensureIdx = process.argv.indexOf('--ensure');
if (ensureIdx > -1) {
  let payload = process.argv[ensureIdx + 1] || '{}';
  if (payload.startsWith('@')) {
    const { readFileSync } = await import('node:fs');
    payload = readFileSync(payload.slice(1), 'utf8').replace(/^﻿/, '').trim();
  }
  const port = Number(process.env.MCP_HTTP_PORT || 9333);
  const base = 'http://127.0.0.1:' + port;
  const health = async () => {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1200) });
      if (!r.ok) return false;
      const info = await r.json();
      const norm = (p) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
      if (!info.kitDir || norm(info.kitDir) !== norm(CFG.kitDir)) {
        throw new Error('端口 ' + port + ' 被另一份或旧版 edge-control 桥占用；请核对其进程和来源后再处理，不要盲目终止。');
      }
      return true;
    } catch (e) {
      if (e.message && e.message.includes('edge-control 桥占用')) throw e;
      return false;
    }
  };
  const post = async () => {
    const r = await fetch(base + '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(120000),
    });
    return r.text();
  };
  let alive;
  try { alive = await health(); } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(1); }
  if (!alive) {
    const { spawn } = await import('node:child_process');
    const args = [process.argv[1], '--http', String(port)];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 25 && !alive; i += 1) {
      await new Promise((r) => setTimeout(r, 400));
      try { alive = await health(); } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(1); }
    }
  }
  if (!alive) { process.stdout.write(JSON.stringify({ error: 'bridge did not start' })); process.exit(1); }
  const out = await post();
  process.stdout.write(out);
  process.exit(0);
}

// ---------- HTTP 常驻模式 ----------
// 用途：让所有调用共用同一条 CDP 连接，这样「允许远程调试」的授权只需要点一次。
if (HTTP_PORT > 0) {
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    // Browser-originated requests must not invoke privileged local tools.
    if (req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403); res.end('Forbidden'); return; }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, cdp: BASE, keep: KEEP_CDP, browserConnected: !!sharedBrowserSocket && sharedBrowserSocket.readyState === WebSocket.OPEN, kitDir: CFG.kitDir }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
    try {
      const out = await dispatch(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out || {}));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload && payload.id, error: { code: -32000, message: String((e && e.message) || e) } }));
    }
  });
  server.listen(HTTP_PORT, '127.0.0.1', () => log(`http mode on 127.0.0.1:` + HTTP_PORT + ` keep=` + KEEP_CDP));
}

log(`ready  edge=` + EDGE + `  profile=` + PROFILE + `  cdp=` + (ACTIVE_PORT_FILE ? 'active-port-file' : BASE) + (HTTP_PORT ? `  http=` + HTTP_PORT : ''));

