/* =============================================================
 * js/db.js — 数据层
 *
 * 实现方式：
 *   1. 用 sql.js（SQLite 编译成 WASM）在内存里跑一个真正的 SQLite；
 *   2. 把整个数据库导出成二进制快照，存进浏览器 IndexedDB。
 *
 * 为什么不再用 File System Access API（选目录、写回 eyerecord 文件）：
 *   file:// 协议下页面的源是 null（不透明源），FSA / OPFS 会被浏览器硬性禁用
 *   （调用直接抛 SecurityError），双击打开 html 时根本用不了。而 IndexedDB 在
 *   file:// 下可用，Chrome 按 html 文件所在的目录做分区存储（同目录共享一份，
 *   换目录就是另一份）。所以自动保存只保留 IndexedDB 这一条路径。
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

  const DB_FILE_NAME = 'eyerecord';
  const IDB_NAME = 'eyerecord-app';
  /* 版本号保持 2 不再升：去掉目录句柄后没有结构性变更，升版反而会在别的标签页
     占着旧版本时触发 onblocked，直接退化成内存模式。旧库里残留的 'handles'
     store 只是无害死数据，不读不写即可。 */
  const IDB_VERSION = 2;
  const IDB_STORE = 'db';
  const IDB_BYTES_KEY = 'bytes';   // 整个数据库的二进制快照
  const IDB_INTRO_KEY = 'intro';   // 首次说明页是否看过（与快照分开存，导入备份不会把它冲掉）

  /* SQLite 不支持 MySQL 风格的内联 COMMENT，字段说明以 -- 注释保留，
     会原样存进 sqlite_master，用 DB Browser / sqlite3 打开时能看到。 */
  const SCHEMA_USER_SQL = `
CREATE TABLE IF NOT EXISTS user_config (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL UNIQUE,   -- 用户ID，80 开头 + yyyyMMddHHmm + 6 位随机
    user_name         TEXT NOT NULL,          -- 用户姓名
    effect_confirm    TEXT NOT NULL DEFAULT 'GAME' CHECK (effect_confirm IN ('GAME','COLOR')),  -- 确认效果：GAME 游戏 / COLOR 闪色
    enhance_count     INTEGER NOT NULL DEFAULT 4,   -- 强化次数：答对几次算通过当前档
    record_require    TEXT NOT NULL DEFAULT 'BEST' CHECK (record_require IN ('BEST','LAST')),   -- 记录时机：BEST 取最好 / LAST 取最后一次
    chart_calibration INTEGER NOT NULL DEFAULT 100, -- 图表校准：实测校准条的毫米数，默认 100
    max_display_count INTEGER NOT NULL DEFAULT 1,   -- 最多展示个数：0-8，0 表示一行能放几个就放几个
    gmt_created       DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    gmt_modified      DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 修改时间
    remark            TEXT                                 -- 备注
);
`;

  /* 唯一约束是 UNIQUE(user_id, record_date) —— 多用户下同一天各存一条。
     旧版本的 UNIQUE(record_date) 会让两个用户无法在同一天记录，必须重建表。 */
  const SCHEMA_RECORD_SQL = `
CREATE TABLE IF NOT EXISTS vision_train_record (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        TEXT NOT NULL,          -- 关联用户ID
    record_date    TEXT NOT NULL,          -- 记录日期 YYYY-MM-DD
    pre_left       REAL,                   -- 训前左眼视力
    pre_right      REAL,                   -- 训前右眼视力
    pre_both       REAL,                   -- 训前双眼视力
    train_left     REAL,                   -- 强化训练左眼视力
    train_right    REAL,                   -- 强化训练右眼视力
    train_both     REAL,                   -- 强化训练双眼视力
    second_left    REAL,                   -- 秒视左眼视力
    second_right   REAL,                   -- 秒视右眼视力
    second_both    REAL,                   -- 秒视双眼视力
    test_distance  INTEGER,                -- 测视距离，单位 cm
    train_distance INTEGER,                -- 强化训练距离，单位 cm
    remark         TEXT,                   -- 备注：训练时长、孩子配合情况、特殊说明
    gmt_created    DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    gmt_modified   DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 修改时间
    UNIQUE(user_id, record_date)
);
`;

  const TRIGGER_USER_SQL = `
CREATE TRIGGER IF NOT EXISTS update_user_config_modtime
AFTER UPDATE ON user_config
FOR EACH ROW
BEGIN
    UPDATE user_config SET gmt_modified = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`;

  const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS update_vision_train_modtime
