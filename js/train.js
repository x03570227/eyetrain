/* =============================================================
 * js/train.js — 测训舞台
 *
 * 全屏白底遮罩上画一组山字视标，用方向键作答：
 *   单击方向键     = 回答当前被红点指中的那个图标的朝向
 *   双击同一个方向 = 上/下切档，左切测试方式，右切训练眼睛
 *
 * 写库规则：本档答对次数达到「强化次数」才写（写的是「今天」，跟日期选择框翻到
 * 哪一天无关）。只答对一次就写，会把蒙对的档位记成真实水平。达标之后怎么办，
 * 三种模式各不相同，见 afterCorrect()。
 * ============================================================= */
(function (global) {
  'use strict';

  const MODES = [
    { key: 'TEST',   label: '测视' },
    { key: 'TRAIN',  label: '训练' },
    { key: 'SECOND', label: '秒视' }
  ];
  const EYES = [
    { key: 'LEFT',  label: '左' },
    { key: 'RIGHT', label: '右' },
    { key: 'BOTH',  label: '双眼' }
  ];

  /* 需求里的对照表：测试方式 + 眼睛 → 数据库字段 */
  const FIELD_MAP = {
    TEST:   { LEFT: 'pre_left',    RIGHT: 'pre_right',    BOTH: 'pre_both' },
    TRAIN:  { LEFT: 'train_left',  RIGHT: 'train_right',  BOTH: 'train_both' },
    SECOND: { LEFT: 'second_left', RIGHT: 'second_right', BOTH: 'second_both' }
  };

  /* 双击「左」的循环顺序：训练 → 测视 → 秒视 → 训练
     （需求原文：当前是训练，双击左切到测视，再双击切到秒视，再双击回到训练） */
  const MODE_CYCLE = [2, 0, 1];   // MODES[i] 的下一个下标
  /* 双击「右」的循环顺序：右 → 双眼 → 左 → 右 */
  const EYE_CYCLE = [1, 2, 0];

  const KEY_DIR = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 };

  const DOUBLE_MS = 300;    // 双击判定窗口
  const EFFECT_MS = 1200;   // 反馈效果时长，期间锁输入（要和 CSS 里的动画时长一致）
  const SECOND_MS = 3000;   // 秒视：每组图标只展示 3 秒

  const $ = (id) => document.getElementById(id);

  const st = {
    active: false, paused: false, exiting: false,
    userId: null, config: null,
    modeIdx: 0, eyeIdx: 0,
    level: 0,
    dirs: [], selected: 0, centers: [],
    success: 0,     // 本档答对次数：够「强化次数」才有资格写库
    total: 0,       // 本档总作答次数（对 + 错），算成功率用
    saved: false,   // 本档是否已写过库：达标后每次答对都写是白费一次全库导出
    generation: 0,     // 每次重画自增：延迟触发的按键动作靠它判断自己是否已过期
    locked: false,
    pending: null,
    secondTimer: null, effectTimer: null, pressTimer: null,
    els: {},
    onExit: null
  };

  /* ---------------- 小工具 ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function level() { return global.EyeChart.LEVELS[st.level]; }

  function modeKey() { return MODES[st.modeIdx].key; }

  function currentField() {
    return FIELD_MAP[modeKey()][EYES[st.eyeIdx].key];
  }

  /* ---------------- 绘制 ---------------- */

  function draw() {
    clearPending();
    const canvas = st.els.canvas;
    // clientWidth 会强制浏览器立刻排版，所以刚取消 hidden 也能拿到真实尺寸
    const w = Math.max(160, canvas.clientWidth);
    const h = Math.max(160, canvas.clientHeight);
    const calib = st.config.chart_calibration;

    const iconPx = level().side * global.EyeChart.pxPerMm(calib);
    const count = global.EyeChart.fitCountPx(iconPx, w - 40, st.config.max_display_count);

    st.dirs = global.EyeChart.randomDirs(count);
    st.selected = count > 1 ? global.EyeChart.randomIndex(count) : 0;
    st.generation++;

    const out = global.EyeChart.optotypeSvg({
      level: st.level,
      dirs: st.dirs,
      selected: st.selected,
      width: w,
      height: h,
      calibration: calib,
      bg: '#ffffff',
      marker: count > 1
    });
    canvas.innerHTML = out.svg;
    st.centers = out.centers;

    renderSide();
    restartSecondTimer();
  }

  /** 左侧竖条：14 个档位，当前档高亮 */
  function renderSide() {
    const rows = st.els.side.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-current', i === st.level);
    }
  }

  function buildSide() {
    const host = st.els.side;
    host.innerHTML = '';
    global.EyeChart.LEVELS.forEach((lv, i) => {
      const row = document.createElement('div');
      row.className = 'train-level';
      row.innerHTML = '<b>' + global.EyeChart.formatV(lv.V) + '</b><span>' + lv.L + '</span>';
      host.appendChild(row);
    });
  }

  /** 顶部下拉条：两组 TAB + 退出 */
  function renderBar() {
    const modes = st.els.barModes.children;
    for (let i = 0; i < modes.length; i++) {
      modes[i].classList.toggle('is-on', i === st.modeIdx);
    }
    const eyes = st.els.barEyes.children;
    for (let i = 0; i < eyes.length; i++) {
      eyes[i].classList.toggle('is-on', i === st.eyeIdx);
    }
    renderEyes();
    renderModeBadge();
  }

  /** 左下/右下角眼睛图案：随训练眼切换（左眼→左、右眼→右、双眼→两个都亮） */
  function renderEyes() {
    const eye = EYES[st.eyeIdx].key;   // LEFT / RIGHT / BOTH
    st.els.eyeLeft.hidden = (eye === 'RIGHT');
    st.els.eyeRight.hidden = (eye === 'LEFT');
  }

  /** 右上角：用颜色表示当前训练模式（黑=训练 蓝=测视 紫=秒视），颜色由 CSS 按类名切换。
      不用红/绿，避免和左下/右下角的眼睛指示（红=左眼 绿=右眼）撞色 */
  function renderModeBadge() {
    st.els.modeBadge.className = 'train-mode-badge mode-' + MODES[st.modeIdx].key;
  }

  function buildBar() {
    const mHost = st.els.barModes;
    mHost.innerHTML = '';
    MODES.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'train-tab';
      b.textContent = m.label;
      b.addEventListener('click', () => { if (st.active) setMode(i); });
      mHost.appendChild(b);
    });

    const eHost = st.els.barEyes;
    eHost.innerHTML = '';
    EYES.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'train-tab';
      b.textContent = e.label;
      b.addEventListener('click', () => { if (st.active) setEye(i); });
      eHost.appendChild(b);
    });
  }

  /* ---------------- 档位 / 模式 / 眼睛 ---------------- */

  /** 本档成功率（0–1），一次都没答过时算 0 */
  function rate() { return st.total > 0 ? st.success / st.total : 0; }

  /** 底部浮动统计条：show=false 直接收起来 */
  function renderStats(show) {
    const box = st.els.stats;
    if (!show) { box.hidden = true; return; }
    box.hidden = false;
    st.els.statTotal.textContent = st.total;
    st.els.statSuccess.textContent = st.success;
    st.els.statRate.textContent = Math.round(rate() * 100) + '%';
    box.classList.toggle('is-low', rate() < 0.5);   // 不到一半用红字
  }

  /**
   * 换档 / 换模式 / 换眼睛都要把本档的计数清零。
   * 统计条也要一起收掉 —— 它显示的是上一档的次数，留着会看错。
   */
  function resetCounters() {
    st.success = 0;
    st.total = 0;
    st.saved = false;
    renderStats(false);
  }

  /** 切换模式或眼睛都要回到第 0 档、清空计数 */
  function resetLevel() {
    st.level = 0;
    resetCounters();
    renderBar();
    draw();
  }

  function setMode(i) { st.modeIdx = i; resetLevel(); }
  function setEye(i) { st.eyeIdx = i; resetLevel(); }

  /** 只换档，不写库：手动切到下一档不算这个档位练成了 */
  function gotoLevel(i) {
    st.level = clamp(i, 0, global.EyeChart.LEVELS.length - 1);
    resetCounters();
    draw();
  }

  /* ---------------- 反馈效果 ---------------- */

  function clearFx() {
    st.els.fx.innerHTML = '';
    st.els.stage.classList.remove('is-ok', 'is-bad');
  }

  function spawnGameFx(ok) {
    const c = st.centers[st.selected];
    if (!c) return;
    const el = document.createElement('div');
    el.className = 'train-fx-item' + (ok ? ' is-ok' : ' is-bad');
    // 爱心带 U+FE0F 强制走 emoji 字形（更饱满、离远看得清）；
    // 有 emoji 字体时用系统红，没有时退回文本字形、吃 CSS 里的红色
    el.textContent = ok ? '\u2764\uFE0F' : '\uD83D\uDCA5';
    el.style.left = c.cx + 'px';
    el.style.top = Math.max(10, c.top - 20) + 'px';
    st.els.fx.appendChild(el);
  }

  /**
   * 播完效果再回调 —— 进档与否要等效果结束才判定，
   * 效果期间锁输入，避免连按把状态打乱。
   */
  function showEffect(ok, done) {
    st.locked = true;
    if (st.config.effect_confirm === 'GAME') {
      spawnGameFx(ok);
    } else {
      st.els.stage.classList.add(ok ? 'is-ok' : 'is-bad');
    }
    st.effectTimer = setTimeout(() => {
      st.locked = false;
      clearFx();
      done();
    }, EFFECT_MS);
  }

  /* ---------------- 作答 ---------------- */

  /** 把当前档位的视力值写进今天这条记录。同一档只写一次，达标后每次答对都写是白费一次全库导出 */
  function saveCurrentLevel() {
    if (st.saved) return;
    st.saved = true;
    // 写「今天」这一天：训练是当下发生的，跟日期选择框翻到哪天无关
    global.EyeDB.recordVision(
      st.userId, todayStr(), currentField(), level().V, st.config.record_require
    );
  }

  function answer(dir) {
    const correct = dir === st.dirs[st.selected];
    st.total++;
    if (!correct) {
      showEffect(false, afterWrong);
      return;
    }
    st.success++;
    showEffect(true, afterCorrect);
  }

  /**
   * 答错之后：
   *   训练模式 —— 认错了要留在同一组图案上接着练，所以不换图案（只把已显示的统计条刷新一下）；
   *   测视/秒视 —— 换一组新图案（同档）。
   */
  function afterWrong() {
    if (!st.els.stats.hidden) renderStats(true);
    if (modeKey() !== 'TRAIN') draw();   // 训练模式保留当前图案
  }

  /**
   * 答对之后统一判定：本档答对次数够不够「强化次数」，够了三种模式各走各的。
   *   测视 —— 成功次数 >= 强化次数：写库，并自动进下一档
   *   训练 —— 成功次数 > 强化次数 且 成功率 > 50% 才写库；不进档，底部常驻统计条，
   *           档位全由用户双击上下键决定（按 Enter 也能手动换图案）
   *   秒视 —— 成功次数 >= 强化次数 且 成功率 > 50%：写库并进下一档；
   *           没过半就把统计条（红字）亮出来继续练，等成功率上来再写库进档
   */
  function afterCorrect() {
    const need = st.config.enhance_count;
    const reached = st.success >= need;   // 达到次数门槛就亮统计条

    if (modeKey() === 'TEST') {
      if (reached) { saveCurrentLevel(); gotoLevel(st.level + 1); return; }
      draw();
      return;
    }

    if (modeKey() === 'TRAIN') {
      // 写库条件：成功次数 > 强化次数 且 成功率 > 50%（严格大于，不是 >=）
      if (st.success > need && rate() > 0.5) saveCurrentLevel();
      renderStats(reached);   // 达到次数门槛就常驻显示，不自动进档
      draw();                 // 答对换图案
      return;
    }

    // 秒视
    if (reached && rate() > 0.5) {
      saveCurrentLevel();
      gotoLevel(st.level + 1);
      return;
    }
    renderStats(reached);
    draw();
  }

  /* ---------------- 键盘 ---------------- */

  function clearPending() {
    if (st.pending) {
      clearTimeout(st.pending.timer);
      st.pending = null;
    }
  }

  function flashPress() {
    const canvas = st.els.canvas;
    canvas.classList.add('is-pressed');
    clearTimeout(st.pressTimer);
    st.pressTimer = setTimeout(() => canvas.classList.remove('is-pressed'), 130);
  }

  /** 回车：训练模式下直接换一组新图案（不作答、不计数，给操作者一个「跳过当前这组」的手段） */
  function onEnter() {
    if (!st.active || st.paused || st.exiting || st.locked) return;
    if (modeKey() !== 'TRAIN') return;          // 仅训练模式支持手动换图案
    draw();
  }

  function onKeyDown(e) {
    if (!st.active || st.paused || st.exiting) return;
    if (e.repeat) return;                       // 长按产生的重复事件直接丢掉
    if (e.key === 'Enter') { onEnter(); return; }
    const dir = KEY_DIR[e.key];
    if (dir === undefined) return;
    e.preventDefault();

    flashPress();   // 立刻给个按下的反馈，抵消双击判定带来的等待感

    const now = Date.now();
    const p = st.pending;
    // 双击不校验 generation：切档、切模式这些动作跟当前画的是哪一组图标无关，
    // 所以即使正赶上效果动画或者秒视自动翻页，也照常响应，不然会觉得「按了没反应」
    if (p && p.key === e.key && now - p.at < DOUBLE_MS) {
      clearPending();
      runDouble(e.key);
      return;
    }

    clearPending();
    const gen = st.generation;
    st.pending = {
      key: e.key,
      at: now,
      timer: setTimeout(() => {
        st.pending = null;
        if (!st.active || st.paused || st.exiting) return;
        if (st.locked) return;              // 期间进了效果动画，这次作答作废
        if (gen !== st.generation) return;  // 图标已经换过了（比如秒视自动翻页），作废
        answer(dir);
      }, DOUBLE_MS)
    };
  }

  /** 双击：下=下一档，上=上一档，左=切测试方式，右=切眼睛 */
  function runDouble(key) {
    if (key === 'ArrowDown') gotoLevel(st.level + 1);
    else if (key === 'ArrowUp') gotoLevel(st.level - 1);
    else if (key === 'ArrowLeft') setMode(MODE_CYCLE[st.modeIdx]);
    else if (key === 'ArrowRight') setEye(EYE_CYCLE[st.eyeIdx]);
  }

  /** 秒视：每组只展示 3 秒，到点换一组新图标（不进档、不算答错） */
  function restartSecondTimer() {
    clearTimeout(st.secondTimer);
    if (modeKey() !== 'SECOND') return;
    st.secondTimer = setTimeout(() => {
      if (!st.active || st.paused || st.exiting) return;
      if (st.locked) { restartSecondTimer(); return; }   // 效果还没播完，等下一拍
      draw();
    }, SECOND_MS);
  }

  /* ---------------- 全屏 ---------------- */

  function requestFs() {
    const el = document.documentElement;
    if (!el.requestFullscreen) return Promise.resolve(false);
    return Promise.resolve(el.requestFullscreen()).then(() => true).catch(() => false);
  }

  function onFullscreenChange() {
    if (!st.active || st.exiting) return;
    // Esc 退出全屏时浏览器不会投递 keydown，只能在这里兜底
    if (!document.fullscreenElement) pause();
    else hideResume();
  }

  function pause() {
    st.paused = true;
    clearTimeout(st.secondTimer);
    clearPending();
    st.els.resume.hidden = false;
  }

  function hideResume() {
    st.paused = false;
    st.els.resume.hidden = true;
  }

  function onResize() {
    if (st.active && !st.paused) draw();
  }

  /* ---------------- 启动 / 退出 ---------------- */

  function start(opts) {
    if (st.active) return;
    if (!st.ready) throw new Error('测训舞台没有初始化');
    if (!opts || !opts.userId || !opts.config) {
      throw new Error('开始训练前需要先选择用户');
    }

    st.active = true;
    st.exiting = false;
    st.paused = false;
    st.userId = opts.userId;
    st.config = opts.config;
    st.modeIdx = clamp(opts.modeIdx || 0, 0, MODES.length - 1);
    st.eyeIdx = clamp(opts.eyeIdx || 0, 0, EYES.length - 1);
    st.onExit = opts.onExit || null;

    clearFx();
    // 全屏必须赶在用户手势还没失效的时候申请，所以放在最前面（不能等任何 await）
    requestFs();
    st.els.stage.hidden = false;
    // 强制一次排版，好让下面 draw() 能读到真实的舞台尺寸
    void st.els.stage.offsetWidth;
    st.els.stage.classList.add('is-in');

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    global.addEventListener('resize', onResize);

    resetLevel();
  }

  function stop() {
    if (!st.active) return;
    st.active = false;
    st.paused = false;

    clearTimeout(st.secondTimer);
    clearTimeout(st.effectTimer);
    clearTimeout(st.pressTimer);
    clearPending();

    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    global.removeEventListener('resize', onResize);

    clearFx();
    st.els.stage.classList.remove('is-in');
    st.els.stage.hidden = true;
    st.els.resume.hidden = true;

    global.EyeDB.flushTrainingWrites();

    const cb = st.onExit;
    st.onExit = null;
    if (cb) cb({ modeIdx: st.modeIdx, eyeIdx: st.eyeIdx });
  }

  function exitTraining() {
    st.exiting = true;
    stop();
    st.exiting = false;
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    // 舞台 markup 齐了才接管，缺一个就整体不启用，免得半初始化后在 start() 里崩
    const map = {
      stage: 'trainStage', canvas: 'trainCanvas', fx: 'trainFx', side: 'trainSide',
      barModes: 'trainBarModes', barEyes: 'trainBarEyes', bar: 'trainBar',
      topwrap: 'trainTopwrap', resume: 'trainResume',
      stats: 'trainStats', statTotal: 'statTotal',
      statSuccess: 'statSuccess', statRate: 'statRate',
      eyeLeft: 'trainEyeLeft', eyeRight: 'trainEyeRight',
      modeBadge: 'trainModeBadge',
      btnExit: 'btnExitTrain', btnResume: 'btnResumeTrain', btnQuit: 'btnQuitTrain'
    };
    st.els = {};
    Object.keys(map).forEach((key) => { st.els[key] = $(map[key]); });
    st.ready = Object.keys(map).every((key) => !!st.els[key]);
    if (!st.ready) return;

    buildSide();
    buildBar();

    st.els.btnExit.addEventListener('click', exitTraining);
    st.els.btnQuit.addEventListener('click', exitTraining);
    st.els.btnResume.addEventListener('click', () => {
      requestFs().then(() => {
        if (document.fullscreenElement) hideResume();
        draw();
      });
    });

    // hotspot 和下拉条放在同一个容器里，用容器的进出驱动显示，
    // 鼠标在两个元素之间移动时不会来回闪
    st.els.topwrap.addEventListener('pointerenter', () => {
      st.els.topwrap.classList.add('is-open');
    });
    st.els.topwrap.addEventListener('pointerleave', () => {
      st.els.topwrap.classList.remove('is-open');
    });
  }

  global.EyeTrain = {
    init: init,
    start: start,
    stop: exitTraining,
    isActive: () => st.active,
    MODES: MODES,
    EYES: EYES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
