import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateManifest } from '../src/manifest.js';
import type { Diagnostic } from '../src/types.js';

const codes = (diagnostics: Diagnostic[], severity?: Diagnostic['severity']) =>
  diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

const dataMod = { uuid: 'yourname.balance', name: 'Balance', version: '1.0.0', packFormatVersion: 1, gpNextVersion: '^1.5.0' };
const jsMod = {
  ...dataMod,
  uuid: 'yourname.hello-js',
  apiVersion: 2,
  js: { entry: 'scripts/main.js' },
  requiredGpNextFeatures: ['experimental.jsModding'],
};

describe('validateManifest: 合法清单', () => {
  it('官方文档中的最小数据 mod 没有错误和警告', () => {
    const result = validateManifest({ uuid: 'yourname.balance', name: 'Balance changes', version: '1.0.0', packFormatVersion: 1 });
    assert.deepEqual(codes(result, 'error'), []);
    assert.deepEqual(codes(result, 'warning'), []);
  });

  it('完整的 JS mod 没有错误和警告', () => {
    const result = validateManifest(jsMod, { hasScriptEntry: true });
    assert.deepEqual(codes(result, 'error'), []);
    assert.deepEqual(codes(result, 'warning'), []);
  });
});

describe('validateManifest: uuid', () => {
  it('缺少 uuid 是错误', () => {
    assert.ok(codes(validateManifest({ name: 'x' }), 'error').includes('UUID_MISSING'));
  });

  it('uuid 不是字符串或为空是错误', () => {
    assert.ok(codes(validateManifest({ uuid: 123 }), 'error').includes('UUID_INVALID'));
    assert.ok(codes(validateManifest({ uuid: '' }), 'error').includes('UUID_INVALID'));
  });

  it('uuid 首尾有空格是错误', () => {
    assert.ok(codes(validateManifest({ ...dataMod, uuid: ' a.b ' }), 'error').includes('UUID_WHITESPACE'));
  });

  it('uuid 使用保留前缀 legacy: 是错误', () => {
    assert.ok(codes(validateManifest({ ...dataMod, uuid: 'legacy:old' }), 'error').includes('UUID_RESERVED_PREFIX'));
  });

  it('JS mod 的 uuid 必须符合 3-128 位字符集规则', () => {
    for (const bad of ['ab', '.abc', '-abc', 'has space', 'x'.repeat(129), '中文名']) {
      const result = validateManifest({ ...jsMod, uuid: bad }, { hasScriptEntry: true });
      assert.ok(codes(result, 'error').includes('UUID_JS_FORMAT'), `应拒绝 ${JSON.stringify(bad)}`);
    }
    for (const good of ['abc', '1abc', 'a.b_c-d', 'x'.repeat(128)]) {
      const result = validateManifest({ ...jsMod, uuid: good }, { hasScriptEntry: true });
      assert.ok(!codes(result, 'error').includes('UUID_JS_FORMAT'), `应接受 ${JSON.stringify(good)}`);
    }
  });

  it('非 JS mod 不检查 JS uuid 字符集', () => {
    const result = validateManifest({ ...dataMod, uuid: 'ab' });
    assert.ok(!codes(result).includes('UUID_JS_FORMAT'));
  });
});

