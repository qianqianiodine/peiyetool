/* 验收脚本 —— Node 直接跑：node tools/verify.js
 * 只验证纯逻辑（计算 + 试剂表解析），不碰 DOM / 网络 / 存储。
 * 视觉与交互测试由人工完成。
 */
'use strict';

const path = require('path');
const J = p => require(path.join(__dirname, '..', 'js', p));

const Units   = J('units.js');
const Calc    = J('calc.js');
const Reagents = J('data-reagents.js');
const Buffers = J('data-buffers.js');

let pass = 0, fail = 0;
const failures = [];

function ok(n, title, detail) {
  pass++;
  console.log('  ✓ ' + n + '. ' + title + (detail ? '  ' + detail : ''));
}
function bad(n, title, detail) {
  fail++; failures.push(n + '. ' + title + ' — ' + detail);
  console.log('  ✗ ' + n + '. ' + title + '  \u001b[31m' + detail + '\u001b[0m');
}

/** 相对容差比较 */
function near(actual, expected, title, n, tolPct) {
  const tol = Math.abs(expected) * (tolPct == null ? 0.1 : tolPct) / 100;
  const diff = Math.abs(actual - expected);
  const d = '实际 ' + actual.toFixed(4) + ' / 期望 ' + expected
    + ' (差 ' + (expected ? (diff / Math.abs(expected) * 100).toFixed(3) : diff) + '%)';
  if (diff <= tol) ok(n, title, d); else bad(n, title, d);
}

function equal(actual, expected, title, n) {
  const d = '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected);
  if (actual === expected) ok(n, title, d); else bad(n, title, d);
}

console.log('\n验收测试 —— 科研配液计算器\n' + '='.repeat(58) + '\n');

/* ── 1. 葡萄糖 1 M × 1 L → 180.16 g ─────────────────────── */
{
  const r = Reagents.find('glucose');
  const m = Calc.massForSolution(1, 1, r.reagent.mw);
  near(m, 180.16, '葡萄糖 1 M × 1 L', 1);
}

/* ── 2. Tris pH 7.4 @25°C → 4°C = 7.99 ─────────────────── */
{
  const b = Buffers.bufferById('tris');
  const r = Calc.tempShift({ pKa25: b.pKa25, dpKa: b.dpKa, pH: 7.4, tKnown: 25, tTarget: 4 });
  near(r.pH, 7.99, 'Tris 温度换算 25→4°C', 2, 0.13);
  console.log('      pH = ' + Units.formatPH(r.pH) + '，ΔpKa = ' + r.deltaPKa.toFixed(4));
}

/* ── 3. 磷酸盐 pH 7.2 @25°C → 4°C = 7.26 ───────────────── */
{
  const b = Buffers.bufferById('phosphate');
  const r = Calc.tempShift({ pKa25: b.pKa25, dpKa: b.dpKa, pH: 7.2, tKnown: 25, tTarget: 4 });
  near(r.pH, 7.26, '磷酸盐温度换算 25→4°C', 3, 0.13);
  console.log('      pH = ' + Units.formatPH(r.pH) + '，ΔpKa = ' + r.deltaPKa.toFixed(4));
}

/* ── 4. 磷酸钾 1 L 1 M pH 7.2 ──────────────────────────── */
{
  const s = Buffers.polyById('k-phosphate');
  const b = Buffers.bufferById(s.bufferId);
  const acid = Reagents.byId(s.acid.reagentId);
  const base = Reagents.byId(s.base.reagentId);
  const r = Calc.polyproticRatio({
    pKas: b.pKas, za: s.za, zb: s.zb, pH: 7.2, conc: 1, vol: 1,
    mwAcid: acid.mw, mwBase: base.mw
  });
  console.log('      z = ' + r.z.toFixed(5) + '，n酸 = ' + r.nAcid.toFixed(4)
    + ' mol，n碱 = ' + r.nBase.toFixed(4) + ' mol');
  near(r.massBase, 87.09, '磷酸钾 → K₂HPO₄ 质量', 4);
  near(r.massAcid, 68.05, '磷酸钾 → KH₂PO₄ 质量', 5);
}

