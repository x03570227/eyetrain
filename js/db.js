/* =============================================================
 * js/db.js — 数据层（纯浏览器存储版，不再依赖 SQLite）
 *
 * 存储方式：
 *   1. 业务数据本身直接以对象形式存在 IndexedDB 里：
 *        - users   对象仓库，主键 user_id，一个用户一行配置
 *        - records 对象仓库，主键 id，一条日记录一行
 *        - meta    对象仓库，存「首次说明页看过没」这类小标记
 *   2. 内存里维护一份完整副本，页面上的读取（getByDate / listRange / listUsers）
 *      都是同步的，写入先改内存再异步落盘，落盘结果作为返回值告诉上层。
 *   3. 导出 / 导入统一切到 JSON：导出的是一份带版本号的结构化文件，
 *      导入同时兼容：
 *        - 新版 JSON 备份；
 *        - 旧版（sql.js 时代）导出的 SQLite 二进制备份，以及浏览器里遗留的
 *          旧版 SQLite 快照 —— 用一个只读的 SQLite 文件解析器读出数据再转成 JSON。
 *
 * 为什么不再用 sql.js：
 *   sql.js 会把约 1MB 的 WASM 打进页面，而这里的数据量很小、查询也简单，
 *   直接按对象存 IndexedDB 更快、更省内存，也少一层「整体导出二进制快照」的开销。
 *
 * 两种模式：
 *   idb     — 正常路径，每次改动即时写入 IndexedDB，刷新 / 重开浏览器都不丢。
 *   manual  — 浏览器没有 IndexedDB 时的降级：只存在内存里，每次保存自动下载备份。
 *
 * 注意：IndexedDB 里那份是唯一副本。清浏览器缓存、换浏览器、换电脑都会丢，
 * 跨设备搬移数据只能靠「导出备份 / 导入」。
 * ============================================================= */
