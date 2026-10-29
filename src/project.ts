/**
 * mod 目录级校验:定位 pack.json、核对 JS 入口、检查 jsons/ 布局与补丁语法。
 *
 * 目录布局来源:官方文档 https://pvzge.com/en/guide/mod/gp-next-datapack.html
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';
import { validateManifest } from './manifest.js';
import { validateFeaturesPatch, validateObjectsPatch } from './patchContent.js';
import { validateLangPatch, validatePatchingConfig } from './patches.js';
import { loadBundledSchema, type Schema } from './schema.js';
import { extractZip } from './zip.js';
import type { Diagnostic, ProjectResult, Severity } from './types.js';

/**
 * jsons/ 下文档记录的子目录;值为该目录里文档记录的固定文件名(不含扩展名,.json 与 .json5 均可),
 * 没有固定名则为 undefined。lang 与 patching 允许 .json5 见官方 Language Packs / Merge Rules 页。
 */
const JSONS_SUBDIRS: Record<string, string | undefined> = {
  features: undefined,
  objects: undefined,
  levels: undefined,
  lang: 'lang',
  config: 'patching',
  worldmap: 'gpn-worldmap',
  extensions: 'plant-levels',
};

const DEFAULT_SCRIPT_ENTRY = 'scripts/main.js';

