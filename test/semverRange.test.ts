import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkVersionRange } from '../src/semverRange.js';

describe('checkVersionRange', () => {
  // 以下合法写法均取自官方文档的表格与示例
  const valid = [
    '^1.5.0',
    '~1.5.0',
    '>=1.5.0 <2.0.0',
    '1.5.x',
    '^1.5.0 || ^2.0.0',
    '>=1.5.0, <2.0.0, !=1.5.2',
    '>=1.5.0, <2.0.0,!=1.5.2',
    '==1.5.0',
    '==1.5',
    '~=1.5.0',
    '~=1.5',
    '~1.5',
    '1.5',
    '^1.5.0-pre.1',
    '*',
    '1.2.3 - 2.0.0',
    '>= 1.5.0',
  ];
  for (const expr of valid) {
    it(`接受 ${JSON.stringify(expr)}`, () => {
      assert.deepEqual(checkVersionRange(expr), { ok: true });
    });
  }

  const invalid: Array<[string, RegExp]> = [
    ['', /为空/],
    ['   ', /为空/],
    ['===1.5.0', /===/],
    ['1.5.0.dev1', /\.dev/],
    ['1.5.0.post2', /\.post/],
    ['1!2.0.0', /epoch/],
    ['^^1.5', /无法识别/],
    ['latest', /无法识别/],
    ['>=', /无法识别|空/],
    ['abc', /无法识别/],
    ['^1.5.0 ||', /空的 \|\|/],
    ['1.2.3 - banana', /连字符/],
  ];
  for (const [expr, reason] of invalid) {
    it(`拒绝 ${JSON.stringify(expr)}`, () => {
      const result = checkVersionRange(expr);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, reason);
    });
  }
});
