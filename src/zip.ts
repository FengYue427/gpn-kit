/**
 * ZIP 打包与安全解压。
 *
 * 官方要求:ZIP 的根部必须是 pack.json,并保留目录结构
 * (https://pvzge.com/en/guide/mod/gp-next-js.md、gp-next-datapack)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { Diagnostic } from './types.js';

/** 打包时排除的目录名(版本控制、编辑器配置、依赖目录) */
const EXCLUDED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.vscode', '.idea']);
/** 打包时排除的文件名(系统垃圾文件) */
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** 固定时间戳,让相同内容打出字节完全一致的 ZIP */
const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);

/** 解压限制:防止 ZIP 炸弹 */
const MAX_ENTRIES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface PackFiles {
  /** 相对 mod 根目录、使用 / 分隔、已排序 */
  files: string[];
  /** 被排除的路径(同样是相对路径),用于向用户说明 */
  skipped: string[];
}

export function collectPackFiles(root: string, excludeAbsolute?: string): PackFiles {
  const files: string[] = [];
  const skipped: string[] = [];
  const exclude = excludeAbsolute ? path.resolve(excludeAbsolute) : undefined;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) skipped.push(`${rel}/`);
        else walk(full);
      } else if (entry.isFile()) {
        const isOutput = exclude !== undefined && path.resolve(full) === exclude;
        if (EXCLUDED_FILES.has(entry.name) || entry.name.toLowerCase().endsWith('.zip') || isOutput) skipped.push(rel);
        else files.push(rel);
      }
      // 符号链接等其他类型直接忽略
    }
  };
  walk(root);
  return { files: files.sort(), skipped: skipped.sort() };
}

export function createZip(root: string, files: string[]): Uint8Array {
  const entries: Zippable = {};
  // 显式写入目录条目,与资源管理器、7-Zip 等常见工具生成的 ZIP 一致
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  for (const dir of [...dirs].sort()) entries[dir] = [new Uint8Array(0), { mtime: FIXED_MTIME }];
  for (const file of files) {
    entries[file] = [new Uint8Array(fs.readFileSync(path.join(root, file))), { mtime: FIXED_MTIME, level: 6 }];
  }
  return zipSync(entries);
}

/** 列出 ZIP 中的条目名(原样,不做规范化);ZIP 损坏时抛出异常 */
export function listZipEntries(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

export interface ExtractResult {
  diagnostics: Diagnostic[];
  ok: boolean;
}

/**
 * 把 ZIP 解压到 destDir。
 * - 路径里的反斜杠按分隔符处理,并给出警告(ZIP 规范要求 /,个别旧版 Windows 压缩工具会写反斜杠)
 * - 含 .. 或绝对路径的条目被拒绝(zip-slip),不会写到 destDir 之外
 */
export function extractZip(zipPath: string, destDir: string): ExtractResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string): ExtractResult => {
    diagnostics.push({ severity: 'error', code, message });
    return { diagnostics, ok: false };
  };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(zipPath));
  } catch (e) {
    return fail('ZIP_UNREADABLE', `无法读取文件:${(e as Error).message}`);
  }

  let count = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        count++;
        total += file.originalSize;
        if (count > MAX_ENTRIES) throw new Error(`条目数超过上限 ${MAX_ENTRIES}`);
        if (total > MAX_TOTAL_BYTES) throw new Error(`解压后总大小超过上限 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
        return true;
      },
    });
  } catch (e) {
    return fail('ZIP_INVALID', `不是有效的 ZIP 文件,或超出安全限制:${(e as Error).message}`);
  }

  const root = path.resolve(destDir);
  let backslashCount = 0;
  let unsafeCount = 0;

  for (const [rawName, data] of Object.entries(files)) {
    if (rawName.includes('\\')) backslashCount++;
    const name = rawName.replace(/\\/g, '/');
    const segments = name.split('/').filter((s) => s !== '' && s !== '.');
    const isAbsolute = name.startsWith('/') || /^[A-Za-z]:/.test(name);
    if (isAbsolute || segments.includes('..')) {
      unsafeCount++;
      diagnostics.push({ severity: 'error', code: 'ZIP_UNSAFE_PATH', message: `条目 "${rawName}" 的路径含有 .. 或绝对路径,已拒绝解压` });
      continue;
    }
    if (segments.length === 0) continue;

    const target = path.join(root, ...segments);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      unsafeCount++;
      diagnostics.push({ severity: 'error', code: 'ZIP_UNSAFE_PATH', message: `条目 "${rawName}" 会解压到目标目录之外,已拒绝` });
      continue;
    }
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }

  if (backslashCount > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'ZIP_BACKSLASH_PATHS',
      message: `${backslashCount} 个条目的路径使用了反斜杠。ZIP 规范要求使用 /,个别旧版 Windows 压缩工具会写成反斜杠;建议用 gpn pack 重新打包`,
    });
  }
  return { diagnostics, ok: unsafeCount === 0 };
}
