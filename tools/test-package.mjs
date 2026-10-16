/** 发布边界回归：测试清单选择与拒绝规则，不执行打包。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackagePlan } from './package-plan.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timezone-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content = '') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('manifest.json', JSON.stringify({ manifest_version: 3, version: '1.1.3', background: { service_worker: 'src/background.js' } }));
  write('package.json', JSON.stringify({ version: '1.1.3' }));
  for (const name of ['LICENSE', 'PRIVACY.md', 'INSTALL.md', 'icons/icon128.png', 'src/background.js',
    'src/content/zone-seeds/Asia_Singapore.js', '.git/config', 'output/live-ip.log', 'native-host/run_host.bat',
    'test/private-fixture.json', 'local-notes/key.pem']) write(name);
  return { root, write };
}

test('发布清单包含动态时区种子，排除日志、原生宿主机和本地记录', t => {
  const { root } = fixture(t);
  const plan = createPackagePlan(root, 'refs/tags/v1.1.3');
  assert.ok(plan.files.includes('manifest.json'));
  assert.ok(plan.files.includes('src/content/zone-seeds/Asia_Singapore.js'));
  assert.ok(plan.files.includes('LICENSE'));
  assert.ok(plan.files.includes('PRIVACY.md'));
  assert.equal(plan.files.some(name => /^(?:output|native-host|test|local-notes|\.git)\//.test(name)), false);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});

test('发布标签和 manifest 版本不一致时拒绝打包', t => {
  const { root } = fixture(t);
  assert.throws(() => createPackagePlan(root, 'refs/tags/v9.9.9'), /标签.*版本/);
});

test('package 与 manifest 版本不一致时拒绝打包', t => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ version: '2.0.0' }));
  assert.throws(() => createPackagePlan(root), /package.*manifest/);
});

test('运行目录中的私钥文件或伪装成 JS 的私钥都不能进入发布包', t => {
  const { root, write } = fixture(t);
  write('src/signing.pem', '测试文件');
  assert.throws(() => createPackagePlan(root), /不允许/);
  fs.unlinkSync(path.join(root, 'src/signing.pem'));
  write('src/leak.js', '-----BEGIN PRIVATE KEY-----');
  assert.throws(() => createPackagePlan(root), /私钥/);
});

test('manifest 引用包外文件时拒绝打包', t => {
  const { root, write } = fixture(t);
  write('manifest.json', JSON.stringify({ manifest_version: 3, version: '1.1.3', background: { service_worker: '../secret.js' } }));
  assert.throws(() => createPackagePlan(root), /引用.*发布清单/);
});