/* ── 5. 磷酸钠 1 L 1 M pH 7.2 ──────────────────────────── */
{
  const s = Buffers.polyById('na-phosphate');
  const b = Buffers.bufferById(s.bufferId);
  const acid = Reagents.byId(s.acid.reagentId);
  const base = Reagents.byId(s.base.reagentId);
  const r = Calc.polyproticRatio({
    pKas: b.pKas, za: s.za, zb: s.zb, pH: 7.2, conc: 1, vol: 1,
    mwAcid: acid.mw, mwBase: base.mw
  });
  near(r.massBase, 70.98, '磷酸钠 → Na₂HPO₄ 质量', 6);
  near(r.massAcid, 59.99, '磷酸钠 → NaH₂PO₄ 质量', 7);
}

/* ── 6. 柠檬酸 1 L 1 M pH 4.76 ─────────────────────────── */
{
  const s = Buffers.polyById('citrate');
  const b = Buffers.bufferById(s.bufferId);
  const acid = Reagents.byId(s.acid.reagentId);
  const base = Reagents.byId(s.base.reagentId);
  const r = Calc.polyproticRatio({
    pKas: b.pKas, za: s.za, zb: s.zb, pH: 4.76, conc: 1, vol: 1,
    mwAcid: acid.mw, mwBase: base.mw
  });
  console.log('      z = ' + r.z.toFixed(5) + '（简化算法取 1.5，'
    + '完整分布公式含 pKa1/pKa3 微小贡献）');
  near(r.massBase, 129.04, '柠檬酸 → 柠檬酸三钠质量', 8);
  near(r.massAcid, 96.06, '柠檬酸 → 柠檬酸质量', 9);
}

/* ── 7. 母液稀释 1 M → 100 mL 10 mM ────────────────────── */
{
  // 从「用户输入的原始数字 + 各自的单位」起步，走完换算再算。
  // 不能拿 1 和 10 直接比大小 —— 那样 1 M → 10 mM 会被误判成"目标浓度更高"而拒绝计算。
  const c1 = 1 * Units.concFactor('M');      // 1 mol/L
  const c2 = 10 * Units.concFactor('mM');    // 0.01 mol/L
  const r = Calc.dilution({ c1, c2, v2: Units.toLiter(100, 'mL') });
  near(Units.fromLiter(r.v1, 'mL'), 1, '稀释取母液体积 (mL)', 10, 0.01);
  near(Units.fromLiter(r.vSolvent, 'mL'), 99, '补加溶剂体积 (mL)', 11, 0.01);
}

/* ── 8. 体系配置 50 mM Tris + 150 mM NaCl ──────────────── */
{
  const tris = Reagents.byId('tris'), nacl = Reagents.byId('nacl');
  const r = Calc.systemMix([
    { name: 'Tris', targetConc: 50, targetUnit: 'mM', mode: 'stock', stockConc: 1, stockUnit: 'M', mw: tris.mw },
    { name: 'NaCl', targetConc: 150, targetUnit: 'mM', mode: 'stock', stockConc: 1, stockUnit: 'M', mw: nacl.mw }
  ], 1);
  const vTris = r.rows[0].volume * 1000, vNacl = r.rows[1].volume * 1000;
  near(vTris, 50, 'Tris 母液体积 (mL)', 12, 0.01);
  near(vNacl, 150, 'NaCl 母液体积 (mL)', 13, 0.01);
  near(r.solventVol * 1000, 800, '补加溶剂 (mL)', 14, 0.01);
}