(function (global) {
  'use strict';

  /* ---------------- 常量 ---------------- */

  const IDB_NAME = 'eyerecord-app';
  /* 版本 3：从「一个 store 存整个 SQLite 快照」改成 users / records / meta 三个仓库。
     v2 的 'db' store 不动，里面可能还有一份旧 SQLite 快照，启动时用它做一次性迁移。 */
  const IDB_VERSION = 3;
  const STORE_META = 'meta';
  const STORE_USERS = 'users';
  const STORE_RECORDS = 'records';
  const LEGACY_STORE = 'db';            // v2 及以前：SQLite 快照的存放位置
  const LEGACY_BYTES_KEY = 'bytes';
  const META_INTRO_KEY = 'intro';

  /* 导出文件格式标识：认出自家文件，别的 JSON 一律拒绝 */
  const FORMAT = 'eyerecord';
  const FORMAT_VERSION = 2;

  const USER_FIELDS = [
    'id', 'user_id', 'user_name', 'effect_confirm', 'enhance_count',
    'record_require', 'chart_calibration', 'max_display_count',
    'gmt_created', 'gmt_modified', 'remark'
  ];
  const RECORD_FIELDS = [
    'id', 'user_id', 'record_date',
    'pre_left', 'pre_right', 'pre_both',
    'train_left', 'train_right', 'train_both',
    'second_left', 'second_right', 'second_both',
    'test_distance', 'train_distance', 'remark',
    'gmt_created', 'gmt_modified'
  ];

  /* recordVision 的字段名由外部传入，必须白名单校验 */
  const VISION_FIELDS = [
    'pre_left', 'pre_right', 'pre_both',
    'train_left', 'train_right', 'train_both',
    'second_left', 'second_right', 'second_both'
  ];

  /* 配置里允许外部按 key 更新的项，同样是白名单 */
  const CONFIG_FIELDS = [
    'effect_confirm', 'enhance_count', 'record_require',
    'chart_calibration', 'max_display_count'
  ];

  const CONFIG_LIMITS = {
    effect_confirm: ['GAME', 'COLOR'],
    record_require: ['BEST', 'LAST'],
    enhance_count: [0, 20],
    chart_calibration: [20, 500],
    max_display_count: [0, 8]
  };

  /* 训练自动建行时带上的默认测量距离（手动记录页的默认值与之保持一致） */
  const DEFAULT_TEST_DISTANCE_CM = 500;    // 测视距离 5 米
  const DEFAULT_TRAIN_DISTANCE_CM = 900;   // 强化训练距离 9 米

  const LEGACY_USER_ID = '80legacy000001';
  const LEGACY_USER_NAME = '历史记录（未归属）';

  const state = {
    mode: null,          // 'idb' | 'manual'
    users: [],           // 用户对象数组（内存副本）
    records: [],         // 记录对象数组（内存副本）
    nextUserId: 1,
    nextRecordId: 1,
    pendingExport: false,
    writeChain: Promise.resolve()
  };

  /* ---------------- 通用小工具 ---------------- */

  function pad(n, w) { return String(n).padStart(w, '0'); }

  /** 与 SQLite 的 CURRENT_TIMESTAMP 保持同一种字符串（UTC），显示层不用改 */
  function nowUtc() {
    const d = new Date();
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) +
      ' ' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2);
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  function intOrNull(v) {
    const n = numOrNull(v);
    return n === null ? null : Math.round(n);
  }

  function strOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s === '' ? null : s;
  }

  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function pickEnum(v, allowed, dflt) {
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }

  function normalizeTimestamp(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) {
      return v.replace('T', ' ').slice(0, 19);
    }
    return nowUtc();
  }

  function cloneUser(u) { return Object.assign({}, u); }
  function cloneRecord(r) { return Object.assign({}, r); }

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    throw new Error('无法识别的二进制数据');
  }

  function concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /* ---------------- 用户 / 记录的规范化 ---------------- */

  /** 把外来数据补成一条完整合法的用户配置；id 只用于排序，由采纳顺序决定 */
  function normalizeUser(raw, id) {
    const src = raw || {};
    return {
      id: id,
      user_id: String(src.user_id || ''),
      user_name: String(src.user_name == null || src.user_name === '' ? '未命名' : src.user_name),
      effect_confirm: pickEnum(src.effect_confirm, CONFIG_LIMITS.effect_confirm, 'GAME'),
      enhance_count: clampInt(src.enhance_count, 0, 20, 4),
      record_require: pickEnum(src.record_require, CONFIG_LIMITS.record_require, 'BEST'),
      chart_calibration: clampInt(src.chart_calibration, 20, 500, 100),
      max_display_count: clampInt(src.max_display_count, 0, 8, 1),
      gmt_created: normalizeTimestamp(src.gmt_created),
      gmt_modified: normalizeTimestamp(src.gmt_modified),
      remark: strOrNull(src.remark)
    };
  }

  function normalizeRecord(raw, id) {
    const src = raw || {};
    return {
      id: id,
      user_id: String(src.user_id || ''),
      record_date: String(src.record_date || ''),
      pre_left: numOrNull(src.pre_left),
      pre_right: numOrNull(src.pre_right),
      pre_both: numOrNull(src.pre_both),
      train_left: numOrNull(src.train_left),
      train_right: numOrNull(src.train_right),
      train_both: numOrNull(src.train_both),
      second_left: numOrNull(src.second_left),
      second_right: numOrNull(src.second_right),
      second_both: numOrNull(src.second_both),
      test_distance: intOrNull(src.test_distance),
      train_distance: intOrNull(src.train_distance),
      remark: strOrNull(src.remark),
      gmt_created: normalizeTimestamp(src.gmt_created),
      gmt_modified: normalizeTimestamp(src.gmt_modified)
    };
  }

  /** 只取记录里允许写入的 12 个字段，undefined 统一成 null */
  function pickRecordFields(rec) {
    const out = {};
    ['pre_left', 'pre_right', 'pre_both',
      'train_left', 'train_right', 'train_both',
      'second_left', 'second_right', 'second_both'].forEach((k) => { out[k] = numOrNull(rec[k]); });
    out.test_distance = intOrNull(rec.test_distance);
    out.train_distance = intOrNull(rec.train_distance);
    out.remark = strOrNull(rec.remark);
    return out;
  }

  /** 用一批用户 / 记录替换内存副本，并重排自增 id（顺带去重，保证仓库主键唯一） */
  function adopt(users, records) {
    const known = {};
    const cleanUsers = [];
    (users || []).forEach((u) => {
      if (!u || !u.user_id) return;
      const key = String(u.user_id);
      if (known[key]) return;
      known[key] = true;
      cleanUsers.push(normalizeUser(u, cleanUsers.length + 1));
    });

    const seen = {};
    const cleanRecords = [];
    (records || []).forEach((r) => {
      if (!r || !r.user_id || !r.record_date) return;
      const key = String(r.user_id) + '\u0000' + String(r.record_date);
      if (seen[key]) return;             // (user_id, record_date) 唯一：重复的只留第一条
      seen[key] = true;
      cleanRecords.push(normalizeRecord(r, cleanRecords.length + 1));
    });

    // 记录挂在一个不存在的用户上（比如只导入了 records）时，补一个占位用户，别让数据变孤儿
    let needLegacy = false;
    cleanRecords.forEach((r) => { if (!known[r.user_id]) needLegacy = true; });
    if (needLegacy && !known[LEGACY_USER_ID]) {
      cleanUsers.push(normalizeUser({
        user_id: LEGACY_USER_ID,
        user_name: LEGACY_USER_NAME,
        remark: '升级多用户版本之前已有的旧记录'
      }, cleanUsers.length + 1));
      known[LEGACY_USER_ID] = true;
    }

    state.users = cleanUsers;
    state.records = cleanRecords;
    state.nextUserId = cleanUsers.length + 1;
    state.nextRecordId = cleanRecords.length + 1;
  }

  /* ---------------- IndexedDB ---------------- */

  let idbPromise = null;

  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      let req;
      try { req = global.indexedDB.open(IDB_NAME, IDB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_USERS)) db.createObjectStore(STORE_USERS, { keyPath: 'user_id' });
        if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        // 旧版的 'db' store（SQLite 快照）故意留着，启动时用它做一次性迁移
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      // 别的标签页占着旧版本时会卡在这里，不能干等，直接让上层降级
      req.onblocked = () => reject(new Error('idb blocked'));
    }).catch((e) => { idbPromise = null; throw e; });
    return idbPromise;
  }

  function idbStoreExists(name) {
    return idbOpen().then((db) => db.objectStoreNames.contains(name));
  }

  function idbGetAll(storeName) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbGet(storeName, key) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPut(storeName, value) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb abort'));
    }));
  }

  /** meta 这类没有 keyPath 的仓库：put(值, 键) */
  function idbPutKey(storeName, value, key) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb abort'));
    }));
  }

  function idbDelete(storeName, key) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb abort'));
    }));
  }

  /** 用内存副本整体覆盖两个仓库：一个事务里完成，不会出现只写了一半的中间态 */
  function idbReplaceAll(users, records) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_USERS, STORE_RECORDS], 'readwrite');
      const us = tx.objectStore(STORE_USERS);
      const rs = tx.objectStore(STORE_RECORDS);
      us.clear();
      rs.clear();
      users.forEach((u) => us.put(u));
      records.forEach((r) => rs.put(r));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb abort'));
    }));
  }

  /**
   * 写入排队 + 结果归一：永远 resolve 成「有没有落盘成功」。
   * 写失败只把 pendingExport 亮起来（上层会提示用户导出备份），不抛错，
   * 这样即使存储出问题，界面也不会卡死。
   */
  function persist(work) {
    const run = () => {
      if (state.mode !== 'idb') {
        state.pendingExport = true;
        return false;
      }
      return work()
        .then(() => { state.pendingExport = false; return true; })
        .catch(() => { state.pendingExport = true; return false; });
    };
    state.writeChain = state.writeChain.then(run, run);
    return state.writeChain;
  }

  function persistAll() {
    return persist(() => idbReplaceAll(state.users, state.records));
  }

  function persistUser(user) {
    return persist(() => idbPut(STORE_USERS, user));
  }

  function persistRecord(rec) {
    return persist(() => idbPut(STORE_RECORDS, rec));
  }

  function persistRecordDelete(id) {
    return persist(() => idbDelete(STORE_RECORDS, id));
  }

  /* ---------------- 旧版 SQLite 备份解析（只读，用于兼容导入） ----------------
   *
   * 旧版本的备份是 sql.js 导出的标准 SQLite 文件。这里实现一个够用的只读解析器：
   * 顺着表 B 树读出每一行，按 CREATE TABLE 里的列名映射成对象。
   * 只解析表页（0x05 / 0x0D），支持溢出页、UTF-8 / UTF-16 文本。
   * ------------------------------------------------------------------------- */

  const decoderCache = {};

  function decodeSqliteText(bytes, encoding) {
    let enc = 'utf-8';
    if (encoding === 2) enc = 'utf-16le';
    else if (encoding === 3) enc = 'utf-16be';
    try {
      if (!decoderCache[enc]) decoderCache[enc] = new global.TextDecoder(enc);
      return decoderCache[enc].decode(bytes);
    } catch (e) {
      return new global.TextDecoder('utf-8').decode(bytes);
    }
  }

  function stripSqlComments(sql) {
    return String(sql).replace(/--[^\n\r]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  }

  /** 按顶层分隔符切分，跳过括号和引号里的内容 */
  function splitTopLevel(body, sep) {
    const out = [];
    let depth = 0;
    let cur = '';
    let quote = null;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === '[') { quote = ']'; cur += ch; continue; }
      if (ch === '(') { depth++; cur += ch; continue; }
      if (ch === ')') { depth--; cur += ch; continue; }
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** 从 CREATE TABLE 语句里解析列名 / 类型 / 是否主键 */
  function parseColumns(createSql) {
    const sql = stripSqlComments(createSql);
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    const parts = splitTopLevel(sql.slice(open + 1, close), ',');
    const cols = [];
    parts.forEach((part) => {
      const t = part.trim();
      if (!t) return;
      if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(t)) return;
      const m = /^(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|'([^']+)'|([A-Za-z_][A-Za-z0-9_$]*))/.exec(t);
      if (!m) return;
      const name = m[1] || m[2] || m[3] || m[4] || m[5];
      const rest = t.slice(m[0].length);
      const typeMatch = /^\s+([A-Za-z]+)/.exec(rest);
      cols.push({
        name: name,
        type: typeMatch ? typeMatch[1].toUpperCase() : '',
        pk: /\bPRIMARY\s+KEY\b/i.test(rest)
      });
    });
    return cols;
  }

  function sqliteSerial(t) {
    if (t === 0) return { kind: 'null', size: 0 };
    if (t >= 1 && t <= 4) return { kind: 'int', size: t };
    if (t === 5) return { kind: 'int', size: 6 };
    if (t === 6) return { kind: 'int', size: 8 };
    if (t === 7) return { kind: 'float', size: 8 };
    if (t === 8) return { kind: 'int0', size: 0 };
    if (t === 9) return { kind: 'int1', size: 0 };
    if (t === 10 || t === 11) return { kind: 'null', size: 0 };
    if (t % 2 === 0) return { kind: 'blob', size: (t - 12) / 2 };
    return { kind: 'text', size: (t - 13) / 2 };
  }

  function readSigned(buf, off, n) {
    if (n === 8) {
      const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
      return Number(dv.getBigInt64(0, false));
    }
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[off + i];
    if (v >= Math.pow(2, n * 8 - 1)) v -= Math.pow(2, n * 8);
    return v;
  }

  function readSqliteValue(buf, off, serial, encoding) {
    switch (serial.kind) {
      case 'null': return null;
      case 'int': return readSigned(buf, off, serial.size);
      case 'int0': return 0;
      case 'int1': return 1;
      case 'float': return new DataView(buf.buffer, buf.byteOffset + off, 8).getFloat64(0, false);
      case 'text': return decodeSqliteText(buf.subarray(off, off + serial.size), encoding);
      case 'blob': return buf.subarray(off, off + serial.size);
      default: return null;
    }
  }

  /**
   * 解析一个 SQLite 数据库文件（ArrayBuffer / Uint8Array）。
   * 返回 { tables: { 表名: { columns, rows } } }，rows 里的每一项是「列名 → 值」的对象。
   */
  function parseSqliteDatabase(input) {
    const u8 = toU8(input);
    if (u8.length < 100) throw new Error('文件太小，不是 SQLite 数据库');
    const magic = 'SQLite format 3\u0000';
    for (let i = 0; i < 16; i++) {
      if (u8[i] !== magic.charCodeAt(i)) throw new Error('不是 SQLite 数据库文件');
    }

    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pageSize = dv.getUint16(16, false);
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error('SQLite 页大小异常：' + pageSize);
    }
    const reserved = u8[20];
    const usable = pageSize - reserved;
    if (usable < 480) throw new Error('SQLite 可用页大小异常');
    const encoding = dv.getUint32(56, false) || 1;
    const totalPages = Math.max(1, Math.floor(u8.length / pageSize));

    function pageOffset(no) {
      if (no < 1 || no > totalPages) throw new Error('SQLite 页号越界：' + no);
      return (no - 1) * pageSize;
    }

    function readVarint(buf, off, end) {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        if (off + i >= end) throw new Error('记录越界（varint）');
        const b = buf[off + i];
        v = v * 128 + (b & 0x7f);
        if (b < 0x80) return { value: v, size: i + 1 };
      }
      if (off + 8 >= end) throw new Error('记录越界（varint）');
      v = v * 256 + buf[off + 8];
      return { value: v, size: 9 };
    }

    /** 取出单元格载荷：超出本页的部分顺着溢出页链拼回来 */
    function readPayload(off, len) {
      const maxLocal = usable - 35;
      if (len <= maxLocal) {
        if (off + len > u8.length) throw new Error('记录越界（载荷）');
        return u8.subarray(off, off + len);
      }
      const minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
      let local = minLocal + (len - minLocal) % (usable - 4);
      if (local > maxLocal) local = minLocal;
      const parts = [u8.subarray(off, off + local)];
      let remaining = len - local;
      let next = dv.getUint32(off + local, false);
      let guard = 0;
      while (next && remaining > 0) {
        if (++guard > totalPages + 10) throw new Error('SQLite 溢出页链异常');
        const po = pageOffset(next);
        const follow = dv.getUint32(po, false);
        const take = Math.min(remaining, usable - 4);
        parts.push(u8.subarray(po + 4, po + 4 + take));
        remaining -= take;
        next = follow;
      }
      if (remaining > 0) throw new Error('SQLite 记录载荷不完整');
      return concatBytes(parts, len);
    }

    function decodeRecord(payload) {
      const head = readVarint(payload, 0, payload.length);
      const headerSize = head.value;
      const types = [];
      let o = head.size;
      while (o < headerSize) {
        const t = readVarint(payload, o, payload.length);
        types.push(t.value);
        o += t.size;
      }
      let dataOff = headerSize;
      return types.map((t) => {
        const serial = sqliteSerial(t);
        const v = readSqliteValue(payload, dataOff, serial, encoding);
        dataOff += serial.size;
        return v;
      });
    }

    /** 中序遍历表 B 树，回调 (rowid, 值数组) */
    function walkTable(rootPage, onRow) {
      const seen = {};
      (function walk(no) {
        if (seen[no]) return;
        seen[no] = true;
        const base = pageOffset(no);
        // 第 1 页开头是 100 字节的文件头，B 树页头从 100 之后才开始；
        // 但单元格偏移量始终是相对页首的，所以 cell 用 base 换算。
        const hdr = no === 1 ? base + 100 : base;
        const type = u8[hdr];
        const count = dv.getUint16(hdr + 3, false);
        if (type === 0x0d) {                       // 叶表页
          for (let i = 0; i < count; i++) {
            const cell = base + dv.getUint16(hdr + 8 + i * 2, false);
            const pl = readVarint(u8, cell, u8.length);
            const rid = readVarint(u8, cell + pl.size, u8.length);
            const payload = readPayload(cell + pl.size + rid.size, pl.value);
            onRow(rid.value, decodeRecord(payload));
          }
          return;
        }
        if (type === 0x05) {                       // 内表页
          for (let i = 0; i < count; i++) {
            const cell = base + dv.getUint16(hdr + 12 + i * 2, false);
            walk(dv.getUint32(cell, false));
          }
          walk(dv.getUint32(hdr + 8, false));
          return;
        }
        throw new Error('不支持的 SQLite 页类型：' + type);
      })(rootPage);
    }

    function rowToObject(columns, vals, rowid) {
      const pkCols = columns.filter((c) => c.pk);
      // INTEGER PRIMARY KEY 是 rowid 的别名，记录里存的是 NULL，实际值要用 rowid 补上
      const rowidAlias = (pkCols.length === 1 && /INT/i.test(pkCols[0].type)) ? pkCols[0].name : null;
      const obj = {};
      columns.forEach((c, i) => {
        let v = i < vals.length ? vals[i] : null;
        if (c.name === rowidAlias && v === null) v = rowid;
        obj[c.name] = v;
      });
      return obj;
    }

    const tables = {};
    walkTable(1, (rowid, vals) => {                // 第 1 页是 sqlite_master
      const type = vals[0];
      const name = vals[1];
      const rootpage = vals[3];
      const sql = vals[4];
      if (type !== 'table' || !name || !sql || typeof rootpage !== 'number') return;
      const columns = parseColumns(sql);
      if (!columns.length) return;
      const rows = [];
      walkTable(rootpage, (rid, rvals) => rows.push(rowToObject(columns, rvals, rid)));
      tables[name] = { columns: columns, rows: rows };
    });

    return { pageSize: pageSize, encoding: encoding, tables: tables };
  }

  function isSqliteFile(bytes) {
    const u8 = toU8(bytes);
    if (u8.length < 16) return false;
    const magic = 'SQLite format 3\u0000';
    for (let i = 0; i < 16; i++) if (u8[i] !== magic.charCodeAt(i)) return false;
    return true;
  }

  function tableRows(parsed, name) {
    return parsed && parsed.tables && parsed.tables[name] ? parsed.tables[name].rows : [];
  }

  /** 把旧库里的两张表转成新结构；缺列、孤儿记录都在这里兜住 */
  function adoptFromSqlite(parsed) {
    const users = tableRows(parsed, 'user_config')
      .filter((u) => u && u.user_id)
      .map((u) => ({
        user_id: u.user_id,
        user_name: u.user_name,
        effect_confirm: u.effect_confirm,
        enhance_count: u.enhance_count,
        record_require: u.record_require,
        chart_calibration: u.chart_calibration,
        max_display_count: u.max_display_count,
        gmt_created: u.gmt_created,
        gmt_modified: u.gmt_modified,
        remark: u.remark
      }));

    const records = tableRows(parsed, 'vision_train_record')
      .filter((r) => r && r.record_date)
      .map((r) => ({
        user_id: r.user_id || LEGACY_USER_ID,
        record_date: r.record_date,
        pre_left: r.pre_left,
        pre_right: r.pre_right,
        pre_both: r.pre_both,
        train_left: r.train_left,
        train_right: r.train_right,
        train_both: r.train_both,
        // 旧版本没有秒视字段，读出来是 undefined，normalize 时会变成 null
        second_left: r.second_left,
        second_right: r.second_right,
        second_both: r.second_both,
        test_distance: r.test_distance,
        train_distance: r.train_distance,
        remark: r.remark,
        gmt_created: r.gmt_created,
        gmt_modified: r.gmt_modified
      }));

    // 老库里没有用户表 / 记录没有归属：统一挂到占位用户上
    if (records.length && (users.length === 0 || records.some((r) => r.user_id === LEGACY_USER_ID))) {
      if (!users.some((u) => u.user_id === LEGACY_USER_ID)) {
        users.push({
          user_id: LEGACY_USER_ID,
          user_name: LEGACY_USER_NAME,
          remark: '升级多用户版本之前已有的旧记录'
        });
      }
    }

    adopt(users, records);
  }

  /* ---------------- 启动流程 ---------------- */

  function loadFromIdb() {
    return Promise.all([idbGetAll(STORE_USERS), idbGetAll(STORE_RECORDS)])
      .then((res) => {
        const users = res[0];
        const records = res[1];
        if (users.length || records.length) {
          adopt(users, records);
          state.mode = 'idb';
          return { status: 'ready', fromIdb: true };
        }
        return migrateLegacySnapshot();
      });
  }

  /** 新仓库还是空的：看看 v2 时代留下的 SQLite 快照能不能迁过来 */
  function migrateLegacySnapshot() {
    return idbStoreExists(LEGACY_STORE).then((has) => {
      if (!has) return null;
      return idbGet(LEGACY_STORE, LEGACY_BYTES_KEY).then((bytes) => {
        if (!bytes) return null;
        state.mode = 'idb';
        let parsed;
        try {
          parsed = parseSqliteDatabase(bytes);
        } catch (e) {
          // 旧快照读不出来：给个空库继续用，但不覆盖旧快照，保留恢复的可能
          return { status: 'ready', legacyError: e && e.message ? e.message : String(e) };
        }
        adoptFromSqlite(parsed);
        return persistAll().then(() => ({
          status: 'ready',
          migrated: true,
          counts: { users: state.users.length, records: state.records.length }
        }));
      });
    });
  }

  function emptyReady() {
    state.mode = global.indexedDB ? 'idb' : 'manual';
    adopt([], []);
    if (state.mode !== 'idb') return { status: 'ready', created: true, degraded: true };
    return persistAll().then(() => ({ status: 'ready', created: true }));
  }

  function manualReady() {
    state.mode = 'manual';
    adopt([], []);
    return { status: 'ready', created: true, degraded: true };
  }

  /* ---------------- 导入 ---------------- */

  function readFileBytes(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new global.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  }

  function decodeUtf8(bytes) {
    try {
      return new global.TextDecoder('utf-8').decode(toU8(bytes));
    } catch (e) {
      return '';
    }
  }

  /* ---------------- 对外接口 ---------------- */

  const EyeDB = {
    /**
     * 页面启动时调用。只有两条路：
     *   IndexedDB 里已有数据 → 读进内存；
     *   IndexedDB 里是空的   → 建新库，或把 v2 的 SQLite 快照迁过来。
     * 返回值永远是 status:'ready'，任何异常都降级成可用状态，不把界面卡死。
     *
     * 可能带上的标记：
     *   created      这次新建了库（首次打开）
     *   migrated     从旧版 SQLite 快照迁移完成，counts 是条数
     *   legacyError  旧快照存在但读不出来
     *   degraded     浏览器没有 IndexedDB，只能存内存里，每次保存会自动下载备份
     */
    boot() {
      if (!global.indexedDB) return Promise.resolve(manualReady());
      return idbOpen()
        .then(() => loadFromIdb())
        .then((res) => res || emptyReady())
        .catch((e) => {
          // IDB 被禁用 / open 被 blocked / 读写失败：降级到内存模式，页面照常能用
          return Object.assign(manualReady(), { error: e && e.message ? e.message : String(e) });
        });
    },

    /** 导入备份文件（新版 JSON 或旧版 SQLite 二进制都行），导入后立刻落盘 */
    loadFromFile(file) { return EyeDB.importFile(file); },

    importFile(file) {
      return readFileBytes(file).then((bytes) => EyeDB.importBytes(bytes, file && file.name));
    },

    importBytes(bytes, fileName) {
      if (!bytes) return Promise.reject(new Error('文件是空的'));
      // 先看魔数：旧版 SQLite 备份
      if (isSqliteFile(bytes)) return EyeDB.importLegacyBytes(bytes, fileName);

      const text = decodeUtf8(bytes).replace(/^\uFEFF/, '').trim();
      if (!text) return Promise.reject(new Error('文件是空的'));
      if (text.charAt(0) !== '{') {
        return Promise.reject(new Error('这个文件既不是 JSON 备份，也不是旧版的 SQLite 备份'));
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return Promise.reject(new Error('JSON 解析失败：' + (e && e.message ? e.message : e)));
      }
      return EyeDB.importData(data, fileName);
    },

    importData(data, fileName) {
      if (!data || typeof data !== 'object') {
        return Promise.reject(new Error('备份文件格式不正确'));
      }
      const users = Array.isArray(data.users) ? data.users : [];
      const records = Array.isArray(data.records) ? data.records : [];
      if (!users.length && !records.length) {
        return Promise.reject(new Error('备份文件里没有可导入的用户或记录'));
      }
      if (data.format && data.format !== FORMAT) {
        return Promise.reject(new Error('这不是本项目的备份文件'));
      }

      adopt(users, records);
      state.mode = global.indexedDB ? 'idb' : 'manual';
      if (state.mode !== 'idb') return Promise.resolve(importResult(false, fileName));
      return persistAll().then((written) => importResult(written, fileName));
    },

    importLegacyBytes(bytes, fileName) {
      let parsed;
      try {
        parsed = parseSqliteDatabase(bytes);
      } catch (e) {
        return Promise.reject(new Error('无法解析旧版 SQLite 备份：' + (e && e.message ? e.message : e)));
      }
      adoptFromSqlite(parsed);
      if (!state.records.length && !state.users.length) {
        return Promise.reject(new Error('这个 SQLite 备份里没有视力记录'));
      }
      state.mode = global.indexedDB ? 'idb' : 'manual';
      if (state.mode !== 'idb') return Promise.resolve(importResult(false, fileName, true));
      return persistAll().then((written) => importResult(written, fileName, true));
    },

    /** 建一个空库并立刻存进 IndexedDB（首次打开时用） */
    loadEmpty() {
      return Promise.resolve(emptyReady());
    },

    getMode() { return state.mode; },
    isAutoSave() { return state.mode === 'idb'; },
    hasPendingExport() { return state.pendingExport; },
    dbFileLabel() {
      if (state.mode === 'idb') return '浏览器本地存储';
      return '内存中（浏览器不能保存）';
    },

    /** 首次说明页看过没。存 IndexedDB 而非 localStorage：file:// 下 localStorage
        是所有本地页面共享的，html 挪到新文件夹时提示就不会再出现，恰好在最该
        出现的场景下失效；IndexedDB 按目录分区，正好对得上。 */
    introShown() {
      if (state.mode !== 'idb') return Promise.resolve(false);   // 内存模式每次都提示
      return idbGet(STORE_META, META_INTRO_KEY)
        .catch(() => null)
        .then((v) => {
          if (v) return true;
          // 兼容 v2：标记当时和 SQLite 快照存在同一个 store 里
          return idbStoreExists(LEGACY_STORE)
            .then((has) => (has ? idbGet(LEGACY_STORE, META_INTRO_KEY) : null))
            .catch(() => null)
            .then((old) => !!old);
        });
    },

    markIntroShown() {
      if (state.mode !== 'idb') return Promise.resolve(false);
      return idbPutKey(STORE_META, 1, META_INTRO_KEY).catch(() => false);
    },

    /* ---------------- 用户 ---------------- */

    /** 全部用户，按创建顺序 */
    listUsers() {
      return state.users.slice().sort((a, b) => a.id - b.id).map(cloneUser);
    },

    /** 系统生成用户ID：80 + yyyyMMddHHmm(12位) + 6位随机 */
    newUserId() {
      const d = new Date();
      const stamp = String(d.getFullYear()) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
        pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
      const rand = pad(Math.floor(Math.random() * 1000000), 6);
      return '80' + stamp + rand;
    },

    getUserByName(name) {
      const u = state.users.find((x) => x.user_name === name);
      return u ? cloneUser(u) : null;
    },

    getUser(userId) {
      const u = state.users.find((x) => x.user_id === userId);
      return u ? cloneUser(u) : null;
    },

    /** 按姓名取用户，没有就用默认配置新建 */
    upsertUserByName(name) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return Promise.reject(new Error('请填写姓名'));
      const found = state.users.find((x) => x.user_name === trimmed);
      if (found) return Promise.resolve(cloneUser(found));

      const now = nowUtc();
      const user = normalizeUser({
        user_id: this.newUserId(),
        user_name: trimmed,
        gmt_created: now,
        gmt_modified: now
      }, state.nextUserId++);
      state.users.push(user);
      return persistUser(user).then(() => cloneUser(user));
    },

    /** 实时保存某一项配置，随后异步落盘 */
    updateConfig(userId, key, value) {
      if (!userId) return Promise.resolve(false);
      if (CONFIG_FIELDS.indexOf(key) < 0) throw new Error('不允许修改的配置项：' + key);
      const user = state.users.find((x) => x.user_id === userId);
      if (!user) return Promise.resolve(false);

      if (key === 'effect_confirm' || key === 'record_require') {
        user[key] = pickEnum(value, CONFIG_LIMITS[key], key === 'effect_confirm' ? 'GAME' : 'BEST');
      } else {
        user[key] = clampInt(value, CONFIG_LIMITS[key][0], CONFIG_LIMITS[key][1], user[key]);
      }
      user.gmt_modified = nowUtc();
      return persistUser(user);
    },

    /* ---------------- 记录 ---------------- */

    /** 取某个用户某一天的记录 */
    getByDate(userId, date) {
      const r = state.records.find((x) => x.user_id === userId && x.record_date === date);
      return r ? cloneRecord(r) : null;
    },

    /** 取某个用户时间范围内的记录，按日期倒序 */
    listRange(userId, from, to) {
      return state.records
        .filter((r) => r.user_id === userId && r.record_date >= from && r.record_date <= to)
        .sort((a, b) => (a.record_date < b.record_date ? 1 : (a.record_date > b.record_date ? -1 : b.id - a.id)))
        .map(cloneRecord);
    },

    /** 删除某个用户某一天的记录，随后立即落盘 */
    delete(userId, date) {
      const i = state.records.findIndex((x) => x.user_id === userId && x.record_date === date);
      if (i < 0) return persist(() => Promise.resolve(true));
      const row = state.records.splice(i, 1)[0];
      return persistRecordDelete(row.id);
    },

    /**
     * 新增或更新某一天的记录，随后立即落盘。
     * 未填的视力字段存 null（不是 0）：折线图会自动跳过空值，
     * 不会在图表上砸出一个跌到 0 的点。
     */
    save(userId, rec) {
      const date = String(rec.record_date);
      const now = nowUtc();
      const i = state.records.findIndex((x) => x.user_id === userId && x.record_date === date);
      let row;
      if (i >= 0) {
        row = Object.assign({}, state.records[i], pickRecordFields(rec), { gmt_modified: now });
        state.records[i] = row;
      } else {
        row = Object.assign({
          id: state.nextRecordId++,
          user_id: userId,
          record_date: date,
          gmt_created: now,
          gmt_modified: now
        }, pickRecordFields(rec));
        state.records.push(row);
      }
      return persistRecord(row);
    },

    /**
     * 训练过程中记一次视力值：行不存在就先建（视力字段为 null，距离带默认值），再写目标字段。
     * mode = 'BEST' 只在更优时覆盖；mode = 'LAST' 直接覆盖。
     */
    recordVision(userId, date, field, value, mode) {
      if (!userId) return Promise.resolve(false);
      if (VISION_FIELDS.indexOf(field) < 0) throw new Error('不认识的视力字段：' + field);
      const now = nowUtc();
      let row = state.records.find((x) => x.user_id === userId && x.record_date === date);
      if (!row) {
        row = normalizeRecord({
          user_id: userId,
          record_date: date,
          test_distance: DEFAULT_TEST_DISTANCE_CM,
          train_distance: DEFAULT_TRAIN_DISTANCE_CM,
          gmt_created: now,
          gmt_modified: now
        }, state.nextRecordId++);
        state.records.push(row);
      }
      if (mode === 'LAST') {
        row[field] = numOrNull(value);
      } else if (row[field] === null || row[field] < value) {
        row[field] = numOrNull(value);
      }
      row.gmt_modified = now;
      // 每答对一次就立刻落盘：训练随时可能被 Esc/关页打断，攒着不写会丢数据
      return persistRecord(row);
    },

    /** 退出训练时的兜底：等排队的写入全部落盘 */
    flushTrainingWrites() {
      return state.writeChain.then(() => state.mode === 'idb' && !state.pendingExport);
    },

    /* ---------------- 导入 / 导出 ---------------- */

    /** 结构化导出：JSON 里带上格式标识和版本号，方便以后升级 */
    exportData() {
      return {
        format: FORMAT,
        version: FORMAT_VERSION,
        app: '视力训练记录台',
        exportedAt: new Date().toISOString(),
        users: state.users.slice().sort((a, b) => a.id - b.id).map(cloneUser),
        records: state.records.slice().sort((a, b) => a.id - b.id).map(cloneRecord)
      };
    },

    exportJSON() {
      return JSON.stringify(this.exportData(), null, 2);
    },

    /**
     * 把数据导出成 JSON 文件下载。
     * 这是数据搬家的唯一途径（换电脑、换浏览器、清缓存前先导出一份），
     * 文件名带日期，多次备份不会互相覆盖。
     */
    exportBlob() {
      const json = this.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'eyerecord-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      state.pendingExport = false;
    },

    /** 米 <-> 厘米 */
    m2cm(m) { return m === null || m === undefined || m === '' ? null : Math.round(m * 100); },
    cm2m(cm) { return cm === null || cm === undefined ? null : (cm / 100).toFixed(2); },

    /* 内部工具，导出给测试 / 调试用 */
    _parseSqlite: parseSqliteDatabase,
    _fields: { USER_FIELDS: USER_FIELDS, RECORD_FIELDS: RECORD_FIELDS, VISION_FIELDS: VISION_FIELDS }
  };

  function importResult(written, fileName, legacy) {
    return {
      status: 'ready',
      imported: true,
      legacy: !!legacy,
      written: !!written,
      fileName: fileName || '',
      counts: { users: state.users.length, records: state.records.length }
    };
  }

  global.EyeDB = EyeDB;
})(typeof window !== 'undefined' ? window : globalThis);
