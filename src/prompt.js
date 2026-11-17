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

export const PROMPT=[
  '## 实证研究工作台',
  '工作台按对话启用。未关联项目或未明确启用时，可调用只读 data_analysis_status 和明确启动入口 data_analysis_start；话题中出现数据、图表等词不会自动授权开工。',
  '用户明确要求实证研究或显式调用研究技能时，先用可见文字说明正在启动，再调用 data_analysis_start。要求论文或期刊套版时验收档用 submission，不要自行降到 explore。失败时立即说明原因，不能静默改走手工脚本，或把旧产物冒充本次工作台执行。',
  '已启用后调用 data_analysis_status，以它返回的任务卡为唯一规程。需要完整契约时才调用 data_analysis_workflow(action="describe", full=true)。',
  '阶段 ID、顺序、脚本、依赖、检查点、动作和手工任务均由当前技能声明；不要背诵旧阶段表，也不要读技能源码来猜参数。',
  '通过 data_analysis_run_stage 运行任务卡点名的阶段；通过 data_analysis_workflow(action="run-action",actionId=...) 执行已登记动作。',
  '自定义解析先写在 draft/，再用 data_analysis_adopt_command 锁定。没有回执的脚本产物不被闸门采信。',
  '运行退出码与质量结果分别读取；缺证据、失效、未判和不适用不能冒充通过。校验器与原文不符时用 data_analysis_dispute_gate 登记争议，不要为了迁就误判去改表。',
  '人工裁定只作用于明确的人工项，不能覆盖机器事实；不代填真实签收。语义断点（纳入、锁定、主分析、正文图、套版预览）未写确认文件时停住。',
  '交付调用 formatjiang_receive_manuscript 后，用 data_analysis_record_handoff 记下 file_id、paper_id、version_id。终稿状态以交接文件和任务卡为准。',
  '技能包只读。缺少或不兼容的工作流必须明确报告，不能退回旧流程。',
].join('\n');

let livePrompt = PROMPT;

export function setLivePrompt(text) {
  livePrompt = String(text || PROMPT);
}

export function currentPrompt() {
  return livePrompt;
}

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
      get text() { return livePrompt; },
    });
  } catch (error) {
    logger?.error?.(`[data-analysis] 注入使用规则失败：${error?.message || error}`);
    return () => {};
  }
}