function diag(severity: Severity, code: string, message: string, file?: string, field?: string): Diagnostic {
  return { severity, code, message, ...(file ? { file } : {}), ...(field ? { field } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface ValidateOptions {
  /** 字段校验用的 schema。缺省使用随包发布的游戏数据;传 false 则跳过字段校验 */
  schema?: Schema | false;
}

/** 入口里的静态 import / re-export(官方要求多模块、TypeScript、npm 库先打包成单个 ES 模块) */
const STATIC_IMPORT_RE = /^\s*(?:import\s+(?:[\w*${}\s,]+\s+from\s+)?['"][^'"]+['"]|export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"])/m;
const DEFAULT_EXPORT_RE = /\bexport\s+default\b/;

export function validateProject(dir: string, options: ValidateOptions = {}): ProjectResult {
  const root = path.resolve(dir);
  const diagnostics: Diagnostic[] = [];
  const result: ProjectResult = { dir: root, diagnostics };
  const schema = options.schema === false ? undefined : (options.schema ?? loadBundledSchema());
  let schemaUsed = false;
  let schemaMissingReported = false;

  if (!isDirectory(root)) {
    diagnostics.push(diag('error', 'DIR_NOT_FOUND', `目录不存在:${root}`));
    return result;
  }

  // 1. 定位并解析 pack.json
  const packPath = path.join(root, 'pack.json');
  if (!isFile(packPath)) {
    const nested = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isFile(path.join(root, e.name, 'pack.json')))
      .map((e) => e.name);
    const hint =
      nested.length > 0
        ? `。在子目录 "${nested[0]}" 中找到了 pack.json:打包 ZIP 时 pack.json 必须位于 ZIP 根部,请对该子目录校验,并从子目录内部压缩`
        : '';
    diagnostics.push(diag('error', 'PACK_MISSING', `根目录缺少 pack.json${hint}`));
    return result;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readText(packPath));
  } catch (e) {
    diagnostics.push(diag('error', 'PACK_INVALID_JSON', `pack.json 不是合法 JSON:${(e as Error).message}`, 'pack.json'));
    return result;
  }

  // 2. 确定 JS 入口:js.entry 指定的文件,否则自动检测 scripts/main.js
  const jsField = isPlainObject(manifest) ? manifest.js : undefined;
  const declaredEntry = isPlainObject(jsField) && typeof jsField.entry === 'string' ? jsField.entry : undefined;
  const autoEntryExists = isFile(path.join(root, DEFAULT_SCRIPT_ENTRY));
  const entryRel = declaredEntry ?? (autoEntryExists ? DEFAULT_SCRIPT_ENTRY : undefined);

  diagnostics.push(...validateManifest(manifest, { hasScriptEntry: entryRel !== undefined }));

  if (isPlainObject(jsField) && declaredEntry === undefined && !autoEntryExists && jsField.entry === undefined) {
    diagnostics.push(diag('error', 'JS_ENTRY_MISSING', `声明了 js 但没有 js.entry,且找不到 ${DEFAULT_SCRIPT_ENTRY}`, 'pack.json', 'js.entry'));
  }

  if (entryRel !== undefined && /\.m?js$/.test(entryRel)) {
    const entryPath = path.resolve(root, entryRel);
    const relative = path.relative(root, entryPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      diagnostics.push(diag('error', 'JS_ENTRY_ESCAPES', `js.entry "${entryRel}" 指向 mod 目录之外`, 'pack.json', 'js.entry'));
    } else if (!isFile(entryPath)) {
      diagnostics.push(diag('error', 'JS_ENTRY_NOT_FOUND', `找不到 JS 入口文件 "${entryRel}"`, 'pack.json', 'js.entry'));
    } else {
      const source = readText(entryPath);
      const entryRelPosix = toPosix(relative);
      if (!/\bsetup\b/.test(source)) {
        diagnostics.push(diag('warning', 'JS_SETUP_NOT_FOUND', '入口文件中没有找到 setup;JS mod 的入口必须提供 setup(ctx)', entryRelPosix));
      } else if (!DEFAULT_EXPORT_RE.test(source)) {
        diagnostics.push(
          diag('info', 'JS_NO_DEFAULT_EXPORT', '官方文档的所有示例都使用 export default { setup(ctx) {} };文档没有说明具名导出 setup 是否同样可用', entryRelPosix),
        );
      }
      if (STATIC_IMPORT_RE.test(source)) {
        diagnostics.push(
          diag('warning', 'JS_ENTRY_HAS_IMPORTS', '入口文件含有 import / export ... from。官方要求多模块、TypeScript 或 npm 库必须先打包成单个 ES 模块再发布,否则游戏里可能无法解析这些引用', entryRelPosix),
        );
      }
    }
  }

  // 3. 扫描 jsons/
  const declaredFeatures =
    isPlainObject(manifest) && Array.isArray(manifest.requiredGpNextFeatures)
      ? (manifest.requiredGpNextFeatures as unknown[])
      : [];
  let jsonFileCount = 0;
  let hasWorldmap = false;
  let hasPlantLevels = false;

  const jsonsDir = path.join(root, 'jsons');
  if (isDirectory(jsonsDir)) {
    for (const entry of fs.readdirSync(jsonsDir, { withFileTypes: true })) {
      const rel = `jsons/${entry.name}`;
      if (!entry.isDirectory()) {
        diagnostics.push(diag('warning', 'JSONS_STRAY_FILE', `jsons/ 根部的文件 "${entry.name}" 不会被识别,补丁应放在 jsons/features、objects、levels、lang 等子目录中`, rel));
        continue;
      }
      if (!Object.hasOwn(JSONS_SUBDIRS, entry.name)) {
        diagnostics.push(
          diag('warning', 'JSONS_UNKNOWN_DIR', `jsons/${entry.name}/ 不是文档记录的目录(可用:${Object.keys(JSONS_SUBDIRS).join(', ')})`, `${rel}/`),
        );
        continue;
      }

      const expectedName = JSONS_SUBDIRS[entry.name];
      for (const file of walkFiles(path.join(jsonsDir, entry.name))) {
        const fileRel = toPosix(path.relative(root, file));
        const ext = path.extname(file).toLowerCase();
        if (ext !== '.json' && ext !== '.json5') {
          diagnostics.push(diag('warning', 'JSONS_NOT_JSON', `"${fileRel}" 不是 .json 文件,游戏可能不会读取它`, fileRel));
          continue;
        }
        jsonFileCount++;
        const stem = path.basename(file, path.extname(file));
        const isExpectedName = expectedName === undefined || stem === expectedName;
        if (entry.name === 'worldmap') hasWorldmap = true;
        if (entry.name === 'extensions' && stem === 'plant-levels') hasPlantLevels = true;

        let content: unknown;
        let parsed = false;
        try {
          content = JSON5.parse(readText(file));
          parsed = true;
        } catch (e) {
          diagnostics.push(diag('error', 'JSON_SYNTAX', `语法错误:${(e as Error).message}`, fileRel));
        }
        if (!isExpectedName) {
          diagnostics.push(
            diag('info', 'JSONS_UNEXPECTED_NAME', `文档中 jsons/${entry.name}/ 的文件名是 ${expectedName}.json 或 ${expectedName}.json5,"${path.basename(file)}" 可能不会被读取`, fileRel),
          );
        }
        // 只对文档有明确格式说明、且文件名正确的配置做内容校验
        if (parsed && isExpectedName) {
          if (entry.name === 'config') diagnostics.push(...validatePatchingConfig(content, fileRel));
          if (entry.name === 'lang') diagnostics.push(...validateLangPatch(content, fileRel));
        }
        // 数据补丁:按原版数据校验字段名、类型与匹配键(类型名取自文件名)
        if (parsed && (entry.name === 'features' || entry.name === 'objects')) {
          if (schema) {
            schemaUsed = true;
            diagnostics.push(
              ...(entry.name === 'features'
                ? validateFeaturesPatch(stem, content, fileRel, schema)
                : validateObjectsPatch(stem, content, fileRel, schema)),
            );
          } else if (options.schema !== false && !schemaMissingReported) {
            schemaMissingReported = true;
            diagnostics.push(diag('info', 'SCHEMA_UNAVAILABLE', '找不到随包发布的游戏数据 schema,已跳过补丁字段校验'));
          }
        }
      }
    }
  }

  // 4. 声明的功能与实际内容是否对得上
  if (hasWorldmap && !declaredFeatures.includes('experimental.worldMapJson')) {
    diagnostics.push(diag('warning', 'FEATURE_WORLDMAP_NOT_DECLARED', '包含 jsons/worldmap/ 内容,建议在 requiredGpNextFeatures 中声明 "experimental.worldMapJson"', 'pack.json', 'requiredGpNextFeatures'));
  }
  if (hasPlantLevels && !declaredFeatures.includes('experimental.plantLevelSystem')) {
    diagnostics.push(diag('warning', 'FEATURE_PLANTLEVEL_NOT_DECLARED', '包含 jsons/extensions/plant-levels.json,建议在 requiredGpNextFeatures 中声明 "experimental.plantLevelSystem"', 'pack.json', 'requiredGpNextFeatures'));
  }

  // 5. 空 mod 提示:除 pack.json 与封面外没有任何内容。
  //    其他目录(如框架自定义的 content/)可能是合法内容,所以只在完全为空时提示
  const otherEntries = fs
    .readdirSync(root)
    .filter((name) => name !== 'pack.json' && !/^thumbnail\.(png|ico)$/i.test(name));
  if (otherEntries.length === 0 && jsonFileCount === 0) {
    diagnostics.push(diag('warning', 'EMPTY_MOD', '除 pack.json 外没有任何内容:既没有 jsons/ 补丁,也没有 JS 脚本'));
  }

  if (schemaUsed && schema) result.schemaVersion = schema.gameVersion;
  return result;
}

/** 校验目录,或直接校验 .zip 文件(先安全解压到临时目录,校验后清理) */
export function validateTarget(target: string, options: ValidateOptions = {}): ProjectResult {
  const resolved = path.resolve(target);
  if (!isFile(resolved)) return validateProject(target, options);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpn-zip-'));
  try {
    const extracted = extractZip(resolved, temp);
    if (!extracted.ok) {
      return { dir: resolved, diagnostics: extracted.diagnostics };
    }
    const result = validateProject(temp, options);
    result.dir = resolved;
    result.diagnostics.unshift(...extracted.diagnostics);
    return result;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}
