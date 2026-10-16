/**
 * 代理探测层
 * ------------------------------------------------------------------
 * 四路证据：
 *  1. chrome.proxy.settings  —— 浏览器/扩展自己配置的固定代理或 PAC
 *  2. 本机端口探测          —— 谁在监听那些「代理软件默认端口」
 *  3. 控制台 API 指纹       —— Clash / mihomo / sing-box 系的 RESTful 控制口
 *  4. 原生宿主机进程名       —— 见 native.js（需额外安装，可选）
 */

import {
  PROXY_SOFTWARE,
  DEFAULT_PROBE_PORTS,
  CHROME_BLOCKED_PORTS,
  PORT_PROBE_TIMEOUT_MS,
  API_PROBE_TIMEOUT_MS
} from '../common/constants.js';
import { parseExtraPorts } from '../common/settings.js';

/* ------------------------------------------------------------------ */
/* 1. 读浏览器代理配置                                                  */
/* ------------------------------------------------------------------ */

export async function readChromeProxyConfig() {
  const out = {
    levelOfControl: 'unknown',
    mode: 'unknown',
    pacUrl: '',
    endpoints: [],
    usesSystemProxy: false,
    error: ''
  };
  try {
    const cfg = await chrome.proxy.settings.get({ incognito: false });
    out.levelOfControl = cfg.levelOfControl || 'unknown';
    const value = cfg.value || {};
    out.mode = value.mode || 'unknown';
    if (value.pacScript && value.pacScript.url) out.pacUrl = value.pacScript.url;
    if (value.mode === 'system') out.usesSystemProxy = true;
    const rules = value.rules || {};
    const push = (kind, ep) => {
      if (!ep || !ep.host) return;
      out.endpoints.push({
        kind,
        host: ep.host,
        port: Number(ep.port) || 0,
        scheme: ep.scheme || 'http'
      });
    };
    push('single', rules.singleProxy);
    push('http', rules.proxyForHttp);
    push('https', rules.proxyForHttps);
    push('socks', rules.proxyForSocks);
    push('ftp', rules.proxyForFtp);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 端口探测                                                         */
/* ------------------------------------------------------------------ */

/**
 * 探测单个端口，返回三种状态：
 *  - 'http'         : 连上了并且回了 HTTP 响应（典型：HTTP 代理 / 控制台 API）
 *  - 'open-unknown' : 连上了但没回 HTTP（典型：SOCKS5 入站口，或非 HTTP 服务）
 *  - 'closed'       : 连接被拒绝 / 端口没人监听
 */
export async function probePort(port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  if (CHROME_BLOCKED_PORTS.has(port)) {
    return { port, state: 'blocked', ms: 0, error: 'Chrome 禁用端口，无法探测' };
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'x-tz-probe': '1' }
    });
    clearTimeout(timer);
    return {
      port,
      state: 'http',
      code: res.status,
      server: res.headers.get('server') || '',
      via: res.headers.get('via') || res.headers.get('proxy-agent') || '',
      ms: Date.now() - started
    };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError');
    const msg = String((e && e.message) || e);
    // Chrome 对「连不上」和「协议不对」都报 Failed to fetch，只能靠超时区分
    return {
      port,
      state: aborted ? 'open-unknown' : 'closed',
      ms: Date.now() - started,
      error: aborted ? '超时未响应（端口像是开着的，但不是 HTTP）' : msg
    };
  }
}

