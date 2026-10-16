/**
 * 页面时区适配：Date 的内部毫秒值始终是真实时间，只转换本地读写接口。
 * document_start 的时区种子与本文件按顺序注册；运行中的页面通过桥接更新。
 * 不覆盖 Worker，不声称补丁不可检测，也不修改操作系统时区。
 */
(() => {
  'use strict';
  const FLAG = '__TZ_AUTO_SWITCH_SHIM__';
  const MESSAGE = '__TZ_AUTO_SWITCH_MSG__';
  const seed = window.__TZ_AUTO_SWITCH__;
  if (window[FLAG] && typeof window[FLAG].update === 'function') {
    window[FLAG].update(seed);
    return;
  }
  const NativeDate = Date;
  const dp = NativeDate.prototype;
  const NativeDTF = Intl.DateTimeFormat;
  const getTime = dp.getTime;
  const setTime = dp.setTime;
  const parse = NativeDate.parse;
  const now = NativeDate.now;
  const utc = NativeDate.UTC;
  const nativeToString = Function.prototype.toString;
  const native = Object.fromEntries(Object.getOwnPropertyNames(dp).map(k => [k, dp[k]]));
  const descriptors = [];
  const fakeSource = new WeakMap();
  const formatters = new Map();
  let zone = null;
  let installed = false;

  function valid(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new NativeDTF('en-US', { timeZone: tz }); return true; } catch { return false; }
  }
  function mark(fn, name) {
    fakeSource.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
  }
  function patch(object, key, value) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    descriptors.push({ object, key, descriptor, value });
    Object.defineProperty(object, key, { ...descriptor, value });
  }
  function method(key, fn) { patch(dp, key, mark(fn, key)); }

  /** 用数字传入原生 Intl，内部不经过可被网页改写的 Date 方法。 */
  function parts(ts, tz) {
    if (!formatters.has(tz)) formatters.set(tz, new NativeDTF('en-US-u-ca-gregory-nu-latn', {
      timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    const p = {};
    for (const item of formatters.get(tz).formatToParts(ts)) if (item.type !== 'literal') p[item.type] = item.value;
    return [p.era === 'BC' ? 1 - Number(p.year) : Number(p.year), +p.month - 1, +p.day, +p.hour, +p.minute, +p.second,
      ((ts % 1000) + 1000) % 1000];
  }
  function wallTimestamp(fields) {
    // setUTCFullYear 不会把公元 0..99 年重新解释为 1900..1999 年。
    const d = new NativeDate(0);
    native.setUTCFullYear.call(d, fields[0], fields[1], fields[2]);
    native.setUTCHours.call(d, fields[3], fields[4], fields[5], fields[6]);
    return getTime.call(d);
  }
  function offset(ts, tz) { return wallTimestamp(parts(ts, tz)) - ts; }
  function localDate(ts) { return new NativeDate(wallTimestamp(parts(ts, zone))); }

  /** 本地墙钟转真实时间：重叠选较早时刻；不存在的时间向前跨过缺口。 */
  function fromWall(wall, tz) {
    if (!Number.isFinite(wall)) return NaN;
    const offsets = new Set([-2, -1, 0, 1, 2].map(days => offset(wall + days * 86400000, tz)));
    const exact = [];
    const after = [];
    for (const off of offsets) {
      const candidate = wall - off;
      const actualWall = wallTimestamp(parts(candidate, tz));
      if (actualWall === wall) exact.push(candidate);
      else if (actualWall > wall) after.push({ candidate, gap: actualWall - wall });
    }
    if (exact.length) return Math.min(...exact);
    after.sort((a, b) => a.gap - b.gap || a.candidate - b.candidate);
    return after.length ? after[0].candidate : NaN;
  }
  function explicitOffset(s) {
    // Date.parse 支持的传统北美缩写也是显式时区；括号注释中的缩写不算。
    const withoutComments = s.replace(/\([^)]*\)/g, '').trim();
    return /^(?:\d{4}|[+\-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/.test(s) ||
      /[zZ]$|[+\-]\d{2}:?\d{2}$|\b(?:gmt|utc|ut|est|edt|cst|cdt|mst|mdt|pst|pdt)\b/i.test(withoutComments);
  }
  function parseLocal(value) {
    // 模板字符串遵循 ToString，Symbol 会与原生 Date.parse 一样抛错。
    const s = `${value}`.trim();
    const parsed = parse(s);
    if (!zone || !Number.isFinite(parsed) || explicitOffset(s)) return parsed;
    if (/^(?:\d{4}|[+\-]\d{6})-\d{2}-\d{2}T/i.test(s)) return fromWall(parse(s + 'Z'), zone);
    const d = new NativeDate(parsed);
    const fields = ['getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds']
      .map(k => native[k].call(d));
    return fromWall(wallTimestamp(fields), zone);
  }
  function primitive(value) {
    if (value === null || !['object', 'function'].includes(typeof value)) return value;
    const custom = value[Symbol.toPrimitive];
    if (custom !== undefined && custom !== null) {
      if (typeof custom !== 'function') throw new TypeError('无法转换日期参数');
      const result = custom.call(value, 'default');
      if (result === null || !['object', 'function'].includes(typeof result)) return result;
      throw new TypeError('日期参数必须转换为原始值');
    }
    for (const key of ['valueOf', 'toString']) {
      if (typeof value[key] !== 'function') continue;
      const result = value[key]();
      if (result === null || !['object', 'function'].includes(typeof result)) return result;
    }
    throw new TypeError('无法转换日期参数');
  }
  function constructArgs(args) {
    if (!zone || !args.length) return args;
    if (args.length >= 2) return [fromWall(utc(...args.slice(0, 7)), zone)];
    const a = args[0];
    if (a !== null && ['object', 'function'].includes(typeof a)) {
      try { return [getTime.call(a)]; } catch { /* 非 Date 对象按原生 ToPrimitive 转换 */ }
    }
    const value = primitive(a);
    return typeof value === 'string' ? [parseLocal(value)] : [value];
  }
  function stringParts(ts) {
    const fields = parts(ts, zone);
    const d = new NativeDate(wallTimestamp(fields));
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const date = `${weekdays[native.getUTCDay.call(d)]} ${months[fields[1]]} ${String(fields[2]).padStart(2, '0')} ${String(fields[0]).padStart(4, '0')}`;
    const off = Math.round(offset(ts, zone) / 60000);
    const abs = Math.abs(off);
    const gmt = 'GMT' + (off < 0 ? '-' : '+') + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
    const name = new NativeDTF('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(ts).find(p => p.type === 'timeZoneName').value;
    const time = fields.slice(3, 6).map(n => String(n).padStart(2, '0')).join(':') + ` ${gmt} (${name})`;
    return { date, time };
  }
  function withZone(options) {
    if (options === null) throw new TypeError('日期格式化选项不能是 null');
    // 继承选项而非复制，保留原型上的显式 timeZone 和非枚举属性。
    const result = Object.create(options === undefined ? null : Object(options));
    if (result.timeZone === undefined) Object.defineProperty(result, 'timeZone', { value: zone, enumerable: true });
    return result;
  }

  function install() {
    if (installed) return;
    installed = true;
    const parseShim = mark(function parse(value) { return parseLocal(value); }, 'parse');
    const DateShim = mark(new Proxy(NativeDate, {
      construct(target, args, newTarget) { return Reflect.construct(target, constructArgs(args), newTarget); },
      apply(target, thisArg, args) {
        if (!zone) return Reflect.apply(target, thisArg, args);
        const p = stringParts(now()); return p.date + ' ' + p.time;
      }
    }), 'Date');
    const DateTimeFormatShim = mark(new Proxy(NativeDTF, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, [args[0], zone ? withZone(args[1]) : args[1]], newTarget);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target, thisArg, [args[0], zone ? withZone(args[1]) : args[1]]);
      }
    }), 'DateTimeFormat');
    const getters = { getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate', getDay: 'getUTCDay',
      getHours: 'getUTCHours', getMinutes: 'getUTCMinutes', getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds' };
    for (const [key, utcKey] of Object.entries(getters)) method(key, function () {
      const ts = getTime.call(this);
      if (!zone || !Number.isFinite(ts)) return native[key].call(this);
      return native[utcKey].call(localDate(ts));
    });
    method('getYear', function getYear() {
      const ts = getTime.call(this);
      return zone && Number.isFinite(ts) ? parts(ts, zone)[0] - 1900 : native.getYear.call(this);
    });
    method('getTimezoneOffset', function getTimezoneOffset() {
      const ts = getTime.call(this);
      return zone && Number.isFinite(ts) ? -offset(ts, zone) / 60000 : native.getTimezoneOffset.call(this);
    });
    const setters = { setFullYear: 'setUTCFullYear', setMonth: 'setUTCMonth', setDate: 'setUTCDate', setHours: 'setUTCHours',
      setMinutes: 'setUTCMinutes', setSeconds: 'setUTCSeconds', setMilliseconds: 'setUTCMilliseconds' };
    for (const [key, utcKey] of Object.entries(setters)) method(key, function (...args) {
      if (!zone) return native[key].apply(this, args);
      const ts = getTime.call(this);
      const wall = Number.isFinite(ts) ? localDate(ts) : new NativeDate(NaN);
      const next = native[utcKey].apply(wall, args);
      return setTime.call(this, fromWall(next, zone));
    });
    method('setYear', function setYear(year) {
      if (!zone) return native.setYear.call(this, year);
      const n = +year;
      const y = Number.isFinite(n) && Math.trunc(n) >= 0 && Math.trunc(n) <= 99 ? Math.trunc(n) + 1900 : n;
      const ts = getTime.call(this);
      const wall = Number.isFinite(ts) ? localDate(ts) : new NativeDate(NaN);
      const next = native.setUTCFullYear.call(wall, y);
      return setTime.call(this, fromWall(next, zone));
    });
    for (const [key, which] of [['toString', 'both'], ['toDateString', 'date'], ['toTimeString', 'time']]) method(key, function () {
      const ts = getTime.call(this);
      if (!zone || !Number.isFinite(ts)) return native[key].call(this);
      const p = stringParts(ts);
      return which === 'both' ? p.date + ' ' + p.time : p[which];
    });
    for (const key of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) method(key, function (locales, options) {
      // 对应原生方法保留默认字段、异常、dateStyle/timeStyle 的原生语义。
      return native[key].call(this, locales, zone ? withZone(options) : options);
    });
    patch(NativeDate, 'parse', parseShim);
    patch(dp, 'constructor', DateShim);
    patch(NativeDTF.prototype, 'constructor', DateTimeFormatShim);
    patch(window, 'Date', DateShim);
    patch(Intl, 'DateTimeFormat', DateTimeFormatShim);
    patch(Function.prototype, 'toString', mark(function toString() {
      return fakeSource.get(this) || nativeToString.call(this);
    }, 'toString'));
  }
  function restore() {
    // 仅恢复自己仍持有的属性，避免覆盖网页后来安装的其他适配器。
    for (const entry of descriptors.splice(0).reverse()) {
      if (Object.getOwnPropertyDescriptor(entry.object, entry.key)?.value === entry.value) {
        Object.defineProperty(entry.object, entry.key, entry.descriptor);
      }
    }
    installed = false;
    formatters.clear();
  }
  function update(tz) {
    zone = valid(tz) ? tz : null;
    if (zone) install(); else restore();
  }
  Object.defineProperty(window, FLAG, { value: { update }, configurable: true });
  window.addEventListener('message', ev => {
    if (ev.source === window && ev.data?.type === MESSAGE) update(ev.data.tz);
  });
  let initial = seed;
  if (!initial) initial = document.documentElement?.getAttribute('data-tz-auto-switch');
  update(initial);
})();
