/**
 * 隔离世界桥接脚本
 * ------------------------------------------------------------------
 * Service Worker 把「当前生效的目标时区」写进 chrome.storage.local，
 * 这里负责已打开页面的运行中更新，首次注入由持久化种子脚本负责。
 * 读出来后通过三条通道交给主世界的补丁引擎：
 *   1) window.__TZ_AUTO_SWITCH__          （主世界全局变量，不依赖 DOM，最快）
 *   2) html 的 data-tz-auto-switch 属性   （DOM 通道，document_start 时可能还没建好）
 *   3) postMessage 事件                   （主世界监听补发）
 */

(() => {
  'use strict';

  const TZ_KEY = 'data-tz-auto-switch';
  const TZ_GLOBAL = '__TZ_AUTO_SWITCH__';
  const TZ_MESSAGE = '__TZ_AUTO_SWITCH_MSG__';
  const SYNC_KEY = 'tzSync';

  /** 域名排除规则（与 common/settings.js 的实现保持一致） */
  function isExcluded(hostname, rules) {
    if (!hostname || !rules || !rules.length) return false;
    const host = hostname.toLowerCase();
    return rules.some((raw) => {
      const rule = String(raw || '').trim().toLowerCase();
      if (!rule) return false;
      if (rule.startsWith('*.')) {
        const base = rule.slice(2);
        return host === base || host.endsWith('.' + base);
      }
      return host === rule || host.endsWith('.' + rule);
    });
  }

  let desired = null; // 目标时区，null 表示「本页不做任何修改」
  let lastSent; // 上次通过 postMessage 广播的值

  function flush() {
    const value = desired;
    try {
      window[TZ_GLOBAL] = value || undefined;
    } catch {
      /* ignore */
    }
    try {
      const el = document.documentElement;
      if (el) {
        if (value) el.setAttribute(TZ_KEY, value);
        else el.removeAttribute(TZ_KEY);
      }
    } catch {
      /* ignore */
    }
    if (lastSent !== value) {
      lastSent = value;
      try {
        window.postMessage({ type: TZ_MESSAGE, tz: value }, '*');
      } catch {
        /* ignore */
      }
    }
  }

  function applySync(sync) {
    const s = sync || {};
    const enabled = s.enabled !== false;
    const tz = typeof s.tz === 'string' ? s.tz : '';
    let host = '';
    try {
      host = location.hostname || '';
    } catch {
      host = '';
    }
    const outsideScope = (s.included || []).length && !isExcluded(host, s.included);
    desired = !enabled || s.engine !== 'shim' || !tz || outsideScope || isExcluded(host, s.excluded || []) ? null : tz;
    flush();
  }

  function load() {
    try {
      chrome.storage.local
        .get(SYNC_KEY)
        .then((got) => applySync(got ? got[SYNC_KEY] : null))
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }

  load();

  // <html> 还没建好时，短时间内多补几次 DOM 属性（通道 1/3 不受影响）
  if (!document.documentElement) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (document.documentElement || tries > 20) {
        clearInterval(timer);
        flush();
      }
    }, 10);
    document.addEventListener('DOMContentLoaded', flush, { once: true });
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SYNC_KEY]) return;
      applySync(changes[SYNC_KEY].newValue);
    });
  } catch {
    /* ignore */
  }
})();
