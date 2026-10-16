/** 一次性生成随扩展分发的小时区种子，不需要安装依赖或构建。 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COUNTRY_TZ } from '../src/common/country-tz.js';

const dir = new URL('../src/content/zone-seeds/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const zones = new Set([...Intl.supportedValuesOf('timeZone'), ...Object.values(COUNTRY_TZ), 'UTC']);
for (let offset = -14; offset <= 14; offset++) {
  const tz = 'Etc/GMT' + (offset >= 0 ? '+' : '') + offset;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); zones.add(tz); } catch { /* ICU 不支持的偏移跳过 */ }
}
for (const tz of [...zones]) zones.add(new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone);
const index = {};
for (const tz of [...zones].sort()) {
  const file = tz.replace(/[^A-Za-z0-9+-]/g, '_') + '.js';
  index[tz] = 'src/content/zone-seeds/' + file;
  fs.writeFileSync(new URL(file, dir), '/** 页面启动前的同步时区种子。 */\nwindow.__TZ_AUTO_SWITCH__ = ' + JSON.stringify(tz) + ';\n');
}
fs.writeFileSync(new URL('../src/tz/zone-seeds.js', import.meta.url), '/** 随扩展打包的时区种子索引，由 tools/seed-timezones.mjs 生成。 */\nexport const ZONE_SEEDS = ' + JSON.stringify(index, null, 2) + ';\n');
console.log(`已生成 ${zones.size} 个时区种子：${fileURLToPath(dir)}`);
