import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { packProject } from '../src/pack.js';
import { validateTarget } from '../src/project.js';
import { extractZip, listZipEntries } from '../src/zip.js';
import type { Diagnostic } from '../src/types.js';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-pack-'));
  temps.push(dir);
  return dir;
}
function makeMod(files: Record<string, string | Uint8Array>): string {
  const dir = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const codes = (diagnostics: Diagnostic[], severity?: Diagnostic['severity']) =>
  diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

const pack = JSON.stringify({ uuid: 'tester.pack', name: 'P', version: '2.1.0', packFormatVersion: 1, gpNextVersion: '^1.5.0' });
const patch = JSON.stringify({ PLANTS: [{ CODENAME: 'peashooter', BOOST: 3 }] });
const goodFiles = { 'pack.json': pack, 'jsons/features/PlantFeatures.json': patch };

describe('packProject', () => {
  it('生成 ZIP:pack.json 在根部,路径用 /,保留目录结构', () => {
    const dir = makeMod(goodFiles);
    const out = path.join(tempDir(), 'out.zip');
    const result = packProject(dir, { out });
    assert.equal(result.packed, true);
    assert.equal(result.outFile, out);
    const entries = listZipEntries(new Uint8Array(fs.readFileSync(out)));
    assert.ok(entries.includes('pack.json'));
    assert.ok(entries.includes('jsons/features/PlantFeatures.json'));
    assert.ok(entries.includes('jsons/') && entries.includes('jsons/features/'));
    assert.ok(entries.every((name) => !name.includes('\\')));
  });

  it('ZIP 内容与源文件逐字节一致', () => {
    const dir = makeMod({ ...goodFiles, 'data/blob.bin': new Uint8Array([0, 1, 2, 250, 255]) });
    const out = path.join(tempDir(), 'out.zip');
    packProject(dir, { out });
    const files = unzipSync(new Uint8Array(fs.readFileSync(out)));
    assert.deepEqual([...files['data/blob.bin']!], [0, 1, 2, 250, 255]);
    assert.equal(Buffer.from(files['pack.json']!).toString('utf8'), pack);
  });

  it('相同内容打出字节完全一致的 ZIP(可复现)', () => {
    const dir = makeMod(goodFiles);
    const a = path.join(tempDir(), 'a.zip');
    const b = path.join(tempDir(), 'b.zip');
    packProject(dir, { out: a });
    packProject(dir, { out: b });
    assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
  });

  it('排除版本控制目录、依赖目录、系统垃圾文件和已有的 zip', () => {
    const dir = makeMod({
      ...goodFiles,
      '.git/config': 'x',
      'node_modules/pkg/index.js': 'x',
      '.vscode/settings.json': '{}',
      'Thumbs.db': 'x',
      '.DS_Store': 'x',
      'old-release.zip': 'x',
    });
    const out = path.join(tempDir(), 'out.zip');
    const result = packProject(dir, { out });
    const entries = listZipEntries(new Uint8Array(fs.readFileSync(out)));
    for (const name of entries) {
      assert.ok(!/^(\.git|node_modules|\.vscode)\//.test(name) && !/Thumbs\.db|\.DS_Store|\.zip$/.test(name), name);
    }
    assert.ok(result.skipped!.length >= 6);
  });

  it('输出文件放在 mod 目录内时不会把自己打进去', () => {
    const dir = makeMod(goodFiles);
    const out = path.join(dir, 'release', 'self.zip');
    packProject(dir, { out });
    packProject(dir, { out });
    const entries = listZipEntries(new Uint8Array(fs.readFileSync(out)));
    assert.ok(!entries.some((name) => name.includes('self.zip')));
  });

  it('默认文件名为 <uuid>-<version>.zip 并放在当前目录', () => {
    const dir = makeMod(goodFiles);
    const cwd = tempDir();
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const result = packProject(dir);
      assert.equal(path.basename(result.outFile!), 'tester.pack-2.1.0.zip');
      assert.equal(path.dirname(fs.realpathSync(result.outFile!)), fs.realpathSync(cwd));
    } finally {
      process.chdir(previous);
    }
  });

  it('校验有错误时拒绝打包,不生成文件', () => {
    const dir = makeMod({ 'pack.json': JSON.stringify({ name: 'no uuid' }), 'jsons/features/A.json': '{}' });
    const out = path.join(tempDir(), 'out.zip');
    const result = packProject(dir, { out });
    assert.equal(result.packed, false);
    assert.match(result.reason!, /校验未通过/);
    assert.equal(fs.existsSync(out), false);
  });

  it('--force 可以强制打包有错误的 mod', () => {
    const dir = makeMod({ 'pack.json': JSON.stringify({ uuid: ' bad ', name: 'x' }), 'jsons/features/A.json': '{}' });
    const out = path.join(tempDir(), 'out.zip');
    const result = packProject(dir, { out, force: true });
    assert.equal(result.packed, true);
    assert.ok(fs.existsSync(out));
  });

  it('--strict:仅有警告也拒绝打包', () => {
    const dir = makeMod({ 'pack.json': pack });
    const out = path.join(tempDir(), 'out.zip');
    assert.equal(packProject(dir, { out }).packed, true);
    assert.equal(packProject(dir, { out: path.join(tempDir(), 'strict.zip'), strict: true }).packed, false);
  });

  it('pack.json 不在根部时拒绝', () => {
    const dir = makeMod({ 'inner/pack.json': pack });
    assert.equal(packProject(dir, { out: path.join(tempDir(), 'o.zip') }).packed, false);
  });

  it('强制打包且无法确定文件名时要求使用 -o', () => {
    const dir = makeMod({ 'pack.json': '{ not json' });
    const result = packProject(dir, { force: true });
    assert.equal(result.packed, false);
  });
});

describe('validateTarget:校验 ZIP', () => {
  it('pack 生成的 ZIP 可以直接校验通过', () => {
    const dir = makeMod(goodFiles);
    const out = path.join(tempDir(), 'ok.zip');
    packProject(dir, { out });
    const result = validateTarget(out);
    assert.equal(result.dir, out);
    assert.deepEqual(codes(result.diagnostics, 'error'), []);
    assert.equal(result.schemaVersion, '0.15.0');
  });

  it('多套了一层目录的 ZIP 会被指出', () => {
    const out = path.join(tempDir(), 'nested.zip');
    fs.writeFileSync(out, zipSync({ 'my-mod/pack.json': new TextEncoder().encode(pack) }));
    const result = validateTarget(out);
    assert.deepEqual(codes(result.diagnostics), ['PACK_MISSING']);
    assert.match(result.diagnostics[0]!.message, /my-mod/);
  });

  it('反斜杠路径的 ZIP:能识别内容,并给出警告', () => {
    const out = path.join(tempDir(), 'backslash.zip');
    fs.writeFileSync(out, zipSync({ 'pack.json': new TextEncoder().encode(pack), 'jsons\\features\\PlantFeatures.json': new TextEncoder().encode(patch) }));
    const result = validateTarget(out);
    assert.ok(codes(result.diagnostics, 'warning').includes('ZIP_BACKSLASH_PATHS'));
    assert.deepEqual(codes(result.diagnostics, 'error'), []);
    assert.ok(!codes(result.diagnostics).includes('EMPTY_MOD'));
  });

  it('不是 ZIP 的文件报错', () => {
    const out = path.join(tempDir(), 'fake.zip');
    fs.writeFileSync(out, 'this is not a zip');
    assert.deepEqual(codes(validateTarget(out).diagnostics), ['ZIP_INVALID']);
  });

  it('校验结束后清理临时目录', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gpn-zip-')).length;
    const dir = makeMod(goodFiles);
    const out = path.join(tempDir(), 'ok.zip');
    packProject(dir, { out });
    validateTarget(out);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gpn-zip-')).length;
    assert.equal(after, before);
  });
});

