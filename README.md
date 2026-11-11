# 实证研究工作台（dsh-data-analysis）

把 `empirical-research-pipeline` 技能包变成**可点、可看、可拦住**的数据分析流水线：9 个阶段、子进程运行、产物只读解析、闸门三态判定。最后一阶段「复核与修订」把「让模型再看一遍」拆成机器复算 + 模型提案 + 人裁定 + 自动重跑。

它不是第二套研究方法，而是技能的**操作台**——脚本还是技能里那些 Python 脚本，工作台负责登记、运行、展示与拦截。

## 它解决什么

- **跑没跑**：每次运行都是一个 `run-*` 记录，命令、退出码、信号、日志尾部全部落盘。
  终检是两步（`qa_outputs.py` + `verify_numbers.py`），日志合并进同一次运行，任何一步非零就停。
- **产物在哪**：只读解析 `sample_flow.csv`、`chart_manifest.csv`、`coef_*.csv`/`fit*.csv`、`number_issues.csv`、`qa_report.json`，面板直接给结构。
- **能不能交付**：每条闸门只有三种状态——`✓ 通过`、`✗ 未过`、`? 判不了`。
  **判不了不等于通过**：PNG 没有文字层，字号就是未核；没声明调色板，配色就是未核。
- **别被旧结论骗**：人工裁定早于该阶段最近一次运行结束时，裁定自动失效、退回待裁定。

## 安装

```powershell
# 用 DSH 的插件管理装本地包（绝对路径）
# plugin_manager: action=install_bundle, target=F:\deepseek-data-analysis\dsh-data-analysis
#   已装过则 set_plugin false → true 重载（target 用 entryId：include:data-analysis）
```

装好后刷新页面，侧栏出现「实证研究工作台」图标。

## 配置

`cordis.patch.yml` 或面板「设置」：

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `skillRoot` | 技能仓库根或其中的 `empirical-research-pipeline` 包目录；**只读**。配了但无效会直接报错，不再偷偷回退 | `F:\测试文件\SPSS-Style-Charting-Skill` |
| `dataDir` | 台账目录（`data-analysis.json` 所在）；空 = 按 profile 自动选 | 空 |
| `pythonPath` | Python 可执行文件 | `python` |
| `maxRuns` | 台账保留的运行记录数 | `60` |
| `maxLogLines` | 面板保留的日志行数 | `800` |
| `modelMode` | `follow` = 跟随 DSH 默认模型；`custom` = 用下面两项 | `follow` |
| `modelProvider` / `modelId` | 自定义起草模型（来自宿主已注册的 provider 与其模型列表） | 空 |
| `assistantMaxTokens` | 单次起草的最大输出 token | `1800` |

## 启动自检（环境是否就位）

插件启动时会在后台验一遍，结果同时出现在面板顶部（未通过时）、设置弹窗与 `data_analysis_doctor`：

| 检查 | 判据 | 失败会怎样 |
| --- | --- | --- |
| 技能包 | `skillRoot` 能解析到 `SKILL.md` + `scripts/` | 所有阶段都没脚本可跑 |
| 阶段脚本 | 8 个阶段登记的脚本（含 `steps`）都在 | 对应阶段运行即报「脚本不存在」 |
| Python | 能执行 `pythonPath -c ...`，版本 ≥ 3.9 | 所有脚本阶段都跑不起来 |
| 依赖 | `pandas`、`numpy`、`scipy`、`statsmodels`、`matplotlib`、`fitz`(PyMuPDF)、`docx`(python-docx)、`openpyxl`、`PIL`(Pillow) 可导入 | 审计/统计/图表/终检按缺的包失败 |
| Word→PDF | `pywin32` 可导入（另需本机 Word） | **warn**，只影响 Word 转 PDF，其它阶段不受影响 |

自检只读探测：**不安装任何东西、不修改技能包**；缺包时给出 `pip install ...` 建议，由用户决定。改过 `skillRoot` / `pythonPath` 会立即作废旧结论并重查；结果缓存 5 分钟，面板上可点「重新检查」。

