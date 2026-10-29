import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { validateFeaturesPatch, validateObjectsPatch } from '../src/patchContent.js';
import { loadBundledSchema, loadSchemaFile, SchemaError } from '../src/schema.js';

describe('随包发布的 schema(游戏 0.15.0)', () => {
  const schema = loadBundledSchema();

  it('能够加载,且包含预期的类型', () => {
    assert.ok(schema, '应能加载 data/schema-0.15.0.json');
    assert.equal(schema.gameVersion, '0.15.0');
    assert.ok(schema.features.PlantFeatures);
    assert.ok(schema.objects.PlantProps);
  });

  it('匹配键与官方 Merge Rules 页一致', () => {
    assert.equal(schema!.features.PlantFeatures!.sections.PLANTS!.kind, 'entries');
    const key = (type: string, section: string) => {
      const s = schema!.features[type]!.sections[section]!;
      return s.kind === 'entries' ? s.keyField : undefined;
    };
    assert.equal(key('PlantFeatures', 'PLANTS'), 'CODENAME');
    assert.equal(key('ZombieFeatures', 'ZOMBIES'), 'CODENAME');
    assert.equal(key('MintObtainRoute', 'ROUTES'), 'Family');
    assert.equal(key('StoreCommodityFeatures', 'Plants'), 'CommodityName');
    assert.equal(key('StoreCommodityFeatures', 'Upgrade'), 'CommodityName');
    assert.equal(key('StoreCommodityFeatures', 'Gem'), undefined);
  });

  it('以真实数据为准:PlantFeatures 有 TAGS 而没有文档表格里的 TYPE', () => {
    const section = schema!.features.PlantFeatures!.sections.PLANTS!;
    assert.ok(section.kind === 'entries');
    assert.ok('TAGS' in section.fields);
    assert.ok(!('TYPE' in section.fields));
  });

  it('保留了仅大小写不同的真实字段(校验必须区分大小写)', () => {
    const fields = schema!.objects.PlantProps!.classes.PlantProperties!.fields;
    assert.ok('LifeSpan' in fields && 'Lifespan' in fields);
  });

  it('不含游戏文本:除 note 外没有任何中文字符', () => {
    const { note: _omit, ...rest } = schema as unknown as Record<string, unknown>;
    assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(rest)));
  });

  it('官方文档的示例补丁在真实 schema 下零诊断', () => {
    const patch = { PLANTS: [{ CODENAME: 'peashooter', BOOST: 3 }] };
    assert.deepEqual(validateFeaturesPatch('PlantFeatures', patch, 'f', schema!), []);
  });
});

describe('loadSchemaFile:用户提供的 schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-schema-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };

  it('能加载合法的 schema(包括带 BOM 的文件)', () => {
    const bundled = loadBundledSchema()!;
    assert.equal(loadSchemaFile(write('ok.json', bundled)).gameVersion, '0.15.0');
    assert.equal(loadSchemaFile(write('bom.json', `\uFEFF${JSON.stringify(bundled)}`)).gameVersion, '0.15.0');
  });

  it('文件不存在或不是 JSON', () => {
    assert.throws(() => loadSchemaFile(path.join(dir, 'nope.json')), SchemaError);
    assert.throws(() => loadSchemaFile(write('bad.json', '{ not json')), SchemaError);
  });

  it('结构不对时给出明确的错误,而不是等到校验时崩溃', () => {
    assert.throws(() => loadSchemaFile(write('arr.json', [])), /不是有效的 schema/);
    assert.throws(() => loadSchemaFile(write('nover.json', { features: {}, objects: {} })), /gameVersion/);
    assert.throws(() => loadSchemaFile(write('nosec.json', { gameVersion: '1', features: { X: {} }, objects: {} })), /features\.X/);
    assert.throws(() => loadSchemaFile(write('nocls.json', { gameVersion: '1', features: {}, objects: { Y: {} } })), /objects\.Y/);
  });
});

/**
 * 回归防线:把官方原版 JSON 自己当作补丁,不应出现 warning/error(否则就是规则误报)。
 * 原版数据体积大且属于官方,不随仓库发布;设置 GPN_GAME_JSON_DIR 指向解压后的目录时才运行。
 * 唯一已知的例外:PropertySheets.json 里 18 个原版条目本身就没有 aliases。
 */
const gameJsonDir = process.env.GPN_GAME_JSON_DIR;
describe('原版数据自检(需要 GPN_GAME_JSON_DIR)', { skip: gameJsonDir ? false : '未设置 GPN_GAME_JSON_DIR' }, () => {
  const schema = loadBundledSchema()!;
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(gameJsonDir!, rel), 'utf8').replace(/^\uFEFF/, ''));

  it('Features 全部通过', () => {
    for (const file of fs.readdirSync(path.join(gameJsonDir!, 'Features')).filter((f) => f.endsWith('.json'))) {
      const diagnostics = validateFeaturesPatch(path.basename(file, '.json'), read(`Features/${file}`), file, schema);
      assert.deepEqual(diagnostics.filter((d) => d.severity !== 'info'), [], file);
    }
  });

  it('Objects 全部通过(PropertySheets 的无别名条目除外)', () => {
    for (const file of fs.readdirSync(path.join(gameJsonDir!, 'Objects')).filter((f) => f.endsWith('.json'))) {
      const diagnostics = validateObjectsPatch(path.basename(file, '.json'), read(`Objects/${file}`), file, schema);
      const problems = diagnostics.filter((d) => d.severity !== 'info' && !(file === 'PropertySheets.json' && d.code === 'PATCH_ENTRY_NO_KEY'));
      assert.deepEqual(problems, [], file);
    }
  });
});
