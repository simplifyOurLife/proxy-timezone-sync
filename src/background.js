/**
 * Service Worker：探测 → 判定 → 应用
 * ------------------------------------------------------------------
 * 一次刷新做的事：
 *   1. 读设置
 *   2. 读浏览器代理配置 + 扫本机端口 + 打 Clash 控制台 + （可选）问原生宿主机
 *   3. 多路证据打分 → 判断你在用什么代理软件
 *   4. 请求地理接口 → 拿到出口 IP 的国家 / 城市 / 时区
 *   5. 决定目标时区（手动 > 地理时区 > 单一时区地区 > 可选主要城市兜底 > 节点名线索）
 *   6. 应用：shim 引擎写 storage（内容脚本接力）；cdp 引擎直接改渲染进程
 */

import { getSettings, patchSettings, isAllowedUrl } from './common/settings.js';
import { SOURCE } from './common/constants.js';
import { updateToolbar } from './common/toolbar.js';
import { isValidTimeZone, systemTimeZone, describeTimeZone } from './common/tz-util.js';
import { countryToTimezone, countryToSingleTimezone, COUNTRY_CN } from './common/country-tz.js';
import { probeLocal, rankSoftware } from './detect/proxy.js';
import { lookupGeo, countryFromNodeName } from './detect/geo.js';
import { probeNative } from './detect/native.js';
import * as cdp from './tz/cdp.js';
import * as shim from './tz/shim.js';

const STATE_KEY = 'state';
const SYNC_KEY = 'tzSync';
const ALARM_NAME = 'tz-auto-refresh';

let refreshing = null;
let settingsRevision = 0;
let pendingReason = '';
let applying = Promise.resolve();

/* ------------------------------------------------------------------ *
 * 状态读写
 * ------------------------------------------------------------------ */
