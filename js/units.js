/* 单位换算与数值格式化 —— 纯函数，无 DOM / 无网络 / 无存储 */
(function (global) {
  'use strict';

  /* 微符号有两个 Unicode 码点（U+00B5 MICRO SIGN / U+03BC GREEK MU），
   * 用户输入法和粘贴来源不同会混用，统一归一化到 U+03BC。 */
  const norm = s => String(s == null ? '' : s).replace(/[µμ]/g, 'μ').trim();

  const CONC = {
    'M':     { factor: 1,    kind: 'molar' },
    'mM':    { factor: 1e-3, kind: 'molar' },
    'μM': { factor: 1e-6, kind: 'molar' },
    'nM':    { factor: 1e-9, kind: 'molar' },
    'mg/mL': { factor: 1,    kind: 'mass' },
    '%':     { factor: 1,    kind: 'relative' },
    '×': { factor: 1,   kind: 'relative' }   // ×
  };

  const VOL = {
    'L':       { factor: 1,    },
    'mL':      { factor: 1e-3, },
    'μL': { factor: 1e-6 }   // μL
  };

  const MASS = {
    'g':       { factor: 1,    },
    'mg':      { factor: 1e-3, },
    'μg': { factor: 1e-6 }   // μg
  };

  const CONC_UNITS  = Object.keys(CONC);
  const VOL_UNITS   = Object.keys(VOL);
  const MASS_UNITS  = Object.keys(MASS);

  /* 只要摩尔浓度的那几项。凡是「乘除分子量」「除以母液浓度」的地方都得用这份 ——
   * % / × / mg/mL 的换算系数都是 1，放进摩尔浓度的算式里会被静默当成 mol/L。 */
  const MOLAR_UNITS = CONC_UNITS.filter(u => CONC[u].kind === 'molar');

  function concFactor(u) { const k = CONC[norm(u)]; if (!k) throw new Error('未知浓度单位: ' + u); return k.factor; }
  function volFactor(u)  { const k = VOL[norm(u)];  if (!k) throw new Error('未知体积单位: ' + u); return k.factor; }
  function massFactor(u) { const k = MASS[norm(u)]; if (!k) throw new Error('未知质量单位: ' + u); return k.factor; }

  const toMolar   = (v, u) => Number(v) * concFactor(u);      // → mol/L
  const toLiter   = (v, u) => Number(v) * volFactor(u);       // → L
  const toGram    = (v, u) => Number(v) * massFactor(u);      // → g
  const fromGram  = (g, u) => Number(g) / massFactor(u);      // g → 指定质量单位
  const fromLiter = (l, u) => Number(l) / volFactor(u);       // L → 指定体积单位

  /* ── 数值格式化 ─────────────────────────────────────── */

  /** n 位有效数字 */
  function sigFigs(x, n) {
    if (!isFinite(x)) return 0;
    if (x === 0) return 0;
    const digits = Math.ceil(Math.log10(Math.abs(x)));
    const p = (n || 3) - digits;
    const m = Math.pow(10, p);
    return Math.round(x * m) / m;
  }

  /** 保留 d 位小数（用 EPS 补偿浮点表示误差，避免 129.035 掉成 129.03） */
  function fixed(x, d) {
    if (!isFinite(x)) return 0;
    const m = Math.pow(10, d);
    return Math.round((x + Number.EPSILON * Math.abs(x)) * m) / m;
  }

  /** 去掉尾部多余的 0，让 1.500 显示成 1.5 */
  function trim(s) {
    return String(s).includes('.') ? String(s).replace(/0+$/, '').replace(/\.$/, '') : String(s);
  }

  /** 质量自动选单位：≥1 g 用 g，≥1 mg 用 mg，否则 μg */
  function pickMassUnit(g) {
    const a = Math.abs(g);
    if (a >= 1) return 'g';
    if (a >= 1e-3) return 'mg';
    return 'μg';
  }

  /** 质量 → { value, unit, text }；g 级保留 2 位小数（实验室称量精度） */
  function formatMass(g, opts) {
    const o = opts || {};
    const unit = o.unit || pickMassUnit(g);
    const v = fromGram(g, unit);
    const d = o.decimals != null ? o.decimals : (unit === 'g' ? 2 : (unit === 'mg' ? 2 : 1));
    const value = fixed(v, d);
    return { value, unit, text: trim(value.toFixed(d)) + ' ' + unit };
  }

  /** 体积 → { value, unit, text }，按 3 位有效数字 */
  function formatVol(liter, opts) {
    const o = opts || {};
    const a = Math.abs(liter);
    const unit = o.unit || (a >= 1 ? 'L' : (a >= 1e-3 ? 'mL' : 'μL'));
    const v = liter / volFactor(unit);
    const n = o.sig != null ? o.sig : 3;
    const value = sigFigs(v, n);
    return { value, unit, text: trim(value) + ' ' + unit };
  }

  /** 摩尔浓度 → { value, unit, text }，按 3 位有效数字，自动选单位 */
  function formatConc(molar, opts) {
    const o = opts || {};
    const a = Math.abs(molar);
    let unit = o.unit;
    if (!unit) unit = a >= 1 ? 'M' : (a >= 1e-3 ? 'mM' : (a >= 1e-6 ? 'μM' : 'nM'));
    const v = molar / concFactor(unit);
    const n = o.sig != null ? o.sig : 3;
    const value = sigFigs(v, n);
    return { value, unit, text: trim(value) + ' ' + unit };
  }

  /** pH：固定 2 位小数 */
  function formatPH(x) {
    return fixed(x, 2).toFixed(2);
  }

  /** 通用的"按有效数字输出" */
  function formatSig(x, n) {
    return trim(sigFigs(x, n == null ? 3 : n));
  }

  /** 解析用户输入的数字，非法返回 NaN（不抛异常，交给调用方给提示） */
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    const s = norm(v).replace(/\s/g, '').replace(/,/g, '');
    if (!s) return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  const api = {
    norm, CONC, VOL, MASS, CONC_UNITS, VOL_UNITS, MASS_UNITS, MOLAR_UNITS,
    concFactor, volFactor, massFactor,
    toMolar, toLiter, toGram, fromGram, fromLiter,
    sigFigs, fixed, trim, pickMassUnit,
    formatMass, formatVol, formatConc, formatPH, formatSig, num
  };
  global.Units = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
