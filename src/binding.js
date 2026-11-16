/**
 * 工具 → 会话 → 项目 的粘合层。
 *
 * 用户要的是「互相关联，不能随意切换」：对话里让 AI 建的项目要自动关联上，
 * 之后这条对话里的每次调用都作用在同一个项目上——而不是「左栏最近点开的那个」。
 *
 * 这里不碰宿主 API（不 import dsh-tools），只做几件纯事：
 *   1. 从工具执行记录里读出这条调用属于哪条会话；
 *   2. 把调用放进该会话绑定的项目作用域里执行（子代理沿父对话的项目走）；
 *   3. 在结果文本末尾说清「本对话 ⇄ 哪个项目」；
 *   4. 决定哪些工具「不许顺手绑定」（探路 / 环境类）。
 * 宿主接线在 tools.js，测试直接驱动本文件。
 */

import { PROBE_TOOLS, BOOTSTRAP_TOOLS } from './gating.js';

/**
 * 这条工具调用发生在哪条 DSH 会话里。
 *
 * 宿主喂给 execute 的第二个参数是执行记录，`exec.agent` 就是那条会话的 agent loop，
 * 会话 id 在 `agent.session.id` 上。读不到（旧宿主、子代理）就返回空串——调用照旧，
 * 只是不记绑定，绝不猜一个 id 出来。
 */
export function sessionIdOf(exec) {
  try {
    const agent = exec && exec.agent;
    const id = agent && agent.session && agent.session.id;
    if (typeof id === 'string' && id) return id;
    const fallback = agent && agent.sessionId;
    if (typeof fallback === 'string' && fallback) return fallback;
    const direct = exec && exec.sessionId;
    return typeof direct === 'string' ? direct : '';
  } catch {
    return '';
  }
}

/**
 * 这条调用是不是「子代理」发起的。
 *
 * 子代理只是替主体干活的临时会话：让它去抢项目的「研究对话」名额，
 * 用户会发现左栏那颗入口变成一个自己没见过的会话。所以子代理不参与绑定。
 */
export function sessionIsDelegated(exec) {
  try {
    const agent = exec && exec.agent;
    const header = agent && agent.session && agent.session.header;
    if (!header) return false;
    if (header.origin === 'subagent') return true;
    const depth = Number(header.delegationDepth || 0);
    return Number.isFinite(depth) && depth > 0;
  } catch {
    return false;
  }
}

/** 在结果文本末尾补一句「这条对话 ⇄ 哪个项目」：只在刚建立/刚改绑时补，读操作不刷屏。 */
export function withChatLink(value, link) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.ok === false) return value;
  if (!link || !link.ok || !link.project) return value;
  // 早就绑好了：这次调用没有改变任何关系，不往结果里塞话（读工具每次都说一遍只会变噪音）
  if (link.already === true) return value;
  const label = link.project.name || link.project.path;
  if (!label) return value;
  const line = link.movedFrom
    ? `本对话已改绑到项目：${label}（之前关联的是另一个项目）`
    : `本对话已关联项目：${label}（后续这条对话的调用都作用在它上面）`;
  if (typeof value.text !== 'string' || !value.text) return { ...value, text: line };
  if (value.text.includes('本对话')) return value;
  return { ...value, text: `${value.text}\n${line}` };
}

/** 这两个工具会换项目：跑完再把这条对话绑到新项目上（用户让切，就是明确的改绑）。 */
export const PROJECT_SELECTING_TOOLS = new Set(['data_analysis_create_project', 'data_analysis_open_project']);

/**
 * 环境类工具：只读/只写全局配置，不需要项目。
 *
 * 它们不该把「临时装环境」的会话绑到项目上（会顶掉用户真正的研究对话），
 * 但也不当探路工具——触发门仍然挡着，未启用时一样看不见。
 */
export const PROJECT_AGNOSTIC_TOOLS = new Set([
  'data_analysis_doctor',
  'data_analysis_configure',
  'data_analysis_list_stages',
]);

/**
 * 这些工具不许「顺手绑定」。
 *
 * 绑定会顺带启用工作台（触发门），所以只读的探路工具（data_analysis_status）必须留在门外：
 * 否则模型只要调一次 status，这条对话就被绑上、下一步 27 个工具全冒出来——门等于没设。
 * 环境类工具同理：面板开的装环境会话只要调一次 doctor 就把项目抢走，用户的研究对话会被顶掉。
 * 已经绑过（或已启用）的会话照旧在它自己的项目作用域里跑，只是不再新建绑定。
 */
export const NO_AUTOBIND_TOOLS = new Set([...PROBE_TOOLS, ...BOOTSTRAP_TOOLS, ...PROJECT_AGNOSTIC_TOOLS]);

/**
 * 包一层工具实现：拿到会话 id，绑定，然后在该会话的项目作用域里跑。
 *
 * - 换项目的工具（create/open）不放进作用域：它就该改全局当前项目，跑完再把这条对话改绑过去；
 * - 其余工具：没绑过就绑到当前项目（已有的绑定绝不被抢），再在作用域里跑。
 * 返回值原样返回（序列化由 tools.js 负责），异常照旧抛给宿主。
 */
export function wrapExecute({ name, workbench, original }) {
  return async function executeWithSession(args, exec) {
    const sessionId = sessionIdOf(exec);
    if (!sessionId) return original(args, exec);
    if(BOOTSTRAP_TOOLS.has(name))return original(args,exec);
    // 子代理不记绑定：它不该占用项目那唯一一条「研究对话」。
    // 但它替父对话干活，作用域要跟着父对话的项目走——否则面板停在 B，子代理会把 A 的产物写到 B 上。
    if (sessionIsDelegated(exec)) {
      if(PROJECT_SELECTING_TOOLS.has(name))return {ok:false,error:'请由主研究对话创建或切换项目，子代理不改变项目归属',text:'操作未执行：请由主研究对话创建或切换项目'};
      const scope = typeof workbench.delegatedScopeSession === 'function' ? workbench.delegatedScopeSession(sessionId) : '';
      if(scope)return workbench.runForSession(scope, () => original(args, exec));
      if(NO_AUTOBIND_TOOLS.has(name))return original(args,exec);
      return {ok:false,error:'父研究对话尚未关联有效项目，未使用面板中的其他项目代替',text:'操作未执行：父研究对话尚未关联有效项目'};
    }

    if (PROJECT_SELECTING_TOOLS.has(name)) {
      const value = await original(args, exec);
      // 建/开没成功就别改绑：一次失败的 create 不该把这条对话挪到别的项目上
      if (value && value.ok === false) return value;
      const active = workbench.active();
      if (!active.ok) return value;
      return withChatLink(value, workbench.bindSessionTo(sessionId, active.id, { force: true }));
    }

    // 探路工具不许顺手绑定（见 NO_AUTOBIND_TOOLS）：已绑的照旧在会话作用域里跑，没绑的不新建
    if (NO_AUTOBIND_TOOLS.has(name)) {
      const bound = workbench.sessionBinding(sessionId);
      return bound ? workbench.runForSession(sessionId, () => original(args, exec)) : original(args, exec);
    }

    const ensured = workbench.ensureSessionBinding(sessionId);
    if(!ensured?.ok)return {...ensured,ok:false,text:'工作台操作未执行：'+(ensured?.error||'当前对话未关联有效项目')};
    const value = await workbench.runForSession(sessionId, () => original(args, exec));
    return ensured && ensured.already ? value : withChatLink(value, ensured);
  };
}
