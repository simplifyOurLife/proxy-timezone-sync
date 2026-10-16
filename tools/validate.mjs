/**
 * 扩展静态校验（不联网、不起浏览器）
 * ------------------------------------------------------------------
 * 1. manifest.json 里引用的每个文件是否真的存在
 * 2. 每个 ESM 文件的 import 目标是否存在、被导入的名字是否真的被导出
 * 3. HTML 里引用的 js/css 是否存在
 * 4. 常见 MV3 坑（内联脚本、缺权限、world 值写错等）
 *
 * 用法：node tools/validate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const errors = [];
const warnings = [];
const notes = [];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const exists = (p) => fs.existsSync(p);

function err(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/* ---------------------------------------------------------------- */
/* 1. manifest                                                       */
/* ---------------------------------------------------------------- */
const manifestPath = path.join(ROOT, 'manifest.json');
if (!exists(manifestPath)) {
  err('找不到 manifest.json');
}
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  err('manifest.json 不是合法 JSON：' + e.message);
}

if (manifest) {
  notes.push(`manifest: v${manifest.manifest_version} ${manifest.name} ${manifest.version}`);

  if (manifest.manifest_version !== 3) err('manifest_version 应该是 3');
  if (manifest.default_locale && !exists(path.join(ROOT, '_locales'))) {
    err('声明了 default_locale 但没有 _locales 目录，扩展会加载失败');
  }

  const check = (p, what) => {
    if (!p) return;
    if (!exists(path.join(ROOT, p))) err(`${what} 指向的文件不存在：${p}`);
  };

  check(manifest.background?.service_worker, 'background.service_worker');
  if (manifest.background?.type !== 'module' && manifest.background?.service_worker?.startsWith('src/background')) {
    warn('background.js 里用了 import，manifest.background.type 应该是 "module"');
  }
  check(manifest.action?.default_popup, 'action.default_popup');
  check(manifest.options_page, 'options_page');

  for (const [size, p] of Object.entries(manifest.action?.default_icon || {})) check(p, `action.default_icon[${size}]`);
  for (const [size, p] of Object.entries(manifest.icons || {})) check(p, `icons[${size}]`);

  manifest.content_scripts?.forEach((cs, i) => {
    (cs.js || []).forEach((p) => check(p, `content_scripts[${i}].js`));
    (cs.css || []).forEach((p) => check(p, `content_scripts[${i}].css`));
    if (cs.world && !['ISOLATED', 'MAIN'].includes(cs.world)) err(`content_scripts[${i}].world 取值非法：${cs.world}`);
  });

  // 权限自检：这几个是功能必需
  const need = ['proxy', 'storage', 'tabs', 'scripting', 'alarms', 'webNavigation', 'debugger'];
  for (const p of need) {
    if (!manifest.permissions?.includes(p)) warn(`permissions 缺少 "${p}"，相关功能会不可用`);
  }
  if (!manifest.host_permissions?.length) warn('没有 host_permissions，地理接口和本机端口探测都发不出去');

  const hasMainWorld = (manifest.content_scripts || []).some((cs) => cs.world === 'MAIN');
  if (hasMainWorld) {
    const mv = Number(manifest.minimum_chrome_version || '0');
    if (mv && mv < 111) err(`content_scripts world:"MAIN" 需要 Chrome 111+，现在是 ${mv}`);
  }
}

/* ---------------------------------------------------------------- */
/* 2. 模块依赖                                                        */
/* ---------------------------------------------------------------- */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));

/** 粗略抓 export 出来的名字 */
function exportedNames(code) {
  const names = new Set();
  const push = (s) => String(s).split(',').forEach((x) => names.add(x.trim()));
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  void push;
  return names;
}

const fileExports = new Map();
for (const f of srcFiles) fileExports.set(f, exportedNames(fs.readFileSync(f, 'utf8')));

