/** 模型可见面：只注册 1 个工具，结果经 jsonSafe 归一后由 render 回到模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Store } from '../src/store.js';
import { Viewer } from '../src/viewer.js';
import { WorkspaceService } from '../src/workspace.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tool-output-'));
try {
  // SDK 的 defineTool 只是声明构造器；替换掉它后才能在没有宿主依赖的环境里加载真实工具代码。
  let source = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.ok(source.includes("import { defineTool } from '@deepseek-ai/dsh-tools';"));
  source = source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';", 'const defineTool=value=>value;');
  source = source.replaceAll(/from '(\.\/[^']+)'/g, (_all, rel) => 'from ' + JSON.stringify(new URL('../src/' + rel.slice(2), import.meta.url).href));
  const file = path.join(root, 'actual-tools.mjs');
  fs.writeFileSync(file, source);
  const { registerTools } = await import(pathToFileURL(file).href);

  const stateDir = path.join(root, 'ledger');
  const store = new Store({ filePath: path.join(stateDir, 'data-analysis.json') }).load();
  const viewer = new Viewer({ store });
  const workspace = new WorkspaceService({ store, viewer });

  const definitions = new Map();
  const admissions = new Map();
  registerTools({ tools: { register: (definition, admission) => {
    definitions.set(definition.name, definition);
    admissions.set(definition.name, admission);
  } } }, workspace);

  assert.deepEqual([...definitions.keys()], ['data_analysis_workspace'], '必须只有 1 个工具');
  const tool = definitions.get('data_analysis_workspace');
  assert.equal(admissions.get('data_analysis_workspace'), undefined, '不设触发门/准入条件');
  assert.match(tool.description, /只读展示/);
  assert.match(tool.description, /SKILL\.md/);
  assert.ok(!/第一步|首先|然后|必须调用|按阶段/.test(tool.description), '工具描述不得指挥研究步骤');

  const dir = path.join(root, 'research');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'output', 'a.csv'), 'a\n1\n');

  const result = await tool.execute({ dir, name: '输出' }, { agent: { session: { id: 'session-1' } } });
  assert.equal(result.ok, true);
  assert.equal(result.workspace.name, '输出');
  const blocks = tool.output.render({}, result);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /已绑定工作区/);
  assert.equal(store.get('bindings')['session-1'], result.workspace.id);

  const missingSession = await tool.execute({ dir }, {});
  assert.equal(missingSession.ok, false);
  assert.equal(missingSession.code, 'SESSION_REQUIRED');

  // jsonSafe：Date / NaN / undefined / 函数都要归一，否则宿主判为不可序列化
  const noisy = {
    bindForExec: () => ({ ok: true, at: new Date('2026-01-02T03:04:05Z'), bad: NaN, skip: undefined, fn() {}, list: [undefined, 1] }),
  };
  const noisyDefinitions = new Map();
  registerTools({ tools: { register: (definition) => noisyDefinitions.set(definition.name, definition) } }, noisy);
  const normalized = await noisyDefinitions.get('data_analysis_workspace').execute({ dir }, {});
  assert.equal(normalized.at, '2026-01-02T03:04:05.000Z');
  assert.equal(normalized.bad, null);
  assert.equal('skip' in normalized, false);
  assert.equal('fn' in normalized, false);
  assert.deepEqual(normalized.list, [null, 1]);
  const fallback = noisyDefinitions.get('data_analysis_workspace').output.render({}, { ok: true });
  assert.equal(fallback[0].text, '已绑定工作区');

  console.log('PASS 只注册 data_analysis_workspace（无触发门、描述非指令性）');
  console.log('PASS 工具结果经 jsonSafe 归一并由 render 返回模型可见文本');
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}