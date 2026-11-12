# 实证研究工作台（dsh-data-analysis）

把 `empirical-research-pipeline` 技能包变成**可点、可看、可拦住**的数据分析流水线：9 个阶段、子进程运行、产物只读解析、闸门三态判定。最后一阶段「复核与修订」把「让模型再看一遍」拆成机器复算 + 模型提案 + 人裁定 + 自动重跑。

它不是第二套研究方法，而是技能的**操作台**——脚本还是技能里那些 Python 脚本，工作台负责登记、运行、展示与拦截。

依赖：[**SPSS-Style-Charting-Skill**](https://github.com/lybxkl/SPSS-Style-Charting-Skill)（`empirical-research-pipeline` 包，
提供审计/编码/统计/图表/终检的全部脚本）。装法见下文，工作台对它是只读的。

## 它解决什么

- **跑没跑**：每次运行都是一个 `run-*` 记录，命令、退出码、信号、日志尾部全部落盘。
  终检是两步（`qa_outputs.py` + `verify_numbers.py`），日志合并进同一次运行，任何一步非零就停。
- **产物在哪**：只读解析 `sample_flow.csv`、`chart_manifest.csv`、`coef_*.csv`/`fit*.csv`、`number_issues.csv`、`qa_report.json`，面板直接给结构。
- **能不能交付**：每条闸门只有三种状态——`✓ 通过`、`✗ 未过`、`? 判不了`。
  **判不了不等于通过**：PNG 没有文字层，字号就是未核；没声明调色板，配色就是未核。
- **别被旧结论骗**：人工裁定早于该阶段最近一次运行结束时，裁定自动失效、退回待裁定。

## 安装

工作台只负责「跑、看、拦」，真正干活的是技能包 [SPSS-Style-Charting-Skill](https://github.com/lybxkl/SPSS-Style-Charting-Skill)。
**两步：装插件 → 让 AI 把环境装齐。**

### 1. 装工作台（插件）

`plugin_manager`，`action=install_bundle`，`target` 填**本目录的绝对路径**。
图形界面下的等价操作是 **插件 → 添加插件 → 选本地目录**。

装好刷新页面，侧栏出现「实证研究工作台」图标。已装过的重装/重载：先 `set_plugin` 停用再启用
（`target` 用 entry id `include:data-analysis`），或直接重启 DSH。

> 改了 host 侧代码（`src/*.js`、`index.js`）要重启 DSH 才生效；只改 `client.js` 刷新页面即可。

### 2. 让 AI 把环境装好

打开面板。环境没齐时它不会让你往下做，而是先拦在「环境还没就绪」这一屏，点**「让 AI 装好环境」**：
工作台会开一个临时会话，把安装清单交给那个会话里的 Agent，它会自己去

- `git clone` 技能包并放进 `~/.agents/skills/`（或 `~/.dsh/skills/`）；
- 检查 Python：没有就装最新的 Python 3（Windows `winget install Python.Python.3.13`，macOS `brew install python`，Linux 用发行版包管理器）；
- `pip install` 那 9 个依赖；
- 装完自己跑一遍 `data_analysis_doctor`，必要时把 `pythonPath` / `skillRoot` 填进设置。

装完回到面板，它每 12 秒复查一次，环境齐了就自动放行。也可以直接在对话里说「把实证研究工作台的环境装好」。

> 面板是「拦住」不是「提示」：`skillRoot` 解析不到、Python 跑不起来、依赖缺任何一个，工作台主体都不显示，
> 只给「让 AI 装好环境 / 手动配置 / 重新检查」三个出口。Mac 上没有 Word COM 属于平台限制，判为「判不了」，不拦。

### 备选：手动装

DSH 从这些目录发现技能：`~/.agents/skills`（用户级）、`~/.dsh/skills`、`<工作区>/.dsh/skills`、`<工作区>/.agents/skills`。
技能包要能放在「`SKILL.md` 直接在这一层」的位置。

```powershell
# Windows
git clone https://github.com/lybxkl/SPSS-Style-Charting-Skill
Copy-Item -Recurse .\SPSS-Style-Charting-Skill\empirical-research-pipeline "$HOME\.agents\skills\"
pip install -r .\SPSS-Style-Charting-Skill\requirements.txt
```

```bash
# macOS / Linux
git clone https://github.com/lybxkl/SPSS-Style-Charting-Skill
mkdir -p ~/.agents/skills
cp -r SPSS-Style-Charting-Skill/empirical-research-pipeline ~/.agents/skills/
pip3 install -r SPSS-Style-Charting-Skill/requirements.txt
```

装好后 `~/.agents/skills/empirical-research-pipeline/SKILL.md` 应该存在，DSH 的技能目录里能看到它。
技能装在哪只决定 Agent 能不能自己调用它；工作台的 `skillRoot` 指向同一份包，两边可以共用一个 clone。

`skillRoot` 留空时会按顺序探测 `~/.agents/skills/empirical-research-pipeline`、`~/.dsh/skills/empirical-research-pipeline`、
`~/SPSS-Style-Charting-Skill` 等常见位置。探测不到就在设置里手填——指向**仓库根**或**其中的
`empirical-research-pipeline` 包目录**都可以，工作台自己找出包。

## 配置

`cordis.patch.yml` 或面板「设置」：

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `skillRoot` | 技能仓库根或其中的 `empirical-research-pipeline` 包目录；**只读**。留空则自动探测常见安装位置；配了但无效会直接报错，不再偷偷回退 | 空（自动探测） |
| `dataDir` | 台账目录（`data-analysis.json` 所在）；空 = 按 profile 自动选 | 空 |
| `pythonPath` | Python 可执行文件；留空/失败时依次试 `python3`、`python`、`py`（Windows 先试 `python`） | Windows `python`，其它 `python3` |
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
| Word→PDF | `pywin32` 可导入（另需本机 Word） | Windows 上 **warn**，只影响 Word 转 PDF；macOS/Linux 判「判不了」（没有 COM） |

自检只读探测：**不安装任何东西、不修改技能包**。有 fail 项时面板会被整块拦住（顶栏还在），给三个出口：
「让 AI 装好环境」（开临时会话自动装）、「手动配置」（设置弹窗自己填路径）、「重新检查」。被拦期间面板每 12 秒强制复查一次。
改过 `skillRoot` / `pythonPath` 会立即作废旧结论并重查；平时结果缓存 5 分钟，设置里可点「重新检查」。

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

## 界面

面板是三段式工作区：左边阶段、中间当前阶段、右边运行台。**面板不自己算结论**，
所有状态都来自服务端快照（闸门三态、运行记录、产物解析都在 host 侧算好）。

视觉是**卡片仪表盘**：浅灰底上浮白卡片，圆角 12px、阴影极轻，状态一律「软色底 + 文字徽章」——
不靠色点认状态（色弱、灰度打印都读得出），数字用等宽字体对齐。

打开面板时先过一道**环境闸门**：技能包 / 阶段脚本 / Python / 依赖有任何一项 fail，主体就不显示，
只留「让 AI 装好环境｜手动配置｜重新检查」和一屏检查结果——九个阶段都靠这份环境跑，缺了它点进去也是白点。

```
[研] 实证研究工作台 · <项目名>        [技能包就位 · v]  AI 接手▾  材料  设置  项目▾  刷新
────────────────────────────────────────────────────────────────────────────────────────
项目 14          ← 左栏上部：项目列表【自己滚】，多到 14 个也不挤走下面
 ▣ 环境资源犯罪裁判文书实证分析        ×   ← 悬停出现 ×：从列表移除（二次确认）
 ▣ 生态修复论文项目            （最多占左栏 46%，超了就出滚动条）
 + 新建   打开…
资料
 ▤ 材料库 · 3 条挂载 · 1 个材料源
阶段 1–9        ← 左栏下部（独立滚动）：阶段行 = 圆号 + 名称 + 状态徽章
 ① 范围与口径        完成
 ② 资料审计          待裁定
 ③ 编码与抽取        拦住
────────────────────────────────────────────────────────────────────────────────────────
 数据审计  [✓ 已完成] [02] [9 项闸门]      ← 中栏：hero 卡（标题 + 一句话 + 主按钮）
 ┌ 有效语料 ┬ 总体积 ┬ 阶段完成 ┬ 待裁定 ┬ 闸门未过 ┐  ← KPI 条：五个数一眼看完
 │   223 份 │ 34.4MB │    2/9  │   1 项 │   1 项  │
 └──────────┴────────┴─────────┴────────┴─────────┘
 闸门   4 通过 · 1 判不了
 ✓ 语料指纹与现场一致   现在 223 个文件 / 36,055,673 字节，与审计快照逐项相等。
 ✗ 逐条对账             3 份对不上（点开看证据）                    [去拍板]
────────────────────────────────────────────────────────────────────────────────────────
 run-4f21 运行中   run-4e02 ok   run-4d90 failed   ← 右栏：运行记录卡片
 $ python audit_corpus.py --root data …            ← 日志卡：固定深色终端底
 ✓ 安徽 90 份   ✓ 北京 4 份   ✓ 福建 129 份
```

五个区域：

- **顶栏（58px）**：品牌标 + 项目名 + 技能包指纹（SKILL.md 与项目记录不一致时标 ⚠）、`AI 接手▾`（起草 /
  在对话里做这一步 / 复核）、`🗂 材料`（材料库：把项目外的资料挂进来）、`⚙ 设置`（技能目录 · Python ·
  台账位置 · 模型）、`项目▾`（打开 · 新建）、刷新。材料与设置是**常驻入口**——它们是配置动作，不是项目动作，
  藏在菜单里等于让人找不到；窄屏下只留图标。
- **左栏**：分三区，从上到下是「你在哪儿干活 → 喂给它什么 → 它跑到哪」：
  - **项目**：全部已登记项目，当前那个是白卡片（带首字方块），点一下直接切；顶部显示总数，底部
    `+ 新建` / `打开…`。**列表自己滚**：项目再多也只占左栏上部（最多 46%），
    「资料 / 阶段」永远从同一处开始，不会被顶出屏幕——这里原来只显示 6 个、把剩下的藏进「还有 N 个…」，
    拿信息换空间，已经改掉。每行右侧的 `×` 是**移除**：点了要先勾一句「我明白这是移除登记」才放行，
    移除的是台账条目（连同这个项目的运行记录、人工裁定、复核链），**磁盘上的文件一个都不删**；
    目录已经不见的项目会标红并常显 `×`，因为它已经没有别的动作可做了。
  - **资料**：材料库入口，副标题 `N 条挂载 · M 个材料源`，挂载失效时整条变红。
  - **阶段 1–9**：圆号 + 名称 + 右侧状态徽章（`完成` / `拦住` / `待裁定` / `待办`）。
    还没轮到的阶段退成灰字，但不透明到看不清。
- **中栏**：hero 卡（阶段名 + 一句话目的 + 最近一次运行 + 主按钮）→ KPI 条（有效语料 / 总体积 /
  阶段完成 / 待裁定 / 闸门未过）→「下一步」条 → 闸门卡（未过的排在前面，通过的折叠成一行）→ 产物清单；
  命令收在「执行细节 · 命令」里，平时只是一行可点的说明（展开才长边框），日志与覆盖表在右栏 /
  复核区。闸门全部通过时，标题行不再复述「已通过 N 项」——同一句话只在折叠行说一次。
- **右栏（运行台）**：运行记录卡片（阶段 / 状态 / 开始时间 / 退出码）+ 选中那条的命令与日志，
  日志是固定深色的终端卡，运行中自动滚到底。**宽屏常驻**；≤1240 起收成抽屉（顶栏「运行台」打开）。
  `运行本阶段` 只负责启动——**退出码 0 不等于阶段完成**，完成与否看中间那排闸门。
- **弹窗**：设置、打开项目、新建项目、移除项目（二次确认）、AI 起草、人工裁定、材料库、复核、补丁预览。
  全部自绘，Esc 关闭，打开时焦点进弹窗、Tab 圈在里面、关掉回到原来的位置。

四种宽度各有形态：>1240 三栏（KPI 5 列）；≤1240 右栏收成抽屉、左栏 248px、KPI 3 列；
≤900 左栏也收起（改用顶栏的阶段下拉）、KPI 2 列。中栏永远只有一个实心主按钮（运行 / 去拍板 / AI 接手），
其余在次级菜单。

## 上手：从空目录到一份能交付的报告

### 1. 建项目

`项目 ▾ → 新建项目`（或工具 `data_analysis_create_project`）——**只能指向空目录**。
工作台建好 `data/ docs/ output/ scripts/ runs/` 与 `project.json`，并设为当前项目。

### 2. 把材料挂进来（不复制）

`材 → 登记材料目录`，填资料所在目录的绝对路径（例如 `F:\案例打包pdf\刑事pdf`）。
回执按四类报数：直读 / 识图 / 待转换 / 不支持（相加等于目录里的文件总数）。然后在下面挂到 `data/`：

- 挂整包：子目录留空，挂载名自己起（例如「刑事」）
- 只挂几个省：子目录填 `安徽,北京,福建`
- 旧项目里已复制过副本：点「副本换挂载」，先逐份 md5 比对，全等才删副本

### 3. 定范围，跑审计

`① 范围与口径` 是人工阶段：写清研究问题与纳入/排除标准（`docs/scope.md`）。然后跑 `② 资料审计`，
产出 `output/audit/corpus_files.csv`、`corpus_summary.json`、`sample_flow.csv`。
`audit-freshness` 与 `materials-provenance-cover` 会核对「来源账行数 = 现在 data/ 里的文件数」。

### 4. 扫描件走识图

审计表里 `status=image_only` 的行就是要识图的（没有文字层的扫描 PDF 与图片）。`材 → 识图`：
先看「待识别页数」（只数页、零调用），再小批量试跑（`pages=1-5`），满意了再放开。
识别稿落在 `data/<挂载名>__识别稿/`，每页留 `页图 sha256 / 模型 / 提示词版本`。
**逐页核对完再点「标记已核对」**——未核的稿子一旦被文稿或质检引用，`qa-vision` 只给「判不了」。

### 5. 编码 → 数据集 → 统计 → 图表 → 成稿

每步都是「运行 → 看闸门 → 该修就修」。`✗` 点开看证据；`!` 是只能人拍板的那类（例如交付清单确认），
弹窗里先摆证据再写理由；阶段重跑后旧裁定自动失效。
`doc/xls/ppt` 这类旧格式先走转码（`材 → 转码`），`Image only` 之外的 PDF 直接读文本，不用识别。

### 6. 终检与复核

`⑧ 终检` 是两步：`qa_outputs.py` 出合规报告、`verify_numbers.py` 做数字溯源，任一步非零就停。
`AI 接手 → 复核` 进入第 9 阶段：12 项机器复算 → 模型逐条提问题（severity / 证据 / 修法）→ 人裁定 →
改 `scripts/` 或 `data/` 后自动重跑下游。补丁不会直接落盘，要人点「套用」。

### 7. 让模型代笔（可选）

`AI 接手 → 写一份草稿`：用 DSH 当前默认模型起草研究范围 / 变量字典 / 图表解读 / 文稿小节 / 质检说明。
默认只回文本，`save` 才写进 `docs/`。**草稿里的每个数字都必须能溯源**，找不到出处就标未核，不许顺补。

### 用工具跑（等价于点按钮）

```
data_analysis_status
  → data_analysis_create_project
  → data_analysis_materials(action=add, path=…)
  → data_analysis_materials(action=mount, sourceId=…, entries=…, as=…)
  → data_analysis_run_stage(stageId=audit) → data_analysis_status
  → …（逐阶段）→ data_analysis_recheck(action=status)
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
- **运行台**：宽屏常驻右栏（≤1240 收成抽屉，点顶栏「运行台」打开）；列表给出状态、开始时间、阶段简称、
  退出码；选中一条后上方显示命令与耗时，运行中日志自动滚到底。`运行本阶段` 只负责启动，
  **退出码 0 不等于阶段完成**，完成与否要下面那排闸门。
- **KPI 条**：`有效语料 / 总体积 / 阶段完成 / 待裁定 / 闸门未过` 五个数。它们只做「一眼定位」，
  点进去还是以闸门为准——`闸门未过` 跳过还没开工的阶段，所以它不会因为「还没跑」而虚高。
- **人工裁定**：只有标了「人工」的闸门有「现在拍板」按钮；弹窗先摆证据（闸门结论、来源、阶段、
  最近一次运行），再让你写理由并选「确认通过 / 打回重做」。阶段重跑后旧裁定自动失效
  （详情里会写明两次时间），需要对新产物重新确认。未开工阶段不出现拍板按钮。
- **复核页**：`AI 接手 → 复核` 把 12 项复算、已有问题与脚本清单投递到研究对话；`套用补丁` 会先弹确认
  （目标文件、基线哈希、内容前 24 行），覆盖前自动备份到 `output/recheck/diffs`。
- **窄屏**：面板宽度 ≤1240 时右栏收成抽屉（顶栏「运行台」打开）；≤900 时左栏也收起，改用顶栏的
  阶段下拉切换。切项目、关弹窗都不会留下上一个项目的状态。

## 材料库：用户资料留在原地

早先只有一条路——把文件复制进项目 `data/`。复制之后材料与原件就断链了：审计表里没有绝对路径、没有源 mtime，
用户改了源目录项目也不知道。现在的做法是**挂载**：

1. `data_analysis_materials`（action=add，path=目录）把用户目录登记进**全局材料库**（台账里的 `sources[]`，与 `projects[]` 同级）。
   一个目录只登记一次，多个项目共用；摘掉挂载不会删库。
2. action=mount 把它挂到项目的 `data/<挂载名>` 下：Windows 建目录联接（junction），macOS/Linux 建
   「真实目录 + 逐文件软链」的镜像（技能用 `os.walk` 默认不跟随目录软链，只能逐文件链）。
   `--root data` 一行不用改，技能照常扫。源文件一个字节都不复制。
3. 摘掉（unmount）只删联接；联接被手删/移动用 action=repair 修；`materials-mounted`、`sources-outside` 两条闸门盯着
   「断链、指进项目内、重叠挂载」和「源目录被放进项目里」。

挂载粒度由用户决定：挂整个资料包、挂到省/案由、或只挂某一个子目录都行，不预设分类。单文件材料按「父目录 + 子目录」挂。

### 四类文件，逐类报数

登记回执会报四类，且**相加等于目录里的文件总数**：

| 类别 | 包含 | 处理 |
| --- | --- | --- |
| 直读 | 技能能抽文本的 27 种：txt/md/csv/json/xml/yaml 等文本、pdf、docx/docm、odt、pptx/pptm、xlsx/xlsm、html/htm/xhtml | 挂上就能用 |
| 识图 | png/jpg/jpeg/tif/tiff/bmp/webp/gif/heic，以及**没有文字层**的 pdf（审计判 `status=image_only`） | 多模态模型逐页转写（不搞 OCR） |
| 待转换 | doc/xls/ppt | 桌面 Office 另存为 docx/xlsx/pptx |
| 不支持 | mhtml、压缩包、音视频、其他扩展、网址 | 告诉用户怎么换格式 |

`.DS_Store`、`Thumbs.db`、`~$` 锁文件这类记为「系统文件」，来源账里单独标 `channel=junk`，不进四类统计。
（审计会把它们也算进总文件数，所以来源账必须一起记——否则行数对不上。）

### 识图（多模态，不做 OCR）

- `data_analysis_vision`（action=plan）只数页、零模型调用；先给用户看「待识别 N 份 / M 页」，再 action=run。
  `limit` 是本次最多多少页，`pages="1-20"` 可以试跑前 20 页。
- 判定口径跟技能一致：`chars < min_chars 且 pdf 里有图` 才算 `image_only`——带 logo 但有正文的 PDF 不会被误判。
- 每页记：页图 sha256、provider/model、提示词版本（`prompts/vision-v1.md`）、token、产物路径、`human_verified`。
  产物写到 `<台账目录>\sources-cache\<源 id>\derived\`，再挂成 `data/<挂载名>__识别稿/`。
- 模型不能看图时**明确报错**，不会静默降级（DSH 的 llm 层会把图片换成一行文字占位，这里专门拦这个）。
- **未核不是通过**：`human_verified=false` 的识别稿一旦被数字溯源/质检记录引用，`qa-vision` 只能是 unjudged；
  全部识别完但没核对，也是 unjudged。核对后用 action=verify 打勾。

### 待转换（桌面 Office）

`data_analysis_convert`（action=probe 先探测，action=run 真转）走 COM：Word `SaveAs2(16)`、Excel `SaveAs(51)`、
PowerPoint `SaveAs(24)`。转换前先把文件复制到系统临时目录，免得 Office 在用户的材料目录里写 `~$` 锁文件。
非 Windows 或没装 Office 时给 Mac/替代方案的指引，不假装能转。

### 旧副本迁移

早先复制进 `data/` 的副本：`data_analysis_migrate` 先逐份 md5 比对（`apply` 不传只报告），
全部对上才 `apply=true` 删副本、建联接；**只要有一份对不上就整条停下，一个文件都不删**。
整目录挂载（`entry` 为空）或副本被改过名时，用 `as=<data/ 下的目录名>` 定位要替换的那份。
迁移后必须重跑审计——`audit-freshness` 会因为文件数/字节数变化拦住。

来源账写在 `output/materials/`：`provenance.csv`（每份文件从哪来，派生稿带 `derived_from` 指回原件）、
`selection.csv`（源目录里每份文件 include/exclude 与理由）、`mounts.json`（挂载快照）。
`materials-provenance-cover` 要求 provenance 行数等于审计扫到的文件数，对不上就判「判不了」。

## Windows / macOS / Linux 的差异

| 能力 | Windows | macOS / Linux |
| --- | --- | --- |
| 挂载方式 | 目录联接（junction），`data/安徽` 就是源目录 | 镜像目录：真实目录 + 逐文件软链 + `.dsh-mount.json` 标记 |
| 源目录增删文件 | 立刻可见（就是同一个目录） | 镜像不会自动跟；点「修复」（`action=repair`）做增量补齐并清掉断链 |
| Python 命令 | 默认 `python`，可在配置里填 `python.exe` 绝对路径 | 默认 `python3`，没有 `python` 也能跑 |
| Word→PDF | COM + pywin32，`pass/warn` | `unjudged`（没有 Word COM），改用 `soffice --headless --convert-to pdf` |
| doc/xls/ppt 转码 | 桌面 Office COM 另存为 OOXML | 不支持，请在 Office/WPS 里自己另存为；Linux 可用 soffice 批量转 |
| 识图 | 支持 | 支持（PyMuPDF 渲染 + Pillow 转 PNG，逻辑一致） |

两处容易踩的坑：

- **Windows 只走 junction**：它不需要管理员权限，但**不能指向网络路径**（`\\NAS\...`）。指向网络共享会明确报错，
  这种情形先把材料包挂到本地磁盘再登记。macOS/Linux 的镜像用的是文件软链，普通用户就能建。
- **路径长度**：Windows 上深层材料目录容易超 260 字符。删除失败时错误信息会提示「路径超长」，
  可以给系统开启长路径支持，或把材料包放到更浅的目录。

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

## 模型工具（18 个）

`data_analysis_status`（状态与闸门）、`doctor`（环境自检）、`list_stages`、`figures`、`create_project`、`open_project`、
`run_stage`、`run_log`、`cancel_stage`、`adjudicate`、`configure`、`draft`（起草文本）、`recheck`（复核）、`issue`（写问题）、
`materials`（材料库：登记/挂载/摘下/修复）、`vision`（识图：计划/跑/核对）、`convert`（Legacy Office 转码）、
`migrate`（旧副本换联接）。
状态类工具只回摘要与闸门，不回整份产物快照（避免一次读进 60 张图的全部列）。

## 测试

```bash
npm test                          # 下面六套全跑，一条命令
node tests/materials.test.mjs     # 通道分类、挂载、迁移、识图全流程、来源账、移除项目（全在临时目录里造数据）
node tests/gates.test.mjs         # 闸门三态：pass / fail / unjudged 的边界，用合成项目逐条打
node tests/recheck.test.mjs       # 复核与补丁：baseHash、越界、目录联接穿透、备份命名、12 项复算口径
node tests/consistency.test.mjs   # 静态对账：文案键 / CSS 类 / 接口路径 / 工具名 / 快照字段
node tests/client-smoke.test.mjs  # 不开浏览器，用假 React 把面板渲染成树：环境闸门 / 主界面 / 八个弹窗 / 24 轮 fuzz
node tests/visual.mjs             # 视觉回归：渲成真 HTML + 真 CSS，用无头 Chrome 量尺寸与对比度
node tests/e2e-corpus.test.mjs    # 真实语料端到端（有材料包才跑；用 DSA_PROJECT / DSA_SOURCE 指定路径）
```

识图小节用假模型跑，不花 token；真实模型只在面板里手工试。
`client-smoke` 会把 `client.js` 的两个 `useState` 初值替换成测试夹具再渲染，所以它同时是个结构探针：
面板里那几行初始化被改写，测试会直接报「结构变了」，提醒同步更新。
`consistency` 是这几套里唯一「不需要 fixture」的：它只读源码，客户端调了不存在的接口、用了没定义的文案键、
写了没有样式的 class，都会当场报出来。

`visual` 是给**改版**准备的那套：它把面板渲成真 HTML、注入 `client.js` 里那份 CSS（直接从源码求值，
不复制一份），再用无头 Chrome 在 1560 / 1180 / 900 三档宽度与暗色下量东西并截图到 `tests/out/`。
断言的都是 `node --check` 和冒烟测试抓不到的东西：

- **横向溢出**：任何宽度下 `scrollWidth` 都不许超过视口，逐元素扫 `overflow-x: visible` 的越界元素
- **项目多了不顶走阶段**：14 个项目时列表必须自己出现滚动条（`scrollHeight > clientHeight`），
  且左栏项目区不得超过左栏高度的 50%，九个阶段的最底边要留在可视区内
- **形状真的落地了**：顶栏 58px、品牌标 30px 圆角、徽章是 pill（`border-radius ≥ 100px`）、
  按钮 32px/8px、卡片有圆角与阴影、日志卡是深色终端底——CSS 写了却没人用的情况会被量出来
- **对比度**：正文/提示/徽章/标题按计算样式算 WCAG 比值，低于 4.5 直接失败（背景会沿祖先链找，
  渐变底取第一个色标，避免把「透明」当黑色算出假比值）
- **状态不只靠色**：每一行阶段都必须有一段非空的状态文字
- **不叠卡中卡**：`details` 塞在 `.dsa-card` 里时不许再自带左右/下边框、圆角或阴影
  （允许留一条顶部分隔线）——折叠行不是「又一张卡片」，这是量出来的，不是看出来的
- **没有碎字**：面板里任何文本的计算字号不得小于 11px（阶段徽章、KPI 标签、路径这些原来都是 10 / 10.5px）

需要本机装了 Chrome；找不到就报错退出，不静默跳过。

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
4. **L4 修复与二次验收**：问题的补丁（`patch_path` + `patch_base_hash` + `patch_content`）只是提案；
   人在面板点「套用补丁并重跑」后才会落盘（备份到 `output/recheck/diffs/`），并按下游依赖**自动重跑**
   （改 `data/`、`scripts/`、`output/coding` 就全链重跑；只改图就从 figures 起跑）。
   重跑链**以闸门为准，不看退出码**：阶段判定为 blocked（有 error 级未过）或运行被取消就停在原地，
   退出码非 0 但闸门没有 error 级未过时（典型：`verify_numbers` 找到问题就 exit 2，那是待裁定）继续往下跑。
   套用后问题**仍留在 open**，等你复核完再手动标 fixed——补丁写坏了不能让闸门自己变绿。
   重跑链的状态与进度存在台账 `recheckChains` 里，面板可取消；每一步的闸门重新判定，旧裁定按「裁定早于运行结束」自动失效。

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
  src/service.js      面板/工具共用的服务层（含材料库、识图、转码、迁移）
  src/assistant.js    LLM 桥：受控上下文 + llm.stream + 看图（seeImage）
  src/platform.js     目录联接/镜像挂载、PowerShell 调用、自己走的递归删除
  src/sources.js      材料库、挂载表、来源账、派生路径、旧副本迁移
  src/vision.js       扫描件逐页识别、留痕、人工核对
  src/convert.js      桌面 Office 转码（doc/xls/ppt → OOXML）
  src/taskcard.js     阶段任务卡（投递到原生会话的那段文字）
  src/tools.js        data_analysis_* 模型工具
  src/routes.js       /data-analysis/api/* 面板通道
  src/prompt.js       注入系统提示的使用规则
  assets/render_pages.py  数页 / 渲染页图 / 图片转 PNG（PyMuPDF + Pillow）
  tests/              材料库回归与真实语料端到端
```

## 两个 Node 的坑（Windows）

- `fs.rmSync({recursive:true})` 对**非 ASCII 路径**（`data\安徽`）会**静默失效**：不抛错、也不删。
  所以 `platform.removeTree()` 自己走 `readdirSync + unlinkSync + rmdirSync`，别改回去。
- `fs.cpSync` 在同样的语料树上也崩过（`STATUS_STACK_BUFFER_OVERRUN`）。要整树复制就自己递归 `copyFileSync`。

## v0.1 边界

- 只支持**从空目录新建**项目，不接管已有项目（目录非空会拒绝）。
- 不内嵌聊天输入框：要对话就走 DSH 原生会话，工作台只投任务卡与装饰（附件、图片、工具卡都用宿主原生能力）。
- 不做语义判定（图型对不对、双轴、截断基线、图注四要素），这些留给模型看图或人工裁定。
- 不解析绘图代码，不重算统计量，不修复任何产物。
- 运行记录不删除；裁定只对「人工」闸门生效，机器能判的事实不允许被改成通过。


