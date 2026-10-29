import fs from 'node:fs';
import path from 'node:path';
import { validateManifest } from './manifest.js';

export type ModType = 'data' | 'js';

export interface InitOptions {
  /** 要创建的 mod 目录 */
  dir: string;
  uuid: string;
  type: ModType;
  /** 缺省取目录名 */
  name?: string;
  author?: string;
}

export class InitError extends Error {}

const DATA_PATCH = {
  objects: [
    {
      aliases: ['peashooter'],
      objclass: 'PlantProperties',
      objdata: { SunCost: 100 },
    },
  ],
};

const JS_ENTRY = `// 官方文档的所有示例都使用 export default { setup(ctx) {} } 的形式。
// 完整 API:https://pvzge.com/en/guide/mod/gp-next-api-reference.html
// 多个模块、TypeScript 或 npm 库需要先打包成单个 ES 模块再发布。
export default {
  setup(ctx) {
    ctx.ui.toast('Hello from my mod!', 'success')
  }
}
`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** 创建一个能直接通过 gpn validate 的 mod 骨架,返回创建的文件(相对路径) */
export function initProject(options: InitOptions): string[] {
  const dir = path.resolve(options.dir);
  const name = options.name?.trim() || path.basename(dir);

  const manifest: Record<string, unknown> = {
    uuid: options.uuid,
    name,
    version: '1.0.0',
    packFormatVersion: 1,
    ...(options.type === 'js' ? { apiVersion: 2, js: { entry: 'scripts/main.js' } } : {}),
    gpNextVersion: '^1.5.0',
    ...(options.type === 'js' ? { requiredGpNextFeatures: ['experimental.jsModding'] } : {}),
    ...(options.author?.trim() ? { author: options.author.trim() } : {}),
  };

  // 生成之前先用校验器检查参数,避免写出一个本身就不合法的 mod
  const problems = validateManifest(manifest, { hasScriptEntry: options.type === 'js' }).filter((d) => d.severity === 'error');
  if (problems.length > 0) {
    throw new InitError(problems.map((d) => d.message).join(';'));
  }

  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new InitError(`${dir} 已存在且不是目录`);
    if (fs.readdirSync(dir).length > 0) throw new InitError(`目录 ${dir} 不是空的,为避免覆盖已有文件已中止`);
  }

  const files: Record<string, string> = { 'pack.json': json(manifest) };
  if (options.type === 'js') files['scripts/main.js'] = JS_ENTRY;
  else files['jsons/objects/PlantProps.json'] = json(DATA_PATCH);

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return Object.keys(files);
}