## 9 个阶段

| # | 阶段 | 脚本 | 关键产物 |
| --- | --- | --- | --- |
| 1 | 范围与口径 | 人工 | `docs/scope.md` |
| 2 | 资料审计 | `audit_corpus.py` | `output/audit/sample_flow.csv`、`corpus_summary.json` |
| 3 | 编码与抽取 | `make_coding_sheet.py` | `output/coding/coding_sheet.csv` |
| 4 | 数据集 | 人工 | `output/dataset/analysis.csv` |
| 5 | 统计分析 | `auto_stats.py` | `output/models/coef_*.csv`、`fit*.csv` |
| 6 | 出版级图表 | `auto_chart_pack.py` | `output/chart_pack/chart_manifest.csv` |
| 7 | 文稿组装 | `assemble_manuscript.py` | `output/manuscript.docx` |
| 8 | 终检 | `qa_outputs.py` → `verify_numbers.py` | `output/qa/qa_report.json`、`output/verify/number_issues.csv` |
| 9 | 复核与修订 | 机器复算 + 模型审计（无脚本） | `output/recheck/issues.jsonl`、`coverage.json`、`report.md` |

登记表是数据：项目里的 `project.json` 可以覆盖每阶段的 `script` / `args` / `steps`，现场写的新脚本放 `scripts/` 并登记即可。

**两步以上的阶段用 `steps`**，与 `args` 二选一：

```json
{ "qa": { "steps": [
  { "script": "scripts/qa_outputs.py", "args": ["--out", "output/qa/qa_report.json", "--exit-zero"], "continueOnError": true },
  { "script": "scripts/verify_numbers.py", "args": ["--out", "output/verify"] }
] } }
```

## 面板怎么读

- **全局下一步**：面板顶部的横幅永远回答「现在该干嘛」——下一个未完成阶段、卡在哪条闸门、
  以及动作按钮（`去查看` / `去拍板` / `让 AI 接手`）。它看的是整条流水线，不受当前选中阶段影响；
  你正站在该阶段时，真正的执行按钮在阶段标题右侧，横幅只负责导航。
- **四个状态词**：`已完成` / `被拦住` / `等你拍板` / `还没查`（外加过程态 `运行中`）。
  闸门只有四种符号：`✓ 通过`、`✗ 未通过`、`○ 还没查`（含判不了、缺证据）、`! 等你拍板`。
  「未核 / 判不了 / 缺失」一律归入「还没查」，不再另造词表；灰色不是绿色。
- **判读带**：阶段标题下方先给结论（`x 项待处理 · 已通过 y 项`），未过的闸门排在前面，
  已通过项折叠成一行；命令、日志、覆盖表都收在「技术细节」里，默认不占版面。
- **单一主行动**：每屏只有一个实心主按钮。有脚本时是「运行/重跑」，需要人拍板时是「去拍板」，
  没有脚本时是「AI 接手」；其余动作都在次级菜单里。`AI 接手 ▾` 统一提供三件事：
  写一份草稿（不跑脚本，落 `docs/`）、在对话里做这一步（会改文件）、复核（第 9 阶段）。
- **产物按阶段归属**：选中审计只看审计链，选中图表只看图表清单，选中终检只看数字溯源与终检报告，
  不会再把全项目的图表/模型堆到每个阶段。没有产物的阶段不渲染空的「产物」段。
- **运行台**：点顶栏「运行台」打开抽屉；列表给出状态、开始时间、阶段简称、退出码；选中一条后
  上方显示命令与耗时，运行中日志自动滚到底。`运行本阶段` 只负责启动，**退出码 0 不等于阶段完成**，
  完成与否以下面的闸门为准。
- **人工裁定**：只有标了「人工」的闸门有「现在拍板」按钮；弹窗先摆证据（闸门结论、来源、阶段、
  最近一次运行），再让你写理由并选「确认通过 / 打回重做」。阶段重跑后旧裁定自动失效
  （详情里会写明两次时间），需要对新产物重新确认。未开工阶段不出现拍板按钮。
