/**
 * 触发门（档②）：data_analysis_* 只在「这条对话已启用工作台」的模型步里出现。
 *
 * 启用 = 这条对话关联了项目 / 被显式 arm 过（面板的「让 AI 装环境」临时会话）/
 * 父对话已启用（子代理沿用它，否则被派去干活的会话会突然没有工具）。
 *
 * 为什么单独一个文件：
 *   - 它是纯函数，测试不需要宿主 API，也不会把 service.js 拖进循环依赖；
 *   - 「默认关」这条规则只能有一个实现，散在 tools.js 里迟早会出现两套判定。
 */

/**
 * 不进门的探路工具（档②的 A 选项）。
 * 只放只读工具：误触时最多多一次「读状态」，不会建项目、不会跑阶段。
 * 注意：名单里的工具不许自动绑定会话（见 binding.js 的 NO_AUTOBIND_TOOLS）——
 * 绑定即启用，让一次「查一下」把门打开，门就白设了。
 */
export const PROBE_TOOLS = new Set(['data_analysis_status']);

/** 子代理链最多往上找几层（正常只有一层；给 fork / 多层委派留余量）。 */
export const MAX_INHERIT_DEPTH = 8;

/**
 * 从 ToolActivationContext.agent 里取会话 id。
 * 宿主保证 agent.id 是 SessionId；运行时对象上还有 agent.session.id（binding.js 走的就是那条路），
 * 两个都认，取不到就空串——绝不猜一个 id 出来。
 */
export function sessionIdFromActivation(agent) {
  try {
    if (!agent || typeof agent !== 'object') return '';
    const direct = agent.id;
    if (typeof direct === 'string' && direct) return direct;
    const nested = agent.session && agent.session.id;
    return typeof nested === 'string' ? nested : '';
  } catch {
    // 会话对象可能已经释放/被代理：读属性抛错就当作「没有会话」，绝不猜
    return '';
  }
}

/**
 * 这条会话能不能看见并调用工作台工具。
 *
 * 只依赖 workbench.isArmed(sessionId)（Workbench 上有）。宿主给的对象缺这个方法时按「没启用」处理：
 * 门禁的默认值必须是关，不能因为少一个方法就放开。
 */
export function isArmedSession(workbench, sessionId) {
  const key = String(sessionId || '').trim();
  if (!key) return false;
  if (!workbench || typeof workbench.isArmed !== 'function') return false;
  try {
    return workbench.isArmed(key) === true;
  } catch {
    return false;
  }
}

/**
 * 交给 ctx.tools.register(def, { when }) 的准入条件：每个模型步求值一次。
 * 返回 false 时该步的工具表里没有这个工具（不是调用时才拒），所以模型连它的描述都看不到。
 */
export function whenArmed(workbench) {
  return function armedForStep(context) {
    try {
      const agent = context && context.agent;
      return isArmedSession(workbench, sessionIdFromActivation(agent));
    } catch {
      // 准入判定自己抛错不能把整个模型步拖垮：被挡住就好，默认关
      return false;
    }
  };
}

/**
 * 每个工具该带什么注册准入。
 *
 * 抽出来是为了能单独测：tools.js 依赖宿主的 @deepseek-ai/dsh-tools，测试环境里没有那个包；
 * 而「哪些工具进门、哪些当探路」恰恰是最该被测住的一行——漏一个就等于门有洞。
 */
export function admissionFor(armedInStep, toolName, options = {}) {
  if (options.ungated === true) return undefined;
  if (PROBE_TOOLS.has(String(toolName || ''))) return undefined;
  return { when: armedInStep };
}
