/**
 * Service Worker 集成测试（mock chrome API + fetch）
 * ------------------------------------------------------------------
 * 这条链路以前只能靠手动开浏览器点着测，这里把它自动化：
 *   端口探测 → Clash 控制台指纹 → 软件打分 → 地理接口 → 目标时区 → 应用 → 消息接口
 *
 * 用法：node tools/test-background.mjs
 */

import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;

function ok(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + '\n      got  = ' + JSON.stringify(got) + '\n      want = ' + JSON.stringify(want));
  }
}
function truthy(name, got) {
  if (got) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + '  (falsy: ' + JSON.stringify(got) + ')');
  }
}

/* ================================================================== */
/* chrome API mock                                                     */
/* ================================================================== */
const listeners = {};
const ev = (name) => ({
  addListener(fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
});
const fire = (name, ...args) => (listeners[name] || []).forEach((fn) => fn(...args));

const store = new Map();
const calls = {
  badge: [],
  titles: [],
  alarms: [],
  executedScripts: [],
  registeredScripts: new Map(),
  cdpAttached: new Set(),
  cdpCommands: []
};

// 原生宿主机可切换开关（用来测进程级探测那条路）
let hasNativePerm = false;
let nativeReply = null;

const chromeMock = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    onInstalled: ev('onInstalled'),
    onStartup: ev('onStartup'),
    onMessage: ev('onMessage'),
    get lastError() {
      return undefined;
    },
    connectNative() {
      if (!nativeReply) throw new Error('Specified native messaging host not found.');
      const msgListeners = [];
      const discListeners = [];
      const port = {
        onMessage: { addListener: (fn) => msgListeners.push(fn) },
        onDisconnect: { addListener: (fn) => discListeners.push(fn) },
        postMessage() {
          setTimeout(() => msgListeners.forEach((fn) => fn(nativeReply)), 5);
        },
        disconnect() {
          discListeners.forEach((fn) => fn());
        }
      };
      return port;
    },
    openOptionsPage() {}
  },
  storage: {
    local: {
      async get(key) {
        if (key === undefined || key === null) return Object.fromEntries(store);
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
          return out;
        }
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
    onChanged: ev('storageOnChanged')
  },
  alarms: {
    async get() {
      return null;
    },
    async create(name, info) {
      calls.alarms.push({ name, info });
    },
    onAlarm: ev('onAlarm')
  },
  proxy: {
    settings: {
      async get() {
        return { levelOfControl: 'not_controllable', value: { mode: 'system' } };
      },
      onChange: ev('proxyOnChange')
    }
  },
  tabs: {
    async query() {
      return [{ id: 1, url: 'https://example.com/', discarded: false }];
    },
    onUpdated: ev('tabsOnUpdated'),
    onRemoved: ev('tabsOnRemoved')
  },
  webNavigation: { onCommitted: ev('navOnCommitted') },
  scripting: {
    async getRegisteredContentScripts({ ids } = {}) {
      return [...calls.registeredScripts.values()].filter(script => !ids || ids.includes(script.id));
    },
    async registerContentScripts(scripts) { for (const script of scripts) calls.registeredScripts.set(script.id, script); },
    async updateContentScripts(scripts) { for (const script of scripts) calls.registeredScripts.set(script.id, script); },
    async unregisterContentScripts({ ids }) { for (const id of ids) calls.registeredScripts.delete(id); },
    async executeScript(opts) {
      calls.executedScripts.push(opts);
      return [];
    }
  },
  action: {
    setBadgeText(t) {
      calls.badge.push(t && t.text);
    },
    setTitle(value) { calls.titles.push(value.title); },
    setIcon() {},
    setBadgeBackgroundColor() {}
  },
  permissions: {
    async contains() {
      return hasNativePerm;
    },
    async request() {
      return false;
    },
    onRemoved: ev('permOnRemoved')
  },
  debugger: {
    onEvent: ev('debuggerOnEvent'),
    async getTargets() {
      return [];
    },
    onDetach: ev('debuggerOnDetach'),
    async attach(target) {
      if (calls.cdpAttached.has(target.tabId)) throw new Error('Debugger is already attached to the tab.');
      calls.cdpAttached.add(target.tabId);
    },
    async detach(target) {
      calls.cdpAttached.delete(target.tabId);
    },
    async sendCommand(target, method, params) {
      if (!calls.cdpAttached.has(target.tabId)) {
        throw new Error('Debugger is not attached to the tab with id: ' + target.tabId);
      }
      calls.cdpCommands.push({ tabId: target.tabId, method, params });
      return {};
    }
  }
};