export async function getState() {
  const got = await chrome.storage.local.get(STATE_KEY);
  return got && got[STATE_KEY] ? got[STATE_KEY] : null;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await updateToolbar(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * 判断「当前是不是在走代理」
 * ------------------------------------------------------------------ */
function detectProxied(local, ranked, nativeSystemProxy) {
  const pc = (local && local.proxyConfig) || {};
  // 1. 浏览器自己配了代理 / PAC / 自动探测
  if (pc.mode === 'fixed_servers' || pc.mode === 'pac_script' || pc.mode === 'auto_detect') return true;
  // 2. 扫到了本地代理端口，或者认出了代理软件
  if (ranked && ranked.primary && ranked.primary.score >= 42) return true;
  const open = ((local && local.portResults) || []).filter(
    (r) => r.state === 'http' || r.state === 'open-unknown'
  );
  if (open.length > 0) return true;
  // 3. 系统代理/PAC 是辅助证据；TUN 本身不一定配置系统代理。
  if (nativeSystemProxy) {
    if (nativeSystemProxy.enabled) return true;
    if (nativeSystemProxy.pacUrl) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 决定目标时区
 * ------------------------------------------------------------------ */
function resolveTarget({ settings, geo, ranked, local, native }) {
  if (!settings.enabled) return { tz: '', source: SOURCE.SYSTEM, reason: '已关闭浏览器时区覆盖；电脑系统时区未修改' };
  if (settings.manualTimezone) {
    if (isValidTimeZone(settings.manualTimezone)) {
      return { tz: settings.manualTimezone, source: SOURCE.MANUAL, reason: '手动指定时区' };
    }
    return { tz: '', source: SOURCE.NONE, reason: `手动指定的时区 "${settings.manualTimezone}" 不合法` };
  }

  const proxied = detectProxied(local, ranked, native && native.systemProxy);
  if (settings.onlyWhenProxied && !proxied) {
    return {
      tz: '',
      source: SOURCE.SYSTEM,
      reason:
        '没检测到在用代理，保持系统时区。如果你用的是 TUN / 透明代理模式，把「只在检测到代理时切换」关掉即可。',
      proxied
    };
  }

  if (geo && geo.ok) {
    if (geo.timezone && isValidTimeZone(geo.timezone)) {
      return {
        tz: geo.timezone,
        source: SOURCE.GEO_TIMEZONE,
        reason: `出口 IP ${geo.ip || '?'} 位于 ${geo.country || geo.countryCode || '未知'}${geo.city ? ' ' + geo.city : ''}`,
        proxied,
        countryCode: geo.countryCode || ''
      };
    }
    // 接口只有国家时，明确的单一时区地区无需开启“主要城市猜测”。
    const singleTz = countryToSingleTimezone(geo.countryCode);
    if (singleTz && isValidTimeZone(singleTz)) {
      return {
        tz: singleTz,
        source: SOURCE.GEO_SINGLE_TIMEZONE,
        reason: `接口只返回 ${COUNTRY_CN[geo.countryCode] || geo.countryCode}（${geo.countryCode}），按单一时区地区自动使用 ${singleTz}`,
        proxied,
        countryCode: geo.countryCode
      };
    }
    if (settings.countryFallback && geo.countryCode) {
      const tz = countryToTimezone(geo.countryCode);
      if (tz && isValidTimeZone(tz)) {
        return {
          tz,
          source: SOURCE.GEO_COUNTRY,
          reason: `接口只给了国家 ${geo.countryCode}，用该国主要城市时区兜底`,
          proxied,
          countryCode: geo.countryCode
        };
      }
    }
    return {
      tz: '',
      source: SOURCE.NONE,
      reason: geo.countryCode
        ? `接口只返回 ${COUNTRY_CN[geo.countryCode] || geo.countryCode}（${geo.countryCode}），无法可靠确定城市时区；请在设置中手动指定时区`
        : '地理接口未提供有效时区或国家；请在设置中手动指定时区',
      proxied,
      countryCode: geo.countryCode || ''
    };
  }

  if (!settings.allowGenericExit && !geo?.exitVerified) return {
    tz: '', source: SOURCE.NONE, reason: geo?.warning || '无法确认目标网站出口，未切换浏览器时区', proxied
  };
  if (!settings.countryFallback) return {
    tz: '', source: SOURCE.NONE, reason: geo?.warning || '未取得准确的城市时区，未使用国家或节点名猜测', proxied
  };
  // 仅在显式允许国家兜底及通用出口时，才接受节点名这类弱线索。
  const api = ((local && local.apiResults) || []).find((a) => a && a.node);
  const nodeName = api ? api.node : '';
  const cc = countryFromNodeName(nodeName);
  if (cc) {
    const tz = countryToTimezone(cc);
    if (tz && isValidTimeZone(tz)) {
      return {
        tz,
        source: SOURCE.LOCAL_PROXY_HINT,
        reason: `地理接口都失败，用当前节点名 "${nodeName}" 推断为 ${cc}`,
        proxied,
        countryCode: cc
      };
    }
  }

  return {
    tz: '',
    source: SOURCE.NONE,
    reason: '所有地理接口都失败了（检查代理是否放行了 ipwho.is / ipapi.co 等域名）',
    proxied
  };
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */
function applyTarget(target, settings, state, revision) {
  applying = applying.catch(() => {}).then(() => applyTargetNow(target, settings, revision));
  return applying;
}

async function applyTargetNow(target, settings, revision) {
  if (revision !== settingsRevision) return { superseded: true };
  const enabled = settings.enabled;
  const tz = enabled && target.tz && isValidTimeZone(target.tz) ? target.tz : '';

  const sync = { tz, enabled, excluded: settings.excludedDomains, included: settings.includedDomains,
    engine: enabled ? settings.engine : 'off', at: Date.now() };

  const applied = { engine: enabled ? settings.engine : 'off', tz, at: Date.now(), cdp: null, shim: null, registration: null };
  const wantCdp = enabled && settings.engine === 'cdp';
  try { applied.registration = await shim.syncRegistration(sync); }
  catch (e) {
    applied.registration = { registered: false, error: String(e?.message || e) };
    // 预注册失败时撤销已有页面覆盖，不让“目标值”伪装成已经可靠生效。
    sync.tz = '';
    sync.engine = 'off';
    applied.tz = '';
    console.warn('[tz-auto-switch] 页面启动脚本注册失败', e);
  }
  await chrome.storage.local.set({ [SYNC_KEY]: sync });
  if (wantCdp && !applied.registration.error) {
    applied.shim = await shim.applyToExistingTabs(sync); // 同步恢复已有页面原生引用后再交给 CDP。
    if (tz) {
      applied.cdp = await cdp.applyToAllTabs(tz, settings);
    } else {
      const n = await cdp.restoreAllTabs();
      applied.cdp = { ok: 0, restored: n };
    }
  } else {
    const n = await cdp.restoreAllTabs();
    applied.cdp = { restored: n };
    applied.shim = await shim.applyToExistingTabs(sync);
  }
  if (settings.showDebug) console.info('[tz-auto-switch] 时区应用结果', applied);
  return applied;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function doRefresh(reason = 'manual') {
  const t0 = Date.now();
  const revision = settingsRevision;
  const settings = await getSettings();
  const errors = [];

  // 关闭和手动时区无需等待端口扫描或外网，且不会再泄露不必要的查询。
  if (!settings.enabled || settings.manualTimezone) {
    const previous = await getState();
    const target = resolveTarget({ settings, geo: null, ranked: null, local: null, native: null });
    const state = { ...previous, updatedAt: Date.now(), durationMs: Date.now() - t0, reason,
      enabled: settings.enabled, engine: settings.enabled ? settings.engine : 'off', systemTz: systemTimeZone(),
      target: { ...target, info: target.tz ? describeTimeZone(target.tz) : null }, errors };
    state.applied = await applyTarget(target, settings, state, revision);
    if (revision !== settingsRevision) return getState();
    return setState(state);
  }

  let local = { proxyConfig: { mode: 'unknown', endpoints: [] }, portResults: [], apiResults: [], probedPorts: [] };
  try {
    local = await probeLocal(settings);
  } catch (e) {
    errors.push(`本地探测失败：${String((e && e.message) || e)}`);
  }

  let native = { available: false, reason: settings.nativeProbe ? '' : '未启用' };
  if (settings.nativeProbe) {
    try {
      native = await probeNative();
    } catch (e) {
      native = { available: false, reason: String((e && e.message) || e) };
    }
  }

  const ranked = rankSoftware({
    portResults: local.portResults,
    apiResults: local.apiResults,
    proxyConfig: local.proxyConfig,
    processes: (native.processes || []).map((p) => ({ name: p.name || '', path: p.path || '', pid: p.pid }))
  });

  let geo = { ok: false, attempts: [] };
  try {
    geo = await lookupGeo({ exitProbeUrl: settings.exitProbeUrl, allowGenericExit: settings.allowGenericExit });
  } catch (e) {
    errors.push(`地理接口失败：${String((e && e.message) || e)}`);
  }

  if (revision !== settingsRevision) return getState();
  const target = resolveTarget({ settings, geo, ranked, local, native });
  const targetInfo = target.tz ? describeTimeZone(target.tz) : null;

  const state = {
    updatedAt: Date.now(),
    durationMs: Date.now() - t0,
    reason,
    enabled: settings.enabled,
    engine: settings.enabled ? settings.engine : 'off',
    systemTz: systemTimeZone(),
    proxyConfig: local.proxyConfig,
    software: ranked,
    openPorts: (local.portResults || []).filter((r) => r.state !== 'closed' && r.state !== 'blocked'),
    allPorts: local.portResults || [],
    api: local.apiResults || [],
    native: {
      available: native.available,
      reason: native.reason || '',
      count: (native.processes || []).length,
      systemProxy: native.systemProxy || null,
      processes: (native.processes || []).slice(0, 12)
    },
    geo: {
      ok: geo.ok,
      source: geo.source || '',
      sourceLabel: geo.sourceLabel || '',
      ip: geo.ip || '',
      country: geo.country || '',
      countryCn: COUNTRY_CN[geo.countryCode] || '',
      countryCode: geo.countryCode || '',
      city: geo.city || '',
      region: geo.region || '',
      timezone: geo.timezone || '',
      exitVerified: Boolean(geo.exitVerified),
      probeHost: geo.probeHost || '',
      warning: geo.warning || '',
      attempts: geo.attempts || []
    },
    target: {
      tz: target.tz || '',
      source: target.source,
      reason: target.reason || '',
      proxied: Boolean(target.proxied),
      countryCode: target.countryCode || '',
      info: targetInfo
    },
    errors
  };

  state.applied = await applyTarget(target, settings, state, revision);
  if (revision !== settingsRevision) return getState();
  if (settings.showDebug) console.info('[tz-auto-switch] 出口检测完成', {
    reason, ip: state.geo.ip, probeHost: state.geo.probeHost, exitVerified: state.geo.exitVerified,
    target: state.target.tz, warning: state.geo.warning, attempts: state.geo.attempts, errors
  });
  await setState(state);
  return state;
}

export async function refresh(reason = 'manual') {
  if (refreshing) {
    if (reason === 'settings-change' || reason === 'proxy-change') pendingReason = reason;
    return refreshing;
  }
  pendingReason = reason;
  const p = (async () => {
    let state;
    do {
      const next = pendingReason; pendingReason = '';
      state = await doRefresh(next);
    } while (pendingReason);
    return state;
  })().finally(() => {
    refreshing = null;
  });
  refreshing = p;
  return p;
}

/* ------------------------------------------------------------------ *
 * 定时与事件
 * ------------------------------------------------------------------ */
async function ensureAlarm() {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(ALARM_NAME);
  const wanted = settings.refreshMinutes;
  if (!existing || Math.abs((existing.periodInMinutes || 0) - wanted) > 0.001) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: wanted, delayInMinutes: 0.2 });
  }
}

async function bootstrap(reason) {
  const revision = settingsRevision;
  try {
    await ensureAlarm();
    const state = await getState();
    const settings = await getSettings();
    if (revision !== settingsRevision) return;
    await updateToolbar({ ...state, enabled: settings.enabled });
    const stale = !state || Date.now() - (state.updatedAt || 0) > settings.refreshMinutes * 60 * 1000;
    if (reason === 'startup' || reason === 'installed' || reason === 'proxy-change' || stale) {
      await refresh(reason);
    } else {
      await applyTarget(state.target || { tz: '' }, settings, state, revision);
    }
  } catch (e) {
    console.warn('[tz-auto-switch] bootstrap 失败', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap('installed');
});
chrome.runtime.onStartup.addListener(() => {
  void bootstrap('startup');
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void refresh('alarm');
});
chrome.proxy.settings.onChange.addListener(() => {
  settingsRevision++;
  void refresh('proxy-change');
});

function applyCdpForNavigation(tabId, url) {
  // 与目标清空/切换共用队列，禁止导航把旧覆盖排到恢复操作之后。
  applying = applying.catch(() => {}).then(() => applyCdpForNavigationNow(tabId, url));
  return applying;
}
async function applyCdpForNavigationNow(tabId, url) {
  const revision = settingsRevision;
  const settings = await getSettings();
  if (revision !== settingsRevision) return;
  if (!settings.enabled || settings.engine !== 'cdp' || !isAllowedUrl(url, settings)) {
    if (cdp.attachedTabIds().includes(tabId)) await cdp.clearTimezoneForTab(tabId);
    return;
  }
  // sync 在应用覆盖前写入；state 要等所有目标完成才落盘，不能用它驱动导航。
  const got = await chrome.storage.local.get(SYNC_KEY);
  const sync = got[SYNC_KEY];
  const tz = sync?.enabled && sync.engine === 'cdp' ? sync.tz : '';
  if (revision !== settingsRevision) return;
  if (!tz) {
    if (cdp.attachedTabIds().includes(tabId)) await cdp.clearTimezoneForTab(tabId);
    return;
  }
  const r = await cdp.setTimezoneForTab(tabId, tz, settings);
  if (revision !== settingsRevision) await cdp.clearTimezoneForTab(tabId);
  if (!r.ok) console.warn('[tz-auto-switch] CDP 覆盖失败', tabId, r.error);
}

// document_start 补丁由 Chrome 预注册机制负责；导航事件仅补 CDP 覆盖。
chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId === 0) await applyCdpForNavigation(details.tabId, details.url);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    await applyCdpForNavigation(tabId, changeInfo.url || tab?.pendingUrl || tab?.url);
  }
});

