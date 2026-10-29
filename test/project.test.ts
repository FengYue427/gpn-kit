import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../src/project.js';
import type { Diagnostic } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '../../examples');

const tempRoots: string[] = [];
function makeMod(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-test-'));
  tempRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const codes = (diagnostics: Diagnostic[], severity?: Diagnostic['severity']) =>
  diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

const goodPack = JSON.stringify({ uuid: 'yourname.test', name: 'T', version: '1.0.0', packFormatVersion: 1, gpNextVersion: '^1.5.0' });
const goodJsPack = JSON.stringify({
  uuid: 'yourname.test-js',
  name: 'T',
  version: '1.0.0',
  packFormatVersion: 1,
  apiVersion: 2,
  gpNextVersion: '^1.5.0',
  requiredGpNextFeatures: ['experimental.jsModding'],
});

describe('validateProject: 示例 mod', () => {
  it('balance-mod 没有错误和警告', () => {
    const { diagnostics } = validateProject(path.join(examples, 'balance-mod'));
    assert.deepEqual(codes(diagnostics, 'error'), []);
    assert.deepEqual(codes(diagnostics, 'warning'), []);
  });

  it('js-mod 没有错误和警告', () => {
    const { diagnostics } = validateProject(path.join(examples, 'js-mod'));
    assert.deepEqual(codes(diagnostics, 'error'), []);
    assert.deepEqual(codes(diagnostics, 'warning'), []);
  });

  it('broken-mod 能抓出预期的问题', () => {
    const { diagnostics } = validateProject(path.join(examples, 'broken-mod'));
    const found = new Set(codes(diagnostics));
    for (const expected of [
      'UUID_WHITESPACE',
      'UUID_RESERVED_PREFIX',
      'PACK_FORMAT_UNSUPPORTED',
      'API_VERSION_REQUIRED',
      'JS_RELOADABLE_NEEDS_STARTUP',
      'JS_ENTRY_NOT_FOUND',
      'DEPS_DUPLICATE',
      'DEPS_LOOKS_LIKE_VERSION',
      'UNKNOWN_FIELD_TYPO',
      'FEATURE_UNKNOWN',
      'JSON_SYNTAX',
    ]) {
      assert.ok(found.has(expected), `缺少预期诊断 ${expected}`);
    }
  });
});

describe('validateProject: pack.json 定位与解析', () => {
  it('目录不存在', () => {
    const { diagnostics } = validateProject(path.join(os.tmpdir(), 'gpn-does-not-exist-xyz'));
    assert.deepEqual(codes(diagnostics), ['DIR_NOT_FOUND']);
  });

  it('根目录没有 pack.json', () => {
    const dir = makeMod({ 'readme.txt': 'hi' });
    assert.deepEqual(codes(validateProject(dir).diagnostics), ['PACK_MISSING']);
  });

  it('pack.json 在子目录时提示 ZIP 根部问题', () => {
    const dir = makeMod({ 'my-mod/pack.json': goodPack });
    const { diagnostics } = validateProject(dir);
    assert.deepEqual(codes(diagnostics), ['PACK_MISSING']);
    assert.match(diagnostics[0]!.message, /ZIP 根部/);
    assert.match(diagnostics[0]!.message, /my-mod/);
  });

  it('pack.json 不是合法 JSON', () => {
    const dir = makeMod({ 'pack.json': '{ "uuid": ' });
    assert.deepEqual(codes(validateProject(dir).diagnostics), ['PACK_INVALID_JSON']);
  });

  it('接受带 BOM 的 pack.json(Windows 记事本常见)', () => {
    const dir = makeMod({ 'pack.json': `\uFEFF${goodPack}`, 'jsons/features/A.json': '{}' });
    assert.deepEqual(codes(validateProject(dir).diagnostics, 'error'), []);
  });
});

describe('validateProject: JS 入口', () => {
  it('自动检测 scripts/main.js,且缺少 apiVersion 报错', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'scripts/main.js': 'export function setup(ctx) {}' });
    assert.ok(codes(validateProject(dir).diagnostics, 'error').includes('API_VERSION_REQUIRED'));
  });

  it('自动检测 scripts/main.js 且配置完整时通过', () => {
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': 'export function setup(ctx) {}' });
    const { diagnostics } = validateProject(dir);
    assert.deepEqual(codes(diagnostics, 'error'), []);
    assert.deepEqual(codes(diagnostics, 'warning'), []);
  });

  it('官方推荐的 export default 写法没有任何诊断', () => {
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': 'export default {\n  setup(ctx) {}\n}' });
    assert.deepEqual(validateProject(dir).diagnostics, []);
  });

  it('具名导出 setup 只给提示(文档未说明是否支持),不报错', () => {
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': 'export function setup(ctx) {}' });
    const { diagnostics } = validateProject(dir);
    assert.deepEqual(codes(diagnostics), ['JS_NO_DEFAULT_EXPORT']);
    assert.equal(diagnostics[0]!.severity, 'info');
  });

  it('入口含静态 import 时提醒需要先打包成单个模块', () => {
    for (const source of [
      "import { x } from './util.js'\nexport default { setup(ctx) {} }",
      "import lodash from 'lodash'\nexport default { setup(ctx) {} }",
      "import './side-effect.js'\nexport default { setup(ctx) {} }",
      "export * from './other.js'\nexport default { setup(ctx) {} }",
    ]) {
      const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': source });
      assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('JS_ENTRY_HAS_IMPORTS'), source);
    }
  });

  it('文本里提到 import 但并非语句时不误报', () => {
    const source = "// 用 import 引入会失败\nconst s = 'import x from y'\nexport default { setup(ctx) { ctx.log.info('important') } }";
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': source });
    assert.ok(!codes(validateProject(dir).diagnostics).includes('JS_ENTRY_HAS_IMPORTS'));
  });

  it('入口文件缺少 setup 给出警告', () => {
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': 'console.log(1)' });
    assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('JS_SETUP_NOT_FOUND'));
  });

  it('声明了 js 但没有入口文件', () => {
    const pack = JSON.stringify({ ...JSON.parse(goodJsPack), js: { startup: true } });
    const dir = makeMod({ 'pack.json': pack });
    assert.ok(codes(validateProject(dir).diagnostics, 'error').includes('JS_ENTRY_MISSING'));
  });

  it('js.entry 指向的文件不存在', () => {
    const pack = JSON.stringify({ ...JSON.parse(goodJsPack), js: { entry: 'src/index.js' } });
    const dir = makeMod({ 'pack.json': pack });
    assert.ok(codes(validateProject(dir).diagnostics, 'error').includes('JS_ENTRY_NOT_FOUND'));
  });

  it('js.entry 不能跳出 mod 目录', () => {
    const pack = JSON.stringify({ ...JSON.parse(goodJsPack), js: { entry: '../evil.js' } });
    const dir = makeMod({ 'pack.json': pack });
    assert.ok(codes(validateProject(dir).diagnostics, 'error').includes('JS_ENTRY_ESCAPES'));
  });
});

