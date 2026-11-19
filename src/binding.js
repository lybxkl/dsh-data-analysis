/**
 * 工具 → 会话 的识别层。
 *
 * 只做两件纯事：读出这条调用属于哪条会话；判断它是不是子代理。
 * 绑定关系本身记在 store.bindings，由 workspace.js 负责。
 */

/** 这条工具调用发生在哪条 DSH 会话里；读不到就返回空串，绝不猜。 */
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

/** 子代理只是替主体干活的临时会话，不参与绑定/改绑。 */
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