import fs from 'node:fs';
import path from 'node:path';
import { countDiagnostics } from './format.js';
import { validateProject, type ValidateOptions } from './project.js';
import type { ProjectResult } from './types.js';
import { collectPackFiles, createZip, listZipEntries } from './zip.js';

export interface PackOptions extends ValidateOptions {
  /** 输出 ZIP 路径;缺省为当前目录下的 <uuid>-<version>.zip */
  out?: string;
  /** 即使校验未通过也打包 */
  force?: boolean;
  /** 警告也视为校验未通过 */
  strict?: boolean;
}

export interface PackResult {
  validation: ProjectResult;
  /** 是否生成了 ZIP */
  packed: boolean;
  /** 未生成的原因 */
  reason?: string;
  outFile?: string;
  fileCount?: number;
  bytes?: number;
  skipped?: string[];
}

/** uuid / version 转成安全的文件名片段 */
function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function packProject(dir: string, options: PackOptions = {}): PackResult {
  const root = path.resolve(dir);
  const validation = validateProject(root, options);
  const counts = countDiagnostics(validation.diagnostics);
  const failed = counts.error > 0 || (options.strict === true && counts.warning > 0);

  if (failed && !options.force) {
    return { validation, packed: false, reason: '校验未通过,未打包。修复问题后重试,或使用 --force 强制打包' };
  }

  let outFile = options.out ? path.resolve(options.out) : undefined;
  if (!outFile) {
    let manifest: { uuid?: unknown; version?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return { validation, packed: false, reason: '无法读取 pack.json 来生成文件名,请用 -o 指定输出路径' };
    }
    if (typeof manifest.uuid !== 'string' || manifest.uuid.trim() === '') {
      return { validation, packed: false, reason: 'pack.json 缺少有效的 uuid,无法生成文件名,请用 -o 指定输出路径' };
    }
    const version = typeof manifest.version === 'string' ? manifest.version : '1.0.0';
    outFile = path.resolve(`${safeName(manifest.uuid.trim())}-${safeName(version)}.zip`);
  }

  const { files, skipped } = collectPackFiles(root, outFile);
  if (!files.includes('pack.json')) {
    return { validation, packed: false, reason: '目录根部没有 pack.json,无法打包' };
  }

  const bytes = createZip(root, files);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);

  // 读回验证:官方要求 pack.json 位于 ZIP 根部
  const entries = listZipEntries(new Uint8Array(fs.readFileSync(outFile)));
  if (!entries.includes('pack.json')) {
    fs.rmSync(outFile, { force: true });
    return { validation, packed: false, reason: '生成的 ZIP 读回验证失败:根部没有 pack.json(已删除该文件)' };
  }

  return { validation, packed: true, outFile, fileCount: files.length, bytes: bytes.length, skipped };
}