/** 并发受限地批量探测端口 */
export async function probePorts(ports, { concurrency = 12, timeoutMs = PORT_PROBE_TIMEOUT_MS } = {}) {
  const list = Array.from(new Set(ports)).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await probePort(list[idx], timeoutMs);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 3. 控制台 API 指纹（Clash 系 / sing-box clash-api）                   */
/* ------------------------------------------------------------------ */

async function fetchJson(url, timeoutMs = API_PROBE_TIMEOUT_MS, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, status: res.status, json: JSON.parse(text), text };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 Clash 系控制台。命中说明很确定是 Clash/mihomo/sing-box 家族，
 * 并且能顺手拿到真实的入站端口和当前选中的节点名。
 */
export async function probeClashApi(port) {
  const version = await fetchJson(`http://127.0.0.1:${port}/version`);
  if (!version.ok || !version.json || typeof version.json.version === 'undefined') {
    if (version.status === 401 || version.status === 403) {
      return { port, kind: 'clash-api', authRequired: true };
    }
    return null;
  }
  const info = {
    port,
    kind: 'clash-api',
    version: version.json.version,
    meta: Boolean(version.json.meta),
    premium: Boolean(version.json.premium),
    ports: null,
    node: '',
    group: ''
  };

  const configs = await fetchJson(`http://127.0.0.1:${port}/configs`);
  if (configs.ok && configs.json) {
    const c = configs.json;
    info.ports = {
      port: c.port || 0,
      socksPort: c['socks-port'] || 0,
      mixedPort: c['mixed-port'] || 0,
      redirPort: c['redir-port'] || 0,
      tproxyPort: c['tproxy-port'] || 0
    };
    info.mode = c.mode || '';
  }

  const proxies = await fetchJson(`http://127.0.0.1:${port}/proxies`);
  if (proxies.ok && proxies.json && proxies.json.proxies) {
    const groups = proxies.json.proxies;
    for (const name of ['GLOBAL', 'Proxy', 'PROXY', '节点选择', 'Selector']) {
      const g = groups[name];
      if (g && g.now) {
        info.group = name;
        info.node = g.now;
        break;
      }
    }
    if (!info.node) {
      for (const [name, g] of Object.entries(groups)) {
        if (g && g.now && g.all && g.all.length) {
          info.group = name;
          info.node = g.now;
          break;
        }
      }
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* 4. 合并打分                                                          */
/* ------------------------------------------------------------------ */

function softwareById(id) {
  return PROXY_SOFTWARE.find((s) => s.id === id) || null;
}

/**
 * 综合判断本机在用什么代理软件
 * @returns {{primary: object|null, candidates: Array}}
 */
export function rankSoftware({ portResults = [], apiResults = [], proxyConfig = null, processes = [] }) {
  const scores = new Map(); // id -> {score, evidence[]}
  const touch = (id) => {
    if (!scores.has(id)) scores.set(id, { id, score: 0, evidence: [] });
    return scores.get(id);
  };

  // 端口命中
  for (const r of portResults) {
    if (r.state === 'closed' || r.state === 'blocked') continue;
    for (const sw of PROXY_SOFTWARE) {
      if (!sw.ports.includes(r.port)) continue;
      const rec = touch(sw.id);
      // 回了 HTTP 说明确实是个 HTTP 代理/控制台；只是「有监听」则更弱一些
      const weight = r.state === 'http' ? 42 : 32;
      rec.score += weight;
      rec.evidence.push({
        source: 'port',
        detail: `端口 ${r.port} ${r.state === 'http' ? '有 HTTP 响应' : '有监听（非 HTTP）'}`
      });
    }
  }

  // 控制台 API 命中（最强证据：等于直接看到内核在跑）
  for (const api of apiResults) {
    if (!api) continue;
    const ids = ['mihomo', 'clash-verge', 'clash'];
    const primaryId = api.meta ? 'mihomo' : 'clash';
    const rec = touch(primaryId);
    rec.score += 72;
    rec.evidence.push({
      source: 'api',
      detail: `端口 ${api.port} 命中 Clash 控制台 /version${api.version ? ` (v${api.version}${api.meta ? ', meta' : ''})` : ''}`
    });
    if (api.ports) {
      rec.evidence.push({
        source: 'api',
        detail: `真实入站端口：mixed=${api.ports.mixedPort || '-'} http=${api.ports.port || '-'} socks=${api.ports.socksPort || '-'}`
      });
    }
    for (const id of ids.slice(1)) {
      const alt = touch(id);
      alt.score += 14;
      alt.evidence.push({ source: 'api', detail: '同族内核（Clash 系控制台可达）' });
    }
  }

  // 浏览器代理配置里的端口/主机
  if (proxyConfig && Array.isArray(proxyConfig.endpoints)) {
    for (const ep of proxyConfig.endpoints) {
      const hostIsLocal = /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/i.test(ep.host);
      for (const sw of PROXY_SOFTWARE) {
        if (!sw.ports.includes(ep.port)) continue;
        const rec = touch(sw.id);
        rec.score += 46;
        rec.evidence.push({
          source: 'config',
          detail: `浏览器代理指向 ${ep.host}:${ep.port}${hostIsLocal ? '（本机）' : ''}`
        });
      }
    }
    if (proxyConfig.pacUrl) {
      const lowered = proxyConfig.pacUrl.toLowerCase();
      for (const sw of PROXY_SOFTWARE) {
        if (!sw.pacHints.length) continue;
        const hit = sw.pacHints.find((h) => lowered.includes(h));
        if (hit) {
          const rec = touch(sw.id);
          rec.score += 30;
          rec.evidence.push({
            source: 'pac',
            detail: `PAC 地址命中关键字 "${hit}"：${proxyConfig.pacUrl}`
          });
        }
      }
    }
  }

  // 原生宿主机返回的进程名（最硬的证据之一）
  for (const proc of processes) {
    const lower = String(proc.name || proc.path || '').toLowerCase();
    if (!lower) continue;
    for (const sw of PROXY_SOFTWARE) {
      if (!sw.processNames.some((p) => lower.includes(p))) continue;
      const rec = touch(sw.id);
      rec.score += 70;
      rec.evidence.push({ source: 'process', detail: `检测到进程 ${proc.name || proc.path}${proc.pid ? `（PID ${proc.pid}）` : ''}` });
    }
  }

  const candidates = Array.from(scores.values())
    .map((rec) => {
      const sw = softwareById(rec.id);
      const score = Math.min(100, rec.score);
      return {
        id: rec.id,
        name: sw ? sw.name : rec.id,
        portHint: sw ? sw.note : '',
        score,
        confidence: score >= 70 ? 'high' : score >= 42 ? 'medium' : 'low',
        evidence: rec.evidence
      };
    })
    .sort((a, b) => b.score - a.score);

  return { primary: candidates[0] || null, candidates };
}

/* ------------------------------------------------------------------ */
/* 5. 组合入口                                                          */
/* ------------------------------------------------------------------ */

export function collectProbePorts(settings) {
  const extra = parseExtraPorts(settings.extraProbePorts);
  return Array.from(new Set([...DEFAULT_PROBE_PORTS, ...extra]));
}

export function apiCandidatePorts(settings) {
  const extra = parseExtraPorts(settings.extraProbePorts);
  const fromDb = PROXY_SOFTWARE.flatMap((s) => s.apiPorts);
  return Array.from(new Set([...fromDb, ...extra.filter((p) => p >= 1000)])).filter(
    (p) => !CHROME_BLOCKED_PORTS.has(p)
  );
}

/** 完整跑一遍本地探测 */
export async function probeLocal(settings) {
  const proxyConfig = await readChromeProxyConfig();
  const result = {
    proxyConfig,
    portResults: [],
    apiResults: [],
    processes: [],
    probedPorts: [],
    startedAt: Date.now()
  };

  if (settings.localProbe) {
    const ports = collectProbePorts(settings);
    result.probedPorts = ports;
    result.portResults = await probePorts(ports);

    // 控制口只在「该端口确实开着」时才去请求，省时间
    const open = new Set(result.portResults.filter((r) => r.state !== 'closed' && r.state !== 'blocked').map((r) => r.port));
    // 控制台端口如果被防火墙挡住但服务在跑，也允许盲试一遍
    const apiPorts = apiCandidatePorts(settings).filter((p) => open.has(p) || !result.probedPorts.includes(p));
    for (const p of apiPorts.slice(0, 6)) {
      const api = await probeClashApi(p);
      if (api) result.apiResults.push(api);
    }
  }

  result.finishedAt = Date.now();
  return result;
}
