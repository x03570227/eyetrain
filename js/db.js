/* =============================================================
 * js/db.js — 数据层
 *
 * 浏览器无法直接读写磁盘上的 SQLite 文件，这里的实现方式是：
 *   1. 用 sql.js（SQLite 编译成 WASM）在内存里跑一个真正的 SQLite；
 *   2. 把整个数据库导出成二进制，覆盖写回磁盘上的 eyerecord 文件。
 *
 * 写回磁盘有两条路径：
 *   主路径 fsa    — File System Access API（仅 Chrome / Edge），选中 index.html
 *                   所在目录一次，之后每次改动静默写回；目录句柄存 IndexedDB。
 *   兜底 manual   — 浏览器不支持时用「导入文件 / 下载导出」手动往返。
 * ============================================================= */
(function (global) {
  'use strict';

  const DB_FILE_NAME = 'eyerecord';
  const IDB_NAME = 'eyerecord-app';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'dataDir';

  /* SQLite 不支持 MySQL 风格的内联 COMMENT，字段说明以 -- 注释保留，
     会原样存进 sqlite_master，用 DB Browser / sqlite3 打开时能看到。 */
  const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vision_train_record (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date    TEXT NOT NULL UNIQUE,   -- 记录日期 YYYY-MM-DD，同一天只允许一条记录
    pre_left       REAL,                   -- 训前左眼视力
    pre_right      REAL,                   -- 训前右眼视力
    pre_both       REAL,                   -- 训前双眼视力
    train_left     REAL,                   -- 强化训练左眼视力
    train_right    REAL,                   -- 强化训练右眼视力
    train_both     REAL,                   -- 强化训练双眼视力
    test_distance  INTEGER,                -- 测视距离，单位 cm
    train_distance INTEGER,                -- 强化训练距离，单位 cm
    remark         TEXT,                   -- 备注：训练时长、孩子配合情况、特殊说明
    gmt_created    DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    gmt_modified   DATETIME DEFAULT CURRENT_TIMESTAMP   -- 修改时间
);
`;

  const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS update_vision_train_modtime
AFTER UPDATE ON vision_train_record
FOR EACH ROW
BEGIN
    UPDATE vision_train_record SET gmt_modified = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`;

  const state = {
    SQL: null,
    db: null,
    mode: null,        // 'fsa' | 'manual'
    dirHandle: null,
    fileHandle: null,
    fileName: DB_FILE_NAME,
    pendingExport: false,
    handlePersisted: false   // 目录句柄是否成功存进了 IndexedDB
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

  /* ---------------- IndexedDB：记住用户选过的目录 ---------------- */

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
    });
  }

  function idbGet(key) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })).catch(() => null);
  }

  function idbSet(key, val) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })).catch(() => false);
  }

  /** IDB 迟迟不返回时不能把整个启动流程卡死（否则页面会停在没有遮罩也没有数据的空状态） */
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

  function idbDel(key) {
    return idbOpen().then((db) => new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    })).catch(() => false);
  }

  /* ---------------- 文件系统访问 ---------------- */

  const supportsFsa = () => typeof global.showDirectoryPicker === 'function';

  /** 只查询、不弹授权框。页面刚打开时没有用户手势，只能查询 */
  function hasPermission(handle) {
    const opts = { mode: 'readwrite' };
    if (!handle.queryPermission) return Promise.resolve(true);
    return Promise.resolve(handle.queryPermission(opts)).then((perm) => perm === 'granted');
  }

  /** 查不到授权就申请。必须在用户点击的回调里调用，否则浏览器会拒绝 */
  function ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    if (!handle.queryPermission || !handle.requestPermission) return Promise.resolve(true);
    return hasPermission(handle).then((ok) => {
      if (ok) return true;
      return Promise.resolve(handle.requestPermission(opts)).then((p) => p === 'granted');
    });
  }

  function readIntoDb(fileHandle) {
    return fileHandle.getFile()
      .then((file) => file.arrayBuffer())
      .then((buf) => {
        try {
          state.db = new state.SQL.Database(new Uint8Array(buf));
        } catch (e) {
          throw new Error('eyerecord 文件不是有效的 SQLite 数据库，请换一个目录或删除该文件后重试');
        }
        return ensureSchema();   // true 表示这次新建了表，需要立刻落盘
      });
  }

  function doWrite() {
    if (state.mode !== 'fsa' || !state.fileHandle) {
      state.pendingExport = true;
      return Promise.resolve(false);
    }
    const bytes = state.db.export();
    return state.fileHandle.createWritable()
      .then((w) => w.write(bytes).then(() => w.close()))
      .then(() => { state.pendingExport = false; return true; })
      .catch(() => { state.pendingExport = true; return false; });
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

  function ensureSchema() {
    const exists = queryOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vision_train_record'"
    );
    if (!exists) {
      state.db.run(SCHEMA_SQL);
      state.db.run(TRIGGER_SQL);
      return true;   // 新建了表
    }
    return false;
  }

  /* ---------------- 对外接口 ---------------- */

  const EyeDB = {
    /** 页面启动时调用：尝试恢复上次选过的目录并打开数据库 */
    boot() {
      return loadRuntime().then(() => {
        if (!supportsFsa()) return { status: 'need-init', canPickDir: false, reason: 'no-fsa' };
        return withTimeout(idbGet(IDB_KEY), 3000, null).then((dirHandle) => {
          if (!dirHandle) return { status: 'need-init', canPickDir: true, reason: 'no-handle' };
          state.dirHandle = dirHandle;
          state.handlePersisted = true;
          return hasPermission(dirHandle).then((ok) => {
            // 授权没被记住：不能直接弹窗（没有用户手势），交给页面显示一个「继续」按钮
            if (!ok) return { status: 'need-permission', canPickDir: true, reason: 'permission' };
            return dirHandle.getFileHandle(DB_FILE_NAME, { create: true }).then((fh) => {
              state.mode = 'fsa';
              state.fileHandle = fh;
              return readIntoDb(fh).then((schemaCreated) => {
                // 刚创建的空文件：建完表立刻写回，别让磁盘上留一个 0 字节文件
                const writing = schemaCreated ? writeToDisk() : null;
                return { status: 'ready', created: !!schemaCreated, writing };
              });
            });
          });
        });
      }).catch((e) => {
        // 恢复失败（文件被删、权限被撤、文件损坏）都退回初始化流程
        return { status: 'need-init', canPickDir: supportsFsa(), reason: 'error', error: e && e.message };
      });
    },

    /**
     * 点击「初始化数据库」：弹出目录选择框，建库建表。
     * 记住目录（IndexedDB）和首次落盘都不在这里等 —— 有的浏览器在本地页面上
     * 用不了 IndexedDB，一等就会把整个界面卡住。
     */
    initWithPicker() {
      if (!supportsFsa()) return Promise.reject(new Error('当前浏览器不支持目录授权'));
      // 先弹选择框（必须在用户点击的当口调用），选完再确保 sql.js 运行时就绪
      return global.showDirectoryPicker({ id: IDB_KEY, mode: 'readwrite' })
        .then((dirHandle) => loadRuntime().then(() => dirHandle))
        .then((dirHandle) => dirHandle.getFileHandle(DB_FILE_NAME, { create: true })
          .then((fileHandle) => {
            state.dirHandle = dirHandle;
            state.fileHandle = fileHandle;
            state.mode = 'fsa';
            return readIntoDb(fileHandle);
          }))
        .then((schemaCreated) => this._finishOpen(schemaCreated));
    },

    /** 用已经记住的目录重新取得授权并打开数据库（必须在用户点击里调用） */
    reconnect() {
      const handle = state.dirHandle;
      if (!handle) return Promise.reject(new Error('没有记住的目录'));
      return loadRuntime()
        .then(() => ensurePermission(handle))
        .then((ok) => {
          if (!ok) throw new Error('浏览器没有授权访问该目录，请重新选择一次');
          return handle.getFileHandle(DB_FILE_NAME, { create: true });
        })
        .then((fh) => {
          state.fileHandle = fh;
          state.mode = 'fsa';
          return readIntoDb(fh);
        })
        .then((schemaCreated) => this._finishOpen(schemaCreated));
    },

    _finishOpen(schemaCreated) {
      // 后台记住目录，成不成功都不影响这次使用
      idbSet(IDB_KEY, state.dirHandle).then((ok) => { state.handlePersisted = !!ok; });
      const writing = writeToDisk();
      return { status: 'ready', created: !!schemaCreated, writing };
    },

    /** 当前连接的目录名，显示在顶栏 */
    dirName() { return state.dirHandle ? state.dirHandle.name : ''; },

    /** 兜底：手动打开一个已有的 eyerecord 文件 */
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
          state.mode = 'manual';
          state.fileName = file.name || DB_FILE_NAME;
          return { status: 'ready', created: false };
        });
    },

    /** 兜底：内存里先建一个空库，之后导出成文件 */
    loadEmpty() {
      return loadRuntime().then(() => {
        state.db = new state.SQL.Database();
        ensureSchema();
        state.mode = 'manual';
        state.fileName = DB_FILE_NAME;
        return { status: 'ready', created: true };
      });
    },

    /** 忘记之前选过的目录，回到初始化流程 */
    forgetDir() {
      state.mode = null;
      state.dirHandle = null;
      state.fileHandle = null;
      state.db = null;
      state.handlePersisted = false;
      state.writeChain = null;
      return idbDel(IDB_KEY);
    },

    isAutoSave() { return state.mode === 'fsa'; },
    /** 目录句柄有没有被浏览器记住（没记住的话下次打开要重新选一次目录） */
    isHandleRemembered() { return state.handlePersisted; },
    hasPendingExport() { return state.pendingExport; },
    dbFileLabel() { return state.mode === 'fsa' ? DB_FILE_NAME : (state.fileName + '（内存中）'); },

    /** 取某一天的记录 */
    getByDate(date) {
      return queryOne('SELECT * FROM vision_train_record WHERE record_date = ?', [date]);
    },

    /** 取时间范围内的记录，按日期倒序 */
    listRange(from, to) {
      return queryAll(
        'SELECT * FROM vision_train_record WHERE record_date BETWEEN ? AND ? ORDER BY record_date DESC',
        [from, to]
      );
    },

    /** 删除某一天的记录，随后立即落盘 */
    delete(date) {
      state.db.run('DELETE FROM vision_train_record WHERE record_date = ?', [date]);
      return writeToDisk();
    },

    /** 新增或更新某一天的记录，随后立即落盘 */
    save(rec) {
      const d = rec.record_date;
      // sql.js 的 bind() 遇到 undefined 会直接抛错，统一转成 NULL
      const nullable = (v) => (v === undefined ? null : v);
      const values = [
        rec.pre_left, rec.pre_right, rec.pre_both,
        rec.train_left, rec.train_right, rec.train_both,
        rec.test_distance, rec.train_distance,
        rec.remark
      ].map(nullable);
      if (queryOne('SELECT id FROM vision_train_record WHERE record_date = ?', [d])) {
        state.db.run(
          `UPDATE vision_train_record SET
             pre_left = ?, pre_right = ?, pre_both = ?,
             train_left = ?, train_right = ?, train_both = ?,
             test_distance = ?, train_distance = ?, remark = ?
           WHERE record_date = ?`,
          values.concat([d])
        );
      } else {
        state.db.run(
          `INSERT INTO vision_train_record
             (record_date, pre_left, pre_right, pre_both,
              train_left, train_right, train_both,
              test_distance, train_distance, remark)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [d].concat(values)
        );
      }
      return writeToDisk();
    },

    /** 兜底模式下把数据库导出成文件下载 */
    exportBlob() {
      const bytes = state.db.export();
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = DB_FILE_NAME;
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
