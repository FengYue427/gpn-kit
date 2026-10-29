/**
 * pack.json 清单校验(纯函数,不碰文件系统)。
 *
 * 规则来源:官方文档 https://pvzge.com/en/guide/mod/gp-next-datapack.html
 * (对应游戏 0.15.0 / GP-Next 1.5.2)。文档没有明确规定的地方,
 * 本工具只给 info/warning,不会当作 error。
 */

import { checkVersionRange } from './semverRange.js';
import { closestMatch } from './text.js';
import type { Diagnostic, Severity } from './types.js';

/** 文档列出的 requiredGpNextFeatures 取值("include" 表示可能不完整,所以未知值只给 warning) */
export const KNOWN_FEATURE_IDS = [
  'experimental.jsModding',
  'experimental.worldMapJson',
  'experimental.plantLevelSystem',
  'runtime.dynamicPlantRegistry',
  'runtime.shopExtensions',
  'runtime.scrollSensitivity',
] as const;

export const KNOWN_MANIFEST_FIELDS = [
  'uuid',
  'name',
  'version',
  'packFormatVersion',
  'apiVersion',
  'js',
  'depends',
  'optionalDepends',
  'gpNextVersion',
  'minGpNextVersion',
  'maxGpNextVersion',
  'requiredGpNextFeatures',
  'author',
  'description',
  'priority',
] as const;

export interface ManifestContext {
  /** 目录里是否存在 JS 入口(js.entry 指向的文件,或自动检测到的 scripts/main.js) */
  hasScriptEntry: boolean;
}

const LEGACY_PREFIX = 'legacy:';
/** JS mod 的 uuid:3-128 个字母/数字/点/连字符/下划线,且以字母或数字开头 */
const JS_UUID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
/** depends 里出现这些字符,多半是写成了 npm 包名或版本范围 */
const VERSION_EXPR_CHARS_RE = /[\s^~<>=!*|,@/]/;

const FILE = 'pack.json';