- **复核页**：`AI 接手 → 复核` 把 12 项复算、已有问题与脚本清单投递到研究对话；`套用补丁` 会先弹确认
  （目标文件、基线哈希、内容前 24 行），覆盖前自动备份到 `output/recheck/diffs`。
- **窄屏**：面板宽度 ≤1240 时右栏收成抽屉（顶栏「运行台」打开）；≤860 时左栏也收起，改用顶栏的
  阶段下拉切换。

## 阶段参数的两条现实约束

- **统计**：`auto_stats.py` 默认找不到因变量会直接 exit 2（`no outcome column found; pass config.outcome`），
  项目里要先写 `config` / `spec` 指定 outcome 与模型，工作台只负责把命令跑起来。
- **文稿**：`assemble_manuscript.py` 需要项目根的 `manuscript.json`，没有会报 `spec not found`；
  所以文稿阶段不是「点了就出 docx」，缺 spec 时失败是正确行为。

## 闸门的关键判定（来自源码，不来自文档叙述）

- **有效 dpi** = `px_width ÷ 5.9055`，门槛 `597`（600×0.995）。manifest 的 `dpi` 列是 PNG 标称值，不当有效 dpi 用。
- **字号**：`note` 里的 `min_fontsize` < `7.2pt` 判 fail；没有这个字段就是**未核**（PNG-only 判不了）。
  `auto_chart_pack.py` 不写 `min_fontsize`，只有 `paper_figures.py` 写——所以 chart_pack 出来的图字号必然是未核。
- **配色**：manifest 的 `palette` 是 8 个 hex（`|` 分隔）；算两两 CIE L* 差，最小 < 10 判 fail（灰度打印会糊成一条线）。
  未声明或单色 = 未核；色相与 CVD 可分性仍需人看图。
- **模型 N**：以 `fit.csv` 的 `n` 为准。`n_dropna` 是**被剔除行数**，V-05 拿它当 N 判定会产生假 error，因此 V-05 单列「待复核」，不并入 error 计数。
- **漏斗对账**：不看 stage 名字，**逐条比对文件集合**——编码表的 `rel_path` 必须与审计 `status=valid` 的集合一致；
  编码出审计外的文件判 **fail**（两次 `--root` 不是同一份语料），编码是审计的真子集时要求每一份都有 `skipped_documents.csv` 留痕，
  否则「判不了」。改漏斗标签不再能让闸门变绿。
- **审计新鲜度**：`corpus_summary.json` 的 fingerprint（文件数/字节数）与当前 `data/` 比对；不一致就是审计过期（error 级 fail，审计阶段被拦住），
  先重跑审计再往下走。**分析宽表放 `output/dataset/analysis.csv`**——`data/` 是语料根，宽表放进去会被下一次审计当成一份资料。
- **产物来源**：有登记脚本的阶段，如果产物没有对应的运行记录、或比最近一次运行还新，标「判不了：工作台外生成」，
  `done` 不再被误读成「工作台跑过」。
- **in_analysis**：`auto_stats` 不会自动遵守它；宽表里同时有 0/1 时提示必须确认 `filter_query` 引用了该列。
  还没有 `model_spec.json` / `chart_config.json` 时，这条闸门是**可拍板**的：人可以在面板选「保留全部行（后续统计/图表写
  `filter_query: in_analysis == 1`）」或「打回先补配置」；拍板后统计阶段仍要真写这条过滤。
- **数字溯源**：`number_issues.csv` 的 severity 直接映射 error/warning/info；`qa_report.json` 的 `error_count > 0` 会让终检报告闸门直接 fail。
- **人工裁定**：只有标 `manual` 的闸门能裁定；裁定「不通过」是 **error 级拦截**（人说不通过就不放过），不是提醒。
  阶段之后再跑过一次，旧裁定**自动失效**（退回待裁定并写明两次时间），必须对当前产物重新确认。
