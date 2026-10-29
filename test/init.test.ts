import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { initProject, InitError } from '../src/init.js';
import { packProject } from '../src/pack.js';
import { validateProject } from '../src/project.js';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-init-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('initProject', () => {
  for (const type of ['data', 'js'] as const) {
    it(`${type} 骨架没有任何错误或警告,并且可以直接打包`, () => {
      const dir = path.join(tempDir(), 'my-mod');
      initProject({ dir, uuid: 'tester.my-mod', type, author: 'tester' });
      const result = validateProject(dir);
      assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
      const packed = packProject(dir, { out: path.join(tempDir(), 'o.zip'), strict: true });
      assert.equal(packed.packed, true);
    });
  }

  it('名称缺省取目录名;提供作者时写入 pack.json', () => {
    const dir = path.join(tempDir(), 'cool-mod');
    initProject({ dir, uuid: 'tester.cool', type: 'data', author: ' me ' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(manifest.name, 'cool-mod');
    assert.equal(manifest.author, 'me');
  });

  it('js 骨架声明了 apiVersion、入口与 experimental.jsModding', () => {
    const dir = path.join(tempDir(), 'j');
    initProject({ dir, uuid: 'tester.js', type: 'js' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(manifest.apiVersion, 2);
    assert.equal(manifest.js.entry, 'scripts/main.js');
    assert.deepEqual(manifest.requiredGpNextFeatures, ['experimental.jsModding']);
    assert.match(fs.readFileSync(path.join(dir, 'scripts/main.js'), 'utf8'), /export default/);
  });

  it('拒绝不合法的 uuid,且不创建任何文件', () => {
    const base = tempDir();
    for (const uuid of ['', ' spaced ', 'legacy:old']) {
      assert.throws(() => initProject({ dir: path.join(base, 'x'), uuid, type: 'data' }), InitError, JSON.stringify(uuid));
    }
    assert.equal(fs.existsSync(path.join(base, 'x')), false);
  });

  it('js mod 的 uuid 必须符合 JS 规则', () => {
    assert.throws(() => initProject({ dir: path.join(tempDir(), 'x'), uuid: 'ab', type: 'js' }), InitError);
    assert.doesNotThrow(() => initProject({ dir: path.join(tempDir(), 'y'), uuid: 'abc', type: 'js' }));
  });

  it('拒绝写入非空目录,不覆盖已有文件', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'important');
    assert.throws(() => initProject({ dir, uuid: 'tester.x', type: 'data' }), /不是空的/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'important');
    assert.equal(fs.existsSync(path.join(dir, 'pack.json')), false);
  });

  it('允许写入已存在的空目录', () => {
    const dir = tempDir();
    assert.doesNotThrow(() => initProject({ dir, uuid: 'tester.empty', type: 'data' }));
    assert.ok(fs.existsSync(path.join(dir, 'pack.json')));
  });
});
