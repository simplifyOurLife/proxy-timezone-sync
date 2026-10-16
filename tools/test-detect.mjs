/**
 * 探测层 / 时区工具的单元测试（纯逻辑，不需要浏览器）
 * 用法：node tools/test-detect.mjs
 */

import {
  PROXY_SOFTWARE,
  DEFAULT_PROBE_PORTS,
  CHROME_BLOCKED_PORTS,
  GEO_ENDPOINTS
} from '../src/common/constants.js';
import { rankSoftware, collectProbePorts, apiCandidatePorts } from '../src/detect/proxy.js';
import { countryFromNodeName, flagToCountryCode } from '../src/detect/geo.js';
import { countryToTimezone, COUNTRY_TZ } from '../src/common/country-tz.js';
import {
  isValidTimeZone,
  tzOffsetMinutes,
  formatOffset,
  describeTimeZone,
  systemTimeZone
} from '../src/common/tz-util.js';
import { DEFAULT_SETTINGS, parseExtraPorts, isExcluded } from '../src/common/settings.js';

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
  ok(name, Boolean(got), true);
}

console.log('[指纹库]');
truthy('至少 12 款代理软件', PROXY_SOFTWARE.length >= 12);
truthy('每款都有 id / name / ports', PROXY_SOFTWARE.every((s) => s.id && s.name && Array.isArray(s.ports)));
truthy('id 不重复', new Set(PROXY_SOFTWARE.map((s) => s.id)).size === PROXY_SOFTWARE.length);
truthy('默认端口列表不含 Chrome 禁用端口', DEFAULT_PROBE_PORTS.every((p) => !CHROME_BLOCKED_PORTS.has(p)));
truthy('默认端口包含 clash 7890', DEFAULT_PROBE_PORTS.includes(7890));
truthy('默认端口包含 10809', DEFAULT_PROBE_PORTS.includes(10809));
truthy('默认端口包含 7897（Clash Verge）', DEFAULT_PROBE_PORTS.includes(7897));
truthy('默认端口不含 10080（Chrome 禁用）', !DEFAULT_PROBE_PORTS.includes(10080));

console.log('');
console.log('[软件识别打分]');

// 1. Clash 控制台 API 命中 —— 最强证据
const clashApi = rankSoftware({
  portResults: [{ port: 9090, state: 'http', code: 200 }],
  apiResults: [
    {
      port: 9090,
      kind: 'clash-api',
      version: '1.18.1',
      meta: true,
      ports: { mixedPort: 7897, port: 7890, socksPort: 0 }
    }
  ],
  proxyConfig: { mode: 'system', endpoints: [] }
});
ok('控制台命中 → 首选 mihomo', clashApi.primary && clashApi.primary.id, 'mihomo');
ok('控制台命中 → 高置信', clashApi.primary && clashApi.primary.confidence, 'high');
truthy('证据里有 api 来源', clashApi.primary.evidence.some((e) => e.source === 'api'));

// 2. 端口 + 进程名 —— 最强证据组合
const verge = rankSoftware({
  portResults: [{ port: 7897, state: 'http', code: 400 }],
  apiResults: [],
  proxyConfig: { mode: 'system', endpoints: [] },
  processes: [{ name: 'clash-verge.exe', pid: 1234, path: 'C:\\Program Files\\Clash Verge\\clash-verge.exe' }]
});
ok('进程 + 端口 → clash-verge', verge.primary && verge.primary.id, 'clash-verge');
ok('高置信', verge.primary.confidence, 'high');
truthy('证据里有进程名', verge.primary.evidence.some((e) => e.source === 'process' && /clash-verge/.test(e.detail)));

// 3. 只有浏览器代理配置指向本机端口
const fromConfig = rankSoftware({
  portResults: [],
  apiResults: [],
  proxyConfig: {
    mode: 'fixed_servers',
    endpoints: [{ kind: 'single', host: '127.0.0.1', port: 10809, scheme: 'http' }]
  }
});
ok('配置端口 10809 → v2rayN', fromConfig.primary && fromConfig.primary.id, 'v2rayn');
ok('中等置信', fromConfig.primary.confidence, 'medium');

// 4. SOCKS 端口（没回 HTTP）也能识别
const socksOnly = rankSoftware({
  portResults: [{ port: 10808, state: 'open-unknown' }],
  apiResults: [],
  proxyConfig: { mode: 'system', endpoints: [] }
});
ok('SOCKS 10808 → v2rayN', socksOnly.primary && socksOnly.primary.id, 'v2rayn');

// 5. 什么都没探测到
const nothing = rankSoftware({ portResults: [], apiResults: [], proxyConfig: { mode: 'direct', endpoints: [] } });
ok('什么都没探到 → primary 为 null', nothing.primary, null);
ok('候选列表为空', nothing.candidates.length, 0);

// 6. 关闭的端口不算证据
const closedOnly = rankSoftware({
  portResults: [{ port: 7890, state: 'closed' }],
  apiResults: [],
  proxyConfig: { mode: 'direct', endpoints: [] }
});
ok('关闭的端口不算证据', closedOnly.primary, null);

// 7. 多证据并存时排序正确
const mixed = rankSoftware({
  portResults: [
    { port: 7897, state: 'http' },
    { port: 10809, state: 'http' }
  ],
  apiResults: [{ port: 9097, kind: 'clash-api', version: '1.19.0', meta: true }],
  proxyConfig: { mode: 'system', endpoints: [] },
  processes: [{ name: 'clash-verge.exe', pid: 1 }]
});
ok('多个候选时首选仍是 clash 系', /clash|mihomo/.test(mixed.primary.id), true);
truthy('候选按分数降序', mixed.candidates.every((c, i) => i === 0 || mixed.candidates[i - 1].score >= c.score));