cdp.watchDetach();

// 权限被回收时（用户在扩展页撤掉了 debugger 权限）自动降级
chrome.permissions.onRemoved.addListener(async removed => {
  const settings = await getSettings();
  if (settings.engine === 'cdp' && removed.permissions?.includes('debugger')) {
    await patchSettings({ engine: 'shim' });
  }
  void refresh('permission-removed');
});

/* ------------------------------------------------------------------ *
 * 消息接口（弹窗 / 设置页 / 测试页）
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'GET_STATE': {
          const [state, settings] = await Promise.all([getState(), getSettings()]);
          const attached = cdp.attachedTabIds();
          sendResponse({ ok: true, state, settings, attachedTabs: attached.length, coverage: cdp.coverage() });
          break;
        }
        case 'REFRESH': {
          const state = await refresh(msg.reason || 'popup');
          sendResponse({ ok: true, state, settings: await getSettings() });
          break;
        }
        case 'SET_SETTINGS': {
          settingsRevision++;
          const settings = await patchSettings(msg.patch || {});
          await ensureAlarm();
          let state = await getState();
          if (state?.target) {
            state = { ...state, enabled: settings.enabled, engine: settings.enabled ? settings.engine : 'off' };
            if (!settings.enabled) state.target = { tz: '', source: SOURCE.SYSTEM, reason: '已关闭浏览器时区覆盖；电脑系统时区未修改' };
            state.applied = await applyTarget(state.target, settings, state, settingsRevision);
            await setState(state);
          }
          state = await refresh('settings-change');
          sendResponse({ ok: true, settings, state });
          break;
        }
        case 'GET_ID': {
          sendResponse({ ok: true, id: chrome.runtime.id });
          break;
        }
        case 'PROBE_NOW': {
          const settings = await getSettings();
          const local = await probeLocal(settings);
          const native = settings.nativeProbe ? await probeNative() : { available: false, reason: '未启用' };
          const ranked = rankSoftware({
            portResults: local.portResults,
            apiResults: local.apiResults,
            proxyConfig: local.proxyConfig,
            processes: (native.processes || []).map((p) => ({ name: p.name || '', path: p.path || '', pid: p.pid }))
          });
          sendResponse({ ok: true, local, native, ranked });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 保持通道异步
});

// 冷启动兜底：SW 被事件唤醒时检查缓存是否过期。
void bootstrap('wake');
