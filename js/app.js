/* =============================================================
 * js/app.js — 页面逻辑
 *   当天记录：日期切换 + 大号数值录入 + 保存 / 修改
 *   历史记录：日期范围筛选 + 三张折线图 + 明细表格
 * ============================================================= */
(function () {
  'use strict';

  /* ---------------- 字段定义 ---------------- */

  const VISION_QUICK = [0.4, 0.6, 0.8, 1.0, 1.2, 1.5];
  const DIST_QUICK = [2.5, 5, 9];

  const VISION_OPT = { min: 0.2, max: 1.5, step: 0.1, decimals: 1, startFrom: 1.0, quick: VISION_QUICK };
  const DIST_OPT = { min: 1, max: 20, step: 1, decimals: 2, unit: '米', quick: DIST_QUICK };

  const VISION_GROUPS = [
    {
      container: 'preFields',
      fields: [
        { key: 'pre_left', label: '左眼' },
        { key: 'pre_right', label: '右眼' },
        { key: 'pre_both', label: '双眼' }
      ]
    },
    {
      container: 'trainFields',
      fields: [
        { key: 'train_left', label: '左眼' },
        { key: 'train_right', label: '右眼' },
        { key: 'train_both', label: '双眼' }
      ]
    }
  ];

  const DIST_GROUPS = [
    {
      container: 'distFields',
      fields: [
        { key: 'test_distance', label: '测视距离', hint: '测训前视力时站多远',
          opt: { startFrom: 5, defaultValue: 5 } },
        { key: 'train_distance', label: '强化训练距离', hint: '做训练时站多远',
          opt: { startFrom: 9, defaultValue: 9 } }
      ]
    }
  ];

  const CHART_DEFS = [
    { canvas: 'chartLeft', pre: 'pre_left', post: 'train_left', hue: '#4f7cff' },
    { canvas: 'chartRight', pre: 'pre_right', post: 'train_right', hue: '#10b3a3' },
    { canvas: 'chartBoth', pre: 'pre_both', post: 'train_both', hue: '#8b5cf6' }
  ];

  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /* ---------------- DOM ---------------- */

  const $ = (id) => document.getElementById(id);

  const el = {
    tabs: $('tabs'),
    viewToday: $('view-today'),
    viewHistory: $('view-history'),
    dbDot: $('dbDot'),
    dbStateTitle: $('dbStateTitle'),
    dbStateDesc: $('dbStateDesc'),
    btnReselect: $('btnReselect'),
    warnBar: $('warnBar'),
    overlay: $('overlay'),
    overlayTitle: $('overlayTitle'),
    overlayTip: $('overlayTip'),
    fallbackBox: $('fallbackBox'),
    overlaySteps: $('overlaySteps'),
    btnInit: $('btnInit'),
    btnReconnect: $('btnReconnect'),
    btnImportFile: $('btnImportFile'),
    btnNewEmpty: $('btnNewEmpty'),
    fileImport: $('fileImport'),
    recordDate: $('recordDate'),
    dateHint: $('dateHint'),
    btnPrevDay: $('btnPrevDay'),
    btnNextDay: $('btnNextDay'),
    btnToday: $('btnToday'),
    form: $('recordForm'),
    remark: $('remark'),
    actionInfo: $('actionInfo'),
    btnEdit: $('btnEdit'),
    btnCancel: $('btnCancel'),
    btnSave: $('btnSave'),
    fromDate: $('fromDate'),
    toDate: $('toDate'),
    quickRange: $('quickRange'),
    tableBody: $('tableBody'),
    tableCount: $('tableCount'),
    toast: $('toast')
  };

  const fields = {};        // key -> { wrap, input, quickBtns }
  const charts = {};        // canvasId -> Chart 实例

  const state = {
    ready: false,
    editing: true,
    hasRecord: false
  };

  /* ---------------- 小工具 ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function shiftDate(str, days) {
    const p = str.split('-');
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function daysAgo(n) { return shiftDate(todayStr(), -n); }

  function weekdayOf(str) {
    const p = str.split('-');
    return WEEK[new Date(+p[0], +p[1] - 1, +p[2]).getDay()];
  }

  /** SQLite 的 CURRENT_TIMESTAMP 是 UTC，这里转成北京时间显示 */
  function formatLocalTime(sqlUtc) {
    if (!sqlUtc) return '';
    const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function round(v, exp) {
    const m = Math.pow(10, exp);
    return Math.round(v * m) / m;
  }

  function fmt(v, decimals) { return v === null || v === undefined ? '' : v.toFixed(decimals); }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  let toastTimer = null;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (isError ? ' is-error' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 3600 : 2200);
  }

  /* ---------------- 数值输入控件 ---------------- */

  function buildField(host, def, baseOpt) {
    const opt = Object.assign({}, baseOpt, def.opt);
    const wrap = document.createElement('div');
    wrap.className = 'num-field';

    const label = document.createElement('label');
    label.textContent = def.label;
    if (def.hint) {
      const span = document.createElement('span');
      span.textContent = ' ' + def.hint;
      label.appendChild(span);
    }
    wrap.appendChild(label);

    const box = document.createElement('div');
    box.className = 'num-input';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(opt.step);
    input.min = String(opt.min);
    input.max = String(opt.max);
    input.placeholder = '—';
    box.appendChild(input);

    if (opt.unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = opt.unit;
      box.appendChild(unit);
    }

    const spin = document.createElement('div');
    spin.className = 'spin';
    [[1, 'M6 15l6-6 6 6', '调大'], [-1, 'M6 9l6 6 6-6', '调小']].forEach(([dir, path, tip]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = tip;
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
      b.addEventListener('click', () => step(def.key, dir));
      spin.appendChild(b);
    });
    box.appendChild(spin);
    wrap.appendChild(box);

    const quick = document.createElement('div');
    quick.className = 'quick';
    const quickBtns = opt.quick.map((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = fmt(v, opt.decimals);
      b.addEventListener('click', () => setValue(def.key, v));
      quick.appendChild(b);
      return { btn: b, value: v };
    });
    wrap.appendChild(quick);

    input.addEventListener('input', () => syncQuick(def.key));
    input.addEventListener('change', () => {
      const v = readValue(def.key);
      input.value = v === null ? '' : fmt(v, opt.decimals);
      syncQuick(def.key);
    });

    host.appendChild(wrap);
    fields[def.key] = { wrap, input, box, quick, quickBtns, opt, def };
  }

  function cmToM(cm) { return cm === null || cm === undefined ? null : cm / 100; }

  function readValue(key) {
    const raw = fields[key].input.value.trim();
    if (raw === '') return null;
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }

  function setValue(key, v) {
    const f = fields[key];
    const opt = f.opt;
    const val = v === null || v === undefined
      ? null
      : Math.min(opt.max, Math.max(opt.min, round(v, 3)));
    f.input.value = val === null ? '' : fmt(val, opt.decimals);
    syncQuick(key);
  }

  /** 点一下 ▲▼ 走一个步长；空值时直接跳到 startFrom */
  function step(key, dir) {
    const opt = fields[key].opt;
    const cur = readValue(key);
    const next = cur === null
      ? opt.startFrom
      : Math.min(opt.max, Math.max(opt.min, round(cur + dir * opt.step, 3)));
    setValue(key, next);
    fields[key].input.focus();
  }

  function syncQuick(key) {
    const f = fields[key];
    const v = readValue(key);
    f.quickBtns.forEach((q) => {
      q.btn.classList.toggle('is-on', v !== null && Math.abs(v - q.value) < 1e-6);
    });
  }

  function buildAllFields() {
    VISION_GROUPS.forEach((g) => {
      const host = $(g.container);
      g.fields.forEach((f) => buildField(host, f, VISION_OPT));
    });
    DIST_GROUPS.forEach((g) => {
      const host = $(g.container);
      host.classList.add('is-2');
      g.fields.forEach((f) => buildField(host, f, DIST_OPT));
    });
  }

  /* ---------------- 当天记录 ---------------- */

  function setLocked(locked) {
    Object.keys(fields).forEach((k) => {
      fields[k].input.readOnly = locked;
      fields[k].wrap.classList.toggle('is-locked', locked);
      fields[k].box.classList.toggle('is-locked', locked);
    });
    el.remark.readOnly = locked;
    el.btnEdit.hidden = !locked;
    el.btnCancel.hidden = !(state.hasRecord && !locked);
    el.btnSave.hidden = locked;
    el.btnSave.textContent = state.hasRecord ? '保存修改' : '保存记录';
  }

  function renderDateHint() {
    const d = el.recordDate.value;
    if (!d) { el.dateHint.textContent = ''; return; }
    const isToday = d === todayStr();
    el.dateHint.innerHTML = esc(d) + ' ' + esc(weekdayOf(d)) +
      (isToday ? ' · <b>今天</b>' : '');
  }

  function loadDate() {
    if (!state.ready) return;
    const d = el.recordDate.value;
    renderDateHint();

    const rec = window.EyeDB.getByDate(d);
    state.hasRecord = !!rec;
    state.editing = !rec;

    if (rec) {
      setValue('pre_left', rec.pre_left);
      setValue('pre_right', rec.pre_right);
      setValue('pre_both', rec.pre_both);
      setValue('train_left', rec.train_left);
      setValue('train_right', rec.train_right);
      setValue('train_both', rec.train_both);
      setValue('test_distance', cmToM(rec.test_distance));
      setValue('train_distance', cmToM(rec.train_distance));
      el.remark.value = rec.remark || '';
    } else {
      // 新建：视力留空，距离带出默认值（测视 5 米、强化训练 9 米）
      Object.keys(fields).forEach((k) => setValue(k, fields[k].opt.defaultValue));
      el.remark.value = '';
    }

    setLocked(state.hasRecord);
    renderActionInfo(rec);
  }

  function renderActionInfo(rec) {
    if (state.hasRecord) {
      const t = formatLocalTime(rec && rec.gmt_modified);
      el.actionInfo.innerHTML = state.editing
        ? '修改后记得点「保存修改」'
        : '这天的记录已保存' + (t ? '，最后更新于 <b>' + esc(t) + '</b>' : '');
    } else {
      el.actionInfo.innerHTML = '这天还没有记录，填好后点「保存记录」';
    }
  }

  function collectForm() {
    const v = (k) => readValue(k);
    return {
      record_date: el.recordDate.value,
      pre_left: v('pre_left'),
      pre_right: v('pre_right'),
      pre_both: v('pre_both'),
      train_left: v('train_left'),
      train_right: v('train_right'),
      train_both: v('train_both'),
      test_distance: window.EyeDB.m2cm(v('test_distance')),
      train_distance: window.EyeDB.m2cm(v('train_distance')),
      remark: el.remark.value.trim() || null
    };
  }

  function saveRecord() {
    if (!el.recordDate.value) { toast('请先选择日期', true); return; }
    const rec = collectForm();
    const hasVision = ['pre_left', 'pre_right', 'pre_both', 'train_left', 'train_right', 'train_both']
      .some((k) => rec[k] !== null && rec[k] !== undefined);
    if (!hasVision) { toast('请至少填一项视力数据', true); return; }

    el.btnSave.disabled = true;
    window.EyeDB.save(rec).then((written) => {
      el.btnSave.disabled = false;
      if (written) {
        toast('已保存到 eyerecord');
        renderWarnBar();
      } else {
        window.EyeDB.exportBlob();
        toast('已保存，并已下载 eyerecord 文件（请覆盖回原目录）', true);
        renderWarnBar();
      }
      loadDate();
      if (!el.viewHistory.hidden) refreshHistory();
    }).catch((e) => {
      el.btnSave.disabled = false;
      toast('保存失败：' + (e && e.message ? e.message : e), true);
    });
  }

  /* ---------------- 历史记录 ---------------- */

  function setRange(from, to, activeBtn) {
    el.fromDate.value = from;
    el.toDate.value = to;
    Array.prototype.forEach.call(el.quickRange.children, (b) => {
      b.classList.toggle('is-active', b === activeBtn);
    });
    refreshHistory();
  }

  function refreshHistory() {
    if (!state.ready) return;
    const from = el.fromDate.value;
    const to = el.toDate.value;
    if (!from || !to || from > to) return;

    const rows = window.EyeDB.listRange(from, to);
    renderCharts(rows);
    renderTable(rows);
  }

  function renderCharts(rows) {
    const asc = rows.slice().reverse();
    const labels = asc.map((r) => r.record_date.slice(5));

    CHART_DEFS.forEach((def) => {
      const box = $(def.canvas);
      if (!charts[def.canvas]) charts[def.canvas] = createChart(box, def);
      const chart = charts[def.canvas];
      chart.data.labels = labels;
      chart.data.datasets[0].data = asc.map((r) => r[def.pre]);
      chart.data.datasets[1].data = asc.map((r) => r[def.post]);
      chart.update();
      const empty = box.parentNode.querySelector('.empty-tip');
      if (empty) empty.hidden = labels.length > 0;
      box.hidden = labels.length === 0;
      if (!box.hidden) chart.resize();
    });
  }

  function createChart(canvas, def) {
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.innerHTML = '<b>这个时间段没有记录</b>换一个日期范围，或先去「当天记录」补一条';
    canvas.parentNode.appendChild(tip);

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: '训练前',
            data: [],
            borderColor: '#9aa6bd',
            backgroundColor: 'transparent',
            pointBackgroundColor: '#9aa6bd',
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.32,
            spanGaps: true
          },
          {
            label: '强化后',
            data: [],
            borderColor: def.hue,
            backgroundColor: hexToRgba(def.hue, 0.12),
            pointBackgroundColor: def.hue,
            borderWidth: 2.5,
            pointRadius: 3.5,
            fill: true,
            tension: 0.32,
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 26, boxHeight: 3, padding: 18, font: { size: 13 }, usePointStyle: false }
          },
          tooltip: {
            backgroundColor: 'rgba(28,35,51,.92)',
            padding: 12,
            titleFont: { size: 13 },
            bodyFont: { size: 13 },
            callbacks: {
              label: (ctx) => ctx.dataset.label + '：' +
                (ctx.parsed.y === null ? '未记录' : ctx.parsed.y.toFixed(1))
            }
          }
        },
        scales: {
          y: {
            suggestedMin: 0.2,
            suggestedMax: 1.5,
            ticks: { font: { size: 12 }, color: '#93a0b5' },
            grid: { color: '#eef1f8' }
          },
          x: {
            ticks: { font: { size: 12 }, color: '#93a0b5', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
            grid: { display: false }
          }
        }
      }
    });
  }

  function renderTable(rows) {
    el.tableCount.textContent = rows.length
      ? '共 ' + rows.length + ' 条，按日期倒序'
      : '';

    if (!rows.length) {
      el.tableBody.innerHTML =
        '<tr><td colspan="10"><div class="empty-tip"><b>没有记录</b>换个日期范围试试</div></td></tr>';
      return;
    }

    el.tableBody.innerHTML = rows.map((r) => {
      const cell = (v, decimals) => v === null || v === undefined
        ? '<td class="num empty">—</td>'
        : '<td class="num">' + Number(v).toFixed(decimals) + '</td>';
      const dist = (cm) => cm === null || cm === undefined
        ? '<td class="num empty">—</td>'
        : '<td class="num">' + window.EyeDB.cm2m(cm) + '</td>';
      const remark = r.remark
        ? '<td class="remark-cell" title="' + esc(r.remark) + '">' + esc(r.remark) + '</td>'
        : '<td class="remark-cell empty">—</td>';
      return '<tr>' +
        '<td class="date">' + esc(r.record_date) + '</td>' +
        cell(r.pre_left, 1) + cell(r.pre_right, 1) + cell(r.pre_both, 1) +
        cell(r.train_left, 1) + cell(r.train_right, 1) + cell(r.train_both, 1) +
        dist(r.test_distance) + dist(r.train_distance) +
        remark +
        '</tr>';
    }).join('');
  }

  /* ---------------- 数据库状态 / 遮罩 ---------------- */

  function renderDbState() {
    if (!state.ready) {
      el.dbDot.className = 'db-dot';
      el.dbStateTitle.textContent = '未连接';
      el.dbStateDesc.textContent = '数据库未初始化';
      el.btnReselect.hidden = true;
      return;
    }
    const auto = window.EyeDB.isAutoSave();
    el.dbDot.className = 'db-dot ' + (auto ? 'is-ok' : 'is-warn');
    el.dbStateTitle.textContent = auto ? '已连接' : '内存模式';
    if (auto) {
      const dir = window.EyeDB.dirName();
      el.dbStateDesc.textContent = window.EyeDB.dbFileLabel() + ' · 自动保存' +
        (dir ? '（' + dir + '）' : '') +
        (window.EyeDB.isHandleRemembered() ? '' : ' · 未记住目录');
    } else {
      el.dbStateDesc.textContent = '需手动导出文件';
    }
    el.btnReselect.hidden = !auto;
  }

  function renderWarnBar() {
    if (!state.ready) { el.warnBar.hidden = true; return; }
    if (window.EyeDB.isAutoSave()) {
      el.warnBar.hidden = !window.EyeDB.hasPendingExport();
      if (!el.warnBar.hidden) {
        el.warnBar.innerHTML = '<b>注意：</b>刚才的修改没能写回文件，请点下面的按钮重新导出。';
      }
      return;
    }
    el.warnBar.hidden = false;
    el.warnBar.innerHTML =
      '<b>当前浏览器不能自动写回本地文件（只有 Chrome / Edge 可以）。</b>' +
      '数据暂时只存在浏览器内存里，每次保存后会自动下载一份 eyerecord 文件，' +
      '请把它移动并覆盖到 index.html 所在的目录；下次打开页面时用「打开已有文件」导入。';
  }

  function showOverlay(res) {
    const canPickDir = !!(res && res.canPickDir);
    const needPermission = !!res && (res.status === 'need-permission' || res.reason === 'permission');
    el.overlay.hidden = false;
    el.overlayTitle.textContent = needPermission ? '点一下「继续」就连上数据目录' : '数据库还没初始化';
    el.overlaySteps.hidden = needPermission;
    el.btnReconnect.hidden = !needPermission;
    el.btnInit.hidden = needPermission || !canPickDir;
    el.fallbackBox.hidden = canPickDir;
    el.overlayTip.textContent = canPickDir
      ? '建议使用 Chrome 或 Edge 浏览器（只有它们能把数据写回本地文件）'
      : '当前浏览器不支持自动保存，请改用 Chrome 或 Edge 打开本页';
    if (res && res.error) toast(res.error, true);
  }

  function hideOverlay() { el.overlay.hidden = true; }

  function onReady(res) {
    state.ready = true;
    hideOverlay();
    renderDbState();
    renderWarnBar();
    el.recordDate.value = todayStr();
    loadDate();
    initHistoryDefaults();
    // 首次建表的落盘是后台跑的，跑完再刷一次提示条
    if (res && res.writing) res.writing.then(() => { renderDbState(); renderWarnBar(); });
  }

  function initHistoryDefaults() {
    setRange(daysAgo(29), todayStr(), el.quickRange.querySelector('[data-days="30"]'));
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      Array.prototype.forEach.call(el.tabs.children, (b) => b.classList.toggle('is-active', b === btn));
      const toHistory = btn.dataset.view === 'history';
      el.viewHistory.hidden = !toHistory;
      el.viewToday.hidden = toHistory;
      if (toHistory) refreshHistory();
    });

    el.btnInit.addEventListener('click', () => {
      window.EyeDB.initWithPicker().then((res) => {
        onReady(res);
        toast(res && res.created ? '数据库已建好，可以开始记录了' : '已连接到 eyerecord');
      }).catch((err) => {
        if (err && err.name === 'AbortError') { toast('没有选择文件夹，已取消', true); return; }
        toast('初始化失败：' + (err && err.message ? err.message : err), true);
      });
    });

    el.btnReconnect.addEventListener('click', () => {
      window.EyeDB.reconnect().then((res) => {
        onReady(res);
        toast('已连接到 eyerecord');
      }).catch((err) => {
        toast('连接失败：' + (err && err.message ? err.message : err), true);
      });
    });

    el.btnImportFile.addEventListener('click', () => el.fileImport.click());
    el.fileImport.addEventListener('change', () => {
      const file = el.fileImport.files[0];
      if (!file) return;
      window.EyeDB.loadFromFile(file).then(() => {
        onReady();
        toast('已载入 ' + file.name);
      }).catch((err) => {
        toast('读取失败：' + (err && err.message ? err.message : err), true);
      });
      el.fileImport.value = '';
    });

    el.btnNewEmpty.addEventListener('click', () => {
      window.EyeDB.loadEmpty()
        .then(() => { onReady(); toast('已开始，记得导出保存'); })
        .catch((err) => toast('启动失败：' + (err && err.message ? err.message : err), true));
    });

    el.btnReselect.addEventListener('click', () => {
      window.EyeDB.forgetDir().then(() => {
        state.ready = false;
        renderDbState();
        el.warnBar.hidden = true;
        showOverlay({ canPickDir: true, reason: 'no-handle' });
      });
    });

    el.recordDate.addEventListener('change', loadDate);
    el.btnPrevDay.addEventListener('click', () => {
      el.recordDate.value = shiftDate(el.recordDate.value, -1);
      loadDate();
    });
    el.btnNextDay.addEventListener('click', () => {
      el.recordDate.value = shiftDate(el.recordDate.value, 1);
      loadDate();
    });
    el.btnToday.addEventListener('click', () => {
      el.recordDate.value = todayStr();
      loadDate();
    });

    el.btnEdit.addEventListener('click', () => {
      state.editing = true;
      setLocked(false);
      renderActionInfo(window.EyeDB.getByDate(el.recordDate.value));
      fields.pre_left.input.focus();
    });

    el.btnCancel.addEventListener('click', () => {
      state.editing = false;
      loadDate();
    });

    el.form.addEventListener('submit', (e) => { e.preventDefault(); saveRecord(); });
    el.btnSave.addEventListener('click', saveRecord);

    el.fromDate.addEventListener('change', () => {
      Array.prototype.forEach.call(el.quickRange.children, (b) => b.classList.remove('is-active'));
      refreshHistory();
    });
    el.toDate.addEventListener('change', () => {
      Array.prototype.forEach.call(el.quickRange.children, (b) => b.classList.remove('is-active'));
      refreshHistory();
    });
    el.quickRange.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const days = btn.dataset.days;
      if (days === 'all') {
        const all = window.EyeDB.listRange('0000-01-01', '9999-12-31');
        const from = all.length ? all[all.length - 1].record_date : daysAgo(29);
        setRange(from, todayStr(), btn);
      } else {
        setRange(daysAgo(+days - 1), todayStr(), btn);
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    buildAllFields();
    bindEvents();
    el.recordDate.value = todayStr();
    renderDateHint();
    setLocked(false);

    window.EyeDB.boot().then((res) => {
      if (res.status === 'ready') {
        onReady();
      } else {
        showOverlay(res);
        renderDbState();
      }
    }).catch((err) => {
      showOverlay({
        canPickDir: typeof window.showDirectoryPicker === 'function',
        reason: 'error',
        error: err && err.message
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