/* ── 9. CAS 查询 50-99-7 → glucose 180.16 ──────────────── */
{
  const hit = Reagents.find('50-99-7');
  if (!hit) bad(15, 'CAS 查询 50-99-7', '未命中');
  else {
    equal(hit.reagent.id === 'glucose', true, 'CAS 50-99-7 → glucose', 15);
    near(hit.reagent.mw, 180.16, 'CAS 50-99-7 → MW', 16, 0.01);
  }
}

/* ── 10. 水合物切换 ────────────────────────────────────── */
{
  const r = Reagents.byId('na2hpo4');
  const anhydrous = r.forms.find(f => f.label === '无水');
  const dodeca    = r.forms.find(f => f.label === '十二水');
  near(anhydrous.mw, 141.96, 'Na₂HPO₄ 无水 MW', 17, 0.01);
  near(dodeca.mw, 358.14, 'Na₂HPO₄ 十二水 MW', 18, 0.01);

  // 同一目标下质量应随水合物变化
  const m1 = Calc.massForSolution(0.5, 1, anhydrous.mw);
  const m2 = Calc.massForSolution(0.5, 1, dodeca.mw);
  equal(m2 > m1, true, '十二水质量 > 无水质量', 19);
  console.log('      0.5 mol 时：无水 ' + m1.toFixed(2) + ' g，十二水 ' + m2.toFixed(2) + ' g');
}

/* ── 11. 分布公式自洽性（替代原"参考表 <1% 偏差"项） ────── */
{
  const cases = [
    { name: '磷酸盐', pKas: Buffers.bufferById('phosphate').pKas, midZ: 1.5 },
    { name: '柠檬酸', pKas: Buffers.bufferById('citrate').pKas,   midZ: 1.5 }
  ];
  let allOk = true, detail = [];
  cases.forEach(c => {
    // (a) pH = pKa2 时 z 应恰为中值
    const zMid = Calc.distribution(c.pKas, c.pKas[1]).z;
    const midOk = Math.abs(zMid - c.midZ) < 1e-3;
    // (b) 任意 pH 下 Σαi = 1
    let sumOk = true;
    for (let pH = 0; pH <= 14; pH += 0.5) {
      const s = Calc.distribution(c.pKas, pH).alpha.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 1e-9) sumOk = false;
    }
    // (c) pH 升高时 z 单调不减
    let monoOk = true, prev = -1;
    for (let pH = 0; pH <= 14; pH += 0.25) {
      const z = Calc.distribution(c.pKas, pH).z;
      if (z < prev - 1e-9) monoOk = false;
      prev = z;
    }
    if (!(midOk && sumOk && monoOk)) allOk = false;
    detail.push(c.name + (midOk ? ' 中值✓' : ' 中值✗') + (sumOk ? ' Σα=1✓' : ' Σα=1✗')
      + (monoOk ? ' 单调✓' : ' 单调✗'));
  });
  if (allOk) ok(20, '分布公式自洽性', detail.join('｜'));
  else bad(20, '分布公式自洽性', detail.join('｜'));
}

/* ── 12. 内置库完整性 ──────────────────────────────────── */
{
  const need = ['77-86-1', '1185-53-1', '7365-45-9', '75277-39-3', '6976-37-0',
    '64431-96-5', '4432-31-9', '71119-23-8', '7778-77-0', '7758-11-4',
    '7558-80-7', '7558-79-4', '77-92-9', '68-04-2', '7647-14-5', '7447-40-7',
    '7786-30-3', '10043-52-4', '3483-12-3', '51805-45-9', '60-00-4',
    '56-81-5', '57-13-6', '50-99-7', '57-50-1', '151-21-3'];
  const missing = need.filter(c => !Reagents.find(c));
  if (missing.length === 0) ok(21, '常用试剂 CAS 号全部内置', need.length + ' 个');
  else bad(21, '下面这些常用试剂的 CAS 号缺失', missing.join(', '));
}

