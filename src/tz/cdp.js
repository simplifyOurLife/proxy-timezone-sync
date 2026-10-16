/** CDP 时区覆盖。仅接管选定页面；子目标失败单独报告，不承诺覆盖所有 Worker。 */
import { isAllowedUrl, isExcluded } from '../common/settings.js';

const OWNED_KEY = 'tzCdpOwnedTabs';
const states = new Map();
const queues = new Map();
let watching = false;
let ownershipWrites = Promise.resolve();
const errorText = e => String(e?.message || e);
const storage = () => chrome.storage.session || chrome.storage.local;

async function ownedIds() {
  const got = await storage().get(OWNED_KEY);
  return Array.isArray(got[OWNED_KEY]) ? got[OWNED_KEY].filter(Number.isInteger) : [];
}
function remember(tabId, add) {
  ownershipWrites = ownershipWrites.catch(() => {}).then(async () => {
    const ids = new Set(await ownedIds());
    if (add) ids.add(tabId); else ids.delete(tabId);
    await storage().set({ [OWNED_KEY]: [...ids] });
  });
  return ownershipWrites;
}
function serial(tabId, action) {
  const previous = queues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(tabId, current);
  current.finally(() => { if (queues.get(tabId) === current) queues.delete(tabId); }).catch(() => {});
  return current;
}
export function attachedTabIds() { return [...states.keys()]; }
export function isAttachableUrl(url) { return typeof url === 'string' && /^(https?|file):/i.test(url); }
export function coverage() {
  return [...states].map(([tabId, state]) => ({ tabId, children: state.children.size, errors: [...state.errors] }));
}
async function autoAttach(target, enabled) {
  await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
    autoAttach: enabled, waitForDebuggerOnStart: enabled, flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false },
      { type: 'shared_worker', exclude: false }, { type: 'service_worker', exclude: false }, { exclude: true }]
  });
}
async function override(target, tz) {
  await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: tz || '' });
}
function note(state, target, e) {
  const detail = { sessionId: target.sessionId || '', error: errorText(e) };
  if (!state.errors.some(item => item.sessionId === detail.sessionId && item.error === detail.error)) state.errors.push(detail);
  console.warn('[tz-auto-switch] CDP 目标覆盖不完整', target.tabId, detail);
}

export async function setTimezoneForTab(tabId, tz, options = {}) {
  return serial(tabId, async () => {
    let state = states.get(tabId);
    const alreadyAttached = Boolean(state);
    try {
      try { await override({ tabId }, tz); }
      catch (e) {
        if (!/not attached/i.test(errorText(e))) throw e;
        await chrome.debugger.attach({ tabId }, '1.3');
        try { await override({ tabId }, tz); }
        catch (commandError) {
          // 附着成功但命令失败时立即释放，避免留下无效调试会话。
          await chrome.debugger.detach({ tabId }).catch(() => {});
          throw commandError;
        }
      }
      state ||= { children: new Map(), errors: [] };
      state.tz = tz;
      state.options = options;
      state.errors = [];
      states.set(tabId, state);
      await remember(tabId, true);
      for (const [sessionId, info] of state.children) {
        const target = { tabId, sessionId };
        let excluded = options.cdpAllFrames === false;
        try { excluded ||= isExcluded(new URL(info.url).hostname, options.excludedDomains || []); } catch { /* 无独立域名的目标沿用父级 */ }
        try {
          await override(target, excluded ? '' : tz);
          await autoAttach(target, !excluded);
        } catch (e) { note(state, target, e); }
        finally {
          await chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger').catch(e => note(state, target, e));
        }
      }
      try { await autoAttach({ tabId }, options.cdpAllFrames !== false); }
      catch (e) { note(state, { tabId }, e); }
      return { ok: true, alreadyAttached, partial: state.errors.length > 0, errors: [...state.errors] };
    } catch (e) { return { ok: false, error: errorText(e) }; }
  });
}
export async function clearTimezoneForTab(tabId) {
  return serial(tabId, async () => {
    const state = states.get(tabId);
    // 删除状态后收到的新子目标只会被恢复执行，不会再得到过期覆盖。
    states.delete(tabId);
    for (const [sessionId] of state?.children || []) {
      await override({ tabId, sessionId }, '').catch(() => {});
      await autoAttach({ tabId, sessionId }, false).catch(() => {});
    }
    await autoAttach({ tabId }, false).catch(() => {});
    await override({ tabId }, '').catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await remember(tabId, false);
  });
}
export async function applyToAllTabs(tz, options = {}) {
  const tabs = await chrome.tabs.query({});
  const results = { ok: 0, skipped: 0, failed: 0, partial: 0, details: [] };
  const owned = new Set([...states.keys(), ...await ownedIds()]);
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || tab.discarded || !isAllowedUrl(tab.url, options)) {
      if (owned.has(tab.id)) await clearTimezoneForTab(tab.id);
      results.skipped++; continue;
    }
    const result = await setTimezoneForTab(tab.id, tz, options);
    if (result.ok) results.ok++;
    if (result.partial) results.partial++;
    if (!result.ok) results.failed++;
    if (!result.ok || result.partial) results.details.push({ tabId: tab.id, url: tab.url, ...result });
  }
  return results;
}
export async function restoreAllTabs() {
  // 只恢复本扩展记录过的目标，不能把其他调试器的附着状态当成自己的。
  const targets = new Set([...states.keys(), ...await ownedIds()]);
  for (const tabId of targets) await clearTimezoneForTab(tabId);
  return targets.size;
}
export function watchDetach() {
  if (watching) return;
  watching = true;
  chrome.debugger.onDetach.addListener(source => {
    if (typeof source?.tabId !== 'number') return;
    states.delete(source.tabId);
    void remember(source.tabId, false).catch(e => console.warn('[tz-auto-switch] 清理调试会话记录失败', e));
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method === 'Target.detachedFromTarget') {
      states.get(source.tabId)?.children.delete(params.sessionId); return;
    }
    if (method !== 'Target.attachedToTarget') return;
    const target = { tabId: source.tabId, sessionId: params.sessionId };
    const state = states.get(source.tabId);
    try {
      let excluded = false;
      try { excluded = isExcluded(new URL(params.targetInfo.url).hostname, state?.options.excludedDomains || []); } catch { /* blob/空地址使用父目标设置 */ }
      if (state && !excluded) {
        state.children.set(params.sessionId, params.targetInfo);
        await override(target, state.tz);
        await autoAttach(target, true); // 跨进程多层 iframe 需要递归附着。
      }
    } catch (e) { if (state) note(state, target, e); }
    finally {
      // 包括不支持 Emulation 的 Worker，异常路径也必须放行，防止网页卡死。
      await chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger').catch(e => {
        if (state) note(state, target, e);
      });
    }
  });
}
