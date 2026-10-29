import type { Diagnostic, ProjectResult, Severity } from './types.js';

const COLORS: Record<Severity, string> = {
  error: '\x1b[31m',
  warning: '\x1b[33m',
  info: '\x1b[36m',
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface Counts {
  error: number;
  warning: number;
  info: number;
}

export function countDiagnostics(diagnostics: Diagnostic[]): Counts {
  const counts: Counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

export function formatResult(result: ProjectResult, options: { color: boolean; strict?: boolean }): string {
  const paint = (text: string, code: string) => (options.color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [`校验目录:${result.dir}`];
  if (result.schemaVersion) lines.push(`补丁字段依据:游戏 ${result.schemaVersion} 的原版数据`);
  lines.push('');

  for (const d of result.diagnostics) {
    const location = [d.file, d.field ? `(${d.field})` : undefined].filter(Boolean).join(' ');
    lines.push(`${paint(d.severity.padEnd(7), COLORS[d.severity])} ${paint(d.code, DIM)}${location ? `  ${location}` : ''}`);
    lines.push(`        ${d.message}`);
  }
  if (result.diagnostics.length > 0) lines.push('');

  const c = countDiagnostics(result.diagnostics);
  const summary = `${c.error} 个错误,${c.warning} 个警告,${c.info} 条提示`;
  const failed = c.error > 0 || (options.strict === true && c.warning > 0);
  const reason = c.error === 0 && failed ? '(--strict:警告视为失败)' : '';
  lines.push(failed ? paint(`✖ 校验未通过${reason}:${summary}`, COLORS.error) : `✔ 校验通过:${summary}`);
  return lines.join('\n');
}
