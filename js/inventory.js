/* 试剂位置表 —— 查「这个试剂在哪个位置」，也是中文名的翻译来源之一。
 *
 * 数据有两个来源，按优先级合并：
 *   ① 用户自己导入的（存在 localStorage 的 ps:inventory）—— 优先，这是他自己的货架
 *   ② 内置的 js/inventory-data.js —— 可选文件，公开版没有它
 *
 * 公开版不打包 ②，所以这个文件在两种版本下都能跑，只是数据来源不同。
 * 对外接口和旧版 data-inventory.js 完全一致（findByName / toEnglish / norm），
 * 所以 js/lookup.js 一行都不用改 —— 那是这个拆分能成立的前提。
 *
 * ⚠️ 索引是懒建的：这个文件在 index.html 里排在 store.js 之前加载，
 *    而且用户是运行中才导入的，所以不能在加载时就把数据取出来。
 */
(function (global) {
  'use strict';

  /**
   * 归一化：去空白、全角括号折半角、去连字符与逗号、转小写。
   * 去连字符是为了让「Tris HCl」和「Tris-HCl」落到同一个键上 ——
   * 手打的时候没人会记得瓶子标签上到底有没有那个短横。
   */
  const norm = s => String(s == null ? '' : s)
    .replace(/[\s　]/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[-–—_.,，、]/g, '')
    .toLowerCase();

  /* 括号里这些词是形态/级别标注，不是别名。
     把它们当键会让「无水」「一水」这种词命中一大堆无关试剂 ——
     「氯化锂(无水)」抽出「无水」后，谁查「无水」都会中招。 */
  const GENERIC = /^(无水|一水|二水|三水|四水|五水|六水|七水|八水|九水|十水|十二水|水合|颗粒|粒状|粉状|结晶|优级纯|分析纯|化学纯|色谱纯|药用级|细胞培养级|AR|GR|ACS|CP|HPLC|TLC)$/i;

  /** 括号里的这一段能不能当别名用 */
  function aliasOK(seg) {
    const s = String(seg || '').trim();
    if (s.length < 2) return false;          // 「5g」「2瓶」这种没意义
    if (GENERIC.test(s)) return false;       // 形态/级别标注，太泛
    if (/^\d+\s*[a-zA-Z克毫升升瓶批版号]*$/.test(s)) return false;  // 数量、批号
    return true;
  }

  /**
   * 从一个名称展开出所有可查询的键。
   *
   * 中文名里的括号多半是别名或货架备注（「无水乙酸钠(醋酸钠)」「吐温20(Tween 20)」），
   * 用户实际会打的是括号前那一段，所以括号前后都要能查到；
   * 英文名的括号是化学名本身的一部分（Poly(ethylene glycol)），拆了就成垃圾键了。
   */
  function keysOf(name) {
    if (!name) return [];
    const keys = [];
    const push = s => {
      const k = norm(s);
      if (k && keys.indexOf(k) < 0) keys.push(k);
    };
    push(name);
    if (/[一-龥]/.test(name)) {
      push(name.split(/[(（]/)[0]);
      (name.match(/[(（][^)）]*[)）]/g) || []).forEach(seg => {
        seg.replace(/[(（)）]/g, '').split(/[\/、,，;；]/).forEach(p => {
          if (aliasOK(p)) push(p);
        });
      });
    }
    return keys;
  }

  /** 用户导入的一条记录 → 内部记录形状。字段名对不上就留空，不编造 */
  function fromImported(r) {
    return {
      code: r.code || '',          // 位置编号
      tag: r.tag || '',            // 哪个货架 / 哪一组
      en: r.en || '',
      zh: r.zh || '',
      cas: r.cas || '',
      formula: r.formula || '',
      mw: r.mw,                    // 可能是 undefined —— 表示这条只提供位置，不提供分子量
      brand: r.brand || '',
      solvent: r.solvent || '',
      note: r.note || ''
    };
  }

  /* 懒建的索引。导入之后要调 reload() 让它重建，否则新数据查不到 */
  let _byName = null;

  /** 两层数据合成一个数组：用户导入的在前（优先），内置的在后 */
  function all() {
    const out = [];
    const imported = (global.Store && global.Store.inventoryGet) ? global.Store.inventoryGet() : [];
    imported.forEach(r => out.push(fromImported(r)));
    const builtin = global.InventoryData;
    if (builtin && builtin.INVENTORY) out.push.apply(out, builtin.INVENTORY);
    return out;
  }

  function ensureIndex() {
    if (_byName) return;
    const idx = {};
    all().forEach(r => {
      // 同一个键可能从 en / zh / clean / cas 几条路各生成一次（Tris-HCl 就是），要去重，
      // 否则一条记录会在结果里重复出现
      const seen = {};
      keysOf(r.en).concat(keysOf(r.zh), keysOf(r.clean), keysOf(r.cas)).forEach(k => {
        if (seen[k]) return;
        seen[k] = 1;
        (idx[k] = idx[k] || []).push(r);
      });
    });
    _byName = idx;
  }

  /** 导入 / 清空之后调这个 —— 不调的话索引还是旧的 */
  function reload() { _byName = null; }

  /** 按名称查位置，返回所有匹配的记录（同一化合物可能有多个货位） */
  function findByName(q) {
    ensureIndex();
    const hits = _byName[norm(q)];
    return hits ? hits.slice() : [];
  }

  /** 认识这个名字吗；认识就给出规范英文名（供联网查询用） */
  function toEnglish(q) {
    const hits = findByName(q);
    for (const h of hits) {
      if (h.clean) return h.clean;
      if (h.en) return h.en;
    }
    return '';
  }

  /** 这张表里一共有多少条（内置 + 导入） */
  function count() { return all().length; }

  const api = { findByName, toEnglish, norm, keysOf, all, count, reload };
  global.Inventory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
