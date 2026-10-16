/** 使用独立进程验证真正的 Date/Intl，避免各用例修改全局后的相互污染。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/content/tz-shim.js'), 'utf8');
const setup = `
const NativeDate = Date;
const NativeDTF = Intl.DateTimeFormat;
const nativeGetTime = Date.prototype.getTime;
const nativeFts = Function.prototype.toString;
const beforeDate = new Date('2024-06-01T12:00:00Z');
const handlers = [];
globalThis.addEventListener = (name, fn) => { if (name === 'message') handlers.push(fn); };
globalThis.removeEventListener = () => {};
globalThis.__TZ_AUTO_SWITCH__ = 'America/New_York';
const document = { documentElement: { getAttribute() { return null; } }, addEventListener() {} };
new Function('window', 'document', 'queueMicrotask', 'setTimeout', ${JSON.stringify(source)})(globalThis, document, queueMicrotask, setTimeout);
const switchZone = tz => handlers.forEach(fn => fn({ source: globalThis, data: { type: '__TZ_AUTO_SWITCH_MSG__', tz } }));
const emit = value => console.log(JSON.stringify(value));
`;

function run(body, systemTz = 'Asia/Shanghai') {
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-'], {
    input: setup + body, cwd: root, encoding: 'utf8',
    env: { ...process.env, TZ: systemTz }, timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout.trim());
}

test('已有 Date 及切换、关闭后的 Date 保持同一个真实时刻', () => {
  assert.deepEqual(run(`
const d = new Date('2024-06-01T12:00:00Z');
const values = [beforeDate.getTime(), d.getTime()];
switchZone('Asia/Tokyo'); values.push(d.getTime());
switchZone(null); values.push(d.getTime()); emit(values);
`), [1717243200000, 1717243200000, 1717243200000, 1717243200000]);
});
test('显式 Intl 时区的格式及 resolvedOptions 保持一致', () => {
  assert.deepEqual(run(`const f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', hour: '2-digit' }); emit([f.resolvedOptions().timeZone, f.format(1717243200000)]);`), ['UTC', '12']);
});
test('默认本地格式化保留各自的日期与时间字段', () => {
  assert.deepEqual(run(`const d = new Date('2024-06-01T12:00:00Z'); emit([d.toLocaleTimeString('en-US'), d.toLocaleString('en-US'), d.toLocaleDateString('en-US')]);`), ['8:00:00 AM', '6/1/2024, 8:00:00 AM', '6/1/2024']);
});
test('UTC setter 直接操作真实 UTC 值', () => {
  assert.equal(run(`const d = new Date('2024-06-01T12:00:00Z'); d.setUTCHours(12); emit(d.toISOString());`), '2024-06-01T12:00:00.000Z');
});
test('本地 setter 返回真实时间戳', () => {
  assert.deepEqual(run(`const d = new Date('2024-06-01T12:00:00Z'); const result = d.setHours(9); emit([result, d.getTime(), d.getHours()]);`), [1717246800000, 1717246800000, 9]);
});
test('夏令时回拨的两个绝对时刻不会合并', () => {
  assert.deepEqual(run(`emit(['2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z'].map(s => new Date(s).toISOString()));`), ['2024-11-03T05:30:00.000Z', '2024-11-03T06:30:00.000Z']);
});
test('夏令时重叠本地时间选择较早时刻', () => {
  assert.equal(run(`emit(new Date('2024-11-03T01:30:00').toISOString());`), '2024-11-03T05:30:00.000Z');
});
test('夏令时跳过的本地时间向前跨过缺口', () => {
  assert.equal(run(`emit(new Date('2024-03-10T02:30:00').toISOString());`), '2024-03-10T07:30:00.000Z');
});
test('Date 子类保留自己的原型', () => {
  assert.deepEqual(run(`class CustomDate extends Date {} const d = new CustomDate(0); emit([d instanceof CustomDate, d instanceof Date, d.toISOString()]);`), [true, true, '1970-01-01T00:00:00.000Z']);
});
test('结构化克隆保留真实内部时间戳', () => {
  assert.deepEqual(run(`const d = structuredClone(new Date('2024-06-01T12:00:00Z')); emit([nativeGetTime.call(d), d.toISOString()]);`), [1717243200000, '2024-06-01T12:00:00.000Z']);
});
test('关闭时恢复 Date、Intl 以及函数原始引用', () => {
  assert.deepEqual(run(`switchZone(null); emit([Date === NativeDate, Intl.DateTimeFormat === NativeDTF, Function.prototype.toString === nativeFts]);`), [true, true, true]);
});
test('Date() 无 new 调用忽略传入参数', () => {
  assert.equal(run(`emit(Date(0) === Date());`), true);
});
test('系统使用夏令时时，本地 getter 仍按目标时区计算', () => {
  assert.deepEqual(run(`const d = new Date('2024-03-31T00:30:00Z'); emit([d.getHours(), d.getTime(), d.getTimezoneOffset()]);`, 'Europe/London'), [20, 1711845000000, 240]);
});
test('ISO 纯年、年月和扩展年份日期仍按 UTC 解析', () => {
  assert.deepEqual(run(`emit(['2024','2024-06','+002024-06-01'].map(value => new Date(value).toISOString()));`),
    ['2024-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z']);
});
test('网页仍可正常替换 Date.parse', () => {
  assert.equal(run(`Date.parse = () => 123; emit(Date.parse('anything'));`), 123);
});
test('浏览器支持的显式 EST/PDT 时区不被二次转换', () => {
  assert.deepEqual(run(`emit(['Mon, 25 Dec 1995 13:30:00 EST', 'Sat, 01 Jun 2024 12:00:00 PDT'].map(value => new Date(value).toISOString()));`),
    ['1995-12-25T18:30:00.000Z', '2024-06-01T19:00:00.000Z']);
});
