/** 弹窗逻辑：只负责展示和转发操作，真正的判断都在 Service Worker 里 */

const $ = (id) => document.getElementById(id);

let current = { state: null, settings: null };
let tickTimer = null;

function countryCodeToFlag(cc) {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '🏳️';
  return Array.from(cc.toUpperCase())
    .map((c) => String.fromCodePoint(0x1f1e6 + (c.charCodeAt(0) - 65)))
    .join('');
}

function fmtTime(tz) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || undefined,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date());
  } catch {
    return '--:--:--';
  }
}

function fmtDateTime(ts) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ts));
  } catch {
    return '—';
  }
}

function agoText(ts) {
  if (!ts) return '从未检测';
  const d = Date.now() - ts;
  if (d < 5000) return '刚刚';
  if (d < 60000) return `${Math.round(d / 1000)} 秒前`;
  if (d < 3600000) return `${Math.round(d / 60000)} 分钟前`;
  return `${Math.round(d / 3600000)} 小时前`;
}

function setBadge(el, confidence) {
  el.className = 'badge';
  const map = { high: ['高置信', 'high'], medium: ['中置信', 'medium'], low: ['低置信', 'low'] };
  if (map[confidence]) {
    el.textContent = map[confidence][0];
    el.classList.add(map[confidence][1]);
  } else {
    el.textContent = '—';
  }
}

