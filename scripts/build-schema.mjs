#!/usr/bin/env node
/**
 * 从官方"原始 JSON 压缩包"提取字段名与类型,生成 gpn-kit 使用的 schema。
 *
 * 用法:
 *   1. 下载并解压官方压缩包(参见 https://pvzge.com/en/guide/mod/gp-next-json ):
 *        Invoke-WebRequest https://pvzge.com/resources/game-json-0.15.0.zip -OutFile game-json.zip
 *        Expand-Archive game-json.zip -DestinationPath game-json
 *   2. node scripts/build-schema.mjs <解压目录> [输出文件]
 *
 * 输出只包含字段名、值类型和条目标识(CODENAME / aliases[0] 等),不包含任何游戏文本或数值。
 * 匹配键规则来自官方 Merge Rules 页:
 *   https://pvzge.com/en/guide/mod/gp-next-merge.html
 */

import fs from 'node:fs';
import path from 'node:path';

const [, , srcDir, outArg] = process.argv;
if (!srcDir) {
  console.error('用法: node scripts/build-schema.mjs <解压后的原始 JSON 目录> [输出文件]');
  process.exit(2);
}

const root = path.resolve(srcDir);
const manifest = readJson(path.join(root, 'MANIFEST.json'));
const gameVersion = manifest.version;
if (typeof gameVersion !== 'string') throw new Error('MANIFEST.json 缺少 version');
const outFile = path.resolve(outArg ?? path.join('data', `schema-${gameVersion}.json`));

/** 官方 Merge Rules 页:大多数 Features 用 CODENAME,以下为例外(类型名 → 区段名 → 匹配键) */
const KEY_OVERRIDES = {
  MintObtainRoute: { ROUTES: 'Family' },
  StoreCommodityFeatures: { Plants: 'CommodityName', Upgrade: 'CommodityName' },
};
const DEFAULT_KEY = 'CODENAME';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kindOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function sortedKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

/** 汇总一组对象的字段 → 出现过的值类型 */
function collectFields(entries) {
  const fields = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      (fields[key] ??= new Set()).add(kindOf(value));
    }
  }
  return sortedKeys(Object.fromEntries(Object.entries(fields).map(([k, set]) => [k, [...set].sort()])));
}

function buildFeatures(typeName, data) {
  const sections = {};
  for (const [name, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      const section = { kind: 'entries', fields: collectFields(value) };
      const keyField = KEY_OVERRIDES[typeName]?.[name] ?? (value.every((e) => DEFAULT_KEY in e) ? DEFAULT_KEY : undefined);
      if (keyField) {
        const keys = value.map((e) => e[keyField]);
        if (!keys.every((k) => typeof k === 'string')) {
          throw new Error(`${typeName}.${name}: 匹配键 ${keyField} 并非在每个条目里都是字符串`);
        }
        section.keyField = keyField;
        section.keys = [...new Set(keys)].sort();
      }
      sections[name] = section;
    } else if (Array.isArray(value)) {
      sections[name] = { kind: 'list' };
    } else if (isPlainObject(value)) {
      sections[name] = { kind: 'object' };
    } else {
      sections[name] = { kind: 'value' };
    }
  }
  return { sections };
}

function buildObjects(data) {
  const byClass = new Map();
  for (const obj of Array.isArray(data.objects) ? data.objects : []) {
    // 少数条目没有 objclass(PropertySheets 中 18 条),无法归类,跳过
    if (typeof obj.objclass !== 'string') continue;
    const cls = byClass.get(obj.objclass) ?? { entries: [], aliases: [] };
    if (isPlainObject(obj.objdata)) cls.entries.push(obj.objdata);
    const alias = Array.isArray(obj.aliases) ? obj.aliases[0] : undefined;
    if (typeof alias === 'string') cls.aliases.push(alias);
    byClass.set(obj.objclass, cls);
  }
  const classes = {};
  for (const [name, cls] of [...byClass].sort(([a], [b]) => a.localeCompare(b))) {
    classes[name] = { fields: collectFields(cls.entries), aliases: [...new Set(cls.aliases)].sort() };
  }
  return { classes };
}

const features = {};
const objects = {};
const listJson = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.json')).sort();

for (const file of listJson('Features')) {
  features[path.basename(file, '.json')] = buildFeatures(path.basename(file, '.json'), readJson(path.join(root, 'Features', file)));
}
for (const file of listJson('Objects')) {
  objects[path.basename(file, '.json')] = buildObjects(readJson(path.join(root, 'Objects', file)));
}

const schema = {
  gameVersion,
  source: manifest.source,
  sourceSha256: manifest.sourceSha256,
  note: '由 scripts/build-schema.mjs 生成,仅含字段名、值类型与条目标识,不含游戏文本或数值。',
  features,
  objects,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(schema)}\n`);

const size = fs.statSync(outFile).size;
console.log(`已生成 ${outFile}`);
console.log(`游戏版本 ${gameVersion};Features ${Object.keys(features).length} 个,Objects ${Object.keys(objects).length} 个;${(size / 1024).toFixed(1)} KB`);
