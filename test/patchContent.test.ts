import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateFeaturesPatch, validateObjectsPatch } from '../src/patchContent.js';
import type { Schema } from '../src/schema.js';
import type { Diagnostic } from '../src/types.js';

/** 手写的最小 schema,字段命名模仿真实数据,让测试不依赖大文件 */
const schema: Schema = {
  gameVersion: 'test',
  source: 'test',
  features: {
    PlantFeatures: {
      sections: {
        PLANTS: {
          kind: 'entries',
          keyField: 'CODENAME',
          keys: ['peashooter', 'sunflower', 'wallnut'],
          fields: { CODENAME: ['string'], BOOST: ['number'], NAME: ['object'], TAGS: ['array'], ID: ['number'] },
        },
        SEEDCHOOSERDEFAULTORDER: { kind: 'list' },
      },
    },
    StoreCommodityFeatures: {
      sections: {
        Plants: { kind: 'entries', keyField: 'CommodityName', keys: ['snowpea'], fields: { CommodityName: ['string'], CurrencyRequired: ['number'] } },
        Gem: { kind: 'entries', fields: { CommodityCount: ['number'] } },
      },
    },
  },
  objects: {
    PlantProps: {
      classes: {
        PlantProperties: {
          aliases: ['peashooter', 'sunflower'],
          fields: { SunCost: ['number'], Cooldown: ['number'], LifeSpan: ['number'], Lifespan: ['number'], MaybeNull: ['number', 'null'] },
        },
      },
    },
    ZombieProps: {
      classes: {
        ZombieProperties: { aliases: ['tutorial'], fields: { Speed: ['number'] } },
        ZombieOther: { aliases: ['other'], fields: { Weird: ['string'] } },
      },
    },
  },
};

const codes = (d: Diagnostic[], severity?: Diagnostic['severity']) =>
  d.filter((x) => !severity || x.severity === severity).map((x) => x.code);

describe('validateFeaturesPatch', () => {
  it('官方文档中的示例补丁没有任何诊断', () => {
    const patch = { PLANTS: [{ CODENAME: 'peashooter', BOOST: 3 }] };
    assert.deepEqual(validateFeaturesPatch('PlantFeatures', patch, 'f', schema), []);
  });

  it('不是原版类型时只给提示并跳过', () => {
    const result = validateFeaturesPatch('MyCustomFeatures', { X: [] }, 'f', schema);
    assert.deepEqual(codes(result), ['PATCH_TYPE_UNKNOWN']);
    assert.equal(result[0]!.severity, 'info');
  });

  it('区段名拼错给出建议', () => {
    const result = validateFeaturesPatch('PlantFeatures', { PLANT: [] }, 'f', schema);
    assert.deepEqual(codes(result, 'warning'), ['PATCH_SECTION_UNKNOWN']);
    assert.match(result[0]!.message, /PLANTS/);
  });

  it('字段名拼错给 warning 并附建议;完全陌生的字段只给 info', () => {
    const typo = validateFeaturesPatch('PlantFeatures', { PLANTS: [{ CODENAME: 'peashooter', BOOT: 3 }] }, 'f', schema);
    assert.deepEqual(codes(typo, 'warning'), ['PATCH_FIELD_TYPO']);
    assert.match(typo[0]!.message, /BOOST/);

    const fresh = validateFeaturesPatch('PlantFeatures', { PLANTS: [{ CODENAME: 'peashooter', MyCustomField: 1 }] }, 'f', schema);
    assert.deepEqual(codes(fresh), ['PATCH_FIELD_NEW']);
    assert.equal(fresh[0]!.severity, 'info');
  });

  it('字段值类型与原版不一致是 warning', () => {
    const result = validateFeaturesPatch('PlantFeatures', { PLANTS: [{ CODENAME: 'peashooter', BOOST: '3' }] }, 'f', schema);
    assert.deepEqual(codes(result, 'warning'), ['PATCH_FIELD_TYPE']);
    assert.match(result[0]!.message, /number.*string/);
  });

  it('原版中没有的 CODENAME 只给 info(可能是新增植物),并对近似名称给出建议', () => {
    const result = validateFeaturesPatch('PlantFeatures', { PLANTS: [{ CODENAME: 'peashoter' }] }, 'f', schema);
    assert.deepEqual(codes(result), ['PATCH_KEY_NOT_FOUND']);
    assert.equal(result[0]!.severity, 'info');
    assert.match(result[0]!.message, /peashooter/);
  });

  it('缺少匹配键的条目给出警告', () => {
    const result = validateFeaturesPatch('PlantFeatures', { PLANTS: [{ BOOST: 3 }] }, 'f', schema);
    assert.deepEqual(codes(result, 'warning'), ['PATCH_ENTRY_NO_KEY']);
  });

  it('使用各区段自己的匹配键(CommodityName),无匹配键的区段(Gem)不要求', () => {
    const ok = validateFeaturesPatch('StoreCommodityFeatures', { Plants: [{ CommodityName: 'snowpea', CurrencyRequired: 30 }], Gem: [{ CommodityCount: 10 }] }, 'f', schema);
    assert.deepEqual(ok, []);
    const missing = validateFeaturesPatch('StoreCommodityFeatures', { Plants: [{ CurrencyRequired: 30 }] }, 'f', schema);
    assert.deepEqual(codes(missing, 'warning'), ['PATCH_ENTRY_NO_KEY']);
  });

  it('区段结构错误给出警告', () => {
    assert.deepEqual(codes(validateFeaturesPatch('PlantFeatures', { PLANTS: { CODENAME: 'x' } }, 'f', schema), 'warning'), ['PATCH_SECTION_TYPE']);
    assert.deepEqual(codes(validateFeaturesPatch('PlantFeatures', { PLANTS: ['peashooter'] }, 'f', schema), 'warning'), ['PATCH_ENTRY_TYPE']);
    assert.deepEqual(codes(validateFeaturesPatch('PlantFeatures', { SEEDCHOOSERDEFAULTORDER: 'a' }, 'f', schema), 'warning'), ['PATCH_SECTION_TYPE']);
    assert.deepEqual(codes(validateFeaturesPatch('PlantFeatures', [], 'f', schema), 'warning'), ['PATCH_NOT_OBJECT']);
  });

  it('忽略以 # 或 // 开头的注释键', () => {
    const result = validateFeaturesPatch('PlantFeatures', { '#comment': 'x', '//': 'y', PLANTS: [] }, 'f', schema);
    assert.deepEqual(result, []);
  });

  it('同一文件的诊断数量有上限,超出部分汇总提示', () => {
    const entries = Array.from({ length: 100 }, () => ({ CODENAME: 'peashooter', BOOT: 1 }));
    const result = validateFeaturesPatch('PlantFeatures', { PLANTS: entries }, 'f', schema);
    assert.ok(result.length <= 41);
    assert.equal(result.at(-1)!.code, 'PATCH_TOO_MANY');
  });
});