- **取消**：取消是用户动作，运行记录记 `cancelled` 且退出码留空；不要把 Windows 上 taskkill 的 1 当成失败证据。
- **未开工 ≠ 未过**：还没产物、没运行、也没裁定的阶段是「未开始」，不计入「未过」总数，也不画成 ✗。
- **多步阶段**：终检是 `qa_outputs.py → verify_numbers.py` 两步；面板显示两步脚本名，参数在任务卡与运行日志里。

## 模型工具（14 个）

`data_analysis_status`（状态与闸门）、`doctor`（环境自检）、`list_stages`、`figures`、`create_project`、`open_project`、
`run_stage`、`run_log`、`cancel_stage`、`adjudicate`、`configure`、`draft`（起草文本）、`recheck`（复核）、`issue`（写问题）。
状态类工具只回摘要与闸门，不回整份产物快照（避免一次读进 60 张图的全部列）。

## 第 9 阶段：复核与修订（完整闭环）

「让模型再看一遍」不可验证；这里把它拆成四层，缺一层就不算复核：

1. **L1 机器复算（12 项，`src/recheck.js`）**：R1 数据血缘闭合、R2 `in_analysis` 真的生效、R3 模型 N 对得上、
   R4 图是当前数据画的（`data_hash` + 时间先后）、R5 图注 N 与样本一致、R6 图注带 N、R7 数字溯源、
   R8 项目脚本可解释（dropna / 静默 except / 追加写）、R9 终检报告无 error、R10 文稿图表数、
   R11 产物是最新运行写的、R12 覆盖表完整。
2. **L2 交叉核对**：图注 N、正文数字（复用 `verify_numbers`）、docx 图表数与 `manuscript.json`。
3. **L3 模型审计**：`data_analysis_recheck`（status → evidence）给出受控证据包；模型用 `data_analysis_issue`
   逐条写 `output/recheck/issues.jsonl`（`severity / where / claim / evidence / fix_kind`），
   并在 `output/recheck/coverage.json` 交 12 项覆盖表（checked / unchecked + 理由）。**模型不改产物。**
4. **L4 修复与二次验收**：问题的补丁（`patch.path` + `patch.baseHash` + `patch.content`）只是提案；
   人在面板点「套用补丁并重跑」后才会落盘（备份到 `output/recheck/diffs/`），并按下游依赖**自动重跑**
   （改 `data/`、`scripts/`、`output/coding` 就全链重跑；只改图就从 figures 起跑）。退出码非 0 但阶段闸门没有 error 级未过时，链会继续并在链状态里记一句说明（典型：`verify_numbers` 找到问题就 exit 2，但那是待裁定，不是脚本崩了）。重跑链的状态与进度
   存在台账 `recheckChains` 里，面板可取消；每一步的闸门重新判定，旧裁定按「裁定早于运行结束」自动失效。

复核阶段的四条闸门：`recheck-machine`（R1–R11 有 fail 即拦截）、`recheck-issues`（open error 即拦截）、
`recheck-coverage`（缺项 fail、unchecked 判不了）、`recheck-report`（缺报告判不了）。

## 与 DSH 的 LLM / harness 怎么接

研究流程里「写范围、写变量字典、写图注、写结果小节、解释质检问题」离不开模型，但**模型不能是裸 API**：
它需要材料，也需要一个能读文件、跑脚本的 harness。这里按三条路分工：

1. **起草（内嵌，无工具）**：`data_analysis_draft` / 面板「AI 起草」。工作台从项目产物里挑出这一步要用的
   材料（分析宽表表头、审计摘要、图表清单、模型输出、终检报告，每份都有截断上限），调宿主 `llm.stream`，
   模型选择默认**跟随 DSH 当前的默认模型**（`agentDefaultModel.currentSelection()`），也可在设置里指定
   provider/model。模型看不到工具，所以它不会声称跑过脚本；返回的 Markdown 由人核对后再写入
   `docs/scope.md`、`docs/codebook.md`、`docs/figure-notes.md`、`docs/manuscript-notes.md`、`docs/qa-notes.md`。