describe('validateProject: jsons/ 内容', () => {
  it('补丁文件允许 JSON5 语法(注释、尾逗号)', () => {
    const dir = makeMod({
      'pack.json': goodPack,
      'jsons/features/PlantFeatures.json': '{ // 注释\n  PLANTS: [{ CODENAME: "peashooter", BOOST: 3, }],\n}',
    });
    assert.deepEqual(codes(validateProject(dir).diagnostics, 'error'), []);
  });

  it('补丁文件语法错误会指出文件', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/objects/Bad.json': '{ "a": ' });
    const error = validateProject(dir).diagnostics.find((d) => d.code === 'JSON_SYNTAX');
    assert.ok(error);
    assert.equal(error.file, 'jsons/objects/Bad.json');
  });

  it('jsons/ 下的未知目录和根部散落文件给出警告', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/feature/A.json': '{}', 'jsons/B.json': '{}' });
    const found = codes(validateProject(dir).diagnostics, 'warning');
    assert.ok(found.includes('JSONS_UNKNOWN_DIR'));
    assert.ok(found.includes('JSONS_STRAY_FILE'));
  });

  it('非 JSON 文件给出警告', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/features/notes.txt': 'x' });
    assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('JSONS_NOT_JSON'));
  });

  it('lang 与 patching 允许 .json5 扩展名,不误报文件名', () => {
    const dir = makeMod({
      'pack.json': goodPack,
      'jsons/lang/lang.json5': '{ _languages: [{ code: "es", name: "Español", isCJK: false }], }',
      'jsons/config/patching.json5': '{ defaultMode: "merge", }',
    });
    const { diagnostics } = validateProject(dir);
    assert.deepEqual(codes(diagnostics, 'error'), []);
    assert.deepEqual(codes(diagnostics, 'warning'), []);
    assert.ok(!codes(diagnostics).includes('JSONS_UNEXPECTED_NAME'));
  });

  it('plant-levels.json5 同样触发功能声明检查', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/extensions/plant-levels.json5': '{}' });
    assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('FEATURE_PLANTLEVEL_NOT_DECLARED'));
  });

  it('文件名不符合文档时给出提示,且不对其内容做配置校验', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/config/other.json': '{ "defaultMode": "bogus" }' });
    const found = codes(validateProject(dir).diagnostics);
    assert.ok(found.includes('JSONS_UNEXPECTED_NAME'));
    assert.ok(!found.includes('PATCHING_MODE_INVALID'));
  });

  it('patching.json 与 lang.json 的内容错误会被项目级校验发现', () => {
    const dir = makeMod({
      'pack.json': goodPack,
      'jsons/config/patching.json': '{ "defaultMode": "overwrite" }',
      'jsons/lang/lang.json': '{ "_languages": [{ "name": "x" }] }',
    });
    const { diagnostics } = validateProject(dir);
    const patchingIssue = diagnostics.find((d) => d.code === 'PATCHING_MODE_INVALID');
    assert.equal(patchingIssue?.file, 'jsons/config/patching.json');
    assert.ok(codes(diagnostics, 'error').includes('LANG_CODE_INVALID'));
  });

  it('包含 worldmap / plant-levels 却没声明对应功能时给出警告', () => {
    const dir = makeMod({
      'pack.json': goodPack,
      'jsons/worldmap/gpn-worldmap.json': '{}',
      'jsons/extensions/plant-levels.json': '{}',
    });
    const found = codes(validateProject(dir).diagnostics, 'warning');
    assert.ok(found.includes('FEATURE_WORLDMAP_NOT_DECLARED'));
    assert.ok(found.includes('FEATURE_PLANTLEVEL_NOT_DECLARED'));
  });

  it('声明了对应功能后不再警告', () => {
    const pack = JSON.stringify({
      ...JSON.parse(goodPack),
      requiredGpNextFeatures: ['experimental.worldMapJson', 'experimental.plantLevelSystem'],
    });
    const dir = makeMod({
      'pack.json': pack,
      'jsons/worldmap/gpn-worldmap.json': '{}',
      'jsons/extensions/plant-levels.json': '{}',
    });
    assert.deepEqual(codes(validateProject(dir).diagnostics, 'warning'), []);
  });
});

