export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** 稳定的机器可读代码,便于测试与 --json 输出 */
  code: string;
  message: string;
  /** 相对 mod 根目录的文件路径(使用 / 分隔) */
  file?: string;
  /** 清单内的字段路径,例如 js.entry */
  field?: string;
}

export interface ProjectResult {
  dir: string;
  diagnostics: Diagnostic[];
  /** 字段校验所依据的游戏数据版本;未做字段校验时为 undefined */
  schemaVersion?: string;
}
