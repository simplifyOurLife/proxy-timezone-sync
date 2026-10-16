/** 设置页逻辑 */

import { DEFAULT_SETTINGS } from '../common/settings.js';

const $ = (id) => document.getElementById(id);

function toast(text, ok = true) {
  const el = $('toast');
  el.textContent = text;
  el.style.color = ok ? '' : 'var(--accent)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function fillForm(settings) {
  $('enabled').checked = settings.enabled;
  $('onlyWhenProxied').checked = settings.onlyWhenProxied;
  $('refreshMinutes').value = String(settings.refreshMinutes);
  $('countryFallback').checked = settings.countryFallback;
  $('exitProbeUrl').value = settings.exitProbeUrl;
  $('allowGenericExit').checked = settings.allowGenericExit;
  $('includedDomains').value = (settings.includedDomains || []).join('\n');
  $('manualTimezone').value = settings.manualTimezone || '';
  $('localProbe').checked = settings.localProbe;
  $('extraProbePorts').value = settings.extraProbePorts || '';
  $('nativeProbe').checked = settings.nativeProbe;
  $('showDebug').checked = settings.showDebug;
  $('excludedDomains').value = (settings.excludedDomains || []).join('\n');
  const engine = settings.engine === 'cdp' ? 'cdp' : 'shim';
  for (const r of document.querySelectorAll('input[name="engine"]')) r.checked = r.value === engine;
}

function readForm() {
  const engineInput = document.querySelector('input[name="engine"]:checked');
  return {
    enabled: $('enabled').checked,
    onlyWhenProxied: $('onlyWhenProxied').checked,
    refreshMinutes: Number($('refreshMinutes').value) || 5,
    countryFallback: $('countryFallback').checked,
    exitProbeUrl: $('exitProbeUrl').value.trim(),
    allowGenericExit: $('allowGenericExit').checked,
    includedDomains: $('includedDomains').value.split('\n').map(s => s.trim()).filter(Boolean),
    manualTimezone: $('manualTimezone').value.trim(),
    engine: engineInput ? engineInput.value : 'shim',
    localProbe: $('localProbe').checked,
    extraProbePorts: $('extraProbePorts').value.trim(),
    nativeProbe: $('nativeProbe').checked,
    showDebug: $('showDebug').checked,
    excludedDomains: $('excludedDomains')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  };
}

function renderCheck(state, settings) {
  if (!state) {
    $('chkSystem').textContent = '—';
    return;
  }
  $('chkSystem').textContent = state.systemTz || '—';
  $('chkTarget').textContent = state.target && state.target.tz ? state.target.tz : '（跟随系统）';
  $('chkIp').textContent = state.geo && state.geo.ip ? `${state.geo.ip} · ${state.geo.countryCn || state.geo.country || ''}` : '未获取';
  $('chkSw').textContent = state.software && state.software.primary
    ? `${state.software.primary.name}（${state.software.primary.confidence}）`
    : '未识别';
  $('chkTime').textContent = state.updatedAt ? new Date(state.updatedAt).toLocaleString('zh-CN') : '—';
  $('chkEngine').textContent = !state.enabled
    ? '已关闭'
    : state.engine === 'cdp'
      ? 'CDP 深度模式'
      : '补丁模式';
  void settings;
}

async function loadState() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res && res.ok) {
    fillForm(res.settings);
    renderCheck(res.state, res.settings);
    $('extId').textContent = chrome.runtime.id;
  }
  if (!document.querySelector('input[name="engine"]:checked')) {
    document.querySelector('input[name="engine"][value="shim"]').checked = true;
  }
}

function buildTzList() {
  const list = $('tzList');
  if (!list) return;
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'];
  }
  const frag = document.createDocumentFragment();
  for (const z of zones) {
    const o = document.createElement('option');
    o.value = z;
    frag.appendChild(o);
  }
  list.appendChild(frag);
}

async function save(reason) {
  const patch = readForm();
  const res = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch, reason });
  if (res && res.ok) {
    fillForm(res.settings);
    renderCheck(res.state, res.settings);
    toast(reason === 'reset' ? '已恢复默认' : '已保存');
  } else {
    toast('保存失败：' + ((res && res.error) || '未知错误'), false);
  }
}

$('save').addEventListener('click', () => void save('save'));
$('refresh').addEventListener('click', () => void save('reapply'));
$('reset').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: DEFAULT_SETTINGS, reason: 'reset' });
  if (res && res.ok) {
    fillForm(res.settings);
    renderCheck(res.state, res.settings);
    toast('已恢复默认');
  }
});

$('copyId').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    toast('已复制扩展 ID');
  } catch {
    toast('复制失败，手动选中吧', false);
  }
});

$('grantNative').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
    if (granted) {
      await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { nativeProbe: true }, reason: 'reapply' });
      $('nativeProbe').checked = true;
      toast('已授权，且已开启原生探测');
    } else {
      toast('授权被拒绝', false);
    }
  } catch (e) {
    toast('授权失败：' + String((e && e.message) || e), false);
  }
});

buildTzList();
void loadState();
