/** 工具栏只显示开关状态；城市和诊断信息放在悬停说明与详情弹窗。 */
const iconCache = new Map();
const colors = { on: '#16803c', off: '#64748b', waiting: '#d97706', error: '#c2410c' };

/** 同时提供常见缩放尺寸；圆点位置也表达状态，不只依靠颜色。 */
export function switchIcons(mode) {
  if (iconCache.has(mode)) return iconCache.get(mode);
  const images = {};
  for (const size of [16, 24, 32, 48]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.scale(size / 32, size / 32);
    ctx.fillStyle = colors[mode] || colors.off;
    ctx.beginPath();
    ctx.roundRect(1, 7, 30, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(mode === 'off' ? 10 : 22, 16, 6.5, 0, Math.PI * 2);
    ctx.fill();
    images[size] = ctx.getImageData(0, 0, size, size);
  }
  iconCache.set(mode, images);
  return images;
}

export async function updateToolbar(state) {
  const enabled = Boolean(state?.enabled);
  const tz = state?.target?.tz || '';
  const applied = state?.applied || {};
  const failed = applied.registration?.error || applied.shim?.failed || applied.cdp?.failed || applied.cdp?.partial;
  const mode = !enabled ? 'off' : failed ? 'error' : tz ? 'on' : 'waiting';
  const status = !enabled ? '已关闭' : failed ? '已开启，但部分页面应用异常' : tz ? `已开启 · 目标时区 ${tz}` : '已开启，尚未取得有效时区';
  try {
    await Promise.all([
      chrome.action.setBadgeText({ text: '' }),
      chrome.action.setTitle({ title: `代理时区自动切换：${status}\n点击查看详情或切换开关` }),
      chrome.action.setIcon({ imageData: switchIcons(mode) })
    ]);
  } catch (e) {
    console.warn('[tz-auto-switch] 工具栏状态更新失败', e);
  }
}