describe('validateManifest: 格式与 JS 配置', () => {
  it('顶层不是对象是错误', () => {
    for (const bad of [null, [], 'text', 42]) {
      assert.deepEqual(codes(validateManifest(bad)), ['MANIFEST_NOT_OBJECT']);
    }
  });

  it('packFormatVersion 只支持 1', () => {
    assert.ok(codes(validateManifest({ ...dataMod, packFormatVersion: 2 }), 'error').includes('PACK_FORMAT_UNSUPPORTED'));
  });

  it('JS mod 缺少 apiVersion: 2 是错误', () => {
    const { apiVersion: _omit, ...withoutApi } = jsMod;
    assert.ok(codes(validateManifest(withoutApi, { hasScriptEntry: true }), 'error').includes('API_VERSION_REQUIRED'));
    assert.ok(codes(validateManifest({ ...jsMod, apiVersion: 1 }, { hasScriptEntry: true }), 'error').includes('API_VERSION_REQUIRED'));
  });

  it('自动检测到 scripts/main.js 时同样要求 apiVersion', () => {
    assert.ok(codes(validateManifest(dataMod, { hasScriptEntry: true }), 'error').includes('API_VERSION_REQUIRED'));
  });

  it('js.entry 必须是 .js 或 .mjs', () => {
    const result = validateManifest({ ...jsMod, js: { entry: 'scripts/main.ts' } }, { hasScriptEntry: true });
    assert.ok(codes(result, 'error').includes('JS_ENTRY_INVALID'));
    const mjs = validateManifest({ ...jsMod, js: { entry: 'main.mjs' } }, { hasScriptEntry: true });
    assert.ok(!codes(mjs).includes('JS_ENTRY_INVALID'));
  });

  it('js 不是对象是错误', () => {
    assert.ok(codes(validateManifest({ ...jsMod, js: 'scripts/main.js' }, { hasScriptEntry: true }), 'error').includes('JS_NOT_OBJECT'));
  });

  it('js.reloadable: false 必须搭配 js.startup: true', () => {
    const bad = validateManifest({ ...jsMod, js: { entry: 'a.js', reloadable: false } }, { hasScriptEntry: true });
    assert.ok(codes(bad, 'error').includes('JS_RELOADABLE_NEEDS_STARTUP'));
    const good = validateManifest({ ...jsMod, js: { entry: 'a.js', reloadable: false, startup: true } }, { hasScriptEntry: true });
    assert.ok(!codes(good).includes('JS_RELOADABLE_NEEDS_STARTUP'));
  });

  it('js.startup / js.reloadable 必须是布尔值', () => {
    const result = validateManifest({ ...jsMod, js: { entry: 'a.js', startup: 'yes', reloadable: 1 } }, { hasScriptEntry: true });
    assert.ok(codes(result, 'error').includes('JS_STARTUP_TYPE'));
    assert.ok(codes(result, 'error').includes('JS_RELOADABLE_TYPE'));
  });
});

describe('validateManifest: 依赖', () => {
  it('depends 必须是字符串数组', () => {
    assert.ok(codes(validateManifest({ ...dataMod, depends: 'a.b' }), 'error').includes('DEPS_NOT_ARRAY'));
    assert.ok(codes(validateManifest({ ...dataMod, depends: [1] }), 'error').includes('DEPS_ITEM_INVALID'));
  });

  it('不能依赖自己', () => {
    assert.ok(codes(validateManifest({ ...dataMod, depends: [dataMod.uuid] }), 'error').includes('DEPS_SELF'));
  });

  it('重复依赖给出警告', () => {
    assert.ok(codes(validateManifest({ ...dataMod, depends: ['a.b', 'a.b'] }), 'warning').includes('DEPS_DUPLICATE'));
  });

  it('把 npm 包名或版本范围写进 depends 给出警告', () => {
    for (const bad of ['pkg@^1.0.0', '^1.0.0', '@scope/pkg', 'a b']) {
      assert.ok(codes(validateManifest({ ...dataMod, depends: [bad] }), 'warning').includes('DEPS_LOOKS_LIKE_VERSION'), bad);
    }
  });

  it('depends 与 optionalDepends 重叠给出警告', () => {
    const result = validateManifest({ ...dataMod, depends: ['a.b'], optionalDepends: ['a.b'] });
    assert.ok(codes(result, 'warning').includes('DEPS_OVERLAP'));
  });
});

