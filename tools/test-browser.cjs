/** 可选真实浏览器检查。需要 playwright-core 和支持加载扩展的 Chromium。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, 'timezone-auto-switch-test-'));
const artifacts = path.join(root, 'output', 'playwright');
fs.mkdirSync(artifacts, { recursive: true });
let context;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', req.url === '/worker.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  if (req.url === '/worker.js') return res.end("postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset()})");
  const port = server.address().port;
  res.end(`<!doctype html><meta charset="utf-8"><title>时区实机检查</title>
<script>window.firstTZ=Intl.DateTimeFormat().resolvedOptions().timeZone;window.savedDate=new Date('2024-06-01T12:00:00Z');window.savedConstructor=Date;</script>
<h1>时区实机检查</h1>${req.url === '/frame' ? '' : `<iframe src="http://frame.test:${port}/frame"></iframe>`}`);
});
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log('通过：' + name);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
      '--host-resolver-rules=MAP tz.test 127.0.0.1,MAP frame.test 127.0.0.1,MAP excluded.test 127.0.0.1,MAP open.test 127.0.0.1',
      `--proxy-server=${process.env.TIMEZONE_TEST_PROXY || 'http://127.0.0.1:1'}`, '--proxy-bypass-list=*.test;localhost;127.0.0.1']
  });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const toolbarErrors = [];
  worker.on('console', message => { if (message.text().includes('工具栏状态更新失败')) toolbarErrors.push(message.text()); });
  const id = new URL(worker.url()).hostname;
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${id}/src/options/options.html`);
  const systemTz = await optionsPage.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  async function settings(patch) {
    const result = await optionsPage.evaluate(patch => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch }), patch);
    assert.equal(result.ok, true, result.error); return result;
  }
  await settings({ enabled: true, engine: 'shim', manualTimezone: 'America/New_York', localProbe: false,
    includedDomains: ['tz.test', 'frame.test'], excludedDomains: ['excluded.test'], onlyWhenProxied: false });
  check('工具栏清空城市角标并明确报告开启', await optionsPage.evaluate(async () => [
    await chrome.action.getBadgeText({}), (await chrome.action.getTitle({})).includes('已开启')
  ]), ['', true]);
  const toolbarPreview = await optionsPage.evaluate(async () => {
    const { switchIcons } = await import('./../common/toolbar.js');
    const canvas = new OffscreenCanvas(320, 76);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, 0, 320, 76);
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    [['on', '开启'], ['off', '关闭'], ['waiting', '等待时区'], ['error', '应用异常']].forEach(([mode, label], index) => {
      const icon = new OffscreenCanvas(32, 32);
      icon.getContext('2d').putImageData(switchIcons(mode)[32], 0, 0);
      ctx.drawImage(icon, index * 80 + 24, 8);
      ctx.fillStyle = '#334155'; ctx.fillText(label, index * 80 + 40, 62);
    });
    return btoa(String.fromCharCode(...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())));
  });
  fs.writeFileSync(path.join(artifacts, 'toolbar-preview.png'), Buffer.from(toolbarPreview, 'base64'));
  const page = await context.newPage();
  await page.goto(`http://tz.test:${port}/`);
  check('真实页面首次同步读取即为纽约', await page.evaluate(() => firstTZ), 'America/New_York');
  check('真实页面日期与显式 UTC 语义', await page.evaluate(() => [savedDate.getTime(), savedDate.getHours(),
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions().timeZone,
    savedDate.toLocaleTimeString('en-US')]), [1717243200000, 8, 'UTC', '8:00:00 AM']);
  const excluded = await context.newPage();
  await excluded.goto(`http://excluded.test:${port}/`);
  check('排除域名保持系统时区', await excluded.evaluate(() => firstTZ), systemTz);
  await settings({ manualTimezone: 'Asia/Tokyo' });
  check('运行中切换保持已有日期真实时刻', await page.evaluate(() => [savedDate.getTime(), savedDate.getHours()]), [1717243200000, 21]);
  await settings({ enabled: false });
  check('关闭后工具栏仍无文字且明确报告关闭', await optionsPage.evaluate(async () => [
    await chrome.action.getBadgeText({}), (await chrome.action.getTitle({})).includes('已关闭')
  ]), ['', true]);
  check('关闭后恢复系统时区且时间戳不变', await page.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, savedDate.getTime()]), [systemTz, 1717243200000]);
  const cdp = await settings({ enabled: true, engine: 'cdp', manualTimezone: 'America/New_York' });
  check('CDP 根页面成功接管', cdp.state.applied.cdp.failed, 0);
  check('CDP 根页面时区', await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York');
  check('CDP 恢复了 JS 构造函数引用', await page.evaluate(() => Date === savedConstructor), false);
  const frame = page.frames().find(frame => frame.url().includes('frame.test'));
  check('CDP 跨站 iframe 时区', await frame.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York');
  const workerResult = await page.evaluate(() => new Promise(resolve => {
    const worker = new Worker('/worker.js');
    const timer = setTimeout(() => { worker.terminate(); resolve({ error: 'timeout' }); }, 5000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); resolve({ error: event.message }); };
  }));
  console.log('真实 Worker 结果：' + JSON.stringify(workerResult));
  check('当前 Chromium 的专用 Worker 时区', workerResult.timezone, 'America/New_York');
  const live = await optionsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  console.log('真实 CDP 覆盖：' + JSON.stringify(live.coverage));
  await settings({ excludedDomains: ['excluded.test', 'frame.test'] });
  check('新增例外恢复已经连接的跨站 iframe', await frame.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), systemTz);
  check('子目标排除后父页面继续使用目标时区', await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York');
  await settings({ excludedDomains: ['excluded.test'] });
  check('取消例外后已有子会话重新覆盖', await frame.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York');
  check('CDP 排除页面未接管', await excluded.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), systemTz);
  await page.goto(`http://excluded.test:${port}/`);
  check('CDP 导航进入例外域名后恢复', await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), systemTz);
  await optionsPage.reload();
  await optionsPage.screenshot({ path: path.join(artifacts, 'options.png'), fullPage: true });
  // 重现用户新截图：外部地理接口全失败，仅目标站点 trace 返回 SG。
  // 只替换网络边界；后台判定、脚本注册、真实网页和弹窗仍运行扩展实际代码。
  await worker.evaluate(() => {
    globalThis.__countryTestFetch = globalThis.fetch;
    globalThis.fetch = async url => {
      const value = String(url);
      if (value === 'https://chatgpt.com/cdn-cgi/trace') {
        return new Response('h=chatgpt.com\nip=203.0.113.9\nloc=SG\n');
      }
      throw new TypeError('受控测试：外部地理接口不可用');
    };
  });
  try {
    const automatic = await settings({ enabled: true, engine: 'shim', manualTimezone: '', localProbe: false,
      onlyWhenProxied: false, countryFallback: false, allowGenericExit: false,
      exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace' });
    check('仅国家结果也能确认目标出口', automatic.state.geo.exitVerified, true);
    check('自动判定新加坡且区别于主要城市猜测',
      [automatic.state.target.tz, automatic.state.target.source], ['Asia/Singapore', 'geo-single-timezone']);
    check('所有地理接口失败时使用目标站点国家', automatic.state.geo.source, 'target-trace');
    await page.goto(`http://tz.test:${port}/`);
    check('自动检测后真实网页首次读取为新加坡', await page.evaluate(() => firstTZ), 'Asia/Singapore');
    check('新加坡日期偏移为 UTC+8', await page.evaluate(() => new Date().getTimezoneOffset()), -480);
    check('新加坡状态在工具栏完整显示', await optionsPage.evaluate(async () =>
      (await chrome.action.getTitle({})).includes('Asia/Singapore')), true);
    // 用长端口列表检查折叠后的真实布局；不修改前面已经得到的时区应用结果。
    await optionsPage.evaluate(state => chrome.storage.local.set({ state: { ...state,
      openPorts: Array.from({ length: 50 }, (_, index) => ({ port: 10800 + index, state: 'open-unknown' }))
    } }), automatic.state);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 390, height: 700 });
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    await popup.locator('#targetTz').filter({ hasText: 'Asia/Singapore' }).waitFor();
    check('弹窗显示新加坡时区且开关开启',
      [await popup.locator('#targetTz').textContent(), await popup.locator('#enabled').isChecked()], ['Asia/Singapore', true]);
    check('长诊断内容默认折叠', await popup.locator('#diagnostics').evaluate(node => node.open), false);
    check('折叠时端口列表不可见', await popup.locator('#ports').isVisible(), false);
    check('折叠状态直接看到操作按钮', await popup.locator('#refreshBtn').evaluate(node => node.getBoundingClientRect().bottom < 600), true);
    await popup.screenshot({ path: path.join(artifacts, 'trace-only-singapore.png'), fullPage: true, animations: 'disabled' });
    await popup.locator('#diagnostics > summary').click();
    check('展开后仍能查看所有端口', [await popup.locator('#ports').isVisible(), await popup.locator('#ports .port').count()], [true, 50]);
    check('展开后显示接口具体失败原因', (await popup.locator('#geoAttempts').textContent()).includes('外部地理接口不可用'), true);
    await popup.locator('#diagnostics > summary').click();
    check('诊断区可以重新折叠', await popup.locator('#ports').isVisible(), false);
    await popup.close();
  } finally {
    await worker.evaluate(() => {
      globalThis.fetch = globalThis.__countryTestFetch;
      delete globalThis.__countryTestFetch;
    });
  }
  if (process.env.TIMEZONE_TEST_PROXY) {
    // 可选实网检查：独立浏览器配置通过指定代理运行，仍不读取用户登录和浏览器配置。
    const live = await settings({ manualTimezone: '', localProbe: false });
    console.log('实网出口：' + JSON.stringify({ ip: live.state.geo.ip, countryCode: live.state.geo.countryCode,
      source: live.state.geo.source, timezone: live.state.target.tz }));
    check('实网目标出口已确认', live.state.geo.exitVerified, true);
    check('实网选择预期时区', live.state.target.tz, process.env.TIMEZONE_TEST_EXPECTED_TZ || 'Asia/Singapore');
    await page.goto(`http://tz.test:${port}/`);
    check('实网检测结果同步到真实网页首次读取', await page.evaluate(() => firstTZ), live.state.target.tz);
    const livePopup = await context.newPage();
    await livePopup.setViewportSize({ width: 390, height: 600 });
    await livePopup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    await livePopup.locator('#targetTz').filter({ hasText: live.state.target.tz }).waitFor();
    await livePopup.screenshot({ path: path.join(artifacts, 'live-singapore.png'), fullPage: true, animations: 'disabled' });
    await livePopup.close();
  }
  check('工具栏绘制与 Chrome action API 无异常', toolbarErrors, []);
  console.log('浏览器版本：' + context.browser().version());
  console.log('真实浏览器检查完成');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('timezone-auto-switch-test-')) fs.rmSync(resolved, { recursive: true, force: true });
});
