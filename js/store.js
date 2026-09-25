/* 本地存储 —— 查询缓存 / 历史记录 / 设置
 * localStorage 在隐私模式下可能抛异常，这里统一降级到内存，保证功能不崩。
 */
(function (global) {
  'use strict';

  const K = {
    cache:    'ps:cache',
    history:  'ps:history',
    settings: 'ps:settings',
    tags:     'ps:tags',
    inventory:'ps:inventory'   // 用户自己导入的试剂位置表
  };

  const HISTORY_MAX = 100;   // 需求：本地保存最近 100 条

  // localStorage 不可用时的兜底
  const mem = {};
  let lsOK = true;
  try {
    const t = '__ps_probe__';
    global.localStorage.setItem(t, '1');
    global.localStorage.removeItem(t);
  } catch (e) { lsOK = false; }

  function read(key, dflt) {
    try {
      const raw = lsOK ? global.localStorage.getItem(key) : mem[key];
      return raw ? JSON.parse(raw) : dflt;
    } catch (e) { return dflt; }
  }

  function write(key, val, noEvict) {
    const raw = JSON.stringify(val);
    try {
      if (lsOK) global.localStorage.setItem(key, raw);
      else mem[key] = raw;
      return true;
    } catch (e) {
      // 配额超限：清掉缓存再试一次。
      // 用户导入的试剂表走 noEvict —— 那张表体积大，写不进去时顺手清掉他的
      // 查询缓存是拿一个损失换另一个损失，不如让它老老实实失败，由导入界面报错
      try {
        if (lsOK && key !== K.cache && !noEvict) {
          global.localStorage.removeItem(K.cache);
          global.localStorage.setItem(key, raw);
          return true;
        }
      } catch (e2) { /* 仍然失败就放弃 */ }
      return false;
    }
  }

  /* ── 查询缓存：按名称与 CAS 双索引 ───────────────────── */
  const normKey = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function cacheGet(query) {
    const c = read(K.cache, {});
    return c[normKey(query)] || null;
  }

  /** 存入时同时写名称键和 CAS 键，下次输哪个都能命中 */
  function cachePut(entry) {
    if (!entry || !entry.mw) return;
    const c = read(K.cache, {});
    const rec = {
      name: entry.name || '',
      formula: entry.formula || '',
      cas: entry.cas || '',
      mw: Number(entry.mw),
      source: entry.source || '',
      ts: Date.now()
    };
    if (entry.name) c[normKey(entry.name)] = rec;
    if (entry.cas)  c[normKey(entry.cas)]  = rec;
    if (entry.query) c[normKey(entry.query)] = rec;
    write(K.cache, c);
  }

  function cacheList() {
    const c = read(K.cache, {});
    // 去重（同一记录被名称和 CAS 各索引了一份）
    const seen = new Set(), out = [];
    Object.keys(c).forEach(k => {
      const r = c[k];
      const sig = r.cas || r.name || k;
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push(Object.assign({ key: k }, r));
    });
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  function cacheDel(key) {
    const c = read(K.cache, {});
    const target = c[key];
    // 连同它的另一个索引一起删掉
    Object.keys(c).forEach(k => {
      if (k === key) return;
      const r = c[k];
      if (target && ((r.cas && r.cas === target.cas) || (r.name && r.name === target.name))) delete c[k];
    });
    delete c[key];
    write(K.cache, c);
  }

  function cacheClear() { write(K.cache, {}); }

  /* ── 用户导入的试剂位置表 ──────────────────────────────
   * 存的是用户自己表格里的原始行（中文字段名），形状的整理交给 inventory.js。
   * 写失败时不清缓存（见 write 的 noEvict）—— 调用方要检查返回值并报错。 */
  /* 1 MB。够放约 5000 条试剂（实验室那张 172 条的表只有 34 KB），
     再往上是拿别人的配额冒险 —— localStorage 一共就 5 MB 左右，
     塞满了会让历史记录和缓存悄悄写不进去 */
  const INV_MAX = 1024 * 1024;

  function inventoryGet() {
    const rows = read(K.inventory, []);
    return Array.isArray(rows) ? rows : [];
  }

  /** 返回 true 表示存进去了；false 时调用方必须告诉用户，不能静默吞掉 */
  function inventorySet(rows) {
    if (!Array.isArray(rows)) return false;
    if (JSON.stringify(rows).length > INV_MAX) return false;
    return write(K.inventory, rows, true);
  }

  function inventoryClear() { write(K.inventory, [], true); }

  /* ── 历史记录 ────────────────────────────────────────── */
  function historyList() { return read(K.history, []); }

  function historyAdd(rec) {
    const h = historyList();
    rec.id = rec.id || ('h' + Date.now() + Math.random().toString(36).slice(2, 7));
    rec.ts = rec.ts || Date.now();
    h.unshift(rec);
    // 溢出时先淘汰最旧的非收藏项
    if (h.length > HISTORY_MAX) {
      for (let i = h.length - 1; i >= 0 && h.length > HISTORY_MAX; i--) {
        if (!h[i].favorite) h.splice(i, 1);
      }
    }
    write(K.history, h);
    return rec;
  }

  function historyUpdate(id, patch) {
    const h = historyList();
    const i = h.findIndex(x => x.id === id);
    if (i < 0) return null;
    h[i] = Object.assign({}, h[i], patch);
    write(K.history, h);
    return h[i];
  }

  function historyDel(id) {
    const h = historyList().filter(x => x.id !== id);
    write(K.history, h);
  }

  /** 无参 = 全清；传数组 = 只留下这些（清空历史时把收藏的、带标签的传进来） */
  function historyClear(keep) { write(K.history, keep || []); }

  /* ── 小标签 ──────────────────────────────────────────────
   * 历史记录可以打多个标签（h.tags 存 id 数组）。
   * 标签单独存一份而不是直接存名字：改名时不用回头遍历所有历史记录。 */
  const TAG_NAME_MAX = 12;

  function tagsList() {
    return read(K.tags, []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  /** 新建标签；同名（忽略大小写与空格）已有就返回那一个，不重复建 */
  function tagAdd(name) {
    const n = String(name || '').trim().slice(0, TAG_NAME_MAX);
    if (!n) return null;
    const list = read(K.tags, []);
    const key = n.toLowerCase();
    const dup = list.find(t => t.name.toLowerCase() === key);
    if (dup) return dup;
    const tag = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                  name: n, ts: Date.now() };
    list.push(tag);
    write(K.tags, list);
    return tag;
  }

  function tagRename(id, name) {
    const n = String(name || '').trim().slice(0, TAG_NAME_MAX);
    if (!n) return null;
    const list = read(K.tags, []);
    const t = list.find(x => x.id === id);
    if (!t) return null;
    t.name = n;
    write(K.tags, list);
    return t;
  }

  /** 删标签，同时把它从所有历史记录上摘掉，不留悬空 id */
  function tagDel(id) {
    write(K.tags, read(K.tags, []).filter(t => t.id !== id));
    const h = historyList();
    let touched = false;
    h.forEach(item => {
      if (item.tags && item.tags.indexOf(id) >= 0) {
        item.tags = item.tags.filter(x => x !== id);
        touched = true;
      }
    });
    if (touched) write(K.history, h);
  }

  /** 每个标签被多少条历史用到 —— 侧栏要显示计数 */
  function tagCounts() {
    const c = {};
    historyList().forEach(h => (h.tags || []).forEach(id => { c[id] = (c[id] || 0) + 1; }));
    return c;
  }

  /** 给历史记录增删标签 */
  function historyTag(id, tagId, on) {
    const h = historyList();
    const i = h.findIndex(x => x.id === id);
    if (i < 0) return null;
    const cur = h[i].tags || [];
    h[i].tags = on ? (cur.indexOf(tagId) >= 0 ? cur : cur.concat([tagId]))
                   : cur.filter(x => x !== tagId);
    write(K.history, h);
    return h[i];
  }

  /* ── 设置 ────────────────────────────────────────────── */
  const DEFAULT_SETTINGS = {
    theme: 'auto',        // auto | light | dark
    sigFigs: 3,           // 浓度/体积有效数字
    defVol: 50,
    defVolUnit: 'mL',
    defConc: 1,
    defConcUnit: 'M',
    onlineQuery: true,    // 联网查询总开关
    casApiKey: '',        // CAS Common Chemistry 可选 key（历史遗留，查询链没在用）
    /* 中文名识别 —— 可选，默认关闭。开了才用，而且必须自己填 key。
       AI 只负责把中文名认成英文名/CAS，分子量仍然去 PubChem 查 */
    llmOn: false,
    llmProvider: 'siliconflow',
    llmKey: '',
    llmUrl: '',           // 只有「自定义」服务商才需要填
    llmModel: ''          // 留空 = 用服务商预设的那个模型
  };

  function settingsGet() {
    return Object.assign({}, DEFAULT_SETTINGS, read(K.settings, {}));
  }

  function settingsSet(patch) {
    const s = Object.assign(settingsGet(), patch);
    write(K.settings, s);
    return s;
  }

  function clearAll() {
    [K.cache, K.history, K.settings, K.tags, K.inventory].forEach(k => {
      try { if (lsOK) global.localStorage.removeItem(k); delete mem[k]; } catch (e) {}
    });
  }

  const api = {
    K, HISTORY_MAX, lsOK, INV_MAX,
    cacheGet, cachePut, cacheList, cacheDel, cacheClear,
    inventoryGet, inventorySet, inventoryClear,
    historyList, historyAdd, historyUpdate, historyDel, historyClear,
    tagsList, tagAdd, tagRename, tagDel, tagCounts, historyTag, TAG_NAME_MAX,
    settingsGet, settingsSet, DEFAULT_SETTINGS,
    clearAll, read, write
  };
  global.Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
