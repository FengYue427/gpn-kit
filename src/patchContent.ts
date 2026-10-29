/**
 * 数据补丁(jsons/features、jsons/objects)的内容校验:字段名、值类型、条目匹配键。
 *
 * 判断依据是官方原始 JSON(见 schema.ts),而不是文档表格:
 * 两者有出入,例如文档的 PlantFeatures 表列了 TYPE,0.15.0 的真实数据里是 TAGS。
 *
 * 严重级别的取舍:mod 完全可以合法地新增条目或字段(例如新增植物),
 * 所以"原版没有的名字"只在高度疑似拼写错误时给 warning,否则只给 info。
 * 值类型与原版不一致则给 warning(原版数据里从未出现过这种类型)。
 */

import type { ObjectClassSchema, Schema, ValueKind } from './schema.js';
import { closestMatch } from './text.js';
import type { Diagnostic, Severity } from './types.js';

/** 单个文件最多报告的诊断数,避免同一个错误在上百个条目里刷屏 */
const MAX_PER_FILE = 40;
/** Objects 补丁顶层允许的非 objects 键(原版文件里的注释与版本号) */
const OBJECTS_TOPLEVEL_OK = new Set(['objects', 'version', '#comment', '//']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): ValueKind {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value as ValueKind;
}

function isCommentKey(key: string): boolean {
  return key.startsWith('#') || key.startsWith('//');
}

class Collector {
  readonly items: Diagnostic[] = [];
  constructor(private readonly file: string) {}

  add(severity: Severity, code: string, message: string, field?: string): void {
    this.items.push({ severity, code, message, file: this.file, ...(field ? { field } : {}) });
  }

  finish(): Diagnostic[] {
    if (this.items.length <= MAX_PER_FILE) return this.items;
    const omitted = this.items.length - MAX_PER_FILE;
    const kept = this.items.slice(0, MAX_PER_FILE);
    kept.push({ severity: 'info', code: 'PATCH_TOO_MANY', message: `该文件还有 ${omitted} 条同类诊断未显示`, file: this.file });
    return kept;
  }
}

/** 校验一个字段名与值类型,fields 是原版 schema 中该条目/类的字段表 */
function checkField(
  c: Collector,
  fields: Record<string, ValueKind[]>,
  name: string,
  value: unknown,
  path: string,
): void {
  const observed = fields[name];
  if (observed === undefined) {
    const suggestion = closestMatch(name, Object.keys(fields));
    if (suggestion) {
      c.add('warning', 'PATCH_FIELD_TYPO', `原版数据中没有字段 "${name}",你是不是想写 "${suggestion}"?(字段名区分大小写)`, path);
    } else {
      c.add('info', 'PATCH_FIELD_NEW', `原版数据中没有字段 "${name}";如果是有意新增的字段可以忽略`, path);
    }
    return;
  }
  const actual = kindOf(value);
  if (!observed.includes(actual)) {
    c.add('warning', 'PATCH_FIELD_TYPE', `字段 "${name}" 在原版数据中的类型是 ${observed.join(' / ')},这里是 ${actual}`, path);
  }
}

function checkKey(c: Collector, known: readonly string[], key: string, keyLabel: string, path: string): void {
  if (known.includes(key)) return;
  const suggestion = closestMatch(key, known);
  const hint = suggestion ? `;你是不是想改 "${suggestion}"?` : '';
  c.add(
    'info',
    'PATCH_KEY_NOT_FOUND',
    `原版中没有 ${keyLabel} 为 "${key}" 的条目,将被当作新增条目${hint}`,
    path,
  );
}

export function validateFeaturesPatch(typeName: string, value: unknown, file: string, schema: Schema): Diagnostic[] {
  const c = new Collector(file);
  const typeSchema = schema.features[typeName];
  if (!typeSchema) {
    c.add('info', 'PATCH_TYPE_UNKNOWN', `"${typeName}" 不是游戏 ${schema.gameVersion} 的原版 Features 类型,已跳过字段校验`);
    return c.finish();
  }
  if (!isPlainObject(value)) {
    c.add('warning', 'PATCH_NOT_OBJECT', 'Features 补丁的顶层必须是对象,键为区段名(如 PLANTS)');
    return c.finish();
  }

  const sectionNames = Object.keys(typeSchema.sections);
  for (const [sectionName, sectionValue] of Object.entries(value)) {
    if (isCommentKey(sectionName)) continue;
    const section = typeSchema.sections[sectionName];
    if (!section) {
      const suggestion = closestMatch(sectionName, sectionNames);
      c.add(
        'warning',
        'PATCH_SECTION_UNKNOWN',
        `${typeName} 中没有区段 "${sectionName}"${suggestion ? `,你是不是想写 "${suggestion}"?` : `(可用:${sectionNames.join(', ')})`}`,
        sectionName,
      );
      continue;
    }

    if (section.kind === 'list') {
      if (!Array.isArray(sectionValue)) c.add('warning', 'PATCH_SECTION_TYPE', `区段 ${sectionName} 应为数组`, sectionName);
      continue;
    }
    if (section.kind === 'object') {
      if (!isPlainObject(sectionValue)) c.add('warning', 'PATCH_SECTION_TYPE', `区段 ${sectionName} 应为对象`, sectionName);
      continue;
    }
    if (section.kind !== 'entries') continue;

    if (!Array.isArray(sectionValue)) {
      c.add('warning', 'PATCH_SECTION_TYPE', `区段 ${sectionName} 应为对象数组`, sectionName);
      continue;
    }
    sectionValue.forEach((entry, i) => {
      const entryPath = `${sectionName}[${i}]`;
      if (!isPlainObject(entry)) {
        c.add('warning', 'PATCH_ENTRY_TYPE', `${entryPath} 应为对象`, entryPath);
        return;
      }
      if (section.keyField !== undefined) {
        const key = entry[section.keyField];
        if (typeof key !== 'string') {
          c.add('warning', 'PATCH_ENTRY_NO_KEY', `${entryPath} 缺少匹配键 ${section.keyField},补丁无法对应到原版条目`, entryPath);
        } else if (section.keys) {
          checkKey(c, section.keys, key, section.keyField, `${entryPath}.${section.keyField}`);
        }
      }
      for (const [fieldName, fieldValue] of Object.entries(entry)) {
        checkField(c, section.fields, fieldName, fieldValue, `${entryPath}.${fieldName}`);
      }
    });
  }
  return c.finish();
}

