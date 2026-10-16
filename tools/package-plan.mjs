/** 只读计算发布文件清单；不会创建压缩包、签名文件或 dist 目录。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createPackagePlan(root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), ref = '') {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) throw new Error('manifest 版本格式不合法');
  if (pkg.version !== manifest.version) throw new Error('package 与 manifest 版本不一致');
  if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${manifest.version}`) throw new Error('发布标签与 manifest 版本不一致');

  const files = ['manifest.json', 'LICENSE', 'PRIVACY.md', 'INSTALL.md'];
  function collect(relative, allowed) {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`不允许发布符号链接：${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) collect(`${relative}/${name}`, allowed);
    } else if (stat.isFile() && allowed.has(path.extname(relative))) files.push(relative);
    else throw new Error(`运行目录中出现不允许发布的文件：${relative}`);
  }
  collect('src', new Set(['.js', '.css', '.html']));
  collect('icons', new Set(['.png']));
  for (const relative of files) {
    const full = path.join(root, relative);
    if (!fs.lstatSync(full).isFile() || fs.lstatSync(full).isSymbolicLink()) throw new Error(`不允许发布此文件：${relative}`);
    if (!relative.endsWith('.png') && /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(fs.readFileSync(full, 'utf8'))) {
      throw new Error(`发布文件疑似包含私钥：${relative}`);
    }
  }
  const refs = [manifest.background?.service_worker, manifest.options_page, manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])];
  for (const name of refs.filter(Boolean)) {
    if (!files.includes(name)) throw new Error(`manifest 引用不在发布清单中：${name}`);
  }
  return { version: manifest.version, name: `proxy-timezone-sync-${manifest.version}`, files: files.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(createPackagePlan(undefined, process.env.GITHUB_REF || ''), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
