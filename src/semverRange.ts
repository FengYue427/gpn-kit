/**
 * gpNextVersion 范围表达式的语法校验。
 *
 * 规则来源:官方文档 https://pvzge.com/en/guide/mod/gp-next-datapack.html
 * - 支持 npm SemVer 范围(^ ~ >= <= > < = x 通配、||、连字符范围)
 * - 支持 Python 风格:逗号表示 AND,以及 == != ~=
 * - 不支持:epoch(1!2.0)、.dev、.post、===
 *
 * 这里只做语法校验(游戏对非法表达式只警告、不拦截,所以这类错误很隐蔽),
 * 不做版本匹配计算。
 */

export type RangeCheck = { ok: true } | { ok: false; reason: string };

const OP = String.raw`(?:~=|>=|<=|==|!=|\^|~|>|<|=)`;
const PART = String.raw`(?:\d+|[xX*])`;
const VERSION = String.raw`v?${PART}(?:\.${PART}(?:\.${PART}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?`;

const COMPARATOR_RE = new RegExp(`^(${OP})?(${VERSION})$`);
const VERSION_RE = new RegExp(`^${VERSION}$`);
const HYPHEN_RE = /^(\S+)\s+-\s+(\S+)$/;
const OP_THEN_SPACE_RE = new RegExp(`(${OP})\\s+`, 'g');

export function checkVersionRange(expr: string): RangeCheck {
  const trimmed = expr.trim();
  if (trimmed === '') {
    return { ok: false, reason: '表达式为空' };
  }

  if (trimmed.includes('===')) {
    return { ok: false, reason: '不支持 ===(官方文档:不支持 epoch、.dev、.post 和 ===)' };
  }
  if (/\d+!\d/.test(trimmed)) {
    return { ok: false, reason: '不支持 epoch 写法(如 1!2.0)' };
  }
  if (/\.(dev|post)\d*/i.test(trimmed)) {
    return { ok: false, reason: '不支持 .dev / .post 版本后缀' };
  }

  for (const alt of trimmed.split('||')) {
    const part = alt.trim();
    if (part === '') {
      return { ok: false, reason: '存在空的 || 分支' };
    }

    const hyphen = HYPHEN_RE.exec(part);
    if (hyphen) {
      const [, from, to] = hyphen;
      if (VERSION_RE.test(from!) && VERSION_RE.test(to!)) continue;
      return { ok: false, reason: `连字符范围 "${part}" 的两端不是合法版本号` };
    }

    const tokens = part
      .replace(/,/g, ' ')
      .replace(OP_THEN_SPACE_RE, '$1')
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length === 0) {
      return { ok: false, reason: '存在空的比较条件' };
    }
    for (const token of tokens) {
      if (!COMPARATOR_RE.test(token)) {
        return { ok: false, reason: `无法识别的比较条件 "${token}"` };
      }
    }
  }

  return { ok: true };
}