AFTER UPDATE ON vision_train_record
FOR EACH ROW
BEGIN
    UPDATE vision_train_record SET gmt_modified = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`;

  /* 升级旧库时要补上的列：旧表没有用户和秒视字段。
     ADD COLUMN 只能加可空列（带 NOT NULL 必须给默认值），
     所以 user_id 这里先建成可空，随后重建表时才收紧为 NOT NULL。 */
  const ADDED_COLUMNS = [
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'second_left', ddl: 'REAL' },
    { name: 'second_right', ddl: 'REAL' },
    { name: 'second_both', ddl: 'REAL' }
  ];

  /* 训练自动建行时带上的默认测量距离（手动记录页的默认值与之保持一致） */
  const DEFAULT_TEST_DISTANCE_CM = 500;    // 测视距离 5 米
  const DEFAULT_TRAIN_DISTANCE_CM = 900;   // 强化训练距离 9 米

  const LEGACY_USER_ID = '80legacy000001';
  const LEGACY_USER_NAME = '历史记录（未归属）';

  /* recordVision 的字段名由外部传入并拼进 SQL，必须白名单校验 */
  const VISION_FIELDS = [
    'pre_left', 'pre_right', 'pre_both',
    'train_left', 'train_right', 'train_both',
    'second_left', 'second_right', 'second_both'
  ];

  /* 用户配置里允许外部按 key 更新的列，同样是白名单 */
  const CONFIG_FIELDS = [
    'effect_confirm', 'enhance_count', 'record_require',
    'chart_calibration', 'max_display_count'
  ];

  const state = {
    SQL: null,
    db: null,
    mode: null,        // 'idb' | 'manual'
    fileName: DB_FILE_NAME,
    pendingExport: false,
  };

  /* ---------------- 底层工具 ---------------- */

  function decodeWasm() {
    const b64 = global.SQL_WASM_BASE64;
    if (!b64) throw new Error('缺少 vendor/sql-wasm-binary.js');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function loadRuntime() {
    if (state.SQL) return Promise.resolve(state.SQL);
    if (!global.initSqlJs) return Promise.reject(new Error('缺少 vendor/sql-wasm.js'));
    return global.initSqlJs({ wasmBinary: decodeWasm() }).then((SQL) => {
      state.SQL = SQL;
      return SQL;
    });
  }

  function queryAll(sql, params) {
    const stmt = state.db.prepare(sql);
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function queryOne(sql, params) {
    return queryAll(sql, params)[0] || null;
  }

  /* ---------------- IndexedDB：唯一的自动保存位置 ---------------- */

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      let req;
      try { req = indexedDB.open(IDB_NAME, IDB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      // 别的标签页占着旧版本时会卡在这里，不能干等，直接让上层降级
      req.onblocked = () => reject(new Error('idb blocked'));
    });
  }

  /** 读出上次的整个数据库字节快照 */
  function idbGetBytes() {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      let req;
      try { req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_BYTES_KEY); }
      catch (e) { return reject(e); }
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    })).catch(() => null);
  }

  /** 把整个数据库字节写回 IndexedDB，等价于「自动保存」 */
  function idbSetBytes(bytes) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, IDB_BYTES_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    }));
  }

  /**
   * 读写与快照无关的小标记（目前只有「首次说明页看过没」）。
   * 刻意和快照分开存：导入备份只覆盖 bytes，标记不受影响。
   */
  function idbGetFlag(key) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })).catch(() => null);
  }

  function idbSetFlag(key, val) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })).catch(() => false);
  }

  /** IDB 迟迟不返回时不能把整个启动流程卡死（否则页面会停在没有数据也没有提示的空状态） */
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      promise.then(done).catch(() => done(fallback));
    });
  }

  function doWrite() {
    if (state.mode === 'idb') {
      let bytes;
      try {
        bytes = state.db.export();     // 库已关闭/损坏时会抛
      } catch (e) {
        state.pendingExport = true;
        return Promise.resolve(false);
      }
      return idbSetBytes(bytes)
        .then(() => { state.pendingExport = false; return true; })
        .catch(() => { state.pendingExport = true; return false; });
    }
    // 纯内存：无法自动落盘，等用户手动导出
    state.pendingExport = true;
    return Promise.resolve(false);
  }

  /**
   * 把内存里的数据库整体覆盖写回 eyerecord。
   * 写入排成一条队（避免两次写入抢同一个文件），失败只做标记不抛错，
   * 这样即使磁盘写入出问题，界面也不会卡死。
   */
  function writeToDisk() {
    state.writeChain = (state.writeChain || Promise.resolve()).then(doWrite);
    return state.writeChain;
  }

  function tableExists(name) {
    return !!queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  }

  function columnNames(table) {
    return queryAll('PRAGMA table_info(' + table + ')').map((r) => r.name);
  }

  /** 每张唯一索引覆盖的列名集合，用来判断旧表是不是只按日期唯一 */
  function uniqueIndexColumns(table) {
    return queryAll('PRAGMA index_list(' + table + ')')
      .filter((idx) => idx.unique === 1)
      .map((idx) => queryAll('PRAGMA index_info(' + idx.name + ')')
        .map((c) => c.name).sort().join(','));
  }

  /** 缺哪个列就补哪个，返回是否有过改动 */
  function addMissingColumns() {
    const have = columnNames('vision_train_record');
    let changed = false;
    ADDED_COLUMNS.forEach((c) => {
      if (have.indexOf(c.name) < 0) {
        state.db.run('ALTER TABLE vision_train_record ADD COLUMN ' + c.name + ' ' + c.ddl);
        changed = true;
      }
    });
    return changed;
  }

  /**
   * 旧表的唯一约束是 UNIQUE(record_date)，多用户下第二个人在同一天根本插不进去。
   * CREATE TABLE IF NOT EXISTS 不会改动既有索引，只能整表重建：
   *   建新表 -> 拷数据 -> 删旧表 -> 改名 -> 重建触发器
   */
  function rebuildRecordTable() {
    const orphans = queryOne(
      'SELECT COUNT(*) AS n FROM vision_train_record WHERE user_id IS NULL'
    ).n;

    // 新表 user_id 是 NOT NULL，无主行必须先挂到一个用户上，否则拷贝会失败
    if (orphans > 0) {
      const legacy = queryOne('SELECT id FROM user_config WHERE user_id = ?', [LEGACY_USER_ID]);
      if (!legacy) {
        state.db.run(
          'INSERT INTO user_config (user_id, user_name, remark) VALUES (?, ?, ?)',
          [LEGACY_USER_ID, LEGACY_USER_NAME, '升级多用户版本之前已有的旧记录']
        );
      }
      state.db.run(
        'UPDATE vision_train_record SET user_id = ? WHERE user_id IS NULL',
        [LEGACY_USER_ID]
      );
    }

    state.db.run('BEGIN');
    state.db.run(SCHEMA_RECORD_SQL.replace('vision_train_record', 'vision_train_record__new'));
    state.db.run(
      'INSERT INTO vision_train_record__new ' +
      '(id, user_id, record_date, pre_left, pre_right, pre_both, ' +
      ' train_left, train_right, train_both, ' +
      ' second_left, second_right, second_both, ' +
      ' test_distance, train_distance, remark, gmt_created, gmt_modified) ' +
      'SELECT id, user_id, record_date, pre_left, pre_right, pre_both, ' +
      ' train_left, train_right, train_both, ' +
      ' second_left, second_right, second_both, ' +
      ' test_distance, train_distance, remark, gmt_created, gmt_modified ' +
      'FROM vision_train_record'
    );
    state.db.run('DROP TABLE vision_train_record');   // 会连带删掉挂在它上面的触发器
    state.db.run('ALTER TABLE vision_train_record__new RENAME TO vision_train_record');
    state.db.run(TRIGGER_SQL);
    state.db.run('COMMIT');
  }

  /** 建表 + 升级旧库。返回 true 表示结构有变动，需要立刻落盘 */
  function ensureSchema() {
    let changed = false;

    if (!tableExists('user_config')) {
      state.db.run(SCHEMA_USER_SQL);
      state.db.run(TRIGGER_USER_SQL);
      changed = true;
    }

    if (!tableExists('vision_train_record')) {
      state.db.run(SCHEMA_RECORD_SQL);
      state.db.run(TRIGGER_SQL);
      return true;
    }

    if (addMissingColumns()) changed = true;

    // 只按日期唯一 = 旧结构，必须重建才能支持多用户
    if (uniqueIndexColumns('vision_train_record').indexOf('record_date') >= 0) {
      rebuildRecordTable();
      changed = true;
    }

    return changed;
  }

  /* ---------------- 对外接口 ---------------- */

  const EyeDB = {
    /**
     * 页面启动时调用。
     *
     * 只有两条路：IndexedDB 里有快照就读出来，没有就建一个空库并立刻存进去。
     * 返回值永远是 status:'ready' —— 去掉「选目录」那套之后，已经没有任何
     * 「需要用户先做点什么才能用」的状态了，卡在遮罩上只会让界面死掉。
     *
     * 可能带上的标记：
     *   created   这次新建了库（首次打开）
     *   corrupt   快照读出来是坏的，已用空库顶上（不会自动写回，否则唯一副本没了）
     *   degraded  浏览器没有 IndexedDB，只能存内存里，每次保存会自动下载备份
     */
    boot() {
      return loadRuntime()
        .then(() => {
          if (!global.indexedDB) return null;   // 没有 IndexedDB，走空库 + 内存模式
          return withTimeout(idbGetBytes(), 3000, null);
        })
        .then((bytes) => {
          if (bytes) {
            try {
              state.db = new state.SQL.Database(new Uint8Array(bytes));
            } catch (e) {
              // 快照坏了：先用空库顶上，但绝不自动写回 —— 一写就把唯一的副本抹掉了
              state.db = new state.SQL.Database();
              ensureSchema();
              state.mode = 'idb';
              return { status: 'ready', corrupt: true };
            }
            ensureSchema();
            state.mode = 'idb';
            return { status: 'ready', fromIdb: true };
          }
          return this.loadEmpty().then(() => ({
            status: 'ready', created: true, degraded: state.mode === 'manual'
          }));
        })
        .catch((e) => {
          // sql.js 本身没起来（缺文件 / WASM 解不开）：没法兜底，如实抛出去
          if (!state.SQL) return Promise.reject(e);
          // 其余（IDB 被禁用、open 被 blocked 等）：至少给个能用的空库，别白屏
          state.db = new state.SQL.Database();
          ensureSchema();
          state.mode = global.indexedDB ? 'idb' : 'manual';
          return { status: 'ready', degraded: true, error: e && e.message };
        });
    },

    /** 手动打开一个备份出来的 eyerecord 文件（之后照样自动存进 IndexedDB） */
    loadFromFile(file) {
      return loadRuntime()
        .then(() => file.arrayBuffer())
        .then((buf) => {
          try {
            state.db = new state.SQL.Database(new Uint8Array(buf));
          } catch (e) {
            throw new Error('这个文件不是有效的 SQLite 数据库');
          }
          ensureSchema();
          state.mode = global.indexedDB ? 'idb' : 'manual';
          state.fileName = file.name || DB_FILE_NAME;
          return { status: 'ready', created: false };
        })
        .then((res) => writeToDisk().then(() => res));
    },

    /** 建一个空库并立刻存进 IndexedDB（首次打开时用） */
    loadEmpty() {
      return loadRuntime().then(() => {
        state.db = new state.SQL.Database();
        ensureSchema();
        state.mode = global.indexedDB ? 'idb' : 'manual';
        state.fileName = DB_FILE_NAME;
      }).then(() => writeToDisk())
        .then(() => ({ status: 'ready', created: true }));
    },

    getMode() { return state.mode; },
    isAutoSave() { return state.mode === 'idb'; },
    hasPendingExport() { return state.pendingExport; },
    dbFileLabel() {
      if (state.mode === 'idb') return '浏览器本地存储';
      return state.fileName + '（内存中）';
    },

    /** 首次说明页看过没。存 IndexedDB 而非 localStorage：file:// 下 localStorage
        是所有本地页面共享的，html 挪到新文件夹时提示就不会再出现，恰好在最该
        出现的场景下失效；IndexedDB 按目录分区，正好对得上。 */
    introShown() {
      if (state.mode !== 'idb') return Promise.resolve(false);   // 内存模式每次都提示
      return idbGetFlag(IDB_INTRO_KEY).then((v) => !!v);
    },

    markIntroShown() {
      if (state.mode !== 'idb') return Promise.resolve(false);
      return idbSetFlag(IDB_INTRO_KEY, 1);
    },

    /* ---------------- 用户 ---------------- */

    /** 全部用户，按创建顺序 */
    listUsers() {
      return queryAll('SELECT * FROM user_config ORDER BY id');
    },

    /** 系统生成用户ID：80 + yyyyMMddHHmm(12位) + 6位随机 */
    newUserId() {
      const p = (n, w) => String(n).padStart(w, '0');
      const d = new Date();
      const stamp = String(d.getFullYear()) + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) +
        p(d.getHours(), 2) + p(d.getMinutes(), 2);
      const rand = p(Math.floor(Math.random() * 1000000), 6);
      return '80' + stamp + rand;
    },

    getUserByName(name) {
      return queryOne('SELECT * FROM user_config WHERE user_name = ?', [name]);
    },

    getUser(userId) {
      return queryOne('SELECT * FROM user_config WHERE user_id = ?', [userId]);
    },

    /** 按姓名取用户，没有就用默认配置新建（配置默认值全部交给建表语句） */
    upsertUserByName(name) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return Promise.reject(new Error('请填写姓名'));
      const found = this.getUserByName(trimmed);
      if (found) return Promise.resolve(found);
      const userId = this.newUserId();
      state.db.run(
        'INSERT INTO user_config (user_id, user_name) VALUES (?, ?)',
        [userId, trimmed]
      );
      writeToDisk();
      return Promise.resolve(this.getUser(userId));
    },

    /** 实时保存某一项配置，随后防抖落盘 */
    updateConfig(userId, key, value) {
      if (!userId) return Promise.resolve(false);
      if (CONFIG_FIELDS.indexOf(key) < 0) throw new Error('不允许修改的配置项：' + key);
      state.db.run(
        'UPDATE user_config SET ' + key + ' = ? WHERE user_id = ?',
        [value, userId]
      );
      return writeToDisk();
    },

    /* ---------------- 记录 ---------------- */

    /** 取某个用户某一天的记录 */
    getByDate(userId, date) {
      return queryOne(
        'SELECT * FROM vision_train_record WHERE user_id = ? AND record_date = ?',
        [userId, date]
      );
    },

    /** 取某个用户时间范围内的记录，按日期倒序 */
    listRange(userId, from, to) {
      return queryAll(
        'SELECT * FROM vision_train_record ' +
        'WHERE user_id = ? AND record_date BETWEEN ? AND ? ORDER BY record_date DESC',
        [userId, from, to]
      );
    },

    /** 删除某个用户某一天的记录，随后立即落盘 */
    delete(userId, date) {
      state.db.run(
        'DELETE FROM vision_train_record WHERE user_id = ? AND record_date = ?',
        [userId, date]
      );
      return writeToDisk();
    },

    /**
     * 新增或更新某一天的记录，随后立即落盘。
     * 建行时 9 个视力字段留 NULL（不是 0）：折线图会自动跳过空值，
     * 不会在图表上砸出一个跌到 0 的点。
     */
    save(userId, rec) {
      const d = rec.record_date;
      // sql.js 的 bind() 遇到 undefined 会直接抛错，统一转成 NULL
      const nullable = (v) => (v === undefined ? null : v);
      const values = [
        rec.pre_left, rec.pre_right, rec.pre_both,
        rec.train_left, rec.train_right, rec.train_both,
        rec.second_left, rec.second_right, rec.second_both,
        rec.test_distance, rec.train_distance,
        rec.remark
      ].map(nullable);
      if (this.getByDate(userId, d)) {
        state.db.run(
          `UPDATE vision_train_record SET
             pre_left = ?, pre_right = ?, pre_both = ?,
             train_left = ?, train_right = ?, train_both = ?,
             second_left = ?, second_right = ?, second_both = ?,
             test_distance = ?, train_distance = ?, remark = ?
           WHERE user_id = ? AND record_date = ?`,
          values.concat([userId, d])
        );
      } else {
        state.db.run(
          `INSERT INTO vision_train_record
             (user_id, record_date, pre_left, pre_right, pre_both,
              train_left, train_right, train_both,
              second_left, second_right, second_both,
              test_distance, train_distance, remark)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [userId, d].concat(values)
        );
      }
      return writeToDisk();
    },

    /**
     * 训练过程中记一次视力值：行不存在就先建（视力字段为 NULL，距离带默认值），再写目标字段。
     * mode = 'BEST' 只在更优时覆盖；mode = 'LAST' 直接覆盖。
     */
    recordVision(userId, date, field, value, mode) {
      if (!userId) return Promise.resolve(false);
      if (VISION_FIELDS.indexOf(field) < 0) throw new Error('不认识的视力字段：' + field);
      state.db.run(
        'INSERT OR IGNORE INTO vision_train_record ' +
        '(user_id, record_date, test_distance, train_distance) VALUES (?, ?, ?, ?)',
        [userId, date, DEFAULT_TEST_DISTANCE_CM, DEFAULT_TRAIN_DISTANCE_CM]
      );
      if (mode === 'LAST') {
        state.db.run(
          'UPDATE vision_train_record SET ' + field + ' = ? WHERE user_id = ? AND record_date = ?',
          [value, userId, date]
        );
      } else {
        // 旧值是 NULL 时视为无条件可更新
        state.db.run(
          'UPDATE vision_train_record SET ' + field + ' = ' +
          'CASE WHEN ' + field + ' IS NULL OR ' + field + ' < ? THEN ? ELSE ' + field + ' END ' +
          'WHERE user_id = ? AND record_date = ?',
          [value, value, userId, date]
        );
      }
      // 每答对一次就立刻落盘：训练随时可能被 Esc/关页打断，攒着不写会丢数据
      return writeToDisk();
    },

    /** 退出训练时的兜底强刷（平时每次作答已经即时落盘，这里只多导出一次） */
    flushTrainingWrites() {
      return writeToDisk();
    },

    /** 当前数据库的完整字节快照（写盘/导出都用它） */
    exportBytes() {
      return state.db.export();
    },

    /**
     * 把数据库导出成文件下载。
     * 这是数据搬家的唯一途径（换电脑、换浏览器、清缓存前先导出一份），
     * 文件名带日期，多次备份不会互相覆盖。
     */
    exportBlob() {
      const bytes = this.exportBytes();
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = DB_FILE_NAME + '-' + new Date().toISOString().slice(0, 10);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      state.pendingExport = false;
    },

    /** 米 <-> 厘米 */
    m2cm(m) { return m === null || m === undefined || m === '' ? null : Math.round(m * 100); },
    cm2m(cm) { return cm === null || cm === undefined ? null : (cm / 100).toFixed(2); }
  };

  global.EyeDB = EyeDB;
})(window);