function render() {
  const { state, settings } = current;
  const enabled = settings ? settings.enabled : false;

  $('enabled').checked = enabled;
  document.body.classList.toggle('disabled', !enabled);

  const dot = $('statusDot');
  dot.className = 'dot ' + (enabled ? 'on' : 'off');

  if (!state) {
    $('targetTz').textContent = '尚未检测';
    $('reason').textContent = '点下面的「立即重新检测」跑一次。';
    $('swName').textContent = '未检测';
    $('footLeft').textContent = '—';
    return;
  }

  // ---------- 时区 ----------
  const target = state.target || {};
  const tz = target.tz || '';
  $('targetTz').textContent = tz || '（跟随系统，未做修改）';
  const info = target.info;
  $('targetMeta').textContent = info && info.valid
    ? `${info.offsetText}${info.isDST ? ' · 夏令时' : ''} · ${info.localTime}`
    : '';
  $('systemTz').textContent = state.systemTz || '—';
  $('reason').textContent = target.reason || '';
  const applied = state.applied || {};
  const coverageErrors = (current.coverage || []).flatMap(item => item.errors || []);
  const failures = (applied.shim?.failed || 0) + (applied.cdp?.failed || 0);
  $('applyHint').textContent = applied.registration?.error
    ? '启动脚本未注册：' + applied.registration.error
    : failures || applied.cdp?.partial || coverageErrors.length
      ? `部分页面或子目标未覆盖（失败页面 ${failures}）；刷新目标网页并查看异常。`
      : '仅影响选定网页；安装或切换模式后请刷新目标网页。电脑系统时区不变。';

  // ---------- 代理软件 ----------
  const sw = (state.software && state.software.primary) || null;
  $('swName').textContent = sw ? sw.name : '未检测到已知代理软件';
  $('swNote').textContent = sw ? sw.portHint || '' : '可能没开代理，或者代理软件改了默认端口（可在设置里手动补端口）';
  setBadge($('swBadge'), sw ? sw.confidence : '');

  const ev = $('evidence');
  ev.innerHTML = '';
  for (const e of (sw && sw.evidence) || []) {
    const li = document.createElement('li');
    li.textContent = `[${e.source}] ${e.detail}`;
    ev.appendChild(li);
  }
  if (!(sw && sw.evidence && sw.evidence.length)) {
    const li = document.createElement('li');
    li.textContent = state.proxyConfig
      ? `浏览器代理模式：${state.proxyConfig.mode}${state.proxyConfig.pacUrl ? ' · PAC ' + state.proxyConfig.pacUrl : ''}`
      : '暂无证据';
    ev.appendChild(li);
  }

  const others = ((state.software && state.software.candidates) || []).filter(
    (c) => !sw || c.id !== sw.id
  );
  $('candidatesWrap').hidden = others.length === 0;
  $('candCount').textContent = String(others.length);
  const cand = $('candidates');
  cand.innerHTML = '';
  for (const c of others) {
    const li = document.createElement('li');
    li.textContent = `${c.name}（${c.score} 分 / ${c.confidence}）`;
    cand.appendChild(li);
  }

  // ---------- 出口 IP ----------
  const geo = state.geo || {};
  $('geoFlag').textContent = countryCodeToFlag(geo.countryCode);
  $('geoPlace').textContent =
    [geo.countryCn || geo.country, geo.city].filter(Boolean).join(' · ') || '未知';
  $('geoIp').textContent = geo.ip || '';
  const geoBadge = $('geoBadge');
  geoBadge.className = 'badge' + (geo.ok ? ' high' : ' low');
  geoBadge.textContent = geo.ok ? geo.sourceLabel || '已获取' : '失败';
  // 主界面只保留状态摘要，完整来源、降级原因和每个接口结果放在默认折叠区。
  $('geoHint').textContent = geo.source === 'target-trace'
    ? `来自 ${geo.probeHost} 的出口国家；外部地理接口暂不可用`
    : geo.exitVerified
      ? `已确认 ${geo.probeHost} 探测请求的出口${geo.ok ? '' : '；定位失败，展开诊断查看原因'}`
      : geo.warning || '未确认目标网站出口';
  const attempts = geo.attempts || [];
  $('geoAttemptsCard').hidden = attempts.length === 0 && !geo.warning;
  const attemptsEl = $('geoAttempts');
  attemptsEl.innerHTML = '';
  for (const attempt of attempts) {
    const li = document.createElement('li');
    li.textContent = `${attempt.id}：${attempt.ok ? '成功' : attempt.reason || '失败'}（${attempt.ms || 0}ms）`;
    attemptsEl.appendChild(li);
  }
  if (geo.warning) {
    const li = document.createElement('li');
    li.textContent = geo.warning;
    attemptsEl.appendChild(li);
  }

  // ---------- 端口 ----------
  const ports = state.openPorts || [];
  const nativeOk = Boolean(state.native && state.native.available);
  $('portsCard').hidden = ports.length === 0 && !(state.api || []).length && !nativeOk;
  const portsEl = $('ports');
  portsEl.innerHTML = '';
  for (const p of ports) {
    const s = document.createElement('span');
    s.className = 'port ' + p.state;
    s.textContent = `${p.port}${p.state === 'http' ? '' : '?'}`;
    s.title = p.state === 'http' ? `HTTP 响应 ${p.code || ''}` : '端口有监听但没回 HTTP（可能是 SOCKS）';
    portsEl.appendChild(s);
  }
  const apiEl = $('apiInfo');
  apiEl.innerHTML = '';
  for (const a of state.api || []) {
    const li = document.createElement('li');
    const p = a.ports || {};
    li.textContent =
      `Clash 控制台 127.0.0.1:${a.port} · 版本 ${a.version || '?'}${a.meta ? ' (meta)' : ''}` +
      (a.node ? ` · 当前节点 ${a.node}` : '') +
      (p.mixedPort || p.port ? ` · 入站端口 mixed=${p.mixedPort || '-'} http=${p.port || '-'} socks=${p.socksPort || '-'}` : '');
    apiEl.appendChild(li);
  }
  if (nativeOk) {
    const sp = state.native.systemProxy || {};
    const li = document.createElement('li');
    li.textContent =
      `原生宿主机：读到 ${state.native.count} 个代理相关进程` +
      (sp.server ? ` · 系统代理 ${sp.server}` : sp.enabled ? ' · 系统代理已开启' : '');
    apiEl.appendChild(li);
  } else if (state.native && state.native.reason) {
    const li = document.createElement('li');
    li.textContent = `原生宿主机未启用：${state.native.reason}`;
    apiEl.appendChild(li);
  }

  // ---------- 错误 ----------
  const errors = [...(state.errors || []),
    ...(applied.cdp?.details || []).map(item => `CDP 页面 ${item.tabId}：${item.error || JSON.stringify(item.errors || [])}`),
    ...coverageErrors.map(item => `CDP 子目标：${item.error}`),
    ...(applied.shim?.details || []).map(item => `页面同步 ${item.tabId}：${item.error}`)];
  $('errCard').hidden = errors.length === 0;
  $('diagnosticCount').textContent = errors.length ? `（异常 ${errors.length}）` : ports.length ? `（端口 ${ports.length}）` : '';
  const errEl = $('errors');
  errEl.innerHTML = '';
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = e;
    errEl.appendChild(li);
  }

  // ---------- 页脚 ----------
  $('footLeft').textContent = `${agoText(state.updatedAt)} · 耗时 ${state.durationMs || 0}ms`;
  const engineName = state.engine === 'cdp' ? 'CDP 深度模式' : state.engine === 'shim' ? '补丁模式' : '已关闭';
  $('footRight').textContent = `v${chrome.runtime.getManifest().version} · ${engineName} · 每 ${settings ? settings.refreshMinutes : '?'} 分钟`;
}

function startClock() {
  if (tickTimer) clearInterval(tickTimer);
  const tick = () => {
    const tz = current.state && current.state.target ? current.state.target.tz : '';
    $('targetClock').textContent = tz ? fmtTime(tz) : '--:--:--';
    $('systemClock').textContent = fmtTime('');
  };
  tick();
  tickTimer = setInterval(tick, 1000);
}

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res && res.ok) {
    current = { state: res.state, settings: res.settings, coverage: res.coverage || [] };
  }
  render();
  startClock();
}

async function refreshNow() {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'REFRESH', reason: 'popup' });
    if (res && res.ok) {
      current = { state: res.state, settings: res.settings };
      render();
      startClock();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '立即重新检测';
  }
}

$('enabled').addEventListener('change', async (e) => {
  const res = await chrome.runtime.sendMessage({
    type: 'SET_SETTINGS',
    patch: { enabled: e.target.checked },
    reason: 'reapply'
  });
  if (res && res.ok) {
    current = { state: res.state, settings: res.settings };
    render();
    startClock();
  }
});

$('refreshBtn').addEventListener('click', () => void refreshNow());
$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

void load();
