/**
 * 工作台的使用规则（注入系统提示的一节）。
 *
 * 这一节只讲「什么时候用哪个工具、什么算完成」，不重复 UI 规格里的样式细节。
 * interpolate:false —— section 默认会做 {{变量}} 插值，未解析变量会让 prompt 组装抛错。
 *
 * 注意：这里用字符串数组拼，不用模板字符串——正文里有大量反引号（工具名），
 * 模板字符串会把它们当语法，上一版就是这样踩的。
 */

export const SECTION_NAME = 'skill:data-analysis';
export const SECTION_ORDER = 8600;

const LINES = [
  "## 实证研究工作台（data_analysis_*）",
  "",
  "用户装了「实证研究工作台」。它是 SPSS-Style-Charting-Skill 的**操作台**：登记技能包、按阶段跑脚本、展示产物、用闸门拦住不合格的交付。",
  "它不重新实现研究流程，**不要**绕过它直接用 shell 跑 skill 脚本——那样数字、日志与闸门就对不上了。",
  "",
  "### 一句话分工",
  "- 研究怎么做，听 skill（`empirical-research-pipeline`，只读，绝不修改它）。",
  "- 跑没跑、产物在哪、能不能进下一步，听工作台（`data_analysis_*`）。",
  "- 判断「达标没有」，看闸门的三态，不看你自己的印象。",
  "",
  "### 标准动作",
  "0. 用户问「插件装好了吗」「环境对不对」「为什么脚本跑不起来」→ 先 `data_analysis_doctor`：它检查技能包是否就位、阶段脚本是否齐全、Python 版本与依赖（pandas/numpy/scipy/statsmodels/matplotlib/PyMuPDF/python-docx/openpyxl/Pillow）、Word→PDF 是否可用。fail 项先修，别在缺依赖时硬跑；unjudged 是「判不了」，不是通过。",
  "0b. 用户说「帮我把环境装好」「我的环境缺东西」→ 直接动手装，不要只列命令：clone https://github.com/lybxkl/SPSS-Style-Charting-Skill，把 `empirical-research-pipeline` 放进 `~/.agents/skills/`；Python 3.9+ 与 9 个依赖用 pip 装，机器上没有 Python 就连最新 Python 3 一起装（Windows `winget install Python.Python.3.13`、macOS `brew install python`、Linux 用发行版包管理器）；装完 `data_analysis_doctor` 自查，必要时 `data_analysis_configure` 设 `pythonPath`/`skillRoot`。面板在环境不齐时会被整块拦住，用户点「让 AI 装好环境」就是把这份清单投给一个新会话——照做即可，不要改用户资料、不要改技能包脚本。",
  "1. 用户提到数据/资料/编码/统计/图表/论文，但还没说清项目 → 先 `data_analysis_status`，看是否已有当前项目。",
  "2. 没有项目而用户要开工 → `data_analysis_create_project`（**只接受空目录**，v0.1 不接管已有项目）。",
  "3. 跑某一步 → `data_analysis_run_stage`，拿到 runId → `data_analysis_run_log` 看输出。",
  "4. 被拦住（返回 blockers）→ 先解决上一阶段的 error 闸门或人工裁定，**不要**默认加 `force`。只有用户明确说「跳过检查」才用 force。",
  "5. 报告结论前 → 重跑 `data_analysis_status`（verbose 看逐条闸门），引用具体的 stageId / gateId。",
  "6. 需要起草文字（研究范围、变量字典、图表题注、文稿小节、质检说明）→ `data_analysis_draft`：它用 **DSH 当前默认模型**，只读项目产物拼上下文；save=true 会写入该任务固定的 docs/ 文件。模型在这条路上没有工具，不会跑脚本。",
  "7. 面板里的「让 AI 做这一步」会把**阶段任务卡**投递到当前项目绑定的 DSH 原生会话（绑定存在台账里）。你在这条会话里按卡上的命令与约束执行即可；卡是工作台按闸门现况生成的，不要自己改口径。输入行的「运行下一步」是工作台直接起脚本，与你在会话里执行是两条路，别重复跑同一阶段。",
  "8. **第 9 阶段复核**：先 `data_analysis_recheck`（action=status）看 12 项机器复算，再 action=evidence 取证据包；逐条判断后用 `data_analysis_issue` 落库（severity / where / claim / evidence / fix_kind）。不要直接手改 output/ 让闸门变绿：要改就改 scripts/ 或 data/ 并重跑受影响阶段；补丁只能作为提案（patch.path + baseHash + content），由人在面板点「套用」后才落盘并自动重跑下游。最后写 12 项覆盖表 R1–R12（checked / unchecked+理由）与 report.md。",
  "",
  "### 材料库（用户的资料放在项目外）",
  "- 用户的资料目录**不进项目、不复制**。`data_analysis_materials`（action=add，path=目录）登记成材料库条目，再用 action=mount 把它挂到 `data/` 下：Windows 下是目录联接（junction），macOS/Linux 下是镜像目录（真实目录 + 逐文件软链），两种都不拷源文件。",
  "- 挂载粒度由用户决定（挂整包、挂到省/案由、或只挂单个子目录都行），不要替用户预设分类。单文件材料按「父目录 + 子目录」挂。",
  "- 摘掉（action=unmount）只删挂载，源目录不动；挂载被手删或移动了用 action=repair 修（镜像目录在源里增删文件后也要 repair 同步）。",
  "- 早先已经复制进 `data/` 的旧副本：先 `data_analysis_migrate`（apply 不传）逐份 md5 比对，全对上了才用 apply=true 换成挂载；只要有一份对不上就整条停下，把差异列给用户看。迁移后必须重跑审计。",
  "- 材料分四类，登记回执会逐类报数：直读（技能能抽文本的 27 种格式，含 pdf/docx/xlsx/pptx/html）、识图（图片与没有文字层的扫描 PDF）、待转换（doc/xls/ppt）、不支持（mhtml、压缩包、音视频等，要告诉用户另存为 HTML 或先解压）。四类相加等于目录里的文件总数。",
  "- **识图**：`data_analysis_vision` 先 action=plan 出「待识别页数」（只数页，零模型调用），再用 action=run 跑（limit/pages 控制本次上限，`pages=\"1-20\"` 可试跑）。识别稿落在 `<台账目录>\\sources-cache\\<源>\\derived\\`，并挂成 `data/<挂载名>__识别稿/`。每条结果记页图 sha256、模型、提示词版本，默认 `human_verified=false`。模型不能看图时会明确报错，**不会**静默降级成纯文本。",
  "- 识别稿是「机器转写」，不是原文：`human_verified=false` 的页一旦被数字溯源或质检记录引用，`qa-vision` 闸门只会给出 unjudged。交付前必须逐页核对，核完用 action=verify 打勾（`all:true` 表示全部核对过）。",
  "- **待转换**：doc/xls/ppt 下游脚本读不出文本。工作台不代做转换——让用户（或你自己）在 Office/WPS 里另存为 docx/xlsx/pptx，放回原目录后重扫材料；不要假装能转，也不要为了绕过去自己写解析器。",
  "- 挂载、识图、解挂都动过 `data/` 之后**必须重跑审计**：`audit-freshness` 与 `materials-provenance-cover` 会对不上，闸门会拦。转换（doc/xls/ppt 另存为）是你或用户做的，做完同样要重扫材料并重跑审计。",
  "",
  "### 与 LLM 的分工",
  "- 工作台负责「跑、看、拦」；写作由 `data_analysis_draft` 起草，**人**核对后才写进交付物。",
  "- 起草结果里的每个数字都必须能在产物里找到出处；找不到就让用户补跑或标注未核，不许顺手补一个。",
  "- 你要用工具把一整步做完（读资料、改 CSV、跑脚本）时，走的是本会话的 harness，不是 `data_analysis_draft`；起草工具只产出文本。",
  "- 面板不重画聊天：会话、附件、工具卡都由 DSH 原生对话承担，工作台只在原生对话里加「工作台」「闸门徽章」「运行下一步」与工具结果徽章。",
  "",
  "### 四条硬规则",
  "1. **「未核」不等于「通过」**：闸门只有 pass / fail / unjudged 三态。PNG 判不了字号，就老实说「字号未核」，不许写成「字号合格」。",
  "2. **退出码 0 不等于阶段完成**：进程成功只证明脚本跑完了；阶段完成 = error 闸门全过 + 人工项已裁定 + 产物在。两者不一致时以闸门为准，并说明差异。",
  "   遇到标了「人工」的未裁定闸门：提醒用户在工作台里点「去拍板」，不要改脚本标签或产物来让它变绿；人拍板后再继续。",
  "3. **机器能判的事实不许被裁定改写**：`data_analysis_adjudicate` 只对标了「人工」的闸门有效（例如交付清单确认）。dpi、文件缺失、数字溯源 error 这类，只能修产物，不能改结论。",
  "4. **skill 是只读的**：不要改 skillRoot 下的任何文件，不要把 skill 复制进项目，也不要在项目里再 vendor 一份脚本。项目里要加自己的脚本，放 scripts/ 并在 project.json 的 stages.*.script 里登记。",
  "",
  "### 常见问答口径",
  "- 「图表合格吗」→ `data_analysis_figures`：先看 fail，再看 unjudged（unjudged 要说明「判不了」以及为什么，比如 PNG 没有文字层）。",
  "- 「为什么不能跑下一步」→ 把 blockers 原样说出来（哪个阶段、哪条闸门、什么证据）。",
  "- 「结果可信吗」→ 看数字溯源（output/verify/number_issues.csv 的 error 数）、终检报告（output/qa/qa_report.json 的 error_count）与漏斗是否单调；不要只说「跑通了」。V-05 单列待复核，不要当 error。",
  "- 「终检为什么没过」→ 终检是两步：qa_outputs 出合规报告、verify_numbers 出数字溯源；两步各自的 error 都算。缺 docx / 缺 manifest 时脚本会记 input 类 error，那是「没得查」，不是「查出来没问题」。",
  "- 「换个 python」→ `data_analysis_configure` 传 pythonPath，改完 `data_analysis_doctor` 复核（自检会因配置变化自动失效重查）。",
  "- 「环境装好了吗」→ `data_analysis_doctor` 的 checks 逐条念：技能包 / 阶段脚本 / Python / 依赖 / Word→PDF；缺什么就直接装（见标准动作 0b），装完复核一遍再回话。",
  "- 「我的资料怎么进来」→ 用户给的是**项目外**的目录：`data_analysis_materials`（action=add）登记，再 action=mount 挂到 data/ 下，不复制。别让用户先把文件拷进项目。",
  "- 「扫描件/照片能分析吗」→ 能，走识图：`data_analysis_vision` 先 plan 看要多少页，再 run。识别稿必须人工核对后才算数。",
  "- 「doc/xls 读不了」→ 转换不是工作台的事：让用户在 Office/WPS 里另存为 docx/xlsx 再重扫；工作台只负责告诉你哪些文件是「待转换」。",
];

export const PROMPT = LINES.join("\n");

export function registerPrompt(ctx, helpers = {}) {
  const { logger } = helpers;
  const safeGet = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };
  const systemPrompt = safeGet('systemPrompt');
  if (!systemPrompt?.section) {
    logger?.warn?.('[data-analysis] 宿主没有 systemPrompt 服务，使用规则未注入');
    return () => {};
  }
  try {
    return systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: PROMPT,
    });
  } catch (error) {
    logger?.error?.(`[data-analysis] 注入使用规则失败：${error?.message || error}`);
    return () => {};
  }
}