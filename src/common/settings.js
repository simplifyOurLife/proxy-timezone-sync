/** 设置项的默认值与读写封装 */

export const DEFAULT_SETTINGS = {
  /** 总开关：关闭后恢复网页原生接口，操作系统时区始终不修改 */
  enabled: true,
  /** 应用引擎：shim = 文档 Date/Intl 适配；cdp = 调试协议覆盖及关联目标探测 */
  engine: 'shim',
  /** 自动刷新间隔（分钟），最小 1 */
  refreshMinutes: 5,
  /** 可选门槛；默认按出口判断，避免 TUN 模式被本机端口启发式拦住 */
  onlyWhenProxied: false,
  /** 强制指定时区（IANA），非空时优先级最高 */
  manualTimezone: '',
  /** 是否探测本机端口 */
  localProbe: true,
  /** 附加探测端口（用户自定义，逗号分隔的字符串） */
  extraProbePorts: '',
  /** 是否启用原生宿主机探测（需额外安装 + nativeMessaging 权限） */
  nativeProbe: false,
  /** 地理接口没返回时区时，用「国家 → 主要城市时区」表兜底 */
  countryFallback: false,
  /** 先查询目标域名看到的出口，再对该明确 IP 定位 */
  exitProbeUrl: 'https://chatgpt.com/cdn-cgi/trace',
  /** 仅在用户确认所有相关请求使用同一出口时启用公共接口兜底 */
  allowGenericExit: false,
  /** 空列表表示全部 HTTP(S) 网站；默认只影响需要的站点 */
  includedDomains: ['chatgpt.com', 'openai.com'],
  /** 不生效的域名（支持 *.example.com 形式） */
  excludedDomains: [],
  /** 弹窗里显示调试细节 */
  showDebug: false,
  /** CDP 模式下是否同时覆盖所有子框架 */
  cdpAllFrames: true
};

const SETTINGS_KEY = 'settings';

/** 读取设置（自动补齐缺失字段 + 清洗非法值） */
export async function getSettings() {
  let stored = {};
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    stored = got && got[SETTINGS_KEY] ? got[SETTINGS_KEY] : {};
  } catch {
    stored = {};
  }
  const s = { ...DEFAULT_SETTINGS, ...stored };
  s.enabled = Boolean(s.enabled);
  s.engine = s.engine === 'cdp' ? 'cdp' : 'shim';
  s.refreshMinutes = Math.min(120, Math.max(1, Number(s.refreshMinutes) || 5));
  s.onlyWhenProxied = Boolean(s.onlyWhenProxied);
  s.manualTimezone = typeof s.manualTimezone === 'string' ? s.manualTimezone.trim() : '';
  s.localProbe = Boolean(s.localProbe);
  s.extraProbePorts = typeof s.extraProbePorts === 'string' ? s.extraProbePorts : '';
  s.nativeProbe = Boolean(s.nativeProbe);
  s.countryFallback = Boolean(s.countryFallback);
  s.exitProbeUrl = typeof s.exitProbeUrl === 'string' ? s.exitProbeUrl.trim() : DEFAULT_SETTINGS.exitProbeUrl;
  s.allowGenericExit = Boolean(s.allowGenericExit);
  s.includedDomains = Array.isArray(s.includedDomains) ? s.includedDomains.filter(d => typeof d === 'string') : DEFAULT_SETTINGS.includedDomains;
  s.excludedDomains = Array.isArray(s.excludedDomains) ? s.excludedDomains.filter((d) => typeof d === 'string') : [];
  s.showDebug = Boolean(s.showDebug);
  s.cdpAllFrames = Boolean(s.cdpAllFrames);
  return s;
}

/** 局部更新设置，返回更新后的完整设置 */
export async function patchSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return getSettings();
}

/** 解析附加端口的字符串 */
export function parseExtraPorts(text) {
  if (!text) return [];
  return String(text)
    .split(/[\s,;，、]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

/** 域名是否在排除列表中 */
export function isExcluded(hostname, excludedDomains) {
  if (!hostname || !excludedDomains || !excludedDomains.length) return false;
  const host = hostname.toLowerCase();
  return excludedDomains.some((raw) => {
    const rule = String(raw || '').trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('*.')) {
      const base = rule.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === rule || host.endsWith('.' + rule);
  });
}

/** 两种引擎共同使用的页面作用域；例外优先。 */
export function isAllowedUrl(url, settings = {}) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return false;
    if (isExcluded(parsed.hostname, settings.excludedDomains || [])) return false;
    const included = settings.includedDomains || [];
    return !included.length || isExcluded(parsed.hostname, included);
  } catch { return false; }
}
