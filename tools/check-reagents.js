/* 内置试剂库核验 —— node tools/check-reagents.js
 * 把每条内置记录的 CAS 号发给 NCI Cactus，比对返回的分子量。
 * 只报告差异供人工判断，不自动改数据：Cactus 偶尔会匹配到衍生物（如 Triton X-100）。
 */
'use strict';

const path = require('path');
const Reagents = require(path.join(__dirname, '..', 'js', 'data-reagents.js'));

const BASE = 'https://cactus.nci.nih.gov/chemical/structure/';
const CONCURRENCY = 3;
const TIMEOUT_MS = 15000;

/* ── 已人工核验的 Cactus 假警报 ─────────────────────────────
 * Cactus 的 CAS 索引存在两类系统性问题，都会让核验误报：
 *   (a) 索引指向同一化合物的其他形式（盐水合物对不上）
 *   (b) 部分 CAS 完全没有索引，直接 404
 * 下列条目已逐条人工核对过，本库数值正确，Cactus 才是错的一方。
 * 核验依据写在每条的说明里，方便日后复查。 */
const KNOWN_CACTUS_ERRORS = {
  '7365-45-9':
    'Cactus 返回 C8H17N2NaO4S（那是 HEPES 钠盐的分子式）。'
    + 'HEPES free acid 为 C8H18N2O4S = 238.30，本库正确。',
  '145224-94-8':
    'Cactus 的 CAS 索引指向无水物 C6H13NO4S。'
    + '按名称 MES monohydrate 查得 C6H15NO5S = 213.2482，与本库 213.25 一致。',
  '51805-45-9':
    'Cactus 返回 C9H12O6P = 247.16（比 TCEP 游离酸还少 3 个 H）。'
    + 'TCEP·HCl 标准值 C9H16ClO6P = 286.65，本库正确。',
  '10049-21-5':
    'Cactus 的 CAS 索引返回 H5NaO5P = 139.0。'
    + '按名称查得 H4NaO5P = 137.9921，与本库 137.99 一致。'
};

/** Cactus 完全没有收录的 CAS（返回 404，非网络问题） */
const CACTUS_NO_COVERAGE = ['7778-77-0', '16788-57-1', '7558-80-7', '13472-35-0'];

/** 返回 { status: 'ok'|'nocoverage'|'notfound'|'error', mw } */
async function mwFromCactus(cas) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + encodeURIComponent(cas) + '/mw', { signal: ctl.signal });
    if (res.status === 404) return { status: 'nocoverage' };  // 该 CAS 未收录
    if (!res.ok) return { status: 'notfound' };               // 名称查不到时为 500
    const t = (await res.text()).trim();
    const v = parseFloat(t.split('\n')[0]);
    return isFinite(v) && v > 0 ? { status: 'ok', mw: v } : { status: 'notfound' };
  } catch (e) {
    return { status: 'error' };
  } finally { clearTimeout(timer); }
}

/** 展开成 [{ reagent, form }]，每种形式单独核验 */
function expand() {
  const rows = [];
  Reagents.REAGENTS.forEach(r => {
    if (r.forms) r.forms.forEach(f => rows.push({ r, f }));
    else rows.push({ r, f: { label: '默认', cas: r.cas, mw: r.mw } });
  });
  return rows;
}

async function run() {
  const rows = expand();
  console.log('\n内置试剂库核验 —— 数据源 NCI Cactus');
  console.log('共 ' + rows.length + ' 条记录\n' + '='.repeat(78));

  const results = new Array(rows.length);
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const { r, f } = rows[i];
      const res = await mwFromCactus(f.cas);
      results[i] = { r, f, res };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tally = { agree: 0, known: 0, polymer: 0, mismatch: 0, nocov: 0 };
  const flagged = [];

  console.log(
    pad('化合物', 26) + pad('形式', 8) + pad('CAS', 14)
    + pad('本地', 10) + pad('Cactus', 10) + '偏差'
  );
  console.log('-'.repeat(78));

  results.forEach(({ r, f, res }) => {
    let mark = '', devTxt = '';
    const isKnown = !!KNOWN_CACTUS_ERRORS[f.cas];
    const isNoCov = CACTUS_NO_COVERAGE.includes(f.cas);

    if (res.status !== 'ok') {
      tally.nocov++;
      devTxt = res.status === 'nocoverage' ? 'Cactus 未收录' : '远端查不到';
      if (isNoCov) mark = '\u001b[90m  --\u001b[0m';
      else { mark = '\u001b[33m  ??\u001b[0m'; flagged.push({ r, f, kind: 'nocoverage' }); }
    } else {
      const dev = (res.mw - f.mw) / f.mw * 100;
      devTxt = dev.toFixed(3) + '%';
      if (Math.abs(dev) < 0.05) {
        tally.agree++; mark = '\u001b[32m  ok\u001b[0m';
      } else if (r.mwAvg) {
        tally.polymer++; mark = '\u001b[36m avg\u001b[0m';
        devTxt += '  聚合物，分子量本就不唯一';
      } else if (isKnown) {
        tally.known++; mark = '\u001b[90m  --\u001b[0m';
        devTxt += '  已知 Cactus 索引错误';
      } else {
        tally.mismatch++; mark = '\u001b[31m  !! \u001b[0m';
        flagged.push({ r, f, kind: 'mismatch', dev, remote: res.mw });
      }
    }
    console.log(
      pad(r.name, 26) + pad(f.label, 8) + pad(f.cas, 14)
      + pad(String(f.mw), 10)
      + pad(res.status === 'ok' ? res.mw.toFixed(4) : '-', 10)
      + devTxt + mark
    );
  });

  console.log('='.repeat(78));
  console.log('一致 ' + tally.agree
    + ' ｜ 已知 Cactus 索引问题 ' + tally.known
    + ' ｜ 聚合物 ' + tally.polymer
    + ' ｜ Cactus 未收录 ' + tally.nocov
    + ' ｜ 待确认 ' + tally.mismatch);

  if (tally.mismatch || flagged.some(x => x.kind === 'nocoverage')) {
    console.log('\n需要人工确认的条目：');
    flagged.forEach(({ r, f, kind, dev, remote }) => {
      console.log('  · ' + r.name + ' [' + f.label + '] CAS ' + f.cas
        + '  本地 ' + f.mw
        + (remote != null ? ' / Cactus ' + remote.toFixed(4) : '')
        + (kind === 'mismatch' ? '  偏差 ' + dev.toFixed(2) + '%' : '  ' + kind));
    });
    console.log('\n处置方式：人工核对分子式后，正确的一方保留，');
    console.log('确认是 Cactus 索引问题的，加进 KNOWN_CACTUS_ERRORS 白名单。');
  } else {
    console.log('\n无新增待确认条目。');
  }
  console.log('');
}

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += /[一-龥（）：]/.test(ch) ? 2 : 1;   // 中文按 2 宽度算
  return s + ' '.repeat(Math.max(0, n - w));
}

run().catch(e => { console.error('核验失败：', e.message); process.exit(1); });