export function validateObjectsPatch(typeName: string, value: unknown, file: string, schema: Schema): Diagnostic[] {
  const c = new Collector(file);
  const typeSchema = schema.objects[typeName];
  if (!typeSchema) {
    c.add('info', 'PATCH_TYPE_UNKNOWN', `"${typeName}" 不是游戏 ${schema.gameVersion} 的原版 Objects 类型,已跳过字段校验`);
    return c.finish();
  }
  if (!isPlainObject(value)) {
    c.add('warning', 'PATCH_NOT_OBJECT', 'Objects 补丁的顶层必须是对象,形如 { "objects": [ ... ] }');
    return c.finish();
  }

  for (const key of Object.keys(value)) {
    if (OBJECTS_TOPLEVEL_OK.has(key) || isCommentKey(key)) continue;
    const suggestion = closestMatch(key, ['objects']);
    c.add('warning', 'PATCH_TOPLEVEL_UNKNOWN', `顶层键 "${key}" 不会被识别${suggestion ? `,你是不是想写 "${suggestion}"?` : ''}`, key);
  }
  if (!Array.isArray(value.objects)) {
    c.add('warning', 'PATCH_OBJECTS_MISSING', '缺少 objects 数组,此补丁不会产生任何效果', 'objects');
    return c.finish();
  }

  const classNames = Object.keys(typeSchema.classes);
  const aliasToClass = new Map<string, string>();
  for (const [className, cls] of Object.entries(typeSchema.classes)) {
    for (const alias of cls.aliases) aliasToClass.set(alias, className);
  }
  const allAliases = [...aliasToClass.keys()];

  value.objects.forEach((entry, i) => {
    const entryPath = `objects[${i}]`;
    if (!isPlainObject(entry)) {
      c.add('warning', 'PATCH_ENTRY_TYPE', `${entryPath} 应为对象`, entryPath);
      return;
    }

    const alias = Array.isArray(entry.aliases) ? entry.aliases[0] : undefined;
    if (typeof alias !== 'string') {
      c.add('warning', 'PATCH_ENTRY_NO_KEY', `${entryPath} 缺少 aliases[0],补丁无法对应到原版条目`, `${entryPath}.aliases`);
    } else {
      checkKey(c, allAliases, alias, 'aliases[0]', `${entryPath}.aliases`);
    }

    let cls: ObjectClassSchema | undefined;
    if (typeof entry.objclass === 'string') {
      cls = typeSchema.classes[entry.objclass];
      if (!cls) {
        const suggestion = closestMatch(entry.objclass, classNames);
        c.add(
          'warning',
          'PATCH_CLASS_UNKNOWN',
          `${typeName} 中没有 objclass "${entry.objclass}"${suggestion ? `,你是不是想写 "${suggestion}"?` : `(可用:${classNames.join(', ')})`}`,
          `${entryPath}.objclass`,
        );
      }
    } else if (typeof alias === 'string') {
      // 补丁省略 objclass 时,按原版里该别名所属的类推断
      const inferred = aliasToClass.get(alias);
      if (inferred) cls = typeSchema.classes[inferred];
    }

    if (entry.objdata === undefined) return;
    if (!isPlainObject(entry.objdata)) {
      c.add('warning', 'PATCH_ENTRY_TYPE', `${entryPath}.objdata 应为对象`, `${entryPath}.objdata`);
      return;
    }
    if (!cls) return; // 不知道属于哪个类,无法判断字段
    for (const [fieldName, fieldValue] of Object.entries(entry.objdata)) {
      checkField(c, cls.fields, fieldName, fieldValue, `${entryPath}.objdata.${fieldName}`);
    }
  });
  return c.finish();
}