globalThis.chrome = chromeMock;
// Node 不提供 Canvas，图形 API 在真实 Chromium 中验证；此处只替换绘制边界。
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { scale() {}, beginPath() {}, roundRect() {}, fill() {}, arc() {},
    getImageData: () => ({ width: this.width, height: this.height, data: new Uint8ClampedArray(this.width * this.height * 4) }) }; }
};
// 旧测试明确使用通用出口、全部站点和代理门槛，避免依赖新默认值。
store.set('settings', { exitProbeUrl: '', allowGenericExit: true, includedDomains: [], onlyWhenProxied: true, countryFallback: true });

/* ================================================================== */
/* fetch mock                                                          */
/* ================================================================== */
const realFetch = globalThis.fetch;
let fetchMode = 'ipwho-fail'; // 每个阶段换一种
let countryOnlyCode = 'US';
const fetchLog = [];

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const JP_PAYLOAD = {
  ip: '203.0.113.9',
  country: 'Japan',
  country_code: 'JP',
  city: 'Tokyo',
  timezone: { id: 'Asia/Tokyo' }
};

globalThis.fetch = async function mockedFetch(url, opts = {}) {
  const u = String(url);
  fetchLog.push(u);

  if (u === 'https://chatgpt.com/cdn-cgi/trace' && ['country-only', 'trace-only'].includes(fetchMode)) {
    return new Response('h=chatgpt.com\nip=203.0.113.9\nloc=' + countryOnlyCode + '\n');
  }

  // ---- 本机端口探测 ----
  if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(u)) {
    const port = Number(u.match(/:(\d+)\/$/)[1]);
    if (port === 7897 || port === 9097) return new Response('Bad Request', { status: 400 });
    throw new TypeError('Failed to fetch');
  }
  if (/^http:\/\/127\.0\.0\.1:\d+\/(version|configs|proxies)$/.test(u)) {
    const port = Number(u.match(/:(\d+)\//)[1]);
    if (port !== 9097) throw new TypeError('Failed to fetch');
    if (u.endsWith('/version')) return jsonResponse({ version: '1.19.0', meta: true });
    if (u.endsWith('/configs')) {
      return jsonResponse({ port: 7890, 'socks-port': 7891, 'mixed-port': 7897, mode: 'rule' });
    }
    return jsonResponse({ proxies: { GLOBAL: { type: 'Selector', now: '🇯🇵 日本 01', all: ['DIRECT'] } } });
  }

  // ---- 地理接口（顺序必须和 GEO_ENDPOINTS 一致，否则测不出「依次降级」）----
  if (u.includes('ipwho.is')) {
    if (fetchMode === 'ipwho-fail') return new Response('bad gateway', { status: 502 });
    if (fetchMode === 'geo-ok') return jsonResponse(JP_PAYLOAD);
    throw new TypeError('Failed to fetch');
  }
  if (u.includes('ipapi.co')) {
    if (fetchMode === 'ipwho-fail') {
      return jsonResponse({
        ip: '203.0.113.9',
        country_name: 'Japan',
        country_code: 'JP',
        city: 'Tokyo',
        timezone: 'Asia/Tokyo'
      });
    }
    throw new TypeError('Failed to fetch');
  }
  if (u.includes('country.is')) {
    // 只有这个接口活着 → 只拿到国家，走「国家兜底」
    if (fetchMode === 'country-only') return jsonResponse({ ip: '203.0.113.9', country: countryOnlyCode });
    throw new TypeError('Failed to fetch');
  }
  throw new TypeError('Failed to fetch');
};

/* ================================================================== */
/* 载入 Service Worker                                                 */
/* ================================================================== */
console.log('[载入 background.js]');
await import('../src/background.js');
ok('注册了 onMessage', (listeners.onMessage || []).length, 1);
ok('注册了 onInstalled', (listeners.onInstalled || []).length, 1);
ok('注册了 alarms.onAlarm', (listeners.onAlarm || []).length, 1);
ok('注册了 proxy.onChange', (listeners.proxyOnChange || []).length, 1);
ok('注册了 webNavigation.onCommitted', (listeners.navOnCommitted || []).length, 1);
ok('注册了 tabs.onUpdated', (listeners.tabsOnUpdated || []).length, 1);
truthy('冷启动时创建了定时器', calls.alarms.length > 0);
ok('定时器名字正确', calls.alarms[0].name, 'tz-auto-refresh');

async function send(msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sendMessage 超时：' + msg.type)), 15000);
    const ret = listeners.onMessage[0](msg, {}, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
    if (ret !== true) {
      clearTimeout(timer);
      reject(new Error('onMessage 没有 return true，异步响应会失效'));
    }
  });
}

