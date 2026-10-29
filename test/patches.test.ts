import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateLangPatch, validatePatchingConfig } from '../src/patches.js';
import type { Diagnostic } from '../src/types.js';

const codes = (diagnostics: Diagnostic[], severity?: Diagnostic['severity']) =>
  diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

describe('validatePatchingConfig', () => {
  it('接受官方文档中的示例', () => {
    const example = { defaultMode: 'merge', features: { StoreCommodityFeatures: { mode: 'replace' } } };
    assert.deepEqual(validatePatchingConfig(example, 'jsons/config/patching.json'), []);
  });

  it('空对象合法', () => {
    assert.deepEqual(validatePatchingConfig({}, 'f'), []);
  });

  it('顶层不是对象是错误', () => {
    for (const bad of [null, [], 'merge', 1]) {
      assert.deepEqual(codes(validatePatchingConfig(bad, 'f')), ['PATCHING_NOT_OBJECT']);
    }
  });

  it('defaultMode 只能是 merge 或 replace', () => {
    assert.deepEqual(codes(validatePatchingConfig({ defaultMode: 'overwrite' }, 'f'), 'warning'), ['PATCHING_MODE_INVALID']);
    assert.deepEqual(validatePatchingConfig({ defaultMode: 'replace' }, 'f'), []);
  });

  it('类型条目的 mode 只能是 merge 或 replace', () => {
    const result = validatePatchingConfig({ objects: { PlantTypes: { mode: 'append' } } }, 'f');
    assert.deepEqual(codes(result, 'warning'), ['PATCHING_MODE_INVALID']);
    assert.equal(result[0]!.field, 'objects.PlantTypes.mode');
  });

  it('条目缺少 mode 只给提示', () => {
    const result = validatePatchingConfig({ features: { PlantFeatures: {} } }, 'f');
    assert.deepEqual(codes(result), ['PATCHING_ENTRY_NO_MODE']);
    assert.equal(result[0]!.severity, 'info');
  });

  it('features / objects 的结构错误给出警告', () => {
    assert.ok(codes(validatePatchingConfig({ features: ['PlantFeatures'] }, 'f'), 'warning').includes('PATCHING_SECTION_TYPE'));
    assert.ok(codes(validatePatchingConfig({ features: { PlantFeatures: 'replace' } }, 'f'), 'warning').includes('PATCHING_ENTRY_TYPE'));
  });

  it('关卡、语言、地图不受该配置控制', () => {
    for (const key of ['levels', 'language', 'maps']) {
      assert.ok(codes(validatePatchingConfig({ [key]: {} }, 'f'), 'warning').includes('PATCHING_UNSUPPORTED_SECTION'), key);
    }
  });

  it('键的大小写错误给出针对性提示,其他未知键给出通用警告', () => {
    assert.deepEqual(codes(validatePatchingConfig({ defaultmode: 'merge' }, 'f')), ['PATCHING_KEY_CASE']);
    assert.deepEqual(codes(validatePatchingConfig({ whatever: 1 }, 'f')), ['PATCHING_UNKNOWN_KEY']);
  });
});

describe('validateLangPatch', () => {
  it('接受官方文档中的示例', () => {
    const example = {
      _languages: [{ code: 'es', name: 'Español', isCJK: false }],
      LoadingTips: [{ en: 'Sun is your core resource.', zh: '阳光是你的核心资源。', es: 'El sol es tu recurso principal.' }],
    };
    assert.deepEqual(validateLangPatch(example, 'jsons/lang/lang.json'), []);
  });

  it('只编辑已有语言时可以省略 _languages', () => {
    assert.deepEqual(validateLangPatch({ LoadingTips: [] }, 'f'), []);
  });

  it('顶层不是对象是错误', () => {
    assert.deepEqual(codes(validateLangPatch([], 'f')), ['LANG_NOT_OBJECT']);
  });

  it('_languages 不是数组是错误', () => {
    assert.deepEqual(codes(validateLangPatch({ _languages: { code: 'es' } }, 'f')), ['LANG_LANGUAGES_TYPE']);
  });

  it('语言条目缺少 code 是错误,name / isCJK 问题是警告', () => {
    const result = validateLangPatch({ _languages: [{ name: 'Español', isCJK: 'no' }, { code: 'fr' }, 'de'] }, 'f');
    const errors = codes(result, 'error');
    assert.ok(errors.includes('LANG_CODE_INVALID'));
    assert.ok(errors.includes('LANG_ENTRY_TYPE'));
    const warnings = codes(result, 'warning');
    assert.ok(warnings.includes('LANG_ISCJK_TYPE'));
    assert.ok(warnings.includes('LANG_NAME_INVALID'));
  });

  it('重复注册同一个语言代码给出警告', () => {
    const result = validateLangPatch({ _languages: [{ code: 'es', name: 'A' }, { code: 'es', name: 'B' }] }, 'f');
    assert.deepEqual(codes(result), ['LANG_CODE_DUPLICATE']);
  });
});