describe('extractZip:安全', () => {
  const evil = (name: string) => {
    const zip = path.join(tempDir(), 'evil.zip');
    fs.writeFileSync(zip, zipSync({ [name]: new TextEncoder().encode('pwned'), 'pack.json': new TextEncoder().encode(pack) }));
    return zip;
  };

  it('拒绝 zip-slip:含 .. 的条目不会写到目标目录之外', () => {
    const parent = tempDir();
    const dest = path.join(parent, 'dest');
    fs.mkdirSync(dest);
    const result = extractZip(evil('../escaped.txt'), dest);
    assert.equal(result.ok, false);
    assert.ok(codes(result.diagnostics, 'error').includes('ZIP_UNSAFE_PATH'));
    assert.equal(fs.existsSync(path.join(parent, 'escaped.txt')), false);
  });

  it('拒绝反斜杠形式的路径穿越与绝对路径', () => {
    for (const name of ['..\\..\\escaped.txt', '/etc/escaped.txt', 'C:\\escaped.txt', 'a/../../escaped.txt']) {
      const parent = tempDir();
      const dest = path.join(parent, 'dest');
      fs.mkdirSync(dest);
      const result = extractZip(evil(name), dest);
      assert.equal(result.ok, false, name);
      assert.equal(fs.existsSync(path.join(parent, 'escaped.txt')), false, name);
    }
  });
});
