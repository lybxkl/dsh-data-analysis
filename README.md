# @local/dsh-data-analysis · 实证研究查看器

把一个研究产物目录**只读**展示成通用文件查看器。研究流程归 skill，执行归模型，插件只负责看。

```
skill（empirical-research-pipeline，可选）──写文件──▶ 项目目录 output/ scripts/
                                                        │ 只读
模型 ──调用 1 个工具绑定目录──▶ data_analysis_workspace ──▶ 本插件（文件树 + 查看器 + 目录进度）
```

## 它做什么

- **一个模型工具** `data_analysis_workspace`：把当前会话绑定到一个产物目录（已有目录或新目录均可），供面板只读展示。常驻可见，不设触发门。
- **一个通用查看器**（面板主视图）：
  - 页签：图 / 表 / 文档 / 全部 / code
  - 图片直接走原图 + CSS 缩放；PDF 用浏览器原生 iframe；CSV 渲染成表；JSON/文本用 `<pre>`；docx 下载
  - `code` 页签与「全部」页签共用一个递归 FileTree，脚本（.py/.R/.jl/.do/.sps/.json/.md）按等宽文本展示（无语法高亮、从不执行）
  - lightbox：图可 ←/→ 翻页、Esc 关闭
  - 面板可见时每 4s 轮询树与状态；`document.hidden` 暂停，回到前台立即刷新；「刷新」按钮保留
- **目录式被动进度**：枚举 `output/` 的一级子目录，显示「N 个文件 · 最近 X 分钟前」；点击过滤查看器。纯目录事实，不推断阶段语义。
- **工作区左栏**：工作区列表（名 + 路径 + 文件数）、点击切换、绑定本会话、移除登记（只删台账，不删目录）。
- **跟随对话**：面板向宿主取当前会话 id，经 `GET /api/session/project?sessionId=` 自动选中该会话绑定的工作区。

## 它不做什么（硬约束）

1. 不注入系统提示、不生成任务卡、不用工具描述指挥研究步骤。
2. 不运行任何脚本、不起子进程（没有 Python，也不做缩略图/PDF 渲染）。
3. 不往绑定目录写任何文件（工作区登记只写插件台账）。
4. 不做闸门三态、环境拦截、准入/触发门、人工裁定、重跑链；也不做语义解释（漏斗、pass/fail 徽章、系数摘要、QA 判定表）。skill 写的报告（`qa_report.json`、`coef.csv`、`number_issues.csv`…）就是普通文件，由通用查看器原样渲染。
5. 不读 `workflow.json`、不配 `skillRoot`、不依赖 skill 安装。仅假设两个目录名：`output/`（产物）与 `scripts/`（代码）。

## 绑定目录

在对话里让模型调用（唯一工具）：

```json
{ "dir": "F:\\research\\proj1", "name": "我的研究" }
```

或在面板点「绑定目录」。目录可以是 skill 已经产出文件的已有目录，也可以是新目录；插件不创建、不修改它。同一会话重复绑定同一目录是幂等的；换目录视为明确改绑；子代理不能创建/改绑。

不传 `name` 时默认名为「目录名（YYYY-MM-DD）」（本地日期作版本戳）；显式 `name` 原样使用。工具描述建议：本工具可用（即 dsh 已装本插件）时尽早绑定产物目录，用户即可在面板实时看到研究产出。

## 面板数据接口（只读 + 工作区登记）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/data-analysis/api/health` | GET | 存活探针 |
| `/data-analysis/api/state` | GET | 工作区快照（列表 + 当前 + 目录进度 + 文件树） |
| `/data-analysis/api/artifacts/tree` | GET | 文件树（`output/` 深度 3 + `scripts/` 深度 2） |
| `/data-analysis/api/artifacts/file` | GET | 读文件（CSV/JSON/文本/元信息） |
| `/data-analysis/api/artifacts/raw` | GET | 原始字节（图片/PDF/docx，按白名单） |
| `/data-analysis/api/workspace` | POST | 创建/绑定/选择工作区（与工具同一实现） |
| `/data-analysis/api/workspace/list` | GET | 工作区列表 |
| `/data-analysis/api/workspace/forget` | POST | 移除登记（不删目录） |
| `/data-analysis/api/session/project` | GET | 当前会话绑定的工作区 |
| `/data-analysis/api/config` | GET/POST | 仅 `dataDir` |

## 路径安全（四道防护）

`artifactResolve` 全部保留并有测试钉死：

1. 词法越界（`..` / 绝对路径）拒绝；
2. realpath 越界（junction/符号链接逃逸）拒绝；
3. 扩展名白名单（图片/PDF/docx/CSV/JSON/文本/HTML/脚本源码；脚本只按文本读取，插件从不执行）；
4. 单文件 32MB 上限。

HTML 一律按下载处理，不给同源脚本能力；只允许 loopback Host + 同源 Origin。

## 配置

只有一个配置项：

```yaml
- insert:
    - id: data-analysis
      name: '@local/dsh-data-analysis'
      config:
        dataDir: ''   # 留空 = <profile>/data-analysis；只影响插件台账位置
```

## 开发与测试

```bash
npm test                 # 全部（含无头 Chrome 视觉回归）
npm run test:artifacts   # 双根树 / 读文件 / 目录进度 / 路径四道防护 / 红线静态守卫 / 只读路由
npm run test:paths       # 路径边界回归（含 junction 逃逸）
npm run test:readcache   # 一次快照内的读盘去重
npm run test:binding     # 会话识别、幂等/改绑、子代理守卫、零 skill 耦合
npm run test:tool-output # 只有 1 个工具，jsonSafe + 模型可见文本
npm run test:client      # 面板骨架/页签/code/lightbox/轮询/跟随会话
npm run test:visual      # 宽/紧凑/窄/暗色布局与溢出
```

视觉回归需要本机 Chrome；找不到会报错退出，不静默跳过。截图与 HTML 在 `tests/out/`。