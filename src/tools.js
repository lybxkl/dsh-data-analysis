/**
 * 模型工具：只有 1 个 —— data_analysis_workspace。
 *
 * 常驻可见（不设触发门）；描述只说明「把会话绑定到目录、供只读展示」，
 * 不指挥研究步骤——流程权威属于 skill。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * 工具返回值必须是无损 JSON：undefined / 函数 / 非有限数 / Date 都要先归一。
 */
function jsonSafe(value) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return undefined;
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'bigint') return String(value);
  if (kind === 'string' || kind === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = jsonSafe(item);
      return next === undefined ? null : next;
    });
  }
  if (kind === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = jsonSafe(item);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return undefined;
}

function okText(line) {
  return [{ type: 'text', text: line }];
}

export function registerTools(ctx, workspace, helpers = {}) {
  const { logger } = helpers;
  const disposers = [];

  function register(definition) {
    try {
      const original = definition.execute;
      definition.execute = async (args, exec) => jsonSafe(await original(args, exec));
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    } catch (error) {
      const message = String(error?.message || error);
      if (/duplicate/i.test(message)) {
        logger?.warn?.(`[data-analysis] 工具 ${definition.name} 已存在，跳过重复注册`);
        return () => {};
      }
      logger?.error?.(`[data-analysis] 注册工具 ${definition.name} 失败：${message}`);
      return () => {};
    }
  }

  register(defineTool({
    name: 'data_analysis_workspace',
    description:
      '把当前会话绑定到一个研究产物目录，供「实证研究工作台」只读展示。'
      + '目录可以是 skill 已经产出文件的已有目录，也可以是新目录。'
      + '研究流程本身请遵循 empirical-research-pipeline 技能（SKILL.md）；'
      + '本工具不执行任何分析、不运行脚本、不修改目录内容。'
      + '建议：本工具可用（即 dsh 已安装本插件）时尽早绑定产物目录，用户即可在面板实时看到研究产出。',
    parameters: {
      dir: { type: 'string', required: true, description: '产物目录的绝对路径（已有或新目录均可）' },
      name: { type: 'string', description: '可选工作区名，默认取目录名+日期' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => okText(value?.text || '已绑定工作区') },
    async execute(args, exec) {
      try {
        return await workspace.bindForExec(args || {}, exec);
      } catch (error) {
        const message = String(error?.message || error);
        return { ok: false, code: 'WORKSPACE_FAILED', error: message, text: `操作未执行：${message}` };
      }
    },
  }));

  return disposers;
}

export { jsonSafe, okText };