/** 时区相关的纯函数工具（浏览器 & Service Worker 都能用） */

const _zones = new Map();

/** 是否是浏览器能识别的合法 IANA 时区 */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (_zones.has(tz)) return _zones.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    // 额外排除 "UTC" 这类其实合法但我们不想误判成地区的情况交给调用方判断
    ok = true;
  } catch {
    ok = false;
  }
  _zones.set(tz, ok);
  return ok;
}

/** 本地系统当前时区 */
export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 目标时区在某个时间点的 UTC 偏移（分钟，东为正）
 * @param {string} tz
 * @param {number} ts 毫秒时间戳
 */
export function tzOffsetMinutes(tz, ts = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(ts));
    const m = {};
    for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
    let hour = Number(m.hour);
    if (hour === 24) hour = 0;
    const asUTC = Date.UTC(
      Number(m.year),
      Number(m.month) - 1,
      Number(m.day),
      hour,
      Number(m.minute),
      Number(m.second)
    );
    return Math.round((asUTC - Math.floor(ts / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

/** 系统当前偏移（分钟，东为正） */
export function systemOffsetMinutes(ts = Date.now()) {
  return -new Date(ts).getTimezoneOffset();
}

/** 把偏移分钟格式化成 GMT+08:00 */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `GMT${sign}${hh}:${mm}`;
}

/** 该时区当前是不是使用夏令时 */
export function isDST(tz, ts = Date.now()) {
  try {
    const jan = tzOffsetMinutes(tz, Date.UTC(new Date(ts).getUTCFullYear(), 0, 1));
    const jul = tzOffsetMinutes(tz, Date.UTC(new Date(ts).getUTCFullYear(), 6, 1));
    return tzOffsetMinutes(tz, ts) === Math.max(jan, jul) && jan !== jul;
  } catch {
    return false;
  }
}

/** 生成一个人类可读的时区摘要 */
export function describeTimeZone(tz, ts = Date.now()) {
  if (!isValidTimeZone(tz)) return { tz, valid: false };
  const off = tzOffsetMinutes(tz, ts);
  let local = '';
  try {
    local = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(ts));
  } catch {
    local = '';
  }
  return {
    tz,
    valid: true,
    offsetMinutes: off,
    offsetText: formatOffset(off),
    isDST: isDST(tz, ts),
    localTime: local
  };
}
