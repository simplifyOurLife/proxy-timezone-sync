/**
 * 出口 IP → 地理位置 / 时区
 * ------------------------------------------------------------------
 * 优先观测目标网站 trace 请求的出口，然后把这个明确 IP 交给地理接口。
 * 分流可以按域名、路径、IP 家族变化，结果只代表此次探测请求。
 */

import { GEO_ENDPOINTS, GEO_TIMEOUT_MS } from '../common/constants.js';
import { isValidTimeZone } from '../common/tz-util.js';

function normalizedIP(value) {
  if (typeof value !== 'string') return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').every(x => +x <= 255) ? value : '';
  if (!/^[a-f\d:]+$/i.test(value) || !value.includes(':')) return '';
  try { return new URL(`https://[${value}]/`).hostname.slice(1, -1); } catch { return ''; }
}

/** 不携带登录凭据，也不跟随到另一个域名，避免把其他站点的出口当成目标出口。 */
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/**
 * 依次尝试各个地理接口，第一个成功解析的就返回。
 * @returns {Promise<{ok:boolean, attempts:Array, ip?:string, timezone?:string, countryCode?:string}>}
 */
export async function lookupGeo({ timeoutMs = GEO_TIMEOUT_MS, endpoints = GEO_ENDPOINTS,
  exitProbeUrl = 'https://chatgpt.com/cdn-cgi/trace', allowGenericExit = false } = {}) {
  const attempts = [];
  let targetIP = '';
  let traceCountry = '';
  let probeHost = '';
  let warning = '';
  if (exitProbeUrl) {
    const t0 = Date.now();
    try {
      const url = new URL(exitProbeUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('出口探测地址必须是无凭据的 HTTPS 地址');
      probeHost = url.hostname;
      const text = await fetchText(url.href, timeoutMs);
      const fields = Object.fromEntries(text.trim().split(/\r?\n/).filter(line => line.includes('=')).map(line => {
        const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
      }));
      if (fields.h && fields.h.toLowerCase() !== probeHost.toLowerCase()) throw new Error('trace 响应的域名不匹配');
      targetIP = normalizedIP(fields.ip);
      if (!targetIP) throw new Error('trace 未返回有效 IP');
      // loc 是出口国家，colo 是 Cloudflare 机房；不能把机房城市当作出口位置。
      if (/^[A-Z]{2}$/.test(fields.loc || '') && fields.loc !== 'XX') traceCountry = fields.loc;
      attempts.push({ id: 'target-exit', ok: true, ms: Date.now() - t0 });
    } catch (e) {
      warning = `无法确认 ${probeHost || '目标网站'} 的出口：${e.name === 'AbortError' ? '超时' : e.message}`;
      attempts.push({ id: 'target-exit', ok: false, reason: warning, ms: Date.now() - t0 });
    }
  } else warning = '未配置目标网站出口探测地址';
  if (!targetIP && !allowGenericExit) return { ok: false, exitVerified: false, probeHost, warning, attempts };
  if (!targetIP) warning += '；当前使用公共查询接口出口，不能证明与目标网站一致';
  let countryOnly = null;
  for (const ep of endpoints) {
    if (targetIP && !ep.urlForIP) continue;
    const t0 = Date.now();
    try {
      const text = await fetchText(targetIP ? ep.urlForIP(targetIP) : ep.url, timeoutMs);
      const parsed = ep.parse(JSON.parse(text));
      if (!parsed || !normalizedIP(parsed.ip)) throw new Error('字段解析失败');
      if (targetIP && normalizedIP(parsed.ip) !== targetIP) throw new Error('接口返回的 IP 与目标出口不一致');
      const hasTimezone = parsed.timezone && isValidTimeZone(parsed.timezone);
      if (!hasTimezone && !/^[A-Z]{2}$/.test(parsed.countryCode || '')) throw new Error('缺少有效时区或国家代码');
      attempts.push({ id: ep.id, ok: true, ms: Date.now() - t0 });
      const result = { ok: true, source: ep.id, sourceLabel: ep.label, attempts, ...parsed,
        timezone: hasTimezone ? parsed.timezone : '', exitVerified: Boolean(targetIP), probeHost, warning };
      if (hasTimezone) return result;
      countryOnly ||= result; // 国家结果不应阻止后续接口给出准确城市时区。
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      attempts.push({
        id: ep.id,
        ok: false,
        reason: aborted ? '超时' : String((e && e.message) || e),
        ms: Date.now() - t0
      });
    }
  }
  if (countryOnly) return countryOnly;
  if (targetIP && traceCountry) {
    return { ok: true, ip: targetIP, countryCode: traceCountry, timezone: '',
      source: 'target-trace', sourceLabel: `${probeHost} trace`, attempts,
      exitVerified: true, probeHost,
      warning: '外部地理接口未返回有效结果，使用目标站点 trace 的国家信息（不含城市）' };
  }
  // 出口已确认但定位失败时仍保留 IP，便于诊断和手动核对。
  return { ok: false, ip: targetIP, attempts, exitVerified: Boolean(targetIP), probeHost,
    warning: warning || (targetIP ? '已确认目标出口 IP，但未取得有效国家或时区；可在设置中手动指定时区' : '') };
}

/* ------------------------------------------------------------------ */
/* 节点名 / 旗帜 Emoji → 国家代码（地理接口全挂时的兜底线索）             */
/* ------------------------------------------------------------------ */

const NODE_KEYWORDS = [
  [/香港|hong\s?kong|\bhk\b|深港|沪港|京港/i, 'HK'],
  [/台湾|臺灣|taiwan|\btw\b|中華電信|彰化|新北|台北|台中|高雄/i, 'TW'],
  [/日本|japan|\bjp\b|东京|東京|大阪|tokyo|osaka|埼玉|京都|名古屋|软银|softbank|iij|kddi/i, 'JP'],
  [/韩国|韓國|korea|\bkr\b|首尔|首爾|seoul|sk\s?broadband|kt\s/i, 'KR'],
  [/新加坡|狮城|獅城|singapore|\bsg\b|坡县|新加坡/i, 'SG'],
  [/美国|美國|united\s?states|\bus\b|洛杉矶|los\s?angeles|硅谷|圣何塞|san\s?jose|西雅图|seattle|达拉斯|dallas|纽约|new\s?york|凤凰城|phoenix|芝加哥|chicago|迈阿密|miami|亚特兰大|atlanta|拉斯维加斯/i, 'US'],
  [/英国|英國|united\s?kingdom|london|\bgb\b|\buk\b|伦敦/i, 'GB'],
  [/德国|德國|germany|\bde\b|法兰克福|frankfurt|柏林|berlin/i, 'DE'],
  [/法国|法國|france|\bfr\b|巴黎|paris|马赛/i, 'FR'],
  [/荷兰|荷蘭|netherlands|\bnl\b|阿姆斯特丹|amsterdam/i, 'NL'],
  [/俄罗斯|俄羅斯|russia|moscow|莫斯科|\bru\b/i, 'RU'],
  [/加拿大|canada|toronto|多伦多|蒙特利尔|温哥华|vancouver|\bca\b/i, 'CA'],
  [/澳大利亚|澳洲|australia|sydney|悉尼|墨尔本|melbourne|\bau\b/i, 'AU'],
  [/印度|india|mumbai|孟买|\bin\b/i, 'IN'],
  [/土耳其|turkey|turkiye|istanbul|伊斯坦布尔|\btr\b/i, 'TR'],
  [/巴西|brazil|sao\s?paulo|圣保罗|\bbr\b/i, 'BR'],
  [/阿根廷|argentina|\bar\b/i, 'AR'],
  [/马来西亚|馬來西亞|malaysia|吉隆坡|kuala|\bmy\b/i, 'MY'],
  [/泰国|泰國|thailand|曼谷|bangkok|\bth\b/i, 'TH'],
  [/越南|vietnam|河内|胡志明|\bvn\b/i, 'VN'],
  [/菲律宾|菲律賓|philippines|马尼拉|manila|\bph\b/i, 'PH'],
  [/印尼|印度尼西亚|indonesia|雅加达|jakarta|\bid\b/i, 'ID'],
  [/阿联酋|迪拜|dubai|emirates|\bae\b/i, 'AE'],
  [/以色列|israel|tel\s?aviv|\bil\b/i, 'IL'],
  [/意大利|italy|米兰|milan|罗马|rome|\bit\b/i, 'IT'],
  [/西班牙|spain|马德里|madrid|\bes\b/i, 'ES'],
  [/瑞典|sweden|stockholm|\bse\b/i, 'SE'],
  [/瑞士|switzerland|zurich|\bch\b/i, 'CH'],
  [/波兰|poland|warsaw|\bpl\b/i, 'PL'],
  [/乌克兰|ukraine|kyiv|kiev|\bua\b/i, 'UA'],
  [/南非|south\s?africa|johannesburg|\bza\b/i, 'ZA'],
  [/埃及|egypt|cairo|\beg\b/i, 'EG'],
  [/墨西哥|mexico|\bmx\b/i, 'MX'],
  [/智利|chile|santiago|\bcl\b/i, 'CL']
];

/** 把国旗 emoji（两个区域指示符）解成 ISO 国家代码 */
export function flagToCountryCode(str) {
  if (!str) return '';
  const m = String(str).match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (!m) return '';
  const code = Array.from(m[0])
    .map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65))
    .join('');
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/** 从节点名猜国家 */
export function countryFromNodeName(name) {
  if (!name) return '';
  const flag = flagToCountryCode(name);
  if (flag) return flag;
  for (const [re, code] of NODE_KEYWORDS) {
    if (re.test(name)) return code;
  }
  return '';
}
