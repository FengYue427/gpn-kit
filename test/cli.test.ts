import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../src/cli.js');
const examples = path.resolve(here, '../../examples');

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-cli-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('命令行:退出码与输出', () => {
  it('--version 与 --help', () => {
    const version = run(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.out.trim(), /^\d+\.\d+\.\d+/);
    for (const args of [[], ['--help'], ['validate', '--help']]) {
      const help = run(args);
      assert.equal(help.code, 0);
      assert.match(help.out, /gpn init/);
      assert.match(help.out, /gpn pack/);
    }
  });

  it('未知命令和未知选项返回 2', () => {
    assert.equal(run(['bogus']).code, 2);
    assert.equal(run(['validate', '--nope']).code, 2);
    assert.equal(run(['validate', 'a', 'b']).code, 2);
    assert.equal(run(['pack', '--nope']).code, 2);
  });

  it('validate:合法 mod 返回 0,有错误返回 1', () => {
    assert.equal(run(['validate', path.join(examples, 'balance-mod')]).code, 0);
    assert.equal(run(['validate', path.join(examples, 'broken-mod')]).code, 1);
    assert.equal(run(['validate', path.join(os.tmpdir(), 'gpn-not-exist-xyz')]).code, 1);
  });

  it('validate --json 输出可解析的 JSON', () => {
    const { code, out } = run(['validate', path.join(examples, 'broken-mod'), '--json']);
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.ok(parsed.counts.error > 0);
    assert.equal(parsed.schemaVersion, '0.15.0');
  });

  it('validate --strict:只有警告时返回 1', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ uuid: 'a.b', name: 'x', version: '1.0.0', packFormatVersion: 1, gpNextVersion: '^1.5.0' }));
    assert.equal(run(['validate', dir]).code, 0);
    const strict = run(['validate', dir, '--strict']);
    assert.equal(strict.code, 1);
    assert.match(strict.out, /--strict/);
  });
});

describe('命令行:--schema 与 --no-schema', () => {
  const broken = path.join(examples, 'broken-mod');
  const fieldCodes = (out: string) => JSON.parse(out).diagnostics.map((d: { code: string }) => d.code).filter((c: string) => c.startsWith('PATCH_'));

  it('--no-schema 跳过补丁字段校验,且输出里没有 schemaVersion', () => {
    const { out } = run(['validate', broken, '--json', '--no-schema']);
    assert.deepEqual(fieldCodes(out), []);
    assert.equal(JSON.parse(out).schemaVersion, undefined);
  });

  it('--schema 使用指定文件:字段是否"已知"取决于它', () => {
    const dir = tempDir();
    // 一个只认识 Cooldwn 的假 schema:此时 Cooldwn 不再是拼写错误
    const schema = {
      gameVersion: 'custom-1.0',
      features: {},
      objects: {
        PlantProps: {
          classes: { PlantProperties: { aliases: ['peashoter'], fields: { SunCost: ['string'], Cooldwn: ['number'], Toughness: ['number'] } } },
        },
      },
    };
    const file = path.join(dir, 'custom-schema.json');
    fs.writeFileSync(file, JSON.stringify(schema));
    const { out } = run(['validate', broken, '--json', '--schema', file]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.schemaVersion, 'custom-1.0');
    assert.deepEqual(fieldCodes(out), [], '自定义 schema 下 SunCost(字符串)、Cooldwn、peashoter 都是已知的');
  });

  it('--schema 指向无效文件返回 2 并说明原因', () => {
    const dir = tempDir();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{"hello": 1}');
    const result = run(['validate', broken, '--schema', file]);
    assert.equal(result.code, 2);
    assert.match(result.err, /不是有效的 schema/);
    assert.equal(run(['validate', broken, '--schema', path.join(dir, 'missing.json')]).code, 2);
  });

  it('--schema 与 --no-schema 同时使用是用法错误', () => {
    assert.equal(run(['validate', broken, '--schema', 'x.json', '--no-schema']).code, 2);
  });

  it('pack 同样支持这两个选项', () => {
    const cwd = tempDir();
    const out = path.join(cwd, 'o.zip');
    // broken-mod 本身有非字段类的错误,所以仍然打包失败;这里只验证选项被接受而不是被当作未知选项
    assert.equal(run(['pack', broken, '-o', out, '--no-schema'], cwd).code, 1);
    assert.equal(run(['pack', broken, '-o', out, '--schema', 'x.json', '--no-schema'], cwd).code, 2);
  });
});

describe('命令行:init → validate → pack 完整流程', () => {
  it('从零创建、校验、打包,并校验生成的 ZIP', () => {
    const cwd = tempDir();
    const init = run(['init', 'my-mod', '--uuid', 'tester.flow'], cwd);
    assert.equal(init.code, 0, init.err);
    assert.ok(fs.existsSync(path.join(cwd, 'my-mod', 'pack.json')));

    assert.equal(run(['validate', 'my-mod'], cwd).code, 0);

    const pack = run(['pack', 'my-mod'], cwd);
    assert.equal(pack.code, 0, pack.err);
    const zip = path.join(cwd, 'tester.flow-1.0.0.zip');
    assert.ok(fs.existsSync(zip));

    assert.equal(run(['validate', zip], cwd).code, 0);
  });

  it('pack -o 指定输出路径', () => {
    const cwd = tempDir();
    run(['init', 'm', '--uuid', 'tester.out'], cwd);
    const out = path.join(cwd, 'build', 'custom.zip');
    assert.equal(run(['pack', 'm', '-o', out], cwd).code, 0);
    assert.ok(fs.existsSync(out));
  });

  it('pack 在校验失败时返回 1 且不生成文件', () => {
    const cwd = tempDir();
    const out = path.join(cwd, 'o.zip');
    const result = run(['pack', path.join(examples, 'broken-mod'), '-o', out], cwd);
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(out), false);
    assert.match(result.err, /未打包/);
  });

  it('init 非交互环境缺少 --uuid 时返回 2,而不是卡住等输入', () => {
    const cwd = tempDir();
    const result = run(['init', 'x'], cwd);
    assert.equal(result.code, 2);
    assert.match(result.err, /--uuid/);
    assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
  });

  it('init 的参数错误:非法 type、不合法 uuid、非空目录', () => {
    const cwd = tempDir();
    assert.equal(run(['init', 'a', '--uuid', 'tester.a', '--type', 'lua'], cwd).code, 2);
    assert.equal(run(['init', 'b', '--uuid', 'legacy:x'], cwd).code, 1);
    run(['init', 'c', '--uuid', 'tester.c'], cwd);
    assert.equal(run(['init', 'c', '--uuid', 'tester.c'], cwd).code, 1);
  });
});
