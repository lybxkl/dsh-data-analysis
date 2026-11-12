/**
 * 实证研究工作台 · Client 半片（单文件、零构建）
 *
 * 视觉目标（ui-spec.md）：
 *  - 纸白底、藏青强调、无渐变无阴影；数字等宽；顶栏 44px、左阶段栏 296px、右运行台 352px。
 *  - 三态贯穿：✓ 通过 / ✗ 未过 / ? 判不了。「判不了」用灰点 + 「未核」，绝不画成绿色。
 *
 * 数据契约（与 Host 半片 src/routes.js 严格一致）：
 *  GET  /data-analysis/api/state
 *  POST /data-analysis/api/project/create | open | close
 *  POST /data-analysis/api/stage/run | stage/cancel
 *  GET  /data-analysis/api/run/log?id=
 *  POST /data-analysis/api/adjudicate | config
 */
(function () {
  var MODULE_ID = '@local/dsh-data-analysis';
  var API = '/data-analysis/api';

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useMemo = React.useMemo;
      var useRef = React.useRef;
      var useCallback = React.useCallback;

      /* ------------------------------------------------------------------ *
       * 文案
       * ------------------------------------------------------------------ */

      var ZH = {
        title: '实证研究工作台',
        subtitle: '按阶段跑技能、看证据、在交付前拦住不合格项',
        refresh: '刷新',
        refreshing: '读取中…',
        open: '打开项目',
        create: '新建项目',
        settings: '设置',
        close: '关闭',
        cancel: '取消',
        confirm: '确定',
        save: '保存',
        saving: '保存中…',
        retry: '重试',
        emptyTitle: '从一个资料目录开始',
        emptyHint: '工作台不写论文，它负责跑技能包、把每一步的产物和闸门摆出来。新建项目后把 PDF / Word / Excel 放进 data/，从第 1 步往下走。',
        dirLabel: '项目目录',
        dirPh: '如 F:\\研究\\2026-数字政府',
        nameLabel: '项目名（可空）',
        namePh: '默认取目录名',
        createHint: '目录必须是空的；会创建 data / docs / output / scripts / runs 与 project.json。',
        openHint: '目录里要有 project.json（工作台建过的项目）。',
        stageEmpty: '选择左侧一个阶段查看闸门与产物',
        run: '运行本阶段',
        rerun: '重跑',
        running: '运行中…',
        cancelRun: '取消运行',
        noScript: '本阶段没有登记脚本：由人/模型完成，工作台只做验收',
        command: '命令',
        gates: '闸门',
        gatesTodoNote: '该阶段还没开始。下面是开工后要逐条过的闸门，此时的 ✗ 只表示产物还没生成，不是判定结果。',
        artifacts: '产物',
        logs: '运行台',
        noRuns: '还没有运行记录',
        logEmpty: '选择一条运行查看日志',
        gatePass: '通过',
        gateFail: '未过',
        gateUnjudged: '未核',
        manual: '人工',
        adjudicate: '裁定',
        adjudicateTitle: '人工裁定',
        adjudicateHint: '机器能判的事实不允许改写；这里只记录「人看过之后」的结论。',
        note: '理由（写进台账）',
        pass: '通过',
        fail: '不通过',
        clear: '撤销裁定',
        skillOk: '技能包就位',
        skillMissing: '技能包未就位',
        skillRoot: '技能包目录',
        pythonPath: 'Python 命令',
        skillDrift: '项目记录的 SKILL.md 指纹与当前技能包不一致，旧产物可能来自旧版本',
        blocked: '被拦住',
        review: '待裁定',
        done: '已完成',
        todo: '未开始',
        runningState: '运行中',
        stageRunOk: '最近一次运行成功',
        stageRunFail: '最近一次运行失败',
        stageRunCancelled: '最近一次运行已取消',
        figures: '图表清单',
        flow: '样本流程',
        models: '模型',
        verify: '数字溯源',
        noFigures: '还没有图表清单',
        noFlow: '还没有 sample_flow',
        noModels: '还没有模型产物',
        noVerify: '还没有数字溯源报告',
        dpi: 'dpi',
        font: '字号',
        palette: '配色',
        file: '文件',
        nLabel: 'N',
        notMeasured: '未测',
        notDeclared: '未声明',
        missing: '缺失',
        unitFigures: '张图',
        project: '项目',
        skill: '技能包',
        totalGates: '闸门',
        drawer: '运行台',
        closeDrawer: '收起',
        health: '状态',
        created: '已创建',
        loadFail: '读取失败',
        actionFail: '操作失败',
        okMark: '✓',
        failMark: '✗',
        unknownMark: '?',
        preflight: '环境自检',
        envFail: '环境未就绪',
        envWarn: '环境可用，但有降级',
        envPending: '正在检查运行环境…',
        recheck: '重新检查',
        envHint: '技能包与 Python 依赖在启动时自动检查；缺了可以点「让 AI 装好环境」，它会自己 clone 技能包、装依赖（没有 Python 连 Python 一起装）。',
        checkedAt: '检查时间',
        advice: '处理建议',
        draft: 'AI 起草',
        draftTitle: '用 DSH 模型起草',
        draftHint: '工作台只读项目产物拼上下文；模型没有工具，不会运行脚本，也不会编造数字。写入前请人工核对。',
        draftModel: '模型',
        modelFollow: '跟随 DSH 默认',
        modelCustom: '自定义模型',
        modelProvider: '提供方',
        modelName: '模型',
        modelUnavailable: '模型不可用',
        draftTask: '起草任务',
        draftInstruction: '补充要求',
        draftInstructionPh: '例如：重点说明 in_analysis 口径；图注必须含 N',
        generate: '生成',
        generating: '生成中…',
        copy: '复制',
        write: '写入',
        written: '已写入',
        draftEmpty: '还没有内容：填好要求后点「生成」。',
        draftSaved: '已写入项目文件',
        modelsFail: '读取模型列表失败',
        researchChat: '研究对话',
        chatNone: '还没有绑定会话。点「开始研究对话」会在项目目录里建一个真正的 DSH 会话。',
        chatBound: '已绑定 DSH 会话',
        chatRunning: 'AI 正在干活…',
        chatIdle: '会话空闲',
        startChat: '开始研究对话',
        openChat: '打开对话',
        askAI: '让 AI 做这一步',
        askAIHint: '把当前阶段的现状、命令、约束和期望产物投递到这条会话，并切到原生对话；AI 正在跑时会排队',
        aiSent: '任务卡已投递，已切到对话',
        aiFailed: '投递任务卡失败',
        chatUnavailable: 'DSH 会话服务不可用（宿主没暴露 sessions）',
        chatNoProject: '先打开一个项目',
        nextStep: '运行下一步',
        nextAllDone: '八个阶段都已完成',
        nextManual: '下一步要人工完成',
        nextRunStarted: '已启动：',
        nextRunFailed: '启动失败：',
        tailTitle: '工作台',
        tailOpen: '打开',
        chatCardTitle: '研究对话',
        chatSessionShort: '会话',
        sessionGone: '会话已不存在，请重新开始研究对话',
        retryChat: '重新建会话',
        nextTitle: '全局下一步',
        nextRun: '运行',
        nextGo: '去这里',
        nextAdjudicate: '去裁定',
        nextInspect: '去查看',
        nextAllDoneText: '九个阶段都已完成',
        nextRunning: '正在运行',
        nextBlocked: '被拦住',
        nextReview: '待人工确认',
        nextTodo: '还没开始',
        nextAskAI: '让 AI 做这一步',
        nextDraft: '让 AI 起草',
        stageSelect: '阶段',
        expected: '要产出',
        noArtifacts: '这一阶段还没有可解析的产物。看上面的闸门与命令，跑一次或把产物放到预期路径再刷新。',
        figPass: '达标',
        figFail: '不达标',
        figUnjudged: '待核',
        figFontNote: '字号需要 PDF 文字层才能测，PNG 清单只能记「未核」。',
        showAll: '显示全部',
        collapse: '收起',
        copyCmd: '复制命令',
        copied: '已复制',
        coefficients: '个系数',
        inAnalysisLabel: 'in_analysis',
        excludedLabel: '排除',
        reportErrors: 'error',
        reportWarnings: 'warning',
        patchTitle: '套用补丁',
        patchTarget: '将覆盖',
        patchBase: '基线哈希',
        patchBackup: '覆盖前会自动备份到 output/recheck/diffs。',
        patchApply: '覆盖并重跑',
        patchChanged: '补丁内容（前 24 行）',
        aiReview: '让 AI 复核',
        aiReviewHint: '把 12 项复算、已有问题与项目脚本交给模型，让它写 issues.jsonl 与覆盖表；工作台不替模型改产物',
        chainRunning: '重跑中',
        chainDone: '已跑完',
        chainStopped: '已停下',
        chainCancelled: '已取消',
        chainStep: '步',
        chainNoSteps: '没有需要重跑的下游阶段',
        issueOpen: '待处理',
        issueFixed: '已修',
        issueWontfix: '不修',
        issueDeferred: '延后',
        severityError: '错误',
        severityWarning: '警告',
        severityInfo: '提示',
        fixEditText: '改文本',
        fixEditCode: '改脚本',
        fixRerun: '重跑',
        fixAcceptRisk: '接受风险',
        fixAskUser: '问用户',
        coverageTitle: '覆盖表',
        coverageChecked: '已核',
        runExit: '退出码',
        runNoLog: '这次运行没有日志',
        pipelineLegend: '完成 = 闸门全过；待裁定 = 有人工项或警告；被拦住 = 有 error 级未过',
        stageOf: '阶段'
      };

      function t(key) {
        return ZH[key] || key;
      }

      var STATUS_TEXT = {
        done: 'done',
        blocked: 'blocked',
        review: 'review',
        todo: 'todo',
        running: 'runningState'
      };

      // 复核区原来直接显示英文枚举，人看不懂；这里统一成中文
      var ISSUE_STATUS = { open: 'issueOpen', fixed: 'issueFixed', wontfix: 'issueWontfix', deferred: 'issueDeferred' };
      var SEVERITY_TEXT = { error: 'severityError', warning: 'severityWarning', info: 'severityInfo' };
      var FIX_KIND_TEXT = {
        'edit-text': 'fixEditText',
        'edit-code': 'fixEditCode',
        rerun: 'fixRerun',
        'accept-risk': 'fixAcceptRisk',
        'ask-user': 'fixAskUser'
      };
      var CHAIN_STATUS = { running: 'chainRunning', done: 'chainDone', stopped: 'chainStopped', cancelled: 'chainCancelled' };
      var RUN_WORD = { ok: '成功', failed: '失败', cancelled: '已取消', running: '运行中', interrupted: '被中断' };
      // 面板阶段 → AI 起草任务的对应关系：没有脚本的阶段，主按钮应该直接把起草任务打开
      var STAGE_TASK = { scope: 'scope', coding: 'codebook', figures: 'figures', manuscript: 'manuscript', qa: 'qa', recheck: 'recheck' };

      function fmtTime(iso) {
        if (!iso) return '';
        var date = new Date(iso);
        if (isNaN(date.getTime())) return String(iso);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      }

      function fmtSpan(from, to) {
        if (!from) return '';
        var start = new Date(from).getTime();
        var end = to ? new Date(to).getTime() : Date.now();
        if (isNaN(start) || isNaN(end) || end < start) return '';
        var sec = Math.round((end - start) / 1000);
        if (sec < 60) return sec + ' 秒';
        var min = Math.floor(sec / 60);
        var rest = sec % 60;
        return min + ' 分' + (rest ? ' ' + rest + ' 秒' : '');
      }

      function sizeText(bytes) {
        var n = Number(bytes || 0);
        if (!n) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
      }

      /* ------------------------------------------------------------------ *
       * HTTP
       * ------------------------------------------------------------------ */

      function request(method, path, body) {
        var init = { method: method, headers: { accept: 'application/json' } };
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        return fetch(API + path, init).then(function (res) {
          return res.json().catch(function () {
            return { ok: false, error: 'HTTP ' + res.status };
          }).then(function (json) {
            if (!res.ok && json && json.ok === undefined) json = { ok: false, error: 'HTTP ' + res.status };
            return json;
          });
        });
      }

      function getState() {
        return request('GET', '/state');
      }

      function getSummary() {
        return request('GET', '/summary');
      }

      /* ------------------------------------------------------------------ *
       * 研究对话：与 DSH 原生会话的桥
       *
       * 不实现聊天：会话、消息流、输入框、附件、工具卡都由宿主承担。
       * 工作台只做三件事——建/绑会话、投递任务卡、在原生对话里加工作台动作。
       * ------------------------------------------------------------------ */

      var runtime = { ctx: null, ref: null };
      // 投卡去重记录：按项目路径存最近一次指纹。放模块作用域，面板卸载/切到对话后仍在。
      var CARD_LOG = {};

      function svc(name) {
        var ctx = runtime.ctx;
        if (!ctx || typeof ctx.get !== 'function') return null;
        try {
          return ctx.get(name) || null;
        } catch (e) {
          return null;
        }
      }

      function sessionService() {
        return svc('sessions');
      }

      function releaseRef() {
        var ref = runtime.ref;
        runtime.ref = null;
        if (ref && typeof ref.release === 'function') {
          try {
            ref.release();
          } catch (e) {
            /* ignore */
          }
        }
      }

      function ensureRef(sessionId) {
        if (!sessionId) return Promise.reject(new Error(t('chatNoProject')));
        var sessions = sessionService();
        if (!sessions || typeof sessions.retain !== 'function') {
          return Promise.reject(new Error(t('chatUnavailable')));
        }
        if (runtime.ref && runtime.ref.sessionId === sessionId) return Promise.resolve(runtime.ref);
        releaseRef();
        var ref = sessions.retain(sessionId, { source: 'gateway' });
        runtime.ref = ref;
        return Promise.resolve(ref.ready).then(function () {
          return ref;
        }).catch(function (error) {
          if (runtime.ref === ref) runtime.ref = null;
          try {
            ref.release();
          } catch (e) {
            /* ignore */
          }
          throw error;
        });
      }

      function createSession(cwd) {
        var sessions = sessionService();
        if (!sessions || typeof sessions.create !== 'function') {
          return Promise.reject(new Error(t('chatUnavailable')));
        }
        return sessions.create({ cwd: cwd });
      }

      function persistSession(sessionId) {
        return request('POST', '/project/session', { sessionId: sessionId || '' }).then(function (json) {
          if (json && json.ok) return json;
          throw new Error((json && json.error) || '绑定会话失败');
        });
      }

      function openConversation(sessionId) {
        var uiWorkspace = svc('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          try {
            uiWorkspace.openSession(sessionId);
            return;
          } catch (e) {
            /* fall through */
          }
        }
        var layout = svc('layout');
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('conversation');
      }

      function openWorkbenchPanel() {
        var layout = svc('layout');
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('data-analysis');
      }

      /* ------------------------------------------------------------------ *
       * 让 AI 装环境：开一个临时会话，把「装什么、怎么验」一次说清
       * 会话由宿主建（sessions.create + retain + prompt），工作台不自己实现聊天。
       * ------------------------------------------------------------------ */

      var ENV_PROMPT = [
        '帮我把「实证研究工作台」（DSH 插件 dsh-data-analysis）的运行环境一次性装好，装完自己验一遍再回话。',
        '',
        '需要两样东西：',
        '',
        '1) 技能包 empirical-research-pipeline',
        '   仓库：https://github.com/lybxkl/SPSS-Style-Charting-Skill',
        '   做法：git clone 到临时目录，把里面的 empirical-research-pipeline 整个目录复制到 ~/.agents/skills/',
        '   （Windows 是 %USERPROFILE%\\.agents\\skills\\）。装完确认 ~/.agents/skills/empirical-research-pipeline/SKILL.md 存在。',
        '',
        '2) Python 3.9+ 与依赖',
        '   依赖：pandas numpy scipy statsmodels matplotlib PyMuPDF python-docx openpyxl Pillow',
        '   没有 Python（或低于 3.9）就先装最新的 Python 3：Windows 用 winget install Python.Python.3.13 或官网安装包，',
        '   macOS 用 brew install python，Linux 用发行版的包管理器。',
        '   然后 pip install -r <技能仓库>/requirements.txt；缺哪个包单独补装也行。',
        '   Windows 上还想用 Word→PDF 这一步的话，再装 pywin32（可选，缺了只影响那一步）。',
        '',
        '装完请依次做：',
        '- 调 data_analysis_doctor 自查，把每一项结果原样贴出来；',
        '- 如果 Python 不在 PATH，或用的是别的解释器，用 data_analysis_configure 把 pythonPath 设成绝对路径；',
        '- 如果技能包装在别处，用 data_analysis_configure 把 skillRoot 指过去（仓库根或包目录都行）；',
        '- 再调一次 data_analysis_doctor 确认全部通过。',
        '',
        '约束：不要动用户的研究资料，不要修改技能包里的脚本，不要装上面没提到的软件。',
        '最后用一句话说明「环境已就绪」，并附上 Python 可执行文件路径与版本。'
      ].join('\n');

      /**
       * 开一个临时会话并把安装提示词投进去。
       * 用自己的一条 ref，不碰 runtime.ref（那是「研究对话」在用的），失败一律如实抛出。
       */
      function startInstallSession(cwd) {
        var sessions = sessionService();
        if (!sessions || typeof sessions.create !== 'function') {
          return Promise.reject(new Error('宿主没有会话服务，开不了临时会话'));
        }
        if (runtime.installRef) {
          try {
            runtime.installRef.release();
          } catch (e) {
            /* ignore */
          }
          runtime.installRef = null;
        }
        var created = typeof cwd === 'string' && cwd ? sessions.create({ cwd: cwd }) : sessions.create({});
        return Promise.resolve(created).then(function (sessionId) {
          var ref = sessions.retain(sessionId, { source: 'gateway' });
          return Promise.resolve(ref.ready).then(function () {
            runtime.installRef = ref;
            return ref.binding.session.prompt([{ type: 'text', text: ENV_PROMPT }], 'queue');
          }).then(function (result) {
            if (!result || result.ok !== true) {
              var detail = result && result.error && (result.error.message || result.error.code);
              throw new Error('投递失败：' + (detail || '宿主拒绝了这条消息'));
            }
            openConversation(sessionId);
            return sessionId;
          });
        });
      }

      function textOfBlocks(content) {
        if (!Array.isArray(content)) return '';
        var out = [];
        for (var i = 0; i < content.length; i += 1) {
          var part = content[i];
          if (part && part.type === 'text' && part.text) out.push(part.text);
        }
        return out.join('\n');
      }

      /**
       * 面板投递：拿任务卡 → 有绑定就复用，没有就建会话 → prompt(queue) → 绑定 → 打开原生对话。
       * 任一步失败都如实抛回面板，不静默换会话、不重试。
       */
      function deliverCard(stageId, projectDir, boundSessionId) {
        return request('GET', '/task-card?stageId=' + encodeURIComponent(stageId)).then(function (card) {
          if (!card || !card.ok) throw new Error((card && card.error) || '任务卡生成失败');
          var idPromise = boundSessionId ? Promise.resolve(boundSessionId) : createSession(projectDir);
          return idPromise.then(function (sessionId) {
            return ensureRef(sessionId).then(function (ref) {
              return ref.binding.session.prompt([{ type: 'text', text: card.text }], 'queue').then(function (result) {
                if (!result || result.ok !== true) {
                  var detail = result && result.error && (result.error.message || result.error.code);
                  throw new Error('投递失败：' + (detail || '宿主拒绝了这条消息'));
                }
                return persistSession(sessionId).then(function (json) {
                  openConversation(sessionId);
                  return { ok: true, sessionId: sessionId, state: json.state };
                }).catch(function (error) {
                  // 消息已经发出去了：绑定失败不能谎报「投递失败」，照常进对话并如实提示。
                  openConversation(sessionId);
                  return {
                    ok: true,
                    sessionId: sessionId,
                    warning: '任务卡已发出，但会话绑定失败（重启后可能找不到这条对话）：' + String((error && error.message) || error)
                  };
                });
              });
            });
          });
        });
      }

      /** 原生会话侧读工作台摘要：payload 只含 active/summary/totals/next，不搬图表清单。 */
      function useWorkbenchState(intervalMs, deps) {
        var stateTuple = useState(null);
        var state = stateTuple[0];
        var setState = stateTuple[1];
        var errTuple = useState('');
        var err = errTuple[0];
        var setErr = errTuple[1];
        var reload = useCallback(function () {
          return getSummary().then(function (json) {
            if (json && json.ok) {
              setState(json);
              setErr('');
            } else {
              setErr((json && json.error) || t('loadFail'));
            }
          }).catch(function (e) {
            setErr(String((e && e.message) || e));
          });
        }, []);
        useEffect(function () {
          void reload();
          if (!intervalMs) return undefined;
          var timer = setInterval(function () {
            void reload();
          }, intervalMs);
          return function () {
            clearInterval(timer);
          };
        }, [reload].concat(deps || []));
        return [state, reload, err];
      }

      function useSessionRunning(sessionId) {
        var tuple = useState(false);
        var running = tuple[0];
        var setRunning = tuple[1];
        useEffect(function () {
          if (!sessionId) {
            setRunning(false);
            return undefined;
          }
          var alive = true;
          var unsub = null;
          void ensureRef(sessionId).then(function (ref) {
            if (!alive) return;
            var session = ref.binding.session;
            var sync = function sync() {
              try {
                setRunning(Boolean(session.getSnapshot().running));
              } catch (e) {
                /* ignore */
              }
            };
            sync();
            if (session && typeof session.subscribe === 'function') unsub = session.subscribe(sync);
          }).catch(function () {
            if (alive) setRunning(false);
          });
          return function () {
            alive = false;
            if (typeof unsub === 'function') {
              try {
                unsub();
              } catch (e) {
                /* ignore */
              }
            }
          };
        }, [sessionId]);
        return running;
      }

      /** 面板侧栏只放「最近一轮」的摘要，不搬运整段对话。 */
      function useSessionSnippet(sessionId) {
        var tuple = useState('');
        var snippet = tuple[0];
        var setSnippet = tuple[1];
        useEffect(function () {
          if (!sessionId) {
            setSnippet('');
            return undefined;
          }
          var alive = true;
          var unsub = null;
          void ensureRef(sessionId).then(function (ref) {
            if (!alive) return;
            var source = ref.binding.eventSource;
            var read = function read() {
              try {
                var windowValue = source && source.getSnapshot && source.getSnapshot();
                var entries = (windowValue && windowValue.entries) || [];
                for (var i = entries.length - 1; i >= 0; i -= 1) {
                  var item = entries[i];
                  var event = item && item.event;
                  if (event && event.type === 'assistant/message') {
                    var message = event.data && event.data.message;
                    var text = textOfBlocks(message && message.content).replace(/\s+/g, ' ').trim();
                    if (text) {
                      setSnippet(text.slice(0, 96) + (text.length > 96 ? '…' : ''));
                      return;
                    }
                  }
                }
                setSnippet('');
              } catch (e) {
                setSnippet('');
              }
            };
            read();
            if (source && typeof source.subscribe === 'function') unsub = source.subscribe(read);
          }).catch(function () {
            if (alive) setSnippet('');
          });
          return function () {
            alive = false;
            if (typeof unsub === 'function') {
              try {
                unsub();
              } catch (e) {
                /* ignore */
              }
            }
          };
        }, [sessionId]);
        return snippet;
      }

      /* ------------------------------------------------------------------ *
       * 原生对话里的工作台零件（四个槽位，一个都不重画聊天）
       * ------------------------------------------------------------------ */

      function OpenWorkbenchAction() {
        return h(
          'button',
          { type: 'button', className: 'dsa-chat-btn', title: t('title'), onClick: openWorkbenchPanel },
          h('span', { className: 'dsa-chat-glyph' }, '▤'),
          ' ' + t('tailTitle')
        );
      }

      function WorkbenchTail(props) {
        var tuple = useWorkbenchState(10000, [props.seq]);
        var state = tuple[0];
        if (!state || !state.active || !props.sessionId || state.active.sessionId !== props.sessionId) return null;
        var summary = state.summary || {};
        var totals = state.totals || {};
        return h(
          'div',
          { className: 'dsa-tail' },
          h('span', { className: 'dsa-chat-dot ' + (totals.fail ? 'err' : 'ok') }),
          h('b', null, t('tailTitle')),
          h(
            'span',
            null,
            state.active.name
              + ' · 完成 ' + (summary.done || 0)
              + ' · 待裁定 ' + (summary.review || 0)
              + ' · 未过 ' + (totals.fail || 0)
          ),
          h('button', { type: 'button', className: 'dsa-chat-btn', onClick: openWorkbenchPanel }, t('tailOpen'))
        );
      }

      function NextStepControl(props) {
        var tuple = useWorkbenchState(8000, [props.sessionId]);
        var state = tuple[0];
        var reload = tuple[1];
        var busyTuple = useState(false);
        var busy = busyTuple[0];
        var setBusy = busyTuple[1];
        var noteTuple = useState('');
        var note = noteTuple[0];
        var setNote = noteTuple[1];
        if (!state || !state.active || !props.sessionId || state.active.sessionId !== props.sessionId) return null;
        var next = state.next;
        if (!next) return h('span', { className: 'dsa-hint' }, t('nextAllDone'));
        var runnable = Boolean(next.script) && next.status !== 'running';
        var click = function click() {
          if (!runnable) {
            openWorkbenchPanel();
            return;
          }
          setBusy(true);
          setNote('');
          request('POST', '/stage/run', { stageId: next.id }).then(function (json) {
            if (json && json.ok) {
              setNote(t('nextRunStarted') + next.name);
              void reload();
            } else {
              setNote(t('nextRunFailed') + ((json && json.error) || '未知错误'));
            }
          }).catch(function (e) {
            setNote(t('nextRunFailed') + String((e && e.message) || e));
          }).then(function () {
            setBusy(false);
          });
        };
        return h(
          'span',
          { className: 'dsa-inline', style: { gap: '6px' } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-chat-btn',
              disabled: busy,
              title: runnable ? '在工作台里运行「' + next.name + '」' : t('nextManual'),
              onClick: click
            },
            busy ? '…' : (runnable ? '▶ ' : '→ ') + t('nextStep') + ' · ' + next.name
          ),
          note ? h('span', { className: 'dsa-hint' }, note) : null
        );
      }

      var TOOL_LABELS = {
        data_analysis_status: '工作台状态',
        data_analysis_list_stages: '阶段清单',
        data_analysis_figures: '图表合规',
        data_analysis_create_project: '新建项目',
        data_analysis_open_project: '打开项目',
        data_analysis_run_stage: '运行阶段',
        data_analysis_run_log: '运行日志',
        data_analysis_cancel_stage: '取消运行',
        data_analysis_adjudicate: '人工裁定',
        data_analysis_configure: '修改配置',
        data_analysis_doctor: '环境自检',
        data_analysis_draft: 'AI 起草'
      };

      function makeToolRow(toolName) {
        return function WorkbenchToolRow(props) {
          var phase = props.phase || '';
          var block = props.block || {};
          var text = phase === 'result' ? textOfBlocks(block.content) : '';
          text = text.replace(/\s+/g, ' ').trim();
          if (text.length > 160) text = text.slice(0, 160) + '…';
          return h(
            'div',
            { className: 'dsa-toolrow', 'data-tool': toolName },
            h('span', { className: 'dsa-tool-dot' }),
            h('span', { className: 'dsa-tool-name' }, TOOL_LABELS[toolName] || toolName),
            h('span', { className: 'dsa-tool-text', title: text }, phase === 'result' ? text || '完成' : '调用中…')
          );
        };
      }

      var DATA_TOOLS = Object.keys(TOOL_LABELS);

      /* ------------------------------------------------------------------ *
       * 样式
       * ------------------------------------------------------------------ */

      var CSS = [
        // 变量挂在面板根上，不写 :root —— 别把宿主全局的 --dsa-* 污染了
        // 方向 C（卡片仪表盘）：白卡片浮在浅灰底上，圆角 + 极轻阴影，状态用「软色底 + 文字」而不是只靠色点
        '.dsa-root{',
        '  --dsa-bg:#f4f5f7;--dsa-band:#f7f8fa;--dsa-panel:#fff;--dsa-card:#fff;--dsa-card2:#fafbfc;',
        '  --dsa-ink:#12141a;--dsa-ink2:#5a6070;--dsa-ink3:#666c7b;',
        '  --dsa-line:#e6e8ec;--dsa-line2:#d5d8e0;',
        '  --dsa-accent:#1e40af;--dsa-accent2:#3b6fe0;--dsa-soft:#eef2fd;',
        '  --dsa-ok:#0f7a4a;--dsa-oksoft:#e7f6ee;--dsa-warn:#9a6400;--dsa-warnsoft:#fdf4e3;',
        '  --dsa-err:#b42c22;--dsa-errsoft:#fdecea;--dsa-ctl:#7d8492;--dsa-hover:#eceef2;--dsa-sel:#fff;',
        '  --dsa-r:12px;--dsa-r2:8px;--dsa-shadow:0 1px 3px rgba(16,24,40,.05);--dsa-shadow2:0 2px 6px rgba(16,24,40,.07);',
        '  --dsa-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;',
        '  --dsa-sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
        '}',
        '[data-dsa-theme="dark"]{',
        '  --dsa-bg:#0f1116;--dsa-band:#14171d;--dsa-panel:#171a21;--dsa-card:#171a21;--dsa-card2:#1b1f27;',
        '  --dsa-ink:#e9ecf2;--dsa-ink2:#aab2c1;--dsa-ink3:#8b93a4;',
        '  --dsa-line:#252a34;--dsa-line2:#333a47;',
        '  --dsa-accent:#7aa2f7;--dsa-accent2:#9dbcf9;--dsa-soft:#1a2233;',
        '  --dsa-ok:#5cc08f;--dsa-oksoft:#12261d;--dsa-warn:#d9a94e;--dsa-warnsoft:#2a2113;',
        '  --dsa-err:#e08a82;--dsa-errsoft:#2b1513;--dsa-ctl:#6f7787;--dsa-hover:#1d212a;--dsa-sel:#1d212a;',
        '  --dsa-shadow:0 1px 3px rgba(0,0,0,.45);--dsa-shadow2:0 2px 8px rgba(0,0,0,.55);',
        '}',
        '.dsa-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsa-bg);color:var(--dsa-ink);',
        '  font-family:var(--dsa-sans);font-size:13.5px;line-height:1.55;-webkit-font-smoothing:antialiased;}',
        '.dsa-root *{box-sizing:border-box;}',
        '.dsa-root :focus-visible{outline:2px solid var(--dsa-accent);outline-offset:2px;}',
        '.dsa-root button{font-family:inherit;}',
        '.dsa-top{height:44px;flex:0 0 44px;display:flex;align-items:center;gap:12px;padding:0 14px;',
        '  background:var(--dsa-panel);border-bottom:1px solid var(--dsa-line);}',
        '.dsa-brand{display:flex;align-items:baseline;gap:8px;min-width:0;}',
        '.dsa-brand b{font-size:13.5px;font-weight:600;letter-spacing:.2px;white-space:nowrap;}',
        '.dsa-brand span{color:var(--dsa-ink3);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-spacer{flex:1 1 auto;}',
        '.dsa-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsa-line);',
        '  border-radius:3px;color:var(--dsa-ink2);font-size:11.5px;background:transparent;white-space:nowrap;}',
        '.dsa-chip.ok{color:var(--dsa-ok);border-color:color-mix(in srgb,var(--dsa-ok) 35%,var(--dsa-line));}',
        '.dsa-chip.warn{color:var(--dsa-warn);border-color:color-mix(in srgb,var(--dsa-warn) 35%,var(--dsa-line));}',
        '.dsa-chip.err{color:var(--dsa-err);border-color:color-mix(in srgb,var(--dsa-err) 35%,var(--dsa-line));}',
        // 默认按钮要有「填充」才像按钮：原来白底白边框，落在白色弹窗里就成了一条细线
        '.dsa-btn{appearance:none;height:30px;padding:0 11px;border:1px solid var(--dsa-line2);border-radius:4px;',
        '  background:var(--dsa-band);color:var(--dsa-ink);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;}',
        '.dsa-btn:hover{background:var(--dsa-hover);}',
        '.dsa-btn:disabled{opacity:.5;cursor:default;}',
        '.dsa-btn.primary{background:var(--dsa-accent);border-color:var(--dsa-accent);color:#fff;}',
        '[data-dsa-theme="dark"] .dsa-btn.primary{color:#0f1216;}',
        '.dsa-btn.primary:hover{background:color-mix(in srgb,var(--dsa-accent) 88%,#000);}',
        '.dsa-btn.danger{color:var(--dsa-err);border-color:color-mix(in srgb,var(--dsa-err) 40%,var(--dsa-line2));}',
        '.dsa-btn.ghost{border-color:transparent;background:transparent;color:var(--dsa-ink2);}',
        '.dsa-btn.ghost:hover{background:var(--dsa-hover);color:var(--dsa-ink);}',
        // 设置常驻顶栏：图标+文字，窄屏只留齿轮（标题/无障碍名还在，不会变成无字按钮）
        '.dsa-settings-btn{display:inline-flex;align-items:center;gap:5px;}',
        '.dsa-settings-btn .dsa-ico{font-size:13px;line-height:1;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-settings-btn .dsa-settings-label{display:none;}',
        // 空状态三步动线：编号列表，弱化正文但让「第几步」一眼可数
        '.dsa-steps{margin:12px 0 10px;padding-left:20px;color:var(--dsa-ink2);font-size:12.5px;line-height:1.85;}',
        '.dsa-steps li::marker{color:var(--dsa-ink3);font-variant-numeric:tabular-nums;}',
        '.dsa-steps b{color:var(--dsa-ink);font-weight:600;}',
        '.dsa-body{flex:1 1 auto;display:flex;min-height:0;}',
        '.dsa-rail{flex:0 0 296px;width:296px;border-right:1px solid var(--dsa-line);background:var(--dsa-band);',
        '  overflow-y:auto;padding:6px 0 16px;}',
        '.dsa-rail-h{padding:10px 14px 6px;color:var(--dsa-ink2);font-size:11.5px;font-weight:600;}',
        // 左栏顶部的项目区：项目是「你在哪儿干活」，比阶段更高一层，所以给它独立的分区 + 卡片行
        '.dsa-rail-sec{border-bottom:1px solid var(--dsa-line);padding-bottom:8px;margin-bottom:4px;}',
        '.dsa-rail-h .dsa-count{margin-left:6px;color:var(--dsa-ctl);font-weight:400;}',
        '.dsa-proj-list{padding:0 8px;}',
        '.dsa-proj{display:block;width:100%;text-align:left;border:0;background:transparent;font:inherit;',
        '  padding:5px 8px;border-radius:4px;cursor:pointer;color:inherit;}',
        '.dsa-proj:hover{background:var(--dsa-hover);}',
        '.dsa-proj.sel{background:var(--dsa-panel);box-shadow:inset 2px 0 0 var(--dsa-accent);}',
        '.dsa-proj-name{display:block;font-size:12.5px;color:var(--dsa-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-proj.sel .dsa-proj-name{font-weight:600;}',
        '.dsa-proj-path{display:block;margin-top:1px;font-size:11px;color:var(--dsa-ink3);overflow:hidden;',
        '  text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-link{border:0;background:transparent;color:var(--dsa-ink2);font:inherit;font-size:11.5px;',
        '  cursor:pointer;padding:2px 0;}',
        '.dsa-link:hover{color:var(--dsa-accent);}',
        '.dsa-proj-actions{display:flex;gap:12px;padding:4px 16px 0;}',
        '.dsa-stage{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;cursor:pointer;border-left:3px solid transparent;',
        '  width:100%;border-top:0;border-right:0;border-bottom:0;background:transparent;text-align:left;color:inherit;font:inherit;}',
        '.dsa-stage:hover{background:var(--dsa-hover);}',
        '.dsa-stage.sel{background:var(--dsa-sel);border-left-color:var(--dsa-accent);}',
        '.dsa-idx{flex:0 0 20px;height:20px;border-radius:50%;border:1px solid var(--dsa-line2);color:var(--dsa-ink3);',
        '  font-size:11px;font-family:var(--dsa-mono);display:flex;align-items:center;justify-content:center;margin-top:1px;}',
        '.dsa-stage.done .dsa-idx{border-color:var(--dsa-ok);color:var(--dsa-ok);}',
        '.dsa-stage.blocked .dsa-idx{border-color:var(--dsa-err);color:var(--dsa-err);}',
        '.dsa-stage.review .dsa-idx{border-color:var(--dsa-warn);color:var(--dsa-warn);}',
        '.dsa-stage.running .dsa-idx{border-color:var(--dsa-accent);color:var(--dsa-accent);}',
        '.dsa-stage-main{min-width:0;flex:1 1 auto;}',
        '.dsa-stage-name{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:500;line-height:1.35;}',
        '.dsa-stage-name .dot{width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:var(--dsa-ctl);}',
        '.dsa-stage-name .dot.pass{background:var(--dsa-ok);}',
        '.dsa-stage-name .dot.fail{background:var(--dsa-err);}',
        '.dsa-stage-name .dot.warn{background:var(--dsa-warn);}',
        '.dsa-stage-name .dot.run{background:var(--dsa-accent);}',
        '.dsa-stage-meta{margin-top:2px;color:var(--dsa-ink3);font-size:11.5px;',
        '  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        // 还没轮到的阶段退到背景里：当前该看哪一步，靠「已完成 / 等你拍板 / 未开始」的明暗差来指路
        '.dsa-stage.todo{opacity:.48;}',
        '.dsa-stage.todo .dsa-stage-name{color:var(--dsa-ink3);font-weight:400;}',
        '.dsa-stage.todo .dsa-idx{border-color:var(--dsa-line);color:var(--dsa-ink3);}',
        '.dsa-stage.todo .dot{background:transparent;box-shadow:inset 0 0 0 1px var(--dsa-ctl);}',
        '.dsa-stage.todo:hover{opacity:.82;}',
        '.dsa-stage.sel{opacity:1;}',
        '.dsa-main{flex:1 1 auto;min-width:0;overflow-y:auto;padding:20px 24px 44px;}',
        '.dsa-side{flex:0 0 352px;width:352px;border-left:1px solid var(--dsa-line);background:var(--dsa-band);',
        '  display:flex;flex-direction:column;min-height:0;}',
        '.dsa-side.hide{display:none;}',
        '.dsa-h1{font-size:20px;font-weight:600;letter-spacing:.1px;margin:0 0 3px;line-height:1.25;}',
        '.dsa-sub{color:var(--dsa-ink2);margin:0 0 14px;font-size:12.5px;line-height:1.55;}',
        '.dsa-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.dsa-section{margin:22px 0 9px;display:flex;align-items:baseline;gap:8px;}',
        '.dsa-section h3{font-size:15px;font-weight:600;color:var(--dsa-ink);margin:0;}',
        '.dsa-section .count{color:var(--dsa-ink3);font-size:11.5px;font-variant-numeric:tabular-nums;}',
        '.dsa-card{border:1px solid var(--dsa-line);border-radius:6px;background:var(--dsa-panel);}',
        '.dsa-pad{padding:12px 14px;}',
        '.dsa-gate{display:flex;gap:10px;padding:10px 14px;border-top:1px solid var(--dsa-line);align-items:flex-start;}',
        '.dsa-gate:first-child{border-top:0;}',
        '.dsa-gate .mark{flex:0 0 17px;font-family:var(--dsa-mono);font-size:13px;line-height:1.5;}',
        '.dsa-gate.pass .mark{color:var(--dsa-ok);}',
        '.dsa-gate.fail .mark{color:var(--dsa-err);}',
        '.dsa-gate.unjudged .mark{color:var(--dsa-ctl);}',
        '.dsa-gate.todo .mark{color:var(--dsa-ctl);}',
        '.dsa-gate.manual .mark{color:var(--dsa-warn);}',
        '.dsa-gate-body{flex:1 1 auto;min-width:0;}',
        '.dsa-gate-label{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;}',
        '.dsa-gate-detail{color:var(--dsa-ink2);font-size:12px;margin-top:2px;word-break:break-word;line-height:1.5;}',
        '.dsa-tag{display:inline-block;height:18px;line-height:17px;padding:0 6px;border-radius:3px;font-size:11px;',
        '  border:1px solid var(--dsa-line2);color:var(--dsa-ink3);}',
        '.dsa-tag.err{color:var(--dsa-err);border-color:color-mix(in srgb,var(--dsa-err) 45%,var(--dsa-line2));}',
        '.dsa-tag.manual{color:var(--dsa-accent);border-color:color-mix(in srgb,var(--dsa-accent) 40%,var(--dsa-line2));}',
        '.dsa-code{font-family:var(--dsa-mono);font-size:12px;background:var(--dsa-bg);border:1px solid var(--dsa-line);',
        '  border-radius:4px;padding:9px 10px;color:var(--dsa-ink2);white-space:pre-wrap;overflow-wrap:anywhere;}',
        '.dsa-flow{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;}',
        '.dsa-flow-step{border:1px solid var(--dsa-line);border-radius:4px;padding:7px 10px;min-width:92px;background:var(--dsa-panel);}',
        '.dsa-flow-step .s{color:var(--dsa-ink3);font-size:11.5px;}',
        '.dsa-flow-step .n{font-family:var(--dsa-mono);font-size:18px;font-variant-numeric:tabular-nums;margin-top:1px;}',
        '.dsa-flow-step.bad{border-color:color-mix(in srgb,var(--dsa-err) 55%,var(--dsa-line));}',
        '.dsa-table{width:100%;border-collapse:collapse;font-size:12px;}',
        '.dsa-table th{text-align:left;font-weight:500;color:var(--dsa-ink2);border-bottom:1px solid var(--dsa-line);padding:7px 8px;white-space:nowrap;}',
        '.dsa-table td{border-bottom:1px solid var(--dsa-line);padding:7px 8px;vertical-align:top;}',
        '.dsa-table tr:last-child td{border-bottom:0;}',
        '.dsa-mono{font-family:var(--dsa-mono);font-variant-numeric:tabular-nums;}',
        '.dsa-badge{display:inline-flex;align-items:center;height:17px;line-height:16px;padding:0 6px;border-radius:3px;',
        '  font-size:11px;margin:0 4px 3px 0;white-space:nowrap;}',
        '.dsa-badge.pass{color:var(--dsa-ok);background:color-mix(in srgb,var(--dsa-ok) 10%,transparent);}',
        '.dsa-badge.fail{color:var(--dsa-err);background:color-mix(in srgb,var(--dsa-err) 12%,transparent);}',
        '.dsa-badge.unjudged{color:var(--dsa-ink3);background:color-mix(in srgb,var(--dsa-ctl) 14%,transparent);}',
        '.dsa-side-h{flex:0 0 auto;height:42px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--dsa-line);background:var(--dsa-panel);}',
        '.dsa-side-h b{font-size:12.5px;font-weight:600;color:var(--dsa-ink);}',
        '.dsa-runs{flex:0 0 auto;max-height:42%;overflow-y:auto;border-bottom:1px solid var(--dsa-line);background:var(--dsa-panel);}',
        '.dsa-run{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-left:2px solid transparent;',
        '  width:100%;border-top:0;border-right:0;border-bottom:0;background:transparent;text-align:left;color:inherit;font:inherit;}',
        '.dsa-run:hover{background:var(--dsa-hover);}',
        '.dsa-run.sel{background:var(--dsa-sel);border-left-color:var(--dsa-accent);}',
        '.dsa-run .st{font-size:11.5px;width:46px;flex:0 0 46px;color:var(--dsa-ink3);}',
        '.dsa-run .st.ok{color:var(--dsa-ok);}.dsa-run .st.failed{color:var(--dsa-err);}',
        '.dsa-run .st.cancelled{color:var(--dsa-warn);}.dsa-run .st.running{color:var(--dsa-accent);}',
        '.dsa-run .sid{flex:1 1 auto;min-width:0;font-size:12.5px;color:var(--dsa-ink);',
        '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-log{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px;font-family:var(--dsa-mono);font-size:11.5px;',
        '  line-height:1.7;color:var(--dsa-ink2);white-space:pre-wrap;word-break:break-all;background:var(--dsa-bg);}',
        '.dsa-log .ln-err{color:var(--dsa-err);}',
        '.dsa-log .ln-warn{color:var(--dsa-warn);}',
        '.dsa-empty{padding:24px 14px;color:var(--dsa-ink3);font-size:12.5px;text-align:center;}',
        '.dsa-empty b{display:block;color:var(--dsa-ink);font-size:15px;font-weight:600;margin-bottom:6px;}',
        '.dsa-form{max-width:560px;display:flex;flex-direction:column;gap:10px;}',
        '.dsa-field{display:flex;flex-direction:column;gap:4px;}',
        '.dsa-field label{font-size:12px;color:var(--dsa-ink2);}',
        '.dsa-input{height:32px;padding:0 9px;border:1px solid var(--dsa-ctl);border-radius:4px;background:var(--dsa-panel);',
        '  color:var(--dsa-ink);font:inherit;font-size:13px;width:100%;}',
        '.dsa-input:focus{outline:none;border-color:var(--dsa-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsa-accent) 18%,transparent);}',
        '.dsa-hint{color:var(--dsa-ink3);font-size:12px;line-height:1.55;}',
        '.dsa-error{color:var(--dsa-err);font-size:12px;background:color-mix(in srgb,var(--dsa-err) 8%,transparent);',
        '  border:1px solid color-mix(in srgb,var(--dsa-err) 30%,var(--dsa-line));border-radius:3px;padding:8px 10px;}',
        '.dsa-ok-note{color:var(--dsa-ok);font-size:12px;}',
        '.dsa-mask{position:absolute;inset:0;background:rgba(20,20,18,.32);display:flex;align-items:center;justify-content:center;',
        '  z-index:40;padding:20px;}',
        '.dsa-modal{width:min(620px,100%);max-height:88%;overflow:auto;background:var(--dsa-panel);border:1px solid var(--dsa-line2);',
        '  border-radius:5px;padding:18px 20px;}',
        '.dsa-modal h2{margin:0 0 4px;font-size:15px;font-weight:600;}',
        '.dsa-modal p{margin:0 0 12px;color:var(--dsa-ink3);font-size:12px;}',
        '.dsa-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}',
        '.dsa-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.dsa-split{display:grid;grid-template-columns:1fr 1fr;gap:14px;}',
        '.dsa-drawer-toggle{display:none;}',
        // 断点按「面板自身宽度」而不是窗口宽度：宿主侧栏可能已折叠，两者能差 200px 以上
        '.dsa-root[data-dsa-width="compact"] .dsa-side{position:absolute;right:0;top:44px;bottom:0;z-index:30;',
        '  box-shadow:none;border-left:1px solid var(--dsa-line2);}',
        '.dsa-root[data-dsa-width="compact"] .dsa-side.hide{display:none;}',
        '.dsa-root[data-dsa-width="compact"] .dsa-drawer-toggle{display:inline-flex;}',
        // 面板 1160px 左右时三栏只剩 500px 给主区：右栏也改成抽屉，别把表格挤变形
        '.dsa-root[data-dsa-width="mid"] .dsa-side{position:absolute;right:0;top:44px;bottom:0;z-index:30;',
        '  border-left:1px solid var(--dsa-line2);}',
        '.dsa-root[data-dsa-width="mid"] .dsa-side.hide{display:none;}',
        '.dsa-root[data-dsa-width="mid"] .dsa-drawer-toggle{display:inline-flex;}',
        '.dsa-root[data-dsa-width="compact"] .dsa-rail{flex-basis:240px;width:240px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-rail{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-main{padding:14px;}',
        '.dsa-banner{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin:0 0 12px;padding:9px 11px;',
        '  border:1px solid color-mix(in srgb,var(--dsa-err) 34%,var(--dsa-line));',
        '  background:color-mix(in srgb,var(--dsa-err) 7%,transparent);border-radius:3px;}',
        '.dsa-banner b{color:var(--dsa-err);font-size:12px;white-space:nowrap;}',
        '.dsa-banner .dsa-banner-text{flex:1 1 180px;min-width:120px;color:var(--dsa-ink2);font-size:11.5px;line-height:1.5;word-break:break-word;}',
        '.dsa-check{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--dsa-line);font-size:11.5px;}',
        '.dsa-check:last-child{border-bottom:none;}',
        '.dsa-check-mark{flex:0 0 14px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;}',
        '.dsa-check.pass .dsa-check-mark{color:var(--dsa-ok);}',
        '.dsa-check.fail .dsa-check-mark{color:var(--dsa-err);}',
        '.dsa-check.warn .dsa-check-mark{color:var(--dsa-warn);}',
        '.dsa-check.unjudged .dsa-check-mark{color:var(--dsa-ink3);}',
        '.dsa-check-body{flex:1 1 auto;min-width:0;line-height:1.5;word-break:break-word;}',
        '.dsa-check-label{color:var(--dsa-ink);}',
        '.dsa-check-detail{color:var(--dsa-ink3);}',
        '.dsa-check-advice{color:var(--dsa-warn);}',
        '.dsa-draft-out{margin:0;padding:9px 11px;border:1px solid var(--dsa-line);background:var(--dsa-bg);',
        '  border-radius:2px;max-height:44vh;overflow:auto;white-space:pre-wrap;word-break:break-word;',
        '  font-family:var(--dsa-sans);font-size:12px;line-height:1.7;color:var(--dsa-ink);}',
        '.dsa-model-line{font-family:var(--dsa-mono);font-size:11px;color:var(--dsa-ink3);}',
        '.dsa-draft-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsa-ink3);}',
        // 研究对话：面板里的会话卡、对话里的工作台徽章
        '.dsa-chat-card{border:1px solid var(--dsa-line);border-radius:3px;background:var(--dsa-bg);padding:9px 10px;',
        '  display:flex;flex-direction:column;gap:6px;}',
        '.dsa-chat-card .dsa-hint{line-height:1.5;}',
        '.dsa-chat-id{font-family:var(--dsa-mono);font-size:11px;color:var(--dsa-ink3);word-break:break-all;}',
        '.dsa-chat-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:5px;background:var(--dsa-ink3);}',
        '.dsa-chat-dot.run{background:var(--dsa-accent);}',
        '.dsa-chat-dot.ok{background:var(--dsa-ok);}',
        '.dsa-chat-dot.err{background:var(--dsa-err);}',
        '.dsa-chat-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border:1px solid var(--dsa-line2);',
        '  border-radius:3px;background:var(--dsa-panel);color:var(--dsa-ink2);font:inherit;font-size:11.5px;cursor:pointer;}',
        '.dsa-chat-btn:hover{background:var(--dsa-bg);color:var(--dsa-ink);}',
        '.dsa-chat-glyph{font-size:12px;line-height:1;}',
        '.dsa-tail{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:4px 0 2px;padding:3px 7px;',
        '  border:1px solid var(--dsa-line);border-radius:3px;background:var(--dsa-bg);font-size:11px;color:var(--dsa-ink3);}',
        '.dsa-tail b{color:var(--dsa-ink2);font-weight:600;}',
        '.dsa-toolrow{display:flex;align-items:baseline;gap:7px;padding:3px 0;font-size:11.5px;color:var(--dsa-ink3);',
        '  min-width:0;}',
        '.dsa-tool-dot{width:5px;height:5px;border-radius:50%;background:var(--dsa-accent);flex:0 0 auto;}',
        '.dsa-tool-name{color:var(--dsa-ink2);flex:0 0 auto;}',
        '.dsa-tool-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        // 窄屏没有阶段栏：用下拉补一个入口，否则只能看当前阶段、无法切换
        '.dsa-stage-select{display:none;height:26px;max-width:190px;padding:0 6px;border:1px solid var(--dsa-line2);',
        '  border-radius:3px;background:var(--dsa-panel);color:var(--dsa-ink);font:inherit;font-size:11.5px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-stage-select{display:inline-flex;}',
        // 744px 时标题会被挤成 0 宽：窄屏只保留「标题 + 阶段下拉 + 动作」，技能包徽章退场
        '.dsa-root[data-dsa-width="narrow"] .dsa-chip.ok{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-brand span{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-top{gap:7px;padding:0 10px;}',
        // 窄屏的右栏必须是抽屉：默认显示会把主区挤到一半
        '.dsa-root[data-dsa-width="narrow"] .dsa-side{position:absolute;right:0;top:44px;bottom:0;z-index:30;',
        '  border-left:1px solid var(--dsa-line2);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-side.hide{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-drawer-toggle{display:inline-flex;}',
        // 「下一步」条：面板要有一句话说清现在卡在哪、该点哪个按钮
        '.dsa-next{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;margin:0 0 18px;',
        '  border:1px solid var(--dsa-line);border-left:3px solid var(--dsa-accent);border-radius:6px;background:var(--dsa-panel);}',
        '.dsa-next.done{border-left-color:var(--dsa-ok);}',
        '.dsa-next.blocked{border-left-color:var(--dsa-err);}',
        '.dsa-next.review{border-left-color:var(--dsa-warn);}',
        '.dsa-next.run{border-left-color:var(--dsa-accent);}',
        // tone 直接取 stage.status：running 也是合法取值，todo 走默认色，别让它们悄悄没样式
        '.dsa-next.running{border-left-color:var(--dsa-accent);}',
        '.dsa-next.todo{border-left-color:var(--dsa-ctl);}',
        '.dsa-next-label{font-size:11.5px;font-weight:600;color:var(--dsa-accent);flex:0 0 auto;}',
        '.dsa-next-body{flex:1 1 260px;min-width:0;}',
        '.dsa-next-line{font-size:14px;font-weight:600;line-height:1.4;}',
        '.dsa-next-sub{color:var(--dsa-ink2);font-size:12.5px;margin-top:3px;line-height:1.5;word-break:break-word;}',
        // 折叠「已通过」与「技术细节」共用
        '.dsa-fold{margin-top:8px;border:1px solid var(--dsa-line);border-radius:6px;background:var(--dsa-panel);}',
        '.dsa-fold>summary{cursor:pointer;padding:9px 14px;font-size:12.5px;color:var(--dsa-ink2);list-style:none;}',
        '.dsa-fold>summary::-webkit-details-marker{display:none;}',
        '.dsa-fold>summary:before{content:"▸";display:inline-block;width:14px;color:var(--dsa-ink3);}',
        '.dsa-fold[open]>summary:before{content:"▾";}',
        // AI 接手：一个入口，三种意图
        '.dsa-menu{position:relative;}',
        '.dsa-menu>summary{list-style:none;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;',
        '  border:1px solid var(--dsa-line2);border-radius:4px;background:var(--dsa-panel);font-size:12.5px;cursor:pointer;white-space:nowrap;}',
        '.dsa-menu>summary::-webkit-details-marker{display:none;}',
        '.dsa-menu[open]>summary{background:var(--dsa-hover);}',
        '.dsa-menu-list{position:absolute;right:0;top:34px;z-index:35;min-width:252px;padding:5px;background:var(--dsa-panel);',
        '  border:1px solid var(--dsa-line2);border-radius:6px;}',
        '.dsa-menu-list button{display:block;width:100%;text-align:left;padding:8px 9px;border:0;border-radius:4px;background:transparent;',
        '  color:var(--dsa-ink);font:inherit;font-size:12.5px;cursor:pointer;}',
        '.dsa-menu-list button:hover{background:var(--dsa-hover);}',
        '.dsa-menu-list button .dsa-hint{display:block;margin-top:2px;padding:0;}',
        // 抽屉遮罩：点哪里都能关，Esc 也行
        '.dsa-scrim{position:absolute;inset:44px 0 0 0;background:rgba(20,20,18,.22);z-index:29;}',
        // 只给读屏用的播报区：视觉上不可见，但不能用 display:none（那样读屏也读不到）
        '.dsa-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
        '.dsa-agg{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 8px;}',
        '.dsa-kv{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsa-ink2);}',
        '.dsa-kv b{font-family:var(--dsa-mono);font-variant-numeric:tabular-nums;}',
        '.dsa-run .tm{flex:0 0 74px;font-size:11px;color:var(--dsa-ink3);font-variant-numeric:tabular-nums;}',
        '.dsa-run .ex{flex:0 0 30px;text-align:right;font-family:var(--dsa-mono);font-size:11px;color:var(--dsa-ink3);}',
        '.dsa-run-h{padding:8px 12px;border-bottom:1px solid var(--dsa-line);font-size:11.5px;color:var(--dsa-ink2);}',
        '.dsa-run-h .dsa-kv{gap:12px;}',
        '.dsa-chat-card summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;}',
        '.dsa-chat-card summary::-webkit-details-marker{display:none;}',
        '.dsa-chat-card .dsa-chat-more{display:flex;flex-direction:column;gap:6px;margin-top:7px;}',
        '.dsa-issue-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
        '.dsa-patch-pre{max-height:220px;overflow:auto;margin:6px 0 0;padding:8px 10px;border:1px solid var(--dsa-line);',
        '  background:var(--dsa-bg);border-radius:2px;font-family:var(--dsa-mono);font-size:11px;white-space:pre-wrap;word-break:break-word;}',
        '.dsa-inline-tight{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap;}',

        /* ================================================================== *
         * 方向 C：卡片仪表盘
         *
         * 这一层放在数组最后，只覆盖「形状与密度」，一个功能类名都没改——
         * 所以行为完全沿用上面的规则，改的只是看起来的样子。
         * 三条硬口径：① 状态永远有文字，不只靠颜色 ② 数字等宽对齐
         *            ③ 项目多时列表自己滚，不把下面的阶段挤走
         * ================================================================== */

        // ---- 顶栏：58px、圆角渐变标、pill 徽章、有填充的按钮
        '.dsa-top{height:58px;flex:0 0 58px;gap:10px;padding:0 18px;}',
        '.dsa-logo{flex:0 0 30px;width:30px;height:30px;border-radius:9px;',
        '  background:linear-gradient(140deg,var(--dsa-accent2),var(--dsa-accent));display:flex;align-items:center;',
        '  justify-content:center;color:#fff;font-size:14px;font-weight:700;',
        '  box-shadow:0 2px 6px color-mix(in srgb,var(--dsa-accent) 30%,transparent);}',
        '[data-dsa-theme="dark"] .dsa-logo{color:#0f1216;}',
        '.dsa-brand{display:flex;align-items:center;gap:9px;min-width:0;}',
        '.dsa-brand-tx{display:flex;flex-direction:column;min-width:0;line-height:1.32;}',
        '.dsa-brand b{font-size:13.5px;font-weight:650;letter-spacing:-.01em;}',
        '.dsa-brand-tx span{font-size:11px;color:var(--dsa-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-chip{height:28px;padding:0 12px;border-radius:999px;background:var(--dsa-card2);}',
        '.dsa-btn{height:32px;padding:0 13px;border-radius:var(--dsa-r2);background:var(--dsa-panel);',
        '  transition:background .16s,border-color .16s,box-shadow .16s,transform .06s;}',
        '.dsa-btn:hover{background:var(--dsa-card2);border-color:var(--dsa-line2);}',
        '.dsa-btn:active{transform:translateY(.5px);}',
        '.dsa-btn.ghost{background:transparent;border-color:transparent;}',
        '.dsa-btn.ghost:hover{background:var(--dsa-hover);}',
        '.dsa-btn.primary{background:linear-gradient(180deg,var(--dsa-accent2),var(--dsa-accent));border-color:var(--dsa-accent);',
        '  box-shadow:0 1px 2px rgba(16,24,40,.14),inset 0 1px 0 rgba(255,255,255,.16);}',
        '.dsa-btn.primary:hover{background:linear-gradient(180deg,var(--dsa-accent2),var(--dsa-accent));',
        '  filter:brightness(1.07);}',
        '.dsa-stage-select,.dsa-menu>summary{height:32px;border-radius:var(--dsa-r2);font-size:12.5px;}',
        '.dsa-menu-list{top:38px;border-radius:10px;box-shadow:var(--dsa-shadow2);}',

        // ---- 左栏：分区 + 项目列表「自己滚」，阶段永远在下面看得见
        '.dsa-rail{flex:0 0 276px;width:276px;display:flex;flex-direction:column;min-height:0;overflow:hidden;',
        '  background:var(--dsa-bg);padding:12px 12px 0;border-right:1px solid var(--dsa-line);}',
        '.dsa-rail-sec{flex:0 1 auto;min-height:0;max-height:46%;display:flex;flex-direction:column;',
        '  padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid var(--dsa-line);}',
        '.dsa-rail-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 0 24px;}',
        '.dsa-rail-h{padding:0 6px 7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;',
        '  font-weight:650;color:var(--dsa-ink3);}',
        '.dsa-rail-h .dsa-count{margin-left:auto;font-family:var(--dsa-mono);font-size:11px;letter-spacing:0;',
        '  text-transform:none;background:var(--dsa-line);color:var(--dsa-ink2);padding:1px 6px;border-radius:999px;font-weight:400;}',
        '.dsa-proj-list{flex:0 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:0 2px 0 0;}',
        '.dsa-proj{padding:7px 8px;border:1px solid transparent;border-radius:var(--dsa-r2);',
        '  transition:background .16s,border-color .16s,box-shadow .16s;}',
        '.dsa-proj:hover{background:var(--dsa-hover);}',
        '.dsa-proj.sel{background:var(--dsa-panel);border-color:var(--dsa-line);box-shadow:var(--dsa-shadow);}',
        '.dsa-proj-h{display:flex;align-items:center;gap:7px;min-width:0;}',
        '.dsa-proj-av{flex:0 0 20px;width:20px;height:20px;border-radius:6px;background:var(--dsa-soft);',
        '  color:var(--dsa-accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;}',
        '.dsa-proj.sel .dsa-proj-av{background:linear-gradient(140deg,var(--dsa-accent2),var(--dsa-accent));color:#fff;}',
        '[data-dsa-theme="dark"] .dsa-proj.sel .dsa-proj-av{color:#0f1216;}',
        '.dsa-proj-name{font-size:12.5px;font-weight:550;}',
        '.dsa-proj-path{margin:1px 0 0 27px;font-family:var(--dsa-mono);font-size:11px;color:var(--dsa-ink3);}',
        '.dsa-proj-actions{gap:8px;padding:5px 4px 0;}',
        '.dsa-link{padding:3px 5px;border-radius:6px;font-size:11.5px;}',
        '.dsa-link:hover{background:var(--dsa-hover);}',

        // ---- 阶段行：圆号 + 名称 + 右侧状态徽章（徽章是文字，色弱也读得出）
        '.dsa-stage{padding:5px 8px;border:1px solid transparent;border-radius:var(--dsa-r2);align-items:center;',
        '  gap:9px;margin-bottom:1px;transition:background .16s,border-color .16s,box-shadow .16s;}',
        '.dsa-stage:hover{background:var(--dsa-hover);}',
        '.dsa-stage.sel{background:var(--dsa-panel);border-color:var(--dsa-line);border-left-color:var(--dsa-line);',
        '  box-shadow:var(--dsa-shadow);}',
        '.dsa-idx{flex:0 0 18px;width:18px;height:18px;border-radius:50%;background:var(--dsa-line);',
        '  border:1px solid transparent;color:var(--dsa-ink3);font-size:11px;font-weight:600;margin-top:0;line-height:1;}',
        '.dsa-stage.done .dsa-idx{background:var(--dsa-oksoft);color:var(--dsa-ok);',
        '  border-color:color-mix(in srgb,var(--dsa-ok) 30%,transparent);}',
        '.dsa-stage.blocked .dsa-idx{background:var(--dsa-errsoft);color:var(--dsa-err);',
        '  border-color:color-mix(in srgb,var(--dsa-err) 30%,transparent);}',
        '.dsa-stage.review .dsa-idx{background:var(--dsa-warnsoft);color:var(--dsa-warn);',
        '  border-color:color-mix(in srgb,var(--dsa-warn) 30%,transparent);}',
        '.dsa-stage.running .dsa-idx{background:var(--dsa-soft);color:var(--dsa-accent);}',
        '.dsa-stage-main{display:flex;align-items:center;gap:8px;}',
        '.dsa-stage-name{flex:1 1 auto;min-width:0;display:block;font-size:12.5px;',
        '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-stage-name .dot{display:none;}',
        '.dsa-stage-meta{flex:0 0 auto;margin-top:0;padding:1px 7px;border-radius:999px;background:var(--dsa-line);',
        '  color:var(--dsa-ink3);font-size:11px;font-weight:600;max-width:52%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-stage.done .dsa-stage-meta{background:var(--dsa-oksoft);color:var(--dsa-ok);}',
        '.dsa-stage.blocked .dsa-stage-meta{background:var(--dsa-errsoft);color:var(--dsa-err);}',
        '.dsa-stage.review .dsa-stage-meta{background:var(--dsa-warnsoft);color:var(--dsa-warn);}',
        '.dsa-stage.running .dsa-stage-meta{background:var(--dsa-soft);color:var(--dsa-accent);}',
        '.dsa-stage.todo{opacity:1;}',
        '.dsa-stage.todo .dsa-stage-name{color:var(--dsa-ink3);font-weight:400;}',

        // ---- 主区：hero 卡 + KPI 条 + 卡片化的段落
        '.dsa-main{padding:16px 20px 60px;background:var(--dsa-bg);}',
        '.dsa-hero{background:var(--dsa-panel);border:1px solid var(--dsa-line);border-radius:var(--dsa-r);',
        '  padding:16px 18px;box-shadow:var(--dsa-shadow);margin:0 0 14px;}',
        '.dsa-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:0 0 14px;}',
        '.dsa-kpi{background:var(--dsa-panel);border:1px solid var(--dsa-line);border-radius:var(--dsa-r);',
        '  padding:11px 13px;box-shadow:var(--dsa-shadow);min-width:0;}',
        '.dsa-kpi .k{font-size:11px;color:var(--dsa-ink3);letter-spacing:.04em;font-weight:550;',
        '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-kpi .v{font-family:var(--dsa-mono);font-size:21px;font-weight:600;letter-spacing:-.03em;margin-top:2px;',
        '  font-variant-numeric:tabular-nums;line-height:1.2;white-space:nowrap;}',
        '.dsa-kpi .v small{font-size:11px;color:var(--dsa-ink3);margin-left:2px;font-weight:400;letter-spacing:0;}',
        '.dsa-kpi.hi{background:linear-gradient(180deg,color-mix(in srgb,var(--dsa-soft) 65%,var(--dsa-panel)),var(--dsa-panel));',
        '  border-color:color-mix(in srgb,var(--dsa-accent) 22%,var(--dsa-line));}',
        '.dsa-kpi.hi .v{color:var(--dsa-accent);}',
        '.dsa-h1{font-size:20px;font-weight:680;letter-spacing:-.02em;}',
        '.dsa-sub{margin:4px 0 0;}',
        '.dsa-section{margin:20px 0 8px;}',
        '.dsa-section h3{font-size:13px;font-weight:650;letter-spacing:-.005em;}',
        '.dsa-card,.dsa-fold,.dsa-next{border-radius:var(--dsa-r);box-shadow:var(--dsa-shadow);}',
        '.dsa-next{padding:13px 16px;margin:0 0 14px;}',
        '.dsa-gate{padding:11px 15px;}',
        '.dsa-gate .mark{font-size:14px;}',
        '.dsa-code{border-radius:var(--dsa-r2);}',
        '.dsa-tag{border-radius:999px;padding:0 7px;height:19px;line-height:18px;}',
        '.dsa-badge{border-radius:999px;height:18px;line-height:17px;padding:0 7px;font-weight:550;}',

        // ---- 右栏：运行记录卡片 + 终端风格的日志卡（日志固定深色，像 C 的 .log）
        '.dsa-side{flex:0 0 330px;width:330px;background:var(--dsa-bg);padding-bottom:18px;}',
        '.dsa-side-h{height:46px;background:transparent;}',
        '.dsa-runs{flex:0 1 auto;max-height:34%;margin:12px 12px 0;overflow-y:auto;background:var(--dsa-panel);',
        '  border:1px solid var(--dsa-line);border-radius:var(--dsa-r);box-shadow:var(--dsa-shadow);}',
        '.dsa-run{padding:8px 12px;border-left:0;transition:background .16s;}',
        '.dsa-run.sel{background:var(--dsa-soft);box-shadow:inset 3px 0 0 var(--dsa-accent);}',
        '.dsa-run-h{margin:10px 12px 0;padding:9px 12px;border:1px solid var(--dsa-line);border-radius:var(--dsa-r);',
        '  background:var(--dsa-panel);box-shadow:var(--dsa-shadow);}',
        '.dsa-log{flex:1 1 auto;min-height:120px;margin:10px 12px 0;padding:11px 13px;border:1px solid #232a38;',
        '  border-radius:var(--dsa-r);background:#141821;color:#c3c9d6;}',
        '.dsa-log .ln-err{color:#e58d84;}',
        '.dsa-log .ln-warn{color:#dfb267;}',
        '.dsa-chat-card{margin:12px 12px 0;border-radius:var(--dsa-r);background:var(--dsa-panel);box-shadow:var(--dsa-shadow);}',

        // ---- 弹窗与输入：跟着圆角走，输入框加柔光圈
        '.dsa-modal{border-radius:14px;box-shadow:0 18px 50px rgba(16,24,40,.22);}',
        '.dsa-input,.dsa-btn,.dsa-chat-btn,.dsa-menu-list button,.dsa-flow-step{border-radius:var(--dsa-r2);}',

        // ---- 断点：顶栏变高了，抽屉与遮罩的起点要跟着改
        '.dsa-root[data-dsa-width="compact"] .dsa-rail{flex-basis:248px;width:248px;}',
        '.dsa-root[data-dsa-width="compact"] .dsa-kpis{grid-template-columns:repeat(3,1fr);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-kpis{grid-template-columns:repeat(2,1fr);}',
        '.dsa-root[data-dsa-width="compact"] .dsa-side,',
        '.dsa-root[data-dsa-width="mid"] .dsa-side,',
        '.dsa-root[data-dsa-width="narrow"] .dsa-side{top:58px;}',
        '.dsa-scrim{top:58px;}',

        // ---- 折叠行：卡里的折叠不能是「卡中卡」，独立折叠也要有可点的手感
        '.dsa-card .dsa-fold{margin-top:0;border:0;border-top:1px solid var(--dsa-line);border-radius:0;',
        '  background:transparent;box-shadow:none;}',
        '.dsa-card .dsa-fold>summary{padding:10px 15px;}',
        // 折叠行压在卡片底部时，hover 底色要跟着卡片圆角收，否则卡片下缘会露出直角
        '.dsa-card .dsa-fold:last-child>summary{border-radius:0 0 var(--dsa-r) var(--dsa-r);}',
        '.dsa-card .dsa-fold[open]:last-child>summary{border-radius:0;}',
        '.dsa-fold>summary{transition:background .15s;border-radius:inherit;}',
        '.dsa-fold>summary:hover{background:var(--dsa-hover);}',
        '.dsa-fold[open]>summary{border-bottom:1px solid var(--dsa-line);}',
        // 独立折叠（执行细节 · 命令）平时只是一行可点的说明，展开后才长出卡片边
        '.dsa-fold-quiet{margin:2px 0 0;border:0;border-radius:var(--dsa-r2);background:transparent;box-shadow:none;}',
        '.dsa-fold-quiet>summary{padding:7px 10px;font-size:12px;}',
        '.dsa-fold-quiet[open]{background:var(--dsa-card);border:1px solid var(--dsa-line);box-shadow:var(--dsa-shadow);}',
        '.dsa-fold-quiet[open]>summary{border-radius:var(--dsa-r2) var(--dsa-r2) 0 0;}',
        '.dsa-fold-body{padding:10px 12px 12px;}',
        // 闸门行里的小折叠（证据）：跟大折叠同一套三角，但更轻，不抢闸门结论
        '.dsa-fold-sub>summary{cursor:pointer;list-style:none;font-size:11.5px;color:var(--dsa-ink2);}',
        '.dsa-fold-sub>summary::-webkit-details-marker{display:none;}',
        '.dsa-fold-sub>summary:before{content:"▸";display:inline-block;width:12px;color:var(--dsa-ink3);}',
        '.dsa-fold-sub[open]>summary:before{content:"▾";}',

        // ---- 项目行：整行可点 + 右侧移除键（两个并列 button，不能嵌套）
        '.dsa-proj{position:relative;}',
        '.dsa-proj-main{display:block;width:100%;padding:0 22px 0 0;border:0;background:none;',
        '  font:inherit;color:inherit;text-align:left;cursor:pointer;}',
        '.dsa-proj-main:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:2px;}',
        '.dsa-proj-del{position:absolute;top:5px;right:5px;width:20px;height:20px;padding:0;border:0;',
        '  border-radius:6px;background:transparent;color:var(--dsa-ink2);font-size:14px;line-height:18px;',
        // 常态可见（.3）：藏到悬停才出现等于没有按钮，用户会问「删除在哪」
        '  cursor:pointer;opacity:.3;transition:opacity .15s,background .15s,color .15s;}',
        '.dsa-proj:hover .dsa-proj-del,.dsa-proj:focus-within .dsa-proj-del{opacity:1;}',
        // 没有 hover 的设备（触屏笔记本、平板）上没有「悬停」这一步，移除键不能永远隐身
        '@media (hover: none){.dsa-proj-del{opacity:.55;}}',
        '.dsa-proj-del:hover{background:var(--dsa-errsoft);color:var(--dsa-err);}',
        '.dsa-proj-del:focus-visible{opacity:1;outline:2px solid var(--dsa-accent);outline-offset:1px;}',
        // 目录已经不见的项目：移除键常显，因为这是用户唯一能对它做的动作
        '.dsa-proj.orphan .dsa-proj-del{opacity:.85;}',
        '.dsa-proj.orphan .dsa-proj-name{color:var(--dsa-err);}',

        // ---- 移除项目的确认弹窗
        '.dsa-forget-name{font-size:13px;font-weight:600;color:var(--dsa-ink);}',
        '.dsa-forget-path{margin-top:3px;font-family:var(--dsa-mono);font-size:11px;color:var(--dsa-ink3);',
        '  word-break:break-all;}',
        '.dsa-forget-facts{margin-top:10px;padding:10px 12px;border-radius:var(--dsa-r2);background:var(--dsa-card2);',
        '  border:1px solid var(--dsa-line);font-size:12px;color:var(--dsa-ink2);line-height:1.7;}',
        '.dsa-ack{display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12.5px;color:var(--dsa-ink);cursor:pointer;}',
        '.dsa-ack input{margin:2px 0 0;flex:0 0 auto;}'
      ].join('');

      function installStyles() {
        if (document.getElementById('dsa-style')) return function () {};
        var el = document.createElement('style');
        el.id = 'dsa-style';
        el.textContent = CSS;
        document.head.appendChild(el);
        return function () {
          try {
            el.remove();
          } catch (e) {
            void e;
          }
        };
      }

      /* ------------------------------------------------------------------ *
       * 小组件
       * ------------------------------------------------------------------ */

      function Chip(props) {
        return h('span', { className: 'dsa-chip ' + (props.tone || ''), title: props.title || undefined }, props.children);
      }

      function Btn(props) {
        var cls = 'dsa-btn' + (props.variant ? ' ' + props.variant : '') + (props.className ? ' ' + props.className : '');
        return h(
          'button',
          {
            type: 'button',
            className: cls,
            disabled: props.disabled,
            title: props.title || undefined,
            onClick: props.onClick
          },
          props.children
        );
      }

      function stateDot(status) {
        if (status === 'done') return 'pass';
        if (status === 'blocked') return 'fail';
        if (status === 'review') return 'warn';
        if (status === 'running') return 'run';
        return '';
      }

      function statusLabel(status) {
        return t(STATUS_TEXT[status] || 'todo');
      }

      function gateMarks(gates) {
        var pass = 0;
        var fail = 0;
        var unknown = 0;
        for (var i = 0; i < gates.length; i += 1) {
          if (gates[i].status === 'pass') pass += 1;
          else if (gates[i].status === 'fail') fail += 1;
          else unknown += 1;
        }
        return { pass: pass, fail: fail, unjudged: unknown };
      }

      // 一套词表：通过 / 未通过 / 等你拍板 / 还没查。未核、判不了、未测、缺失都只是「还没查」的原因。
      function gateFace(gate, stageStatus) {
        if (stageStatus === 'todo' && gate.status !== 'pass') return { cls: 'todo', mark: '○', word: '未评价' };
        if (gate.status === 'pass') return { cls: 'pass', mark: '✓', word: '通过' };
        if (gate.status === 'fail') return { cls: 'fail', mark: '✗', word: '未通过' };
        if (gate.manual) return { cls: 'manual', mark: '!', word: '等你拍板' };
        return { cls: 'unjudged', mark: '○', word: '还没查' };
      }

      function stageWord(stage) {
        if (!stage) return '';
        if (stage.status === 'running') return '运行中';
        if (stage.status === 'done') return '已完成';
        if (stage.status === 'blocked') return '被拦住';
        if (stage.status === 'todo') return '未开始';
        var manual = 0;
        var unknown = 0;
        for (var i = 0; i < (stage.gates || []).length; i += 1) {
          var gate = stage.gates[i];
          if (gate.status !== 'unjudged') continue;
          if (gate.manual) manual += 1;
          else unknown += 1;
        }
        if (manual) return '等你拍板 ' + manual;
        if (unknown) return '还没查 ' + unknown;
        return '待复核';
      }

      function Badge(props) {
        var mark = props.state === 'pass' ? '✓' : props.state === 'fail' ? '✗' : '?';
        return h('span', { className: 'dsa-badge ' + props.state, title: props.title || undefined }, mark + ' ' + props.text);
      }

      /** 一个 AI 入口：不再让用户猜「起草 / 让 AI 做 / 复核」有什么区别。 */
      function AiMenu(props) {
        var items = [];
        if (props.onDraft) items.push({ label: '写一份草稿', hint: '不跑脚本，只依据已有产物，落 docs/', run: props.onDraft });
        if (props.onChat) items.push({ label: '在对话里做这一步', hint: '投任务卡到项目会话，会改文件', run: props.onChat });
        if (props.onReview) items.push({ label: '复核（第 9 阶段）', hint: '让模型按证据包写问题清单', run: props.onReview });
        if (!items.length) return null;
        return h(
          'details',
          { className: 'dsa-menu' },
          h('summary', { className: 'dsa-btn' + (props.primary ? ' primary' : ''), title: 'AI 接手' }, 'AI 接手 ▾'),
          h(
            'div',
            { className: 'dsa-menu-list' },
            items.map(function (item) {
              return h(
                'button',
                {
                  key: item.label,
                  type: 'button',
                  disabled: props.busy,
                  onClick: function (e) {
                    var d = e.currentTarget.closest('details');
                    if (d) d.open = false;
                    item.run();
                  }
                },
                item.label,
                h('span', { className: 'dsa-hint' }, item.hint)
              );
            })
          )
        );
      }

      /** 一行闸门：符号 + 一句话结论 + 证据。符号只有 ✓ ✗ ○ ! 四种，别再造新词。 */
      function GateRow(props) {
        var gate = props.gate;
        var face = gateFace(gate, props.stageStatus);
        var tag = null;
        if (gate.status === 'fail') {
          tag = h('span', { className: 'dsa-tag ' + (gate.level === 'error' ? 'err' : '') }, gate.level === 'error' ? '拦截' : '提醒');
        } else if (gate.manual && gate.status === 'unjudged') {
          tag = props.stageStatus === 'todo'
            ? h('span', { className: 'dsa-tag' }, '开工后确认')
            : h('span', { className: 'dsa-tag manual' }, '需要你');
        }
        return h(
          'div',
          { className: 'dsa-gate ' + face.cls },
          h('span', { className: 'mark', title: face.word }, face.mark),
          h(
            'div',
            { className: 'dsa-gate-body' },
            h(
              'div',
              { className: 'dsa-gate-label' },
              gate.label,
              tag,
              gate.manual && props.stageStatus !== 'todo'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-btn ghost',
                      style: { height: '24px', padding: '0 7px', fontSize: '12px', marginLeft: 'auto' },
                      onClick: function () { props.onAdjudicate(gate); }
                    },
                    gate.status === 'unjudged' ? '现在拍板' : '重新裁定'
                  )
                : null
            ),
            h(
              'div',
              { className: 'dsa-gate-detail' },
              gate.detail || (gate.status === 'unjudged' ? '缺少可读证据，先补齐再判断' : '')
            ),
            gate.source
              ? h('div', { className: 'dsa-hint dsa-mono', style: { fontSize: '11.5px', marginTop: '2px' } }, String(gate.source))
              : null
          )
        );
      }

      function Modal(props) {
        var boxRef = useRef(null);

        // 打开就把焦点放进弹窗：键盘用户不应该还停在背后的阶段栏上
        useEffect(function () {
          var node = boxRef.current;
          if (!node || typeof node.focus !== 'function') return;
          try {
            node.focus();
          } catch (error) {
            /* 焦点抢不到不影响操作 */
          }
        }, []);

        // Esc 关闭：遮罩挡住了背后整块面板，没有键盘出口时用户只能找鼠标
        useEffect(function () {
          function onKey(e) {
            if (e.key !== 'Escape') return;
            if (props.onCancel) props.onCancel();
            else if (props.onMask) props.onMask(e);
          }
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
          };
        }, [props.onCancel, props.onMask]);

        // Tab 不能跑出弹窗：aria-modal 只是声明，焦点还得自己圈住；关闭时把焦点还给原来的位置
        useEffect(function () {
          var box = boxRef.current;
          var previous = null;
          try {
            previous = window.document ? window.document.activeElement : null;
          } catch (error) {
            previous = null;
          }
          function onKey(e) {
            if (e.key !== 'Tab' || !box || typeof box.querySelector !== 'function') return;
            var nodes = box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            var list = Array.prototype.filter.call(nodes, function (node) {
              return !node.disabled && node.getAttribute && node.getAttribute('aria-hidden') !== 'true';
            });
            if (!list.length) return;
            var first = list[0];
            var last = list[list.length - 1];
            var active = window.document ? window.document.activeElement : null;
            if (!e.shiftKey && active === last) {
              e.preventDefault();
              first.focus();
            } else if (e.shiftKey && (active === first || active === box)) {
              e.preventDefault();
              last.focus();
            }
          }
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
            try {
              if (previous && typeof previous.focus === 'function') previous.focus();
            } catch (error) {
              /* 焦点还不了不影响操作 */
            }
          };
        }, []);

        return h(
          'div',
          { className: 'dsa-mask', onMouseDown: props.onMask || undefined },
          h(
            'div',
            {
              className: 'dsa-modal',
              ref: boxRef,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': props.title,
              tabIndex: -1,
              onMouseDown: function (e) { e.stopPropagation(); },
            },
            h('h2', null, props.title),
            props.desc ? h('p', null, props.desc) : null,
            // 操作失败要显示在弹窗里：错误落在面板背后等于没报
            props.error ? h('div', { className: 'dsa-error', role: 'alert', style: { marginBottom: '10px' } }, props.error) : null,
            props.children,
            h(
              'div',
              { className: 'dsa-modal-foot' },
              props.onCancel ? h(Btn, { variant: 'ghost', onClick: props.onCancel }, t('cancel')) : null,
              props.onConfirm
                ? h(Btn, { variant: props.confirmVariant || 'primary', disabled: props.busy || props.confirmDisabled, onClick: props.onConfirm }, props.busy ? t('saving') : props.confirmText || t('confirm'))
                : null
            )
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 启动自检
       * ------------------------------------------------------------------ */

      var CHECK_MARK = { pass: '✓', fail: '✗', warn: '!', unjudged: '?' };

      /** 环境自检的紧凑清单：面板顶部横幅与设置弹窗共用。 */
      function PreflightList(props) {
        var pre = props.preflight;
        if (!pre || pre.status === 'pending' || !pre.checks || !pre.checks.length) {
          return h('div', { className: 'dsa-hint' }, t('envPending'));
        }
        return h(
          'div',
          null,
          pre.checks.map(function (item) {
            return h(
              'div',
              { key: item.id, className: 'dsa-check ' + item.status },
              h('span', { className: 'dsa-check-mark' }, CHECK_MARK[item.status] || '?'),
              h(
                'span',
                { className: 'dsa-check-body' },
                h('span', { className: 'dsa-check-label' }, item.label),
                h('span', { className: 'dsa-check-detail' }, ' — ' + item.detail),
                item.hint && item.status !== 'pass'
                  ? h('div', { className: 'dsa-check-advice' }, t('advice') + '：' + item.hint)
                  : null
              )
            );
          })
        );
      }

      function PreflightBanner(props) {
        var pre = props.preflight;
        if (!pre || pre.status === 'pass' || pre.status === 'pending') return null;
        var fails = (pre.checks || []).filter(function (item) { return item.status === 'fail'; });
        if (!fails.length) return null;
        return h(
          'div',
          { className: 'dsa-banner' },
          h('b', null, t('envFail')),
          h(
            'div',
            { className: 'dsa-banner-text' },
            fails.map(function (item) { return item.label + '：' + item.detail; }).join('；')
          ),
          h(Btn, { disabled: props.busy, onClick: props.onRecheck }, t('recheck'))
        );
      }

      /** 环境不全（有 error 级检查没通过）时，工作台整体不可用。还没查到结论时不算拦。 */
      function envBlocked(pre) {
        if (!pre) return false;
        if (pre.status === 'fail') return true;
        return (pre.checks || []).some(function (item) { return item.status === 'fail'; });
      }

      /**
       * 环境闸门：拦在整个工作台前面。
       * 只有两条出路——让 AI 装好，或者自己去设置里填路径；判不了/warn 不算拦（Mac 上没有 Word COM 是正常的）。
       */
      function EnvGate(props) {
        var pre = props.preflight;
        var fails = (pre && pre.checks ? pre.checks : []).filter(function (item) { return item.status === 'fail'; });
        return h(
          'div',
          { className: 'dsa-main', style: { overflow: 'auto' } },
          h(
            'div',
            { className: 'dsa-card dsa-pad', style: { maxWidth: '760px', margin: '28px auto', padding: '22px 24px' } },
            h('h1', { className: 'dsa-h1', style: { marginBottom: '6px' } }, '环境还没就绪'),
            h(
              'p',
              { className: 'dsa-sub', style: { marginTop: 0 } },
              '工作台不自己算数：脚本来自技能包，跑在 Python 子进程里。这两样缺一样，九个阶段一个都跑不起来，所以先把环境装齐再进来。'
            ),
            fails.length
              ? h(
                  'div',
                  { className: 'dsa-hint', style: { marginBottom: '8px' } },
                  '卡住的是：' + fails.map(function (item) { return item.label; }).join('、') + '（共 ' + fails.length + ' 项）'
                )
              : null,
            h(PreflightList, { preflight: pre }),
            h(
              'div',
              { className: 'dsa-inline', style: { marginTop: '16px', gap: '8px', flexWrap: 'wrap' } },
              h(
                Btn,
                { variant: 'primary', disabled: props.busy, onClick: props.onAi },
                props.busy ? '正在开临时会话…' : '让 AI 装好环境'
              ),
              h(Btn, { disabled: props.busy, onClick: props.onSettings }, '手动配置'),
              h(Btn, { disabled: props.busy, onClick: props.onRecheck }, t('recheck'))
            ),
            h(
              'div',
              { className: 'dsa-hint', style: { marginTop: '10px' } },
              '点「让 AI 装好环境」会开一个临时会话：它自己 clone 技能包、装 Python 依赖（机器上没有 Python 的话连 Python 一起装），再用 data_analysis_doctor 自查。装完回到这里会自动复查，通过后就能正常使用。'
            ),
            props.note ? h('div', { className: 'dsa-error', style: { marginTop: '8px' } }, props.note) : null
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 面板
       * ------------------------------------------------------------------ */

      function Panel() {
        var snapState = useState(null);
        var snap = snapState[0];
        var setSnap = snapState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var loadingState = useState(true);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var selectedState = useState('scope');
        var selected = selectedState[0];
        var setSelected = selectedState[1];
        var dialogState = useState(null);
        var dialog = dialogState[0];
        var setDialog = dialogState[1];
        // 起草结果按任务留在面板层：关掉弹窗（Esc/遮罩/取消）不该丢掉刚生成的正文
        var draftMemoState = useState({});
        var draftMemo = draftMemoState[0];
        var setDraftMemo = draftMemoState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var runIdState = useState('');
        var runId = runIdState[0];
        var setRunId = runIdState[1];
        var logState = useState({ id: '', lines: [], run: null });
        var logData = logState[0];
        var setLogData = logState[1];
        var drawerState = useState(false);
        var drawer = drawerState[0];
        var setDrawer = drawerState[1];
        // 图表默认只列 10 行：33 行徽章会把整页挤爆，但用户要能展开看全
        var figsOpenState = useState(false);
        var figsOpen = figsOpenState[0];
        var setFigsOpen = figsOpenState[1];
        var cmdCopiedState = useState(false);
        var cmdCopied = cmdCopiedState[0];
        var setCmdCopied = cmdCopiedState[1];
        var logRef = useRef(null);
        // 投卡去重：同一阶段、同一闸门指纹、同一产物状态，不重复投第二张卡。
        // 上一轮会话同一张「数据集」卡被投了 4 次，后两次模型只能核对一遍再停下。
                var timerRef = useRef(null);
        var rootRef = useRef(null);
        var roRef = useRef(null);
        // 断点看「面板自己有多宽」而不是窗口：宿主侧栏折叠后，同一窗口下面板能差 200px 以上
        var widthState = useState('wide');
        var width = widthState[0];
        var setWidth = widthState[1];
        var themeState = useState('light');
        var theme = themeState[0];
        var setTheme = themeState[1];
        // 启动自检结果：state 里带的是缓存摘要，没查过时单独拉一次（不会重复起 python，服务端共用 promise）
        var preflightState = useState(null);
        var preflight = preflightState[0];
        var setPreflight = preflightState[1];
        // 环境闸门：开临时会话让 AI 装环境时的状态
        var envBusyState = useState(false);
        var envBusy = envBusyState[0];
        var setEnvBusy = envBusyState[1];
        var envNoteState = useState('');
        var envNote = envNoteState[0];
        var setEnvNote = envNoteState[1];

        var measureRoot = useCallback(function () {
          var el = rootRef.current;
          if (!el) return;
          var w = el.clientWidth || 0;
          var next = w <= 860 ? 'narrow' : w <= 1100 ? 'compact' : w <= 1240 ? 'mid' : 'wide';
          setWidth(function (prev) { return prev === next ? prev : next; });
        }, []);

        // 用回调 ref 而不是 [] effect：面板首帧是 loading 占位，那时 .dsa-root 还不存在，
        // effect 只跑一次就永远拿不到节点（这是实测踩到的坑）。
        var attachRoot = useCallback(function (node) {
          rootRef.current = node;
          if (!node) return;
          if (roRef.current) roRef.current.observe(node);
          measureRoot();
          setTimeout(measureRoot, 0);
          setTimeout(measureRoot, 300);
        }, [measureRoot]);

        useEffect(function () {
          var onResize = function () { measureRoot(); };
          window.addEventListener('resize', onResize);
          if (typeof window.ResizeObserver !== 'undefined') {
            roRef.current = new window.ResizeObserver(function () { measureRoot(); });
            if (rootRef.current) roRef.current.observe(rootRef.current);
          }
          return function () {
            window.removeEventListener('resize', onResize);
            if (roRef.current) {
              roRef.current.disconnect();
              roRef.current = null;
            }
          };
        }, [measureRoot]);

        // Esc 关抽屉：右栏在 mid/compact/narrow 是覆盖式抽屉，没有键盘出口就只能点遮罩
        useEffect(function () {
          function onKey(e) {
            if (e.key === 'Escape' && drawer && !dialog) setDrawer(false);
          }
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }, [drawer, dialog]);

        useEffect(function () {
          function detect() {
            var dark = null;
            try {
              var scheme = (window.getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
              if (scheme) dark = scheme.indexOf('dark') >= 0;
            } catch (e) { void e; }
            if (dark === null) {
              var bg = '';
              try { bg = window.getComputedStyle(document.body).backgroundColor || ''; } catch (e) { void e; }
              var m = /rgba?\(([^)]+)\)/.exec(bg);
              var parts = m ? m[1].split(',').map(Number) : null;
              if (parts && (parts.length < 4 || parts[3] > 0.05)) {
                var lum = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
                dark = lum < 0.5;
              } else {
                // body 背景是透明的（很多主题只给容器上色）：退回系统偏好，至少不会反着来
                dark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
              }
            }
            setTheme(dark ? 'dark' : 'light');
          }
          detect();
          var mo = null;
          if (window.MutationObserver) {
            mo = new window.MutationObserver(detect);
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
          }
          var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
          if (mq && mq.addEventListener) mq.addEventListener('change', detect);
          return function () {
            if (mo) mo.disconnect();
            if (mq && mq.removeEventListener) mq.removeEventListener('change', detect);
          };
        }, []);

        var load = useCallback(function (silent) {
          if (!silent) setLoading(true);
          return getState()
            .then(function (json) {
              if (json && json.ok && json.state) {
                setSnap(json.state);
                setError('');
                var pre = json.state.preflight || null;
                if (pre) setPreflight(pre);
                if (!pre || pre.status === 'pending') {
                  request('GET', '/preflight')
                    .then(function (res) {
                      if (res && res.ok && res.preflight) setPreflight(res.preflight);
                    })
                    .catch(function () {});
                }
              } else {
                setError((json && json.error) || t('loadFail'));
              }
            })
            .catch(function (e) {
              setError(String((e && e.message) || e));
            })
            .then(function () {
              if (!silent) setLoading(false);
            });
        }, []);

        useEffect(function () {
          void load(false);
          return function () {
            if (timerRef.current) clearInterval(timerRef.current);
          };
        }, [load]);

        var running = useMemo(function () {
          if (!snap || !snap.activeRuns) return false;
          for (var key in snap.activeRuns) {
            if (Object.prototype.hasOwnProperty.call(snap.activeRuns, key)) return true;
          }
          return false;
        }, [snap]);

        // 研究对话：会话 id 存在宿主台账里，running / 最近一轮都从原生会话读
        var projectSession = (snap && snap.active && snap.active.sessionId) || '';
        var chatRunning = useSessionRunning(projectSession);
        var chatSnippet = useSessionSnippet(projectSession);
        var chatErrState = useState('');
        var chatError = chatErrState[0];
        var setChatError = chatErrState[1];

        useEffect(function () {
          return function () {
            releaseRef();
          };
        }, []);

        useEffect(function () {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(function () {
            if (running) void load(true);
          }, 2500);
          return function () {
            if (timerRef.current) clearInterval(timerRef.current);
          };
        }, [running, load]);

        var stages = (snap && snap.stages) || [];
        var current = useMemo(function () {
          for (var i = 0; i < stages.length; i += 1) if (stages[i].id === selected) return stages[i];
          return stages[0] || null;
        }, [stages, selected]);

        useEffect(function () {
          if (current) return;
          if (stages.length) setSelected(stages[0].id);
        }, [stages, current]);

        // 第一次拿到快照时，直接落在「该做的那一步」：已完成的不当前，未开始的不抢眼
        var landedRef = useRef(false);
        useEffect(function () {
          if (landedRef.current || !stages.length) return;
          landedRef.current = true;
          var target = null;
          for (var i = 0; i < stages.length; i += 1) {
            if (stages[i].status !== 'done') { target = stages[i]; break; }
          }
          if (!target) target = stages[stages.length - 1];
          if (target) setSelected(target.id);
        }, [stages]);

        var refreshLog = useCallback(function (id) {
          if (!id) return;
          request('GET', '/run/log?id=' + encodeURIComponent(id) + '&limit=300')
            .then(function (json) {
              if (json && json.ok) setLogData({ id: id, lines: json.lines || [], run: json.run });
            })
            .catch(function () {});
        }, []);

        useEffect(function () {
          if (!runId) return undefined;
          refreshLog(runId);
          // 只在跑的时候轮询：结束之后还每 6 秒打一次接口纯属浪费
          if (!running) return undefined;
          var id = setInterval(function () { refreshLog(runId); }, 1500);
          return function () { clearInterval(id); };
        }, [runId, running, refreshLog]);

        // 运行中的日志滚到底：不然长脚本要每 2 秒手动往下拽
        useEffect(function () {
          var el = logRef.current;
          if (el && running) el.scrollTop = el.scrollHeight;
        }, [logData.lines, running]);

        var action = useCallback(function (path, body) {
          setBusy(true);
          setError('');
          return request('POST', path, body)
            .then(function (json) {
              if (json && json.ok) {
                if (json.state) setSnap(json.state);
                else void load(true);
              } else {
                setError((json && json.error) || t('actionFail'));
              }
              return json;
            })
            .catch(function (e) {
              setError(String((e && e.message) || e));
              return { ok: false };
            })
            .then(function (json) {
              setBusy(false);
              return json;
            });
        }, [load]);

        var doRun = useCallback(function (stage) {
          action('/stage/run', { stageId: stage.id }).then(function (json) {
            if (json && json.ok && json.run) {
              setRunId(json.run.id);
              setDrawer(true);
            }
          });
        }, [action]);

        var doCancel = useCallback(function (stage) {
          action('/stage/cancel', { stageId: stage.id });
        }, [action]);

        // 重新检查环境：只探测，不安装；结果同时刷新横幅与设置弹窗
        var doRecheck = useCallback(function () {
          setBusy(true);
          return request('POST', '/preflight/refresh', {})
            .then(function (json) {
              if (json && json.preflight) setPreflight(json.preflight);
              if (json && json.state) setSnap(json.state);
              if (!json || !json.ok) setError((json && json.error) || t('actionFail'));
              return json;
            })
            .catch(function (e) {
              setError(String((e && e.message) || e));
              return { ok: false };
            })
            .then(function (json) {
              setBusy(false);
              return json;
            });
        }, []);

        var doAdjudicate = useCallback(function (payload) {
          return action('/adjudicate', payload).then(function (json) {
            if (json && json.ok) setDialog(null);
            return json;
          });
        }, [action]);

        /* ---------------- 环境闸门 ---------------- */

        // 项目一换，开着的弹窗（拍板 / 补丁 / 草稿）指向的就都是旧项目了：
        // 直接关掉，别让它对着新项目把旧结论写进去。
        var activeIdRef = useRef('');
        var activeId = snap && snap.active ? snap.active.id : '';
        useEffect(function () {
          if (activeIdRef.current !== activeId) {
            activeIdRef.current = activeId;
            setDialog(null);
          }
        }, [activeId]);

        // 让 AI 装环境：开临时会话投递安装提示词，然后把界面切过去
        var doAiInstall = useCallback(function () {
          setEnvNote('');
          setEnvBusy(true);
          var cwd = snap && snap.active ? snap.active.path : '';
          return startInstallSession(cwd)
            .then(function (sessionId) {
              setEnvNote('已在新会话里开始安装（' + String(sessionId).slice(0, 22) + '…）。装完回到这里会自动复查。');
              return sessionId;
            })
            .catch(function (e) {
              setEnvNote('没能开出临时会话：' + String((e && e.message) || e) + '。可以点「手动配置」自己填路径，或直接在对话里新建一个会话让我装。');
              return null;
            })
            .then(function (value) {
              setEnvBusy(false);
              return value;
            });
        }, [snap]);

        // 被环境挡住时每 12 秒强制复查一次：AI 那边装完，这里应该自己放行。
        // 用 refresh 而不是取缓存的 /preflight —— 否则最长要等 5 分钟缓存过期才看到变化。
        var envBlockedNow = envBlocked(preflight);
        useEffect(function () {
          if (!envBlockedNow) return undefined;
          var stopped = false;
          var inflight = false;
          var timer = setInterval(function () {
            if (inflight) return;
            inflight = true;
            request('POST', '/preflight/refresh', {})
              .then(function (json) {
                if (!stopped && json && json.preflight) setPreflight(json.preflight);
              })
              .catch(function () {
                /* 复查失败不打扰，下一轮再说 */
              })
              .then(function () {
                inflight = false;
              });
          }, 12000);
          return function () {
            stopped = true;
            clearInterval(timer);
          };
        }, [envBlockedNow]);

        /* ---------------- 研究对话 ---------------- */

        // 「让 AI 做这一步」：拿任务卡 → 复用/新建会话 → 投递 → 绑定 → 切到原生对话
        var doAskAI = useCallback(function (stage) {
          if (!snap || !snap.active || !stage) return;
          if (chatRunning) {
            setChatError('研究对话正在跑这一轮，先等它结束；要打断就点对话里的停止。');
            return;
          }
          var key = [
            stage.id,
            stage.lastRun ? stage.lastRun.id : 'no-run',
            (stage.gates || []).map(function (g) { return g.id + ':' + g.status; }).join(',')
          ].join('|');
          var logged = CARD_LOG[snap.active.path];
          if (logged && logged.key === key) {
            setChatError('这张卡已经投过，闸门和产物都没有变化；没有再投一次。产物有更新后可以再投。');
            return;
          }
          setBusy(true);
          setChatError('');
          deliverCard(stage.id, snap.active.path, projectSession)
            .then(function (result) {
              if (result && result.state) setSnap(result.state);
              if (result && result.warning) setChatError(result.warning);
              CARD_LOG[snap.active.path] = { stageId: stage.id, key: key, at: Date.now() };
            })
            .catch(function (e) {
              setChatError(String((e && e.message) || e) || t('aiFailed'));
            })
            .then(function () {
              setBusy(false);
            });
        }, [snap, projectSession, chatRunning, doOpenChat]);

        var reviewNow = useCallback(function () {
          var target = null;
          for (var i = 0; i < (snap?.stages || []).length; i += 1) {
            if (snap.stages[i].id === 'recheck') target = snap.stages[i];
          }
          if (!target) return;
          setSelected('recheck');
          doAskAI(target);
        }, [snap, doAskAI]);

        // 只打开对话，不投递：已有会话直接进；没有就先建一个空会话
        var doOpenChat = useCallback(function () {
          if (!snap || !snap.active) return;
          setBusy(true);
          setChatError('');
          var existing = projectSession;
          var idPromise = existing ? Promise.resolve(existing) : createSession(snap.active.path);
          idPromise
            .then(function (sessionId) {
              return ensureRef(sessionId).then(function () {
                if (existing) return null;
                return persistSession(sessionId).then(function (json) {
                  if (json.state) setSnap(json.state);
                });
              }).then(function () {
                openConversation(sessionId);
              });
            })
            .catch(function (e) {
              setChatError(String((e && e.message) || e) || t('chatUnavailable'));
            })
            .then(function () {
              setBusy(false);
            });
        }, [snap, projectSession]);

        // 绑定失效（会话被删）时：清掉旧 id，下一次重新建
        var doResetChat = useCallback(function () {
          setBusy(true);
          setChatError('');
          releaseRef();
          persistSession('')
            .then(function (json) {
              if (json.state) setSnap(json.state);
            })
            .catch(function (e) {
              setChatError(String((e && e.message) || e));
            })
            .then(function () {
              setBusy(false);
            });
        }, []);

        /* ---------------- 复核（第 9 阶段） ---------------- */

        // 只有选中复核阶段才拉：12 项检查 + 问题清单不该跟着 /state 每 8 秒轮询
        var recheckState = useState(null);
        var recheck = recheckState[0];
        var setRecheck = recheckState[1];
        var recheckErrState = useState('');
        var recheckError = recheckErrState[0];
        var setRecheckError = recheckErrState[1];
        var noticeState = useState('');
        var notice = noticeState[0];
        var setNotice = noticeState[1];

        var loadRecheck = useCallback(function () {
          if (!snap || !snap.active) return Promise.resolve(null);
          return request('GET', '/recheck')
            .then(function (json) {
              if (json && json.ok) {
                setRecheck(json);
                setRecheckError('');
              } else {
                setRecheckError((json && json.error) || '复核状态读取失败');
              }
              return json;
            })
            .catch(function (e) {
              setRecheckError(String((e && e.message) || e));
              return null;
            });
        }, [snap && snap.active ? snap.active.id : '']);

        useEffect(function () {
          if (selected !== 'recheck') return undefined;
          void loadRecheck();
          // 重跑链/模型审计落盘后，复核页要自己更新：不要求用户每改一步都手动刷新
          var timer = setInterval(function () { void loadRecheck(); }, 5000);
          return function () { clearInterval(timer); };
        }, [selected, snap && snap.active ? snap.active.id : '']);

        var doIssue = function (id, status) {
          action('/recheck/issue', { id: id, status: status }).then(function (json) {
            if (json && json.ok) void loadRecheck();
          });
        };
        var doApply = function (id) {
          setNotice('');
          action('/recheck/apply', { id: id, advance: true }).then(function (json) {
            if (json && json.ok) {
              setDialog(null);
              setNotice(json.chain
                ? '补丁已应用，开始重跑：' + json.chain.steps.join(' → ')
                : (json.note || '补丁已应用'));
              void loadRecheck();
            }
          });
        };
        var doCancelChain = function () {
          action('/recheck/cancel-chain', {}).then(function (json) {
            if (json && json.ok) void loadRecheck();
          });
        };

        /* ---------------- 顶栏 ---------------- */

        var header = h(
          'div',
          { className: 'dsa-top' },
          h(
            'div',
            { className: 'dsa-brand' },
            h('div', { className: 'dsa-logo', 'aria-hidden': 'true' }, '研'),
            h(
              'div',
              { className: 'dsa-brand-tx' },
              h('b', null, t('title')),
              snap && snap.active
                ? h('span', { title: snap.active.path }, snap.active.name || snap.active.path)
                : h('span', null, t('subtitle'))
            )
          ),
          // 窄屏没有左侧阶段栏，用下拉补一个入口；宽屏由 CSS 隐藏
          stages.length
            ? h(
                'select',
                {
                  className: 'dsa-stage-select',
                  value: selected,
                  title: t('stageSelect'),
                  onChange: function (e) { setSelected(e.target.value); }
                },
                stages.map(function (stage) {
                  return h('option', { key: stage.id, value: stage.id }, String(stage.index) + '. ' + stage.name);
                })
              )
            : null,
          h('span', { className: 'dsa-spacer' }),
          snap && snap.active && snap.active.skillDrift
            ? h(Chip, { tone: 'warn', title: t('skillDrift') }, '⚠ SKILL.md 指纹不一致')
            : null,
          snap && snap.skill && snap.skill.ok
            ? h(Chip, { tone: 'ok', title: snap.skill.packageDir }, t('skillOk') + ' · ' + (snap.skill.version || '?'))
            : h(Chip, { tone: 'err', title: snap && snap.skill ? snap.skill.reason : '' }, t('skillMissing')),
          h(AiMenu, {
            busy: busy,
            onDraft: function () { setDialog({ kind: 'draft' }); },
            onChat: current ? function () { doAskAI(current); } : null,
            onReview: reviewNow
          }),
          // 材料库是「给项目喂资料」的主入口，不该藏在项目菜单里：和设置一样常驻顶栏。
          h(
            Btn,
            {
              className: 'dsa-settings-btn',
              variant: 'ghost',
              title: '材料库：把项目外的资料目录挂进来，不复制',
              onClick: function () { setDialog({ kind: 'materials' }); }
            },
            h('span', { className: 'dsa-ico', 'aria-hidden': 'true' }, '🗂'),
            h('span', { className: 'dsa-settings-label' }, '材料')
          ),
          // 设置是「配置入口」，不是项目动作：常驻在顶栏右上角，别塞进「项目」菜单里让人翻。
          // 窄屏只留图标（标题与无障碍名仍在），不给顶栏添负担。
          h(
            Btn,
            {
              className: 'dsa-settings-btn',
              variant: 'ghost',
              title: '设置：技能目录 · Python · 台账位置 · 模型',
              onClick: function () { setDialog({ kind: 'settings' }); }
            },
            h('span', { className: 'dsa-ico', 'aria-hidden': 'true' }, '⚙'),
            h('span', { className: 'dsa-settings-label' }, t('settings'))
          ),
          h(
            'details',
            { className: 'dsa-menu' },
            h('summary', { className: 'dsa-btn' }, '项目 ▾'),
            h(
              'div',
              { className: 'dsa-menu-list' },
              h('button', { type: 'button', onClick: function () { setDialog({ kind: 'open' }); } }, t('open')),
              h('button', { type: 'button', onClick: function () { setDialog({ kind: 'create' }); } }, t('create'))
            )
          ),
          h(Btn, { className: 'dsa-drawer-toggle', variant: 'ghost', onClick: function () { setDrawer(!drawer); } }, t('drawer')),
          h(Btn, { disabled: loading, onClick: function () { void load(false); } }, loading ? t('refreshing') : t('refresh'))
        );

        /* ---------------- 无项目 ---------------- */

        if (!snap || !snap.active) {
          var picker = h(
            'div',
            { className: 'dsa-main' },
            h(PreflightBanner, { preflight: preflight, busy: busy, onRecheck: doRecheck }),
            h(
              'div',
              { className: 'dsa-card dsa-pad', style: { maxWidth: '640px', marginTop: '24px' } },
              h('div', { className: 'dsa-empty' }, h('b', null, t('emptyTitle')), t('emptyHint')),
              // 第一次打开的人不知道下一步该点哪个按钮：把动线按顺序摆出来，而不是让人猜
              h(
                'ol',
                { className: 'dsa-steps' },
                h('li', null, h('b', null, '先确认环境'), ' —— 技能包、Python、依赖；缺了让 AI 装，或点顶栏 ⚙ 手动指定'),
                h('li', null, h('b', null, '再选一个项目目录'), ' —— 新建（空目录）或打开已有项目'),
                h('li', null, h('b', null, '然后把资料挂进来'), ' —— 顶栏「材料」，资料留在原地，不复制')
              ),
              h(
                'div',
                { className: 'dsa-hint', style: { margin: '0 0 14px' } },
                '你会得到：可审计的语料清单 · 分析宽表与统计表 · 600 dpi 图表包 · 成稿 docx · 机器质检报告。'
              ),
              error ? h('div', { className: 'dsa-error', role: 'alert', style: { margin: '0 0 12px' } }, error) : null,
              h(
                'div',
                { className: 'dsa-form' },
                h(
                  'div',
                  { className: 'dsa-split' },
                  h(Btn, { variant: 'primary', onClick: function () { setDialog({ kind: 'create' }); } }, t('create')),
                  h(Btn, { onClick: function () { setDialog({ kind: 'open' }); } }, t('open'))
                ),
                snap && snap.projects && snap.projects.length
                  ? h(
                      'div',
                      null,
                      h('div', { className: 'dsa-hint', style: { marginTop: '8px' } }, '最近项目'),
                      snap.projects.map(function (p) {
                        return h(
                          'div',
                          { key: p.path, className: 'dsa-inline', style: { marginTop: '6px' } },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsa-btn ghost',
                              style: { textAlign: 'left', height: 'auto', padding: '4px 6px', maxWidth: '100%' },
                              onClick: function () {
                                action('/project/open', { dir: p.path });
                              }
                            },
                            h('span', { className: 'dsa-mono', style: { fontSize: '11px' } }, p.path)
                          ),
                          p.exists ? null : h('span', { className: 'dsa-tag err' }, '文件不见了'),
                          // 目录没了的项目在这里也要能清掉：否则它会一直卡在「最近项目」里点不开
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsa-link',
                              title: '从列表移除（不删磁盘文件）',
                              onClick: function () { setDialog({ kind: 'forget', project: p }); }
                            },
                            '移除'
                          )
                        );
                      })
                    )
                  : null
              )
            )
          );
          return h(
            'div',
            { className: 'dsa-root' },
            header,
            picker,
            dialog ? renderDialog(dialog) : null
          );
        }

        /* ---------------- 阶段栏 ---------------- */

        var mat = (snap && snap.materials) || { sources: [], mounts: [], derived: [] };
        var matMounts = mat.mounts || [];
        var matBad = matMounts.filter(function (item) { return item.status !== 'ok'; }).length;
        // 副标题要能塞进 52% 宽的 pill：挂载条数是用户要看的数，材料源个数只在不止一个时才提
        var matMeta = matBad
          ? '⚠ ' + matBad + ' 条失效'
          : matMounts.length
            ? matMounts.length + ' 条挂载' + ((mat.sources || []).length > 1 ? ' · ' + (mat.sources || []).length + ' 源' : '')
            : '未挂载（点开管理）';

        var railProjects = (snap && snap.projects) || [];
        var rail = h(
          'div',
          { className: 'dsa-rail' },
          // 项目区置顶：切换项目是这个面板最高频的「换舞台」动作，不该埋在菜单里
          h(
            'div',
            { className: 'dsa-rail-sec' },
            h(
              'div',
              { className: 'dsa-rail-h', style: { display: 'flex', alignItems: 'baseline' } },
              '项目',
              h('span', { className: 'dsa-count' }, String(railProjects.length))
            ),
            // 项目多了不能把下面的「资料 / 阶段」挤走：这个列表自己滚（CSS 里 min-height:0 + overflow-y:auto），
            // 整个分区再限一个 max-height 兜底。原来只显示 6 个、剩下的藏进「还有 N 个…」，那是拿信息换空间。
            h(
              'div',
              { className: 'dsa-proj-list' },
              railProjects.map(function (p) {
                var on = snap && snap.active && p.id === snap.active.id;
                var label = p.name || p.path;
                // 行主体和「移除」是两个并列按钮：button 不能套 button，
                // 套进去浏览器会把内层按钮踢出 DOM，移除键就永远点不到。
                return h(
                  'div',
                  {
                    key: p.path,
                    className: 'dsa-proj' + (on ? ' sel' : '') + (p.exists === false ? ' orphan' : ''),
                    title: p.path + (p.exists === false ? '（目录不见了）' : '')
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-proj-main',
                      'aria-current': on ? 'true' : undefined,
                      onClick: function () {
                        if (on) return;
                        action('/project/open', { dir: p.path });
                      }
                    },
                    h(
                      'span',
                      { className: 'dsa-proj-h' },
                      h('span', { className: 'dsa-proj-av', 'aria-hidden': 'true' }, String(label).slice(0, 1)),
                      h('span', { className: 'dsa-proj-name' }, label)
                    ),
                    h('span', { className: 'dsa-proj-path' }, p.exists === false ? p.path + ' · 目录不见了' : p.path)
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-proj-del',
                      title: '从列表移除（不删磁盘文件）',
                      'aria-label': '从列表移除 ' + label,
                      onClick: function (e) {
                        if (e && e.stopPropagation) e.stopPropagation();
                        setDialog({ kind: 'forget', project: p });
                      }
                    },
                    '×'
                  )
                );
              })
            ),
            h(
              'div',
              { className: 'dsa-proj-actions' },
              h('button', { type: 'button', className: 'dsa-link', onClick: function () { setDialog({ kind: 'create' }); } }, '+ 新建'),
              h('button', { type: 'button', className: 'dsa-link', onClick: function () { setDialog({ kind: 'open' }); } }, '打开…')
            )
          ),
          // 资料 + 阶段放进同一个滚动容器：项目区占多高由它自己决定，这两块永远从同一处开始读
          h(
            'div',
            { className: 'dsa-rail-body' },
            h('div', { className: 'dsa-rail-h' }, '资料'),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-stage ' + (matBad ? 'blocked' : ''),
              title: '材料库：登记用户的资料目录，挂到 data/ 下（不复制文件）',
              onClick: function () { setDialog({ kind: 'materials' }); }
            },
            h('div', { className: 'dsa-idx' }, '材'),
            h(
              'div',
              { className: 'dsa-stage-main' },
              h(
                'div',
                { className: 'dsa-stage-name' },
                h('span', { className: 'dot ' + (matBad ? 'fail' : matMounts.length ? 'pass' : '') }),
                '材料库'
              ),
              h('div', { className: 'dsa-stage-meta' }, matMeta)
            )
          ),
          h('div', { className: 'dsa-rail-h' }, '阶段 1–9'),
          stages.map(function (stage) {
            var dotClass = stateDot(stage.status);
            return h(
              'button',
              {
                key: stage.id,
                type: 'button',
                className: 'dsa-stage ' + (stage.id === selected ? 'sel ' : '') + stage.status,
                'aria-current': stage.id === selected ? 'step' : undefined,
                onClick: function () { setSelected(stage.id); }
              },
              h('div', { className: 'dsa-idx' }, String(stage.index)),
              h(
                'div',
                { className: 'dsa-stage-main' },
                h(
                  'div',
                  { className: 'dsa-stage-name' },
                  h('span', { className: 'dot ' + dotClass }),
                  stage.name
                ),
                h('div', { className: 'dsa-stage-meta' }, stageWord(stage))
              )
            );
            })
          )
        );

        /* ---------------- 闸门 ---------------- */

        var gateRank = { fail: 0, manual: 1, todo: 2, unjudged: 2, pass: 9 };
        var orderedGates = (current.gates || []).slice().sort(function (a, b) {
          return gateRank[gateFace(a, current.status).cls] - gateRank[gateFace(b, current.status).cls];
        });
        var openGates = orderedGates.filter(function (gate) { return gateFace(gate, current.status).cls !== 'pass'; });
        var passedGates = orderedGates.filter(function (gate) { return gateFace(gate, current.status).cls === 'pass'; });
        var gateRowOf = function (gate) {
          return h(GateRow, {
            key: gate.id,
            gate: gate,
            stageStatus: current.status,
            onAdjudicate: function (target) { setDialog({ kind: 'adjudicate', stage: current, gate: target }); }
          });
        };
        var gateList = h(
          'div',
          { className: 'dsa-card' },
          openGates.length
            ? openGates.map(gateRowOf)
            : passedGates.length
              ? null
              : h('div', { className: 'dsa-empty' }, '本阶段还没有可判的闸门'),
          passedGates.length
            ? h(
                'details',
                { className: 'dsa-fold' },
                h('summary', null, '已通过 ' + passedGates.length + ' 项'),
                passedGates.map(gateRowOf)
              )
            : null
        );

        /* ---------------- 复核区（第 9 阶段） ---------------- */

        var recheckView = null;
        if (current && current.id === 'recheck') {
          var rc = recheck || { checks: [], issues: [], coverage: {}, chain: null, openErrors: 0, openOthers: 0 };
          var chain = rc.chain;
          var sortKey = function (key) {
            var m = /^R(\d+)$/.exec(String(key));
            return m ? Number(m[1]) : 999;
          };
          var coverageKeys = Object.keys(rc.coverage || {}).sort(function (a, b) { return sortKey(a) - sortKey(b); });
          recheckView = h(
            'div',
            null,
            h(
              'div',
              { className: 'dsa-inline', style: { margin: '2px 0 10px' } },
              h(Btn, { variant: 'ghost', disabled: busy, onClick: function () { void loadRecheck(); } }, t('refresh')),
              h('span', { className: 'dsa-hint' }, 'open error ' + String(rc.openErrors || 0) + ' · 其他 ' + String(rc.openOthers || 0))
            ),
            chain
              ? h(
                  'div',
                  { className: 'dsa-card dsa-pad', style: { marginBottom: '10px' } },
                  h(
                    'div',
                    { className: 'dsa-inline', style: { justifyContent: 'space-between' } },
                    h('b', { style: { fontSize: '12px' } }, '重跑链 · ' + t(CHAIN_STATUS[chain.status] || 'chainRunning')),
                    chain.status === 'running'
                      ? h(Btn, { variant: 'ghost', disabled: busy, onClick: doCancelChain }, '取消重跑')
                      : null
                  ),
                  h(
                    'div',
                    { className: 'dsa-hint dsa-mono', style: { marginTop: '4px' } },
                    chain.steps.length
                      ? chain.steps
                          .map(function (s, i) {
                            var mark = i < chain.index ? '✓' : i === chain.index && chain.status === 'running' ? '▶' : '·';
                            return mark + ' ' + (i + 1) + '/' + chain.steps.length + ' ' + s;
                          })
                          .join('   ')
                      : t('chainNoSteps')
                  ),
                  chain.note ? h('div', { className: 'dsa-hint', style: { marginTop: '3px' } }, chain.note) : null,
                  chain.error ? h('div', { className: 'dsa-error', style: { fontSize: '11px', marginTop: '4px' } }, chain.error) : null
                )
              : null,
            notice ? h('div', { className: 'dsa-hint', style: { marginBottom: '8px' } }, notice) : null,
            recheckError ? h('div', { className: 'dsa-error', style: { marginBottom: '8px' } }, recheckError) : null,
            h(
              'div',
              { className: 'dsa-section' },
              h('h3', null, '机器复算'),
              h(
                'span',
                { className: 'count' },
                String((rc.checks || []).length) + ' 项 · ' + String(rc.openErrors || 0) + ' error / ' + String(rc.openOthers || 0) + ' 其他'
              )
            ),
            h(
              'div',
              { className: 'dsa-card' },
              (rc.checks || []).map(function (c) {
                return h(
                  'div',
                  {
                    key: c.id,
                    className: 'dsa-gate ' + (c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'unjudged')
                  },
                  h('span', { className: 'mark' }, c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '?'),
                  h(
                    'div',
                    { className: 'dsa-gate-body' },
                    h('div', { className: 'dsa-gate-label' }, c.id + ' · ' + c.label),
                    h('div', { className: 'dsa-gate-detail' }, c.detail || ''),
                    c.evidence
                      ? h(
                          'details',
                          { className: 'dsa-fold-sub', style: { marginTop: '4px' } },
                          h('summary', null, '证据'),
                          h('pre', { className: 'dsa-code', style: { marginTop: '4px', whiteSpace: 'pre-wrap' } }, String(c.evidence))
                        )
                      : null
                  )
                );
              })
            ),
            h('div', { className: 'dsa-section' }, h('h3', null, '问题清单'), h('span', { className: 'count' }, String((rc.issues || []).length) + ' 条')),
            (rc.issues || []).length
              ? (rc.issues || []).map(function (issue) {
                  return h(
                    'div',
                    { key: issue.id, className: 'dsa-card dsa-pad', style: { marginBottom: '8px' } },
                    h(
                      'div',
                      { className: 'dsa-issue-head' },
                      h('b', { className: 'dsa-mono', style: { fontSize: '11.5px' } }, issue.id),
                      h('span', { className: 'dsa-tag ' + (issue.severity === 'error' ? 'err' : '') }, t(SEVERITY_TEXT[issue.severity] || issue.severity)),
                      h('span', { className: 'dsa-tag' }, t(ISSUE_STATUS[issue.status] || issue.status))
                    ),
                    h(
                      'div',
                      { className: 'dsa-hint dsa-mono', style: { fontSize: '11px', marginTop: '3px' } },
                      issue.where + (issue.fix_kind ? ' · ' + t(FIX_KIND_TEXT[issue.fix_kind] || issue.fix_kind) : '')
                    ),
                    h('div', { style: { marginTop: '4px' } }, issue.claim),
                    issue.evidence ? h('div', { className: 'dsa-hint', style: { marginTop: '3px' } }, String(issue.evidence).slice(0, 240)) : null,
                    h(
                      'div',
                      { className: 'dsa-inline', style: { marginTop: '6px' } },
                      issue.patch
                        ? h(Btn, { variant: 'primary', disabled: busy, onClick: function () { setDialog({ kind: 'patch', issue: issue }); } }, '查看补丁并套用')
                        : null,
                      issue.status === 'open'
                        ? h(Btn, { disabled: busy, onClick: function () { doIssue(issue.id, 'fixed'); } }, '标记已修')
                        : h(Btn, { disabled: busy, onClick: function () { doIssue(issue.id, 'open'); } }, '重新打开'),
                      h(Btn, { variant: 'ghost', disabled: busy, onClick: function () { doIssue(issue.id, 'wontfix'); } }, '不修')
                    )
                  );
                })
              : h(
                  'div',
                  { className: 'dsa-card dsa-pad' },
                  h('div', { className: 'dsa-hint', style: { marginBottom: '6px' } }, '还没有 issues.jsonl：让 AI 按证据包写问题，或手动用 data_analysis_issue 记录。'),
                  h(Btn, { variant: 'primary', disabled: busy, onClick: function () { doAskAI(current); } }, t('aiReview'))
                ),
            coverageKeys.length
              ? h(
                  'div',
                  null,
                  h('div', { className: 'dsa-section' }, h('h3', null, t('coverageTitle')), h('span', { className: 'count' }, 'R1–R12')),
                  h(
                    'div',
                    { className: 'dsa-card dsa-pad' },
                    h(
                      'table',
                      { className: 'dsa-table' },
                      h(
                        'tbody',
                        null,
                        coverageKeys.map(function (key) {
                          var entry = rc.coverage[key] || {};
                          var statusText = entry.status === 'checked' ? t('coverageChecked') : entry.status === 'unchecked' ? t('figUnjudged') : entry.status || '—';
                          return h(
                            'tr',
                            { key: key },
                            h('td', { className: 'dsa-mono', style: { width: '42px' } }, key),
                            h('td', { style: { width: '64px' } }, statusText),
                            h('td', { className: 'dsa-hint' }, entry.note || '')
                          );
                        })
                      )
                    )
                  )
                )
              : null
          );
        }

        /* ---------------- 产物 ---------------- */

        var artifacts = snap.artifacts || {};
        var artifactBlocks = [];

        // 产物按阶段归属：审计看审计链、编码看编码链，别把全项目的东西堆到每个阶段
        var flowChains = (artifacts.flow || []).filter(function (chain) {
          if (current.id === 'audit') return chain.file.indexOf('output/audit/') === 0;
          if (current.id === 'coding') return chain.file.indexOf('output/coding/') === 0;
          return false;
        });
        if (flowChains.length) {
          artifactBlocks.push(
            h(
              'div',
              { key: 'flow' },
              h('div', { className: 'dsa-section' }, h('h3', null, t('flow')), h('span', { className: 'count' }, flowChains.length + ' 条链')),
              flowChains.map(function (chain) {
                return h(
                  'div',
                  { key: chain.file, className: 'dsa-card dsa-pad', style: { marginBottom: '8px' } },
                  h(
                    'div',
                    { className: 'dsa-hint dsa-mono', style: { marginBottom: '7px' } },
                    chain.file + ' · ' + chain.source + (chain.monotonic ? ' · 单调' : ' · 有回升')
                  ),
                  h(
                    'div',
                    { className: 'dsa-flow' },
                    chain.steps.map(function (step, idx) {
                      var prev = idx ? chain.steps[idx - 1].n : null;
                      var bad = prev !== null && step.n > prev;
                      return h(
                        'div',
                        {
                          key: step.stage + idx,
                          className: 'dsa-flow-step' + (bad ? ' bad' : ''),
                          title: step.note || undefined
                        },
                        h('div', { className: 's' }, step.stage),
                        h('div', { className: 'n' }, String(step.n))
                      );
                    })
                  )
                );
              })
            )
          );
        }

        if (artifacts.figures && artifacts.figures.total && current.id === 'figures') {
          var figRows = artifacts.figures.rows || [];
          var figSum = artifacts.figures.summary || {};
          var shown = figsOpen ? figRows : figRows.slice(0, 10);
          artifactBlocks.push(
            h(
              'div',
              { key: 'figs' },
              h(
                'div',
                { className: 'dsa-section' },
                h('h3', null, t('figures')),
                h('span', { className: 'count' }, artifacts.figures.total + ' ' + t('unitFigures') + ' · ' + artifacts.figures.file)
              ),
              h(
                'div',
                { className: 'dsa-agg' },
                h('span', { className: 'dsa-badge pass' }, '✓ ' + t('figPass') + ' ' + (figSum.pass || 0)),
                h('span', { className: 'dsa-badge fail' }, '✗ ' + t('figFail') + ' ' + (figSum.fail || 0)),
                h('span', { className: 'dsa-badge unjudged' }, '? ' + t('figUnjudged') + ' ' + (figSum.unjudged || 0))
              ),
              figSum.fontUnjudged
                ? h('div', { className: 'dsa-hint', style: { marginBottom: '7px' } }, t('figFontNote') + ' 本次 ' + figSum.fontUnjudged + ' 张缺 min_fontsize。')
                : null,
              h(
                'div',
                { className: 'dsa-card', style: { overflow: 'auto' } },
                h(
                  'table',
                  { className: 'dsa-table' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', null, 'ID'),
                      h('th', null, '图型'),
                      h('th', null, t('nLabel')),
                      h('th', null, '状态')
                    )
                  ),
                  h(
                    'tbody',
                    null,
                    shown.map(function (row) {
                      return h(
                        'tr',
                        { key: row.id },
                        h('td', { className: 'dsa-mono', title: row.caption || row.question || '' }, row.id),
                        h('td', { title: row.caption || row.question || '' }, row.chartType || '—'),
                        h('td', { className: 'dsa-mono' }, row.nText || '—'),
                        h(
                          'td',
                          null,
                          (row.badges || []).map(function (badge) {
                            var mark = badge.state === 'pass' ? '✓ ' : badge.state === 'fail' ? '✗ ' : '? ';
                            return h(
                              'span',
                              {
                                key: badge.key,
                                className: 'dsa-badge ' + badge.state,
                                title: badge.label + (badge.text ? '：' + badge.text : '')
                              },
                              mark + badge.label + (badge.text ? ' ' + badge.text : '')
                            );
                          })
                        )
                      );
                    })
                  )
                )
              ),
              figRows.length > 10
                ? h(
                    'div',
                    { style: { marginTop: '6px' } },
                    h(Btn, { variant: 'ghost', onClick: function () { setFigsOpen(!figsOpen); } }, figsOpen ? t('collapse') : t('showAll') + ' · ' + figRows.length + ' 张')
                  )
                : null
            )
          );
        }

        if (artifacts.models && artifacts.models.length && current.id === 'stats') {
          artifactBlocks.push(
            h(
              'div',
              { key: 'models' },
              h('div', { className: 'dsa-section' }, h('h3', null, t('models')), h('span', { className: 'count' }, artifacts.models.length + ' 个')),
              h(
                'div',
                { className: 'dsa-card dsa-pad' },
                artifacts.models.map(function (m) {
                  return h(
                    'div',
                    { key: m.id, className: 'dsa-inline', style: { justifyContent: 'space-between', padding: '3px 0' } },
                    h('span', { className: 'dsa-mono' }, m.id),
                    h(
                      'span',
                      { className: 'dsa-mono dsa-hint', title: m.fitN === null ? '缺 fit.csv：只能用 coef 表的 n' : 'N 取 fit.csv 的 n（n_dropna 不是 N）' },
                      'N=' + (m.fitN === null || m.fitN === undefined ? (m.n === null ? '—' : String(m.n)) : String(m.fitN)) + ' · ' + m.rows + ' ' + t('coefficients')
                    )
                  );
                }),
                artifacts.flowChecks && artifacts.flowChecks.length
                  ? h(
                      'div',
                      { className: 'dsa-hint', style: { marginTop: '6px' } },
                      'flow_checks：' + artifacts.flowChecks.filter(function (c) { return c && c.match === false; }).length + ' 项不一致'
                    )
                  : null
              )
            )
          );
        }

        if (artifacts.verify && current.id === 'qa') {
          var counts = artifacts.verify.counts || {};
          var issues = artifacts.verify.issues || [];
          artifactBlocks.push(
            h(
              'div',
              { key: 'verify' },
              h('div', { className: 'dsa-section' }, h('h3', null, t('verify')), h('span', { className: 'count' }, artifacts.verify.file + ' · ' + artifacts.verify.rows + ' 条')),
              h(
                'div',
                { className: 'dsa-card dsa-pad' },
                h(
                  'div',
                  { className: 'dsa-kv' },
                  h('span', null, h('b', { style: { color: 'var(--dsa-err)' } }, String(counts.error || 0)), ' error'),
                  h('span', null, h('b', { style: { color: 'var(--dsa-warn)' } }, String(counts.warning || 0)), ' warning'),
                  h('span', null, h('b', null, String(counts.info || 0)), ' info'),
                  counts.deferred
                    ? h('span', { title: 'V-05 用 n_dropna 当 N，需按 fit.n 复核；不并入 error' }, h('b', { style: { color: 'var(--dsa-ink3)' } }, String(counts.deferred)), ' V-05 待复核')
                    : null
                ),
                issues.length
                  ? h(
                      'div',
                      { style: { marginTop: '8px' } },
                      issues.map(function (row, idx) {
                        var sev = String(row.severity || '').toLowerCase();
                        var text = row.message || row.detail || row.note || row.where || row.file || row.title || '';
                        return h(
                          'div',
                          { key: idx, className: 'dsa-check ' + (sev === 'error' ? 'fail' : sev === 'warning' ? 'warn' : 'unjudged') },
                          h('span', { className: 'dsa-check-mark' }, sev === 'error' ? '✗' : sev === 'warning' ? '!' : '·'),
                          h(
                            'span',
                            { className: 'dsa-check-body' },
                            h('span', { className: 'dsa-check-label dsa-mono' }, String(row.check || 'issue')),
                            h('span', { className: 'dsa-check-detail' }, ' — ' + String(text).slice(0, 180))
                          )
                        );
                      })
                    )
                  : h('div', { className: 'dsa-hint', style: { marginTop: '6px' } }, '没有可展示的明细行（报告只有计数）')
              )
            )
          );
        }

        if (artifacts.analysis && current.id === 'dataset') {
          var a = artifacts.analysis;
          artifactBlocks.push(
            h(
              'div',
              { key: 'dataset' },
              h('div', { className: 'dsa-section' }, h('h3', null, '分析宽表'), h('span', { className: 'count' }, a.file)),
              h(
                'div',
                { className: 'dsa-card dsa-pad' },
                h(
                  'div',
                  { className: 'dsa-kv' },
                  h('span', null, h('b', null, String(a.rows)), ' 行'),
                  h('span', null, h('b', null, String(a.columns)), ' 列'),
                  a.inAnalysis === null
                    ? h('span', { className: 'dsa-hint' }, '缺 in_analysis 列')
                    : h('span', null, h('b', null, String(a.inAnalysis)), ' ' + t('inAnalysisLabel')),
                  a.excluded ? h('span', null, h('b', null, String(a.excluded)), ' ' + t('excludedLabel')) : null
                ),
                h('div', { className: 'dsa-hint', style: { marginTop: '5px' } }, a.header.join(' · '))
              )
            )
          );
        }

        if (current.id === 'manuscript') {
          var man = artifacts.manuscript || 0;
          artifactBlocks.push(
            h(
              'div',
              { key: 'manuscript' },
              h('div', { className: 'dsa-section' }, h('h3', null, '成稿'), h('span', { className: 'count' }, 'output/manuscript.docx')),
              h(
                'div',
                { className: 'dsa-card dsa-pad dsa-kv' },
                h('span', null, man ? sizeText(man) : '还没有 manuscript.docx'),
                h('span', null, h('b', null, String(artifacts.tables || 0)), ' 个表格 CSV'),
                h('span', { className: 'dsa-hint' }, '图表数、题注与数字溯源在终检里核对')
              )
            )
          );
        }

        if (artifacts.qa && artifacts.qa.count && current.id === 'qa') {
          artifactBlocks.push(
            h(
              'div',
              { key: 'qa-reports' },
              h('div', { className: 'dsa-section' }, h('h3', null, '终检报告'), h('span', { className: 'count' }, artifacts.qa.count + ' 份')),
              h(
                'div',
                { className: 'dsa-card' },
                h(
                  'table',
                  { className: 'dsa-table' },
                  h(
                    'tbody',
                    null,
                    (artifacts.qa.reports || []).map(function (report) {
                      return h(
                        'tr',
                        { key: report.name },
                        h('td', { className: 'dsa-mono' }, report.name),
                        h('td', { className: 'dsa-mono', style: { color: isNaN(report.errors) || report.errors ? 'var(--dsa-err)' : 'var(--dsa-ok)' } }, (isNaN(report.errors) ? '?' : String(report.errors)) + ' error'),
                        h('td', { className: 'dsa-mono', style: { color: 'var(--dsa-warn)' } }, String(report.warnings || 0) + ' warning'),
                        h('td', { className: 'dsa-hint' }, report.mtimeMs ? fmtTime(new Date(report.mtimeMs).toISOString()) : '')
                      );
                    })
                  )
                )
              )
            )
          );
        }

        /* ---------------- 中央区 ---------------- */

        var stageRunning = Boolean(current && snap.activeRuns && snap.activeRuns[current.id]);
        var stageRun = stageRunning ? snap.activeRuns[current.id] : null;
        var hasScript = Boolean(current && current.script);
        var pyName = (snap.config && snap.config.pythonPath) || 'python';
        // 多步阶段（终检）不能只显示第一步：参数在每一步里，命令回显会把用户看糊涂
        var stepScripts = (current && current.steps ? current.steps : []).filter(Boolean);
        var cmdText = stepScripts.length > 1
          ? stepScripts.map(function (s) { return pyName + ' ' + s; }).join('  →  ') + '（' + stepScripts.length + ' 步，参数见任务卡与运行日志）'
          : pyName + ' ' + current.script + ' ' + (current.args || []).join(' ');
        /* ---------------- 下一步 ---------------- */

        // 面板最该回答的问题是「现在该干嘛」：用一条横幅把状态、卡点、动作说清楚
        var runningStage = null;
        var nextStage = null;
        for (var ni = 0; ni < stages.length; ni += 1) {
          if (stages[ni].status === 'running') runningStage = stages[ni];
          if (!nextStage && stages[ni].status !== 'done') nextStage = stages[ni];
        }
        var nextView = null;
        if (runningStage) {
          nextView = h(
            'div',
            { className: 'dsa-next run' },
            h('span', { className: 'dsa-next-label' }, t('nextTitle')),
            h(
              'div',
              { className: 'dsa-next-body' },
              h('div', { className: 'dsa-next-line' }, t('nextRunning') + '：' + String(runningStage.index) + '. ' + runningStage.name),
              h('div', { className: 'dsa-next-sub' }, '运行台的日志会实时刷新；跑完这里会变成阶段结果。')
            ),
            h(Btn, { variant: 'danger', disabled: busy, onClick: function () { doCancel(runningStage); } }, t('cancelRun'))
          );
        } else if (!nextStage && stages.length) {
          nextView = h(
            'div',
            { className: 'dsa-next done' },
            h('span', { className: 'dsa-next-label' }, t('nextTitle')),
            h(
              'div',
              { className: 'dsa-next-body' },
              h('div', { className: 'dsa-next-line' }, t('nextAllDoneText')),
              h('div', { className: 'dsa-next-sub' }, '所有阶段的闸门都已通过或已由人裁定。可以导出，或从右侧进入研究对话做最后复核。')
            )
          );
        } else if (nextStage) {
          var manualGate = null;
          var errGate = null;
          var firstUnknown = null;
          var unknownCount = 0;
          for (var gi = 0; gi < nextStage.gates.length; gi += 1) {
            var item = nextStage.gates[gi];
            if (!errGate && item.status === 'fail' && item.level === 'error') errGate = item;
            if (item.status === 'unjudged' && item.manual && !manualGate) manualGate = item;
            if (item.status === 'unjudged' && !item.manual) {
              unknownCount += 1;
              if (!firstUnknown) firstUnknown = item;
            }
          }
          var tone = nextStage.status;
          var isHere = nextStage.id === selected;
          var line = String(nextStage.index) + '. ' + nextStage.name + ' · ' + stageWord(nextStage);
          var sub = '';
          var primary = null;
          if (nextStage.status === 'blocked') {
            sub = (errGate ? errGate.label + '：' + errGate.detail + '。' : '') + '后面的步骤先跑不了。';
            primary = isHere
              ? h(Btn, { variant: 'ghost', onClick: function () { setSelected(nextStage.id); } }, '看哪条没过')
              : h(Btn, { variant: 'ghost', onClick: function () { setSelected(nextStage.id); } }, '去查看');
          } else if (nextStage.status === 'review') {
            if (manualGate) {
              sub = manualGate.label + '：' + (manualGate.detail || '需要你看一眼再决定') + '。';
              primary = isHere
                ? h(
                    Btn,
                    {
                      variant: 'ghost',
                      onClick: function () { setDialog({ kind: 'adjudicate', stage: nextStage, gate: manualGate }); }
                    },
                    '现在拍板'
                  )
                : h(Btn, { variant: 'ghost', onClick: function () { setSelected(nextStage.id); } }, '去拍板');
            } else {
              sub = (firstUnknown ? unknownCount + ' 项还没查，先看「' + firstUnknown.label + '」' : '闸门没有全过') + '。';
              primary = h(Btn, { variant: 'ghost', onClick: function () { setSelected(nextStage.id); } }, isHere ? '看闸门' : '去查看');
            }
          } else {
            sub = nextStage.script ? '有登记脚本，可以直接跑。' : '这一阶段没有脚本，交给 AI 或人来做。';
            if (isHere) {
              primary = nextStage.script
                ? h(
                    Btn,
                    { variant: 'ghost', disabled: busy, onClick: function () { doRun(nextStage); } },
                    (nextStage.lastRun ? '重跑' : '运行') + ' ' + nextStage.short
                  )
                : h(AiMenu, {
                    primary: false,
                    busy: busy,
                    onDraft: STAGE_TASK[nextStage.id]
                      ? function () { setDialog({ kind: 'draft', task: STAGE_TASK[nextStage.id] }); }
                      : null,
                    onChat: function () { doAskAI(nextStage); },
                    onReview: reviewNow
                  });
            } else {
              primary = h(Btn, { variant: 'ghost', onClick: function () { setSelected(nextStage.id); } }, '去这里');
            }
          }
          nextView = h(
            'div',
            { className: 'dsa-next ' + tone },
            h('span', { className: 'dsa-next-label' }, '下一步'),
            h(
              'div',
              { className: 'dsa-next-body' },
              h('div', { className: 'dsa-next-line' }, line),
              h('div', { className: 'dsa-next-sub' }, sub)
            ),
            primary
          );
        }

        var manualOpen = null;
        for (var mgi = 0; mgi < openGates.length; mgi += 1) {
          if (gateFace(openGates[mgi], current.status).cls === 'manual') { manualOpen = openGates[mgi]; break; }
        }
        var headerPrimary = stageRunning
          ? h(Btn, { variant: 'danger', disabled: busy, onClick: function () { doCancel(current); } }, '停止')
          : manualOpen
            ? h(
                Btn,
                {
                  variant: 'primary',
                  disabled: busy,
                  title: manualOpen.label,
                  onClick: function () { setDialog({ kind: 'adjudicate', stage: current, gate: manualOpen }); }
                },
                '去拍板'
              )
            : hasScript
              ? h(
                  Btn,
                  {
                    variant: 'primary',
                    disabled: busy,
                    title: current.script,
                    onClick: function () { doRun(current); }
                  },
                  current.lastRun ? '重跑' : '运行'
                )
              : null;
        // KPI 条：五个数一眼看完「有多少料、走到哪、卡在哪」。数字等宽，和右栏日志同一套
        var corpusInfo = (snap && snap.artifacts && snap.artifacts.corpus) || {};
        var corpusTotal = Number(corpusInfo.validFiles || corpusInfo.totalFiles || 0) || 0;
        var corpusBytes = Number((corpusInfo.fingerprint && corpusInfo.fingerprint.bytes) || 0) || 0;
        var sizeNum = corpusBytes
          ? corpusBytes >= 1048576
            ? (corpusBytes / 1048576).toFixed(1)
            : corpusBytes >= 1024
              ? String(Math.round(corpusBytes / 1024))
              : String(corpusBytes)
          : '—';
        var sizeUnit = corpusBytes ? (corpusBytes >= 1048576 ? 'MB' : corpusBytes >= 1024 ? 'KB' : 'B') : '';
        var stageSummary = (snap && snap.summary) || {};
        var gateTotals = (snap && snap.totals) || {};
        var kpiOf = function (key, label, value, unit, hi) {
          return h(
            'div',
            { key: key, className: 'dsa-kpi' + (hi ? ' hi' : '') },
            h('div', { className: 'k' }, label),
            h('div', { className: 'v' }, String(value), unit ? h('small', null, unit) : null)
          );
        };
        var kpiStrip = h(
          'div',
          { className: 'dsa-kpis' },
          kpiOf('corpus', '有效语料', corpusTotal || '—', corpusTotal ? '份' : '', true),
          kpiOf('size', '总体积', sizeNum, sizeUnit, false),
          kpiOf('done', '阶段完成', (stageSummary.done || 0) + '/' + (stages.length || 9), '', false),
          kpiOf('review', '待裁定', stageSummary.review || 0, '项', false),
          kpiOf('fail', '闸门未过', gateTotals.fail || 0, '项', false)
        );

        var main = h(
          'div',
          { className: 'dsa-main' },
          h(PreflightBanner, { preflight: preflight, busy: busy, onRecheck: doRecheck }),
          h('div', { className: 'dsa-row dsa-hero', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
            h(
              'div',
              { style: { minWidth: 0 } },
              h(
                'div',
                { className: 'dsa-inline', style: { gap: '8px' } },
                h('h1', { className: 'dsa-h1' }, String(current.index) + '. ' + current.name),
                h(
                  'span',
                  {
                    className: 'dsa-chip ' + (current.status === 'done' ? 'ok' : current.status === 'blocked' ? 'err' : current.status === 'review' ? 'warn' : ''),
                    title: '阶段状态（按闸门与产物判定）'
                  },
                  stageWord(current)
                )
              ),
              h('p', { className: 'dsa-sub' }, current.purpose),
              current.lastRun
                ? h(
                    'div',
                    { className: 'dsa-hint', style: { margin: '-6px 0 0' } },
                    '最近一次运行 ' + (RUN_WORD[current.lastRun.status] || current.lastRun.status)
                      + ' · ' + fmtTime(current.lastRun.endedAt || current.lastRun.startedAt)
                      + (current.lastRun.endedAt ? ' · ' + fmtSpan(current.lastRun.startedAt, current.lastRun.endedAt) : '')
                      + ' · 退出码 ' + (current.lastRun.exitCode === null || current.lastRun.exitCode === undefined ? '—' : current.lastRun.exitCode)
                  )
                : null
            ),
            h(
              'div',
              { className: 'dsa-row' },
              headerPrimary,
              h(AiMenu, {
                busy: busy,
                primary: !hasScript && !stageRunning,
                onDraft: STAGE_TASK[current.id]
                  ? function () { setDialog({ kind: 'draft', task: STAGE_TASK[current.id] }); }
                  : null,
                onChat: current.id === 'recheck' ? null : function () { doAskAI(current); },
                onReview: function () { if (current.id === 'recheck') doAskAI(current); else reviewNow(); }
              })
            )
          ),
          kpiStrip,
          nextView,
          error ? h('div', { className: 'dsa-error', role: 'alert', style: { margin: '10px 0' } }, error) : null,
          hasScript
            ? h(
                'details',
                { className: 'dsa-fold dsa-fold-quiet' },
                h('summary', null, '执行细节 · 命令'),
                h(
                  'div',
                  { className: 'dsa-fold-body' },
                  h(
                    'div',
                    { className: 'dsa-inline', style: { justifyContent: 'space-between', margin: '0 0 6px' } },
                    h('span', { className: 'dsa-hint' }, '在工作台外执行也行，闸门只认产物'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsa-chat-btn',
                        onClick: function () {
                          try {
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                              void navigator.clipboard.writeText(cmdText);
                              setCmdCopied(true);
                              setTimeout(function () { setCmdCopied(false); }, 1500);
                            }
                          } catch (e) { void e; }
                        }
                      },
                      cmdCopied ? t('copied') : t('copyCmd')
                    )
                  ),
                  h('div', { className: 'dsa-code' }, cmdText)
                )
              )
            : h('div', { className: 'dsa-hint', style: { margin: '8px 0 0' } }, t('noScript')),
          h(
            'div',
            { className: 'dsa-section' },
            h('h3', null, '判读'),
            // 全部通过时这一行不再复述「已通过 N 项」——折叠行里已经写了，同一句话出现两遍只是噪音
            openGates.length
              ? h('span', { className: 'count' }, openGates.length + ' 项待处理 · 已通过 ' + passedGates.length + ' 项')
              : null
          ),
          gateList,
          recheckView,
          artifactBlocks.length
            ? h('div', { className: 'dsa-section' }, h('h3', null, t('artifacts')))
            : null,
          artifactBlocks
        );

        /* ---------------- 运行台 ---------------- */

        var runs = (snap.runs || []).slice();
        var stageShort = function (id) {
          var match = (snap.stages || []).filter(function (s) { return s.id === id; })[0];
          return match ? match.short : '';
        };
        var side = h(
          'div',
          // 宽屏右栏本来就该常驻：抽屉的开关按钮在宽屏是隐藏的，如果这里也按 drawer 关闭，
          // 运行记录与日志就永远打不开了。窄屏才由 drawer 决定（那里有按钮，默认收起不挡内容）。
          { className: 'dsa-side' + (drawer || width === 'wide' ? '' : ' hide') },
          h(
            'div',
            { className: 'dsa-side-h' },
            h('b', null, t('logs')),
            h('span', { className: 'dsa-spacer' }),
            runId ? h('span', { className: 'dsa-hint dsa-mono', style: { fontSize: '11px' } }, runId) : null,
            h(Btn, { variant: 'ghost', onClick: function () { setDrawer(false); } }, t('closeDrawer'))
          ),
          h(
            'details',
            { className: 'dsa-chat-card', style: { margin: '10px 12px 2px' } },
            h(
              'summary',
              null,
              h('span', { className: 'dsa-chat-dot ' + (projectSession ? (chatRunning ? 'run' : 'ok') : '') }),
              h('b', { style: { fontSize: '12.5px', fontWeight: 600 } }, t('chatCardTitle')),
              h(
                'span',
                { className: 'dsa-hint', style: { marginLeft: 'auto' } },
                projectSession ? (chatRunning ? t('chatRunning') : '已绑定') : '未绑定'
              )
            ),
            h(
              'div',
              { className: 'dsa-chat-more' },
              projectSession
                ? h('div', { className: 'dsa-chat-id', title: projectSession }, projectSession)
                : h('div', { className: 'dsa-hint' }, t('chatNone')),
              chatSnippet ? h('div', { className: 'dsa-hint' }, '最近：' + chatSnippet) : null,
              h(
                'div',
                { className: 'dsa-inline' },
                h(
                  Btn,
                  { variant: 'ghost', disabled: busy, onClick: function () { doOpenChat(); } },
                  projectSession ? t('openChat') : t('startChat')
                ),
                h(
                  Btn,
                  { variant: 'primary', disabled: busy || !current, onClick: function () { doAskAI(current); } },
                  '把这一步交给 AI'
                )
              ),
              chatError ? h('div', { className: 'dsa-error', role: 'alert', style: { fontSize: '12px' } }, chatError) : null,
              chatError && projectSession
                ? h(
                    'button',
                    { type: 'button', className: 'dsa-chat-btn', onClick: function () { doResetChat(); } },
                    t('retryChat')
                  )
                : null
            )
          ),
          h(
            'div',
            { className: 'dsa-runs' },
            runs.length
              ? runs.map(function (run) {
                  var stageMatch = (snap.stages || []).filter(function (s) { return s.id === run.stageId; })[0];
                  return h(
                    'button',
                    {
                      key: run.id,
                      type: 'button',
                      className: 'dsa-run' + (run.id === runId ? ' sel' : ''),
                      title: run.id + ' · ' + run.stageId,
                      onClick: function () { setRunId(run.id); }
                    },
                    h('span', { className: 'sid' }, stageMatch ? stageMatch.short : run.stageId),
                    h('span', { className: 'st ' + run.status }, RUN_WORD[run.status] || run.status),
                    h('span', { className: 'tm' }, fmtTime(run.startedAt)),
                    h('span', { className: 'ex' }, run.exitCode === null || run.exitCode === undefined ? '—' : String(run.exitCode))
                  );
                })
              : h('div', { className: 'dsa-empty' }, t('noRuns'))
          ),
          runId && logData.run
            ? h(
                'div',
                { className: 'dsa-run-h' },
                h(
                  'div',
                  { className: 'dsa-kv' },
                  h('span', null, t('stageOf') + ' ' + (stageShort(logData.run.stageId) || logData.run.stageId)),
                  h('span', null, RUN_WORD[logData.run.status] || logData.run.status),
                  h('span', null, t('runExit') + ' ' + (logData.run.exitCode === null || logData.run.exitCode === undefined ? '—' : logData.run.exitCode)),
                  h('span', null, fmtTime(logData.run.startedAt) + (logData.run.endedAt ? ' · ' + fmtSpan(logData.run.startedAt, logData.run.endedAt) : ''))
                ),
                Array.isArray(logData.run.command) && logData.run.command.length
                  ? h(
                      'div',
                      { className: 'dsa-mono', style: { marginTop: '4px', wordBreak: 'break-all', color: 'var(--dsa-ink3)' }, title: logData.run.logFile || '' },
                      logData.run.command.join(' ')
                    )
                  : null
              )
            : null,
          h(
            'div',
            { className: 'dsa-log', ref: logRef },
            runId
              ? logData.id === runId && logData.lines.length
                ? logData.lines.map(function (line, i) {
                    var cls = /error|traceback|失败|错误/i.test(line)
                      ? 'ln-err'
                      : /\bwarn(ing)?\b|警告/i.test(line) ? 'ln-warn' : '';
                    return h('div', { key: i, className: cls }, line || ' ');
                  })
                : t('logEmpty')
              : t('logEmpty')
          )
        );

        return h(
          'div',
          { className: 'dsa-root', ref: attachRoot, 'data-dsa-width': width, 'data-dsa-theme': theme, 'data-drawer': drawer || width === 'wide' ? 'open' : 'closed' },
          header,
          // 读屏用户看不到状态色块：把「当前阶段 + 运行状态 + 错误」放进一个礼貌播报区
          h(
            'div',
            { className: 'dsa-sr-only', role: 'status', 'aria-live': 'polite' },
            (current && current.name ? current.name + '：' : '') + (stageWord(runningStage || nextStage || current) || '') + (error ? '；' + error : '')
          ),
          drawer && width !== 'wide'
            ? h('div', { className: 'dsa-scrim', onClick: function () { setDrawer(false); } })
            : null,
          envBlockedNow
            ? h(EnvGate, {
                preflight: preflight,
                busy: envBusy,
                note: envNote,
                onAi: doAiInstall,
                onSettings: function () { setDialog({ kind: 'settings' }); },
                onRecheck: doRecheck
              })
            : h('div', { className: 'dsa-body' }, rail, main, side),
          dialog ? renderDialog(dialog) : null
        );

        /* ---------------- 弹窗 ---------------- */

        function renderDialog(d) {
          if (d.kind === 'create') {
            return h(CreateDialog, {
              busy: busy,
              error: error,
              onCancel: function () { setDialog(null); },
              onConfirm: function (dir, name) {
                action('/project/create', { dir: dir, name: name }).then(function (json) {
                  if (json && json.ok) setDialog(null);
                });
              }
            });
          }
          if (d.kind === 'open') {
            return h(OpenDialog, {
              busy: busy,
              error: error,
              recent: (snap && snap.projects) || [],
              onCancel: function () { setDialog(null); },
              onConfirm: function (dir) {
                action('/project/open', { dir: dir }).then(function (json) {
                  if (json && json.ok) setDialog(null);
                });
              }
            });
          }
          if (d.kind === 'draft') {
            return h(DraftDialog, {
              memo: draftMemo,
              initialTask: d.task || '',
              onMemo: function (taskId, text, meta) {
                setDraftMemo(function (prev) {
                  var next = {};
                  for (var k in (prev || {})) next[k] = prev[k];
                  next[taskId] = { text: text, meta: meta };
                  return next;
                });
              },
              onCancel: function () { setDialog(null); },
              onSaved: function (json) {
                if (json && json.state) setSnap(json.state);
              }
            });
          }
          if (d.kind === 'settings') {
            return h(SettingsDialog, {
              busy: busy,
              aiBusy: envBusy,
              error: error,
              skill: snap && snap.skill,
              preflight: preflight,
              config: snap && snap.config,
              onRecheck: doRecheck,
              onAi: doAiInstall,
              onCancel: function () { setDialog(null); },
              onConfirm: function (patch) {
                action('/config', { patch: patch }).then(function (json) {
                  if (json && json.ok) {
                    setDialog(null);
                    // 改了技能包目录/Python 命令，旧自检结论立即过期：马上重查一次
                    void doRecheck();
                  }
                });
              }
            });
          }
          if (d.kind === 'materials') {
            return h(MaterialsDialog, {
              // 平台来自快照，弹窗自己拉的那份还没回来时也能用对的措辞
              platform: (snap && snap.materials && snap.materials.platform) || '',
              // 挂载/识图/转码都会影响闸门：处理完让面板重新取一次快照，别等下一轮轮询
              onChanged: function () { void load(true); },
              onCancel: function () { setDialog(null); }
            });
          }
          if (d.kind === 'adjudicate') {
            return h(AdjudicateDialog, {
              busy: busy,
              error: error,
              stage: d.stage,
              gate: d.gate,
              onCancel: function () { setDialog(null); },
              onConfirm: function (status, note) {
                doAdjudicate({ stageId: d.stage.id, gateId: d.gate.id, status: status, note: note });
              }
            });
          }
          if (d.kind === 'patch') {
            return h(PatchDialog, {
              busy: busy,
              error: error,
              issue: d.issue,
              onCancel: function () { setDialog(null); },
              onConfirm: function () { doApply(d.issue.id); }
            });
          }
          if (d.kind === 'forget') {
            return h(ForgetDialog, {
              busy: busy,
              error: error,
              project: d.project,
              onCancel: function () { setDialog(null); },
              onConfirm: function (id) {
                action('/project/forget', { id: id }).then(function (json) {
                  if (!json || !json.ok) return;
                  setDialog(null);
                  // 移除的是当前项目时，选中的阶段也一起归零：否则还停在一个已经不存在的项目里
                  setSelected(null);
                });
              }
            });
          }
          return null;
        }
      }

      /* ------------------------------------------------------------------ *
       * 弹窗实现
       * ------------------------------------------------------------------ */

      function CreateDialog(props) {
        var dirState = useState('');
        var dir = dirState[0];
        var setDir = dirState[1];
        var nameState = useState('');
        var name = nameState[0];
        var setName = nameState[1];
        return h(
          Modal,
          {
            title: t('create'),
            desc: t('createHint'),
            busy: props.busy,
            error: props.error,
            confirmText: t('create'),
            confirmDisabled: !dir.trim(),
            onCancel: props.onCancel,
            onConfirm: function () { props.onConfirm(cleanPath(dir), name.trim()); }
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('dirLabel')),
              h('input', { className: 'dsa-input', value: dir, placeholder: t('dirPh'), onChange: function (e) { setDir(e.target.value); } })
            ),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('nameLabel')),
              h('input', { className: 'dsa-input', value: name, placeholder: t('namePh'), onChange: function (e) { setName(e.target.value); } })
            )
          )
        );
      }

      function OpenDialog(props) {
        var dirState = useState('');
        var dir = dirState[0];
        var setDir = dirState[1];
        return h(
          Modal,
          {
            title: t('open'),
            desc: t('openHint'),
            busy: props.busy,
            error: props.error,
            confirmText: t('open'),
            confirmDisabled: !dir.trim(),
            onCancel: props.onCancel,
            onConfirm: function () { props.onConfirm(cleanPath(dir)); }
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('dirLabel')),
              h('input', { className: 'dsa-input', value: dir, placeholder: t('dirPh'), onChange: function (e) { setDir(e.target.value); } })
            ),
            props.recent && props.recent.length
              ? h(
                  'div',
                  { className: 'dsa-field' },
                  h('label', null, '最近'),
                  props.recent.slice(0, 6).map(function (p) {
                    return h(
                      'button',
                      {
                        key: p.path,
                        type: 'button',
                        className: 'dsa-btn ghost',
                        style: { textAlign: 'left', padding: '3px 6px', height: 'auto' },
                        onClick: function () { setDir(p.path); }
                      },
                      h('span', { className: 'dsa-mono', style: { fontSize: '11px' } }, p.path)
                    );
                  })
                )
              : null
          )
        );
      }

      function ForgetDialog(props) {
        var project = props.project || {};
        var ackState = useState(false);
        var ack = ackState[0];
        var setAck = ackState[1];
        return h(
          Modal,
          {
            title: '移除项目',
            desc: '只从工作台的项目列表里移除登记，磁盘上的文件一个都不会删。',
            busy: props.busy,
            error: props.error,
            confirmText: '移除',
            confirmVariant: 'danger',
            // 二次确认：勾上这一句才让按钮可用，避免手快点掉一个项目
            confirmDisabled: !ack,
            onCancel: props.onCancel,
            onConfirm: function () { props.onConfirm(project.id); }
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, '项目'),
              h('div', { className: 'dsa-forget-name' }, project.name || project.path || '（未命名）'),
              h('div', { className: 'dsa-forget-path' }, project.path || '')
            ),
            h(
              'div',
              { className: 'dsa-forget-facts' },
              h('div', null, '会一起清掉：这个项目的运行记录、人工裁定、复核链。'),
              h('div', null, '不会动：项目目录、data/、output/、scripts/，以及材料源本身。')
            ),
            h(
              'label',
              { className: 'dsa-ack' },
              h('input', {
                type: 'checkbox',
                checked: ack,
                onChange: function (e) { setAck(Boolean(e.target.checked)); }
              }),
              h('span', null, '我明白这是移除登记，文件还在原来的目录里')
            )
          )
        );
      }

      function DraftDialog(props) {
        var fallbackTasks = [
          { id: 'scope', label: '研究范围与口径', file: 'docs/scope.md' },
          { id: 'codebook', label: '变量字典与编码规则', file: 'docs/codebook.md' },
          { id: 'figures', label: '图表题注与解读', file: 'docs/figure-notes.md' },
          { id: 'manuscript', label: '文稿小节', file: 'docs/manuscript-notes.md' },
          { id: 'qa', label: '质检问题说明', file: 'docs/qa-notes.md' }
        ];
        var catalogState = useState({ loading: true, ok: false, providers: [], tasks: fallbackTasks, default: null, error: '' });
        var catalog = catalogState[0];
        var setCatalog = catalogState[1];
        // 从面板「让 AI 起草」进来时直接落到对应任务，不用再手动选一次
        var firstTask = props.initialTask || fallbackTasks[0].id;
        var taskState = useState(firstTask);
        var taskId = taskState[0];
        var setTaskId = taskState[1];
        var instructionState = useState('');
        var instruction = instructionState[0];
        var setInstruction = instructionState[1];
        var outState = useState((props.memo && props.memo[firstTask] && props.memo[firstTask].text) || '');
        var out = outState[0];
        var setOut = outState[1];
        var metaState = useState((props.memo && props.memo[firstTask] && props.memo[firstTask].meta) || null);
        var meta = metaState[0];
        var setMeta = metaState[1];
        var errState = useState('');
        var err = errState[0];
        var setErr = errState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var savedState = useState('');
        var saved = savedState[0];
        var setSaved = savedState[1];

        useEffect(function () {
          request('GET', '/assistant/models')
            .then(function (json) {
              if (!json) return;
              setCatalog({
                loading: false,
                ok: Boolean(json.ok),
                providers: json.providers || [],
                tasks: json.tasks && json.tasks.length ? json.tasks : fallbackTasks,
                default: json.default || null,
                error: json.error || ''
              });
            })
            .catch(function (e) {
              setCatalog({ loading: false, ok: false, providers: [], tasks: fallbackTasks, default: null, error: String((e && e.message) || e) });
            });
        }, []);

        var current = null;
        for (var i = 0; i < catalog.tasks.length; i += 1) {
          if (catalog.tasks[i].id === taskId) current = catalog.tasks[i];
        }
        if (!current) current = catalog.tasks[0] || fallbackTasks[0];

        // 切任务时优先恢复这个任务上一次的生成结果；没有才清空
        useEffect(function () {
          var m = (props.memo && props.memo[taskId]) || null;
          setOut(m ? m.text || '' : '');
          setMeta(m ? m.meta || null : null);
          setErr('');
          setSaved('');
        }, [taskId]);

        // 生成一次就把结果留在面板层，关闭弹窗不丢
        useEffect(function () {
          if (!out) return;
          if (props.onMemo) props.onMemo(taskId, out, meta);
        }, [out, meta]);

        var route = catalog.default || null;
        var modelLine = '模型：读取中…';
        if (!catalog.loading) {
          if (!catalog.ok) modelLine = t('modelUnavailable') + (catalog.error ? ' · ' + catalog.error : '');
          else if (route && route.provider && route.model) {
            modelLine = '模型：' + (route.source === 'custom' ? '自定义 · ' : '跟随 DSH 默认 · ') + route.provider + ' / ' + route.model;
          } else if (route && route.error) {
            modelLine = t('modelUnavailable') + ' · ' + route.error;
          }
        }

        function generate() {
          setBusy(true);
          setErr('');
          setSaved('');
          request('POST', '/assistant/draft', { taskId: taskId, instruction: instruction.trim() })
            .then(function (json) {
              if (json && json.ok) {
                setOut(json.text || '');
                setMeta(json);
              } else {
                setErr((json && json.error) || t('actionFail'));
              }
              return json;
            })
            .catch(function (e) {
              setErr(String((e && e.message) || e));
            })
            .then(function () {
              setBusy(false);
            });
        }

        function copyOut() {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              void navigator.clipboard.writeText(out);
              setSaved(t('copy') + ' ✓');
            }
          } catch (e) {
            void e;
          }
        }

        function writeOut() {
          setBusy(true);
          setErr('');
          request('POST', '/assistant/save', { taskId: taskId, text: out })
            .then(function (json) {
              if (json && json.ok) {
                setSaved(t('draftSaved') + '：' + json.file);
                if (props.onSaved) props.onSaved(json);
              } else {
                setErr((json && json.error) || t('actionFail'));
              }
              return json;
            })
            .catch(function (e) {
              setErr(String((e && e.message) || e));
            })
            .then(function () {
              setBusy(false);
            });
        }

        return h(
          Modal,
          {
            title: t('draftTitle'),
            desc: t('draftHint'),
            error: err,
            onCancel: props.onCancel
          },
          h(
            'div',
            { className: 'dsa-form' },
            h('div', { className: 'dsa-model-line' }, modelLine),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('draftTask')),
              h(
                'select',
                {
                  className: 'dsa-input',
                  value: taskId,
                  onChange: function (e) { setTaskId(e.target.value); setSaved(''); }
                },
                catalog.tasks.map(function (task) {
                  return h('option', { key: task.id, value: task.id }, task.label + ' → ' + task.file);
                })
              )
            ),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('draftInstruction')),
              h('textarea', {
                className: 'dsa-input',
                style: { height: '56px', padding: '6px 9px', resize: 'vertical' },
                value: instruction,
                placeholder: t('draftInstructionPh'),
                onChange: function (e) { setInstruction(e.target.value); }
              })
            ),
            h(
              'div',
              { className: 'dsa-inline' },
              h(Btn, { variant: 'primary', disabled: busy || !catalog.ok, onClick: generate }, busy ? t('generating') : t('generate')),
              h(Btn, { variant: 'ghost', disabled: busy || !out, onClick: copyOut }, t('copy')),
              h(Btn, { variant: 'ghost', disabled: busy || !out, onClick: writeOut, title: current.file }, t('write')),
              saved ? h('span', { className: 'dsa-hint' }, saved) : null
            ),
            h('pre', { className: 'dsa-draft-out' }, out || t('draftEmpty')),
            meta
              ? h(
                  'div',
                  { className: 'dsa-draft-meta' },
                  h('span', null, meta.provider + ' / ' + meta.model),
                  meta.usage ? h('span', null, 'in ' + meta.usage.inputTokens + ' · out ' + meta.usage.outputTokens) : null,
                  h('span', null, (meta.elapsedMs / 1000).toFixed(1) + 's'),
                  meta.missing && meta.missing.length ? h('span', null, '未提供：' + meta.missing.join('、')) : null
                )
              : null
          )
        );
      }

      function SettingsDialog(props) {
        var rootState = useState((props.config && props.config.skillRoot) || '');
        var root = rootState[0];
        var setRoot = rootState[1];
        var pyState = useState((props.config && props.config.pythonPath) || 'python');
        var py = pyState[0];
        var setPy = pyState[1];
        var modeState = useState((props.config && props.config.modelMode) || 'follow');
        var mode = modeState[0];
        var setMode = modeState[1];
        var providerState = useState((props.config && props.config.modelProvider) || '');
        var provider = providerState[0];
        var setProvider = providerState[1];
        var modelIdState = useState((props.config && props.config.modelId) || '');
        var modelId = modelIdState[0];
        var setModelId = modelIdState[1];
        var catState = useState(null);
        var cat = catState[0];
        var setCat = catState[1];

        useEffect(function () {
          request('GET', '/assistant/models')
            .then(function (json) { if (json) setCat(json); })
            .catch(function () {});
        }, []);

        var providers = (cat && cat.providers) || [];
        var current = null;
        for (var i = 0; i < providers.length; i += 1) {
          if (providers[i].id === provider) current = providers[i];
        }
        var models = (current && current.models) || [];
        var defaultRoute = cat && cat.default;
        return h(
          Modal,
          {
            title: t('settings'),
            desc: t('envHint'),
            busy: props.busy,
            error: props.error,
            confirmText: t('save'),
            onCancel: props.onCancel,
            onConfirm: function () {
              props.onConfirm({
                skillRoot: root.trim(),
                pythonPath: py.trim(),
                modelMode: mode,
                modelProvider: mode === 'custom' ? provider : '',
                modelId: mode === 'custom' ? modelId : ''
              });
            }
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('skillRoot')),
              h('input', { className: 'dsa-input', value: root, placeholder: 'F:\\...\\SPSS-Style-Charting-Skill', onChange: function (e) { setRoot(e.target.value); } })
            ),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('pythonPath')),
              h('input', { className: 'dsa-input', value: py, placeholder: 'python', onChange: function (e) { setPy(e.target.value); } })
            ),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('draftModel')),
              h(
                'select',
                { className: 'dsa-input', value: mode, onChange: function (e) { setMode(e.target.value); } },
                h('option', { value: 'follow' }, t('modelFollow')),
                h('option', { value: 'custom' }, t('modelCustom'))
              ),
              defaultRoute && defaultRoute.provider && defaultRoute.model
                ? h('div', { className: 'dsa-model-line' }, 'DSH 默认：' + defaultRoute.provider + ' / ' + defaultRoute.model)
                : h('div', { className: 'dsa-hint' }, defaultRoute && defaultRoute.error ? defaultRoute.error : 'DSH 未配置默认模型'),
              mode === 'custom'
                ? h(
                    'div',
                    { className: 'dsa-split', style: { marginTop: '6px' } },
                    h(
                      'div',
                      { className: 'dsa-field' },
                      h('label', null, t('modelProvider')),
                      h(
                        'select',
                        {
                          className: 'dsa-input',
                          value: provider,
                          onChange: function (e) { setProvider(e.target.value); setModelId(''); }
                        },
                        h('option', { value: '' }, '—'),
                        providers.map(function (item) {
                          return h('option', { key: item.id, value: item.id }, item.name || item.id);
                        })
                      )
                    ),
                    h(
                      'div',
                      { className: 'dsa-field' },
                      h('label', null, t('modelName')),
                      h(
                        'select',
                        { className: 'dsa-input', value: modelId, onChange: function (e) { setModelId(e.target.value); } },
                        h('option', { value: '' }, '—'),
                        models.map(function (item) {
                          return h('option', { key: item.id, value: item.id }, item.name || item.id);
                        })
                      )
                    )
                  )
                : null,
              cat && cat.ok === false && cat.error ? h('div', { className: 'dsa-hint' }, t('modelsFail') + '：' + cat.error) : null
            ),
        h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('preflight')),
              h(PreflightList, { preflight: props.preflight }),
              h(
                'div',
                { className: 'dsa-inline', style: { marginTop: '6px' } },
                // 这两颗是「出路」，不是页脚链接：主路（找 AI 装）用实心，次路（自己再看一眼）用带框按钮，
                // 之前两颗都是 ghost（透明底透明边灰字），在设置页里看着就是一行文字。
                props.onAi
                  ? h(
                      Btn,
                      { variant: 'primary', disabled: props.busy || props.aiBusy, onClick: props.onAi },
                      props.aiBusy ? '正在开临时会话…' : '让 AI 装好环境'
                    )
                  : null,
                h(Btn, { disabled: props.busy || props.aiBusy, onClick: props.onRecheck }, t('recheck')),
                props.preflight && props.preflight.checkedAt
                  ? h('span', { className: 'dsa-hint' }, t('checkedAt') + ' ' + props.preflight.checkedAt.replace('T', ' ').slice(0, 19))
                  : null
              )
            ),
            props.skill
              ? h(
                  'div',
                  { className: props.skill.ok ? 'dsa-ok-note' : 'dsa-error' },
                  props.skill.ok
                    ? t('skillOk') + '：' + props.skill.version + ' · ' + props.skill.scripts.length + ' 脚本 · ' + props.skill.packageDir
                    : t('skillMissing') + '：' + (props.skill.reason || '')
                )
              : null
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 材料库
       * ------------------------------------------------------------------ */

      var MOUNT_WORD = {
        ok: '有效',
        'not-link': '不是工作台建的挂载',
        'missing-link': '挂载不见了',
        retargeted: '指向被改过',
        'missing-target': '目标不在了'
      };

      function splitEntries(text) {
        return String(text || '')
          .split(/[\n,，;；]+/)
          .map(function (item) { return item.trim(); })
          .filter(Boolean);
      }

      /**
       * 材料库：用户的资料放在自己的目录里，工作台只记地址。
       * 挂到 data/ 下是目录联接（Windows）或镜像目录（macOS/Linux），一个字节都不复制；所以这里能删的只有挂载，删不掉原件。
       */
      /**
       * 用户粘进来的路径要收拾一下：资源管理器「复制路径」带引号，浏览器地址栏是 file:///，
       * 手滑还会带尾随空格或反斜杠。不收拾就在 Windows 上建出一个名字带引号的目录。
       */
      function cleanPath(value) {
        var text = String(value == null ? '' : value).trim();
        if (!text) return '';
        // 成对引号（中英文都有）
        if (/^["'“”‘’].*["'“”‘’]$/.test(text)) text = text.slice(1, -1).trim();
        if (/^file:\/\//i.test(text)) {
          try {
            text = decodeURI(text.replace(/^file:\/\/\/?/i, function (all) {
              return all.endsWith(':///') ? '' : '/';
            }));
          } catch (error) {
            /* 解不了就按原样 */
          }
        }
        // Windows：/ 也能认；去掉尾随分隔符（盘符根保留）
        if (/^[A-Za-z]:/.test(text)) text = text.replace(/\//g, '\\');
        if (text.length > 1 && !/^[A-Za-z]:[\\/]$/.test(text)) text = text.replace(/[\\/]+$/, '');
        return text;
      }

      /** 是不是 macOS / Linux 口径：快照里的平台先算数，弹窗自己拉的数据兜底 */      function macOSMode(data, platform) {
        if (platform) return platform !== 'win32';
        return Boolean(data && data.isWindows === false);
      }

      function MaterialsDialog(props) {
        var dataState = useState(null);
        var data = dataState[0];
        var setData = dataState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var noteState = useState('');
        var note = noteState[0];
        var setNote = noteState[1];
        var addState = useState('');
        var addPath = addState[0];
        var setAddPath = addState[1];
        var labelState = useState('');
        var addLabel = labelState[0];
        var setAddLabel = labelState[1];
        var entriesState = useState({});
        var entries = entriesState[0];
        var setEntries = entriesState[1];
        var limitState = useState('20');
        var limit = limitState[0];
        var setLimit = limitState[1];
        var pagesState = useState('');
        var pages = pagesState[0];
        var setPages = pagesState[1];

        var refresh = function () {
          return request('GET', '/materials').then(function (json) {
            if (json && json.ok !== false) setData(json);
            return json;
          });
        };

        useEffect(function () {
          void refresh();
          // 识图/转码在后台跑：弹窗开着时每 4 秒刷一次进度
          var timer = setInterval(function () { void refresh(); }, 4000);
          return function () { clearInterval(timer); };
        }, []);

        var call = function (path, body) {
          setBusy(true);
          setError('');
          setNote('');
          return request('POST', path, body || {}).then(function (json) {
            setBusy(false);
            if (!json || !json.ok) {
              setError((json && json.error) || '操作失败');
              return json;
            }
            if (json.note) setNote(json.note);
            if (props.onChanged) props.onChanged();
            return refresh().then(function () { return json; });
          }, function (err) {
            setBusy(false);
            setError(String((err && err.message) || err));
            return null;
          });
        };

        var sources = (data && data.sources) || [];
        var mounts = (data && data.mounts) || [];
        var derived = (data && data.derived) || [];
        var vision = (data && data.vision) || null;
        var convert = (data && data.convert) || null;
        var plan = (data && data.plan) || null;

        var addRow = h(
          'div',
          { className: 'dsa-card', style: { padding: '10px 12px', marginBottom: '10px' } },
          h('div', { className: 'dsa-row', style: { gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('div', { className: 'dsa-field', style: { flex: '3 1 320px', margin: 0 } },
              h('label', null, '材料目录（绝对路径）'),
              h('input', {
                className: 'dsa-input',
                value: addPath,
                placeholder: 'F:\\资料\\刑事判决书',
                onChange: function (e) { setAddPath(e.target.value); }
              })
            ),
            h('div', { className: 'dsa-field', style: { flex: '1 1 120px', margin: 0 } },
              h('label', null, '名称（可选）'),
              h('input', {
                className: 'dsa-input',
                value: addLabel,
                placeholder: '刑事判决书',
                onChange: function (e) { setAddLabel(e.target.value); }
              })
            ),
            h(Btn, {
              variant: 'primary',
              disabled: busy || !addPath.trim(),
              onClick: function () {
                void call('/materials/add', { path: cleanPath(addPath), label: addLabel.trim() }).then(function (json) {
                  if (json && json.ok) {
                    setAddPath('');
                    setAddLabel('');
                    setNote('已登记；这一步不复制任何文件');
                  }
                });
              }
            }, '登记')
          ),
          h('div', { className: 'dsa-hint', style: { marginTop: '6px' } },
            '登记只记地址：回执会把目录里的文件按「直读 / 识图 / 待转换 / 不支持」分成四类报数，四类相加就是这个目录的总数。')
        );

        var sourceRows = sources.length
          ? sources.map(function (src) {
              var scan = src.scan;
              var usedText = src.usedBy.length
                ? '已挂到：' + src.usedBy.map(function (u) { return u.project + ' → data/' + u.as; }).join('、')
                : '还没有项目挂载它';
              return h(
                'div',
                { key: src.id, className: 'dsa-card', style: { padding: '10px 12px', marginBottom: '8px' } },
                h('div', { className: 'dsa-inline', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } },
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'dsa-inline', style: { gap: '8px' } },
                      h('b', null, src.label),
                      h('span', { className: 'dsa-hint' },
                        scan ? scan.files + ' 份 · ' + scan.bytesText : '还没扫描'),
                      src.exists ? null : h('span', { className: 'dsa-tag err' }, '目录不在了')
                    ),
                    h('div', { className: 'dsa-mono', style: { fontSize: '11px', color: 'var(--dsa-ink3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: src.path }, src.path)
                  ),
                  h('div', { className: 'dsa-inline', style: { gap: '6px' } },
                    h(Btn, { variant: 'ghost', disabled: busy, onClick: function () { void call('/materials/scan', { id: src.id }); } }, '重新登记'),
                    h(Btn, {
                      variant: 'ghost',
                      disabled: busy,
                      onClick: function () {
                        var used = src.usedBy.length;
                        var ask = used
                          ? '这个目录还被 ' + used + ' 个项目挂着，仍然要从材料库删掉吗？（磁盘上的文件不会动）'
                          : '从材料库删掉「' + src.label + '」？（磁盘上的文件不会动）';
                        if (!window.confirm(ask)) return;
                        void call('/materials/remove', { id: src.id, force: Boolean(used) });
                      }
                    }, '删除')
                  )
                ),
                src.receipt ? h('div', { className: 'dsa-hint', style: { marginTop: '6px' } }, src.receipt) : null,
                h('div', { className: 'dsa-hint', style: { marginTop: '2px' } }, usedText),
                h('div', { className: 'dsa-inline', style: { marginTop: '8px', gap: '8px' } },
                  h('input', {
                    className: 'dsa-input',
                    style: { flex: '1 1 auto' },
                    placeholder: '只挂其中几个子目录，逗号分隔；留空 = 整个目录',
                    value: entries[src.id] || '',
                    onChange: function (e) {
                      var value = e.target.value;
                      setEntries(function (prev) {
                        var next = {};
                        for (var key in prev) next[key] = prev[key];
                        next[src.id] = value;
                        return next;
                      });
                    }
                  }),
                  h(Btn, {
                    variant: 'primary',
                    disabled: busy || !src.exists,
                    onClick: function () {
                      void call('/materials/mount', {
                        sourceId: src.id,
                        entries: splitEntries(entries[src.id]),
                        as: ''
                      });
                    }
                  }, '挂到当前项目')
                )
              );
            })
          : h('div', { className: 'dsa-empty' }, '材料库是空的：先在上面登记一个目录');

        var mountRows = mounts.length
          ? mounts.map(function (mount) {
              var bad = mount.status !== 'ok';
              return h(
                'div',
                { key: mount.id, style: { padding: '8px 0', borderTop: '1px solid var(--dsa-line)' } },
                h('div', { className: 'dsa-inline', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } },
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'dsa-inline', style: { gap: '6px' } },
                      h('span', { className: 'dsa-tag ' + (bad ? 'err' : ''), title: mount.detail || '' }, bad ? '✗' : '✓'),
                      h('b', { className: 'dsa-mono' }, 'data/' + mount.as),
                      mount.mode === 'mirror' ? h('span', { className: 'dsa-hint' }, '镜像（逐文件软链）') : null
                    ),
                    h('div', { className: 'dsa-mono', style: { fontSize: '11px', color: 'var(--dsa-ink3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: mount.target },
                      mount.target + '（' + (MOUNT_WORD[mount.status] || mount.status) + '）'),
                    mount.detail ? h('div', { className: 'dsa-hint' }, mount.detail) : null
                  ),
                  h('div', { className: 'dsa-inline', style: { gap: '6px' } },
                    h(Btn, {
                      variant: 'ghost',
                      disabled: busy,
                      onClick: function () {
                        if (!window.confirm('把 data/' + mount.as + ' 的挂载摘掉？（材料原件不动）')) return;
                        void call('/materials/unmount', { as: mount.as });
                      }
                    }, '摘下'),
                    h(Btn, {
                      variant: 'ghost',
                      disabled: busy,
                      onClick: function () {
                        // as 定位副本目录名，entries 只在副本名与源里路径不同名时为空
                        var body = { sourceId: mount.sourceId, entries: mount.entry ? [mount.entry] : [], as: mount.as, apply: false };
                        void call('/materials/migrate', body).then(function (json) {
                          if (!json || !json.ok) return;
                          if (!json.safe) {
                            setError('逐份比对没通过，已停止、没有删任何文件；看报告里是哪几份');
                            return;
                          }
                          if (!window.confirm('逐份 md5 全部一致。把 data/' + mount.as + ' 里的副本删掉、换成挂载？')) return;
                          void call('/materials/migrate', { sourceId: mount.sourceId, entries: body.entries, as: mount.as, apply: true });
                        });
                      }
                    }, '副本换挂载')
                  )
                )
              );
            })
          : null;

        var visionSummary = vision && vision.summary;
        var visionBlock = h(
          'div',
          { className: 'dsa-card', style: { padding: '10px 12px', marginTop: '10px' } },
          h('div', { className: 'dsa-inline', style: { justifyContent: 'space-between', gap: '8px' } },
            h('b', null, '扫描件识图'),
            h('span', { className: 'dsa-hint' },
              vision && vision.running ? '正在跑…' : '空闲')
          ),
          h('div', { className: 'dsa-hint', style: { marginTop: '4px' } },
            '审计判为 image_only 的 PDF 与图片，交给多模态模型逐页转写；产物写进派生目录并挂回 data/。' +
            '识图文本未经人工核对时，数字溯源闸门只会判「判不了」。'),
          visionSummary && visionSummary.rows
            ? h('div', { className: 'dsa-hint', style: { marginTop: '4px' } },
                '已识别 ' + visionSummary.pagesOk + ' 页 / ' + visionSummary.files + ' 份 · 失败 ' + visionSummary.pagesFailed + ' 页 · 人工已核 ' + visionSummary.pagesVerified + ' 页')
            : null,
          h('div', { className: 'dsa-inline', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } },
            h('input', {
              className: 'dsa-input',
              style: { width: '90px' },
              value: limit,
              placeholder: '最多页数',
              title: '本次最多识别多少页',
              onChange: function (e) { setLimit(e.target.value); }
            }),
            h('input', {
              className: 'dsa-input',
              style: { width: '140px' },
              value: pages,
              placeholder: '只跑这些页，如 1-20',
              onChange: function (e) { setPages(e.target.value); }
            }),
            h(Btn, {
              variant: 'primary',
              disabled: busy || Boolean(vision && vision.running),
              onClick: function () {
                void call('/materials/vision/run', { limit: Number(limit) || 20, pages: pages.trim() });
              }
            }, '开始识别'),
            vision && vision.running
              ? h(Btn, { variant: 'ghost', disabled: busy, onClick: function () { void call('/materials/vision/cancel', {}); } }, '停止')
              : null,
            visionSummary && visionSummary.pagesOk
              ? h(Btn, {
                  variant: 'ghost',
                  disabled: busy,
                  onClick: function () {
                    if (!window.confirm('确认这些识别稿你已经逐页对照过原件了？打勾之后 qa-vision 才可能通过。')) return;
                    void call('/materials/vision/verify', { all: true });
                  }
                }, '标记已核对')
              : null
          )
        );

        var convertBlock = h(
          'div',
          { className: 'dsa-card', style: { padding: '10px 12px', marginTop: '10px' } },
          h('div', { className: 'dsa-inline', style: { justifyContent: 'space-between', gap: '8px' } },
            h('b', null, '旧版 Office 转码'),
            h('span', { className: 'dsa-hint' }, convert && convert.running ? '正在跑…' : '空闲')
          ),
          h('div', { className: 'dsa-hint', style: { marginTop: '4px' } },
            data && data.isWindows === false
              ? 'macOS/Linux 没有桌面 Office COM，这条通道不适用：请用本机 Office/WPS 打开原文件另存为 docx/xlsx/pptx，放回原目录后点「重扫」。'
              : (convert && convert.office
                ? (convert.office.ok
                  ? '本机 Office 可用'
                  : '本机 Office 不可用：' + (convert.office.error || convert.office.detail || '未知原因')
                    + (convert.office.hint ? ' —— ' + convert.office.hint : ''))
                : 'doc/xls/ppt 技能读不了文本；Windows 上用桌面 Office 另存为 docx/xlsx/pptx。')),
          convert && convert.summary && convert.summary.rows
            ? h('div', { className: 'dsa-hint', style: { marginTop: '4px' } },
                '已转 ' + convert.summary.converted + ' 份 · 失败 ' + convert.summary.failed + ' 份')
            : null,
          h('div', { className: 'dsa-inline', style: { marginTop: '8px', gap: '8px' } },
            h(Btn, { variant: 'ghost', disabled: busy || (data && data.isWindows === false), onClick: function () { void call('/materials/office', {}); } }, '查本机 Office'),
            h(Btn, {
              variant: 'primary',
              disabled: busy || Boolean(convert && convert.running) || (data && data.isWindows === false),
              onClick: function () { void call('/materials/convert/run', { limit: Number(limit) || 10 }); }
            }, '开始转码')
          )
        );

        var derivedLine = derived.length
          ? h('div', { className: 'dsa-hint', style: { marginTop: '8px' } },
              '派生稿：' + derived.map(function (item) { return item.mountName + '（' + item.files + ' 份）'; }).join('、'))
          : null;

        return h(
          Modal,
          { title: '材料库', onCancel: props.onCancel, desc: macOSMode(data, props.platform)
            ? '材料留在你自己的目录里，工作台只记地址；挂到项目 data/ 下是「镜像目录」（真实目录 + 逐文件软链），不复制文件。'
            : '材料留在你自己的目录里，工作台只记地址；挂到项目 data/ 下是目录联接（macOS/Linux 为镜像目录），不复制文件。' },
          error ? h('div', { className: 'dsa-error', style: { marginBottom: '10px' } }, error) : null,
          note ? h('div', { className: 'dsa-hint', style: { marginBottom: '10px' } }, note) : null,
          h('div', { style: { maxHeight: '58vh', overflowY: 'auto', paddingRight: '2px' } },
            addRow,
            h('div', { className: 'dsa-rail-h', style: { padding: '6px 0' } }, '材料源'),
            sourceRows,
            h('div', { className: 'dsa-rail-h', style: { padding: '12px 0 6px' } }, '当前项目 data/ 下的挂载'),
            h('div', { className: 'dsa-hint', style: { marginBottom: '4px' } },
              macOSMode(data, props.platform)
                ? 'macOS/Linux 上没有目录联接，工作台建的是「镜像目录」：真实目录里逐个文件软链，源目录增删文件后点「修复」同步。'
                : 'Windows 上建的是目录联接（junction）：data/ 下的目录直接指向材料目录，不占空间。'),
            mountRows || h('div', { className: 'dsa-empty' }, '还没有挂载任何材料目录'),
            derivedLine,
            visionBlock,
            convertBlock
          )
        );
      }

      function AdjudicateDialog(props) {
        var noteState = useState('');
        var note = noteState[0];
        var setNote = noteState[1];
        function decide(status) {
          props.onConfirm(status, note.trim());
        }
        // 弹窗开着的时候项目被切走/闸门没了：不崩，也不许对着别的项目拍板
        if (!props.gate || !props.stage) {
          return h(
            Modal,
            { title: t('adjudicateTitle'), desc: '', error: props.error, onCancel: props.onCancel },
            h('p', null, '这条闸门已经不在当前项目里了（切了项目，或者产物被删）。关掉这个窗口，重新点一次「去拍板」。'),
            h('div', { className: 'dsa-inline' }, h(Btn, { variant: 'ghost', onClick: props.onCancel }, t('close')))
          );
        }
        return h(
          Modal,
          {
            title: t('adjudicateTitle') + ' · ' + props.gate.label,
            desc: t('adjudicateHint'),
            error: props.error,
            onCancel: props.onCancel
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-card dsa-pad', style: { marginBottom: '4px' } },
              h('div', { style: { fontSize: '13px', lineHeight: 1.55 } }, props.gate.detail || '这条闸门需要你判断。'),
              props.gate.source
                ? h('div', { className: 'dsa-hint dsa-mono', style: { marginTop: '5px' } }, String(props.gate.source))
                : null,
              h(
                'div',
                { className: 'dsa-hint', style: { marginTop: '6px' } },
                '阶段：' + props.stage.name
                  + (props.stage.lastRun
                    ? ' · 最近运行 ' + (RUN_WORD[props.stage.lastRun.status] || props.stage.lastRun.status)
                      + '（退出码 ' + (props.stage.lastRun.exitCode === null ? '—' : props.stage.lastRun.exitCode) + '）'
                    : ' · 还没有运行记录')
              )
            ),
            h(
              'div',
              { className: 'dsa-field' },
              h('label', null, t('note')),
              h('textarea', {
                className: 'dsa-input',
                style: { height: '68px', padding: '6px 9px', resize: 'vertical' },
                value: note,
                placeholder: '为什么通过或不通过；写进记录，之后能追溯',
                onChange: function (e) { setNote(e.target.value); }
              })
            ),
            h(
              'div',
              { className: 'dsa-inline' },
              h(Btn, { variant: 'primary', disabled: props.busy, onClick: function () { decide('pass'); } }, '确认通过'),
              h(Btn, { variant: 'danger', disabled: props.busy, onClick: function () { decide('fail'); } }, '打回重做'),
              h(Btn, { variant: 'ghost', disabled: props.busy, onClick: function () { decide('unjudged'); } }, t('clear'))
            )
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 套用补丁前的确认
       *
       * 补丁会覆盖项目里的文件：不能点一下就落盘。先把目标、基线、备份策略与
       * 内容前 24 行摊开，人确认后才 POST /recheck/apply。
       * ------------------------------------------------------------------ */

      function PatchDialog(props) {
        var issue = props.issue || {};
        var patch = issue.patch || {};
        var content = String(patch.content || '');
        var preview = content.split('\n').slice(0, 24).join('\n');
        return h(
          Modal,
          {
            title: t('patchTitle') + ' · ' + (issue.id || ''),
            desc: issue.claim || '',
            busy: props.busy,
            error: props.error,
            confirmText: t('patchApply'),
            onCancel: props.onCancel,
            onConfirm: props.onConfirm
          },
          h(
            'div',
            { className: 'dsa-form' },
            h(
              'div',
              { className: 'dsa-kv' },
              h('span', null, t('patchTarget') + '：' + (patch.path || '?')),
              h('span', null, t('patchBase') + ' ' + (String(patch.baseHash || '').slice(0, 16) || '—'))
            ),
            h('div', { className: 'dsa-hint' }, t('patchBackup')),
            h('div', { className: 'dsa-hint' }, t('patchChanged')),
            h('pre', { className: 'dsa-patch-pre' }, preview || '（补丁内容为空）')
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 图标与装配
       * ------------------------------------------------------------------ */

      function WorkbenchIcon() {
        return h(
          'svg',
          {
            viewBox: '0 0 20 20',
            width: 18,
            height: 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true'
          },
          h('path', { d: 'M3 3h14l-5 6v5.2l-4 1.8V9L3 3z' })
        );
      }

      function apply(ctx) {
        runtime.ctx = ctx;
        ctx.effect(installStyles, 'data-analysis: styles');
        ctx.effect(function () {
          var offs = [];
          offs.push(ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'data-analysis' }, Panel);
          }));
          offs.push(ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'data-analysis',
                order: 6,
                label: function () {
                  return t('title');
                }
              },
              WorkbenchIcon
            );
          }));

          // 原生对话里的三处装饰 + 工具卡（全部只做加法，不替换宿主组件）
          offs.push(ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register(
              { name: 'conversation.session.header.actions', id: 'data-analysis-workbench', order: 90 },
              OpenWorkbenchAction
            );
          }));
          offs.push(ctx.slots.inject('conversation.chat.turnTail', function () {
            return ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'data-analysis-gates',
                order: 60,
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                }
              },
              WorkbenchTail
            );
          }));
          offs.push(ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'data-analysis-next',
                order: 70,
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                }
              },
              NextStepControl
            );
          }));
          DATA_TOOLS.forEach(function (toolName) {
            offs.push(ctx.slots.inject('tool.call.toolview', function () {
              return ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, makeToolRow(toolName));
            }));
          });

          return function () {
            offs.forEach(function (off) {
              if (typeof off === 'function') off();
            });
          };
        }, 'data-analysis: slots');
        ctx.effect(function () {
          return function () {
            releaseRef();
          };
        }, 'data-analysis: session');
      }

      return {
        inject: ['slots'],
        apply: apply
      };
    }
  });
})();

