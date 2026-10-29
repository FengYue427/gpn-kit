# gpn-kit

PvZ2 Gardendless(GP-Next)mod 作者工具:**创建、校验、打包**。

GP-Next 对 mod 的很多问题只给警告、不拦截,作者往往要打包、导入、重启游戏之后才发现问题,甚至发现不了。`gpn` 把这些检查前移到本地,几十毫秒出结果,并给出"你是不是想写 X"式的修正建议。

```text
$ gpn validate examples/broken-mod

error   UUID_WHITESPACE  pack.json (uuid)
        uuid 首尾不能有空格
error   JS_ENTRY_NOT_FOUND  pack.json (js.entry)
        找不到 JS 入口文件 "scripts/missing.js"
warning PATCH_FIELD_TYPE  jsons/objects/PlantProps.json (objects[0].objdata.SunCost)
        字段 "SunCost" 在原版数据中的类型是 number,这里是 string
warning PATCH_FIELD_TYPO  jsons/objects/PlantProps.json (objects[0].objdata.Cooldwn)
        原版数据中没有字段 "Cooldwn",你是不是想写 "Cooldown"?(字段名区分大小写)
...
✖ 校验未通过:8 个错误,6 个警告,3 条提示
```

## 安装

需要 Node.js 22 或更高版本。

```powershell
git clone https://github.com/FengYue427/gpn-kit.git
cd gpn-kit
npm install
npm run build
npm link          # 之后可以在任何位置使用 gpn 命令
```

不想全局安装的话,把下面所有 `gpn` 换成 `node dist/src/cli.js` 即可。

## 使用

三条命令覆盖从创建到发布的完整流程:

```powershell
gpn init my-mod --uuid yourname.my-mod      # 1. 创建骨架(--type js 创建 JS mod)
gpn validate my-mod                          # 2. 编辑之后校验
gpn pack my-mod                              # 3. 校验通过后打包成 ZIP,导入游戏
```

### `gpn init <目录>`

创建一个能直接通过校验的骨架。`--uuid` 是 mod 的唯一标识,**发布后不能再改**,所以必须自己指定(在交互终端里缺省时会询问)。

| 选项 | 作用 |
|---|---|
| `--uuid <id>` | mod 的唯一标识,例如 `yourname.my-mod` |
| `--type data\|js` | 数据补丁 mod(缺省)或 JS mod |
| `--name <名称>` | 显示名称,缺省取目录名 |
| `--author <作者>` | 写入 `pack.json` |

不会写入非空目录,不会覆盖已有文件。

### `gpn validate [目录或 .zip]`

校验 mod 目录,或直接校验一个 ZIP(会先安全解压到临时目录,结束后清理)。

| 选项 | 作用 |
|---|---|
| `--json` | 以 JSON 输出诊断结果,便于接入 CI |
| `--strict` | 警告也视为失败 |
| `--schema <文件>` | 补丁字段校验使用指定的 schema(游戏更新后见下文) |
| `--no-schema` | 不校验补丁字段 |

### `gpn pack [目录]`

校验通过后打包。校验未通过时拒绝打包。

| 选项 | 作用 |
|---|---|
| `-o <文件>` | 输出路径,缺省为当前目录下的 `<uuid>-<version>.zip` |
| `--strict` | 警告也拒绝打包 |
| `--force` | 即使校验未通过也打包 |
| `--schema <文件>` / `--no-schema` | 同 `validate` |

生成的 ZIP:`pack.json` 在根部,路径一律使用 `/`,保留目录结构。相同内容打出的 ZIP 字节完全一致。会自动排除 `.git`、`node_modules`、`.vscode`、`.idea`、`.DS_Store`、`Thumbs.db` 和已有的 `.zip`。

### 退出码

`0` 成功;`1` 校验未通过或操作失败;`2` 用法错误。

## 在 CI 里使用

```yaml
- run: npx gpn validate . --strict
```

## 校验内容