describe('validateObjectsPatch', () => {
  const entry = (objdata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    objects: [{ aliases: ['peashooter'], objclass: 'PlantProperties', objdata, ...extra }],
  });

  it('合法补丁没有诊断', () => {
    assert.deepEqual(validateObjectsPatch('PlantProps', entry({ SunCost: 150, Cooldown: 5 }), 'f', schema), []);
  });

  it('字段名区分大小写:LifeSpan 与 Lifespan 是两个不同的真实字段', () => {
    assert.deepEqual(validateObjectsPatch('PlantProps', entry({ LifeSpan: 1, Lifespan: 2 }), 'f', schema), []);
    const wrongCase = validateObjectsPatch('PlantProps', entry({ Sunccost: 1, suncost: 1 }), 'f', schema);
    assert.ok(codes(wrongCase, 'warning').includes('PATCH_FIELD_TYPO'));
  });

  it('字段名与类型错误', () => {
    const result = validateObjectsPatch('PlantProps', entry({ SunCost: '100', Cooldwn: 5 }), 'f', schema);
    assert.deepEqual(codes(result, 'warning').sort(), ['PATCH_FIELD_TYPE', 'PATCH_FIELD_TYPO']);
  });

  it('原版允许 null 的字段接受 null', () => {
    assert.deepEqual(validateObjectsPatch('PlantProps', entry({ MaybeNull: null }), 'f', schema), []);
  });

  it('aliases[0] 拼错只给 info 并附建议', () => {
    const patch = { objects: [{ aliases: ['peashoter'], objclass: 'PlantProperties', objdata: {} }] };
    const result = validateObjectsPatch('PlantProps', patch, 'f', schema);
    assert.deepEqual(codes(result), ['PATCH_KEY_NOT_FOUND']);
    assert.match(result[0]!.message, /peashooter/);
  });

  it('省略 objclass 时按别名推断所属类并校验字段', () => {
    const patch = { objects: [{ aliases: ['peashooter'], objdata: { Cooldwn: 1 } }] };
    assert.ok(codes(validateObjectsPatch('PlantProps', patch, 'f', schema), 'warning').includes('PATCH_FIELD_TYPO'));
  });

  it('objclass 不存在时给出建议', () => {
    const result = validateObjectsPatch('PlantProps', entry({}, { objclass: 'PlantProperty' }), 'f', schema);
    assert.deepEqual(codes(result, 'warning'), ['PATCH_CLASS_UNKNOWN']);
    assert.match(result[0]!.message, /PlantProperties/);
  });

  it('同一文件中不同 objclass 的字段表互不混淆', () => {
    const patch = { objects: [{ aliases: ['other'], objclass: 'ZombieOther', objdata: { Weird: 'x', Speed: 1 } }] };
    const result = validateObjectsPatch('ZombieProps', patch, 'f', schema);
    assert.deepEqual(codes(result, 'warning'), []);
    assert.ok(result.some((d) => d.code === 'PATCH_FIELD_NEW' && d.field?.endsWith('Speed')));
  });

  it('缺少 aliases、objects 或顶层结构错误', () => {
    assert.deepEqual(codes(validateObjectsPatch('PlantProps', { objects: [{ objdata: {} }] }, 'f', schema), 'warning'), ['PATCH_ENTRY_NO_KEY']);
    assert.deepEqual(codes(validateObjectsPatch('PlantProps', {}, 'f', schema), 'warning'), ['PATCH_OBJECTS_MISSING']);
    assert.deepEqual(codes(validateObjectsPatch('PlantProps', [], 'f', schema), 'warning'), ['PATCH_NOT_OBJECT']);
  });

  it('顶层键 object 拼错给出建议;允许 version 与注释键', () => {
    const typo = validateObjectsPatch('PlantProps', { object: [] }, 'f', schema);
    assert.ok(codes(typo, 'warning').includes('PATCH_TOPLEVEL_UNKNOWN'));
    assert.match(typo.find((d) => d.code === 'PATCH_TOPLEVEL_UNKNOWN')!.message, /objects/);
    assert.deepEqual(validateObjectsPatch('PlantProps', { '#comment': 'x', version: 1, objects: [] }, 'f', schema), []);
  });

  it('不是原版类型时只给提示并跳过', () => {
    assert.deepEqual(codes(validateObjectsPatch('MyProps', { objects: [] }, 'f', schema)), ['PATCH_TYPE_UNKNOWN']);
  });
});
