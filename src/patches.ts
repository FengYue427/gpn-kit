/**
 * 补丁配置文件的内容校验。只覆盖官方文档给出明确格式的两个文件:
 * - jsons/config/patching.json(.json5):https://pvzge.com/en/guide/mod/gp-next-merge.html
 * - jsons/lang/lang.json(.json5):https://pvzge.com/en/guide/mod/gp-next-language.html
 *
 * Features / Objects 补丁里的具体字段名和类型,文档的 Types & Fields 页才有权威说明,
 * 目前未纳入,所以这里不对它们做内容判断。
 */

import type { Diagnostic, Severity } from './types.js';

const MERGE_MODES = ['merge', 'replace'] as const;
const PATCHING_KEYS = ['defaultMode', 'features', 'objects'] as const;
/** 文档明确说 patching 配置不控制这些内容 */
const NOT_CONTROLLED_BY_PATCHING = ['levels', 'level', 'lang', 'language', 'languages', 'map', 'maps', 'worldmap'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagAt(file: string) {
  return (severity: Severity, code: string, message: string, field?: string): Diagnostic => ({
    severity,
    code,
    message,
    file,
    ...(field ? { field } : {}),
  });
}

export function validatePatchingConfig(value: unknown, file: string): Diagnostic[] {
  const d = diagAt(file);
  const out: Diagnostic[] = [];

  if (!isPlainObject(value)) {
    out.push(d('error', 'PATCHING_NOT_OBJECT', 'patching 配置的顶层必须是对象,例如 { "defaultMode": "merge" }'));
    return out;
  }

  for (const key of Object.keys(value)) {
    if ((PATCHING_KEYS as readonly string[]).includes(key)) continue;
    const sameIgnoringCase = PATCHING_KEYS.find((known) => known.toLowerCase() === key.toLowerCase());
    if (sameIgnoringCase) {
      out.push(d('warning', 'PATCHING_KEY_CASE', `"${key}" 大小写不对,应写作 "${sameIgnoringCase}"`, key));
    } else if (NOT_CONTROLLED_BY_PATCHING.includes(key.toLowerCase())) {
      out.push(d('warning', 'PATCHING_UNSUPPORTED_SECTION', `"${key}" 不受 patching 配置控制:关卡使用完整文件,语言补丁按深度合并,地图有独立格式`, key));
    } else {
      out.push(d('warning', 'PATCHING_UNKNOWN_KEY', `未知键 "${key}"。文档只记录了 ${PATCHING_KEYS.join('、')}`, key));
    }
  }

  const checkMode = (mode: unknown, field: string): void => {
    if (!(MERGE_MODES as readonly unknown[]).includes(mode)) {
      out.push(d('warning', 'PATCHING_MODE_INVALID', `模式必须是 "merge" 或 "replace",当前为 ${JSON.stringify(mode)}`, field));
    }
  };

  if (value.defaultMode !== undefined) checkMode(value.defaultMode, 'defaultMode');

  for (const section of ['features', 'objects'] as const) {
    const entries = value[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      out.push(d('warning', 'PATCHING_SECTION_TYPE', `${section} 必须是对象:键为类型名,值形如 { "mode": "replace" }`, section));
      continue;
    }
    for (const [typeName, entry] of Object.entries(entries)) {
      const field = `${section}.${typeName}`;
      if (!isPlainObject(entry)) {
        out.push(d('warning', 'PATCHING_ENTRY_TYPE', `${field} 必须是对象,例如 { "mode": "replace" }`, field));
      } else if (entry.mode === undefined) {
        out.push(d('info', 'PATCHING_ENTRY_NO_MODE', `${field} 没有 mode,将沿用 defaultMode(缺省为 merge)`, field));
      } else {
        checkMode(entry.mode, `${field}.mode`);
      }
    }
  }

  return out;
}

export function validateLangPatch(value: unknown, file: string): Diagnostic[] {
  const d = diagAt(file);
  const out: Diagnostic[] = [];

  if (!isPlainObject(value)) {
    out.push(d('error', 'LANG_NOT_OBJECT', 'lang 补丁的顶层必须是对象:键为原语言表中的文本节点'));
    return out;
  }

  const languages = value._languages;
  if (languages === undefined) return out;

  if (!Array.isArray(languages)) {
    out.push(d('error', 'LANG_LANGUAGES_TYPE', '_languages 必须是数组,例如 [{ "code": "es", "name": "Español", "isCJK": false }]', '_languages'));
    return out;
  }

  const seen = new Set<string>();
  languages.forEach((lang, i) => {
    const field = `_languages[${i}]`;
    if (!isPlainObject(lang)) {
      out.push(d('error', 'LANG_ENTRY_TYPE', `${field} 必须是对象`, field));
      return;
    }
    if (typeof lang.code !== 'string' || lang.code.trim() === '') {
      out.push(d('error', 'LANG_CODE_INVALID', `${field}.code 必须是非空字符串(语言代码,如 "es")`, `${field}.code`));
    } else if (seen.has(lang.code)) {
      out.push(d('warning', 'LANG_CODE_DUPLICATE', `语言代码 "${lang.code}" 重复注册`, `${field}.code`));
    } else {
      seen.add(lang.code);
    }
    if (typeof lang.name !== 'string' || lang.name.trim() === '') {
      out.push(d('warning', 'LANG_NAME_INVALID', `${field}.name 应为非空字符串(显示在游戏设置里的语言名)`, `${field}.name`));
    }
    if (lang.isCJK !== undefined && typeof lang.isCJK !== 'boolean') {
      out.push(d('warning', 'LANG_ISCJK_TYPE', `${field}.isCJK 应为布尔值(控制文本宽度处理)`, `${field}.isCJK`));
    }
  });

  return out;
}