规则来自官方文档 [Mod files and manifest](https://pvzge.com/en/guide/mod/gp-next-datapack.html)、[Merge Rules](https://pvzge.com/en/guide/mod/gp-next-merge.html)、[Language Packs](https://pvzge.com/en/guide/mod/gp-next-language.html),以及官方发布的游戏原始 JSON(当前对应游戏 0.15.0 / GP-Next 1.5.2)。

**pack.json**

- `uuid`:必填;首尾不能有空格;不能以 `legacy:` 开头;JS mod 须为 3-128 个字母、数字、点、连字符或下划线,且以字母或数字开头
- `packFormatVersion` 只能是 `1`
- JS mod 必须有 `apiVersion: 2`;`js.entry` 必须是 `.js` / `.mjs`;`js.reloadable: false` 必须搭配 `js.startup: true`
- `depends` / `optionalDepends` 必须是 mod uuid 数组(检查重复、自依赖、误写成 npm 包名或版本范围)
- `gpNextVersion` 范围语法(npm SemVer + Python 风格的逗号、`==`、`!=`、`~=`;拒绝 epoch、`.dev`、`.post`、`===`)
- `requiredGpNextFeatures` 的取值,以及声明的功能与实际内容是否对得上
- 字段名拼写(如 `gpNextVersoin`)

**目录与 ZIP**

- `pack.json` 是否在根部,以及把 mod 多套了一层目录的常见错误
- ZIP 内路径使用反斜杠(个别旧版 Windows 压缩工具会这样)
- ZIP 路径穿越(zip-slip)、条目数与解压大小上限

**JS 入口**

- 入口文件存在、位于 mod 目录内、含 `setup`
- 官方文档的所有示例都使用 `export default { setup(ctx) {} }`;具名导出 `setup` 是否可用文档没有说明,所以只给提示
- 官方要求多模块、TypeScript 或 npm 库必须先打包成单个 ES 模块;入口含静态 `import` 时给出警告

**配置文件**

- `jsons/config/patching.json(5)`:`defaultMode` 与各类型的 `mode` 只能是 `merge` / `replace`;提示关卡、语言、地图不受该配置控制
- `jsons/lang/lang.json(5)`:`_languages` 的结构与语言代码重复

**数据补丁的字段**(`jsons/features/*`、`jsons/objects/*`)

依据是官方发布的游戏原始 JSON,而不是文档表格。两者有出入:例如文档的 PlantFeatures 表列了 `TYPE`,0.15.0 的真实数据里这个字段叫 `TAGS`。

- 字段名拼写(区分大小写,`LifeSpan` 与 `Lifespan` 在原版里是两个不同字段),并给出建议
- 字段值类型与原版是否一致(例如 `"SunCost": "100"`,原版是 number)
- 条目匹配键:Features 的 `CODENAME`、`MintObtainRoute` 的 `Family`、商店 `Plants` / `Upgrade` 的 `CommodityName`、Objects 的 `aliases[0]`;匹配键拼错时给出近似的原版名称
- 区段名、`objclass`、Objects 顶层结构

补丁文件的类型取自文件名(`PlantProps.json` → `PlantProps`)。不是原版类型的文件只给提示。mod 可以合法地新增条目和字段,所以"原版没有的名字"只有在和某个原版名字高度相似(疑似拼写错误)时才算警告,否则只是提示。

### 严重级别

- `error`:文档明确要求、违反后会导致安装或加载失败的规则
- `warning`:很可能是错误,或游戏本身只警告不拦截的问题
- `info`:建议项

## 已知局限

- **没有在真实游戏里验证过。** 所有规则来自官方文档和官方发布的数据,我不知道游戏对每种"问题"的实际反应。因此"工具判定合法"不等于"游戏一定能加载"。
- 补丁字段校验只覆盖**顶层字段**,不深入嵌套对象(如 `MintBoostedProps` 内部),也不判断数值是否合理(例如负的阳光消耗)。
- 随包发布的 schema 对应游戏 0.15.0。游戏更新后,新增的字段会被当作"原版没有的字段",只给提示;可以按下文自行生成新的 schema,用 `--schema` 指定,不必等本工具更新。
- 原版数据里 `PropertySheets.json` 有 18 个条目本身没有 `aliases`,无法按 `aliases[0]` 匹配,校验器对这类补丁条目会给出警告。
- 关卡文件(`jsons/levels/`)与语言表的键(`jsons/lang/lang.json` 里的文本节点)暂未校验。
- 官方文档里标注为"不建议修改"的字段(斜体字段)暂未纳入。
- 功能 ID 白名单取自文档的"支持的 ID 包括……"一句,可能随 GP-Next 版本变化,因此未知 ID 只给警告。
- JS 入口只做文本检查,不执行脚本,也不知道 `ctx` 的 API。
- `pack.json` 按严格 JSON 解析。文档只明确说补丁文件支持 JSON5,没有说 `pack.json` 支持。

## 开发

```powershell
npm test      # 编译并运行全部测试(node:test)
```

### 重新生成字段 schema(游戏更新后)

`data/schema-<版本>.json` 由官方原始 JSON 压缩包生成,只包含字段名、值类型和条目标识,不含游戏文本或数值。

```powershell
Invoke-WebRequest https://pvzge.com/resources/game-json-0.15.0.zip -OutFile game-json.zip
Expand-Archive game-json.zip -DestinationPath game-json
node scripts/build-schema.mjs game-json
```

生成后无需改动代码,直接用 `--schema` 指定即可:

```powershell
gpn validate my-mod --schema data/schema-0.16.0.json
```

### 用原版数据做回归测试

官方压缩包体积较大且属于官方,不随本仓库发布。把 `GPN_GAME_JSON_DIR` 指向解压目录后,测试会把全部原版 JSON 当作补丁跑一遍,要求没有警告和错误(不设置则自动跳过)。这是防止规则误报的主要防线。

```powershell
$env:GPN_GAME_JSON_DIR = "game-json"; npm test
```

## 许可证

[Apache License 2.0](LICENSE),与 PvZ2 Gardendless 官网仓库使用的协议一致。

### 关于 `data/schema-*.json`

这个文件由官方发布的"游戏原始 JSON 参考压缩包"([Source Data](https://pvzge.com/en/guide/mod/gp-next-json))生成,**只包含字段名、值类型和条目标识符**(如 `CODENAME`),不包含游戏文本、数值、资源或关卡内容。官方发布该压缩包的目的就是供 mod 作者查找字段、编写补丁。

如果官方团队希望不再随本工具分发这个文件,请提 Issue,我会移除它;移除后用户仍可用 `scripts/build-schema.mjs` 自己生成,并通过 `--schema` 使用,不影响其他功能。

## 声明

本项目是社区作品,与 PvZ2 Gardendless 官方团队、EA、PopCap 均无关联。