function diag(severity: Severity, code: string, message: string, field?: string): Diagnostic {
  return { severity, code, message, file: FILE, ...(field ? { field } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closestKnownField(key: string): string | undefined {
  if (key.length < 4) return undefined;
  return closestMatch(key, KNOWN_MANIFEST_FIELDS);
}

function checkIdList(out: Diagnostic[], field: 'depends' | 'optionalDepends', value: unknown, selfUuid: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    out.push(diag('error', 'DEPS_NOT_ARRAY', `${field} 必须是 mod uuid 字符串数组`, field));
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      out.push(diag('error', 'DEPS_ITEM_INVALID', `${field} 的每一项都必须是非空字符串(mod uuid)`, field));
      continue;
    }
    if (VERSION_EXPR_CHARS_RE.test(item)) {
      out.push(
        diag('warning', 'DEPS_LOOKS_LIKE_VERSION', `${field} 里的 "${item}" 看起来像 npm 包名或版本范围;这里只能写 mod uuid,平台版本请用 gpNextVersion`, field),
      );
    }
    if (item === selfUuid) {
      out.push(diag('error', 'DEPS_SELF', `${field} 不能依赖自己("${item}")`, field));
      continue;
    }
    if (seen.has(item)) {
      out.push(diag('warning', 'DEPS_DUPLICATE', `${field} 中 "${item}" 重复出现`, field));
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function validateManifest(manifest: unknown, ctx: ManifestContext = { hasScriptEntry: false }): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (!isPlainObject(manifest)) {
    out.push(diag('error', 'MANIFEST_NOT_OBJECT', 'pack.json 的顶层必须是 JSON 对象'));
    return out;
  }
  const m = manifest;
  const isJs = ctx.hasScriptEntry || m.js !== undefined;

  // 拼写检查:未知字段多半是写错了名字
  for (const key of Object.keys(m)) {
    if ((KNOWN_MANIFEST_FIELDS as readonly string[]).includes(key)) continue;
    const suggestion = closestKnownField(key);
    if (suggestion) {
      out.push(diag('warning', 'UNKNOWN_FIELD_TYPO', `未知字段 "${key}",你是不是想写 "${suggestion}"?写错的字段多半不会生效`, key));
    } else {
      out.push(diag('info', 'UNKNOWN_FIELD', `字段 "${key}" 不在文档记录的清单字段中`, key));
    }
  }

  // uuid:必填、更新时必须保持不变
  if (m.uuid === undefined) {
    out.push(diag('error', 'UUID_MISSING', '缺少必填字段 uuid', 'uuid'));
  } else if (typeof m.uuid !== 'string' || m.uuid === '') {
    out.push(diag('error', 'UUID_INVALID', 'uuid 必须是非空字符串', 'uuid'));
  } else {
    if (m.uuid !== m.uuid.trim()) {
      out.push(diag('error', 'UUID_WHITESPACE', 'uuid 首尾不能有空格', 'uuid'));
    }
    // 基于去掉空格后的值检查,这样修好空格后不会再冒出新的错误
    if (m.uuid.trim().startsWith(LEGACY_PREFIX)) {
      out.push(diag('error', 'UUID_RESERVED_PREFIX', `uuid 不能以保留前缀 "${LEGACY_PREFIX}" 开头`, 'uuid'));
    }
    if (isJs && !JS_UUID_RE.test(m.uuid)) {
      out.push(
        diag('error', 'UUID_JS_FORMAT', 'JS mod 的 uuid 必须是 3-128 个字母、数字、点、连字符或下划线,并以字母或数字开头', 'uuid'),
      );
    }
  }

  // name / version:推荐填写
  if (m.name === undefined) {
    out.push(diag('info', 'NAME_MISSING', '建议填写 name', 'name'));
  } else if (typeof m.name !== 'string') {
    out.push(diag('warning', 'NAME_TYPE', 'name 应为字符串', 'name'));
  }
  if (m.version === undefined) {
    out.push(diag('info', 'VERSION_MISSING', '建议填写 version(缺省按 1.0.0 处理)', 'version'));
  } else if (typeof m.version !== 'string') {
    out.push(diag('warning', 'VERSION_TYPE', 'version 应为字符串,例如 "1.0.0"', 'version'));
  }

  // packFormatVersion:目前只支持 1
  if (m.packFormatVersion === undefined) {
    out.push(diag('info', 'PACK_FORMAT_IMPLICIT', '建议显式写出 "packFormatVersion": 1', 'packFormatVersion'));
  } else if (m.packFormatVersion !== 1) {
    out.push(diag('error', 'PACK_FORMAT_UNSUPPORTED', '目前只支持 packFormatVersion: 1', 'packFormatVersion'));
  }

  // apiVersion:JS mod 必须为 2
  if (isJs) {
    if (m.apiVersion !== 2) {
      out.push(diag('error', 'API_VERSION_REQUIRED', 'JS mod 必须声明 "apiVersion": 2', 'apiVersion'));
    }
  } else if (m.apiVersion !== undefined && m.apiVersion !== 2) {
    out.push(diag('warning', 'API_VERSION_UNKNOWN', '文档只记录了 apiVersion: 2', 'apiVersion'));
  }

  // js 配置块
  if (m.js !== undefined) {
    if (!isPlainObject(m.js)) {
      out.push(diag('error', 'JS_NOT_OBJECT', 'js 必须是对象,例如 { "entry": "scripts/main.js" }', 'js'));
    } else {
      const js = m.js;
      if (js.entry !== undefined) {
        if (typeof js.entry !== 'string' || !/\.m?js$/.test(js.entry)) {
          out.push(diag('error', 'JS_ENTRY_INVALID', 'js.entry 必须是指向 .js 或 .mjs 文件的字符串', 'js.entry'));
        }
      }
      if (js.startup !== undefined && typeof js.startup !== 'boolean') {
        out.push(diag('error', 'JS_STARTUP_TYPE', 'js.startup 必须是布尔值', 'js.startup'));
      }
      if (js.reloadable !== undefined && typeof js.reloadable !== 'boolean') {
        out.push(diag('error', 'JS_RELOADABLE_TYPE', 'js.reloadable 必须是布尔值', 'js.reloadable'));
      }
      if (js.reloadable === false && js.startup !== true) {
        out.push(diag('error', 'JS_RELOADABLE_NEEDS_STARTUP', '"js.reloadable": false 只能与 "js.startup": true 一起使用', 'js.reloadable'));
      }
    }
  }

  // 依赖
  const depends = checkIdList(out, 'depends', m.depends, m.uuid);
  const optionalDepends = checkIdList(out, 'optionalDepends', m.optionalDepends, m.uuid);
  for (const id of optionalDepends) {
    if (depends.includes(id)) {
      out.push(diag('warning', 'DEPS_OVERLAP', `"${id}" 同时出现在 depends 和 optionalDepends 中`, 'optionalDepends'));
    }
  }

  // 平台版本范围:游戏对非法表达式只警告不拦截,所以这里更要提前抓出来
  const hasOldBounds = m.minGpNextVersion !== undefined || m.maxGpNextVersion !== undefined;
  if (m.gpNextVersion !== undefined) {
    if (typeof m.gpNextVersion !== 'string') {
      out.push(diag('warning', 'GPNEXT_VERSION_TYPE', 'gpNextVersion 必须是字符串,例如 "^1.5.0"', 'gpNextVersion'));
    } else {
      const check = checkVersionRange(m.gpNextVersion);
      if (!check.ok) {
        out.push(diag('warning', 'GPNEXT_VERSION_INVALID', `gpNextVersion "${m.gpNextVersion}" 不合法:${check.reason}。游戏只会警告而不会拦截`, 'gpNextVersion'));
      }
    }
    if (hasOldBounds) {
      out.push(diag('info', 'OLD_BOUNDS_IGNORED', '已声明 gpNextVersion,旧字段 minGpNextVersion / maxGpNextVersion 会被忽略,可以删除', 'gpNextVersion'));
    }
  } else if (hasOldBounds) {
    out.push(diag('info', 'OLD_BOUNDS_DEPRECATED', 'minGpNextVersion / maxGpNextVersion 是旧字段,建议改用 gpNextVersion', 'minGpNextVersion'));
    for (const key of ['minGpNextVersion', 'maxGpNextVersion'] as const) {
      const v = m[key];
      if (v !== undefined && (typeof v !== 'string' || !/^\d+(\.\d+){0,2}$/.test(v.trim()))) {
        out.push(diag('warning', 'OLD_BOUND_INVALID', `${key} 只接受不带运算符的版本号,例如 "1.5.0"`, key));
      }
    }
  } else {
    out.push(diag('info', 'GPNEXT_VERSION_MISSING', '建议声明 gpNextVersion(如 "^1.5.0"),让玩家在版本不兼容时收到提示', 'gpNextVersion'));
  }

  // 必需的平台功能
  let declaredFeatures: string[] = [];
  if (m.requiredGpNextFeatures !== undefined) {
    if (!Array.isArray(m.requiredGpNextFeatures) || m.requiredGpNextFeatures.some((f) => typeof f !== 'string')) {
      out.push(diag('error', 'FEATURES_TYPE', 'requiredGpNextFeatures 必须是字符串数组', 'requiredGpNextFeatures'));
    } else {
      declaredFeatures = m.requiredGpNextFeatures as string[];
      const seen = new Set<string>();
      for (const id of declaredFeatures) {
        if (seen.has(id)) {
          out.push(diag('warning', 'FEATURES_DUPLICATE', `requiredGpNextFeatures 中 "${id}" 重复出现`, 'requiredGpNextFeatures'));
        }
        seen.add(id);
        if (!(KNOWN_FEATURE_IDS as readonly string[]).includes(id)) {
          out.push(
            diag(
              'warning',
              'FEATURE_UNKNOWN',
              `未知的功能 ID "${id}"。游戏会拒绝加载含未知功能 ID 的 mod;若它是更新版本才新增的 ID,可忽略此警告。已知 ID:${KNOWN_FEATURE_IDS.join(', ')}`,
              'requiredGpNextFeatures',
            ),
          );
        }
      }
    }
  }
  if (isJs && !declaredFeatures.includes('experimental.jsModding')) {
    out.push(
      diag('warning', 'JS_FEATURE_NOT_DECLARED', 'JS mod 建议在 requiredGpNextFeatures 中声明 "experimental.jsModding",否则玩家未开启 JS Modding 时只会遇到莫名其妙的加载失败', 'requiredGpNextFeatures'),
    );
  }

  // 可选元数据
  for (const key of ['author', 'description'] as const) {
    if (m[key] !== undefined && typeof m[key] !== 'string') {
      out.push(diag('warning', 'METADATA_TYPE', `${key} 应为字符串`, key));
    }
  }
  if (m.priority !== undefined && (typeof m.priority !== 'number' || !Number.isFinite(m.priority))) {
    out.push(diag('warning', 'PRIORITY_TYPE', 'priority 应为数字', 'priority'));
  }

  return out;
}
