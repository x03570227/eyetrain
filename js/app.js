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

  /* 视标最高档是 2.0，上限必须放开，否则训练记下的 2.0 会被夹成 1.5 */
  const VISION_OPT = { min: 0.1, max: 2.0, step: 0.1, decimals: 1, visionFmt: true, startFrom: 1.0, quick: VISION_QUICK };
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
    },
    {
      container: 'secondFields',
      fields: [
        { key: 'second_left', label: '左眼' },
        { key: 'second_right', label: '右眼' },
        { key: 'second_both', label: '双眼' }
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
    {
      canvas: 'chartPre',
      datasets: [
        { label: '左眼', field: 'pre_left', hue: '#4f7cff' },
        { label: '右眼', field: 'pre_right', hue: '#10b3a3' },
        { label: '双眼', field: 'pre_both', hue: '#8b5cf6' }
      ]
    },
    {
      canvas: 'chartPost',
      datasets: [
        { label: '左眼', field: 'train_left', hue: '#4f7cff' },
        { label: '右眼', field: 'train_right', hue: '#10b3a3' },
        { label: '双眼', field: 'train_both', hue: '#8b5cf6' }
      ]
    },
    {
      canvas: 'chartSecond',
      datasets: [
        { label: '左眼', field: 'second_left', hue: '#4f7cff' },
        { label: '右眼', field: 'second_right', hue: '#10b3a3' },
        { label: '双眼', field: 'second_both', hue: '#8b5cf6' }
      ]
    }
  ];

  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /* ---------------- DOM ---------------- */

  const $ = (id) => document.getElementById(id);

  const el = {
    tabs: $('tabs'),
    viewToday: $('view-today'),
    viewHistory: $('view-history'),
    viewTrain: $('view-train'),
    btnUser: $('btnUser'),
    userName: $('userName'),
    userModal: $('userModal'),
    userInput: $('userInput'),
    userList: $('userList'),
    btnUserSave: $('btnUserSave'),
    btnUserCancel: $('btnUserCancel'),
    calibRuler: $('calibRuler'),
    calibInput: $('calibInput'),
    calibHint: $('calibHint'),
    setMaxDisplay: $('setMaxDisplay'),
    maxDisplayNote: $('maxDisplayNote'),
    setEffect: $('setEffect'),
    setEnhance: $('setEnhance'),
    setRequire: $('setRequire'),
    pickModes: $('pickModes'),
    pickEyes: $('pickEyes'),
    btnStartTrain: $('btnStartTrain'),
    startTip: $('startTip'),
    dbDot: $('dbDot'),
    dbStateTitle: $('dbStateTitle'),
    dbStateDesc: $('dbStateDesc'),
    btnExport: $('btnExport'),
    btnImport: $('btnImport'),
    fileImport: $('fileImport'),
    warnBar: $('warnBar'),
    introOverlay: $('introOverlay'),
    introOk: $('introOk'),
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
    btnDelete: $('btnDelete'),
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
    hasRecord: false,
    user: null        // 当前选中的用户（user_config 表里的一行）
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

  /** 视力值自适应小数位：0.6 → "0.6"，0.12 → "0.12"。固定 1 位会把 0.12 显示成 0.1 */
  function fmtVision(v) {
    if (v === null || v === undefined) return '';
    const t = Math.round(v * 100);
    return (t % 10 === 0) ? v.toFixed(1) : v.toFixed(2);
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  let toastTimer = null;
  function toast(msg, isError) {
    if (window.EyeTrain && window.EyeTrain.isActive()) return;   // 训练舞台在最上层，弹了也看不见
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
    f.input.value = val === null ? '' : (opt.visionFmt ? fmtVision(val) : fmt(val, opt.decimals));
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
    el.btnDelete.hidden = !state.hasRecord;
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
    if (!state.user) { renderNoUser(); return; }
    const d = el.recordDate.value;
    renderDateHint();

    const rec = window.EyeDB.getByDate(state.user.user_id, d);
    state.hasRecord = !!rec;
    state.editing = !rec;

    if (rec) {
      setValue('pre_left', rec.pre_left);
      setValue('pre_right', rec.pre_right);
      setValue('pre_both', rec.pre_both);
      setValue('train_left', rec.train_left);
      setValue('train_right', rec.train_right);
      setValue('train_both', rec.train_both);
      setValue('second_left', rec.second_left);
      setValue('second_right', rec.second_right);
      setValue('second_both', rec.second_both);
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

  function renderNoUser() {
    Object.keys(fields).forEach((k) => setValue(k, null));
    el.remark.value = '';
    el.dateHint.textContent = '';
    el.actionInfo.innerHTML = '先在右上角「切换用户」里填个名字，才能开始记录';
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
      second_left: v('second_left'),
      second_right: v('second_right'),
      second_both: v('second_both'),
      test_distance: window.EyeDB.m2cm(v('test_distance')),
      train_distance: window.EyeDB.m2cm(v('train_distance')),
      remark: el.remark.value.trim() || null
    };
  }

  function saveRecord() {
    if (!state.user) { toast('先在右上角「切换用户」里选好用户', true); openUserModal(); return; }
    if (!el.recordDate.value) { toast('请先选择日期', true); return; }
    const rec = collectForm();
    const hasVision = [
      'pre_left', 'pre_right', 'pre_both',
      'train_left', 'train_right', 'train_both',
      'second_left', 'second_right', 'second_both'
    ].some((k) => rec[k] !== null && rec[k] !== undefined);
    if (!hasVision) { toast('请至少填一项视力数据', true); return; }

    el.btnSave.disabled = true;
    window.EyeDB.save(state.user.user_id, rec).then((written) => {
      el.btnSave.disabled = false;
      if (written) {
        toast('已保存');
        renderWarnBar();
      } else {
        window.EyeDB.exportBlob();
        toast('没能自动保存，已下载一份备份，请留好', true);
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
    if (!state.user) {
      renderCharts([]);
      renderTable([]);
      return;
    }
    const from = el.fromDate.value;
    const to = el.toDate.value;
    if (!from || !to || from > to) return;

    const rows = window.EyeDB.listRange(state.user.user_id, from, to);
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
      def.datasets.forEach((ds, i) => {
        chart.data.datasets[i].data = asc.map((r) => r[ds.field]);
      });
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
        datasets: def.datasets.map((ds) => ({
          label: ds.label,
          data: [],
          borderColor: ds.hue,
          backgroundColor: hexToRgba(ds.hue, 0.10),
          pointBackgroundColor: ds.hue,
          borderWidth: 2.5,
          pointRadius: 3.5,
          fill: true,
          tension: 0.32,
          spanGaps: true
        }))
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
        '<tr><td colspan="14"><div class="empty-tip"><b>没有记录</b>换个日期范围试试</div></td></tr>';
      return;
    }

    el.tableBody.innerHTML = rows.map((r) => {
      const cell = (v) => (v === null || v === undefined
        ? '<td class="num empty">—</td>'
        : '<td class="num">' + fmtVision(v) + '</td>');
      const dist = (cm) => cm === null || cm === undefined
        ? '<td class="num empty">—</td>'
        : '<td class="num">' + window.EyeDB.cm2m(cm) + '</td>';
      const remark = r.remark
        ? '<td class="remark-cell" title="' + esc(r.remark) + '">' + esc(r.remark) + '</td>'
        : '<td class="remark-cell empty">—</td>';
      const del = '<td><button type="button" class="btn-del" data-del="' + esc(r.record_date) + '">删除</button></td>';
      return '<tr>' +
        '<td class="date">' + esc(r.record_date) + '</td>' +
        cell(r.pre_left) + cell(r.pre_right) + cell(r.pre_both) +
        cell(r.train_left) + cell(r.train_right) + cell(r.train_both) +
        cell(r.second_left) + cell(r.second_right) + cell(r.second_both) +
        dist(r.test_distance) + dist(r.train_distance) +
        remark +
        del +
        '</tr>';
    }).join('');
  }

  /* ---------------- 数据库状态 / 首次说明页 ---------------- */

  function renderDbState() {
    if (!state.ready) {
      el.dbDot.className = 'db-dot';
      el.dbStateTitle.textContent = '未连接';
      el.dbStateDesc.textContent = '正在打开数据库…';
      el.btnExport.hidden = true;
      el.btnImport.hidden = true;
      return;
    }
    const auto = window.EyeDB.isAutoSave();
    el.dbDot.className = 'db-dot ' + (auto ? 'is-ok' : 'is-warn');
    el.dbStateTitle.textContent = auto ? '已连接' : '内存模式';
    el.dbStateDesc.textContent = auto
      ? window.EyeDB.dbFileLabel() + ' · 自动保存'
      : '浏览器不能保存，请点「导出备份」';
    el.btnExport.hidden = false;
    el.btnImport.hidden = false;
  }

  function renderWarnBar() {
    if (!state.ready) { el.warnBar.hidden = true; return; }
    if (window.EyeDB.isAutoSave()) {
      el.warnBar.hidden = !window.EyeDB.hasPendingExport();
      if (!el.warnBar.hidden) {
        el.warnBar.innerHTML =
          '<b>注意：</b>刚才的修改没能写进浏览器，请立刻点顶栏的「导出备份」存一份。';
      }
      return;
    }
    el.warnBar.hidden = false;
    el.warnBar.innerHTML =
      '<b>当前浏览器不能自动保存数据。</b>' +
      '现在记的东西只存在内存里，关掉页面就会丢；每次保存都会自动下载一份备份，' +
      '请留好，下次打开页面时用顶栏的「导入」读回来。';
  }

  /**
   * 首次说明页：只显示一次。
   * 数据只存在浏览器里，必须让用户知道备份在哪、以及别把 html 挪走。
   */
  function showIntro() { el.introOverlay.hidden = false; }

  function hideIntro() {
    el.introOverlay.hidden = true;
    window.EyeDB.markIntroShown();
  }

  function onReady(res) {
    state.ready = true;
    renderDbState();
    renderWarnBar();
    restoreUser();          // 从数据库把上次的用户带回来
    renderTrainView();      // 把该用户的设置（校准/图标数/效果/强化次数/记录时机）按库里的值显示出来
    el.recordDate.value = todayStr();
    loadDate();
    initHistoryDefaults();

    if (res && res.corrupt) {
      toast('本地存的数据读不出来了，已重新开始；如果之前导出过备份，请用「导入」恢复', true);
    }
    // 「看过没」存在 IndexedDB 里，所以换文件夹打开时说明页会重新出现 —— 正是需要的
    window.EyeDB.introShown().then((seen) => { if (!seen) showIntro(); });
  }

  function initHistoryDefaults() {
    setRange(daysAgo(29), todayStr(), el.quickRange.querySelector('[data-days="30"]'));
  }

  /* ---------------- 用户 ---------------- */

  const USER_KEY = 'eyerecord.currentUser';

  function rememberUser(userId) {
    try { localStorage.setItem(USER_KEY, userId); } catch (e) { /* file:// 下可能被禁用，无所谓 */ }
  }

  function forgetUser() {
    try { localStorage.removeItem(USER_KEY); } catch (e) { /* 同上 */ }
  }

  /** 打开页面时把上次的用户带回来，省得每次都要重新选 */
  function restoreUser() {
    let saved = null;
    try { saved = localStorage.getItem(USER_KEY); } catch (e) { /* 同上 */ }
    if (!saved) { renderUserBtn(); return; }
    const u = window.EyeDB.getUser(saved);
    if (u) { state.user = u; }
    else forgetUser();
    renderUserBtn();
  }

  function renderUserBtn() {
    el.userName.textContent = state.user ? state.user.user_name : '切换用户';
    el.btnUser.classList.toggle('is-active', !!state.user);
  }

  function openUserModal() {
    el.userInput.value = state.user ? state.user.user_name : '';
    renderUserList();
    el.userModal.hidden = false;
    el.userInput.focus();
    el.userInput.select();
  }

  function closeUserModal() { el.userModal.hidden = true; }

  function renderUserList() {
    const users = window.EyeDB.listUsers();
    el.userList.innerHTML = users.map((u) =>
      '<button type="button" class="user-item' +
      (state.user && u.user_id === state.user.user_id ? ' is-current' : '') +
      '" data-id="' + esc(u.user_id) + '">' + esc(u.user_name) + '</button>'
    ).join('');
    el.userList.hidden = users.length === 0;
  }

  function applyUser(user) {
    state.user = user;
    rememberUser(user.user_id);
    renderUserBtn();
    closeUserModal();
    loadDate();
    if (!el.viewHistory.hidden) refreshHistory();
    if (!el.viewTrain.hidden) renderTrainView();
    toast('已切换到「' + user.user_name + '」');
  }

  function saveUserFromInput() {
    const name = el.userInput.value.trim();
    if (!name) { toast('请填写姓名', true); el.userInput.focus(); return; }
    el.btnUserSave.disabled = true;
    window.EyeDB.upsertUserByName(name).then((user) => {
      el.btnUserSave.disabled = false;
      applyUser(user);
    }).catch((err) => {
      el.btnUserSave.disabled = false;
      toast(err && err.message ? err.message : '保存失败', true);
    });
  }

  /* ---------------- 测训视图 ---------------- */

  let trainModeIdx = 0;
  let trainEyeIdx = 0;

  /** 校准条宽度跟着实测值走；填完之后它就是真正的 100 毫米 */
  function renderCalibration() {
    const calib = state.user ? Number(state.user.chart_calibration) || 100 : 100;
    el.calibRuler.style.width = window.EyeChart.calibrationBarPx(calib) + 'px';
    el.calibHint.innerHTML = '当前标称 <b>100.0 mm</b>，按 ' +
      '<b>' + calib + ' mm</b> 校准。1 毫米 ≈ ' +
      window.EyeChart.pxPerMm(calib).toFixed(2) + ' 像素' +
      (window.EyeChart.isTooSmall(calib)
        ? '；<b class="calib-bad">最高档图标太小，可能会看不清，建议放大浏览器缩放后重新校准</b>'
        : '');
  }

  /** 测训页的设置全部来自当前用户的配置 */
  function renderTrainView() {
    if (!state.ready) return;
    if (!state.user) {
      el.startTip.textContent = '先在右上角「切换用户」里选好用户，才能开始训练';
      el.setMaxDisplay.value = '';
      el.setEnhance.value = '';
      setSeg(el.setEffect, '');
      setSeg(el.setRequire, '');
      el.calibRuler.style.width = window.EyeChart.calibrationBarPx(100) + 'px';
      el.calibHint.textContent = '';
      renderPick();
      return;
    }
    el.startTip.textContent = '';
    const cfg = state.user;
    el.setMaxDisplay.value = cfg.max_display_count;
    el.maxDisplayNote.textContent = cfg.max_display_count === 0 ? '自动排满一行' : '';
    el.setEnhance.value = cfg.enhance_count;
    setSeg(el.setEffect, cfg.effect_confirm);
    setSeg(el.setRequire, cfg.record_require);
    el.calibInput.value = cfg.chart_calibration;
    renderCalibration();
    renderPick();
  }

  function setSeg(host, val) {
    Array.prototype.forEach.call(host.children, (b) => {
      b.classList.toggle('is-on', b.dataset.val === val);
    });
  }

  function renderPick() {
    Array.prototype.forEach.call(el.pickModes.children, (b) => {
      b.classList.toggle('is-on', +b.dataset.idx === trainModeIdx);
    });
    Array.prototype.forEach.call(el.pickEyes.children, (b) => {
      b.classList.toggle('is-on', +b.dataset.idx === trainEyeIdx);
    });
  }

  /**
   * 设置一变就按当前用户实时入库。
   * 内存里的用户对象必须同步改：改完「图标个数」紧接着点「开始训练」，
   * 如果等写盘完成的回调才更新，训练读到的一开始还是旧值。
   */
  function updateConfig(key, value) {
    if (!state.user) { toast('先选好用户再调设置', true); return; }
    state.user[key] = value;
    if (key === 'chart_calibration') renderCalibration();
    if (key === 'max_display_count') {
      el.maxDisplayNote.textContent = value === 0 ? '自动排满一行' : '';
    }
    window.EyeDB.updateConfig(state.user.user_id, key, value).then((written) => {
      // 写不进去时把警示条亮出来，并顺手下载一份备份，别让改动悄悄丢掉
      if (!written) window.EyeDB.exportBlob();
      renderWarnBar();
    }).catch((err) => {
      toast('保存设置失败：' + (err && err.message ? err.message : err), true);
    });
  }

  function startTraining() {
    if (!state.user) { toast('先在右上角「切换用户」里选好用户', true); openUserModal(); return; }
    const cfg = state.user;
    try {
      window.EyeTrain.start({
        userId: cfg.user_id,
        config: {
          effect_confirm: cfg.effect_confirm,
          enhance_count: cfg.enhance_count,
          record_require: cfg.record_require,
          chart_calibration: cfg.chart_calibration,
          max_display_count: cfg.max_display_count
        },
        modeIdx: trainModeIdx,
        eyeIdx: trainEyeIdx,
        onExit: (r) => {
          // 训练里双击左右也能切方式和眼睛，退出来把设置页同步成最后用的那组
          trainModeIdx = r.modeIdx;
          trainEyeIdx = r.eyeIdx;
          renderPick();
          loadDate();
          renderWarnBar();
          if (!el.viewHistory.hidden) refreshHistory();
        }
      });
    } catch (e) {
      toast(e && e.message ? e.message : '无法开始训练', true);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      Array.prototype.forEach.call(el.tabs.children, (b) => b.classList.toggle('is-active', b === btn));
      const view = btn.dataset.view;
      el.viewToday.hidden = view !== 'today';
      el.viewHistory.hidden = view !== 'history';
      el.viewTrain.hidden = view !== 'train';
      if (view === 'history') refreshHistory();
      if (view === 'train') renderTrainView();
    });

    el.btnImport.addEventListener('click', () => el.fileImport.click());
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

    el.btnExport.addEventListener('click', () => {
      window.EyeDB.exportBlob();
      toast('备份已下载，请存到 U 盘或网盘');
    });

    el.introOk.addEventListener('click', hideIntro);

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
      renderActionInfo(window.EyeDB.getByDate(state.user.user_id, el.recordDate.value));
      fields.pre_left.input.focus();
    });

    el.btnCancel.addEventListener('click', () => {
      state.editing = false;
      loadDate();
    });

    el.btnDelete.addEventListener('click', () => {
      const d = el.recordDate.value;
      if (!d) return;
      if (!confirm('确定删除 ' + d + ' 的这条记录吗？删除后无法恢复。')) return;
      el.btnDelete.disabled = true;
      window.EyeDB.delete(state.user.user_id, d).then((written) => {
        el.btnDelete.disabled = false;
        if (!written) {
          window.EyeDB.exportBlob();
          toast('已删除；没能自动保存，已下载一份备份，请留好', true);
        } else {
          toast('已删除该天记录');
        }
        state.hasRecord = false;
        state.editing = false;
        loadDate();
        renderWarnBar();
        if (!el.viewHistory.hidden) refreshHistory();
      }).catch((err) => {
        el.btnDelete.disabled = false;
        toast('删除失败：' + (err && err.message ? err.message : err), true);
      });
    });

    el.tableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      const d = btn.getAttribute('data-del');
      if (!confirm('确定删除 ' + d + ' 的这条记录吗？删除后无法恢复。')) return;
      btn.disabled = true;
      window.EyeDB.delete(state.user.user_id, d).then((written) => {
        if (!written) {
          window.EyeDB.exportBlob();
          toast('已删除；没能自动保存，已下载一份备份，请留好', true);
        } else {
          toast('已删除该天记录');
        }
        renderWarnBar();
        refreshHistory();
        if (el.recordDate.value === d) { state.hasRecord = false; state.editing = false; loadDate(); }
      }).catch((err) => {
        toast('删除失败：' + (err && err.message ? err.message : err), true);
      });
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
        const all = window.EyeDB.listRange(state.user.user_id, '0000-01-01', '9999-12-31');
        const from = all.length ? all[all.length - 1].record_date : daysAgo(29);
        setRange(from, todayStr(), btn);
      } else {
        setRange(daysAgo(+days - 1), todayStr(), btn);
      }
    });

    /* ---- 切换用户 ---- */
    el.btnUser.addEventListener('click', openUserModal);
    el.btnUserSave.addEventListener('click', saveUserFromInput);
    el.btnUserCancel.addEventListener('click', closeUserModal);
    el.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveUserFromInput(); }
      if (e.key === 'Escape') closeUserModal();
    });
    el.userModal.addEventListener('click', (e) => {
      if (e.target === el.userModal) closeUserModal();
    });
    el.userList.addEventListener('click', (e) => {
      const btn = e.target.closest('.user-item');
      if (!btn) return;
      const u = window.EyeDB.getUser(btn.dataset.id);
      if (u) applyUser(u);
    });

    /* ---- 测训设置：一变就存 ---- */
    el.calibInput.addEventListener('change', () => {
      const raw = parseFloat(el.calibInput.value);
      if (isNaN(raw) || raw <= 0) { renderCalibration(); return; }
      // 入库取整毫米（0.5mm 的误差不到 1%，远小于相邻档约 20% 的差距）
      const v = Math.min(500, Math.max(20, Math.round(raw)));
      el.calibInput.value = v;
      updateConfig('chart_calibration', v);
    });
    el.setMaxDisplay.addEventListener('change', () => {
      let v = parseInt(el.setMaxDisplay.value, 10);
      if (isNaN(v)) { renderTrainView(); return; }
      v = Math.min(8, Math.max(0, v));
      el.setMaxDisplay.value = v;
      updateConfig('max_display_count', v);
      el.maxDisplayNote.textContent = v === 0 ? '自动排满一行' : '';
    });
    el.setEnhance.addEventListener('change', () => {
      let v = parseInt(el.setEnhance.value, 10);
      if (isNaN(v)) { renderTrainView(); return; }
      v = Math.min(20, Math.max(0, v));
      el.setEnhance.value = v;
      updateConfig('enhance_count', v);
    });
    el.setEffect.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      setSeg(el.setEffect, btn.dataset.val);
      updateConfig('effect_confirm', btn.dataset.val);
    });
    el.setRequire.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      setSeg(el.setRequire, btn.dataset.val);
      updateConfig('record_require', btn.dataset.val);
    });

    /* ---- 开始训练 ---- */
    el.pickModes.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      trainModeIdx = +btn.dataset.idx;
      renderPick();
    });
    el.pickEyes.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      trainEyeIdx = +btn.dataset.idx;
      renderPick();
    });
    el.btnStartTrain.addEventListener('click', startTraining);
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    buildAllFields();
    bindEvents();
    el.recordDate.value = todayStr();
    renderDateHint();
    setLocked(false);
    renderDbState();

    // boot 只在 sql.js 起不来时才会 reject（缺文件 / WASM 解不开），
    // 其余情况都返回一个能用的库 —— 不能再让任何状态把界面卡在遮罩上。
    window.EyeDB.boot().then(onReady).catch((err) => {
      toast('数据库打开失败：' + (err && err.message ? err.message : err), true);
      renderWarnBar();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
