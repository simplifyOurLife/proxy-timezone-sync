/**
 * tz-shim.js 行为测试（Node 全局 Date/Intl；浏览器生命周期另行实测）
 * ------------------------------------------------------------------
 * 做法：把 shim 源码用 new Function 包起来，传进去的 window 就是真实的
 * globalThis：它会直接修改当前进程的
 * Date 和 Intl.DateTimeFormat，然后我们逐条验证行为。
 *
 * 使用独立 Node 进程，不把隔离上下文或 mock 的 Intl 当成浏览器实现。
 *
 * 运行：
 *   $env:TZ = 'Asia/Shanghai'; node tools/test-shim.cjs
 */

const fs = require('fs');
const path = require('path');

/* ---------- 先把原生实现全部存下来（shim 会覆盖全局） ---------- */
const NativeDate = Date;
const NativeIntl = Intl;
const NativeDTF = Intl.DateTimeFormat;
const nativeNow = () => NativeDate.now();
const nativeGetTime = (d) => NativeDate.prototype.getTime.call(d);

const ROOT = path.resolve(__dirname, '..');
const SHIM_SRC = fs.readFileSync(path.join(ROOT, 'src', 'content', 'tz-shim.js'), 'utf8');

const TARGET = 'America/New_York';
const SYSTEM_TZ = NativeIntl.DateTimeFormat().resolvedOptions().timeZone;

let pass = 0;
let fail = 0;

function ok(name, got, want) {
  if (got === want) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + '\n      got  = ' + show(got) + '\n      want = ' + show(want));
  }
}
function near(name, got, want, tol) {
  if (typeof got === 'number' && Math.abs(got - want) <= tol) {
    pass++;
    console.log('  \u2713 ' + name + '   (' + got + ' ≈ ' + want + ')');
  } else {
    fail++;
    console.log('  \u2717 ' + name + '\n      got = ' + show(got) + '\n      want ≈ ' + want);
  }
}
function show(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return '<显示不了>';
  }
}

/* ---------- 用原生实现算期望值 ---------- */
/*
 * ⚠ 这里必须非常小心：shim 生效后，所有 Date 对象的方法（包括原型上的）
 * 都是补丁版，且补丁假定「内部值已经位移过」。所以测试基准里
 *   · 给 Intl 传的必须是数字时间戳，不能传 Date（Date 会被 Intl 调 valueOf）
 *   · 读原生 Date 的值必须用提前抓好的原生方法
 */
const nativeGetUTCHours = NativeDate.prototype.getUTCHours;
const nativeGetUTCDate = NativeDate.prototype.getUTCDate;
// 注意：必须在这里就把方法引用抓下来，不能等到调用时再 NativeDate.prototype.getTime
// —— 那时候属性已经被 shim 换掉了，等于又调了补丁版
const nativeGetTimeMethod = NativeDate.prototype.getTime;
const nativeGetTimeOf = (d) => nativeGetTimeMethod.call(d);

function nativeOffsetMin(tz, ts) {
  const parts = new NativeDTF('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(ts);
  const m = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  let h = Number(m.hour);
  if (h === 24) h = 0;
  return Math.round((NativeDate.UTC(+m.year, +m.month - 1, +m.day, h, +m.minute, +m.second) - Math.floor(ts / 1000) * 1000) / 60000);
}
function nativeLocalHour(tz, ts) {
  for (const p of new NativeDTF('en-US', { timeZone: tz, hour12: false, hour: '2-digit' }).formatToParts(ts)) {
    if (p.type === 'hour') return Number(p.value) % 24;
  }
  return -1;
}
function nativeRealHour(tz) {
  return nativeLocalHour(tz, nativeNow());
}
function nativeOffsetNow(tz) {
  return nativeOffsetMin(tz, nativeNow());
}

/* ---------- 假 dashboard ---------- */
function makeWindow(attributeValue) {
  return {
    document: {
      documentElement: {
        getAttribute(k) {
          return k === 'data-tz-auto-switch' ? attributeValue : null;
        },
        setAttribute() {},
        removeAttribute() {}
      },
      addEventListener() {}
    }
  };
}

function runShim(attributeValue) {
  delete globalThis.__TZ_AUTO_SWITCH_SHIM__;
  globalThis.__TZ_AUTO_SWITCH__ = attributeValue || undefined;
  // Node 的全局没有 addEventListener，补一个空实现（等价于浏览器里的监听注册）
  if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = function () {};
  }
  const fake = makeWindow(attributeValue);
  // 关键：window 传真实 globalThis，等价于浏览器主世界
  const fn = new Function('window', 'document', 'queueMicrotask', 'setTimeout', SHIM_SRC);
  fn(globalThis, fake.document, queueMicrotask, setTimeout);
}