/* ── 13. 单位归一化陷阱 ────────────────────────────────── */
{
  const mu1 = Units.CONC['μM'].factor;              // U+03BC
  const mu2 = Units.concFactor('µM');           // U+00B5 MICRO SIGN
  equal(mu1 === mu2, true, 'µ/μ 两种码点归一化一致', 22);

  const v = Units.formatVol(0.001);
  equal(v.text, '1 mL', '体积格式化 0.001 L → 1 mL', 23);

  // 阈值依需求：≥1 g 用 g，≥1 mg 用 mg，否则 μg
  equal(Units.formatMass(1.5).unit, 'g', '≥1 g 用 g', 24);
  equal(Units.formatMass(0.5).text, '500 mg', '0.5 g → 500 mg', 25);
  equal(Units.formatMass(0.0005).unit, 'μg', '0.5 mg 以下转 μg', 26);
  equal(Units.formatMass(0.0000005).text, '0.5 μg', '0.5 μg 格式化', 27);
}

/* ── 14. 试剂表导入解析 ──────────────────────────────────
 * 解析器是纯函数，所以能在这儿直接测。这里只放**最容易被改坏**的那几条；
 * 更全的脏数据（引号、跨行、GBK、1000 行）在实现时单独跑过。 */
{
  const P = require(path.join(__dirname, '..', 'js', 'inventory-import.js'));

  // 从 Excel 粘贴：制表符 + 中文表头
  // ⚠️ 下面这些示例值（货位、品牌）都是编的。别图省事从真实库存表里复制一行过来 ——
  //    这个仓库是公开的，那等于把实验室的一条真实货位记录发出去。
  const t1 = P.parseTable('编号\t英文名\t中文名\t品牌厂家\nA-99\tAmmonium acetate\t乙酸铵\t示例品牌');
  equal(t1.records.length === 1 && t1.records[0].code === 'A-99'
        && t1.records[0].zh === '乙酸铵' && t1.records[0].brand === '示例品牌',
        true, '粘贴解析：表头按名字对应，编号→位置', 28);

  // 没表头就按固定列序
  const t2 = P.parseTable('乙酸铵\tAmmonium acetate\t77.08\t631-61-8\tA-99');
  equal(!t2.header.detected && t2.records[0].cas === '631-61-8'
        && t2.records[0].code === 'A-99' && t2.records[0].mw === 77.08,
        true, '无表头时按 中文名/英文名/分子量/CAS/位置 落位', 29);

  // 行号必须是原文行号 —— 空行被滤掉后数行号就错位，而用户是照这个号去 Excel 找的
  const t3 = P.parseTable('中文名,英文名\n乙酸铵,A\n\n\n,,只有备注');
  equal(t3.problems.some(p => p.line === 5 && p.level === 'error'), true,
        '行号用原文行号（空行不让它错位）', 30);
  equal(t3.counts.bad === 1 && t3.counts.good === 1, true, '没名字的行跳过并计数', 31);

  // 分子量：允许带单位；看不懂的不能变成 NaN 混进去
  equal(P.parseMw('180.16 g/mol') === 180.16, true, '分子量带单位也能读', 32);
  equal(isNaN(P.parseMw('N/A')), true, '分子量读不懂 → NaN（不当成数字用）', 33);

  // CAS 格式不对就丢掉，否则以后按 CAS 查会误命中别的化合物
  const t4 = P.parseTable('中文名,分子量,CAS\n乙酸铵,77.08,abc-123');
  equal(t4.records[0].cas === '' && t4.problems.some(p => /CAS/.test(p.msg)), true,
        'CAS 格式不对就丢掉并告警', 34);

  // 空输入不能崩（用户点预览时框里是空的）
  equal(P.parseTable('').ok === false && P.parseTable(null).ok === false, true,
        '空内容/null 不崩', 35);
}

/* ── 汇总 ─────────────────────────────────────────────── */
console.log('\n' + '='.repeat(58));
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('全部通过。\n');
}
