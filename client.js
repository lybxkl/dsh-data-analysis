/**
 * 实证研究查看器 · Client 半片（单文件、零构建）。
 *
 * 只做两件事：看目录进度、看文件。没有阶段、没有闸门、没有运行按钮。
 * 数据契约（与 Host src/routes.js 一致）：
 *   GET  /data-analysis/api/state?workspaceId=
 *   GET  /data-analysis/api/artifacts/tree?workspaceId=
 *   GET  /data-analysis/api/artifacts/file?path=&workspaceId=
 *   GET  /data-analysis/api/artifacts/raw?path=&workspaceId=
 *   POST /data-analysis/api/workspace | workspace/forget | config
 *   GET  /data-analysis/api/session/project?sessionId=
 */
(function () {
  var MODULE_ID = '@local/dsh-data-analysis';
  var API = '/data-analysis/api';
  var POLL_MS = 4000;

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
        title: '实证研究查看器',
        refresh: '刷新',
        bind: '绑定目录',
        bindConfirm: '绑定',
        settings: '设置',
        close: '关闭',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        retry: '重试',
        remove: '移除',
        workspaces: '工作区',
        noWorkspaceTitle: '还没有绑定工作区',
        noWorkspaceHint: '绑定一个研究产物目录，插件只读展示。',
        bindTitle: '绑定工作区',
        bindDir: '目录',
        bindDirPh: '如 F:\\研究\\2026-数字政府',
        bindName: '名称',
        bindNamePh: '默认取目录名+日期',
        bindHint: '已有或新目录均可，插件不写入该目录。',
        pick: '选择',
        picking: '选择中…',
        pickTitle: '在弹出的系统窗口里选一个文件夹',
        pickUnsupported: '当前环境没有文件夹选择器，请手动粘贴路径。',
        settingsTitle: '设置',
        dataDirLabel: '台账目录（dataDir）',
        dataDirHint: '留空使用默认位置，切换后读取另一份工作区台账。',
        forgetTitle: '移除工作区登记',
        forgetHint: '只从台账移除，不删除磁盘目录。',
        forgetConfirm: '移除登记',
        progress: '产物目录',
        noProgress: '暂无产物',
        filter: '仅看',
        filterFiles: '筛选文件名/标题',
        clearFilter: '清除',
        loading: '读取中…',
        loadFail: '读取失败',
        treeEmpty: '暂无文件',
        treeMissing: '目录不存在或暂时无法读取。',
        tabFigures: '图',
        tabTables: '表',
        tabDocs: '文档',
        tabAll: '全部',
        tabCode: 'code',
        download: '下载',
        openNew: '新窗口打开',
        prev: '上一张（←）',
        next: '下一张（→）',
        tableRows: '行',
        tableCols: '列',
        tableTruncated: '仅显示前 200 行，可下载完整文件。',
        docHint: 'Word 文档请下载后查看。',
        imageUnsupported: '该格式无法在线预览，请下载原文件。',
        rawUnsupported: '该文件无法在线预览，请下载原文件。',
        scriptsHint: '暂无脚本',
        fileCount: '个文件',
        dirMissing: '目录不存在',
        at: '最近',
        nothingYet: '暂无更新',
        justNow: '刚刚',
        minutesAgo: '分钟前',
        hoursAgo: '小时前',
        daysAgo: '天前',
        workspaceUnavailable: '工作区不可用',
        unviewable: '无法在线预览，请下载原文件。',
        emptyTab: '暂无文件',
        emptyPrefix: '该目录暂无文件',
        other: '其他',
        treeHint: '产物写入 output/ 后会自动出现。',
        tooMany: '仅显示前 200 个，共 %n 个。',
        preview: '预览',
        dirRequired: '请先选择目录',
      };
      function t(key) {
        return ZH[key] || key;
      }

      /* ------------------------------------------------------------------ *
       * 基础工具
       * ------------------------------------------------------------------ */
      function agoText(ms) {
        var value = Number(ms || 0);
        if (!value) return t('nothingYet');
        var diff = Date.now() - value;
        if (diff < 60 * 1000) return t('justNow');
        if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' ' + t('minutesAgo');
        if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' ' + t('hoursAgo');
        return Math.floor(diff / 86400000) + ' ' + t('daysAgo');
      }
      function sizeText(bytes) {
        var n = Number(bytes || 0);
        if (!n) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
      }
      function extOf(rel) {
        var hit = String(rel || '').match(/\.[^./\\]+$/);
        return hit ? hit[0].toLowerCase() : '';
      }
      function cardLabel(entry) {
        return (entry && entry.title) || (entry && entry.name) || '';
      }
      function downloadLabel(entry) {
        if (!entry) return '';
        return entry.title ? entry.title + (entry.ext || '') : entry.name;
      }
      function pageVisible() {
        try {
          if (typeof document === 'undefined') return true;
          if (typeof document.visibilityState === 'string') return document.visibilityState === 'visible';
          return document.hidden !== true;
        } catch (error) {
          return true;
        }
      }

      var VIEWABLE_IMAGE = /^\.(png|jpe?g|webp|gif|bmp|avif)$/i;
      var HIDDEN_TWIN_EXT = /^\.(tiff?|hei[cf])$/i;
      var CODE_EXTS = /^\.(py|r|jl|do|sps|json|md)$/i;

      function artifactQuery(rel, wsId) {
        var q = '?path=' + encodeURIComponent(rel);
        if (wsId) q += '&workspaceId=' + encodeURIComponent(wsId);
        return q;
      }
      function artifactRawUrl(rel, download, wsId, version) {
        return API + '/artifacts/raw' + artifactQuery(rel, wsId)
          + (version ? '&v=' + encodeURIComponent(version) : '')
          + (download ? '&download=1' : '');
      }
      function artifactStem(rel) {
        return String(rel || '').replace(/\.[^./\\]+$/, '');
      }
      function artifactTwins(files) {
        var list = files || [];
        var byStem = {};
        list.forEach(function (entry) {
          var stem = artifactStem(entry.rel);
          (byStem[stem] || (byStem[stem] = [])).push(entry);
        });
        var hide = {};
        var twinOf = {};
        Object.keys(byStem).forEach(function (stem) {
          var bucket = byStem[stem];
          var preview = bucket.filter(function (entry) {
            return VIEWABLE_IMAGE.test(entry.ext) && entry.viewable !== false;
          })[0];
          if (!preview) return;
          bucket.forEach(function (entry) {
            if (!HIDDEN_TWIN_EXT.test(entry.ext) || entry.rel === preview.rel) return;
            hide[entry.rel] = true;
            if (!twinOf[preview.rel] || extOf(entry.rel) === '.tiff') twinOf[preview.rel] = entry.rel;
          });
        });
        return { hide: hide, twinOf: twinOf };
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

      /* ------------------------------------------------------------------ *
       * 宿主服务
       * ------------------------------------------------------------------ */
      var runtime = { ctx: null };
      var CURRENT_CHAT = { id: '' };
      // 面板重新挂载时先用上一帧渲染，避免闪一下空态；新快照到达后照常覆盖。
      var STATE_CACHE = { state: null, tree: null };
      function svc(name) {
        var ctx = runtime.ctx;
        if (!ctx) return null;
        try {
          if (typeof ctx.get === 'function') {
            var hit = ctx.get(name);
            if (hit) return hit;
          }
        } catch (error) {
          /* fall through */
        }
        try {
          if (ctx.reflect && typeof ctx.reflect.get === 'function') {
            var viaReflect = ctx.reflect.get(name);
            if (viaReflect) return viaReflect;
          }
        } catch (error) {
          /* fall through */
        }
        try {
          return ctx[name] || null;
        } catch (error) {
          return null;
        }
      }
      function openViewerPanel() {
        var layout = svc('layout');
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('data-analysis');
      }
      function pickDirectoryPath() {
        var bridge = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : null;
        if (bridge && typeof bridge.pick === 'function') return Promise.resolve(bridge.pick());
        var uiWorkspace = svc('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
          return Promise.resolve(uiWorkspace.pickDirectory());
        }
        return Promise.reject(new Error(t('pickUnsupported')));
      }

      /* ------------------------------------------------------------------ *
       * 通用零件
       * ------------------------------------------------------------------ */
      function Btn(props) {
        var cls = 'dsa-btn' + (props.variant ? ' ' + props.variant : '') + (props.className ? ' ' + props.className : '');
        return h('button', {
          type: 'button',
          className: cls,
          disabled: props.disabled,
          title: props.title || undefined,
          'aria-label': props.ariaLabel || undefined,
          'aria-expanded': props.ariaExpanded,
          'aria-pressed': props.ariaPressed,
          onClick: props.onClick,
        }, props.children);
      }
      function IconSvg(props) {
        var size = props.size || 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          className: props.className || undefined,
        }, props.children);
      }
      function GridIcon(props) {
        return h(IconSvg, { size: props.size || 16 },
          h('rect', { x: 2.2, y: 2.2, width: 4.7, height: 4.7, rx: 1.1 }),
          h('rect', { x: 9.1, y: 2.2, width: 4.7, height: 4.7, rx: 1.1 }),
          h('rect', { x: 2.2, y: 9.1, width: 4.7, height: 4.7, rx: 1.1 }),
          h('rect', { x: 9.1, y: 9.1, width: 4.7, height: 4.7, rx: 1.1 })
        );
      }
      function RefreshIcon(props) {
        return h(IconSvg, { className: props.spin ? 'dsa-spin' : undefined },
          h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
          h('path', { d: 'M13.2 2.8v3.4H9.8' })
        );
      }
      function PlusIcon() {
        return h(IconSvg, null, h('path', { d: 'M8 3v10M3 8h10' }));
      }
      function SlidersIcon() {
        return h(IconSvg, null,
          h('path', { d: 'M3 5h10M3 11h10' }),
          h('circle', { cx: 6, cy: 5, r: 1.6 }),
          h('circle', { cx: 10, cy: 11, r: 1.6 })
        );
      }
      function MenuIcon() {
        return h(IconSvg, null, h('path', { d: 'M3 5h10M3 8h10M3 11h10' }));
      }
      function SearchIcon() {
        return h(IconSvg, null, h('circle', { cx: 7, cy: 7, r: 3.6 }), h('path', { d: 'M9.8 9.8L13 13' }));
      }
      function CloseIcon() {
        return h(IconSvg, null, h('path', { d: 'M4 4l8 8M12 4l-8 8' }));
      }
      function FolderIcon(props) {
        var size = props.size || 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        }, h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z' }));
      }
      function Chip(props) {
        return h('span', { className: 'dsa-chip ' + (props.tone || ''), title: props.title || undefined }, props.children);
      }
      function Modal(props) {
        var boxRef = useRef(null);
        useEffect(function () {
          var node = boxRef.current;
          if (node && typeof node.focus === 'function') {
            try {
              node.focus();
            } catch (error) {
              /* ignore */
            }
          }
        }, []);
        useEffect(function () {
          if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
          function onKey(e) {
            if (e.key === 'Escape') {
              if (document.querySelector && document.querySelector('.dsa-lightbox')) return;
              if (props.onCancel) props.onCancel();
              return;
            }
            if (e.key !== 'Tab') return;
            var box = boxRef.current;
            if (!box) return;
            var nodes = [].slice.call(box.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'))
              .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
            if (!nodes.length) return;
            var first = nodes[0];
            var last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
          };
        }, [props.onCancel]);
        return h('div', { className: 'dsa-mask', onMouseDown: function (e) { if (e.target === e.currentTarget && props.onCancel) props.onCancel(); } },
          h('div', { className: 'dsa-modal', role: 'dialog', 'aria-modal': 'true', tabIndex: -1, ref: boxRef, 'aria-label': props.title },
            h('h2', null, props.title),
            props.desc ? h('p', null, props.desc) : null,
            props.error ? h('div', { className: 'dsa-error', role: 'alert' }, props.error) : null,
            props.children,
            h('div', { className: 'dsa-modal-foot' },
              h(Btn, { variant: 'ghost', onClick: props.onCancel, disabled: props.busy }, t('cancel')),
              props.onConfirm ? h(Btn, { variant: props.danger ? 'danger' : 'primary', onClick: props.onConfirm, disabled: props.busy }, props.confirmText || t('save')) : null
            )
          )
        );
      }
      function DirField(props) {
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var noteState = useState('');
        var note = noteState[0];
        var setNote = noteState[1];
        var choose = function () {
          if (busy) return;
          setBusy(true);
          setNote('');
          pickDirectoryPath().then(function (picked) {
            setBusy(false);
            if (picked) props.onChange(cleanPath(picked));
          }, function (err) {
            setBusy(false);
            setNote((err && err.message) || String(err));
          });
        };
        return h('div', { className: 'dsa-field' },
          h('label', { htmlFor: props.id || undefined }, props.label),
          h('div', { className: 'dsa-input-row' },
            h('input', {
              id: props.id || undefined,
              className: 'dsa-input',
              value: props.value,
              placeholder: props.placeholder,
              disabled: props.disabled,
              onChange: function (e) { setNote(''); props.onChange(e.target.value); },
            }),
            h(Btn, { onClick: choose, disabled: busy || props.disabled, title: t('pickTitle') },
              h(FolderIcon, null),
              h('span', null, busy ? t('picking') : t('pick'))
            )
          ),
          note ? h('div', { className: 'dsa-hint' }, note) : null
        );
      }
      function cleanPath(value) {
        var text = String(value || '').trim();
        if (/^file:\/\/\//i.test(text)) {
          try {
            text = decodeURIComponent(text.replace(/^file:\/\/\//i, ''));
            if (/^[a-zA-Z]:/.test(text) === false && text.charAt(0) === '/') text = text.slice(1);
            text = text.replace(/\//g, '\\');
          } catch (error) {
            /* 保持原样 */
          }
        }
        return text;
      }

      /* ------------------------------------------------------------------ *
       * 文件树（递归 <details>，code 与「全部」共用）
       * ------------------------------------------------------------------ */
      function buildTree(entries) {
        var nodes = Object.create(null);
        nodes[''] = [];
        (entries || []).forEach(function (entry) {
          var rel = String(entry.rel || '');
          var cut = rel.lastIndexOf('/');
          var parent = cut > 0 ? rel.slice(0, cut) : '';
          if (!nodes[parent]) nodes[parent] = [];
          nodes[parent].push(entry);
          if (entry.kind === 'dir' && !nodes[rel]) nodes[rel] = [];
        });
        return nodes;
      }
      function FileTree(props) {
        var nodes = useMemo(function () { return buildTree(props.entries); }, [props.entries]);
        var active = props.active || '';
        var renderLevel = function (parent, depth) {
          if (depth > 8) return null;
          var items = nodes[parent] || [];
          if (!items.length) return null;
          return h('ul', { className: 'dsa-tree' },
            items.map(function (entry) {
              if (entry.kind === 'dir') {
                return h('li', { key: entry.rel, className: 'dsa-tree-dir' },
                  h('details', { open: depth < 1 },
                    h('summary', null, entry.name),
                    renderLevel(entry.rel, depth + 1)
                  )
                );
              }
              return h('li', { key: entry.rel, className: 'dsa-tree-file' },
                h('button', {
                  type: 'button',
                  className: 'dsa-tree-item' + (active === entry.rel ? ' sel' : ''),
                  title: entry.rel,
                  onClick: function () { if (props.onPick) props.onPick(entry.rel); },
                }, cardLabel(entry))
              );
            })
          );
        };
        var rootNodes = (nodes[''] || []).slice();
        if (!rootNodes.length) return h('div', { className: 'dsa-hint' }, t('treeEmpty'));
        return h('div', { className: 'dsa-tree-wrap' },
          rootNodes.map(function (entry) {
            if (entry.kind === 'dir') {
              return h('details', { key: entry.rel, className: 'dsa-tree-root', open: true },
                h('summary', null, entry.name),
                renderLevel(entry.rel, 1)
              );
            }
            return h('button', {
              key: entry.rel,
              type: 'button',
              className: 'dsa-tree-item' + (active === entry.rel ? ' sel' : ''),
              onClick: function () { if (props.onPick) props.onPick(entry.rel); },
            }, cardLabel(entry));
          })
        );
      }

      /* ------------------------------------------------------------------ *
       * 通用查看器
       * ------------------------------------------------------------------ */
      var ARTIFACT_TABS = [
        { id: 'figures', label: 'tabFigures', test: function (entry) { return /^\.(png|jpe?g|webp|gif|bmp|avif|tiff?|hei[cf])$/i.test(entry.ext); } },
        { id: 'tables', label: 'tabTables', test: function (entry) { return entry.ext === '.csv' || entry.ext === '.tsv'; } },
        { id: 'docs', label: 'tabDocs', test: function (entry) { return ['.docx', '.pdf', '.md', '.txt', '.json', '.jsonl', '.html', '.log'].indexOf(entry.ext) >= 0; } },
        { id: 'all', label: 'tabAll', test: function () { return true; } },
        { id: 'code', label: 'tabCode', test: function (entry) { return String(entry.rel).indexOf('scripts/') === 0 && CODE_EXTS.test(entry.ext); } },
      ];

      function ArtifactViewer(props) {
        var wsId = props.workspaceId || '';
        var entries = props.entries || [];
        var prefix = props.prefix || '';
        var tabState = useState('figures');
        var tab = tabState[0];
        var setTab = tabState[1];
        var selState = useState('');
        var sel = selState[0];
        var setSel = selState[1];
        var detailState = useState({ loading: false, ok: false, error: '', data: null });
        var detail = detailState[0];
        var setDetail = detailState[1];
        var queryState = useState('');
        var query = queryState[0];
        var setQuery = queryState[1];
        var aliveRef = useRef(true);
        var lightboxRef = useRef(null);
        var detailSeqRef = useRef(0);
        useEffect(function () {
          aliveRef.current = true;
          return function () { aliveRef.current = false; };
        }, []);
        // 切工作区就收起预览，避免标题是新的、内容还是旧的
        useEffect(function () {
          detailSeqRef.current += 1;
          setSel('');
          setQuery('');
          setDetail({ loading: false, ok: false, error: '', data: null });
        }, [wsId]);

        var files = entries.filter(function (entry) { return entry.kind === 'file'; });
        var prefixDirs = props.prefixDirs || [];
        var scoped = prefixDirs.length
          ? files.filter(function (entry) {
            return prefixDirs.some(function (d) { return entry.rel === d || entry.rel.indexOf(d + '/') === 0; });
          })
          : prefix
            ? files.filter(function (entry) { return entry.rel === prefix || entry.rel.indexOf(prefix + '/') === 0; })
            : files;
        var twins = artifactTwins(scoped);
        var shown = scoped.filter(function (entry) { return !twins.hide[entry.rel]; });
        var activeTab = ARTIFACT_TABS.filter(function (item) { return item.id === tab; })[0] || ARTIFACT_TABS[0];
        var q = String(query || '').trim().toLowerCase();
        var matchesQuery = function (entry) {
          if (!q) return true;
          return String(entry.rel || '').toLowerCase().indexOf(q) >= 0
            || String(entry.title || '').toLowerCase().indexOf(q) >= 0;
        };
        var visible = shown.filter(activeTab.test).filter(matchesQuery).sort(function (a, b) { return String(a.rel).localeCompare(String(b.rel)); });
        var visibleBytes = visible.reduce(function (sum, entry) { return sum + (Number(entry.size) || 0); }, 0);
        var imageList = visible
          .filter(function (entry) { return entry.image === true || /^\.(png|jpe?g|webp|gif|tiff?|hei[cf])$/i.test(entry.ext); })
          .filter(function (entry) { return VIEWABLE_IMAGE.test(entry.ext) || HIDDEN_TWIN_EXT.test(entry.ext); })
          .map(function (entry) { return entry.rel; });
        var selEntry = sel ? entries.filter(function (entry) { return entry.rel === sel; })[0] : null;
        var selVersion = selEntry ? selEntry.mtimeMs : '';
        var twinRel = twins.twinOf[sel] || '';
        var viewIsImage = sel && imageList.indexOf(sel) >= 0;
        var selIndex = viewIsImage ? imageList.indexOf(sel) : -1;
        var step = function (delta) {
          if (!imageList.length) return;
          var next = selIndex < 0 ? 0 : (selIndex + delta + imageList.length) % imageList.length;
          open(imageList[next]);
        };

        var open = function (rel) {
          var seq = detailSeqRef.current + 1;
          detailSeqRef.current = seq;
          var ext = extOf(rel);
          var entry = entries.filter(function (item) { return item.rel === rel; })[0];
          setSel(rel);
          if (entry && entry.viewable === false) {
            setDetail({ loading: false, ok: false, error: t('unviewable'), data: null });
            return;
          }
          if (/^\.(png|jpe?g|webp|gif|bmp|avif|tiff?|hei[cf])$/i.test(ext)) {
            setDetail({ loading: false, ok: true, error: '', data: { kind: 'image', rel: rel } });
            return;
          }
          setDetail({ loading: true, ok: false, error: '', data: null });
          request('GET', '/artifacts/file' + artifactQuery(rel, wsId) + '&limit=200').then(function (json) {
            if (!aliveRef.current || seq !== detailSeqRef.current) return;
            if (!json || !json.ok || (json.rel && json.rel !== rel)) {
              setDetail({ loading: false, ok: false, error: (json && json.error) || t('loadFail'), data: null });
              return;
            }
            setDetail({ loading: false, ok: true, error: '', data: json });
          }).catch(function (error) {
            if (!aliveRef.current || seq !== detailSeqRef.current) return;
            setDetail({ loading: false, ok: false, error: String((error && error.message) || error), data: null });
          });
        };

        useEffect(function () {
          if (!sel) return;
          var node = lightboxRef.current;
          if (node && typeof node.focus === 'function') {
            try { node.focus(); } catch (error) { /* ignore */ }
          }
        }, [sel]);

        useEffect(function () {
          if (!sel || typeof window === 'undefined' || !window.addEventListener) return;
          function onKey(event) {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setSel('');
            } else if (event.key === 'ArrowLeft' && viewIsImage) {
              event.preventDefault();
              step(-1);
            } else if (event.key === 'ArrowRight' && viewIsImage) {
              event.preventDefault();
              step(1);
            } else if (event.key === 'Tab' && typeof document !== 'undefined') {
              var root = document.querySelector('.dsa-lightbox');
              if (!root) return;
              var nodes = [].slice.call(root.querySelectorAll('button,[href],[tabindex]:not([tabindex="-1"])'))
                .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
              if (!nodes.length) return;
              var first = nodes[0];
              var last = nodes[nodes.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }, [sel, imageList.join('|'), wsId]);

        var overlayBody = null;
        if (detail.loading) overlayBody = h('div', { className: 'dsa-hint' }, t('loading'));
        else if (!detail.ok) overlayBody = h('div', { className: 'dsa-error', role: 'alert' }, detail.error || t('loadFail'));
        else if (detail.data && detail.data.kind === 'image') {
          if (VIEWABLE_IMAGE.test(extOf(sel))) {
            overlayBody = h('div', { className: 'dsa-lightbox-stage' },
              h('img', { className: 'dsa-lightbox-img', src: artifactRawUrl(sel, false, wsId, selVersion), alt: sel })
            );
          } else {
            overlayBody = h('div', { className: 'dsa-empty' },
              h('b', null, extOf(sel).replace('.', '').toUpperCase()),
              h('p', null, t('imageUnsupported')),
              h('a', { className: 'dsa-link', href: artifactRawUrl(sel, true, wsId) }, t('download'))
            );
          }
        } else if (detail.data && detail.data.kind === 'table') {
          overlayBody = h('div', { className: 'dsa-tablewrap dsa-tablewrap-lg' },
            h('div', { className: 'dsa-hint' }, detail.data.totalRows + ' ' + t('tableRows') + ' × ' + detail.data.header.length + ' ' + t('tableCols') + (detail.data.truncated ? '（' + t('tableTruncated') + '）' : '')),
            h('table', { className: 'dsa-table' },
              h('thead', null, h('tr', null, detail.data.header.map(function (name) { return h('th', { key: name }, name); }))),
              h('tbody', null, detail.data.rows.map(function (row, index) {
                return h('tr', { key: index }, row.map(function (cell, cellIndex) { return h('td', { key: cellIndex }, String(cell)); }));
              }))
            )
          );
        } else if (detail.data && (detail.data.kind === 'text' || detail.data.kind === 'json')) {
          overlayBody = h('pre', { className: 'dsa-pre dsa-pre-lg' }, String(detail.data.text || '').slice(0, 200000));
        } else if (detail.data && detail.data.kind === 'pdf') {
          overlayBody = h('iframe', { className: 'dsa-lightbox-pdf', src: artifactRawUrl(sel, false, wsId, selVersion), title: sel });
        } else if (detail.data && detail.data.kind === 'document') {
          overlayBody = h('div', { className: 'dsa-empty' },
            h('b', null, 'DOCX'),
            h('p', null, t('docHint')),
            h('a', { className: 'dsa-link', href: artifactRawUrl(sel, true, wsId) }, t('download'))
          );
        }

        var lightbox = sel ? h('div', {
          className: 'dsa-lightbox',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('preview') + '：' + sel,
          onClick: function (event) { if (event.target === event.currentTarget) setSel(''); },
        },
          h('div', { className: 'dsa-lightbox-card' + (viewIsImage ? '' : ' wide'), ref: lightboxRef, tabIndex: -1 },
            h('div', { className: 'dsa-lightbox-bar' },
              h('b', { className: 'dsa-lightbox-name', title: sel }, selEntry ? cardLabel(selEntry) : sel),
              h('span', { className: 'dsa-spacer' }),
              viewIsImage && imageList.length > 1 ? h('span', { className: 'dsa-hint' }, (selIndex + 1) + ' / ' + imageList.length) : null,
              h('a', { className: 'dsa-link', href: artifactRawUrl(sel, false, wsId, selVersion), target: '_blank', rel: 'noreferrer' }, t('openNew')),
              h('a', { className: 'dsa-link', href: artifactRawUrl(sel, true, wsId), download: selEntry ? downloadLabel(selEntry) : undefined }, t('download')),
              twinRel ? h('a', { className: 'dsa-link', href: artifactRawUrl(twinRel, true, wsId), title: twinRel },
                t('download') + ' ' + extOf(twinRel).replace('.', '').toUpperCase()) : null,
              h(Btn, { variant: 'ghost', onClick: function () { setSel(''); } }, t('close'))
            ),
            overlayBody,
            viewIsImage && imageList.length > 1 ? h('div', { className: 'dsa-lightbox-navs' },
              h('button', { type: 'button', className: 'dsa-lightbox-nav prev', 'aria-label': t('prev'), onClick: function () { step(-1); } }, '‹'),
              h('button', { type: 'button', className: 'dsa-lightbox-nav next', 'aria-label': t('next'), onClick: function () { step(1); } }, '›')
            ) : null
          )
        ) : null;

        var codeTab = tab === 'code';
        var treeEntries = entries;
        if (codeTab) {
          var codeFiles = entries.filter(function (entry) {
            return entry.kind === 'file' && (entry.rel === 'scripts' || String(entry.rel).indexOf('scripts/') === 0) && CODE_EXTS.test(entry.ext);
          });
          var codeDirs = { scripts: true };
          codeFiles.forEach(function (entry) {
            var parent = String(entry.rel);
            while (parent.indexOf('/') > 0) {
              parent = parent.slice(0, parent.lastIndexOf('/'));
              codeDirs[parent] = true;
            }
          });
          treeEntries = entries.filter(function (entry) {
            return entry.kind === 'file' ? codeFiles.indexOf(entry) >= 0 : codeDirs[entry.rel] === true;
          });
        }
        var grid = visible.slice(0, 200).map(function (entry) {
          var isImage = entry.image === true || /^\.(png|jpe?g|webp|gif|tiff?|hei[cf])$/i.test(entry.ext);
          var canPreview = entry.viewable !== false && VIEWABLE_IMAGE.test(entry.ext);
          return h('button', {
            key: entry.rel,
            type: 'button',
            className: 'dsa-card' + (sel === entry.rel ? ' sel' : ''),
            title: entry.rel,
            onClick: function () { open(entry.rel); },
          },
            canPreview ? h('img', { className: 'dsa-card-thumb', src: artifactRawUrl(entry.rel, false, wsId, entry.mtimeMs), alt: cardLabel(entry), loading: 'lazy' })
              : h('span', { className: 'dsa-card-ext' }, (entry.ext || '?').replace('.', '').toUpperCase() || '?'),
            h('span', { className: 'dsa-card-name' }, cardLabel(entry)),
            h('span', { className: 'dsa-card-meta' }, sizeText(entry.size))
          );
        });

        var bar = h('div', { className: 'dsa-vbar' },
          h('div', { className: 'dsa-tabs', role: 'tablist' },
            ARTIFACT_TABS.map(function (item, index) {
              var count = shown.filter(item.test).filter(matchesQuery).length;
              var selected = tab === item.id;
              return h('button', {
                key: item.id,
                id: 'dsa-tab-' + item.id,
                type: 'button',
                role: 'tab',
                'aria-selected': selected ? 'true' : 'false',
                'aria-controls': 'dsa-tabpanel',
                tabIndex: selected ? 0 : -1,
                className: 'dsa-tab' + (selected ? ' sel' : ''),
                onClick: function () { setTab(item.id); },
                onKeyDown: function (event) {
                  var keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
                  if (keys.indexOf(event.key) < 0) return;
                  event.preventDefault();
                  var next = event.key === 'Home' ? 0
                    : event.key === 'End' ? ARTIFACT_TABS.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : -1) + ARTIFACT_TABS.length) % ARTIFACT_TABS.length;
                  setTab(ARTIFACT_TABS[next].id);
                  var parent = event.currentTarget && event.currentTarget.parentNode;
                  var node = parent && parent.children[next];
                  if (node && node.focus) node.focus();
                },
              },
                h('span', null, t(item.label)),
                h('span', { className: 'dsa-tab-count' }, count)
              );
            })
          ),
          h('div', { className: 'dsa-search' },
            h(SearchIcon, null),
            h('input', {
              className: 'dsa-search-input',
              type: 'text',
              value: query,
              placeholder: t('filterFiles'),
              'aria-label': t('filterFiles'),
              onChange: function (event) { setQuery(event.target.value); },
            }),
            query ? h('button', {
              type: 'button',
              className: 'dsa-search-clear',
              title: t('clearFilter'),
              'aria-label': t('clearFilter'),
              onClick: function () { setQuery(''); },
            }, h(CloseIcon, null)) : null
          ),
          h('span', { className: 'dsa-spacer' }),
          prefix ? h('span', { className: 'dsa-filter' },
            h('span', null, t('filter') + ' ' + (props.prefixLabel || prefix)),
            h('button', { type: 'button', className: 'dsa-link', title: t('clearFilter'), 'aria-label': t('clearFilter'), onClick: props.onClearPrefix }, t('clearFilter'))
          ) : null,
          h('span', { className: 'dsa-meta' },
            h('span', null, (props.truncated ? '≥ ' : '') + visible.length + ' ' + t('fileCount')),
            visibleBytes ? h('span', null, sizeText(visibleBytes)) : null
          )
        );

        var body;
        if (props.loading) body = h('div', { className: 'dsa-empty' }, h('p', { className: 'dsa-hint' }, t('loading')));
        else if (props.error) body = h('div', { className: 'dsa-error', role: 'alert' }, props.error);
        else if (!visible.length) {
          var emptyHint = prefix ? t('emptyPrefix') : codeTab ? t('scriptsHint') : tab === 'all' ? t('treeHint') : t('emptyTab');
          body = h('div', { className: 'dsa-empty' },
            h('span', { className: 'dsa-empty-icon' }, h(FolderIcon, { size: 32 })),
            files.length ? null : h('b', null, t('noProgress')),
            h('p', null, emptyHint)
          );
        }
        else {
          body = h('div', { className: 'dsa-grid' }, grid);
          if (visible.length > 200) body = h('div', null, body, h('div', { className: 'dsa-hint' }, t('tooMany').replace('%n', visible.length)));
        }

        var panelProps = { role: 'tabpanel', id: 'dsa-tabpanel', 'aria-labelledby': 'dsa-tab-' + tab };
        var panelBody = function () {
          return h('div', Object.assign({ className: 'dsa-viewer-body' }, panelProps), body);
        };

        return h('div', { className: 'dsa-viewer' },
          bar,
          codeTab || tab === 'all' ? h('div', { className: 'dsa-viewer-split' },
            h('div', { className: 'dsa-tree-pane' }, h(FileTree, { entries: treeEntries, active: sel, onPick: open })),
            panelBody()
          ) : panelBody(),
          lightbox
        );
      }

      /* ------------------------------------------------------------------ *
       * 目录进度
       * ------------------------------------------------------------------ */
      function ProgressRail(props) {
        var progress = props.progress || [];
        var layout = props.layout || { ok: false, groups: [], stray: [] };
        var byDir = {};
        progress.forEach(function (item) { byDir[item.dir] = item; });
        function agg(dirs) {
          var count = 0;
          var latest = 0;
          dirs.forEach(function (d) {
            var it = byDir[d];
            if (it) {
              count += Number(it.fileCount) || 0;
              latest = Math.max(latest, Number(it.latestMtime) || 0);
            }
          });
          return { count: count, latest: latest || null };
        }
        // 有闸门分组报告时渲染规范组（跨运行稳定）；旧工作区无报告回退物理目录
        var rows;
        if (layout.ok && layout.groups.length) {
          rows = layout.groups.map(function (g) {
            return { key: g.key, name: g.label, dirs: g.dirs, title: g.dirs.join(', ') };
          });
          if (layout.stray.length) {
            rows.push({ key: '__stray', name: t('other'), dirs: layout.stray, title: layout.stray.join(', ') });
          }
        } else {
          rows = progress.map(function (item) {
            return { key: item.dir, name: item.name, dirs: [item.dir], title: item.dir };
          });
        }
        return h('div', { className: 'dsa-prog' },
          h('div', { className: 'dsa-rail-h' }, h('span', null, t('progress'))),
          !rows.length ? h('div', { className: 'dsa-prog-empty' }, t('noProgress')) : null,
          rows.map(function (row) {
            var active = props.prefix === row.key;
            var meta = agg(row.dirs);
            return h('button', {
              key: row.key,
              type: 'button',
              className: 'dsa-prog-item' + (active ? ' sel' : ''),
              title: row.title,
              'aria-pressed': active ? 'true' : undefined,
              onClick: function () { props.onPick(active ? '' : row.key); },
            },
              h('span', { className: 'dsa-prog-name' }, row.name),
              h('span', { className: 'dsa-prog-meta' },
                h('span', null, meta.count + ' ' + t('fileCount')),
                h('span', null, t('at') + ' ' + agoText(meta.latest))
              )
            );
          })
        );
      }

      /* ------------------------------------------------------------------ *
       * 工作区左栏
       * ------------------------------------------------------------------ */
      function WorkspaceRail(props) {
        var workspaces = props.workspaces || [];
        return h('div', { className: 'dsa-rail-scroll' },
          h('div', { className: 'dsa-rail-h' }, h('span', null, t('workspaces'))),
          h('div', { className: 'dsa-ws-list' },
            workspaces.map(function (item) {
              var active = props.activeId === item.id;
              var missing = item.missing === true;
              return h('div', { key: item.id, className: 'dsa-ws-row' + (active ? ' sel' : '') + (missing ? ' missing' : '') },
                h('button', {
                  type: 'button',
                  className: 'dsa-ws',
                  title: item.root,
                  'aria-current': active ? 'true' : undefined,
                  onClick: function () { props.onSelect(item.id); },
                },
                  h('span', { className: 'dsa-ws-line' },
                    active ? h('span', { className: 'dsa-dot' }) : null,
                    h('span', { className: 'dsa-ws-name' }, item.name || item.root),
                    h('span', { className: 'dsa-ws-count' }, missing ? t('dirMissing') : (Number(item.fileCount) || 0) + ' ' + t('fileCount'))
                  ),
                  h('span', { className: 'dsa-ws-path' }, item.root)
                ),
                h('button', {
                  type: 'button',
                  className: 'dsa-ws-remove',
                  title: t('remove'),
                  'aria-label': '移除登记',
                  onClick: function (e) { e.stopPropagation(); props.onForget(item); },
                }, t('remove'))
              );
            })
          ),
          h(ProgressRail, { progress: props.progress, layout: props.layout, prefix: props.prefix, onPick: props.onPickPrefix })
        );
      }

      /* ------------------------------------------------------------------ *
       * 对话框
       * ------------------------------------------------------------------ */
      function BindDialog(props) {
        var dirState = useState('');
        var dir = dirState[0];
        var setDir = dirState[1];
        var nameState = useState('');
        var name = nameState[0];
        var setName = nameState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var submit = function () {
          if (busy) return;
          if (!String(dir).trim()) {
            setError(t('dirRequired'));
            return;
          }
          setBusy(true);
          setError('');
          request('POST', '/workspace', { dir: cleanPath(dir), name: name, sessionId: props.sessionId || '' }).then(function (json) {
            setBusy(false);
            if (!json || !json.ok) {
              setError((json && json.error) || '绑定失败');
              return;
            }
            if (props.onDone) props.onDone(json);
          }).catch(function (err) {
            setBusy(false);
            setError(String((err && err.message) || err));
          });
        };
        return h(Modal, {
          title: t('bindTitle'),
          desc: t('bindHint'),
          error: error,
          busy: busy,
          confirmText: busy ? t('saving') : t('bindConfirm'),
          onCancel: props.onCancel,
          onConfirm: submit,
        },
          h('div', { className: 'dsa-form' },
            h(DirField, { id: 'dsa-bind-dir', label: t('bindDir'), value: dir, placeholder: t('bindDirPh'), disabled: busy, onChange: setDir }),
            h('div', { className: 'dsa-field' },
              h('label', { htmlFor: 'dsa-bind-name' }, t('bindName')),
              h('input', { id: 'dsa-bind-name', className: 'dsa-input', value: name, placeholder: t('bindNamePh'), disabled: busy, onChange: function (e) { setName(e.target.value); } })
            )
          )
        );
      }
      function SettingsDialog(props) {
        var dirState = useState((props.config && props.config.dataDir) || '');
        var dataDir = dirState[0];
        var setDataDir = dirState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var submit = function () {
          if (busy) return;
          setBusy(true);
          setError('');
          request('POST', '/config', { dataDir: String(dataDir || '').trim() }).then(function (json) {
            setBusy(false);
            if (!json || !json.ok) {
              setError((json && json.error) || '保存失败');
              return;
            }
            if (props.onDone) props.onDone(json);
          }).catch(function (err) {
            setBusy(false);
            setError(String((err && err.message) || err));
          });
        };
        return h(Modal, {
          title: t('settingsTitle'),
          desc: t('dataDirHint'),
          error: error,
          busy: busy,
          confirmText: busy ? t('saving') : t('save'),
          onCancel: props.onCancel,
          onConfirm: submit,
        },
          h('div', { className: 'dsa-form' },
            h('div', { className: 'dsa-field' },
              h('label', { htmlFor: 'dsa-data-dir' }, t('dataDirLabel')),
              h('input', { id: 'dsa-data-dir', className: 'dsa-input', value: dataDir, placeholder: '<profile>/data-analysis', disabled: busy, onChange: function (e) { setDataDir(e.target.value); } })
            )
          )
        );
      }
      function ForgetDialog(props) {
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var submit = function () {
          if (busy) return;
          setBusy(true);
          setError('');
          request('POST', '/workspace/forget', { id: props.workspace.id }).then(function (json) {
            setBusy(false);
            if (!json || !json.ok) {
              setError((json && json.error) || '移除失败');
              return;
            }
            if (props.onDone) props.onDone(json);
          }).catch(function (err) {
            setBusy(false);
            setError(String((err && err.message) || err));
          });
        };
        return h(Modal, {
          title: t('forgetTitle'),
          desc: t('forgetHint'),
          error: error,
          busy: busy,
          danger: true,
          confirmText: busy ? t('saving') : t('forgetConfirm'),
          onCancel: props.onCancel,
          onConfirm: submit,
        },
          h('div', { className: 'dsa-kv' },
            h('span', null, props.workspace.name || props.workspace.root),
            h('span', { className: 'dsa-mono' }, props.workspace.root)
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 面板
       * ------------------------------------------------------------------ */
      function Panel(props) {
        var stateTuple = useState(STATE_CACHE.state);
        var snap = stateTuple[0];
        var setSnap = stateTuple[1];
        var treeTuple = useState(STATE_CACHE.tree);
        var tree = treeTuple[0];
        var setTree = treeTuple[1];
        var selectedState = useState('');
        var selectedId = selectedState[0];
        var setSelectedId = selectedState[1];
        var prefixState = useState('');
        var prefix = prefixState[0];
        var setPrefix = prefixState[1];
        var dialogState = useState(null);
        var dialog = dialogState[0];
        var setDialog = dialogState[1];
        var loadingState = useState(!STATE_CACHE.state);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var refreshingState = useState(false);
        var refreshing = refreshingState[0];
        var setRefreshing = refreshingState[1];
        var errState = useState('');
        var error = errState[0];
        var setError = errState[1];
        var widthState = useState('wide');
        var width = widthState[0];
        var setWidth = widthState[1];
        var themeState = useState('light');
        var theme = themeState[0];
        var setTheme = themeState[1];
        var railOpenState = useState(false);
        var railOpen = railOpenState[0];
        var setRailOpen = railOpenState[1];

        var aliveRef = useRef(true);
        var seqRef = useRef(0);
        var manualRef = useRef(false);
        var followSeqRef = useRef(0);
        var rootRef = useRef(null);
        var roRef = useRef(null);
        var snapRef = useRef(null);
        var selectedRef = useRef('');
        snapRef.current = snap;
        selectedRef.current = selectedId;

        var sessionId = String((props && props.sessionId) || CURRENT_CHAT.id || '');

        var load = useCallback(function (wsId) {
          var seq = seqRef.current + 1;
          seqRef.current = seq;
          if (!snapRef.current) setLoading(true);
          var wanted = wsId === undefined ? selectedRef.current : wsId;
          var qs = wanted ? '?workspaceId=' + encodeURIComponent(wanted) : '';
          var stateReq = request('GET', '/state' + qs);
          var treeReq = request('GET', '/artifacts/tree' + qs);
          return Promise.all([stateReq, treeReq]).then(function (values) {
            if (!aliveRef.current || seq !== seqRef.current) return null;
            var nextState = values[0];
            var nextTree = values[1];
            if (nextState && nextState.ok) {
              var state = nextState.state || {};
              setSnap(state);
              snapRef.current = state;
              var activeId = state.active ? state.active.id : '';
              if (selectedRef.current !== activeId) {
                selectedRef.current = activeId;
                setSelectedId(activeId);
              }
              var useTree = nextTree && nextTree.ok ? nextTree : state.tree && state.tree.ok ? state.tree : null;
              STATE_CACHE.state = state;
              STATE_CACHE.tree = useTree;
              setTree(useTree);
              setError('');
            } else {
              setError((nextState && nextState.error) || t('loadFail'));
            }
            return nextState;
          }).catch(function (err) {
            if (!aliveRef.current || seq !== seqRef.current) return null;
            setError(String((err && err.message) || err));
            return null;
          }).then(function (value) {
            if (aliveRef.current && seq === seqRef.current) setLoading(false);
            return value;
          });
        }, []);

        useEffect(function () {
          aliveRef.current = true;
          return function () {
            aliveRef.current = false;
          };
        }, []);

        // 首屏 + 可见性轮询：4s 一次；hidden 暂停，回到前台立即补一次
        useEffect(function () {
          void load();
          var timer = setInterval(function () {
            if (!pageVisible()) return;
            void load();
          }, POLL_MS);
          function onVisibility() {
            if (pageVisible()) void load();
          }
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility);
          }
          return function () {
            clearInterval(timer);
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisibility);
            }
          };
        }, [load]);

        // 换会话 = 重新允许跟随（用户手动点过的工作区在本次会话里不再被拽回）
        useEffect(function () {
          manualRef.current = false;
        }, [sessionId]);

        // 跟着对话走：每轮都核对宿主里这条会话的绑定；模型改绑后也能跟上
        useEffect(function () {
          if (!sessionId || manualRef.current) return;
          var seq = followSeqRef.current + 1;
          followSeqRef.current = seq;
          request('GET', '/session/project?sessionId=' + encodeURIComponent(sessionId)).then(function (json) {
            if (seq !== followSeqRef.current || !aliveRef.current) return;
            if (!json || !json.ok || !json.workspace) return;
            var id = json.workspace.id;
            if (selectedRef.current === id) return;
            selectedRef.current = id;
            setSelectedId(id);
            setPrefix('');
            void load(id);
          }).catch(function () {
            /* 跟不过去就停在当前选择，不打断浏览 */
          });
        }, [sessionId, load, snap]);

        var measureRoot = useCallback(function () {
          var el = rootRef.current;
          if (!el) return;
          var w = el.clientWidth || 0;
          var next = w <= 760 ? 'narrow' : w <= 1040 ? 'compact' : 'wide';
          setWidth(function (prev) { return prev === next ? prev : next; });
        }, []);
        var attachRoot = useCallback(function (node) {
          rootRef.current = node;
          if (!node) return;
          if (roRef.current) {
            try {
              roRef.current.observe(node);
            } catch (error) {
              /* ignore */
            }
          }
          measureRoot();
          setTimeout(measureRoot, 0);
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
              try {
                roRef.current.disconnect();
              } catch (error) {
                /* ignore */
              }
            }
          };
        }, [measureRoot]);

        // 跟随宿主主题：读 html 的 color-scheme / body 背景亮度，再退回系统偏好
        useEffect(function () {
          if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
          function detect() {
            var dark = null;
            try {
              var scheme = String(window.getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
              if (scheme) dark = scheme.indexOf('dark') >= 0;
            } catch (error) {
              /* fall through */
            }
            if (dark === null) {
              var bg = '';
              try {
                bg = window.getComputedStyle(document.body).backgroundColor || '';
              } catch (error) {
                /* fall through */
              }
              var parts = (/rgba?\(([^)]+)\)/.exec(bg) || [])[1];
              var rgb = parts ? parts.split(',').map(Number) : null;
              if (rgb && (rgb.length < 4 || rgb[3] > 0.05)) {
                dark = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5;
              } else {
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

        var selectWorkspace = function (id) {
          if (!id) return;
          manualRef.current = true;
          selectedRef.current = id;
          setSelectedId(id);
          setPrefix('');
          setRailOpen(false);
          void load(id);
          request('POST', '/workspace', { id: id }).catch(function () {
            /* 选择失败时保持当前视图 */
          });
        };
        var refresh = function () {
          setRefreshing(true);
          Promise.resolve(load()).then(function () {
            if (aliveRef.current) setRefreshing(false);
          }, function () {
            if (aliveRef.current) setRefreshing(false);
          });
        };
        var onBindDone = function (json) {
          setDialog(null);
          manualRef.current = false;
          var id = json.workspace ? json.workspace.id : (json.state && json.state.active ? json.state.active.id : '');
          if (json.state) {
            STATE_CACHE.state = json.state;
            STATE_CACHE.tree = json.state.tree || null;
            setSnap(json.state);
            setTree(json.state.tree || null);
            selectedRef.current = id;
            setSelectedId(id);
            setPrefix('');
          }
          void load(id);
        };
        var onSettingsDone = function (json) {
          setDialog(null);
          manualRef.current = false;
          var id = json.state && json.state.active ? json.state.active.id : '';
          if (json.state) {
            STATE_CACHE.state = json.state;
            STATE_CACHE.tree = json.state.tree || null;
            setSnap(json.state);
            setTree(json.state.tree || null);
            selectedRef.current = id;
            setSelectedId(id);
            setPrefix('');
          }
          void load(id);
        };
        var onForgetDone = function () {
          setDialog(null);
          selectedRef.current = '';
          setSelectedId('');
          setPrefix('');
          void load('');
        };

        var workspaces = (snap && snap.workspaces) || [];
        var active = snap && snap.active;
        var activeError = (snap && snap.activeError) || '';
        var progress = (snap && snap.progress) || [];
        var layout = (snap && snap.layout) || { ok: false, groups: [], stray: [] };
        var prefixDirs = [];
        var prefixLabel = '';
        if (prefix && layout.ok) {
          if (prefix === '__stray') {
            prefixDirs = layout.stray;
            prefixLabel = t('other');
          } else {
            var pickedGroup = layout.groups.filter(function (g) { return g.key === prefix; })[0];
            if (pickedGroup) {
              prefixDirs = pickedGroup.dirs;
              prefixLabel = pickedGroup.label;
            }
          }
        }
        // 分组报告消失时残留的组前缀会空过滤：非物理目录前缀一律清空回退
        var usablePrefix = prefix;
        if (prefix && !layout.ok && !progress.some(function (p) { return p.dir === prefix; })) {
          usablePrefix = '';
        }
        var treeEntries = (tree && tree.ok && tree.entries) || [];
        var treeError = tree && tree.ok === false ? (tree.error || t('treeMissing')) : '';

        var content;
        if (!snap && loading) {
          content = h('div', { className: 'dsa-canvas' },
            h('div', { className: 'dsa-empty' },
              h('span', { className: 'dsa-empty-icon' }, h(GridIcon, { size: 32 })),
              h('p', { className: 'dsa-hint' }, t('loading'))
            )
          );
        } else if (!snap && error) {
          content = h('div', { className: 'dsa-canvas' },
            h('div', { className: 'dsa-empty' },
              h('b', null, t('loadFail')),
              h('p', null, error),
              h(Btn, { onClick: refresh }, h(RefreshIcon, null), h('span', null, t('retry')))
            )
          );
        } else if (!active) {
          content = h('div', { className: 'dsa-canvas' },
            h('div', { className: 'dsa-empty dsa-welcome' },
              h('span', { className: 'dsa-empty-icon' }, h(FolderIcon, { size: 32 })),
              h('b', null, activeError ? t('workspaceUnavailable') : t('noWorkspaceTitle')),
              h('p', null, activeError || t('noWorkspaceHint')),
              h(Btn, {
                variant: 'primary',
                onClick: function () { setDialog({ kind: 'bind' }); },
              }, h(PlusIcon, null), h('span', null, t('bind')))
            )
          );
        } else {
          content = h('div', { className: 'dsa-canvas' },
            activeError ? h('div', { className: 'dsa-error' }, activeError) : null,
            h(ArtifactViewer, {
              workspaceId: selectedId || (active && active.id) || '',
              entries: treeEntries,
              loading: loading && !treeEntries.length,
              error: treeError,
              truncated: tree && tree.truncated === true,
              totalBytes: tree && tree.totalBytes,
              prefix: usablePrefix,
              prefixDirs: prefixDirs,
              prefixLabel: prefixLabel,
              onClearPrefix: function () { setPrefix(''); },
            })
          );
        }

        var header = h('div', { className: 'dsa-top' },
          h('div', { className: 'dsa-brand' },
            h('span', { className: 'dsa-logo' }, h(GridIcon, { size: 18 })),
            h('b', null, t('title'))
          ),
          width !== 'wide' ? h(Btn, {
            className: 'dsa-rail-toggle',
            variant: 'ghost',
            title: t('workspaces'),
            ariaLabel: t('workspaces'),
            ariaExpanded: railOpen,
            onClick: function () { setRailOpen(!railOpen); },
          }, h(MenuIcon, null), h('span', { className: 'dsa-btn-label' }, t('workspaces'))) : null,
          h('span', { className: 'dsa-spacer' }),
          active ? h(Chip, { title: active.root }, h('span', { className: 'dsa-dot' }), h('span', { className: 'dsa-chip-name' }, active.name)) : null,
          error && snap ? h(Chip, { tone: 'err', title: error }, t('loadFail')) : null,
          h(Btn, { onClick: refresh, disabled: loading && !snap, title: t('refresh') }, h(RefreshIcon, { spin: refreshing }), h('span', { className: 'dsa-btn-label' }, t('refresh'))),
          h(Btn, { variant: 'primary', onClick: function () { setDialog({ kind: 'bind' }); }, title: t('bind') }, h(PlusIcon, null), h('span', { className: 'dsa-btn-label' }, t('bind'))),
          h(Btn, { variant: 'ghost', onClick: function () { setDialog({ kind: 'settings' }); }, title: t('settings'), ariaLabel: t('settings') }, h(SlidersIcon, null), h('span', { className: 'dsa-btn-label' }, t('settings')))
        );

        var rail = h('div', { className: 'dsa-rail' },
          h(WorkspaceRail, {
            workspaces: workspaces,
            activeId: selectedId || (active && active.id) || '',
            progress: progress,
            layout: layout,
            prefix: usablePrefix,
            onSelect: selectWorkspace,
            onForget: function (item) { setDialog({ kind: 'forget', workspace: item }); },
            onPickPrefix: function (value) { setPrefix(value); },
          })
        );
        var railBackdrop = width === 'narrow' && railOpen
          ? h('div', { className: 'dsa-rail-backdrop', onClick: function () { setRailOpen(false); } })
          : null;

        var dialogs = null;
        if (dialog && dialog.kind === 'bind') {
          dialogs = h(BindDialog, { sessionId: sessionId, onCancel: function () { setDialog(null); }, onDone: onBindDone });
        } else if (dialog && dialog.kind === 'settings') {
          dialogs = h(SettingsDialog, { config: snap && snap.config, onCancel: function () { setDialog(null); }, onDone: onSettingsDone });
        } else if (dialog && dialog.kind === 'forget') {
          dialogs = h(ForgetDialog, { workspace: dialog.workspace, onCancel: function () { setDialog(null); }, onDone: onForgetDone });
        }

        return h('div', {
          className: 'dsa-root',
          ref: attachRoot,
          'data-dsa-width': width,
          'data-dsa-theme': theme,
        },
          header,
          h('div', { className: 'dsa-body' },
            railBackdrop,
            width === 'narrow' && !railOpen ? null : rail,
            h('div', { className: 'dsa-main' }, content, dialogs)
          )
        );
      }

      /* ------------------------------------------------------------------ *
       * 原生对话里的入口
       * ------------------------------------------------------------------ */
      function WorkbenchIcon() {
        return h('svg', {
          viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        }, h('path', { d: 'M3 3.5h5.5v5H3zM11.5 3.5H17v5h-5.5zM3 11.5h5.5v5H3zM11.5 11.5H17v5h-5.5z' }));
      }
      function OpenWorkbenchAction(props) {
        var sessionId = (props && props.sessionId) || '';
        useEffect(function () {
          if (sessionId) CURRENT_CHAT.id = sessionId;
        }, [sessionId]);
        return h('span', { className: 'dsa-cmp' },
          h('button', {
            type: 'button',
            className: 'dsa-chat-btn',
            onClick: function () {
              if (sessionId) CURRENT_CHAT.id = sessionId;
              openViewerPanel();
            },
          }, h('span', { className: 'dsa-chat-glyph' }, h(GridIcon, { size: 14 })), ' ' + t('title'))
        );
      }

      /* ------------------------------------------------------------------ *
       * 样式
       * ------------------------------------------------------------------ */
      var CSS = [
        '.dsa-root{',
        '  --dsa-bg:#f5f6f8;--dsa-band:#fbfbfc;--dsa-panel:#fff;--dsa-card2:#f5f6f8;',
        '  --dsa-ink:#171b22;--dsa-ink2:#5d6573;--dsa-ink3:#666f7d;',
        '  --dsa-line:rgba(23,27,34,.09);--dsa-line2:rgba(23,27,34,.16);',
        '  --dsa-accent:#2a5cf6;--dsa-accent2:#1f4bd8;--dsa-soft:#edf1ff;',
        '  --dsa-danger:#b3382f;--dsa-danger-soft:#fdf1ef;',
        '  --dsa-r-lg:14px;--dsa-r-md:10px;--dsa-r-sm:6px;',
        '  --dsa-fs-s:12px;--dsa-fs-m:13px;--dsa-fs-l:15px;',
        '  --dsa-shadow-card:0 1px 2px rgba(16,24,40,.05);--dsa-shadow-pop:0 18px 50px rgba(12,16,24,.18);',
        '  --dsa-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;',
        '  --dsa-sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
        '}',
        '[data-dsa-theme="dark"]{',
        '  --dsa-bg:#0c0e13;--dsa-band:#101319;--dsa-panel:#141820;--dsa-card2:#1a1f28;',
        '  --dsa-ink:#e9edf3;--dsa-ink2:#a6aebb;--dsa-ink3:#7f8896;',
        '  --dsa-line:rgba(255,255,255,.10);--dsa-line2:rgba(255,255,255,.18);',
        '  --dsa-accent:#7fa2ff;--dsa-accent2:#9db8ff;--dsa-soft:rgba(90,130,255,.16);',
        '  --dsa-danger:#f08b83;--dsa-danger-soft:rgba(240,139,131,.12);',
        '  --dsa-shadow-card:0 1px 2px rgba(0,0,0,.35);--dsa-shadow-pop:0 18px 50px rgba(0,0,0,.5);',
        '}',
        '.dsa-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsa-bg);color:var(--dsa-ink);',
        '  font-family:var(--dsa-sans);font-size:var(--dsa-fs-m);line-height:1.55;-webkit-font-smoothing:antialiased;}',
        '.dsa-root *{box-sizing:border-box;}',
        '.dsa-root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsa-accent) 60%,transparent);outline-offset:2px;}',
        '.dsa-root button{font-family:inherit;}',
        '.dsa-top{height:52px;flex:0 0 52px;display:flex;align-items:center;gap:10px;padding:0 18px;background:var(--dsa-panel);border-bottom:.5px solid var(--dsa-line);}',
        '.dsa-brand{display:flex;align-items:center;gap:8px;min-width:0;}',
        '.dsa-brand b{font-size:var(--dsa-fs-l);font-weight:600;letter-spacing:.01em;white-space:nowrap;}',
        '.dsa-logo{display:inline-flex;color:var(--dsa-accent);}',
        '.dsa-spacer{flex:1 1 auto;min-width:4px;}',
        '.dsa-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 auto;}',
        '.dsa-icon svg{display:block;}',
        '.dsa-spin{animation:dsa-spin .8s linear infinite;transform-origin:50% 50%;}',
        '@keyframes dsa-spin{to{transform:rotate(360deg);}}',
        '.dsa-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-sm);',
        '  color:var(--dsa-ink2);font-size:var(--dsa-fs-s);background:transparent;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-chip.err{color:var(--dsa-danger);border-color:color-mix(in srgb,var(--dsa-danger) 35%,var(--dsa-line));}',
        '.dsa-chip.quiet{color:var(--dsa-ink3);border-style:dashed;}',
        '.dsa-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-dot{width:6px;height:6px;border-radius:50%;background:var(--dsa-accent);flex:0 0 6px;}',
        '.dsa-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border:.5px solid var(--dsa-line2);border-radius:var(--dsa-r-sm);',
        '  background:transparent;color:var(--dsa-ink);font-size:var(--dsa-fs-m);line-height:1;cursor:pointer;white-space:nowrap;',
        '  transition:background-color .12s ease,border-color .12s ease,color .12s ease;}',
        '.dsa-btn:hover{background:color-mix(in srgb,var(--dsa-ink) 4%,transparent);}',
        '.dsa-btn:disabled{opacity:.45;cursor:default;}',
        '.dsa-btn.primary{color:var(--dsa-accent2);border-color:color-mix(in srgb,var(--dsa-accent) 42%,var(--dsa-line2));}',
        '.dsa-btn.primary:hover{background:var(--dsa-soft);}',
        '.dsa-btn.danger{color:var(--dsa-danger);border-color:color-mix(in srgb,var(--dsa-danger) 38%,var(--dsa-line2));}',
        '.dsa-btn.danger:hover{background:var(--dsa-danger-soft);}',
        '.dsa-btn.ghost{border-color:transparent;color:var(--dsa-ink2);}',
        '.dsa-btn.ghost:hover{background:color-mix(in srgb,var(--dsa-ink) 4%,transparent);color:var(--dsa-ink);}',
        '.dsa-body{flex:1 1 auto;display:flex;min-height:0;}',
        '.dsa-rail{flex:0 0 272px;width:272px;background:var(--dsa-band);border-right:.5px solid var(--dsa-line);display:flex;flex-direction:column;min-height:0;}',
        '.dsa-rail-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 10px 16px;}',
        '.dsa-rail-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px 6px;color:var(--dsa-ink3);font-size:var(--dsa-fs-s);font-weight:600;letter-spacing:.03em;}',
        '.dsa-ws-list{display:flex;flex-direction:column;gap:2px;}',
        '.dsa-ws-row{position:relative;}',
        '.dsa-ws{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 48px 8px 10px;border:.5px solid transparent;border-radius:var(--dsa-r-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;',
        '  transition:background-color .12s ease,border-color .12s ease;}',
        '.dsa-ws:hover{background:color-mix(in srgb,var(--dsa-ink) 3.5%,transparent);}',
        '.dsa-ws-row.sel .dsa-ws{background:var(--dsa-panel);border-color:var(--dsa-line);box-shadow:var(--dsa-shadow-card);}',
        '.dsa-ws-line{display:flex;align-items:center;gap:7px;min-width:0;}',
        '.dsa-ws-name{flex:1 1 auto;min-width:0;font-size:var(--dsa-fs-m);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-ws-row.sel .dsa-ws-name{color:var(--dsa-ink);font-weight:600;}',
        '.dsa-ws-count{flex:0 0 auto;font-size:var(--dsa-fs-s);color:var(--dsa-ink3);font-variant-numeric:tabular-nums;}',
        '.dsa-ws-path{display:block;font-size:var(--dsa-fs-s);color:var(--dsa-ink3);font-family:var(--dsa-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-ws-remove{position:absolute;right:8px;top:9px;z-index:1;padding:2px 5px;border:0;border-radius:4px;background:var(--dsa-panel);color:var(--dsa-ink3);font:inherit;font-size:var(--dsa-fs-s);cursor:pointer;opacity:0;',
        '  transition:opacity .12s ease,color .12s ease;}',
        '.dsa-ws-row:hover .dsa-ws-remove,.dsa-ws-row:focus-within .dsa-ws-remove{opacity:1;}',
        '.dsa-ws-row.missing .dsa-ws-remove{opacity:1;}',
        '.dsa-ws-row.missing .dsa-ws-count{color:var(--dsa-danger);}',
        '.dsa-ws-remove:hover{color:var(--dsa-danger);}',
        '.dsa-prog{margin-top:16px;padding-top:10px;border-top:.5px solid var(--dsa-line);}',
        '.dsa-prog-empty{padding:4px 10px 8px;color:var(--dsa-ink3);font-size:var(--dsa-fs-s);}',
        '.dsa-prog-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 10px;border:.5px solid transparent;border-radius:var(--dsa-r-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;',
        '  transition:background-color .12s ease,border-color .12s ease;}',
        '.dsa-prog-item:hover{background:color-mix(in srgb,var(--dsa-ink) 3.5%,transparent);}',
        '.dsa-prog-item.sel{background:var(--dsa-panel);border-color:var(--dsa-line);box-shadow:var(--dsa-shadow-card);}',
        '.dsa-prog-name{font-size:var(--dsa-fs-m);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-prog-item.sel .dsa-prog-name{color:var(--dsa-accent2);font-weight:600;}',
        '.dsa-prog-meta{display:flex;align-items:center;gap:10px;font-size:var(--dsa-fs-s);color:var(--dsa-ink3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;}',
        '.dsa-main{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px;background:var(--dsa-bg);}',
        '.dsa-canvas{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:var(--dsa-panel);border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-lg);overflow:hidden;}',
        '.dsa-viewer-host{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}',
        '.dsa-viewer{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}',
        '.dsa-vbar{flex:0 0 auto;min-height:52px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 16px;border-bottom:.5px solid var(--dsa-line);}',
        '.dsa-tabs{display:inline-flex;align-items:center;gap:2px;padding:3px;border:.5px solid var(--dsa-line);border-radius:8px;background:var(--dsa-card2);}',
        '.dsa-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:0;border-radius:5px;background:transparent;color:var(--dsa-ink2);',
        '  font-size:var(--dsa-fs-m);font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease;}',
        '.dsa-tab:hover{color:var(--dsa-ink);}',
        '.dsa-tab.sel{background:var(--dsa-panel);color:var(--dsa-ink);box-shadow:0 1px 2px rgba(16,24,40,.06);}',
        '.dsa-tab-count{font-size:var(--dsa-fs-s);font-weight:400;color:var(--dsa-ink3);font-variant-numeric:tabular-nums;}',
        '.dsa-tab.sel .dsa-tab-count{color:var(--dsa-accent2);}',
        '.dsa-filter{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:.5px dashed var(--dsa-line2);border-radius:var(--dsa-r-sm);font-size:var(--dsa-fs-s);color:var(--dsa-ink2);background:transparent;}',
        '.dsa-meta{display:inline-flex;align-items:center;gap:12px;font-size:var(--dsa-fs-s);color:var(--dsa-ink3);font-variant-numeric:tabular-nums;white-space:nowrap;}',
        '.dsa-search{display:inline-flex;align-items:center;gap:6px;height:26px;min-width:0;padding:0 8px;border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-sm);background:var(--dsa-panel);color:var(--dsa-ink3);}',
        '.dsa-search:focus-within{border-color:color-mix(in srgb,var(--dsa-accent) 50%,var(--dsa-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsa-accent) 10%,transparent);}',
        '.dsa-search-input{width:150px;min-width:0;border:0;background:transparent;color:var(--dsa-ink);font:inherit;font-size:var(--dsa-fs-s);outline:none;}',
        '.dsa-search-input::placeholder{color:var(--dsa-ink3);}',
        '.dsa-search-clear{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsa-ink3);cursor:pointer;}',
        '.dsa-search-clear:hover{background:color-mix(in srgb,var(--dsa-ink) 6%,transparent);color:var(--dsa-ink);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-search-input{width:110px;}',
        '.dsa-viewer-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:16px;}',
        '.dsa-viewer-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:224px minmax(0,1fr);gap:16px;padding:16px;}',
        '.dsa-viewer-split>.dsa-viewer-body{padding:0;}',
        '.dsa-tree-pane{min-height:0;overflow:auto;padding:8px;border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-md);background:var(--dsa-card2);}',
        '.dsa-tree-wrap{font-size:var(--dsa-fs-s);}',
        '.dsa-tree{list-style:none;margin:0;padding-left:12px;}',
        '.dsa-tree-root{margin-bottom:2px;}',
        '.dsa-tree summary{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:4px;color:var(--dsa-ink2);cursor:pointer;font-size:var(--dsa-fs-s);white-space:nowrap;}',
        '.dsa-tree summary:hover{background:color-mix(in srgb,var(--dsa-ink) 4%,transparent);color:var(--dsa-ink);}',
        '.dsa-tree-item{display:block;width:100%;padding:2px 6px;border:.5px solid transparent;border-radius:4px;background:transparent;color:var(--dsa-ink2);font:inherit;font-size:var(--dsa-fs-s);text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsa-tree-item:hover{background:color-mix(in srgb,var(--dsa-ink) 4%,transparent);color:var(--dsa-ink);}',
        '.dsa-tree-item.sel{background:var(--dsa-soft);border-color:color-mix(in srgb,var(--dsa-accent) 22%,transparent);color:var(--dsa-accent2);}',
        '.dsa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:12px;align-content:start;}',
        '.dsa-card{display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px;border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-md);background:var(--dsa-panel);color:inherit;font:inherit;text-align:left;cursor:pointer;',
        '  transition:border-color .12s ease,box-shadow .12s ease;}',
        '.dsa-card:hover{border-color:var(--dsa-line2);box-shadow:var(--dsa-shadow-card);}',
        '.dsa-card.sel{border-color:color-mix(in srgb,var(--dsa-accent) 50%,var(--dsa-line));}',
        '.dsa-card-thumb{display:block;width:100%;height:112px;object-fit:contain;border-radius:calc(var(--dsa-r-md) - 6px);background:var(--dsa-card2);}',
        '.dsa-card-ext{display:flex;align-items:center;justify-content:center;height:112px;border-radius:calc(var(--dsa-r-md) - 6px);background:var(--dsa-card2);color:var(--dsa-ink3);font-family:var(--dsa-mono);font-size:var(--dsa-fs-s);letter-spacing:.04em;}',
        '.dsa-card-name{font-size:var(--dsa-fs-m);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-card-meta{font-size:var(--dsa-fs-s);color:var(--dsa-ink3);font-variant-numeric:tabular-nums;}',
        '.dsa-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:1 1 auto;min-height:220px;padding:32px 20px;text-align:center;color:var(--dsa-ink2);}',
        '.dsa-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;color:var(--dsa-ink3);opacity:.9;}',
        '.dsa-empty b{font-size:var(--dsa-fs-l);font-weight:600;color:var(--dsa-ink);}',
        '.dsa-empty p{max-width:380px;margin:0;font-size:var(--dsa-fs-m);line-height:1.6;color:var(--dsa-ink2);}',
        '.dsa-welcome{height:100%;}',
        '.dsa-hint{font-size:var(--dsa-fs-s);line-height:1.6;color:var(--dsa-ink3);}',
        '.dsa-error{font-size:var(--dsa-fs-s);line-height:1.5;color:var(--dsa-danger);background:var(--dsa-danger-soft);border:.5px solid color-mix(in srgb,var(--dsa-danger) 28%,transparent);border-radius:var(--dsa-r-sm);padding:8px 10px;margin:0 0 12px;}',
        '.dsa-canvas>.dsa-error{margin:12px 16px 0;}',
        '.dsa-mask{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(12,16,24,.32);}',
        '.dsa-modal{width:min(540px,100%);max-height:88%;overflow:auto;padding:22px;border:.5px solid var(--dsa-line2);border-radius:var(--dsa-r-lg);background:var(--dsa-panel);box-shadow:var(--dsa-shadow-pop);}',
        '.dsa-modal h2{margin:0 0 6px;font-size:var(--dsa-fs-l);font-weight:600;letter-spacing:.01em;}',
        '.dsa-modal:focus{outline:none;}',
        '.dsa-modal p{margin:0 0 16px;font-size:var(--dsa-fs-m);line-height:1.6;color:var(--dsa-ink2);}',
        '.dsa-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:20px;}',
        '.dsa-form{display:flex;flex-direction:column;gap:14px;}',
        '.dsa-field{display:flex;flex-direction:column;gap:6px;}',
        '.dsa-field label,.dsa-field>span{font-size:var(--dsa-fs-s);color:var(--dsa-ink2);}',
        '.dsa-input{width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsa-line2);border-radius:var(--dsa-r-sm);background:var(--dsa-panel);color:var(--dsa-ink);font:inherit;font-size:var(--dsa-fs-m);}',
        '.dsa-input:focus{outline:none;border-color:color-mix(in srgb,var(--dsa-accent) 60%,var(--dsa-line2));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsa-accent) 12%,transparent);}',
        '.dsa-input-row{display:flex;align-items:center;gap:8px;}',
        '.dsa-kv{display:flex;flex-direction:column;gap:6px;font-size:var(--dsa-fs-m);word-break:break-all;}',
        '.dsa-mono{font-family:var(--dsa-mono);font-size:var(--dsa-fs-s);color:var(--dsa-ink3);}',
        '.dsa-link{border:0;background:transparent;color:var(--dsa-ink2);font:inherit;font-size:var(--dsa-fs-s);cursor:pointer;padding:2px 0;text-decoration:none;}',
        '.dsa-link:hover{color:var(--dsa-accent2);}',
        '.dsa-lightbox{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,10,14,.78);}',
        '.dsa-lightbox-card{position:relative;display:flex;flex-direction:column;width:min(1000px,96vw);max-height:92vh;overflow:hidden;border:.5px solid var(--dsa-line2);border-radius:var(--dsa-r-lg);background:var(--dsa-panel);box-shadow:var(--dsa-shadow-pop);}',
        '.dsa-lightbox-card.wide{width:min(1180px,96vw);}',
        '.dsa-lightbox-card:focus{outline:none;}',
        '.dsa-lightbox-bar{flex:0 0 auto;min-height:48px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 12px 8px 16px;border-bottom:.5px solid var(--dsa-line);background:var(--dsa-panel);}',
        '.dsa-lightbox-name{min-width:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsa-mono);font-size:var(--dsa-fs-s);font-weight:500;color:var(--dsa-ink);}',
        '.dsa-lightbox-stage{display:flex;align-items:center;justify-content:center;min-height:340px;padding:24px;overflow:auto;background:#0e1117;}',
        '.dsa-lightbox-img{display:block;max-width:100%;max-height:74vh;object-fit:contain;}',
        '.dsa-lightbox-pdf{width:100%;height:76vh;border:0;background:#0e1117;}',
        '.dsa-lightbox-navs{position:absolute;left:14px;right:14px;bottom:14px;display:flex;justify-content:space-between;pointer-events:none;}',
        '.dsa-lightbox-nav{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:.5px solid rgba(255,255,255,.24);border-radius:var(--dsa-r-sm);background:rgba(14,17,23,.62);color:#fff;font-size:var(--dsa-fs-l);line-height:1;cursor:pointer;backdrop-filter:blur(6px);}',
        '.dsa-lightbox-nav:hover{background:rgba(14,17,23,.86);}',
        '.dsa-tablewrap{max-height:72vh;overflow:auto;padding:12px 16px 16px;}',
        // 默认滚动条在宽表格里几乎是覆盖式的细线：显式加宽成常驻轨道（勿混用 scrollbar-width，Chromium 会忽略 webkit 伪元素）
        '.dsa-tablewrap::-webkit-scrollbar{width:12px;height:12px;}',
        '.dsa-tablewrap::-webkit-scrollbar-track{background:color-mix(in srgb,var(--dsa-ink) 7%,transparent);}',
        '.dsa-tablewrap::-webkit-scrollbar-thumb{background:var(--dsa-ink3);border:3px solid transparent;border-radius:6px;background-clip:padding-box;}',
        '.dsa-tablewrap::-webkit-scrollbar-thumb:hover{background:var(--dsa-ink2);}',
        '.dsa-tablewrap::-webkit-scrollbar-corner{background:transparent;}',
        '.dsa-tablewrap-lg{max-height:76vh;}',
        '.dsa-table{width:100%;border-collapse:collapse;font-size:var(--dsa-fs-s);}',
        '.dsa-table th{position:sticky;top:0;z-index:1;padding:7px 8px;border-bottom:.5px solid var(--dsa-line2);background:var(--dsa-panel);color:var(--dsa-ink2);font-weight:600;text-align:left;white-space:nowrap;}',
        '.dsa-table td{max-width:420px;padding:6px 8px;border-bottom:.5px solid var(--dsa-line);vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsa-pre{margin:0;padding:16px;border:.5px solid var(--dsa-line);border-radius:var(--dsa-r-md);background:var(--dsa-card2);font-family:var(--dsa-mono);font-size:var(--dsa-fs-s);line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow:auto;}',
        '.dsa-pre-lg{max-height:76vh;border:0;border-radius:0;background:var(--dsa-card2);}',
        '.dsa-rail-toggle{display:none;}',
        '.dsa-rail-backdrop{position:absolute;left:0;right:0;top:52px;bottom:0;z-index:25;background:rgba(12,16,24,.24);}',
        '.dsa-root[data-dsa-width="compact"] .dsa-rail{flex-basis:248px;width:248px;}',
        '.dsa-root[data-dsa-width="compact"] .dsa-viewer-split{grid-template-columns:196px minmax(0,1fr);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-rail{position:absolute;left:0;top:52px;bottom:0;z-index:30;width:280px;flex-basis:280px;box-shadow:var(--dsa-shadow-pop);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-rail-toggle{display:inline-flex;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-brand b{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-btn .dsa-btn-label{display:none;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-main{padding:10px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-vbar{padding:8px 10px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-viewer-body{padding:12px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-viewer-split{padding:12px;grid-template-columns:minmax(0,1fr);}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-tree-pane{max-height:170px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-chip{max-width:150px;}',
        '.dsa-root[data-dsa-width="narrow"] .dsa-ws-remove{opacity:1;}',
        '.dsa-cmp{display:inline-flex;align-items:center;min-width:0;max-width:min(280px,52vw);flex:0 1 auto;overflow:hidden;}',
        '.dsa-chat-btn{display:inline-flex;align-items:center;gap:6px;height:24px;min-width:0;max-width:100%;padding:0 8px;',
        '  border:.5px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;background:transparent;color:inherit;',
        '  font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;}',
        '.dsa-chat-btn:hover{background:color-mix(in srgb,currentColor 7%,transparent);border-color:color-mix(in srgb,currentColor 32%,transparent);}',
        '.dsa-chat-glyph{display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;}',
      ];

      function installStyles() {
        if (typeof document === 'undefined' || !document.head) return function () {};
        var tag = document.createElement('style');
        tag.setAttribute('data-dsa-style', 'data-analysis');
        tag.textContent = CSS.join('');
        document.head.appendChild(tag);
        return function () {
          try {
            tag.remove();
          } catch (error) {
            /* ignore */
          }
        };
      }

      /* ------------------------------------------------------------------ *
       * 装配
       * ------------------------------------------------------------------ */
      function apply(ctx) {
        runtime.ctx = ctx;
        ctx.effect(installStyles, 'data-analysis: styles');
        ctx.effect(function () {
          var offs = [];
          offs.push(ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: 'data-analysis' }, Panel);
          }));
          offs.push(ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: 'data-analysis',
              order: 6,
              label: function () { return t('title'); },
            }, WorkbenchIcon);
          }));
          offs.push(ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'data-analysis-viewer',
              order: 90,
              inject: function (sessionId) {
                return { sessionId: sessionId };
              },
            }, OpenWorkbenchAction);
          }));
          return function () {
            offs.forEach(function (off) {
              if (typeof off === 'function') off();
            });
          };
        }, 'data-analysis: slots');
      }

      return {
        inject: ['slots'],
        apply: apply,
      };
    },
  });
})();