/* 试剂表导入解析 —— 纯函数，无 DOM。
 *
 * 为什么单独一个文件：解析是这一步唯一「有逻辑」的地方，抽出来之后
 * tools/verify.js 能直接 require 它喂脏数据单测，不用起浏览器。
 *
 * 支持两种来源：
 *   ① 从 Excel 直接复制粘贴（制表符分隔）—— 主推这个，粘贴板里是纯文本，
 *      没有编码问题，对非技术用户也最简单
 *   ② CSV 文件（逗号分隔）—— 中文 Windows 上 Excel「另存为 CSV」默认是 GBK，
 *      读文件时要先探测编码，那部分在 app.js 里（浏览器 API），不在这儿
 *
 * 列的顺序（有表头就按表头认，没有就按这个顺序）：
 *   中文名 英文名 分子量 CAS 位置 分组 分子式 品牌 溶剂 备注
 */
(function (global) {
  'use strict';

  /* 列名识别。两个约定：
     ① **en 必须排在 zh 前面** —— zh 那条兜底的 /名称/ 会把「英文名称」抢走，
        先让 en 认领掉所有以「英文」开头的列，zh 才能放心用宽匹配。
     ② 每个字段「先精确后宽松」，精确的那条要求整格相等。 */
  const FIELDS = [
    ['en',      [/^(英文名|英文名称|英文)$/, /^english/i, /english/i, /name[_\s-]?en/i, /^name$/i]],
    ['zh',      [/^(中文名|中文名称|中文)$/, /^chinese/i, /chinese/i,
                 /名称/, /^化合物名?称?$/, /^试剂名?称?$/]],
    ['mw',      [/^(分子量|分子质量|摩尔质量|mw|molwt|molecular\s*weight)/i, /分子量/]],
    ['cas',     [/^cas\s*(no\.?|号|编号|登记号|number)?$/i, /cas/i]],
    // 「编号」单列也算位置编号 —— 实验室的库存表就是「编号/英文名/中文名」这样排的。
    // 它不会和 CAS 抢：cas 那条要求整格以 cas 开头，「编号」到不了那儿
    ['code',    [/^(位置编号|存放位置|货架位置|位置|货位|位号|编号|location|position|code|slot)$/i,
                 /(位置|货位|位号)/]],
    ['tag',     [/^(货架|货架号|柜子|柜号|分组|组别|类别|分类|shelf|group|category|cabinet)$/i,
                 /(货架|柜|分组|类别)/]],
    ['formula', [/^(分子式|化学式|formula)$/i, /分子式/]],
    ['brand',   [/^(品牌|厂家|厂商|供应商|生产商|brand|supplier|vendor)$/i, /(品牌|厂家|厂商|供应商)/]],
    ['solvent', [/^(溶剂|溶解性|solvent)$/i, /溶剂/]],
    ['note',    [/^(备注|说明|注释|note|remark|comment|memo)$/i, /(备注|说明|注释)/]]
  ];

  /** 这个单元格的内容像不像表头 */
  function looksLikeHeader(cells) {
    let hit = 0;
    cells.forEach(c => {
      const t = String(c || '').trim();
      if (!t) return;
      if (FIELDS.some(([, pats]) => pats.some(p => p.test(t)))) hit++;
    });
    // 至少两个单元格认得出，且没有一个单元格长得像分子量数字
    return hit >= 2 && !cells.some(c => /^\d+(\.\d+)?$/.test(String(c || '').trim()));
  }

  /** 一行表头 → { 字段名: 列下标 }。认不出的列会被调用方报出来 */
  function mapHeader(cells) {
    const map = {}, unknown = [];
    cells.forEach((c, i) => {
      const t = String(c || '').trim();
      if (!t) return;
      for (const [field, pats] of FIELDS) {
        if (map[field] != null) continue;              // 一个字段只认第一列
        if (pats.some(p => p.test(t))) { map[field] = i; return; }
      }
      unknown.push(t);
    });
    return { map, unknown };
  }

  /** 探测分隔符：看前几行谁切出来的列数最一致。制表符优先（粘贴路径最常见） */
  function detectDelim(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 5);
    if (!lines.length) return '\t';
    const score = d => {
      const n = lines.map(l => l.split(d).length - 1);
      if (n[0] === 0) return -1;                       // 第一行一个分隔符都没有
      // 每行列数一致 = 更像真的分隔符（逗号在备注里可能零星出现，列数就不齐）
      return n.every(x => x === n[0]) ? n[0] * 10 : n[0];
    };
    let best = '\t', bestScore = -1;
    ['\t', ',', '，', ';'].forEach(d => {
      const s = score(d);
      if (s > bestScore) { bestScore = s; best = d; }
    });
    return best;
  }

  /**
   * 按分隔符切行。用状态机而不是 split —— 因为引号里的分隔符和换行
   * 都只是内容（Excel 导出的 CSV 里，带逗号的备注就会被引号包起来）。
   *
   * 返回 [{ cells, line }]，line 是这行在**原文里**的行号。
   * 这个行号必须在这里记 —— 调用方会把空行滤掉，滤完再数行号就全错位了，
   * 而用户正是拿着这个行号去自己的 Excel 里定位，错一行等于白报。
   */
  function splitRows(text, delim) {
    const rows = [];
    let row = [], cell = '', inQ = false, line = 1, rowLine = 1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }   // 转义的引号
          else inQ = false;
        } else {
          cell += c;
          if (c === '\n') line++;                          // 引号里的换行也是换行
        }
      } else if (c === '"') {
        inQ = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push({ cells: row, line: rowLine });
        row = []; cell = ''; line++; rowLine = line;
      } else if (c !== '\r') {
        cell += c;                                          // \r 丢掉，由 \n 收行
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push({ cells: row, line: rowLine }); }
    return rows;
  }

  /** 分子量单元格 → 数字。允许带单位（180.16 g/mol）、带空格 */
  function parseMw(raw) {
    const s = String(raw == null ? '' : raw).replace(/[（(].*?[)）]/g, '')
      .replace(/g\s*\/?\s*mol/ig, '').replace(/[，,\s]/g, '').trim();
    if (!s) return NaN;
    const v = Number(s);
    return isFinite(v) && v > 0 ? v : NaN;
  }

  const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

  /** 单元格 → 干净字符串 */
  const cell = v => String(v == null ? '' : v).trim();

  /**
   * 主入口。
   * 返回 { ok, records, problems, header, delim, counts }
   *  · records —— 解析成功的记录，形状和 Store 里存的一致
   *  · problems —— [{ line, level:'error'|'warn', msg }]，line 是**用户看到的行号**
   *                （从 1 开始，含表头；这样他能在自己的 Excel 里直接定位）
   */
  function parseTable(text) {
    const raw = String(text == null ? '' : text).replace(/^﻿/, '');   // 去 BOM
    const out = { ok: false, records: [], problems: [], header: null, delim: '\t',
                  counts: { total: 0, good: 0, bad: 0 } };
    if (!raw.trim()) {
      out.problems.push({ line: 0, level: 'error', msg: '内容是空的' });
      return out;
    }

    const delim = detectDelim(raw);
    out.delim = delim;
    // 空行丢掉，但行号是 splitRows 记好的，不受过滤影响
    const rows = splitRows(raw, delim).filter(r => r.cells.some(c => cell(c) !== ''));
    if (!rows.length) {
      out.problems.push({ line: 0, level: 'error', msg: '没解析出任何一行' });
      return out;
    }

    /* 表头：认得出就按表头映射；认不出就按固定顺序，并在界面上说明是按顺序读的 */
    const ORDER = ['zh', 'en', 'mw', 'cas', 'code', 'tag', 'formula', 'brand', 'solvent', 'note'];
    const headLine = rows[0].line;
    let map, startRow;
    if (looksLikeHeader(rows[0].cells)) {
      const h = mapHeader(rows[0].cells);
      map = h.map; startRow = 1;
      out.header = { detected: true, unknown: h.unknown, line: headLine };
      if (h.unknown.length) {
        out.problems.push({ line: headLine, level: 'warn',
          msg: '这几个列名认不出来，已跳过：' + h.unknown.join('、') });
      }
      const known = Object.keys(map);
      if (!known.length) {
        out.problems.push({ line: headLine, level: 'error',
          msg: '表头一列都没认出来。请用这些列名：中文名 / 英文名 / 分子量 / CAS / 位置 / 分组 / 分子式 / 品牌 / 溶剂 / 备注' });
        return out;
      }
      if (map.zh == null && map.en == null) {
        out.problems.push({ line: headLine, level: 'error', msg: '表头里缺少「中文名」或「英文名」列' });
        return out;
      }
    } else {
      map = {};
      ORDER.forEach((f, i) => { map[f] = i; });
      startRow = 0;
      out.header = { detected: false, cols: Math.max.apply(null, rows.map(r => r.cells.length)) };
    }

    const pick = (r, f) => (map[f] == null ? '' : cell(r[map[f]]));

    for (let i = startRow; i < rows.length; i++) {
      const lineNo = rows[i].line;                // 原文里的行号，用户照着这个去 Excel 找
      const r = rows[i].cells;
      const rec = {
        zh: pick(r, 'zh'), en: pick(r, 'en'), cas: pick(r, 'cas'),
        code: pick(r, 'code'), tag: pick(r, 'tag'), formula: pick(r, 'formula'),
        brand: pick(r, 'brand'), solvent: pick(r, 'solvent'), note: pick(r, 'note')
      };
      out.counts.total++;

      if (!rec.zh && !rec.en) {
        out.problems.push({ line: lineNo, level: 'error',
          msg: '既没有中文名也没有英文名，这行跳过了' });
        out.counts.bad++;
        continue;
      }
      // CAS 写错了就丢掉，别让它以后按 CAS 查时误命中别的东西
      if (rec.cas && !CAS_RE.test(rec.cas)) {
        out.problems.push({ line: lineNo, level: 'warn',
          msg: 'CAS「' + rec.cas + '」格式不对（应该像 50-99-7），已忽略这一格' });
        rec.cas = '';
      }
      const mwRaw = pick(r, 'mw');
      const mw = parseMw(mwRaw);
      if (isFinite(mw)) rec.mw = mw;
      else if (mwRaw) {
        out.problems.push({ line: lineNo, level: 'warn',
          msg: '分子量「' + mwRaw + '」看不懂，这行只能查到位置、算不了称量' });
      } else {
        out.problems.push({ line: lineNo, level: 'warn',
          msg: '没有分子量，这行只能查到位置、算不了称量' });
      }
      out.records.push(rec);
    }

    out.counts.good = out.records.length;
    out.ok = out.records.length > 0;
    if (!out.ok && !out.problems.some(p => p.level === 'error')) {
      out.problems.push({ line: 0, level: 'error', msg: '一行都没解析出来' });
    }
    return out;
  }

  const api = { parseTable, detectDelim, splitRows, parseMw, mapHeader, looksLikeHeader, FIELDS };
  global.InventoryImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