// 让冷启动的 bootstrap 跑完
await new Promise((r) => setTimeout(r, 200));

/* ================================================================== */
console.log('');
console.log('[阶段 1] 第一个地理接口挂了，应该自动切到第二个；Clash 控制台应该被认出来');
fetchMode = 'ipwho-fail';
let res = await send({ type: 'REFRESH', reason: 'test' });
truthy('refresh 返回 ok', res && res.ok);
let state = res.state;

ok('首选软件 = mihomo（控制台 /version 命中）', state.software.primary && state.software.primary.id, 'mihomo');
ok('置信度 = high', state.software.primary.confidence, 'high');
truthy('证据里有控制台 API', state.software.primary.evidence.some((e) => e.source === 'api'));
truthy('证据里有端口 7897', state.software.primary.evidence.some((e) => e.source === 'port' && /7897/.test(e.detail)));
ok('探测到了 7897 这个口', state.openPorts.some((p) => p.port === 7897), true);
ok('控制台拿到了真实入站端口', state.api[0].ports.mixedPort, 7897);
ok('控制台拿到了当前节点名', state.api[0].node, '🇯🇵 日本 01');
ok('地理接口跳过失败的 ipwho.is', state.geo.source, 'ipapi.co');
ok('出口 IP', state.geo.ip, '203.0.113.9');
ok('出口国家', state.geo.countryCode, 'JP');
ok('目标时区', state.target.tz, 'Asia/Tokyo');
ok('目标时区来源 = 地理接口', state.target.source, 'geo-timezone');
truthy('判定理由里有 IP', /203\.0\.113\.9/.test(state.target.reason));
ok('应用引擎 = 补丁模式', state.applied.engine, 'shim');
ok('写入了内容脚本要用的同步值', store.get('tzSync').tz, 'Asia/Tokyo');
ok('同步值里带上了开关状态', store.get('tzSync').enabled, true);
ok('工具栏不再显示截断的城市文字', calls.badge.at(-1), '');
truthy('耗时被记录', typeof state.durationMs === 'number');

console.log('');
console.log('[阶段 2] 只剩 country.is 活着 → 只拿到国家，走「国家兜底表」');
fetchMode = 'country-only';
res = await send({ type: 'REFRESH', reason: 'test' });
state = res.state;
ok('显式允许时使用美国代表城市', state.target.tz, 'America/New_York');
ok('来源标记为国家兜底', state.target.source, 'geo-country');
ok('国家代码解析到手', state.geo.countryCode, 'US');
ok('国家中文名带出来了', state.geo.countryCn, '美国');

