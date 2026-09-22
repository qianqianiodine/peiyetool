/* 缓冲体系数据 —— 表驱动。加新体系只需在此加一条，界面与计算自动支持。
 *
 * 温度换算用 pKa25 + dpKa（对多质子酸取主导 pKa）；
 * 配比计算用完整 pKas 数组做分布计算。两者共用同一份 pKa 数据，避免漂移。
 *
 * 全部为 25 °C、无限稀释的热力学值（离子强度 I = 0）。
 * 高离子强度下表观 pKa 会下移，界面需提示用户实测校准。
 */
(function (global) {
  'use strict';

  const BUFFERS = [
    { id: 'tris', name: 'Tris', kind: 'mono',
      pKa25: 8.06, dpKa: -0.028, range: [7.0, 9.0] },

    { id: 'hepes', name: 'HEPES', kind: 'mono',
      pKa25: 7.55, dpKa: -0.014, range: [6.8, 8.2] },

    { id: 'bis-tris', name: 'Bis-Tris', kind: 'mono',
      pKa25: 6.46, dpKa: -0.017, range: [5.8, 7.2] },

    { id: 'btp', name: 'Bis-Tris propane', kind: 'mono',
      pKa25: 6.80, dpKa: -0.017, range: [6.3, 9.5] },

    { id: 'mes', name: 'MES', kind: 'mono',
      pKa25: 6.10, dpKa: -0.011, range: [5.5, 6.7] },

    { id: 'phosphate', name: '磷酸盐', kind: 'poly',
      pKas: [2.15, 7.20, 12.35], dominant: 1,
      pKa25: 7.20, dpKa: -0.0028, range: [5.8, 8.0] },

    { id: 'citrate', name: '柠檬酸盐', kind: 'poly',
      pKas: [3.13, 4.76, 6.40], dominant: 1,
      pKa25: 4.76, dpKa: -0.0015, range: [3.0, 6.2] }
  ];

  /* 多质子酸配比体系：酸形式 + 碱形式两种盐直接混合，不用滴定。
   * za/zb 为酸/碱形式的电荷数，用于解出两者摩尔比。 */
  const POLY_SYSTEMS = [
    { id: 'k-phosphate', name: '磷酸钾', bufferId: 'phosphate',
      acid: { reagentId: 'kh2po4', label: 'KH₂PO₄' },
      base: { reagentId: 'k2hpo4', label: 'K₂HPO₄' },
      za: 1, zb: 2 },

    { id: 'na-phosphate', name: '磷酸钠', bufferId: 'phosphate',
      acid: { reagentId: 'nah2po4', label: 'NaH₂PO₄' },
      base: { reagentId: 'na2hpo4', label: 'Na₂HPO₄' },
      za: 1, zb: 2 },

    { id: 'citrate', name: '柠檬酸', bufferId: 'citrate',
      acid: { reagentId: 'citric-acid', label: '柠檬酸' },
      base: { reagentId: 'na3citrate', label: '柠檬酸三钠' },
      za: 0, zb: 3 }
  ];

  const _bufById = {}, _polyById = {};
  BUFFERS.forEach(b => { _bufById[b.id] = b; });
  POLY_SYSTEMS.forEach(s => { _polyById[s.id] = s; });

  const bufferById = id => _bufById[id] || null;
  const polyById = id => _polyById[id] || null;

  /** 体系适用的温度系数：单 pKa 用自身，多质子酸用主导 pKa 的系数 */
  function dominant(buffer) {
    return {
      pKa25: buffer.pKa25,
      dpKa: buffer.dpKa,
      index: buffer.kind === 'poly' ? buffer.dominant : 0
    };
  }

  const api = { BUFFERS, POLY_SYSTEMS, bufferById, polyById, dominant };
  global.Buffers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
