/** 持久化注册时区种子和补丁：首次读取无需等待 storage/后台消息。 */
import { ZONE_SEEDS } from './zone-seeds.js';
import { isAllowedUrl } from '../common/settings.js';

const ID = 'tz-shim-main';
function patterns(domains) {
  return [...new Set(domains.map(raw => {
    const domain = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(domain) || domain.includes('..')) throw new Error(`域名格式无效：${raw}`);
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) ? `*://${domain}/*` : `*://*.${domain}/*`;
  }))];
}
function seedPath(tz) {
  let canonical = tz;
  try { canonical = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone; } catch { /* 下方统一报错 */ }
  const file = ZONE_SEEDS[tz] || ZONE_SEEDS[canonical];
  if (!file) throw new Error(`此时区未打包启动种子：${tz}，请使用 CDP 模式`);
  return file;
}
export async function syncRegistration(sync) {
  const existing = (await chrome.scripting.getRegisteredContentScripts({ ids: [ID] }))[0];
  const active = sync.enabled && sync.engine === 'shim' && sync.tz;
  if (!active) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
    return { registered: false };
  }
  try {
    const wanted = {
      id: ID, js: [seedPath(sync.tz), 'src/content/tz-shim.js'],
      matches: sync.included?.length ? patterns(sync.included) : ['http://*/*', 'https://*/*', 'file:///*'],
      excludeMatches: patterns(sync.excluded || []),
      runAt: 'document_start', world: 'MAIN', allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true
    };
    if (existing) await chrome.scripting.updateContentScripts([wanted]);
    else await chrome.scripting.registerContentScripts([wanted]);
    return { registered: true, tz: sync.tz };
  } catch (e) {
    // 更新失败也要删除旧种子，不能让新页面继续报告上一节点的时区。
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
    throw e;
  }
}

/** 已打开的页面同步安装/撤销。CDP 接管前必须等待原生引用恢复。 */
export async function applyToExistingTabs(sync) {
  const tabs = await chrome.tabs.query({});
  const result = { ok: 0, skipped: 0, failed: 0, details: [] };
  const settings = { includedDomains: sync.included || [], excludedDomains: sync.excluded || [] };
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || tab.discarded || !/^(https?|file):/i.test(tab.url || '')) { result.skipped++; continue; }
    const tz = sync.enabled && sync.engine === 'shim' && isAllowedUrl(tab.url, settings) ? sync.tz : '';
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN',
        func: (timezone, included, excluded) => {
          const host = location.hostname;
          const matches = list => list.some(raw => { const base = raw.trim().toLowerCase().replace(/^\*\./, ''); return host === base || host.endsWith('.' + base); });
          const value = timezone && (!included.length || matches(included)) && !matches(excluded) ? timezone : null;
          window.__TZ_AUTO_SWITCH__ = value;
          window.__TZ_AUTO_SWITCH_SHIM__?.update?.(value);
        }, args: [tz, sync.included || [], sync.excluded || []] });
      if (tz) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', files: ['src/content/tz-shim.js'] });
      result.ok++;
    } catch (e) {
      result.failed++;
      result.details.push({ tabId: tab.id, error: String(e?.message || e) });
    }
  }
  return result;
}
