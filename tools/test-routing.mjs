/** Chrome API 和网络只在边界替换，断言真实模块发出的配置、请求及恢复动作。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { lookupGeo } from '../src/detect/geo.js';

function chromeFixture() {
  const handlers = {};
  const event = name => ({ addListener(fn) { (handlers[name] ||= []).push(fn); } });
  const attached = new Set();
  const commands = [];
  const data = {};
  const storage = { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); } };
  return { handlers, attached, commands, api: {
    storage: { local: storage, session: storage },
    tabs: { async query() { return [{ id: 1, url: 'https://example.com/', discarded: false }]; } },
    debugger: {
      onEvent: event('event'), onDetach: event('detach'),
      async getTargets() { return []; },
      async attach(target) { attached.add(target.tabId); },
      async detach(target) { attached.delete(target.tabId); },
      async sendCommand(target, method, params) {
        if (!attached.has(target.tabId)) throw new Error('Debugger is not attached');
        commands.push({ ...target, method, params }); return {};
      }
    }
  } };
}
test('桥接在 CDP 模式发送撤销消息，不发送补丁时区', async () => {
  const messages = [];
  const window = { postMessage(value) { messages.push(value); } };
  const context = { window, location: { hostname: 'chatgpt.com' }, document: { documentElement: {
    setAttribute() {}, removeAttribute() {}
  } }, chrome: { storage: { local: { async get() { return { tzSync: {
    tz: 'Asia/Tokyo', enabled: true, engine: 'cdp', excluded: [], included: []
  } }; } }, onChanged: { addListener() {} } } } };
  vm.runInNewContext(fs.readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).tz, null);
});
test('CDP 批量应用跳过并恢复被排除的标签页', async () => {
  const f = chromeFixture(); globalThis.chrome = f.api;
  const cdp = await import('../src/tz/cdp.js?test=exclude');
  await cdp.setTimezoneForTab(1, 'Asia/Tokyo');
  f.commands.length = 0;
  const result = await cdp.applyToAllTabs('Asia/Tokyo', { excludedDomains: ['example.com'], includedDomains: [] });
  assert.equal(result.ok, 0);
  assert.equal(f.attached.has(1), false);
  assert.equal(f.commands.some(c => c.params?.timezoneId === 'Asia/Tokyo'), false);
});
test('CDP 子目标先配置时区，再恢复暂停执行', async () => {
  const f = chromeFixture(); globalThis.chrome = f.api;
  const cdp = await import('../src/tz/cdp.js?test=children');
  cdp.watchDetach();
  await cdp.setTimezoneForTab(1, 'Asia/Tokyo', { cdpAllFrames: true, excludedDomains: [] });
  assert.ok(f.commands.some(c => c.method === 'Target.setAutoAttach'));
  const handler = f.handlers.event[0];
  await handler({ tabId: 1 }, 'Target.attachedToTarget', {
    sessionId: 'child-1', targetInfo: { type: 'iframe', url: 'https://child.example/' }, waitingForDebugger: true
  });
  const child = f.commands.filter(c => c.sessionId === 'child-1');
  assert.equal(child[0].method, 'Emulation.setTimezoneOverride');
  assert.equal(child.at(-1).method, 'Runtime.runIfWaitingForDebugger');
});
test('目标网站出口查询后按明确的 IP 定位，不用查询接口自己的出口', async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), credentials: options.credentials });
    if (String(url) === 'https://chatgpt.com/cdn-cgi/trace') return new Response('h=chatgpt.com\nip=203.0.113.8\nloc=US\n');
    if (String(url) === 'https://ipwho.is/203.0.113.8') return Response.json({ ip: '203.0.113.8', timezone: { id: 'America/Los_Angeles' }, country_code: 'US' });
    return Response.json({ ip: '203.0.113.9', timezone: { id: 'Asia/Tokyo' }, country_code: 'JP' });
  };
  try {
    const result = await lookupGeo({ exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace', allowGenericExit: false });
    assert.equal(result.ip, '203.0.113.8');
    assert.equal(result.timezone, 'America/Los_Angeles');
    assert.equal(result.exitVerified, true);
    assert.equal(calls[0].credentials, 'omit');
    assert.equal(calls[1].url, 'https://ipwho.is/203.0.113.8');
  } finally { globalThis.fetch = savedFetch; }
});
test('目标出口无法确认时，不静默使用公共查询接口的出口', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('blocked', { status: 403 });
  try {
    const result = await lookupGeo({ exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace', allowGenericExit: false });
    assert.equal(result.ok, false);
    assert.equal(result.exitVerified, false);
    assert.match(result.warning, /出口/);
    assert.equal(result.attempts.length, 1);
  } finally { globalThis.fetch = savedFetch; }
});

test('城市地理接口全失败时保留目标 trace 的国家与 IP', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/cdn-cgi/trace')
    ? new Response('h=chatgpt.com\nip=203.0.113.8\nloc=SG\ncolo=NRT\n')
    : new Response('unavailable', { status: 503 });
  try {
    const result = await lookupGeo();
    assert.equal(result.ok, true);
    assert.equal(result.ip, '203.0.113.8');
    assert.equal(result.countryCode, 'SG');
    assert.equal(result.timezone, '');
    assert.equal(result.source, 'target-trace');
    assert.equal(result.exitVerified, true);
    assert.ok(result.attempts.some(item => !item.ok));
  } finally { globalThis.fetch = savedFetch; }
});

test('trace 没有有效国家时仍显示已确认 IP，不把机房 colo 当成出口国家', async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const loc of ['', 'XX', 'T1', 'Singapore']) {
      globalThis.fetch = async url => String(url).includes('/cdn-cgi/trace')
        ? new Response('h=chatgpt.com\nip=203.0.113.8\nloc=' + loc + '\ncolo=SIN\n')
        : new Response('unavailable', { status: 503 });
      const result = await lookupGeo();
      assert.equal(result.ok, false, loc);
      assert.equal(result.ip, '203.0.113.8', loc);
      assert.equal(result.exitVerified, true, loc);
      assert.equal(result.countryCode || '', '', loc);
    }
  } finally { globalThis.fetch = savedFetch; }
});

test('trace 的国家不能覆盖后续接口提供的精确城市时区', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/cdn-cgi/trace')
    ? new Response('h=chatgpt.com\nip=203.0.113.8\nloc=SG\n')
    : Response.json({ ip: '203.0.113.8', country_code: 'SG', timezone: { id: 'Asia/Singapore' } });
  try {
    const result = await lookupGeo();
    assert.equal(result.timezone, 'Asia/Singapore');
    assert.equal(result.source, 'ipwho.is');
  } finally { globalThis.fetch = savedFetch; }
});

test('域名不匹配或 IP 无效时不接受 trace 国家兜底', async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const payload of ['h=elsewhere.test\nip=203.0.113.8\nloc=SG\n', 'h=chatgpt.com\nip=invalid\nloc=SG\n']) {
      globalThis.fetch = async () => new Response(payload);
      const result = await lookupGeo();
      assert.equal(result.ok, false);
      assert.equal(result.exitVerified, false);
      assert.equal(result.countryCode || '', '');
    }
  } finally { globalThis.fetch = savedFetch; }
});
test('地理接口的空 JSON 不阻止下一接口返回有效时区', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('ipwho.is') ? Response.json({})
    : Response.json({ ip: '203.0.113.9', timezone: 'Asia/Tokyo', country_code: 'JP' });
  try {
    const result = await lookupGeo({ exitProbeUrl: '', allowGenericExit: true });
    assert.equal(result.timezone, 'Asia/Tokyo');
    assert.equal(result.source, 'ipapi.co');
  } finally { globalThis.fetch = savedFetch; }
});

test('持久化启动脚本在页面首次同步读取前已经配置时区', async () => {
  const registered = [];
  globalThis.chrome = { scripting: {
    async getRegisteredContentScripts() { return []; },
    async registerContentScripts(scripts) { registered.push(...scripts); },
    async unregisterContentScripts() {}
  } };
  const shim = await import('../src/tz/shim.js');
  await shim.syncRegistration({ tz: 'America/New_York', enabled: true, engine: 'shim', included: ['chatgpt.com'], excluded: ['billing.chatgpt.com'] });
  const main = registered.find(script => script.world === 'MAIN');
  assert.equal(main.runAt, 'document_start');
  assert.equal(main.persistAcrossSessions, true);
  assert.ok(main.excludeMatches.includes('*://*.billing.chatgpt.com/*'));
  const script = main.js.map(file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')).join('\n');
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-'], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' }, input:
    `globalThis.window=globalThis; globalThis.addEventListener=()=>{}; globalThis.document={documentElement:null};\n${script}\nconsole.log(JSON.stringify([Intl.DateTimeFormat().resolvedOptions().timeZone,new Date(0).getTime()]));` });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), ['America/New_York', 0]);
});

test('启动脚本更新失败时撤销旧时区注册，避免新页面继续读旧种子', async () => {
  const scripts = new Map([['tz-shim-main', { id: 'tz-shim-main' }]]);
  globalThis.chrome = { scripting: {
    async getRegisteredContentScripts() { return [...scripts.values()]; },
    async updateContentScripts() { throw new Error('更新失败'); },
    async unregisterContentScripts({ ids }) { ids.forEach(id => scripts.delete(id)); }
  } };
  const shim = await import('../src/tz/shim.js');
  await assert.rejects(shim.syncRegistration({ tz: 'Asia/Tokyo', enabled: true, engine: 'shim', included: [], excluded: [] }));
  assert.equal(scripts.size, 0);
});
test('并发接管记录在后台重启后仍能全部恢复', async () => {
  const f = chromeFixture(); globalThis.chrome = f.api;
  const first = await import('../src/tz/cdp.js?test=ownership-before');
  await Promise.all([first.setTimezoneForTab(1, 'Asia/Tokyo'), first.setTimezoneForTab(2, 'Asia/Tokyo')]);
  const restarted = await import('../src/tz/cdp.js?test=ownership-after');
  await restarted.restoreAllTabs();
  assert.equal(f.attached.size, 0);
});
test('新增子域名例外后，已经连接的独立 iframe 会话得到恢复', async () => {
  const f = chromeFixture(); globalThis.chrome = f.api;
  const cdp = await import('../src/tz/cdp.js?test=existing-child-exclusion');
  cdp.watchDetach();
  await cdp.setTimezoneForTab(1, 'America/New_York', { excludedDomains: [] });
  await f.handlers.event[0]({ tabId: 1 }, 'Target.attachedToTarget', {
    sessionId: 'billing', targetInfo: { type: 'iframe', url: 'https://billing.chatgpt.com/' }, waitingForDebugger: true
  });
  f.commands.length = 0;
  await cdp.applyToAllTabs('America/New_York', { excludedDomains: ['billing.chatgpt.com'], includedDomains: [] });
  const overrides = f.commands.filter(command => command.sessionId === 'billing' && command.method === 'Emulation.setTimezoneOverride');
  assert.equal(overrides.at(-1)?.params.timezoneId, '');
});
