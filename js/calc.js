/* 计算引擎 —— 纯函数，无 DOM / 无网络 / 无存储。
 * 全部使用 25 °C 无限稀释的热力学值。高离子强度下表观 pKa 会下移，
 * 由 estimateIonicStrength() + ionicWarning() 负责提示用户实测校准。
 */
(function (global) {
  'use strict';

  const U = (typeof module !== 'undefined' && module.exports)
    ? require('./units.js')
    : global.Units;

  /* ── 1. 快速配液：质量 = 浓度 × 体积 × 分子量 ───────────── */
  /**
   * @param {number} conc  摩尔浓度 mol/L
   * @param {number} vol   体积 L
   * @param {number} mw    分子量 g/mol
   * @returns {number} 质量 g
   */
  function massForSolution(conc, vol, mw) {
    return conc * vol * mw;
  }

  /* ── 2. 温度换算 pH ──────────────────────────────────── */
  /**
   * 酸/碱比例不变，只有 pKa 随温度变，故 pH 的位移等于 pKa 的位移：
   *   pH_T = pH_已知 + [pKa(T) − pKa(T_已知)]
   *   pKa(T) = pKa25 + dpKa/dT × (T − 25)
   */
  function tempShift(opts) {
    const tKnown  = opts.tKnown  == null ? 25 : Number(opts.tKnown);
    const tTarget = Number(opts.tTarget);
    const pKa25   = Number(opts.pKa25);
    const dpKa    = Number(opts.dpKa);

    const pKaKnown  = pKa25 + dpKa * (tKnown - 25);
    const pKaTarget = pKa25 + dpKa * (tTarget - 25);
    const deltaPKa  = pKaTarget - pKaKnown;

    return {
      pH: Number(opts.pH) + deltaPKa,
      deltaPKa,
      pKaKnown,
      pKaTarget,
      tKnown, tTarget
    };
  }

  /* ── 3. 多质子酸分布 ─────────────────────────────────── */
  /**
   * [H+] = 10^-pH；D = Σ (Ka1…Kai × [H+]^(n−i))；αi = 该项/D
   * z = Σ (i × αi) —— 混合后的平均负电荷数
   * @returns {{alpha:number[], z:number}}
   */
  function distribution(pKas, pH) {
    const H = Math.pow(10, -pH);
    const n = pKas.length;

    // P[i] = Ka1 × Ka2 × … × Kai，P[0] = 1
    const P = [1];
    for (let i = 0; i < n; i++) P.push(P[i] * Math.pow(10, -pKas[i]));

    // 第 i 项 = P[i] × [H+]^(n−i)
    const terms = [];
    for (let i = 0; i <= n; i++) terms.push(P[i] * Math.pow(H, n - i));

    const D = terms.reduce((a, b) => a + b, 0);
    const alpha = terms.map(t => t / D);
    const z = alpha.reduce((s, a, i) => s + i * a, 0);

    return { alpha, z };
  }

  /** 某 pH 下各物种的摩尔分数（对外暴露给 UI 展示用） */
  function speciesFractions(pKas, pH) {
    const { alpha } = distribution(pKas, pH);
    return alpha.map((a, i) => ({ charge: i, fraction: a }));
  }

  /**
   * 把 pKa 列表校正到指定温度。
   * 只校正主导 pKa（其他质子的温度系数本库未收录，改动反而失真），
   * 这是近似——界面需提示非 25 °C 结果仅供参考。
   */
  function pKasAtTemp(pKas, dominantIndex, dpKa, tC) {
    const out = pKas.slice();
    if (tC == null || tC === 25) return out;
    out[dominantIndex] = pKas[dominantIndex] + dpKa * (tC - 25);
    return out;
  }

  /* ── 4. 多质子酸两种盐的配比 ─────────────────────────── */
  /**
   * n_碱 = C(z − z_a)/(z_b − z_a)，n_酸 = C(z_b − z)/(z_b − z_a)
   * 要求 z_a ≤ z ≤ z_b，否则该体系配不出目标 pH。
   *
   * @param {object} o
   *   pKas  完整 pKa 列表（含所有质子）
   *   za/zb 酸形式与碱形式的电荷数
   *   pH    目标 pH
   *   conc  总浓度 mol/L
   *   vol   最终体积 L
   *   mwAcid/mwBase 两种形式的分子量
   */
  function polyproticRatio(o) {
    const { alpha, z } = distribution(o.pKas, o.pH);
    const za = Number(o.za), zb = Number(o.zb);
    const conc = Number(o.conc), vol = Number(o.vol);

    const inRange = z >= za - 1e-9 && z <= zb + 1e-9;
    const span = zb - za;

    // 越界时仍按公式算，调用方据 inRange 决定是否提示"无法配出"
    const nBase = span === 0 ? 0 : conc * (z - za) / span * vol;
    const nAcid = span === 0 ? 0 : conc * (zb - z) / span * vol;

    const out = {
      z, alpha, inRange,
      nAcid, nBase,
      massAcid: nAcid * Number(o.mwAcid),
      massBase: nBase * Number(o.mwBase),
      totalConc: conc, vol
    };

    // 离子强度估算：K⁺/Na⁺ 等抗衡离子一并计入
    out.ionicStrength = estimateIonicStrength({
      pH: o.pH, pKas: o.pKas, za, zb, conc,
      cationPerAcid: o.cationPerAcid, cationPerBase: o.cationPerBase
    });

    return out;
  }

  /* ── 5. 离子强度估算与警示 ───────────────────────────── */
  /**
   * I = 0.5 × Σ(ci × zi²)
   * 对磷酸盐/柠檬酸盐这类"酸式盐 + 碱式盐"体系，抗衡离子（K⁺/Na⁺）
   * 才是离子强度的主要贡献者，必须计入。
   */
  function estimateIonicStrength(o) {
    const { alpha } = distribution(o.pKas, o.pH);
    const ca = Number(o.cationPerAcid == null ? 1 : o.cationPerAcid);
    const cb = Number(o.cationPerBase == null ? 2 : o.cationPerBase);

    // 各族分的摩尔分数 → 浓度 → 电荷贡献
    let sum = 0;
    alpha.forEach((f, charge) => {
      if (f <= 0) return;
      const c = f * o.conc;
      sum += c * charge * charge;
      // 抗衡阳离子：按该物种所需阳离子数配平（用酸/碱形式的比例近似）
      const cations = ca + (cb - ca) * (charge / Math.max(1, o.zb));
      sum += c * cations * 1 * 1;
    });
    return 0.5 * sum;
  }

  /** 高离子强度警示。0.1 M 以上表观 pKa 明显偏离热力学值。 */
  function ionicWarning(concM) {
    if (!(concM > 0.1)) return null;
    return '总浓度 ' + U.formatSig(concM, 2) + ' M 属于高离子强度，'
      + '表观 pKa 会低于热力学值，实际 pH 可能偏离计算结果。建议配好后用 pH 计校准。';
  }

  /* ── 6. 母液稀释 C1V1 = C2V2 ─────────────────────────── */
  function dilution(o) {
    const c1 = Number(o.c1), c2 = Number(o.c2), v2 = Number(o.v2);
    const v1 = c1 === 0 ? NaN : c2 * v2 / c1;
    return { v1, vSolvent: v2 - v1, fold: c1 / c2 };
  }

  /* ── 7. 多组分体系配置 ───────────────────────────────── */
  /**
   * components: [{
   *   name, targetConc, targetUnit,
   *   mode: 'stock' | 'solid',
   *   stockConc, stockUnit,     // mode='stock'
   *   mw                        // mode='solid'
   * }]
   * 补加溶剂 = 最终体积 − 所有母液体积之和
   */
  function systemMix(components, finalVolL) {
    const vol = Number(finalVolL);
    let totalStockVol = 0;
    const rows = (components || []).map(c => {
      const targetM = U.toMolar(c.targetConc, c.targetUnit);
      const moles = targetM * vol;
      const row = { input: c, moles, targetM };

      if (c.mode === 'stock') {
        const stockM = U.toMolar(c.stockConc, c.stockUnit);
        row.volume = stockM === 0 ? NaN : moles / stockM;
        row.mass = null;
        if (isFinite(row.volume)) totalStockVol += row.volume;
      } else {
        row.mass = moles * Number(c.mw);
        row.volume = null;
      }
      return row;
    });

    return { rows, totalStockVol, solventVol: vol - totalStockVol, finalVol: vol };
  }

  /* ── 8. 操作步骤文案 ─────────────────────────────────── */
  /** 快速配液：称取 X g，溶于约 80% 体积，定容至 Y */
  function stepsForSolution(name, massG, volL) {
    const m = U.formatMass(massG);
    const v = U.formatVol(volL);
    const pre = U.formatVol(volL * 0.8);
    return '称取 ' + m.text + ' ' + name + '，溶于约 ' + pre.text
      + ' 去离子水，充分溶解后定容至 ' + v.text + '。';
  }

  /** 两种盐混合：称取 X g A 和 Y g B，调 pH，定容 */
  function stepsForTwoSalts(acidLabel, massAcid, baseLabel, massBase, pH, volL) {
    const a = U.formatMass(massAcid);
    const b = U.formatMass(massBase);
    const v = U.formatVol(volL);
    const pre = U.formatVol(volL * 0.8);
    return '称取 ' + a.text + ' ' + acidLabel + ' 和 ' + b.text + ' ' + baseLabel
      + '，溶于约 ' + pre.text + ' 去离子水，调 pH 至 ' + U.formatPH(pH)
      + '，定容至 ' + v.text + '。';
  }

  const api = {
    massForSolution, tempShift, distribution, speciesFractions, pKasAtTemp,
    polyproticRatio, estimateIonicStrength, ionicWarning,
    dilution, systemMix, stepsForSolution, stepsForTwoSalts
  };
  global.Calc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