describe('validateProject: 补丁字段校验', () => {
  const badObjects = JSON.stringify({ objects: [{ aliases: ['peashooter'], objclass: 'PlantProperties', objdata: { SunCost: '100', Cooldwn: 5 } }] });

  it('按文件名识别类型,并用原版数据校验字段', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/objects/PlantProps.json': badObjects });
    const result = validateProject(dir);
    assert.equal(result.schemaVersion, '0.15.0');
    const warnings = codes(result.diagnostics, 'warning');
    assert.ok(warnings.includes('PATCH_FIELD_TYPE'));
    assert.ok(warnings.includes('PATCH_FIELD_TYPO'));
    assert.equal(result.diagnostics.find((d) => d.code === 'PATCH_FIELD_TYPO')?.file, 'jsons/objects/PlantProps.json');
  });

  it('features 补丁同样校验,json5 写法也支持', () => {
    const dir = makeMod({
      'pack.json': goodPack,
      'jsons/features/PlantFeatures.json5': '{ PLANTS: [{ CODENAME: "peashooter", BOOT: 3, }], }',
    });
    assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('PATCH_FIELD_TYPO'));
  });

  it('自定义类型名(非原版文件)只给提示', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/features/MyFeatures.json': '{ "ANYTHING": [] }' });
    const { diagnostics } = validateProject(dir);
    assert.deepEqual(codes(diagnostics, 'warning'), []);
    assert.ok(codes(diagnostics, 'info').includes('PATCH_TYPE_UNKNOWN'));
  });

  it('语法错误的补丁不再做字段校验,只报语法错误', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/objects/PlantProps.json': '{ "objects": [' });
    const found = codes(validateProject(dir).diagnostics);
    assert.ok(found.includes('JSON_SYNTAX'));
    assert.ok(!found.some((c) => c.startsWith('PATCH_')));
  });

  it('schema: false 时跳过字段校验,且不带 schemaVersion', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'jsons/objects/PlantProps.json': badObjects });
    const result = validateProject(dir, { schema: false });
    assert.ok(!codes(result.diagnostics).some((c) => c.startsWith('PATCH_')));
    assert.equal(result.schemaVersion, undefined);
  });

  it('没有数据补丁的 mod 不带 schemaVersion', () => {
    const dir = makeMod({ 'pack.json': goodJsPack, 'scripts/main.js': 'export default { setup(ctx) {} }' });
    assert.equal(validateProject(dir).schemaVersion, undefined);
  });
});

describe('validateProject: 空 mod', () => {
  it('只有 pack.json 时给出警告', () => {
    const dir = makeMod({ 'pack.json': goodPack });
    assert.ok(codes(validateProject(dir).diagnostics, 'warning').includes('EMPTY_MOD'));
  });

  it('带有框架自定义的 content/ 目录时不误报', () => {
    const dir = makeMod({ 'pack.json': goodPack, 'content/entities.json': '{}' });
    assert.ok(!codes(validateProject(dir).diagnostics).includes('EMPTY_MOD'));
  });
});