/* ================================================================== */
console.log('宿主（Node 进程）时区 = ' + SYSTEM_TZ);
console.log('目标时区              = ' + TARGET);
console.log('');
if (SYSTEM_TZ === TARGET) {
  console.log('⚠ 宿主时区和目标时区相同，建议用 TZ=Asia/Shanghai 运行。');
  console.log('');
}

/* ================= 场景 1：未生效（不该动任何东西） ================= */
console.log('[场景 1] 未提供目标时区 —— 应该完全保持原生行为');
runShim(null);

ok('resolvedOptions().timeZone 还是系统时区', Intl.DateTimeFormat().resolvedOptions().timeZone, SYSTEM_TZ);
ok('getTimezoneOffset() 是系统偏移', new Date().getTimezoneOffset(), -nativeOffsetMin(SYSTEM_TZ, nativeNow()));
ok('getHours() 是系统小时', new Date().getHours(), nativeRealHour(SYSTEM_TZ));
ok('Date.toString() 还是原生的', String(Date).indexOf('[native code]') >= 0, true);

/* ================= 场景 2：生效 ================= */
console.log('');
console.log('[场景 2] 提供目标时区 ' + TARGET + ' —— 应该整体切过去');
runShim(TARGET);

// —— 身份与伪装 ——
ok('Intl.DateTimeFormat().resolvedOptions().timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone, TARGET);
ok("new Intl.DateTimeFormat('en-US') 也报目标时区", new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone, TARGET);
ok('Date.toString() 看起来是原生的', String(Date), 'function Date() { [native code] }');
ok('Date.prototype.getTimezoneOffset.toString() 看起来是原生的', String(Date.prototype.getTimezoneOffset), 'function getTimezoneOffset() { [native code] }');
ok('Function.prototype.toString.toString() 也是原生的', String(Function.prototype.toString), 'function toString() { [native code] }');
ok('Date.prototype 保持原生对象', Date.prototype === NativeDate.prototype, true);
ok('new Date() instanceof Date', new Date() instanceof Date, true);
ok('Object.prototype.toString.call(new Date())', Object.prototype.toString.call(new Date()), '[object Date]');
ok('Date.length === 7', Date.length, 7);
ok('Date.name === "Date"', Date.name, 'Date');
ok('Object.getPrototypeOf(Date) === Function.prototype', Object.getPrototypeOf(Date) === Function.prototype, true);
ok('Date.now 描述符不可枚举', Object.getOwnPropertyDescriptor(Date, 'now').enumerable, false);

// —— 核心：时区 ——
ok('getTimezoneOffset() 跟随目标时区', new Date().getTimezoneOffset(), -nativeOffsetNow(TARGET));
ok('getHours() 等于目标时区小时', new Date().getHours(), nativeRealHour(TARGET));
near('getTime() 仍是真实时间戳', new Date().getTime(), nativeNow(), 10000);
near('Date.now() 未受影响', Date.now(), nativeNow(), 10000);
near('valueOf() 仍是真实时间戳', +new Date(), nativeNow(), 10000);
near('setTime 往返无漂移', (() => { const d = new Date(); const t = d.getTime(); d.setTime(t + 3600000); return d.getTime() - t - 3600000; })(), 0, 1);
ok('getUTCHours() 仍是真实 UTC 小时',
  Math.abs(new Date().getUTCHours() - nativeGetUTCHours.call(new NativeDate())) <= 1, true);
ok('getUTCDate() 仍是真实 UTC 日期',
  new Date().getUTCDate(), nativeGetUTCDate.call(new NativeDate()));

// —— 绝对时刻 → 目标时区墙钟 ——
ok("new Date('2024-06-01T12:00:00Z').getHours() === 8（纽约夏令时）",
  new Date('2024-06-01T12:00:00Z').getHours(), 8);
ok('new Date(0).toISOString() 不变', new Date(0).toISOString(), '1970-01-01T00:00:00.000Z');
ok('new Date(0) 在纽约是 1969-12-31 19:00',
  [new Date(0).getFullYear(), new Date(0).getMonth(), new Date(0).getDate(), new Date(0).getHours()].join(','),
  '1969,11,31,19');
ok('new Date(1717243200000).toISOString()',
  new Date(1717243200000).toISOString(), '2024-06-01T12:00:00.000Z');
ok('new Date(new Date()) 时间戳不变',
  (() => { const src = new Date(); return new Date(src).getTime() === src.getTime(); })(), true);
ok('new Date(new Date(x)) 保留时刻',
  (() => { const src = new Date(1717243200000); return new Date(src).getTime() === src.getTime() && new Date(src).toISOString() === src.toISOString(); })(), true);

// —— 本地时间语义 ——
ok("new Date('2024-06-01T12:00:00') 墙钟 12:00",
  [new Date('2024-06-01T12:00:00').getHours(), new Date('2024-06-01T12:00:00').getDate()].join(','),
  '12,1');
ok('new Date(2024, 5, 1, 12, 0, 0) 墙钟 12:00', new Date(2024, 5, 1, 12, 0, 0).getHours(), 12);
ok("new Date('2024-06-01') 按 UTC", new Date('2024-06-01').toISOString(), '2024-06-01T00:00:00.000Z');
ok('setHours 之后 getHours 正确', (() => { const d = new Date(2024, 0, 15, 3, 0, 0); d.setHours(21); return d.getHours(); })(), 21);

// —— parse ——
ok("Date.parse('2024-06-01T12:00:00Z')", Date.parse('2024-06-01T12:00:00Z'), NativeDate.UTC(2024, 5, 1, 12));
ok("Date.parse('2024-06-01T12:00:00') 按目标时区解释", Date.parse('2024-06-01T12:00:00'), NativeDate.UTC(2024, 5, 1, 16));
ok('parse 后再构造墙钟仍然正确', new Date(Date.parse('2024-06-01T12:00:00')).getHours(), 12);
ok('Date.UTC 不变', Date.UTC(2024, 5, 1, 12), NativeDate.UTC(2024, 5, 1, 12));

// —— 字符串输出 ——
const now = new Date();
ok('toString 带目标时区偏移', /GMT-(04|05)00/.test(now.toString()), true);
ok('toTimeString 带目标时区偏移', /GMT-(04|05)00/.test(now.toTimeString()), true);
ok('toString 不是 Invalid Date', now.toString().indexOf('Invalid') < 0, true);
ok('toISOString 与真实 UTC 一致',
  Math.abs(nativeGetTimeOf(new NativeDate(now.toISOString())) - nativeNow()) < 10000, true);
ok('toJSON() === toISOString()',
  (() => { const d = new Date(); return d.toJSON() === d.toISOString(); })(), true);
ok("toLocaleString('en-US') 用目标时区（12:00Z → 08:00）",
  new Date('2024-06-01T12:00:00Z').toLocaleString('en-US', { hour12: false, hour: '2-digit' }), '08');
ok('Intl 格式化用目标时区',
  new Intl.DateTimeFormat('en-US', { hour12: false, hour: '2-digit' }).format(new Date('2024-06-01T12:00:00Z')), '08');
ok('显式指定 timeZone 时尊重调用方',
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour12: false, hour: '2-digit' }).format(new Date('2024-06-01T12:00:00Z')), '12');
ok('时区长名是纽约的',
  new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date('2024-06-01T12:00:00Z')).some((p) => p.type === 'timeZoneName' && /Eastern/.test(p.value)), true);

// —— 边界 ——
ok("new Date('xxx').toString()", new Date('xxx').toString(), 'Invalid Date');
ok('Invalid Date 的 getTime 是 NaN', String(new Date('xxx').getTime()), 'NaN');
ok('Invalid Date 的 getTimezoneOffset 是 NaN', String(new Date('xxx').getTimezoneOffset()), 'NaN');
ok('Invalid Date 的 toISOString 抛 RangeError', (() => { try { new Date('xxx').toISOString(); return 'no-throw'; } catch (e) { return e.name; } })(), 'RangeError');
ok('无 new 调用 Date() 返回字符串', typeof Date(), 'string');
ok('Date() 的字符串带目标时区偏移', /GMT-(04|05)00/.test(Date()), true);
ok("toISOString 对 Date(0) 稳定", new Date(0).toISOString(), '1970-01-01T00:00:00.000Z');

/* ================= 汇总 ================= */
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
