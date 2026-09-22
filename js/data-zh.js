/* 中英对照 + 快捷添加分组
 * 常用试剂的中文名已内置在 data-reagents.js 的 zh/aliases 字段里，
 * 这里放三样东西：① 通用中→英对照表（内置库和实验室库存都没命中时用）
 *                ② 模块三的快捷添加分组
 *                ③ 中文名归一化
 *
 * ⚠️ 这里**只做整名对照，不做词根替换**。
 *    从前的写法是拿一批词根去字符串替换，后果是：
 *      「硫酸铵」→ "sulfuric acid铵"、「过硫酸铵」→ "过sulfuric acid铵"、
 *      「乙酸钠」→ "acetic acid钠"、「乙二胺四乙酸二钠」→ "乙二胺四acetic acid二钠"。
 *    这些串要么查不到，要么命中的是完全不同的化合物 —— 分子量直接错一大截，
 *    而配液称错量是要命的事。所以规矩是：认识就给出规范英文名，
 *    不认识就把原串返回，由调用方明确告诉用户"不认识这个中文名"，绝不猜。
 *
 * 实验室实际有的试剂（含位置编号）在 data-inventory.js 里，那张表优先。
 */
(function (global) {
  'use strict';

  /* 通用中→英对照。整名精确匹配，键会做归一化（去空格、转小写）。
     只收常用试剂；冷门化合物请走 CAS 号。 */
  const ZH_NAMES = [
    /* 无机盐 */
    ['氯化钠', 'sodium chloride'], ['氯化钾', 'potassium chloride'],
    ['氯化镁', 'magnesium chloride'], ['氯化钙', 'calcium chloride'],
    ['氯化铵', 'ammonium chloride'], ['氯化锂', 'lithium chloride'],
    ['氯化铯', 'cesium chloride'], ['氯化锌', 'zinc chloride'],
    ['氯化锰', 'manganese(II) chloride'], ['氯化镍', 'nickel(II) chloride'],
    ['溴化钾', 'potassium bromide'], ['溴化钠', 'sodium bromide'],
    ['碘化钾', 'potassium iodide'], ['碘化钠', 'sodium iodide'],
    ['氟化钠', 'sodium fluoride'],
    ['硫酸铵', 'ammonium sulfate'], ['硫酸镁', 'magnesium sulfate'],
    ['硫酸钾', 'potassium sulfate'], ['硫酸钠', 'sodium sulfate'],
    ['硫酸铜', 'copper(II) sulfate'], ['硫酸亚铁', 'ferrous sulfate'],
    ['硫酸镍', 'nickel(II) sulfate'], ['硫酸锌', 'zinc sulfate'],
    ['硫酸锰', 'manganese(II) sulfate'], ['硫酸钙', 'calcium sulfate'],
    ['碳酸钠', 'sodium carbonate'], ['碳酸氢钠', 'sodium bicarbonate'],
    ['碳酸钾', 'potassium carbonate'], ['碳酸氢铵', 'ammonium bicarbonate'],
    ['碳酸氢钾', 'potassium bicarbonate'],
    ['磷酸二氢钾', 'potassium dihydrogen phosphate'],
    ['磷酸氢二钾', 'dipotassium hydrogen phosphate'],
    ['磷酸二氢钠', 'sodium dihydrogen phosphate'],
    ['磷酸氢二钠', 'disodium hydrogen phosphate'],
    ['磷酸钠', 'sodium phosphate'], ['磷酸钾', 'potassium phosphate'],
    ['磷酸铵', 'ammonium phosphate'],
    ['氢氧化钠', 'sodium hydroxide'], ['氢氧化钾', 'potassium hydroxide'],
    ['氢氧化钙', 'calcium hydroxide'], ['氢氧化铵', 'ammonium hydroxide'],
    ['钼酸铵', 'ammonium molybdate'], ['钼酸钠', 'sodium molybdate'],
    ['钼酸', 'molybdic acid'],
    ['硫氰酸钾', 'potassium thiocyanate'], ['硫氰酸钠', 'sodium thiocyanate'],
    ['硝酸钠', 'sodium nitrate'], ['硝酸钾', 'potassium nitrate'],
    ['硝酸铵', 'ammonium nitrate'], ['硝酸钙', 'calcium nitrate'],
    ['硝酸银', 'silver nitrate'], ['硝酸镁', 'magnesium nitrate'],
    ['硼酸', 'boric acid'], ['硼酸钠', 'sodium borate'],
    ['硼砂', 'sodium tetraborate decahydrate'],
    ['EDTA二钠', 'EDTA disodium salt'], ['EDTA四钠', 'EDTA tetrasodium salt'],
    ['氟化钾', 'potassium fluoride'], ['氟化铵', 'ammonium fluoride'],

    /* 有机盐与酸 */
    ['乙酸铵', 'ammonium acetate'], ['乙酸钠', 'sodium acetate'],
    ['乙酸钾', 'potassium acetate'], ['乙酸钙', 'calcium acetate'],
    ['乙酸镁', 'magnesium acetate'], ['乙酸锂', 'lithium acetate'],
    ['乙酸锌', 'zinc acetate'], ['乙酸', 'acetic acid'],
    ['三氯乙酸', 'trichloroacetic acid'], ['三氟乙酸', 'trifluoroacetic acid'],
    ['甲酸', 'formic acid'], ['甲酸钠', 'sodium formate'],
    ['甲酸钾', 'potassium formate'], ['甲酸铵', 'ammonium formate'],
    ['柠檬酸', 'citric acid'], ['柠檬酸钠', 'sodium citrate'],
    ['柠檬酸三钠', 'trisodium citrate'], ['柠檬酸铵', 'ammonium citrate'],
    ['柠檬酸钾', 'potassium citrate'],
    ['琥珀酸', 'succinic acid'], ['丁二酸', 'succinic acid'],
    ['苹果酸', 'malic acid'], ['马来酸', 'maleic acid'],
    ['富马酸', 'fumaric acid'], ['乳酸', 'lactic acid'],
    ['乳酸钠', 'sodium lactate'], ['丙酮酸', 'pyruvic acid'],
    ['丙酮酸钠', 'sodium pyruvate'], ['草酸', 'oxalic acid'],
    ['草酸钠', 'sodium oxalate'], ['酒石酸', 'tartaric acid'],
    ['酒石酸钾钠', 'potassium sodium tartrate'],
    ['酒石酸钠', 'sodium tartrate'],
    ['丙二酸', 'malonic acid'], ['戊二酸', 'glutaric acid'],
    ['盐酸胍', 'guanidine hydrochloride'],
    ['异硫氰酸胍', 'guanidine isothiocyanate'],
    ['过硫酸铵', 'ammonium persulfate'], ['过硫酸钾', 'potassium persulfate'],
    ['苯甲基磺酰氟', 'phenylmethanesulfonyl fluoride'],
    ['5-氟尿嘧啶', '5-fluorouracil'],
    ['苯妥英钠', 'phenytoin sodium'],
    ['脱氧胆酸钠', 'sodium deoxycholate'], ['胆酸钠', 'sodium cholate'],
    ['尿嘧啶', 'uracil'], ['胸腺嘧啶', 'thymine'],
    ['腺嘌呤', 'adenine'], ['鸟嘌呤', 'guanine'],
    ['胞嘧啶', 'cytosine'], ['肌苷', 'inosine'],
    ['异丙基硫代半乳糖苷', 'isopropyl beta-D-thiogalactopyranoside'],
    ['异丙基-β-D-硫代半乳糖苷', 'isopropyl beta-D-thiogalactopyranoside'],
    ['吡啶甲酸', 'picolinic acid'], ['咪唑', 'imidazole'],
    ['三羟甲基氨基甲烷', 'tris'],
    ['双三羟甲基丙烷', 'di-trimethylolpropane'],
    ['乙二胺四乙酸', 'EDTA'], ['乙二醇双四乙酸', 'EGTA'],

    /* 有机溶剂与常用有机物 */
    ['甲醇', 'methanol'], ['乙醇', 'ethanol'], ['异丙醇', 'isopropanol'],
    ['正丁醇', 'n-butanol'], ['叔丁醇', 'tert-butanol'],
    ['丙二醇', 'propylene glycol'], ['丙三醇', 'glycerol'],
    ['甘油', 'glycerol'], ['乙二醇', 'ethylene glycol'],
    ['丙酮', 'acetone'], ['乙腈', 'acetonitrile'],
    ['二甲基亚砜', 'dimethyl sulfoxide'], ['二甲基甲酰胺', 'dimethylformamide'],
    ['四氢呋喃', 'tetrahydrofuran'], ['二氧六环', '1,4-dioxane'],
    ['1,4-二氧六环', '1,4-dioxane'], ['吡啶', 'pyridine'],
    ['三乙胺', 'triethylamine'], ['二硫苏糖醇', 'dithiothreitol'],
    ['β-巯基乙醇', '2-mercaptoethanol'], ['巯基乙醇', '2-mercaptoethanol'],
    ['甲基-2,4-戊二醇', '2-methyl-2,4-pentanediol'],
    ['四甲基乙二胺', 'N,N,N\',N\'-tetramethylethylenediamine'],
    ['聚乙二醇', 'polyethylene glycol'],
    ['蔗糖', 'sucrose'], ['葡萄糖', 'glucose'], ['海藻糖', 'trehalose'],
    ['甘露醇', 'mannitol'], ['山梨醇', 'sorbitol'], ['木糖', 'xylose'],
    ['半乳糖', 'galactose'], ['乳糖', 'lactose'], ['麦芽糖', 'maltose'],
    ['甘氨酸', 'glycine'], ['丙氨酸', 'alanine'], ['丝氨酸', 'serine'],
    ['苏氨酸', 'threonine'], ['半胱氨酸', 'cysteine'], ['酪氨酸', 'tyrosine'],
    ['色氨酸', 'tryptophan'], ['苯丙氨酸', 'phenylalanine'],
    ['亮氨酸', 'leucine'], ['异亮氨酸', 'isoleucine'], ['缬氨酸', 'valine'],
    ['赖氨酸', 'lysine'], ['精氨酸', 'arginine'], ['组氨酸', 'histidine'],
    ['天冬氨酸', 'aspartic acid'], ['谷氨酸', 'glutamic acid'],
    ['谷氨酰胺', 'glutamine'], ['天冬酰胺', 'asparagine'],
    ['脯氨酸', 'proline'], ['甲硫氨酸', 'methionine'],
    ['尿素', 'urea'],
    ['十二烷基硫酸钠', 'sodium dodecyl sulfate'],
    ['吐温20', 'polysorbate 20'], ['吐温-20', 'polysorbate 20'],
    ['曲拉通X-100', 'Triton X-100'], ['曲拉通 X-100', 'Triton X-100']
  ];

  /** 归一化：去所有空白、全角括号折半角、转小写 */
  function normZh(s) {
    return String(s == null ? '' : s)
      .replace(/[\s　]/g, '')
      .replace(/（/g, '(').replace(/）/g, ')')
      .toLowerCase();
  }

  const _zhIndex = {};
  ZH_NAMES.forEach(([zh, en]) => { _zhIndex[normZh(zh)] = en; });

  /**
   * 中文名 → 英文名。整名精确匹配，匹配不上就把原串返回。
   * 调用方用 `返回值 !== 输入` 判断"到底认不认识"。
   */
  function toEnglishQuery(q) {
    const s = String(q || '').trim();
    if (!s || !/[一-龥]/.test(s)) return s;
    return _zhIndex[normZh(s)] || s;
  }

  /** 这个中文名认识吗 */
  function knows(q) {
    const s = String(q || '').trim();
    return !!(s && /[一-龥]/.test(s) && _zhIndex[normZh(s)]);
  }

  /* 模块三"体系配置"的快捷添加分组。每项是 reagentId，点击即添加一行组分。 */
  const QUICK_GROUPS = [
    { name: '缓冲液', items: ['tris', 'hepes', 'bis-tris', 'btp', 'mes'] },
    { name: '盐', items: ['nacl', 'kcl', 'mgcl2', 'cacl2'] },
    { name: '还原剂', items: ['dtt', 'tcep', 'bme'] },
    { name: '螯合剂', items: ['edta', 'egta'] },
    { name: '去垢剂', items: ['triton-x100', 'tween-20', 'np-40', 'sds'] },
    { name: '其他', items: ['glycerol', 'sucrose', 'urea'] }
  ];

  const api = { ZH_NAMES, normZh, toEnglishQuery, knows, QUICK_GROUPS };
  global.ZhData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
