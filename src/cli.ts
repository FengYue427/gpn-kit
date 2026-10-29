#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { countDiagnostics, formatResult } from './format.js';
import { InitError, initProject, type ModType } from './init.js';
import { packProject } from './pack.js';
import { validateTarget, type ValidateOptions } from './project.js';
import { loadSchemaFile, SchemaError } from './schema.js';

const HELP = `gpn - PvZ2 Gardendless (GP-Next) mod 作者工具

用法:
  gpn init <目录> [--uuid <id>] [--type data|js] [--name <名称>] [--author <作者>]
      创建一个能直接通过校验的 mod 骨架
  gpn validate [目录或.zip] [--json] [--strict]
      校验 mod 目录或 ZIP 文件
  gpn pack [目录] [-o <输出.zip>] [--strict] [--force]
      校验通过后打包成 ZIP(pack.json 位于 ZIP 根部)

validate / pack 的补丁字段校验选项:
  --schema <文件>  使用指定的 schema(游戏更新后可用 scripts/build-schema.mjs 自行生成)
  --no-schema      不校验补丁字段

通用选项:
  -h, --help     显示帮助
  -v, --version  显示版本

退出码: 0 成功,1 校验未通过或操作失败,2 用法错误`;

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

class UsageError extends Error {}

/** 补丁字段校验的数据来源:缺省用随包发布的 schema,--schema 指定文件,--no-schema 关闭 */
function schemaOptions(values: { schema?: string; 'no-schema'?: boolean }): ValidateOptions {
  if (values.schema !== undefined && values['no-schema']) {
    throw new UsageError('--schema 与 --no-schema 不能同时使用');
  }
  if (values['no-schema']) return { schema: false };
  if (values.schema !== undefined) return { schema: loadSchemaFile(values.schema) };
  return {};
}

function runValidate(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      strict: { type: 'boolean' },
      schema: { type: 'string' },
      'no-schema': { type: 'boolean' },
    },
  });
  if (positionals.length > 1) throw new UsageError('validate 只接受一个目录或 .zip 文件');

  const result = validateTarget(positionals[0] ?? '.', schemaOptions(values));
  const counts = countDiagnostics(result.diagnostics);
  if (values.json) console.log(JSON.stringify({ ...result, counts }, null, 2));
  else console.log(formatResult(result, { color: useColor(), strict: values.strict }));
  return counts.error > 0 || (values.strict === true && counts.warning > 0) ? 1 : 0;
}

function runPack(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      strict: { type: 'boolean' },
      force: { type: 'boolean' },
      schema: { type: 'string' },
      'no-schema': { type: 'boolean' },
    },
  });
  if (positionals.length > 1) throw new UsageError('pack 只接受一个 mod 目录');

  const result = packProject(positionals[0] ?? '.', {
    out: values.out,
    strict: values.strict,
    force: values.force,
    ...schemaOptions(values),
  });
  console.log(formatResult(result.validation, { color: useColor(), strict: values.strict }));
  console.log('');

  if (!result.packed) {
    console.error(`未打包:${result.reason}`);
    return 1;
  }
  const kb = ((result.bytes ?? 0) / 1024).toFixed(1);
  console.log(`已生成 ${result.outFile}`);
  console.log(`${result.fileCount} 个文件,${kb} KB`);
  if (result.skipped && result.skipped.length > 0) {
    console.log(`已排除:${result.skipped.join(', ')}`);
  }
  if (values.force && countDiagnostics(result.validation.diagnostics).error > 0) {
    console.log('注意:使用了 --force,这个 ZIP 含有校验错误,游戏可能无法加载。');
  }
  return 0;
}

async function runInit(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      uuid: { type: 'string' },
      type: { type: 'string' },
      name: { type: 'string' },
      author: { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new UsageError('init 需要且只需要一个目标目录,例如:gpn init my-mod --uuid yourname.my-mod');
  const dir = positionals[0]!;

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let uuid = values.uuid;
  if (uuid === undefined) {
    if (!interactive) throw new UsageError('缺少 --uuid。uuid 是 mod 的唯一标识,发布后不能再改,请自己指定,例如 yourname.my-mod');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      uuid = (await rl.question('mod 的 uuid(唯一标识,发布后不可更改,例如 yourname.my-mod):')).trim();
    } finally {
      rl.close();
    }
  }

  const type = values.type ?? 'data';
  if (type !== 'data' && type !== 'js') throw new UsageError(`--type 只能是 data 或 js,当前为 "${type}"`);

  try {
    const files = initProject({ dir, uuid, type: type as ModType, name: values.name, author: values.author });
    console.log(`已创建 ${path.resolve(dir)}`);
    for (const file of files) console.log(`  ${file}`);
    console.log('');
    console.log('下一步:');
    console.log(`  1. 编辑 ${type === 'js' ? 'scripts/main.js' : 'jsons/objects/PlantProps.json'}`);
    console.log(`  2. gpn validate ${dir}`);
    console.log(`  3. gpn pack ${dir}`);
    return 0;
  } catch (e) {
    if (e instanceof InitError) {
      console.error(`创建失败:${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    console.log(version());
    return 0;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    console.log(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'validate':
        return runValidate(rest);
      case 'pack':
        return runPack(rest);
      case 'init':
        return await runInit(rest);
      default:
        throw new UsageError(`未知命令 "${command}"`);
    }
  } catch (e) {
    // parseArgs 对未知选项等抛出 TypeError(code 以 ERR_PARSE_ARGS 开头)
    const code = (e as { code?: string }).code;
    if (e instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      console.error(`${(e as Error).message}\n\n${HELP}`);
      return 2;
    }
    if (e instanceof SchemaError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

process.exitCode = await main(process.argv.slice(2));