let importCount = 0;
for (const f of srcFiles) {
  const code = fs.readFileSync(f, 'utf8');
  for (const m of code.matchAll(/import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    importCount++;
    const target = path.resolve(path.dirname(f), spec);
    if (!exists(target)) {
      err(`${rel(f)} 导入的模块不存在：${spec}`);
      continue;
    }
    const targetExports = fileExports.get(target);
    if (!targetExports) continue;
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const piece of named[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!targetExports.has(name)) {
          err(`${rel(f)} 导入了 ${spec} 里没有的导出名：${name}`);
        }
      }
    }
  }
}
notes.push(`模块依赖：检查了 ${srcFiles.length} 个 JS 文件、${importCount} 条相对导入`);

/* ---------------------------------------------------------------- */
/* 3. HTML 引用                                                       */
/* ---------------------------------------------------------------- */
const htmlFiles = walk(ROOT).filter((f) => f.endsWith('.html') && !rel(f).startsWith('node_modules'));
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<(?:script|link)[^>]*?(?:src|href)=["']([^"']+)["']/g)) {
    const href = m[1];
    if (/^(https?:)?\/\//.test(href) || href.startsWith('data:')) continue;
    const target = path.resolve(path.dirname(f), href);
    if (!exists(target)) err(`${rel(f)} 引用的资源不存在：${href}`);
  }
  // 扩展页面禁止内联脚本
  const isExtensionPage = rel(f).startsWith('src/');
  if (isExtensionPage && /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html)) {
    err(`${rel(f)} 含有内联 <script>，MV3 的 CSP 会直接拦掉`);
  }
  if (isExtensionPage && /\son[a-z]+\s*=\s*["']/i.test(html)) {
    err(`${rel(f)} 含有内联事件属性（onclick 等），MV3 不允许`);
  }
}

/* ---------------------------------------------------------------- */
/* 4. HTML 里的 id 与同目录 JS 的取元素调用是否对得上                     */
/* ---------------------------------------------------------------- */
for (const htmlFile of htmlFiles) {
  const dir = path.dirname(htmlFile);
  const jsFile = path.join(dir, path.basename(htmlFile).replace(/\.html$/, '.js'));
  if (!exists(jsFile)) continue;

  const html = fs.readFileSync(htmlFile, 'utf8');
  const ids = new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]));
  const js = fs.readFileSync(jsFile, 'utf8');
  const used = new Set([
    ...[...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...js.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  ]);
  for (const id of used) {
    if (!ids.has(id)) err(`${rel(jsFile)} 里取的 #${id} 在 ${rel(htmlFile)} 里不存在`);
  }
  if (used.size) notes.push(`${rel(htmlFile)} ↔ ${rel(jsFile)}：核对 ${used.size} 个元素 id`);
}

/* ---------------------------------------------------------------- */
/* 5. 其它小检查                                                      */
/* ---------------------------------------------------------------- */
for (const f of srcFiles) {
  const code = fs.readFileSync(f, 'utf8');
  if (/\bchrome\.runtime\.onMessage\.addListener/.test(code) && !/return true/.test(code)) {
    warn(`${rel(f)} 的 onMessage 监听里没有 return true，异步 sendResponse 会失效`);
  }
  const isContentScript = /[\\/]content[\\/]/.test(f);
  if (isContentScript && /^\s*import\s/m.test(code)) {
    err(`${rel(f)} 是内容脚本，不能用 ESM import`);
  }
}

/* ---------------------------------------------------------------- */
const line = '─'.repeat(60);
console.log(line);
for (const n of notes) console.log('  · ' + n);
console.log(line);
if (warnings.length) {
  console.log(`警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log('  ! ' + w);
} else {
  console.log('警告 0 条');
}
if (errors.length) {
  console.log('');
  console.log(`错误 ${errors.length} 条：`);
  for (const e of errors) console.log('  ✗ ' + e);
  console.log(line);
  process.exit(1);
}
console.log('错误 0 条 —— 静态校验通过');
console.log(line);