console.log('');
console.log('[阶段 2a] 默认禁止猜测时，已确认出口的单一时区地区仍能自动切换');
res = await send({ type: 'SET_SETTINGS', patch: { countryFallback: false, onlyWhenProxied: false,
  exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace', allowGenericExit: false } });
for (const [cc, tz] of Object.entries({ SG: 'Asia/Singapore', JP: 'Asia/Tokyo', HK: 'Asia/Hong_Kong',
  MO: 'Asia/Macau', TW: 'Asia/Taipei', KR: 'Asia/Seoul', TH: 'Asia/Bangkok', PH: 'Asia/Manila' })) {
  countryOnlyCode = cc;
  res = await send({ type: 'REFRESH', reason: 'test-country-only' });
  ok(cc + ' 已确认目标网站出口', res.state.geo.exitVerified, true);
  ok(cc + ' 自动选择唯一时区', res.state.target.tz, tz);
  ok(cc + ' 来源区别于主要城市猜测', res.state.target.source, 'geo-single-timezone');
  ok(cc + ' 实际写入页面同步值', store.get('tzSync').tz, tz);
  truthy(cc + ' 已注册对应页面启动种子', calls.registeredScripts.get('tz-shim-main')?.js[0].endsWith(tz.replaceAll('/', '_') + '.js'));
}
fetchMode = 'trace-only';
countryOnlyCode = 'SG';
res = await send({ type: 'REFRESH', reason: 'test-trace-country' });
ok('外部接口全失败也能按目标 trace 切换新加坡', res.state.target.tz, 'Asia/Singapore');
ok('目标 trace 国家来源保留', res.state.geo.source, 'target-trace');
ok('失败地理接口不丢弃已确认出口 IP', res.state.geo.ip, '203.0.113.9');
ok('trace 降级结果实际同步给网页', store.get('tzSync').tz, 'Asia/Singapore');
countryOnlyCode = 'US';
res = await send({ type: 'REFRESH', reason: 'test-trace-ambiguous' });
ok('目标 trace 只有美国国家码时不猜测城市', res.state.target.tz, '');
fetchMode = 'country-only';
for (const cc of ['US', 'CA', 'AU', 'ZZ']) {
  countryOnlyCode = cc;
  res = await send({ type: 'REFRESH', reason: 'test-ambiguous-country' });
  ok(cc + ' 不凭国家猜测城市', res.state.target.tz, '');
  ok(cc + ' 还原同步值', store.get('tzSync').tz, '');
  truthy(cc + ' 提示具体国家及手动指定方法', res.state.target.reason.includes(cc) && res.state.target.reason.includes('手动指定'));
}
// 精确地理时区仍优先，不受单一地区表影响。
fetchMode = 'geo-ok';
res = await send({ type: 'SET_SETTINGS', patch: { exitProbeUrl: '', allowGenericExit: true } });
ok('完整接口结果仍来自地理时区', res.state.target.source, 'geo-timezone');
await send({ type: 'SET_SETTINGS', patch: { countryFallback: true, onlyWhenProxied: true } });

console.log('');
console.log('[阶段 2b] 所有地理接口都挂了 → 用 Clash 节点名里的国旗兜底');
fetchMode = 'geo-off';
res = await send({ type: 'REFRESH', reason: 'test' });
state = res.state;
ok('目标时区仍然正确（靠节点名 🇯🇵）', state.target.tz, 'Asia/Tokyo');
ok('来源标记为代理线索', state.target.source, 'proxy-hint');
truthy('理由里提到节点名', /日本/.test(state.target.reason));
ok('地理接口标记为失败', state.geo.ok, false);
truthy(
  '每个接口的失败原因都被记录下来',
  state.geo.attempts.length >= 5 && state.geo.attempts.every((a) => a.ok === false)
);

console.log('');
console.log('[阶段 3] 切到手动指定时区 → 优先级最高');
res = await send({ type: 'SET_SETTINGS', patch: { manualTimezone: 'Europe/Paris' }, reason: 'reapply' });
truthy('保存返回 ok', res.ok);
ok('设置已落盘', (await chromeMock.storage.local.get('settings')).settings.manualTimezone, 'Europe/Paris');
ok('目标时区变成巴黎', res.state.target.tz, 'Europe/Paris');
ok('来源 = 手动', res.state.target.source, 'manual');

res = await send({ type: 'SET_SETTINGS', patch: { manualTimezone: 'Not/AZone' }, reason: 'reapply' });
ok('非法时区被拒绝（不切换）', res.state.target.tz, '');
truthy('理由里说明非法', /不合法/.test(res.state.target.reason));
await send({ type: 'SET_SETTINGS', patch: { manualTimezone: '' }, reason: 'reapply' });

console.log('');
console.log('[阶段 4] 切到 CDP 深度模式 → 应该真的下发 Emulation.setTimezoneOverride');
res = await send({ type: 'SET_SETTINGS', patch: { engine: 'cdp' }, reason: 'reapply' });
truthy('保存 ok', res.ok);
ok('应用引擎 = cdp', res.state.applied.engine, 'cdp');
truthy('CDP 返回了统计', res.state.applied.cdp && res.state.applied.cdp.ok >= 1);
const tzCmd = calls.cdpCommands.find((c) => c.method === 'Emulation.setTimezoneOverride');
truthy('下发过 setTimezoneOverride', Boolean(tzCmd));
ok('下发的时区正确', tzCmd.params.timezoneId, 'Asia/Tokyo');
ok('附着过标签页 1', calls.cdpAttached.has(1), true);

console.log('');
console.log('[阶段 5] 关掉总开关 → 时区应该被清空并还原');
res = await send({ type: 'SET_SETTINGS', patch: { enabled: false }, reason: 'reapply' });
ok('同步值被清空', store.get('tzSync').tz, '');
ok('同步值里的开关 = false', store.get('tzSync').enabled, false);
ok('引擎变成 off', res.state.applied.engine, 'off');
ok('CDP 会话被断开', calls.cdpAttached.has(1), false);
truthy('工具栏悬停明确显示关闭状态', calls.titles.at(-1)?.includes('已关闭'));

console.log('');
console.log('[阶段 6] 重新打开 → 恢复自动');
res = await send({ type: 'SET_SETTINGS', patch: { enabled: true, engine: 'shim' }, reason: 'reapply' });
ok('目标时区恢复', res.state.target.tz, 'Asia/Tokyo');
ok('同步值恢复', store.get('tzSync').tz, 'Asia/Tokyo');

console.log('');
console.log('[阶段 7] document_start 持久化注册');
fetchMode = 'ipwho-fail';
await send({ type: 'REFRESH', reason: 'test' });
await fire('navOnCommitted', { tabId: 1, frameId: 0, url: 'https://example.com/page' });
await new Promise((r) => setTimeout(r, 50));
const registered = calls.registeredScripts.get('tz-shim-main');
truthy('预注册了主世界补丁', Boolean(registered));
ok('配置在页面脚本之前执行', registered?.runAt, 'document_start');
ok('时区种子在补丁之前', registered?.js[0].endsWith('Asia_Tokyo.js'), true);
ok('注册跨浏览器重启保留', registered?.persistAcrossSessions, true);

console.log('');
console.log('[阶段 8] 排除域名 → 不该注入');
await send({ type: 'SET_SETTINGS', patch: { excludedDomains: ['example.com'] }, reason: 'save' });
const before = calls.executedScripts.length;
await fire('navOnCommitted', { tabId: 1, frameId: 0, url: 'https://example.com/page' });
await new Promise((r) => setTimeout(r, 50));
ok('被排除的域名没有注入', calls.executedScripts.length, before);
truthy('预注册脚本也排除该域名', calls.registeredScripts.get('tz-shim-main')?.excludeMatches.includes('*://*.example.com/*'));
await send({ type: 'SET_SETTINGS', patch: { excludedDomains: [] }, reason: 'save' });

console.log('');
console.log('[阶段 9] 关掉端口扫描 → 系统代理模式无法自证，应该保持系统时区并给出提示');
res = await send({ type: 'SET_SETTINGS', patch: { localProbe: false }, reason: 'reapply' });
ok('目标时区被清空（不猜）', res.state.target.tz, '');
ok('没有扫描任何端口', res.state.openPorts.length, 0);
ok('也没探测到软件', res.state.software.primary, null);
truthy('理由里给出 TUN 模式的提示', /没检测到在用代理/.test(res.state.target.reason));

console.log('');
console.log('[阶段 9b] 装上原生宿主机 → 进程名 + 系统代理都能读到');
fetchMode = 'ipwho-fail';
hasNativePerm = true;
nativeReply = {
  ok: true,
  platform: 'win32',
  processes: [
    {
      name: 'clash-verge.exe',
      pid: 1234,
      path: 'C:\\Program Files\\Clash Verge\\clash-verge.exe',
      ports: [7897]
    }
  ],
  systemProxy: { enabled: true, server: '127.0.0.1:7897', pacUrl: '' }
};
res = await send({ type: 'SET_SETTINGS', patch: { nativeProbe: true }, reason: 'reapply' });
ok('原生宿主机可用', res.state.native.available, true);
ok('读到了 1 个代理进程', res.state.native.count, 1);
ok('读到了系统代理', res.state.native.systemProxy.server, '127.0.0.1:7897');
ok('软件识别 = clash-verge（进程名证据）', res.state.software.primary.id, 'clash-verge');
ok('置信度 = high', res.state.software.primary.confidence, 'high');
truthy(
  '证据里带进程名',
  res.state.software.primary.evidence.some((e) => e.source === 'process' && /clash-verge/.test(e.detail))
);
ok('系统代理让「在用代理」判定成立', res.state.target.proxied, true);
ok('目标时区恢复', res.state.target.tz, 'Asia/Tokyo');

console.log('');
console.log('[阶段 10] GET_STATE / GET_ID 消息接口');
res = await send({ type: 'GET_STATE' });
truthy('GET_STATE 返回 state 和 settings', res.ok && res.state && res.settings);
ok('settings 里带着默认值', res.settings.refreshMinutes, 5);
res = await send({ type: 'GET_ID' });
ok('GET_ID 返回扩展 ID', res.id, chromeMock.runtime.id);
res = await send({ type: '不存在的类型' });
ok('未知消息被拒绝', res.ok, false);

console.log('');
console.log('[阶段 11] CDP 排除域名在批量应用和重载时都保持原生');
await send({ type: 'SET_SETTINGS', patch: { engine: 'cdp', manualTimezone: 'Asia/Tokyo', excludedDomains: [] } });
res = await send({ type: 'SET_SETTINGS', patch: { excludedDomains: ['example.com'] } });
ok('CDP 批量应用不接管排除域名', res.state.applied.cdp.ok, 0);
ok('已经接管的排除域名得到恢复', calls.cdpAttached.has(1), false);
const excludedCommandStart = calls.cdpCommands.length;
await listeners.tabsOnUpdated[0](1, { status: 'loading' }, { url: 'https://example.com/' });
ok('重载排除域名不会重新附着', calls.cdpAttached.has(1), false);
ok('重载排除域名没有目标覆盖命令', calls.cdpCommands.slice(excludedCommandStart).some(command => command.params?.timezoneId === 'Asia/Tokyo'), false);

console.log('');
console.log('[阶段 12] 外网检测尚未完成时关闭扩展，旧结果不能重新启用');
fetchMode = 'geo-ok';
await send({ type: 'SET_SETTINGS', patch: { engine: 'shim', enabled: true, manualTimezone: '', onlyWhenProxied: false, excludedDomains: [] } });
const ordinaryFetch = globalThis.fetch;
let releaseGeo;
let geoStarted;
const enteredGeo = new Promise(resolve => { geoStarted = resolve; });
globalThis.fetch = (url, options) => {
  if (String(url).includes('ipwho.is')) return new Promise(resolve => {
    releaseGeo = () => ordinaryFetch(url, options).then(resolve);
    geoStarted();
  });
  return ordinaryFetch(url, options);
};
const inFlight = send({ type: 'REFRESH', reason: 'test-slow-geo' });
await enteredGeo;
const disable = send({ type: 'SET_SETTINGS', patch: { enabled: false } });
await new Promise(resolve => setTimeout(resolve, 30));
ok('无需等待外网便清空同步开关', store.get('tzSync').enabled, false);
releaseGeo();
await Promise.all([inFlight, disable]);
globalThis.fetch = ordinaryFetch;
ok('旧检测完成后仍保持关闭', store.get('state').enabled, false);
ok('旧检测结果没有重新写入时区', store.get('tzSync').tz, '');
ok('关闭时撤销持久化补丁', calls.registeredScripts.has('tz-shim-main'), false);

console.log('');
console.log('[阶段 13] 已禁用的系统代理地址不能单独证明正在使用代理');
nativeReply = { processes: [], systemProxy: { enabled: false, server: '127.0.0.1:7897', pacUrl: '' } };
res = await send({ type: 'SET_SETTINGS', patch: { enabled: true, nativeProbe: true, localProbe: false, onlyWhenProxied: true } });
ok('残留地址不通过代理门槛', res.state.target.tz, '');
ok('状态明确报告未识别到代理', res.state.target.proxied, false);

console.log('');
console.log('[阶段 14] SW 唤醒读取旧缓存时关闭，bootstrap 不能重新启用');
store.set('settings', { enabled: true, engine: 'shim', manualTimezone: 'Asia/Tokyo', includedDomains: [], localProbe: false });
store.set('state', { enabled: true, engine: 'shim', updatedAt: Date.now(), target: { tz: 'Asia/Tokyo' } });
const unblockedGet = chromeMock.storage.local.get;
let settingsReads = 0;
let enterWake;
let releaseWake;
const wakeEntered = new Promise(resolve => { enterWake = resolve; });
const wakeGate = new Promise(resolve => { releaseWake = resolve; });
chromeMock.storage.local.get = async key => {
  const snapshot = JSON.parse(JSON.stringify(await unblockedGet(key)));
  if (key === 'settings' && ++settingsReads === 2) { enterWake(); await wakeGate; }
  return snapshot;
};
await import('../src/background.js?test=wake-race');
await wakeEntered;
await new Promise(resolve => listeners.onMessage.at(-1)({ type: 'SET_SETTINGS', patch: { enabled: false } }, {}, resolve));
ok('唤醒阻塞期间关闭已完成', store.get('tzSync').enabled, false);
releaseWake();
await new Promise(resolve => setTimeout(resolve, 30));
chromeMock.storage.local.get = unblockedGet;
ok('唤醒继续后保持关闭', store.get('tzSync').enabled, false);
ok('唤醒继续后没有残留注册', calls.registeredScripts.has('tz-shim-main'), false);

console.log('');
console.log('[阶段 15] 自动检测清空目标时的并发导航不能重新挂回旧 CDP 时区');
const sendLatest = message => new Promise(resolve => listeners.onMessage.at(-1)(message, {}, resolve));
await sendLatest({ type: 'SET_SETTINGS', patch: { enabled: true, engine: 'cdp', manualTimezone: 'America/New_York',
  includedDomains: [], excludedDomains: [], onlyWhenProxied: false, countryFallback: false, localProbe: false,
  exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace', allowGenericExit: false } });
const ordinaryDetach = chromeMock.debugger.detach;
let enterDetach;
let releaseDetach;
let blockNextDetach = true;
const detachEntered = new Promise(resolve => { enterDetach = resolve; });
const detachGate = new Promise(resolve => { releaseDetach = resolve; });
chromeMock.debugger.detach = async target => {
  if (blockNextDetach) { blockNextDetach = false; enterDetach(); await detachGate; }
  return ordinaryDetach(target);
};
const clearingTarget = sendLatest({ type: 'SET_SETTINGS', patch: { manualTimezone: '' } });
await detachEntered;
const concurrentNavigation = listeners.navOnCommitted.at(-1)({ tabId: 1, frameId: 0, url: 'https://example.com/' });
await new Promise(resolve => setTimeout(resolve, 10));
releaseDetach();
await Promise.all([clearingTarget, concurrentNavigation]);
chromeMock.debugger.detach = ordinaryDetach;
ok('检测结果已清空目标', store.get('state').target.tz, '');
ok('同步值已清空目标', store.get('tzSync').tz, '');
ok('并发导航没有重新接管旧时区', calls.cdpAttached.has(1), false);

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
void realFetch;
void assert;
process.exit(fail === 0 ? 0 : 1);