console.log('');
console.log('[节点名 → 国家]');
ok('国旗 emoji 🇯🇵', flagToCountryCode('🇯🇵 日本 IEPL 01'), 'JP');
ok('国旗 emoji 🇺🇸', flagToCountryCode('🇺🇸 US-Relay'), 'US');
ok('无国旗返回空', flagToCountryCode('Relay-01'), '');
ok('中文国名', countryFromNodeName('香港 01 中转'), 'HK');
ok('英文国名', countryFromNodeName('Tokyo Premium'), 'JP');
ok('城市名', countryFromNodeName('洛杉矶 GIA'), 'US');
ok('缩写', countryFromNodeName('SG-Basic'), 'SG');
ok('认不出来就空', countryFromNodeName('Node-9f3a'), '');
ok('国旗优先于文字', countryFromNodeName('🇩🇪 法兰克福'), 'DE');
ok('null 安全', countryFromNodeName(null), '');

console.log('');
console.log('[国家 → 时区兜底表]');
ok('JP', countryToTimezone('JP'), 'Asia/Tokyo');
ok('HK', countryToTimezone('HK'), 'Asia/Hong_Kong');
ok('US', countryToTimezone('US'), 'America/New_York');
ok('GB', countryToTimezone('GB'), 'Europe/London');
ok('小写也认', countryToTimezone('jp'), 'Asia/Tokyo');
ok('未知国家返回空', countryToTimezone('ZZ'), '');
ok('空值安全', countryToTimezone(''), '');
truthy('表里所有时区都合法', Object.values(COUNTRY_TZ).every((tz) => isValidTimeZone(tz)));

console.log('');
console.log('[时区工具]');
truthy('Asia/Tokyo 合法', isValidTimeZone('Asia/Tokyo'));
truthy('乱写的字符串非法', !isValidTimeZone('Not/AZone'));
truthy('空值非法', !isValidTimeZone(''));
ok('东京偏移 540', tzOffsetMinutes('Asia/Tokyo', Date.UTC(2024, 5, 1)), 540);
ok('纽约夏令时偏移 -240', tzOffsetMinutes('America/New_York', Date.UTC(2024, 5, 1)), -240);
ok('纽约冬令时偏移 -300', tzOffsetMinutes('America/New_York', Date.UTC(2024, 0, 15)), -300);
ok('伦敦夏令时偏移 60', tzOffsetMinutes('Europe/London', Date.UTC(2024, 5, 1)), 60);
ok('UTC 偏移 0', tzOffsetMinutes('UTC', Date.UTC(2024, 5, 1)), 0);
ok('加德满都 +5:45', tzOffsetMinutes('Asia/Kathmandu', Date.UTC(2024, 5, 1)), 345);
ok('偏移格式化 +09:00', formatOffset(540), 'GMT+09:00');
ok('偏移格式化 -04:30', formatOffset(-270), 'GMT-04:30');
ok('偏移格式化 +05:45', formatOffset(345), 'GMT+05:45');
const d = describeTimeZone('Asia/Tokyo');
truthy('describeTimeZone 结构完整', d.valid && d.offsetMinutes === 540 && /GMT\+09:00/.test(d.offsetText) && d.localTime);
truthy('systemTimeZone 返回合法时区', isValidTimeZone(systemTimeZone()));

console.log('');
console.log('[设置工具]');
ok('默认引擎是 shim', DEFAULT_SETTINGS.engine, 'shim');
ok('默认开启', DEFAULT_SETTINGS.enabled, true);
ok('端口解析：逗号', parseExtraPorts('8080, 9090'), [8080, 9090]);
ok('端口解析：中文逗号 / 空格 / 换行', parseExtraPorts('8080，9090 1234\n5678'), [8080, 9090, 1234, 5678]);
ok('端口解析：过滤非法值', parseExtraPorts('0, 70000, abc, 8080'), [8080]);
ok('端口解析：空值', parseExtraPorts(''), []);
ok('排除域名：精确', isExcluded('a.com', ['a.com']), true);
ok('排除域名：子域', isExcluded('x.a.com', ['a.com']), true);
ok('排除域名：通配', isExcluded('x.a.com', ['*.a.com']), true);
ok('排除域名：不匹配', isExcluded('b.com', ['a.com']), false);
ok('排除域名：大小写无关', isExcluded('A.COM', ['a.com']), true);

console.log('');
console.log('[地理接口定义]');
truthy('至少 5 个接口', GEO_ENDPOINTS.length >= 5);
truthy('每个都有 url / parse', GEO_ENDPOINTS.every((e) => e.url && typeof e.parse === 'function'));
ok('ipwho.is 解析', GEO_ENDPOINTS[0].parse({ success: true, ip: '1.2.3.4', country_code: 'JP', timezone: { id: 'Asia/Tokyo' } }).timezone, 'Asia/Tokyo');
ok('空地理响应不能误判为成功', GEO_ENDPOINTS[0].parse({}), null);
truthy('地理接口使用 HTTPS', GEO_ENDPOINTS.every(e => e.url.startsWith('https://')));
ok('country.is 只有国家', GEO_ENDPOINTS.find((e) => e.id === 'country.is').parse({ ip: '1.2.3.4', country: 'DE' }).countryCode, 'DE');

console.log('');
console.log('[端口与设置联动]');
ok('collectProbePorts 含附加端口', collectProbePorts({ extraProbePorts: '12345' }).includes(12345), true);
truthy('apiCandidatePorts 不含禁用端口', apiCandidatePorts({ extraProbePorts: '10080' }).every((p) => !CHROME_BLOCKED_PORTS.has(p)));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
