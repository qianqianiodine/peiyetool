/* 试剂库 —— 表驱动，加新试剂只加一条数据
 * 顶层 cas/formula/mw 即默认形式；有多种形式（游离酸/碱/盐/水合物）时另给 forms 数组，
 * forms[0] 必须与顶层一致。同一化合物的各种形式合并为一条，避免用户选错分子量。
 *   label  短标签，界面 chips 上显示
 *   name   英文规范名（可省略），用于精确命中，如 'Tris-HCl'
 * mwAvg: true 表示聚合物，MW 为平均标称值，不能当精确值用。
 */
(function (global) {
  'use strict';

  const REAGENTS = [
    // ── 缓冲液（游离酸/碱、盐、水合物合并为一条，由用户选形式） ──
    { id: 'tris', name: 'Tris', zh: '三羟甲基氨基甲烷', category: 'buffer',
      aliases: ['tris', '三羟甲基氨基甲烷', '氨基丁三醇'],
      cas: '77-86-1', formula: 'C4H11NO3', mw: 121.14,
      forms: [
        { label: '游离碱', name: 'Tris base',
          cas: '77-86-1', formula: 'C4H11NO3', mw: 121.14,
          aliases: ['Tromethamine', 'THAM', 'Trizma base'] },
        { label: '盐酸盐', name: 'Tris-HCl',
          cas: '1185-53-1', formula: 'C4H12ClNO3', mw: 157.60,
          aliases: ['Tris hydrochloride', 'Tris HCl', 'Trizma hydrochloride'] }
      ] },

    { id: 'hepes', name: 'HEPES', zh: '羟乙基哌嗪乙磺酸', category: 'buffer',
      aliases: ['hepes', '羟乙基哌嗪乙磺酸'],
      cas: '7365-45-9', formula: 'C8H18N2O4S', mw: 238.30,
      forms: [
        { label: '游离酸', name: 'HEPES free acid',
          cas: '7365-45-9', formula: 'C8H18N2O4S', mw: 238.30,
          aliases: ['HEPES acid', '4-(2-Hydroxyethyl)piperazine-1-ethanesulfonic acid'] },
        { label: '钠盐', name: 'HEPES sodium',
          cas: '75277-39-3', formula: 'C8H17N2NaO4S', mw: 260.29,
          aliases: ['HEPES sodium salt', 'HEPES Na', 'Sodium HEPES'] }
      ] },

    { id: 'bis-tris', name: 'Bis-Tris', zh: '双(2-羟乙基)氨基三(羟甲基)甲烷', category: 'buffer',
      aliases: ['bis-tris', 'bistris', '双(2-羟乙基)氨基三(羟甲基)甲烷'],
      cas: '6976-37-0', formula: 'C8H19NO5', mw: 209.24,
      forms: [
        { label: '游离碱', name: 'Bis-Tris base',
          cas: '6976-37-0', formula: 'C8H19NO5', mw: 209.24,
          aliases: ['Bis(2-hydroxyethyl)amino-tris(hydroxymethyl)methane'] },
        { label: '盐酸盐', name: 'Bis-Tris HCl',
          cas: '124763-51-5', formula: 'C8H20ClNO5', mw: 245.70,
          aliases: ['BisTris hydrochloride', 'Bis-Tris hydrochloride'] }
      ] },

    { id: 'btp', name: 'Bis-Tris propane', zh: '双三丙烷', category: 'buffer',
      aliases: ['BTP', 'Bis-Tris Propane', '1,3-bis(tris(hydroxymethyl)methylamino)propane'],
      cas: '64431-96-5', formula: 'C11H26N2O6', mw: 282.33 },

    { id: 'mes', name: 'MES', zh: '吗啉乙磺酸', category: 'buffer',
      aliases: ['mes', '吗啉乙磺酸'],
      cas: '4432-31-9', formula: 'C6H13NO4S', mw: 195.24,
      forms: [
        { label: '游离酸', name: 'MES free acid',
          cas: '4432-31-9', formula: 'C6H13NO4S', mw: 195.24,
          aliases: ['MES acid', '2-(N-Morpholino)ethanesulfonic acid'] },
        { label: '一水', name: 'MES monohydrate',
          cas: '145224-94-8', formula: 'C6H13NO4S·H2O', mw: 213.25,
          aliases: ['MES hydrate'] },
        { label: '钠盐', name: 'MES sodium',
          cas: '71119-23-8', formula: 'C6H12NNaO4S', mw: 217.22,
          aliases: ['MES sodium salt', 'MES Na'] }
      ] },

    // ── 磷酸盐 ──────────────────────────────────────────────
    { id: 'kh2po4', name: 'KH₂PO₄', zh: '磷酸二氢钾', category: 'phosphate',
      aliases: ['Potassium dihydrogen phosphate', 'monopotassium phosphate', '磷酸二氢钾'],
      cas: '7778-77-0', formula: 'KH2PO4', mw: 136.09 },

    { id: 'k2hpo4', name: 'K₂HPO₄', zh: '磷酸氢二钾', category: 'phosphate',
      aliases: ['Dipotassium hydrogen phosphate', 'dipotassium phosphate', '磷酸氢二钾'],
      cas: '7758-11-4', formula: 'K2HPO4', mw: 174.18,
      forms: [
        { label: '无水', cas: '7758-11-4', formula: 'K2HPO4', mw: 174.18 },
        { label: '三水', cas: '16788-57-1', formula: 'K2HPO4·3H2O', mw: 228.22 }
      ] },

    { id: 'nah2po4', name: 'NaH₂PO₄', zh: '磷酸二氢钠', category: 'phosphate',
      aliases: ['Sodium dihydrogen phosphate', 'monosodium phosphate', '磷酸二氢钠'],
      cas: '7558-80-7', formula: 'NaH2PO4', mw: 119.98,
      forms: [
        { label: '无水', cas: '7558-80-7', formula: 'NaH2PO4', mw: 119.98 },
        { label: '一水', cas: '10049-21-5', formula: 'NaH2PO4·H2O', mw: 137.99 },
        { label: '二水', cas: '13472-35-0', formula: 'NaH2PO4·2H2O', mw: 156.01 }
      ] },

    { id: 'na2hpo4', name: 'Na₂HPO₄', zh: '磷酸氢二钠', category: 'phosphate',
      aliases: ['Disodium hydrogen phosphate', 'disodium phosphate', '磷酸氢二钠'],
      cas: '7558-79-4', formula: 'Na2HPO4', mw: 141.96,
      forms: [
        { label: '无水', cas: '7558-79-4', formula: 'Na2HPO4', mw: 141.96 },
        { label: '二水', cas: '10028-24-7', formula: 'Na2HPO4·2H2O', mw: 177.99 },
        { label: '十二水', cas: '10039-32-4', formula: 'Na2HPO4·12H2O', mw: 358.14 }
      ] },

    // ── 柠檬酸盐 ────────────────────────────────────────────
    { id: 'citric-acid', name: '柠檬酸', zh: '柠檬酸', category: 'citrate',
      aliases: ['Citric acid', 'citric acid anhydrous', '无水柠檬酸', '枸橼酸'],
      cas: '77-92-9', formula: 'C6H8O7', mw: 192.12,
      forms: [
        { label: '无水', cas: '77-92-9', formula: 'C6H8O7', mw: 192.12 },
        { label: '一水', cas: '5949-29-1', formula: 'C6H8O7·H2O', mw: 210.14 }
      ] },

    { id: 'na3citrate', name: '柠檬酸三钠', zh: '柠檬酸三钠', category: 'citrate',
      aliases: ['Trisodium citrate', 'sodium citrate', '柠檬酸钠', '枸橼酸三钠'],
      cas: '68-04-2', formula: 'C6H5Na3O7', mw: 258.07,
      forms: [
        { label: '无水', cas: '68-04-2', formula: 'C6H5Na3O7', mw: 258.07 },
        { label: '二水', cas: '6132-04-3', formula: 'C6H5Na3O7·2H2O', mw: 294.10 }
      ] },

    // ── 常用盐 ──────────────────────────────────────────────
    { id: 'nacl', name: 'NaCl', zh: '氯化钠', category: 'salt',
      aliases: ['Sodium chloride', 'sodium chloride', 'salt', '氯化钠'],
      cas: '7647-14-5', formula: 'NaCl', mw: 58.44 },

    { id: 'kcl', name: 'KCl', zh: '氯化钾', category: 'salt',
      aliases: ['Potassium chloride', 'potassium chloride', '氯化钾'],
      cas: '7447-40-7', formula: 'KCl', mw: 74.55 },

    { id: 'mgcl2', name: 'MgCl₂', zh: '氯化镁', category: 'salt',
      aliases: ['Magnesium chloride', 'magnesium chloride', '氯化镁'],
      cas: '7786-30-3', formula: 'MgCl2', mw: 95.21,
      forms: [
        { label: '无水', cas: '7786-30-3', formula: 'MgCl2', mw: 95.21 },
        { label: '六水', cas: '7791-18-6', formula: 'MgCl2·6H2O', mw: 203.30 }
      ] },

    { id: 'cacl2', name: 'CaCl₂', zh: '氯化钙', category: 'salt',
      aliases: ['Calcium chloride', 'calcium chloride', '氯化钙'],
      cas: '10043-52-4', formula: 'CaCl2', mw: 110.98,
      forms: [
        { label: '无水', cas: '10043-52-4', formula: 'CaCl2', mw: 110.98 },
        { label: '二水', cas: '10035-04-8', formula: 'CaCl2·2H2O', mw: 147.01 }
      ] },

    // ── 还原剂 ──────────────────────────────────────────────
    { id: 'dtt', name: 'DTT', zh: '二硫苏糖醇', category: 'reductant',
      aliases: ['Dithiothreitol', '1,4-Dithiothreitol', 'Cleland reagent', '二硫苏糖醇'],
      cas: '3483-12-3', formula: 'C4H10O2S2', mw: 154.24 },

    { id: 'tcep', name: 'TCEP', zh: '三(2-羧乙基)膦盐酸盐', category: 'reductant',
      aliases: ['TCEP-HCl', 'Tris(2-carboxyethyl)phosphine hydrochloride', 'TCEP hydrochloride'],
      cas: '51805-45-9', formula: 'C9H16ClO6P', mw: 286.65,
      note: '本条目为盐酸盐形式（最常见）' },

    { id: 'bme', name: 'β-巯基乙醇', zh: 'β-巯基乙醇', category: 'reductant',
      aliases: ['2-Mercaptoethanol', 'beta-mercaptoethanol', 'BME', '2-ME', '巯基乙醇'],
      cas: '60-24-2', formula: 'C2H6OS', mw: 78.13,
      liquid: true, density: 1.114, note: '液体，密度 1.114 g/mL' },

    // ── 螯合剂 ──────────────────────────────────────────────
    { id: 'edta', name: 'EDTA', zh: '乙二胺四乙酸', category: 'chelator',
      aliases: ['edta', '乙二胺四乙酸', 'EDTA acid'],
      cas: '60-00-4', formula: 'C10H16N2O8', mw: 292.24,
      forms: [
        { label: '游离酸', name: 'EDTA free acid',
          cas: '60-00-4', formula: 'C10H16N2O8', mw: 292.24,
          aliases: ['Ethylenediaminetetraacetic acid'] },
        { label: '二钠二水', name: 'EDTA disodium',
          cas: '6381-92-6', formula: 'C10H14N2Na2O8·2H2O', mw: 372.24,
          aliases: ['EDTA-2Na', 'Disodium EDTA', 'EDTA sodium salt', 'EDTA二钠'] },
        { label: '四钠', name: 'EDTA tetrasodium',
          cas: '64-02-8', formula: 'C10H12N2Na4O8', mw: 380.17,
          aliases: ['EDTA-4Na', 'Tetrasodium EDTA'] }
      ] },

    { id: 'egta', name: 'EGTA', zh: '乙二醇双(2-氨基乙醚)四乙酸', category: 'chelator',
      aliases: ['Egtazic acid', 'Ethylene glycol-bis(2-aminoethylether)-N,N,N\',N\'-tetraacetic acid'],
      cas: '67-42-5', formula: 'C14H24N2O10', mw: 380.35 },

    // ── 去垢剂（聚合物，MW 为平均标称值） ────────────────────
    { id: 'triton-x100', name: 'Triton X-100', zh: '曲拉通 X-100', category: 'detergent',
      aliases: ['Triton X 100', 'TX-100', 'Octylphenol ethoxylate'],
      cas: '9002-93-1', formula: 'C14H22O(C2H4O)n', mw: 647.0, mwAvg: true,
      note: '聚合物，n≈9–10，MW 为平均标称值，请按实际批号为准' },

    { id: 'tween-20', name: 'Tween-20', zh: '吐温 20', category: 'detergent',
      aliases: ['Polysorbate 20', 'Tween 20', 'Polyoxyethylene sorbitan monolaurate'],
      cas: '9005-64-5', formula: '(C2H4O)nC18H34O6', mw: 1227.5, mwAvg: true,
      note: '聚合物，MW 为平均标称值，请按实际批号为准' },

    { id: 'np-40', name: 'NP-40', zh: '乙基苯基聚乙二醇', category: 'detergent',
      aliases: ['Nonidet P-40', 'Nonylphenol ethoxylate', 'IGEPAL CA-630'],
      cas: '9016-45-9', formula: '(C2H4O)nC15H24O', mw: 646.85, mwAvg: true,
      note: '聚合物，MW 为平均标称值，请按实际批号为准' },

    { id: 'sds', name: 'SDS', zh: '十二烷基硫酸钠', category: 'detergent',
      aliases: ['Sodium dodecyl sulfate', 'sodium lauryl sulfate', 'SDS', '十二烷基硫酸钠'],
      cas: '151-21-3', formula: 'C12H25NaO4S', mw: 288.38 },

    // ── 添加剂 ──────────────────────────────────────────────
    { id: 'glycerol', name: '甘油', zh: '甘油', category: 'additive',
      aliases: ['Glycerol', 'glycerin', '丙三醇'],
      cas: '56-81-5', formula: 'C3H8O3', mw: 92.09,
      liquid: true, density: 1.261, note: '液体，密度 1.261 g/mL' },

    { id: 'sucrose', name: '蔗糖', zh: '蔗糖', category: 'additive',
      aliases: ['Sucrose', 'saccharose', '蔗糖'],
      cas: '57-50-1', formula: 'C12H22O11', mw: 342.30 },

    { id: 'urea', name: '尿素', zh: '尿素', category: 'additive',
      aliases: ['Urea', 'carbamide', '脲'],
      cas: '57-13-6', formula: 'CH4N2O', mw: 60.06 },

    { id: 'glucose', name: '葡萄糖', zh: '葡萄糖', category: 'additive',
      aliases: ['Glucose', 'D-Glucose', 'dextrose', 'D-(+)-Glucose', '葡萄糖'],
      cas: '50-99-7', formula: 'C6H12O6', mw: 180.16 }
  ];

  /* 中文/别名 → 试剂 的归一化查找。
   * _byName 的值统一为 { reagent, form }：form 非空表示这个名称**明确指向某个形式**
   * （如 'Tris-HCl'），界面直接采用不再追问；form 为 null 说明名称有歧义（如 'Tris'），
   * 界面需要列出全部形式让用户选。
   * 优先级：试剂正名 > 形式正名 > 各类别名。force 只在同一试剂内部提升优先级，
   * 不会让一条试剂抢走另一条的名字。 */
  /* 下标数字（Na₂HPO₄）折成普通数字，否则用户敲 Na2HPO4 会查不到 */
  const SUBS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
                 '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
  const norm = s => String(s).trim().toLowerCase()
    .replace(/[₀-₉]/g, c => SUBS[c])
    .replace(/\s+/g, ' ');

  const _byId = {}, _byCas = {}, _byName = {};
  function putName(key, val, force) {
    const k = norm(key);
    if (!k) return;
    const cur = _byName[k];
    if (cur && !(force && cur.reagent === val.reagent)) return;
    _byName[k] = val;
  }
  REAGENTS.forEach(r => {
    _byId[r.id] = r;
    [r.cas].concat((r.forms || []).map(f => f.cas)).forEach(c => { if (c) _byCas[c] = r; });

    putName(r.name, { reagent: r, form: null }, true);
    putName(r.zh,   { reagent: r, form: null }, true);
    (r.forms || []).forEach(f => {
      if (norm(f.name) === norm(r.name) || norm(f.name) === norm(r.zh)) return;
      putName(f.name, { reagent: r, form: f }, true);
    });
    (r.aliases || []).forEach(a => putName(a, { reagent: r, form: null }));
    (r.forms || []).forEach(f => (f.aliases || []).forEach(a => putName(a, { reagent: r, form: f })));
  });

  /** 按 id 取试剂 */
  function byId(id) { return _byId[id] || null; }

  /** CAS 号正则：形如 50-99-7 / 1185-53-1 */
  const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

  function isCas(s) { return CAS_RE.test(String(s).trim()); }

  /**
   * 在内置库中查找。返回 { reagent, form, matchedBy } 或 null。
   * 可传名称（中/英/别名/形式名）或 CAS 号。
   * form 非空 = 这次输入已经指定了形式（如 'Tris-HCl'）；
   * form 为 null 而 reagent 有多个 forms = 有歧义，界面应列出形式让用户选。
   */
  function find(q) {
    const s = String(q || '').trim();
    if (!s) return null;

    if (CAS_RE.test(s)) {
      const r = _byCas[s];
      if (!r) return null;
      const form = (r.forms || []).find(f => f.cas === s) || null;
      return { reagent: r, form, matchedBy: 'cas' };
    }

    const hit = _byName[norm(s)];
    return hit ? { reagent: hit.reagent, form: hit.form, matchedBy: 'name' } : null;
  }

  /** 模糊建议：返回名称/别名包含查询串的候选（最多 n 个），供"你是不是想找"用 */
  function suggest(q, n) {
    const s = norm(q);
    if (s.length < 2) return [];
    const out = [];
    for (const r of REAGENTS) {
      const keys = [r.name, r.zh].concat(r.aliases || []);
      if (keys.some(k => norm(k).includes(s) || s.includes(norm(k)))) out.push(r);
      if (out.length >= (n || 5)) break;
    }
    return out;
  }

  /** 取某试剂的形式信息。key 可传形式的 label 或 name；省略则用默认（第一个）形式。
   *  约定：forms[0] 恒等于顶层的 cas/formula/mw，所以无 forms 与有 forms 结果一致。 */
  function formOf(reagent, key) {
    if (!reagent) return null;
    const forms = reagent.forms;
    if (forms && forms.length) {
      const f = key && forms.find(x => x.label === key || x.name === key);
      return f || forms[0];
    }
    return { label: '默认', cas: reagent.cas, formula: reagent.formula, mw: reagent.mw };
  }

  /** 某试剂的全部可选形式；无 forms 时返回只含默认形式的单元素数组 */
  function formsOf(reagent) {
    if (!reagent) return [];
    return (reagent.forms && reagent.forms.length)
      ? reagent.forms
      : [{ label: '默认', cas: reagent.cas, formula: reagent.formula, mw: reagent.mw }];
  }

  /** 是否有多个形式需要用户拍板（输入有歧义时界面据此弹出选择） */
  function hasChoice(reagent) {
    return !!(reagent && reagent.forms && reagent.forms.length > 1);
  }

  const api = { REAGENTS, byId, find, suggest, isCas, formOf, formsOf, hasChoice, CAS_RE };
  global.Reagents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
