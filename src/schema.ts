/**
 * 由 scripts/build-schema.mjs 从官方"原始 JSON 压缩包"提取的字段 schema,
 * 只含字段名、值类型与条目标识,不含游戏文本或数值。
 */

import fs from 'node:fs';

export type ValueKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface EntriesSection {
  kind: 'entries';
  /** 字段名 → 原版数据中出现过的值类型 */
  fields: Record<string, ValueKind[]>;
  /** 条目匹配键(如 CODENAME);没有匹配键的区段整体替换 */
  keyField?: string;
  /** 原版中已有的匹配键取值 */
  keys?: string[];
}

export type Section = EntriesSection | { kind: 'list' } | { kind: 'object' } | { kind: 'value' };

export interface ObjectClassSchema {
  fields: Record<string, ValueKind[]>;
  /** 原版中该 objclass 的 aliases[0] 取值 */
  aliases: string[];
}

export interface Schema {
  gameVersion: string;
  source: string;
  features: Record<string, { sections: Record<string, Section> }>;
  objects: Record<string, { classes: Record<string, ObjectClassSchema> }>;
}

const BUNDLED_SCHEMA_FILE = 'schema-0.15.0.json';

export class SchemaError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 加载用户指定的 schema 文件(由 scripts/build-schema.mjs 生成)。
 * 文件来自外部,所以做基本的结构检查;不合格时抛出 SchemaError 并说明原因。
 */
export function loadSchemaFile(file: string): Schema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new SchemaError(`无法读取 schema 文件 ${file}:${(e as Error).message}`);
  }
  if (
    !isPlainObject(parsed) ||
    typeof parsed.gameVersion !== 'string' ||
    !isPlainObject(parsed.features) ||
    !isPlainObject(parsed.objects)
  ) {
    throw new SchemaError(`${file} 不是有效的 schema:需要 gameVersion、features、objects。请用 scripts/build-schema.mjs 生成`);
  }
  for (const [name, type] of Object.entries(parsed.features)) {
    if (!isPlainObject(type) || !isPlainObject(type.sections)) {
      throw new SchemaError(`${file} 的 features.${name} 缺少 sections,文件可能已损坏或来自不兼容的版本`);
    }
  }
  for (const [name, type] of Object.entries(parsed.objects)) {
    if (!isPlainObject(type) || !isPlainObject(type.classes)) {
      throw new SchemaError(`${file} 的 objects.${name} 缺少 classes,文件可能已损坏或来自不兼容的版本`);
    }
  }
  return parsed as unknown as Schema;
}

let cached: Schema | null | undefined;

/** 加载随包发布的 schema;文件缺失或损坏时返回 undefined,调用方应降级为不做字段校验 */
export function loadBundledSchema(): Schema | undefined {
  if (cached === undefined) {
    try {
      const url = new URL(`../../data/${BUNDLED_SCHEMA_FILE}`, import.meta.url);
      cached = JSON.parse(fs.readFileSync(url, 'utf8')) as Schema;
    } catch {
      cached = null;
    }
  }
  return cached ?? undefined;
}