2. **干活（原生会话，A+ 桥）**：面板阶段头的「让 AI 做这一步」会生成一张**阶段任务卡**（项目/目录、前面阶段
   状态与未过项、待裁定项、本阶段命令或人工步骤、五条硬约束、期望产出），投递到项目绑定的 DSH 会话并切到
   原生对话。工作台**不重画聊天**——会话、消息流、附件、工具卡都由宿主承担，它只在原生对话里加四件装饰：
   - 页头「工作台」动作：回看板；
   - 每轮尾部闸门徽章：`完成 n · 待裁定 n · 未过 n`，点「打开」回看板；
   - 输入行左侧「运行下一步 · 阶段名」：有脚本就直接起这一步，没脚本就打开看板定位该阶段；
   - 12 个 `data_analysis_*` 工具的结果徽章（`tool.call.toolview`）。
   面板侧栏的「研究对话」卡显示会话状态、绑定 id、最近一轮与入口。会话与项目的绑定存在台账
   （`POST /api/project/session`），刷新/重启后仍在；`GET /api/summary` 只回摘要，供原生对话里的徽章轮询。
   投卡前会先看这一轮是否在跑（在跑就提示先等或去停止）；同一阶段、同一最近运行、同一组闸门状态不会
   重复投递——产物或闸门变了才允许再投。
3. **会话里直接调工具**：prompt 小节（`skill:data-analysis`）已把「先 doctor、再 status、被拦不加 force」等
   口径交给会话里的 agent；要整步执行就走这条，不依赖面板。

## 隔离契约

工作台单向依赖技能包：

- `skillRoot` **只读**：不复制、不 vendor、不改写；项目里要加脚本就放项目自己的 `scripts/`。
- 每次运行记录 `SKILL.md` 的 `sha256`，项目里也存一份指纹；面板会提示「指纹漂移」。
- 所有脚本调用走 `child_process.spawn`，不 import 技能代码，不共享全局状态。
- 脚本路径只读得到**项目根**与**技能包**这两处：相对路径优先（`scripts/xxx.py`）；绝对路径只有落在这两处之内才被接受，指向包外的一律拒绝，`..` 跳出这两处也拒绝。
  找不到时会区分「文件不存在」与「指向受保护范围之外」——后者会说明文件其实在，只是不准读，避免把排查引向错误方向。

## 目录

```
dsh-data-analysis/
  index.js            Host 半片：装配 store / runner / workbench / 工具 / 路由
  client.js           Client 半片：main 槽面板 + 侧栏图标（单文件、零构建）
  src/defaults.js     配置与 8 阶段登记表（含终检的两步定义）
  src/store.js        台账（JSON、原子写、可换目录）
  src/projects.js     项目骨架（只从空目录新建）
  src/skill.js        技能包解析与指纹（只读、防逃逸）
  src/audit.js        产物只读解析（CSV/JSON、三态徽章、ΔL*）
  src/gates.js        闸门判定、裁定失效、阶段状态
  src/runner.js       子进程运行（多步）、日志、取消、重启对账
  src/service.js      面板/工具共用的服务层
  src/assistant.js    LLM 桥：受控上下文 + llm.stream + 固定 docs/ 落点
  src/taskcard.js     阶段任务卡（投递到原生会话的那段文字）
  src/tools.js        data_analysis_* 模型工具
  src/routes.js       /data-analysis/api/* 面板通道
  src/prompt.js       注入系统提示的使用规则
```

## v0.1 边界

- 只支持**从空目录新建**项目，不接管已有项目（目录非空会拒绝）。
- 不内嵌聊天输入框：要对话就走 DSH 原生会话，工作台只投任务卡与装饰（附件、图片、工具卡都用宿主原生能力）。
- 不做语义判定（图型对不对、双轴、截断基线、图注四要素），这些留给模型看图或人工裁定。
- 不解析绘图代码，不重算统计量，不修复任何产物。
- 运行记录不删除；裁定只对「人工」闸门生效，机器能判的事实不允许被改成通过。