describe('validateManifest: 平台版本与功能', () => {
  it('非法的 gpNextVersion 给出警告(游戏本身不会拦截)', () => {
    const result = validateManifest({ ...dataMod, gpNextVersion: '===1.5.0' });
    assert.ok(codes(result, 'warning').includes('GPNEXT_VERSION_INVALID'));
    assert.deepEqual(codes(result, 'error'), []);
  });

  it('gpNextVersion 类型错误给出警告', () => {
    assert.ok(codes(validateManifest({ ...dataMod, gpNextVersion: 1.5 }), 'warning').includes('GPNEXT_VERSION_TYPE'));
  });

  it('gpNextVersion 与旧字段同时存在时提示旧字段被忽略', () => {
    const result = validateManifest({ ...dataMod, minGpNextVersion: '1.0.0' });
    assert.ok(codes(result, 'info').includes('OLD_BOUNDS_IGNORED'));
  });

  it('只有旧字段时提示迁移,且旧字段带运算符给出警告', () => {
    const { gpNextVersion: _omit, ...rest } = dataMod;
    const result = validateManifest({ ...rest, minGpNextVersion: '>=1.5.0' });
    assert.ok(codes(result, 'info').includes('OLD_BOUNDS_DEPRECATED'));
    assert.ok(codes(result, 'warning').includes('OLD_BOUND_INVALID'));
  });

  it('未知的功能 ID 给出警告并列出已知 ID', () => {
    const result = validateManifest({ ...dataMod, requiredGpNextFeatures: ['experimental.teleport'] });
    const unknown = result.find((d) => d.code === 'FEATURE_UNKNOWN');
    assert.ok(unknown);
    assert.match(unknown.message, /experimental\.jsModding/);
  });

  it('文档列出的功能 ID 全部被接受', () => {
    const result = validateManifest({
      ...dataMod,
      requiredGpNextFeatures: [
        'experimental.jsModding',
        'experimental.worldMapJson',
        'experimental.plantLevelSystem',
        'runtime.dynamicPlantRegistry',
        'runtime.shopExtensions',
        'runtime.scrollSensitivity',
      ],
    });
    assert.ok(!codes(result).includes('FEATURE_UNKNOWN'));
  });

  it('requiredGpNextFeatures 必须是字符串数组', () => {
    assert.ok(codes(validateManifest({ ...dataMod, requiredGpNextFeatures: 'experimental.jsModding' }), 'error').includes('FEATURES_TYPE'));
  });

  it('JS mod 没有声明 experimental.jsModding 只给提示(官方示例 mod 自己也不声明)', () => {
    const { requiredGpNextFeatures: _omit, ...rest } = jsMod;
    const result = validateManifest(rest, { hasScriptEntry: true });
    assert.ok(codes(result, 'info').includes('JS_FEATURE_NOT_DECLARED'));
    assert.ok(!codes(result, 'warning').includes('JS_FEATURE_NOT_DECLARED'));
  });

  it('官方示例 mod 的 pack.json(来自 pvzge.com/downloads/mods)没有错误和警告', () => {
    // 逐字取自官方发布的 pvzge.entities / example.entity-framework / example.entity-content
    const official = [
      { uuid: 'pvzge.entities', name: 'Official Entity Framework', version: '0.1.0', packFormatVersion: 1, apiVersion: 2, js: { entry: 'scripts/main.js', startup: true, reloadable: false } },
      {
        uuid: 'example.entity-framework', name: 'Entity behavior framework', version: '1.0.1', packFormatVersion: 1, apiVersion: 2,
        js: { entry: 'scripts/main.js', startup: true, reloadable: false }, depends: ['pvzge.entities'],
      },
    ];
    for (const manifest of official) {
      const result = validateManifest(manifest, { hasScriptEntry: true });
      assert.deepEqual(codes(result, 'error'), [], manifest.uuid);
      assert.deepEqual(codes(result, 'warning'), [], manifest.uuid);
    }
    // 内容 mod 没有 JS、没有 apiVersion,只依赖 JS mod
    const content = { uuid: 'example.entity-content', name: 'Triangle and diamond', version: '1.0.0', packFormatVersion: 1, depends: ['example.entity-framework', 'pvzge.entities'] };
    const result = validateManifest(content, { hasScriptEntry: false });
    assert.deepEqual(codes(result, 'error'), []);
    assert.deepEqual(codes(result, 'warning'), []);
  });
});

describe('validateManifest: 拼写检查', () => {
  it('疑似拼错的字段名给出警告并附带建议', () => {
    const result = validateManifest({ ...dataMod, gpNextVersoin: '^1.5.0', requiredGpNextFeature: [] });
    const typos = result.filter((d) => d.code === 'UNKNOWN_FIELD_TYPO');
    assert.equal(typos.length, 2);
    assert.match(typos[0]!.message, /gpNextVersion/);
  });

  it('与已知字段差别很大的未知字段只给提示', () => {
    const result = validateManifest({ ...dataMod, homepage: 'https://example.com' });
    assert.ok(codes(result, 'info').includes('UNKNOWN_FIELD'));
    assert.ok(!codes(result, 'warning').includes('UNKNOWN_FIELD_TYPO'));
  });
});
