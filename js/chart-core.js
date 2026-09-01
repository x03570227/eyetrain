/* =============================================================
 * js/chart-core.js — 视标几何与校准
 *
 * 数据全部来自 ai/eye-chart-5m.html（GB 11533-2011 表3 远视力表视标数据）。
 * side 是「站在 5 米处观看」标定的视标边长，本项目不做距离缩放，直接按它绘制。
 *
 * 关于校准：浏览器拿不到显示器的物理 PPI（CSS 的 1in 恒等于 96px，量不出真实英寸），
 * 所以先按 CSS 96dpi 的标称值渲染一条标称 100mm 的校准条，让用户用实物尺子量出
 * 真实毫米数，再反推当前屏幕真实的 px/mm。换显示器或改浏览器缩放后需要重新校准。
 * ============================================================= */
(function (global) {
  'use strict';

  /* 14 档：L=5分记录，V=小数记录，side=视标边长(mm) */
  const LEVELS = [
    { L: '4.0', V: 0.1,  side: 72.72 },
    { L: '4.1', V: 0.12, side: 57.76 },
    { L: '4.2', V: 0.15, side: 45.88 },
    { L: '4.3', V: 0.2,  side: 36.45 },
    { L: '4.4', V: 0.25, side: 28.95 },
    { L: '4.5', V: 0.3,  side: 23.00 },
    { L: '4.6', V: 0.4,  side: 18.27 },
    { L: '4.7', V: 0.5,  side: 14.51 },
    { L: '4.8', V: 0.6,  side: 11.53 },
    { L: '4.9', V: 0.8,  side: 9.16  },
    { L: '5.0', V: 1.0,  side: 7.27  },
    { L: '5.1', V: 1.2,  side: 5.78  },
    { L: '5.2', V: 1.5,  side: 4.59  },
    { L: '5.3', V: 2.0,  side: 3.64  }
  ];

  /* 视标：5×5 单位栅格，[x, y, w, h] —— 三划等长（GB 11533-2011 等效原图）
     三条等长竖划由底部一横相连，笔画宽度 = 缺口宽度 = 边长的 1/5。
     未旋转时缺口朝上，rotate(90°) 朝右、180° 朝下、270° 朝左，与方向键一一对应。 */
  const STROKES = [[0, 4, 5, 1], [0, 0, 1, 5], [2, 0, 1, 5], [4, 0, 1, 5]];

  /* 方向：0=上 1=右 2=下 3=左。SVG 里 y 轴向下，正角度是顺时针旋转 */
  const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };

  const MAX_ICONS = 8;                    // 一次最多展示几个
  const NOMINAL_PX_PER_MM = 96 / 25.4;    // CSS 96dpi 标称值 ≈ 3.7795
  const CALIBRATION_NOMINAL_MM = 100;     // 校准条标称 100mm
  const TINY_ICON_PX = 20;                // 低于这个值，最高档图标会糊成一团

  /** 校准条标称 100mm，用户量得 calib 毫米 → 真实的 px/mm */
  function pxPerMm(calibration) {
    const calib = Number(calibration);
    if (!isFinite(calib) || calib <= 0) return NOMINAL_PX_PER_MM;
    return NOMINAL_PX_PER_MM * (CALIBRATION_NOMINAL_MM / calib);
  }

  /** 校准条的像素宽度（标称 100mm）。填入实测值后它会变成真正的 100mm */
  function calibrationBarPx(calibration) {
    return CALIBRATION_NOMINAL_MM * pxPerMm(calibration);
  }

  /**
   * 一行最多放得下几个：图标之间留 1 个图标宽的空隙，
   * 于是 n 个占 (2n-1) 个图标宽。结果至少是 1，否则窄屏上会一个都不画、没法作答。
   * maxDisplay = 0 表示自动（能放几个放几个），1-8 表示上限。
   */
  function fitCountPx(iconPx, availPx, maxDisplay) {
    if (!(iconPx > 0)) return 1;
    let n = Math.floor((availPx / iconPx + 1) / 2);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > MAX_ICONS) n = MAX_ICONS;
    if (maxDisplay > 0 && n > maxDisplay) n = maxDisplay;
    return n;
  }

  /** 随机方向序列：四个朝向尽量均衡，次序随机 */
  function randomDirs(n) {
    const reps = Math.ceil(n / 4);
    const pool = [];
    for (let d = 0; d < 4; d++) {
      for (let i = 0; i < reps; i++) pool.push(d);
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, n);
  }

  function randomIndex(n) { return Math.floor(Math.random() * n); }

  function levelLabel(i) {
    const lv = LEVELS[i];
    return lv ? (formatV(lv.V) + '  ' + lv.L) : '';
  }

  /** 视力值格式化：0.6 → "0.6"，0.12 → "0.12"，1.0 → "1.0" */
  function formatV(v) {
    if (v === null || v === undefined) return '';
    return (Math.round(v * 100) % 10 === 0) ? v.toFixed(1) : v.toFixed(2);
  }

  /** 最高档图标在当前校准下有多少像素，用于提示「太小会看不清」 */
  function smallestIconPx(calibration) {
    return LEVELS[LEVELS.length - 1].side * pxPerMm(calibration);
  }

  function isTooSmall(calibration) {
    return smallestIconPx(calibration) < TINY_ICON_PX;
  }

  /**
   * 画一组居中视标，返回 SVG 源码字符串。
   *
   * opts = {
   *   level,          // 档位下标 0-13
   *   dirs,           // 每个图标的朝向数组
   *   selected,       // 被指中的那个图标下标（-1 表示不标记）
   *   width, height,  // 舞台尺寸（CSS px）
   *   calibration,    // 用户实测的校准毫米数
   *   bg,             // 底色，未选中的标记用它来隐藏自己
   *   marker          // 是否画三角标记（只有多图标时才需要）
   * }
   */
  function optotypeSvg(opts) {
    const lv = LEVELS[opts.level] || LEVELS[0];
    const dirs = opts.dirs || [];
    const count = dirs.length;
    const width = opts.width;
    const height = opts.height;
    const bg = opts.bg || '#ffffff';
    const f = pxPerMm(opts.calibration);

    const side = lv.side * f;                       // 视标边长（CSS px）
    const unit = side / 5;                          // 1 个单位 = 边长/5
    const gap = count > 1
      ? Math.max(0, Math.min(side, (width - count * side) / (count - 1)))
      : 0;
    const total = count * side + (count - 1) * gap;

    // 标记圆点的尺寸：跟着图标走，但夹在合理区间里，别在低档时大到出戏
    const markerH = Math.max(8, Math.min(30, side * 0.2));
    const markerR = markerH * 0.42;
    const markerGap = markerH * 0.5;
    const showMarker = !!opts.marker && count > 1;

    // 图标 + 标记当成一个整体居中，而不是只居中图标
    const blockH = side + (showMarker ? markerGap + markerH : 0);
    const iconTop = (height - blockH) / 2;
    const cy = iconTop + side / 2;
    const x0 = (width - total) / 2;

    const p = [];
    const centers = [];   // 每个图标的中心，反馈效果要靠它定位
    for (let k = 0; k < count; k++) {
      centers.push({
        cx: x0 + k * (side + gap) + side / 2,
        cy: cy,
        top: cy - side / 2
      });
    }

    p.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
      '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');

    if (showMarker) {
      const markerTop = iconTop + side + markerGap;
      for (let k = 0; k < count; k++) {
        const cx = x0 + k * (side + gap) + side / 2;
        const on = k === opts.selected;
        // 颜色走内联 style：全局样式表里有 svg circle { fill:none }，会盖掉 fill 属性
        const color = on ? '#ff0000' : bg;
        p.push('<circle cx="' + cx.toFixed(2) + '" cy="' + (markerTop + markerR).toFixed(2) +
          '" r="' + markerR.toFixed(2) + '" style="fill:' + color + ';stroke:none"/>');
      }
    }

    p.push('<g fill="#111827" shape-rendering="geometricPrecision">');
    for (let k = 0; k < count; k++) {
      const cx = x0 + k * (side + gap) + side / 2;
      p.push('<g transform="translate(' + cx.toFixed(2) + ' ' + cy.toFixed(2) +
        ') rotate(' + (dirs[k] * 90) + ') scale(' + unit.toFixed(5) +
        ') translate(-2.5 -2.5)">');
      for (let q = 0; q < STROKES.length; q++) {
        const r = STROKES[q];
        p.push('<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '"/>');
      }
      p.push('</g>');
    }
    p.push('</g></svg>');

    return {
      svg: p.join(''),
      count: count,
      sidePx: side,
      centers: centers,
      level: lv
    };
  }

  global.EyeChart = {
    LEVELS: LEVELS,
    DIR: DIR,
    MAX_ICONS: MAX_ICONS,
    TINY_ICON_PX: TINY_ICON_PX,
    pxPerMm: pxPerMm,
    calibrationBarPx: calibrationBarPx,
    fitCountPx: fitCountPx,
    randomDirs: randomDirs,
    randomIndex: randomIndex,
    levelLabel: levelLabel,
    formatV: formatV,
    smallestIconPx: smallestIconPx,
    isTooSmall: isTooSmall,
    optotypeSvg: optotypeSvg
  };
})(window);
