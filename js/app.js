/* 主逻辑 —— 导航、四个模块、历史、设置 */
(function (global) {
  'use strict';

  const U = global.Units, Calc = global.Calc, Reagents = global.Reagents,
        Buffers = global.Buffers, ZhData = global.ZhData, Store = global.Store,
        Lookup = global.Lookup, UI = global.UI,
        // 试剂位置表（合并内置数据与用户导入）和它的表格解析器
        Inventory = global.Inventory, InvImport = global.InventoryImport;
  const { $, $$, esc, toast, bindCopy } = UI;

  const SUBS = ['quick', 'ph', 'system', 'dilution'];
  const TITLES = {
    home: '配液计算器', quick: '快速配液', ph: '缓冲体系 pH',
    system: '体系配置', dilution: '母液稀释', history: '历史记录', settings: '设置'
  };

  let settings = Store.settingsGet();
  let currentView = 'home';

  /* ══ 路由 ═══════════════════════════════════════════ */
  function go(view, push) {
    currentView = view;
    $$('.view').forEach(v => { v.hidden = (v.id !== 'view-' + view); });

    const isSub = SUBS.indexOf(view) >= 0;
    $('#topTitle').textContent = TITLES[view] || '';
    $('#btnBack').hidden = !isSub;

    $$('.tabbtn').forEach(b => {
      const on = b.dataset.view === view || (isSub && b.dataset.view === 'home');
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    if (view === 'history') renderHistory();
    if (view === 'settings') renderSettings();
    if (push !== false) {
      try { history.pushState({ view }, '', '#' + view); } catch (e) { location.hash = view; }
    }
    global.scrollTo(0, 0);
  }

  /* ══ 通用 ═══════════════════════════════════════════ */
  function fillSelect(sel, units, def) {
    if (!sel) return;
    sel.innerHTML = '';
    units.forEach(u => {
      const o = document.createElement('option');
      o.value = u; o.textContent = u;
      if (u === def) o.selected = true;
      sel.appendChild(o);
    });
  }

  /** 读一个带单位的输入，返回基准单位值；非法返回 NaN */
  function readQty(inputSel, unitSel, toBase) {
    const v = U.num($(inputSel).value);
    const u = $(unitSel).value;
    if (!isFinite(v)) return NaN;
    return toBase(v, u);
  }

  function requirePos(v, msg) {
    if (!isFinite(v) || v <= 0) { toast(msg, 'error'); return false; }
    return true;
  }

  /** 浓度的显示文本。摩尔单位归一化成 M / mM / μM（1 mM 比 0.001 M 好读）；
   *  % / × / mg/mL 之间没有换算关系，照用户填的原样显示，% 和 × 紧贴数字。
   *  不能一律走 formatConc —— 那个只认摩尔浓度，会把 10% 写成 "10 M"。 */
  function concLabel(v, u) {
    const n = U.norm(u);
    const k = U.CONC[n];
    if (k && k.kind === 'molar') return U.formatConc(v * k.factor).text;
    return (n === '%' || n === '×') ? v + n : v + ' ' + n;
  }

  function prefersReduced() {
    return !!(global.matchMedia
      && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** 结果区在长表单下方，算完把它滚进视野，省得用户自己找 */
  function revealOut(el) {
    if (!el || !el.scrollIntoView) return;
    el.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
  }

  /* ── 历史回放 ─────────────────────────────────────────
   * 「重新调出」只把参数填回表单，**不重算**（2026-09-25 用户要求）：
   * 用户点计算 / 回车时才算，那次会照常存历史、并问要不要覆盖原来那条。
   * 所以这里不需要「回放标志」—— 从历史跳过来的计算和手输的没有区别。 */

  /** 存一条历史记录，返回它（结果区要拿到 id 才能往上面打标签） */
  function saveHistory(module, title, summary, payload) {
    const rec = Store.historyAdd({ module, title, summary, payload });
    if (currentView === 'history') renderHistory();
    return rec;
  }

  /* 现在这份表单是从哪条历史记录调出来的 —— 由 recall 设置。点计算时靠它决定要不要问
     「覆盖」：从零算的没得覆盖，不问。 */
  let editingRec = null;

  /** 这次算出来的结果写进哪条历史？返回写进去的那条 id（结果区的标签行要指向它）。
   *  在调出来的那份表单上点计算会先问一句：答「是」更新原来那条，答「否」另存一条新的。
   *  从零算的不进这套 —— 本来就没有「原来那条」，问了也没意义。 */
  async function saveResult(module, title, summary, payload) {
    const linked = editingRec && editingRec.module === module ? editingRec : null;
    if (linked) {
      const ok = await UI.askConfirm('确定覆盖原来那条记录？');
      if (ok) {
        Store.historyUpdate(linked.id, { title, summary, payload });
        if (currentView === 'history') renderHistory();   // historyUpdate 不会自己刷
        return linked.id;
      }
    }
    const id = saveHistory(module, title, summary, payload).id;
    // 接着编辑的是刚存下这条 —— 但只在本来就有「原来那条」时才接上，
    // 否则从零算的第二次计算就会平白无故问一句「覆盖吗」
    if (linked) editingRec = { module, id };
    return id;
  }

  /* ══ 模块一：快速配液 ═══════════════════════════════ */
  let quickFormLabel = null;   // 用户为本次查询选定的形式
  let quickShelfPick = null;   // 用户选定的货架位置（同名多瓶且分子量不同时）
  let quickFormQuery = '';     // 上面两个选择对应的化合物名，换了名字就作废

  /* ══ 批量清单（快速配液 / 母液稀释共用）═══════════════
   * 只活在内存里，刷新即失 —— 要留下来就点「保存到历史」整批存成一条。
   * savedId 指向这份清单存进历史后的那条记录：有了它，再点保存是「更新」而不是又存一条。 */
  const BATCHCFG = {
    quick:    { box: '#q-batch', tagKey: 'quickBatch',    tagbox: 'q-batch-tagbox' },
    dilution: { box: '#d-batch', tagKey: 'dilutionBatch', tagbox: 'd-batch-tagbox' }
  };
  const qBatch = { on: false, entries: [], savedId: null };
  const dBatch = { on: false, entries: [], savedId: null };
  const batchOf = kind => (kind === 'quick' ? qBatch : dBatch);

  /** fresh：这一轮是「重新开始算」（点计算、按回车、调出历史）——
   *  上次给这个化合物选的形式 / 货架不作数，要重新摆出来问一遍。
   *  点选项的回调不传 fresh：否则选完又弹，永远算不出结果。 */
  async function runQuick(fresh) {
    const q = $('#q-name').value.trim();
    if (!q) { toast('请输入化合物名称或 CAS 号', 'error'); $('#q-name').focus(); return; }
    // 换了名字（如点了「你是不是想找」）也一样作废 —— 上次的选择是给别的化合物的
    if (fresh || q !== quickFormQuery) {
      quickFormLabel = null; quickShelfPick = null; quickFormQuery = q;
    }

    // 上一轮结果的标签状态作废（每算一次都会存成新的一条历史记录）
    tagBarReset('quick');
    // 上一次「要你回话」的卡也作废 —— 这次要么重新问、要么就算出来了。
    // 不清的话，上次那张「查不到，请手填分子量」会一直压在输入框下面
    $('#q-ask').innerHTML = '';

    const conc = readQty('#q-conc', '#q-concu', U.toMolar);
    const vol  = readQty('#q-vol', '#q-volu', U.toLiter);
    if (!requirePos(conc, '浓度必须大于 0')) return;
    if (!requirePos(vol, '体积必须大于 0')) return;

    const btn = $('#q-calc');
    btn.disabled = true; btn.textContent = '查询中…';

    let r;
    try {
      r = await Lookup.lookup(q, { settings, formLabel: quickFormLabel,
                                   shelfTag: quickShelfPick && quickShelfPick.tag,
                                   shelfCode: quickShelfPick && quickShelfPick.code });
    } catch (e) { r = { ok: false, reason: 'error', query: q }; }

    btn.disabled = false; btn.textContent = qBatch.on ? '加入清单' : '计算';

    if (!r.ok) {
      // 货架上几瓶分子量不同 → 摆出来让用户点，别替他挑
      if (r.reason === 'shelf-choice') { renderQuickShelfPick(r); return; }
      renderQuickFail(q, r);
      return;
    }
    // 有多种形式又没指定 → 先让用户选，选错形式等于称错药
    if (r.forms && !r.formPicked) { renderQuickPick(r, conc, vol); return; }

    const mass = Calc.massForSolution(conc, vol, r.mw);

    // 批量模式：不逐条写历史，攒进清单（底部可以整批存成一条）
    if (qBatch.on) {
      quickBatchPush(r, conc, vol, mass);
      renderQuickOk(r, conc, vol, mass, true);
      return;
    }

    // 回放不新增记录：标签还打在原来那条上。否则每"重新调出"一次就多一条重复的
    /* 标题用 displayName 而不是 r.name：按 CAS 查没取到名字时 r.name 是空串，
       直接传下去历史里会是一条没有标题的记录 */
    TAGBAR.quick.id = await saveResult('quick', displayName(r), U.formatMass(mass).text,
      { query: q, conc, concUnit: 'M', vol, volUnit: 'L' });
    renderQuickOk(r, conc, vol, mass);
  }

  /** 货架上同名几瓶但分子量不同（无水物 / 水合物）：让用户点自己在拿哪一瓶 */
  function renderQuickShelfPick(r) {
    const html = ''
      + '<div class="result">'
      +   '<div class="result-label">货架上「' + esc(r.query) + '」有 ' + r.locations.length
      +     ' 瓶，分子量不一样，选你手上那瓶</div>'
      +   '<div class="forms-pick">'
      +     r.locations.map((p, i) =>
            '<button type="button" class="fcard" data-shelf="' + i + '">'
            + '<span class="fcard-lbl">' + esc(p.tag) + '　' + esc(p.code) + '</span>'
            + '<span class="fcard-mw">' + esc(String(p.mw)) + '<i>g/mol</i></span>'
            + '<span class="fcard-formula">' + esc(p.zh || p.en)
            +   (p.formula ? '　' + esc(p.formula) : '') + '</span>'
            + '</button>').join('')
      +   '</div>'
      +   '<div class="note">水合物差几个水，分子量差很多（如无水乙酸钠 82.03、'
      +     '三水合物 136.08）。按瓶子上的分子式选。</div>'
      + '</div>';

    const out = $('#q-ask');        // 要用户回话的卡都放这儿，不滚（紧贴输入卡片）
    out.innerHTML = html;
    $$('[data-shelf]', out).forEach(b => b.addEventListener('click', () => {
      const p = r.locations[Number(b.dataset.shelf)];
      quickShelfPick = { tag: p.tag, code: p.code };
      runQuick();
    }));
  }

  /** 形式未定：把候选摆出来让用户点，点完带着选择重查一次 */
  function renderQuickPick(r, conc, vol) {
    const html = ''
      + '<div class="result">'
      +   '<div class="result-label">这个化合物有几种形式，选一个</div>'
      +   '<div class="pick-name">' + esc(r.name)
      +     (r.zh && r.zh !== r.name ? '<span>' + esc(r.zh) + '</span>' : '') + '</div>'
      +   '<div class="forms-pick">'
      +     r.forms.map(f =>
            '<button type="button" class="fcard" data-qform="' + esc(f.label) + '">'
            + '<span class="fcard-lbl">' + esc(f.name) + '</span>'
            + '<span class="fcard-mw">' + f.mw + '<i>g/mol</i></span>'
            + '<span class="fcard-formula">' + esc(f.formula) + '</span>'
            + '</button>').join('')
      +   '</div>'
      +   '<div class="note">分子量随形式不同，请按手里的试剂瓶选择。</div>'
      + '</div>';

    const out = $('#q-ask');
    out.innerHTML = html;
    $$('[data-qform]', out).forEach(b => b.addEventListener('click', () => {
      quickFormLabel = b.dataset.qform;
      runQuick();
    }));
  }

  function sourceLabel(src) {
    return ({
      // 「试剂位置表」而不是「实验室库存」：这个功能现在也服务导入自己表格的用户，
      // 公开版里根本没有实验室那层数据，叫「实验室库存」会让人莫名其妙
      builtin: '内置库', shelf: '试剂位置表', cache: '本地缓存',
      cactus: 'NCI Cactus', pubchem: 'PubChem', manual: '手动输入'
    })[src] || src;
  }

  /** 记录/清单/操作步骤里显示用的名字。
   *  按 CAS 查而 PubChem 没给 Title 时 r.name 是空串 —— 那时候不能留个空标题，
   *  依次用分子式、CAS 号顶上，都没有才是「该化合物」。 */
  function displayName(r) {
    return r.name || r.formula || r.cas || '该化合物';
  }

  /** 货架位置的「哪个货架 + 哪个编号」。编号才是站在货架前要对的那几个字，
   *  所以它比标签大一号 —— 结果卡和清单都共用这一份，不各写一遍。 */
  function whereChip(p) {
    // 用户导入的表可能只填了位置、没填分组 —— 直接渲染空标签会出一枚空胶囊
    const tag = p.tag ? '<span class="where-tag">' + esc(p.tag) + '</span>' : '';
    return tag + '<span class="where-code">' + esc(p.code) + '</span>';
  }

  /** 结果卡里的货架位置：一个货位一行，还带品牌/溶剂/备注 */
  function whereHtml(locations) {
    if (!locations || !locations.length) return '';
    return locations.map(p =>
      '<div class="where">' + whereChip(p)
      + (p.brand ? '<span class="where-brand">' + esc(p.brand) + '</span>' : '')
      + (p.solvent ? '<span class="where-sub">溶剂 ' + esc(p.solvent) + '</span>' : '')
      + (p.note ? '<span class="where-sub">' + esc(p.note) + '</span>' : '')
      + '</div>').join('');
  }

  function renderQuickOk(r, conc, vol, mass, noReveal) {
    const m = U.formatMass(mass);
    const mwTxt = r.mw.toFixed(2);
    const isLiquid = r.reagentId && Reagents.byId(r.reagentId) && Reagents.byId(r.reagentId).liquid;

    let liquidNote = '';
    if (isLiquid) {
      const rg = Reagents.byId(r.reagentId);
      const ml = mass / (rg.density || 1);
      liquidNote = '<div class="note">该试剂为液体（密度 ' + rg.density
        + ' g/mL），若按体积量取约需 ' + ml.toFixed(2) + ' mL。建议按质量称取。</div>';
    }

    const where = whereHtml(r.locations);

    /* 名字拿不到时（按 CAS 查、PubChem 又没给 Title）不能显示成空行，
       更不能把 CAS 串回填上去 —— 那会和下面「CAS 号」那行一模一样。
       操作步骤里用分子式顶上：「称取 2.92 g C6H12O6」比「称取 2.92 g」有用得多 */
    const stepName = displayName(r);

    const html = ''
      + '<div class="result">'
      +   '<div class="result-head">'
      +     '<div class="result-label">需称取</div>'
      +     '<div class="tagbox" id="q-tagbox"></div>'
      +   '</div>'
      +   '<div class="result-main">'
      +     '<span class="bignum" id="q-mass">' + esc(m.text.split(' ')[0]) + '</span>'
      +     '<span class="bigunit">' + esc(m.unit) + '</span>'
      +   '</div>'
      +   (where ? '<div class="where-box">'
              + '<div class="result-label">货架位置</div>' + where + '</div>' : '')
      +   '<div class="meta">'
      +     row('化合物', r.name
              ? esc(r.name) + (r.zh && r.zh !== r.name ? '　' + esc(r.zh) : '')
              : '<span class="meta-none">未查到名称</span>')
      /* AI 转写出来的名字要单独显一行 —— 用户得能核对它认成了什么。
         它认错了的话，下面的分子量会明显不对（或者干脆查不到），有这行才有对照 */
      +     (r.viaAi ? row('识别为', '<span class="ai-pill">AI</span>' + esc(r.viaAi)) : '')
      +     (r.formLabel ? row('形式', esc(r.formLabel)) : '')
      +     row('分子式', esc(r.formula || '—'))
      +     row('分子量', mwTxt + (r.mwAvg ? ' <span class="result-label">(平均)</span>' : ''))
      +     row('CAS 号', r.cas
              ? '<button class="btn tiny" data-copy="' + esc(r.cas) + '">' + esc(r.cas) + '</button>'
              : '—')
      +     row('数据来源', esc(sourceLabel(r.source)))
      +   '</div>'
      +   (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '')
      +   liquidNote
      +   '<div class="steps"><b>计算过程</b><br>'
      +     '质量 = 浓度 × 体积 × 分子量<br>'
      +     '　　= ' + esc(U.formatConc(conc).text) + ' × ' + esc(U.formatVol(vol).text)
      +     ' × ' + mwTxt + ' g/mol<br>'
      +     '　　= ' + esc(m.text)
      +   '</div>'
      +   '<div class="steps">' + esc(Calc.stepsForSolution(stepName, mass, vol)) + '</div>'
      +   '<p class="disclaim">分子量为理论值，请以试剂瓶标签为准。</p>'
      +   '<div class="acts">' + UI.copyBtn(Calc.stepsForSolution(stepName, mass, vol), '复制操作步骤') + '</div>'
      + '</div>';

    const out = $('#q-out');
    out.innerHTML = html;
    bindCopy(out);
    tagBarRender('quick');          // 批量模式下还没存历史，id 是空的，标签块自动收起
    if (!noReveal) revealOut(out);  // 批量模式别抢滚动：新行才是反馈，别把清单顶出屏幕
  }

  function row(k, v) {
    return '<div class="meta-row"><span class="meta-k">' + k
      + '</span><span class="meta-v">' + v + '</span></div>';
  }

  function renderQuickFail(q, r) {
    let tips = '';
    if (r.reason === 'no-mw') {
      // 货架上有，但这瓶本来就没有单一分子量 —— 说清楚原因，别让用户以为是打错名字
      const p = r.place || {};
      tips = '<div class="note warn"><b>这瓶试剂没有单一分子量，算不了称量。</b><br>'
        + esc(p.zh || p.en || q) + '（' + esc(p.tag || '') + ' ' + esc(p.code || '') + '）<br>'
        + esc(p.noMw || '')
        + '</div>';
    } else if (r.reason === 'unknown-zh') {
      // 不认识就说不认识，绝不猜 —— 猜错形式或盐基，分子量会差一大截
      /* 按 AI 的三档状态给不同的第一条建议：
         没开 → 告诉他设置里有这个功能；开了但没填 Key → 提醒补上；
         都配好了还是查不到 → 这条路走不通了，让他回到 CAS / 英文名 */
      const first = r.aiReady
        ? '① 确认服务商的 API Key 还有额度，或把这个名字写得更规范一点<br>'
        : (r.aiOn ? '① 到「设置 → 中文名识别」里填上 API Key<br>'
                  : '① 到「设置 → 中文名识别」开启 AI 识别，能认出大部分中文名<br>');
      tips = '<div class="note">内置库、对照表和你的试剂表里都没有「' + esc(q) + '」这个中文名。'
        + '请任选一种方式继续：<br>'
        + first
        + '② 输入 CAS 号（最可靠，形如 <code>50-99-7</code>）<br>'
        + '③ 改用英文名（如 <code>ammonium sulfate</code>）<br>'
        + '④ 在下方手动填入分子量</div>';
    } else if (r.reason === 'network') {
      tips = '<div class="note warn">联网查询没成功（网络不稳或对方的服务暂时不通）。'
        + '这不是名称的问题 —— 稍后重试，或直接在下方手动填入分子量。</div>';
    } else if (r.reason === 'notfound-name' || r.reason === 'error') {
      tips = '<div class="note">英文名「' + esc(q) + '」查不到。请任选一种方式继续：<br>'
        + '① 换个更规范的英文名（用全名，别用 NaCl 这类缩写）<br>'
        + '② 输入 CAS 号（最可靠，形如 <code>50-99-7</code>）<br>'
        + '③ 在下方手动填入分子量</div>';
    } else if (r.reason === 'notfound-cas') {
      tips = '<div class="note">CAS 号 <code>' + esc(q) + '</code> 未查到，'
        + '可能是该库未收录。可在下方手动填入分子量。</div>';
    }

    if (!r.onlineOn) {
      tips += '<div class="note warn">联网查询已关闭（设置里可开启）。'
        + '常用试剂已内置，不联网也能查。</div>';
    }

    let sug = '';
    if (r.suggestions && r.suggestions.length) {
      sug = '<div class="hint">你是不是想找：</div><div class="chips">'
        + r.suggestions.map(x =>
            '<button class="chip" data-fill="' + esc(x.name) + '">' + esc(x.name)
            + '（' + esc(x.zh) + '）</button>').join('')
        + '</div>';
    }

    const out = $('#q-ask');
    $('#q-out').innerHTML = '';   // 失败就没什么可"算出来的明细"了，清掉免得底下还压着上一轮的数
    out.innerHTML = '<div class="result">' + tips + sug
      + '<label class="lbl" for="q-manual">手动输入分子量 (g/mol)</label>'
      + '<div class="inrow"><input id="q-manual" class="in" type="text" inputmode="decimal" placeholder="如 180.16">'
      + '<button class="btn" id="q-manual-go">使用</button></div>'
      + '</div>';

    $$('[data-fill]', out).forEach(b => b.addEventListener('click', () => {
      $('#q-name').value = b.dataset.fill;
      runQuick();
    }));

    const go2 = async () => {
      const mw = U.num($('#q-manual').value);
      if (!requirePos(mw, '请输入有效的分子量')) return;
      const conc = readQty('#q-conc', '#q-concu', U.toMolar);
      const vol  = readQty('#q-vol', '#q-volu', U.toLiter);
      if (!requirePos(conc, '浓度必须大于 0') || !requirePos(vol, '体积必须大于 0')) return;
      const m = Lookup.manual(q, mw);
      const mass = Calc.massForSolution(conc, vol, m.mw);
      $('#q-ask').innerHTML = '';   // 分子量收下了，这张卡的事办完了

      // 批量模式下「手动填分子量」这条路也要进清单，否则它会偷偷写进历史
      if (qBatch.on) {
        quickBatchPush(m, conc, vol, mass);
        renderQuickOk(m, conc, vol, mass, true);
        return;
      }

      TAGBAR.quick.id = await saveResult('quick', m.name, U.formatMass(mass).text,
        { query: q, conc, concUnit: 'M', vol, volUnit: 'L' });
      renderQuickOk(m, conc, vol, mass);
    };
    $('#q-manual-go').addEventListener('click', go2);
    $('#q-manual').addEventListener('keydown', e => { if (e.key === 'Enter') go2(); });
  }

  /* ══ 模块二 · 子 Tab 1：温度换算 ════════════════════ */
  async function runTemp() {
    const b = Buffers.bufferById($('#t-buf').value);
    if (!b) return;
    const pH = U.num($('#t-ph').value);
    const t1 = U.num($('#t-t1').value);
    const t2 = U.num($('#t-t2').value);
    if (!isFinite(pH)) { toast('请输入已知 pH', 'error'); return; }
    if (!isFinite(t1) || !isFinite(t2)) { toast('请输入温度', 'error'); return; }

    const r = Calc.tempShift({ pKa25: b.pKa25, dpKa: b.dpKa, pH, tKnown: t1, tTarget: t2 });
    const pHtxt = U.formatPH(r.pH);

    const outOfRange = r.pH < b.range[0] || r.pH > b.range[1];
    const dT = t2 - t1;
    const dir = r.deltaPKa > 0 ? '升高' : (r.deltaPKa < 0 ? '降低' : '不变');

    const html = ''
      + '<div class="result">'
      +   '<div class="result-label">' + esc(b.name) + ' 在 ' + t2 + ' °C 下的 pH</div>'
      +   '<div class="result-main">'
      +     '<span class="bignum" id="t-phout">' + pHtxt + '</span>'
      +   '</div>'
      +   '<div class="meta">'
      +     row('已知条件', U.formatPH(pH) + ' @ ' + t1 + ' °C')
      +     row('ΔpKa', (r.deltaPKa >= 0 ? '+' : '') + r.deltaPKa.toFixed(4))
      +     row('pKa @ ' + t1 + ' °C', r.pKaKnown.toFixed(3))
      +     row('pKa @ ' + t2 + ' °C', r.pKaTarget.toFixed(3))
      +     row('有效范围', b.range[0].toFixed(1) + '–' + b.range[1].toFixed(1))
      +   '</div>'
      +   '<div class="steps">温度从 ' + t1 + ' °C 变到 ' + t2 + ' °C，'
      +     'pKa 变化 ' + (r.deltaPKa >= 0 ? '+' : '') + r.deltaPKa.toFixed(4)
      +     '，故 pH ' + dir + '同样幅度。</div>'
      +   (outOfRange
            ? '<div class="note warn">换算结果 ' + pHtxt + ' 已超出该体系的有效范围（'
              + b.range[0].toFixed(1) + '–' + b.range[1].toFixed(1) + '），缓冲能力会很弱。</div>'
            : '')
      +   (Math.abs(dT) > 0 ? '' : '<div class="note warn">已知温度与目标温度相同，结果不会有变化。</div>')
      +   '<div class="note">理论值。假设酸/碱比例不变，未考虑离子强度变化，实验请用 pH 计校准。</div>'
      +   '<div class="acts">' + UI.copyBtn(b.name + ' pH ' + U.formatPH(pH) + ' @ ' + t1
            + '°C → ' + pHtxt + ' @ ' + t2 + '°C', '复制结果') + '</div>'
      + '</div>';

    const out = $('#t-out');
    out.innerHTML = html;
    bindCopy(out);
    revealOut(out);
    await saveResult('ph', b.name + ' 温度换算', pHtxt + ' @ ' + t2 + '°C',
      { bufferId: b.id, pH, tKnown: t1, tTarget: t2 });
  }

  /* ══ 模块二 · 子 Tab 2：多质子酸配比 ════════════════ */
  function syncPolyForms() {
    const s = Buffers.polyById($('#p-sys').value);
    if (!s) return;
    const acid = Reagents.byId(s.acid.reagentId);
    const base = Reagents.byId(s.base.reagentId);
    const b = Buffers.bufferById(s.bufferId);

    $('#p-acidname').textContent = s.acid.label;
    $('#p-basename').textContent = s.base.label;

    const fillForms = (sel, r) => {
      sel.innerHTML = '';
      if (r.forms && r.forms.length) {
        r.forms.forEach(f => {
          const o = document.createElement('option');
          o.value = f.label; o.textContent = f.label + '（MW ' + f.mw + '）';
          sel.appendChild(o);
        });
        sel.disabled = false;
      } else {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '默认（MW ' + r.mw + '）';
        sel.appendChild(o);
        sel.disabled = true;
      }
    };
    fillForms($('#p-acidform'), acid);
    fillForms($('#p-baseform'), base);

    const rng = b.range;
    $('#p-out').innerHTML = '<div class="note">' + esc(b.name)
      + ' 有效 pH 范围 ' + rng[0].toFixed(1) + '–' + rng[1].toFixed(1)
      + '。超出范围仍可计算，但缓冲能力很弱。</div>';
  }

  async function runPoly() {
    const s = Buffers.polyById($('#p-sys').value);
    if (!s) return;
    const b = Buffers.bufferById(s.bufferId);
    const acid = Reagents.byId(s.acid.reagentId);
    const base = Reagents.byId(s.base.reagentId);
    const acidForm = Reagents.formOf(acid, $('#p-acidform').value);
    const baseForm = Reagents.formOf(base, $('#p-baseform').value);

    const pH = U.num($('#p-ph').value);
    const temp = U.num($('#p-temp').value);
    const conc = U.num($('#p-conc').value);
    const vol = readQty('#p-vol', '#p-volu', U.toLiter);

    if (!isFinite(pH) || pH < 0 || pH > 14) { toast('pH 需在 0–14 之间', 'error'); return; }
    if (!isFinite(temp)) { toast('请输入温度', 'error'); return; }
    if (!requirePos(conc, '总浓度必须大于 0')) return;
    if (!requirePos(vol, '体积必须大于 0')) return;

    // 非 25 °C 只校正主导 pKa（其他质子的温度系数本库未收录）
    const pKas = Calc.pKasAtTemp(b.pKas, b.dominant, b.dpKa, temp);
    const pKaUsed = pKas[b.dominant];

    const r = Calc.polyproticRatio({
      pKas, za: s.za, zb: s.zb, pH, conc, vol,
      mwAcid: acidForm.mw, mwBase: baseForm.mw
    });

    const mA = U.formatMass(r.massAcid), mB = U.formatMass(r.massBase);
    const warn = Calc.ionicWarning(conc);
    const outOfRange = pH < b.range[0] || pH > b.range[1];

    let html = '<div class="result">';

    if (!r.inRange) {
      html += '<div class="note error"><b>该体系配不出此 pH。</b><br>'
        + '目标 pH ' + U.formatPH(pH) + ' 对应的平均负电荷 z = ' + r.z.toFixed(4)
        + '，超出 ' + s.acid.label + '（z=' + s.za + '）到 '
        + s.base.label + '（z=' + s.zb + '）的可调范围。</div>';
    } else {
      html += '<div class="result-label">称取量</div>'
        + '<div class="result-main">'
        +   '<span class="bignum">' + esc(mA.text.split(' ')[0]) + '</span>'
        +   '<span class="bigunit">' + esc(mA.unit) + '</span>'
        +   '<span class="result-label">' + esc(s.acid.label) + ' +</span>'
        +   '<span class="bignum">' + esc(mB.text.split(' ')[0]) + '</span>'
        +   '<span class="bigunit">' + esc(mB.unit) + '</span>'
        +   '<span class="result-label">' + esc(s.base.label) + '</span>'
        + '</div>'
        + '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
        + '<th>化合物</th><th class="num">摩尔数</th><th class="num">质量</th><th>CAS</th>'
        + '</tr></thead><tbody>'
        + '<tr><td>' + esc(s.acid.label) + '</td><td class="num">'
        +   r.nAcid.toFixed(4) + ' mol</td><td class="num">' + esc(mA.text)
        +   '</td><td>' + esc(acidForm.cas || '—') + '</td></tr>'
        + '<tr><td>' + esc(s.base.label) + '</td><td class="num">'
        +   r.nBase.toFixed(4) + ' mol</td><td class="num">' + esc(mB.text)
        +   '</td><td>' + esc(baseForm.cas || '—') + '</td></tr>'
        + '</tbody></table></div>';
    }

    html += '<div class="meta" style="margin-top:16px">'
      + row('体系', esc(s.name) + '缓冲液')
      + row('pKa₂ @ ' + temp + ' °C', pKaUsed.toFixed(3))
      + row('平均负电荷 z', r.z.toFixed(4))
      + row('总浓度', U.formatConc(conc).text)
      + '</div>'
      + (r.inRange ? '<div class="steps">'
          + esc(Calc.stepsForTwoSalts(s.acid.label, r.massAcid, s.base.label,
              r.massBase, pH, vol)) + '</div>' : '')
      + (r.inRange ? '<div class="steps"><b>计算过程</b><br>'
          + '[H⁺] = 10<sup>−' + U.formatPH(pH) + '</sup>，由各 pKa 求分布系数 α<sub>i</sub><br>'
          + '平均负电荷 z = Σ(i × α<sub>i</sub>) = ' + r.z.toFixed(4) + '<br>'
          + 'n<sub>碱</sub> = C(z − z<sub>a</sub>)/(z<sub>b</sub> − z<sub>a</sub>) = '
          + r.nBase.toFixed(4) + ' mol<br>'
          + 'n<sub>酸</sub> = C(z<sub>b</sub> − z)/(z<sub>b</sub> − z<sub>a</sub>) = '
          + r.nAcid.toFixed(4) + ' mol'
          + '</div>' : '')
      + (outOfRange
          ? '<div class="note warn">目标 pH 超出该体系有效范围（'
            + b.range[0].toFixed(1) + '–' + b.range[1].toFixed(1) + '），缓冲能力很弱。</div>'
          : '')
      + (temp !== 25
          ? '<div class="note warn">非 25 °C 只校正了主导 pKa，其他质子的温度系数未收录，结果仅供参考。</div>'
          : '')
      + (warn ? '<div class="note warn">' + esc(warn) + '</div>' : '')
      + '<div class="acts">'
      + (r.inRange ? UI.copyBtn(Calc.stepsForTwoSalts(s.acid.label, r.massAcid,
          s.base.label, r.massBase, pH, vol), '复制操作步骤') : '')
      + UI.copyBtn(s.name + ' ' + U.formatPH(pH) + ' @' + temp + '°C：'
          + s.acid.label + ' ' + mA.text + ' + ' + s.base.label + ' ' + mB.text, '复制结果')
      + '</div></div>';

    const out = $('#p-out');
    out.innerHTML = html;
    bindCopy(out);
    revealOut(out);

    if (r.inRange) {
      await saveResult('poly', s.name + '缓冲液 ' + U.formatPH(pH),
        mA.text + ' + ' + mB.text,
        { sysId: s.id, pH, temp, conc, vol, acidForm: acidForm.label, baseForm: baseForm.label });
    }
  }

  /* ══ 模块三：体系配置 ═══════════════════════════════ */
  let comps = [];
  let compSeq = 0;

  function newComp(preset) {
    const c = {
      key: 'c' + (++compSeq),
      name: '', reagentId: null, mw: null, formLabel: '',
      targetConc: '', targetUnit: 'mM',
      mode: 'stock', stockConc: '', stockUnit: 'M'
    };
    if (preset) Object.assign(c, preset);
    return c;
  }

  /** 形式选择 chips。同一试剂有多种形式（游离酸/碱、盐、水合物）时才需要用户拍板。 */
  function formsHtml(reagent, current) {
    if (!Reagents.hasChoice(reagent)) return '';
    return '<span class="cf-lbl">形式</span>'
      + reagent.forms.map(f =>
          '<button type="button" class="fchip' + (f.label === current ? ' on' : '') + '"'
          + ' data-form="' + esc(f.label) + '">'
          + esc(f.name || f.label) + '<b>' + f.mw + '</b></button>').join('');
  }

  /** 只刷新某组分的形式 chips（输入名称后调用，不重绘整卡以免输入框失焦） */
  function syncCompForms(c, el) {
    const box = el.querySelector('[data-forms]');
    if (!box) return;
    box.innerHTML = formsHtml(c.reagentId ? Reagents.byId(c.reagentId) : null, c.formLabel);
  }

  function renderComps() {
    const box = $('#s-list');
    if (!comps.length) {
      box.innerHTML = '<div class="empty">还没有组分<b>从下方快捷按钮添加</b>，或点右上角手动添加</div>';
      return;
    }
    /* 名称横跨整行 —— 左列在 375px 下只剩 60 多像素，长化合物名看不全。
       下半部分仍是「左：模式分段 / 右：两排浓度」，形式选择横跨底部。 */
    box.innerHTML = comps.map(c => {
      const solid = c.mode === 'solid';
      const r = c.reagentId ? Reagents.byId(c.reagentId) : null;
      return '<div class="comp" data-key="' + c.key + '">'
        + '<div class="comp-namerow">'
        +   '<input class="in" data-f="name" type="text" value="' + esc(c.name) + '"'
        +     ' placeholder="名称或 CAS" aria-label="组分名称或 CAS 号"'
        +     ' autocomplete="off" autocapitalize="off" spellcheck="false">'
        +   '<button type="button" class="comp-del" data-del aria-label="删除该组分">×</button>'
        + '</div>'
        + '<div class="comp-l">'
        /* 「液」= 拿母液稀释，「固」= 称固体。单字是为了竖排后只占一个字的宽度，
           把省下的给右列浓度输入（见 app.css 的 .comp-l .seg）。
           单字脱离上下文读不出语义，用 aria-label 补回来。 */
        +   '<div class="seg mini" data-mode>'
        +     '<button type="button" data-m="stock"' + (solid ? '' : ' class="on"')
        +       ' aria-label="用母液">液</button>'
        +     '<button type="button" data-m="solid"' + (solid ? ' class="on"' : '')
        +       ' aria-label="用固体">固</button>'
        +   '</div>'
        + '</div>'
        + '<div class="comp-r">'
        +   '<div class="cf">'
        +     '<span class="cf-lbl">目标</span>'
        +     '<input class="in" data-f="targetConc" type="text" inputmode="decimal"'
        +       ' value="' + esc(c.targetConc) + '" aria-label="目标浓度">'
        +     '<select class="sel" data-f="targetUnit" aria-label="目标浓度单位"></select>'
        +   '</div>'
        +   '<div class="cf">'
        +     '<span class="cf-lbl">' + (solid ? '分子量' : '母液') + '</span>'
        +     (solid
                ? '<input class="in" data-f="mw" type="text" inputmode="decimal"'
                  + ' value="' + esc(c.mw == null ? '' : c.mw) + '" aria-label="分子量">'
                  + '<span class="cf-suffix">g/mol</span>'
                : '<input class="in" data-f="stockConc" type="text" inputmode="decimal"'
                  + ' value="' + esc(c.stockConc) + '" aria-label="母液浓度">'
                  + '<select class="sel" data-f="stockUnit" aria-label="母液浓度单位"></select>')
        +   '</div>'
        + '</div>'
        + '<div class="comp-forms" data-forms>' + formsHtml(r, c.formLabel) + '</div>'
        + '</div>';
    }).join('');

    // 填充单位下拉
    comps.forEach(c => {
      const el = box.querySelector('[data-key="' + c.key + '"]');
      if (!el) return;
      /* 母液模式算的是「目标浓度 × 体积 ÷ 母液浓度」—— 两者同类时换算系数会相消，
         所以 % 配 % 是对的（甘油就是按体积百分比配的），四种浓度单位都放开。
         固体模式要乘分子量，目标浓度只能是摩尔。 */
      const tuSel = el.querySelector('[data-f="targetUnit"]');
      fillSelect(tuSel, c.mode === 'solid' ? U.MOLAR_UNITS : U.CONC_UNITS, c.targetUnit);
      // 切模式后选项列表会变，原先选的 % 可能已不在列表里 —— 把下拉实际选中的值写回内存，
      // 否则界面上显示 M、内存里还留着 %，出错提示会答非所问
      c.targetUnit = tuSel.value;

      const suSel = el.querySelector('[data-f="stockUnit"]');
      if (suSel) {
        fillSelect(suSel, U.CONC_UNITS, c.stockUnit);
        c.stockUnit = suSel.value;
      }
    });
  }

  function bindCompEvents() {
    const box = $('#s-list');

    box.addEventListener('input', e => {
      const el = e.target.closest('.comp'); if (!el) return;
      const c = comps.find(x => x.key === el.dataset.key); if (!c) return;
      const f = e.target.dataset.f;
      if (!f) return;
      c[f] = e.target.value;
      if (f === 'name') autoFillComp(c, el);
    });

    box.addEventListener('change', e => {
      const el = e.target.closest('.comp'); if (!el) return;
      const c = comps.find(x => x.key === el.dataset.key); if (!c) return;
      const f = e.target.dataset.f;
      if (f) c[f] = e.target.value;
    });

    box.addEventListener('click', e => {
      const el = e.target.closest('.comp'); if (!el) return;
      const c = comps.find(x => x.key === el.dataset.key); if (!c) return;

      if (e.target.closest('[data-del]')) {
        comps = comps.filter(x => x.key !== c.key);
        renderComps();
        return;
      }
      const mb = e.target.closest('[data-m]');
      if (mb) {
        c.mode = mb.dataset.m;
        renderComps();
        return;
      }
      // 形式 chips：只改选中态与分子量，不重绘整卡（否则正在输入的名称框会失焦）
      const fb = e.target.closest('[data-form]');
      if (fb) pickCompForm(c, el, fb.dataset.form);
    });
  }

  function pickCompForm(c, el, label) {
    const r = Reagents.byId(c.reagentId);
    if (!r) return;
    c.formLabel = label;
    c.mw = Reagents.formOf(r, label).mw;
    const mwInput = el.querySelector('[data-f="mw"]');
    if (mwInput) mwInput.value = c.mw;
    $$('[data-form]', el).forEach(b =>
      b.classList.toggle('on', b.dataset.form === label));
  }

  /** 名称输入时自动匹配内置库，填充分子量；同名多形式且输入有歧义时列出让用户选 */
  function autoFillComp(c, el) {
    const hit = Reagents.find(c.name);
    const prevForm = c.formLabel;

    if (!hit) {
      c.reagentId = null;
      c.formLabel = '';
    } else {
      const r = hit.reagent;
      c.reagentId = r.id;
      if (!Reagents.hasChoice(r)) c.formLabel = '';
      else if (hit.form) c.formLabel = hit.form.label;   // 输入已指明形式（Tris-HCl / CAS 号）
      else if (!r.forms.some(f => f.label === c.formLabel)) c.formLabel = '';
    }

    const r2 = c.reagentId ? Reagents.byId(c.reagentId) : null;
    // 形式变了（或还没有分子量）才覆盖，避免冲掉用户手改的值
    if (r2 && (c.formLabel !== prevForm || c.mw == null || c.mw === '')) {
      c.mw = Reagents.formOf(r2, c.formLabel).mw;
      const mwInput = el.querySelector('[data-f="mw"]');
      if (mwInput) mwInput.value = c.mw;
    }
    syncCompForms(c, el);
  }

  function renderQuickAdd() {
    const box = $('#s-quick');
    box.innerHTML = ZhData.QUICK_GROUPS.map(g =>
      '<div class="quickgrp"><span class="quickgrp-name">' + esc(g.name) + '</span>'
      + '<div class="chips">'
      + g.items.map(id => {
          const r = Reagents.byId(id);
          return r ? '<button class="chip" data-add="' + esc(id) + '">'
            + esc(r.name) + '</button>' : '';
        }).join('')
      + '</div></div>').join('');

    box.addEventListener('click', e => {
      const b = e.target.closest('[data-add]'); if (!b) return;
      const r = Reagents.byId(b.dataset.add); if (!r) return;
      const form = Reagents.formOf(r);
      comps.push(newComp({
        name: r.name, reagentId: r.id, mw: form.mw, targetConc: '', targetUnit: 'mM'
      }));
      renderComps();
      toast('已添加 ' + r.name);
    });
  }

  /** 母液浓度的显示（摩尔归一化，% / × / mg/mL 照原样），供结果表与复制文本共用 */
  function stockConcText(it) {
    return concLabel(it.stockConc, it.stockUnit);
  }

  /* comps（表单态）→ items（算式入参）。校验只写这一遍：结果页拿 error 去 toast，
     历史卡里就地展开配方也走它。返回 {items} 或 {error}，自己不弹提示 —— 由调用方决定怎么说。 */
  function compsToItems(list) {
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const label = c.name || ('组分 ' + (i + 1));
      const tc = U.num(c.targetConc);
      if (!(tc > 0)) return { error: '「' + label + '」的目标浓度必须大于 0' };

      const tKind = U.CONC[U.norm(c.targetUnit)].kind;

      if (c.mode === 'stock') {
        const sc = U.num(c.stockConc);
        if (!(sc > 0)) return { error: '「' + label + '」的母液浓度必须大于 0' };
        // 同类时换算系数相消，% 配 % 照样对；混类（拿 % 配 M）除出来的比值没有物理意义
        if (tKind !== U.CONC[U.norm(c.stockUnit)].kind) {
          return { error: '「' + label + '」的目标浓度和母液浓度得用同一类单位' };
        }
        items.push({ name: label, targetConc: tc, targetUnit: c.targetUnit,
                     mode: 'stock', stockConc: sc, stockUnit: c.stockUnit, mw: null });
      } else {
        const mw = U.num(c.mw);
        if (!(mw > 0)) return { error: '「' + label + '」缺少分子量，无法算固体质量' };
        // 称固体要算「摩尔浓度 × 体积 × 分子量」，目标浓度必须是摩尔
        if (tKind !== 'molar') return { error: '「' + label + '」按固体称量时，目标浓度得用摩尔单位' };
        items.push({ name: label, targetConc: tc, targetUnit: c.targetUnit,
                     mode: 'solid', mw });
      }
    }
    return { items };
  }

  async function runSystem() {
    const vol = readQty('#s-vol', '#s-volu', U.toLiter);
    if (!requirePos(vol, '最终体积必须大于 0')) return;
    if (!comps.length) { toast('请先添加至少一个组分', 'error'); return; }

    const conv = compsToItems(comps);
    if (conv.error) { toast(conv.error, 'error'); return; }
    const items = conv.items;

    const r = Calc.systemMix(items, vol);
    const negSolvent = r.solventVol < 0;

    let rowsHtml = r.rows.map((row, i) => {
      const it = items[i];
      const concTxt = concLabel(it.targetConc, it.targetUnit);
      const stockTxt = it.mode === 'stock' ? stockConcText(it) : '—';
      const amount = it.mode === 'stock'
        ? U.formatVol(row.volume).text
        : U.formatMass(row.mass).text;
      return '<tr><td>' + esc(it.name) + '</td>'
        + '<td class="num">' + esc(concTxt) + '</td>'
        + '<td class="num">' + esc(stockTxt) + '</td>'
        + '<td class="num">' + esc(amount) + '</td></tr>';
    }).join('');

    const totalTxt = U.formatVol(r.totalStockVol).text;
    const solTxt = U.formatVol(Math.max(0, r.solventVol)).text;

    const html = '<div class="result">'
      + '<div class="result-head">'
      +   '<div class="result-label">配方</div>'
      +   '<div class="tagbox" id="s-tagbox"></div>'
      + '</div>'
      + '<div class="tbl-wrap"><table class="tbl tbl-4"><thead><tr>'
      + '<th>组分</th><th class="num">目标浓度</th>'
      + '<th class="num">母液浓度</th><th class="num">取用量</th>'
      + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
      + '<div class="meta" style="margin-top:16px">'
      + row('最终体积', U.formatVol(vol).text)
      + row('母液合计', totalTxt)
      + row('补加溶剂', solTxt)
      + '</div>'
      + (negSolvent
          ? '<div class="note error">所有母液体积之和（' + totalTxt
            + '）已超过最终体积（' + U.formatVol(vol).text
            + '）。请提高母液浓度或增大最终体积。</div>'
          : '')
      + '<div class="acts">'
      + UI.copyBtn(systemText(items, r, vol), '复制配方')
      + '<button class="btn tiny" id="s-csv">导出 CSV</button>'
      + '</div>'
      + '</div>';

    /* 先定下这条结果写进哪条历史（可能要问一句覆盖不覆盖）再渲染：
       结果区的标签行要指向那条记录 */
    tagBarReset('system');
    TAGBAR.system.id = await saveResult('system', items.length + ' 组分体系',
      '共 ' + totalTxt + ' 母液 / 补 ' + solTxt,
      { vol, comps: JSON.parse(JSON.stringify(comps)) });

    const out = $('#s-out');
    out.innerHTML = html;
    bindCopy(out);
    tagBarRender('system');
    revealOut(out);
    const csv = $('#s-csv');
    if (csv) csv.addEventListener('click', () => exportCSV(items, r, vol));
  }

  function systemText(items, r, vol) {
    const lines = ['体系配方（最终体积 ' + U.formatVol(vol).text + '）'];
    r.rows.forEach((row, i) => {
      const it = items[i];
      const amount = it.mode === 'stock'
        ? U.formatVol(row.volume).text
        : U.formatMass(row.mass).text;
      const src = it.mode === 'stock'
        ? '（' + stockConcText(it) + ' 母液）'
        : '（固体）';
      lines.push('  ' + it.name + '  ' + concLabel(it.targetConc, it.targetUnit)
        + src + '  →  ' + amount);
    });
    lines.push('  母液合计 ' + U.formatVol(r.totalStockVol).text);
    lines.push('  补加溶剂 ' + U.formatVol(Math.max(0, r.solventVol)).text);
    return lines.join('\n');
  }

  function exportCSV(items, r, vol) {
    const head = ['组分', '目标浓度', '母液浓度', '取用量'];
    const body = r.rows.map((row, i) => {
      const it = items[i];
      return [it.name, concLabel(it.targetConc, it.targetUnit),
        it.mode === 'stock' ? stockConcText(it) : '',
        it.mode === 'stock' ? U.formatVol(row.volume).text : U.formatMass(row.mass).text];
    });
    const csv = [head].concat(body).map(a => a.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    downloadFile('配方.csv', '﻿' + csv, 'text/csv;charset=utf-8');
  }

  function downloadFile(name, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('已导出 ' + name);
    } catch (e) {
      toast('导出失败', 'error');
    }
  }

  /* ══ 模块四：母液稀释 ═══════════════════════════════ */
  async function runDilution() {
    const c1 = U.num($('#d-c1').value), c2 = U.num($('#d-c2').value);
    const v2 = U.num($('#d-v2').value);
    const u1 = $('#d-c1u').value, u2 = $('#d-c2u').value, u3 = $('#d-v2u').value;

    if (!requirePos(c1, '母液浓度必须大于 0')) return;
    if (!requirePos(c2, '目标浓度必须大于 0')) return;
    if (!requirePos(v2, '目标体积必须大于 0')) return;

    // 两个浓度必须是同一「种类」：% / × / mg/mL 的换算系数都是 1，
    // 跟 M 混着除出来的比值没有物理意义，显示时还会被当成摩尔浓度。
    if (U.CONC[U.norm(u1)].kind !== U.CONC[U.norm(u2)].kind) {
      toast('母液和目标浓度得用同一类单位，不能拿 % 去配 M', 'error'); return;
    }

    // 浓度单位一律换算到共同基准再比 —— 必须换算之后再比大小。
    // 拿原始数字比会把 1 M → 10 mM 这种正常操作误判成"目标浓度更高"。
    const k1 = U.concFactor(u1), k2 = U.concFactor(u2);
    const c1b = c1 * k1, c2b = c2 * k2;
    if (c2b > c1b) { toast('目标浓度不能高于母液浓度', 'error'); return; }

    const v2b = U.toLiter(v2, u3);

    const r = Calc.dilution({ c1: c1b, c2: c2b, v2: v2b });
    const name = $('#d-name').value.trim();

    const v1Txt = U.formatVol(r.v1).text;
    const solTxt = U.formatVol(Math.max(0, r.vSolvent)).text;
    const v2Txt = U.formatVol(v2b).text;

    // 浓度按用户填的原单位写。formatConc 只认摩尔浓度，用它写 10% 会变成 "10 M"。
    const c1Txt = concLabel(c1, u1), c2Txt = concLabel(c2, u2);

    const steps = '取 ' + v1Txt + ' 母液（' + c1Txt
      + '），加溶剂至 ' + v2Txt + '，即得 ' + c2Txt
      + (name ? ' 的 ' + name : '') + '。';

    const html = '<div class="result">'
      + '<div class="result-label">取母液</div>'
      + '<div class="result-main">'
      +   '<span class="bignum">' + esc(v1Txt.split(' ')[0]) + '</span>'
      +   '<span class="bigunit">' + esc(v1Txt.split(' ')[1] || '') + '</span>'
      + '</div>'
      + '<div class="meta">'
      + row('补加溶剂', solTxt)
      + row('稀释倍数', r.fold.toFixed(1) + ' ×')
      + row('母液 → 工作液', c1Txt + ' → ' + c2Txt)
      + '</div>'
      + '<div class="steps">' + esc(steps) + '</div>'
      + '<div class="acts">' + UI.copyBtn(steps, '复制操作步骤') + '</div>'
      + '</div>';

    const out = $('#d-out');
    out.innerHTML = html;
    bindCopy(out);
    if (!dBatch.on) revealOut(out);   // 批量模式下新行才是反馈，别把清单顶出屏幕

    // 批量模式：攒进清单，整批存成一条历史。不动输入框也不抢焦点 ——
    // 稀释的连续性是「改一个数再算一次」，而且手机上聚焦文本框弹的是全键盘。
    if (dBatch.on) {
      dBatch.entries.push({ name: name, c1: c1b, c1u: u1, c2: c2b, c2u: u2,
                            v1: r.v1, v2: v2b, v2u: u3 });
      renderBatch('dilution', true);
      return;
    }

    // 原单位跟着一起存：% / × 和 M 的换算系数不同，回放时要靠它还原成用户当初填的样子
    await saveResult('dilution', (name ? name + ' ' : '') + '母液稀释',
      v1Txt + ' → ' + v2Txt, { c1: c1b, c2: c2b, v2: v2b, c1u: u1, c2u: u2, v2u: u3, name });
  }

  /* ══ 批量清单（快速配液 / 母液稀释）═══════════════════
   * 清单只活在内存里；整批存成一条历史记录，回看时在历史卡片里就地展开。
   * 一项在「页面上 / 历史记录里 / 复制文本」三处出现，前两处共用 entryHtml、
   * 描述文字共用 entryParts —— 各写一份就是三处会不一致。 */

  /** 浓度回显：payload 里存的是基准值，而 concLabel 要的是「用户当初那个单位的数字」。
   *  少这一步除法，50% 会显示成 "50 M"（formatConc 只认摩尔浓度）。 */
  function concLabelBase(base, unit) {
    const u = unit || 'M';
    return concLabel(base / U.concFactor(u), u);
  }

  /** 手填分子量的标记。全流程里就这一个数没人核对过，所以清单行、历史清单、
   *  复制文本三处都要挂上 —— 哪天对着瓶子复核，一眼能挑出该复核哪几个 */
  const MANUAL_TAG = '手填 MW';

  /** 名字是 AI 从中文名认出来的标记。分子量仍然来自数据库（所以不像「手填 MW」
   *  那样是未经核对的数），但这个**名字**是机器给的 —— 回看历史时得能分出来，
   *  否则用户会以为是自己当初打的那串字。和结果卡的「识别为」是同一件事 */
  const AI_TAG = 'AI 认出';

  function entryParts(module, e) {
    if (module === 'dilution') {
      return {
        title: e.name || '母液稀释',
        meta: concLabelBase(e.c1, e.c1u) + ' → ' + concLabelBase(e.c2, e.c2u)
              + ' · 配 ' + U.formatVol(e.v2, { unit: e.v2u }).text,
        k: '取母液',
        v: U.formatVol(e.v1).text,     // 取用量是算出来的，单位自动选，和单个模式的结果卡一致
        loc: []                        // 稀释页不查库存，所以这页的清单没有货架位置
      };
    }
    const mw = Number(e.mw);
    return {
      title: e.name || '（未命名）',
      meta: 'MW ' + (mw > 0 ? mw.toFixed(2) : '—')
            + ' · ' + concLabelBase(e.conc, e.concU)
            + ' × ' + U.formatVol(e.vol, { unit: e.volU }).text,
      k: '需称',
      v: U.formatMass(e.mass).text,
      // 手填的分子量（老记录没这个字段 → undefined → 不标）
      manual: !!e.manual,
      // 名字是 AI 认的（老记录同样没这个字段）
      ai: !!e.ai,
      // 手动填分子量、或只是联网查到的化合物，货架上没有 —— loc 就是空数组
      loc: e.loc || []
    };
  }

  /** 货架位置的纯文本形式（复制清单用）。HTML 那份在 entryHtml 里 ——
   *  那里标签和编号要各自套样式，这里只要一串字 */
  function locText(loc) {
    return (loc || []).map(p => p.tag + ' ' + p.code).join(' / ');
  }

  function batchTitle(module, entries) {
    const first = entryParts(module, entries[0]).title;
    return entries.length > 1 ? first + ' 等 ' + entries.length + ' 项' : first;
  }

  /** 历史卡片上的摘要行。不编「合计多少克」这类对配方没意义的聚合数 */
  function batchSummary(module, entries) {
    const vs = entries.map(e => entryParts(module, e).v);
    return vs.length <= 3 ? vs.join('、')
                          : vs.slice(0, 3).join('、') + ' 等 ' + vs.length + ' 项';
  }

  /** 复制用的纯文本。一行一项、全角空格分隔 —— 贴进微信/备忘录不会串行 */
  function batchText(module, entries) {
    const head = (module === 'dilution' ? '母液稀释清单' : '快速配液清单')
      + '（' + entries.length + ' 项）';
    return [head].concat(entries.map((e, i) => {
      const p = entryParts(module, e);
      // 货架位置紧跟名称 —— 照着这条去货架上拿，顺序跟人走
      const tag = [locText(p.loc), p.manual ? MANUAL_TAG : '', p.ai ? AI_TAG : '']
        .filter(Boolean).join('　');
      return (i + 1) + '. ' + p.title + (tag ? '　' + tag : '')
        + '　' + p.meta + '　' + p.k + ' ' + p.v;
    })).join('\n');
  }

  /** 一项。i 传 null 表示这是只读展示（历史记录里的清单），不渲染删除按钮 ——
   *  已经存进历史的那份是死的，要删只能删整条记录。 */
  function entryHtml(module, e, i) {
    const p = entryParts(module, e);
    const zh = (module !== 'dilution' && e.zh && e.zh !== p.title)
      ? '<span class="entry-zh">' + esc(e.zh) + '</span>' : '';
    const manual = p.manual
      ? '<span class="entry-manual" title="分子量是手动填入的，未经核对">'
        + MANUAL_TAG + '</span>'
      : '';
    // 复用结果卡那个 .ai-pill：同一个东西长同一个样
    const ai = p.ai
      ? '<span class="entry-ai ai-pill" title="这个名字是 AI 从中文名认出来的">'
        + AI_TAG + '</span>'
      : '';
    // 位置紧挨着名称 —— 站在货架前是「拿这个 → 它在 A 柜 3 号」一条线读下来的。
    // 一个化合物可能在两个位置上（实验室一瓶、自己买的另一瓶），所以是个数组
    const where = p.loc && p.loc.length
      ? '<div class="entry-where"><span class="entry-where-k">货架</span>'
        + p.loc.map(q => '<span class="entry-loc">' + whereChip(q) + '</span>').join('')
        + '</div>'
      : '';
    return '<div class="entry">'
      + '<div class="entry-top">'
      +   '<div class="entry-name">' + esc(p.title) + zh + manual + ai + '</div>'
      // 删除按钮复用 .comp-del：同尺寸同手感，不用再写一套
      +   (i == null ? '' :
            '<button type="button" class="comp-del" data-bdel="' + i + '"'
            + ' aria-label="从清单里删掉 ' + esc(p.title) + '">×</button>')
      + '</div>'
      + where
      + '<div class="entry-meta">' + esc(p.meta) + '</div>'
      + '<div class="entry-res"><span>' + esc(p.k) + '</span><b>' + esc(p.v) + '</b></div>'
      + '</div>';
  }

  /** 重绘清单。added 只在「刚算完一项」时为真 —— 删除、打标签这些重绘不该跳滚动 */
  function renderBatch(kind, added) {
    const cfg = BATCHCFG[kind], B = batchOf(kind);
    const box = $(cfg.box);
    if (!box) return;
    // 切回单个模式：整块收起。标签状态也要一起清 —— 那块的 DOM 已经没了，
    // 留着 menu:true 下次切回批量会莫名其妙地弹出一个菜单
    if (!B.on) { box.innerHTML = ''; tagBarReset(cfg.tagKey); return; }

    const n = B.entries.length;
    // 最新的排最上面（跟历史页一致），但删除要用真实下标，所以带着下标一起翻
    const rows = B.entries.map((e, i) => [e, i]).reverse()
      .map(p => entryHtml(kind, p[0], p[1])).join('');

    box.innerHTML = '<div class="result-head">'
      +   '<div class="result-label">清单 · ' + n + ' 项'
      +     (B.savedId ? ' · 已存历史' : '') + '</div>'
      +   '<div class="tagbox" id="' + cfg.tagbox + '"></div>'
      + '</div>'
      + (n ? rows
           : '<div class="empty"><b>清单还是空的</b>'
             + '批量模式下不再逐条记历史，算完先攒在这里。'
             + '填好上面的名称和用量，点「加入清单」就会加进来。</div>')
      + (n ? '<div class="acts">'
           // 复制文本多行且可能很长，按键现取比整段塞进 data-copy 属性稳
           +   '<button class="btn tiny" data-bcopy>复制清单</button>'
           +   '<button class="btn tiny" data-bsave>'
           +     (B.savedId ? '更新历史记录' : '保存到历史') + '</button>'
           +   '<button class="btn tiny danger" data-bclear>清空清单</button>'
           + '</div>' : '');

    tagBarRender(cfg.tagKey);   // 标签行是拼进 innerHTML 的，每次重绘都得重来一遍
    if (added) {
      const first = box.querySelector('.entry');
      // block:'nearest'：已经看得见就什么都不做，免得跟「聚焦输入框」抢滚动
      if (first && first.scrollIntoView) {
        first.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'nearest' });
      }
    }
  }

  /** 批量模式：这一次的结果攒进清单（不写历史），然后清空名称框方便连着输下一个 */
  function quickBatchPush(r, conc, vol, mass) {
    qBatch.entries.push({
      // displayName 而不是 r.name：按 CAS 查没取到名字时 r.name 是空串，
      // 清单上会是一行没有名称的条目
      name: displayName(r), zh: r.zh || '', mw: r.mw,
      // 单位必须现读 DOM —— 浓度是「数字 + 单位」两个字段，只处理一半就差 1000 倍
      conc: conc, concU: $('#q-concu').value,
      vol: vol,   volU: $('#q-volu').value,
      mass: mass,
      // 手填的分子量要一路标出来 —— 它是整条流程里唯一没人核对过的数，
      // 清单上不标，回头看历史时就分不出哪个数是敲进去的
      manual: r.source === 'manual',
      // 名字是 AI 认的就标出来 —— 回看时得能分清哪些名字是自己打的
      ai: r.viaAi || '',
      // 货架位置只留「货架 + 编号」两个字段：清单要的就是「去哪拿」，
      // 整条库存记录（品牌/溶剂/一长串备注）塞进 payload 只会让历史记录白白变胖
      loc: (r.locations || []).map(p => ({ tag: p.tag, code: p.code }))
    });
    $('#q-name').value = '';
    $('#q-name').focus();
    renderBatch('quick');
  }

  function batchClear(kind) {
    const cfg = BATCHCFG[kind], B = batchOf(kind);
    // 还没存过的清单是「没保存的劳动成果」，清之前问一句；已存过的随便清
    if (B.entries.length && !B.savedId
        && !confirm('清空清单？这 ' + B.entries.length + ' 项还没存进历史，清掉就没了。')) return;
    B.entries = []; B.savedId = null;
    tagBarReset(cfg.tagKey);
    renderBatch(kind);
    toast('清单已清空');
  }

  /** 整批存成一条历史记录。已经存过就更新那一条 —— 免得一份清单攒出好几条重复记录 */
  function batchSave(kind) {
    const cfg = BATCHCFG[kind], B = batchOf(kind);
    if (!B.entries.length) { toast('清单还是空的', 'error'); return; }

    // 深拷贝快照：之后继续往清单里加，不该改到已经存下的那条
    const payload = { batch: true, entries: JSON.parse(JSON.stringify(B.entries)) };
    const title = batchTitle(kind, B.entries);
    const summary = batchSummary(kind, B.entries);

    let updated = false;
    if (B.savedId) {
      if (Store.historyUpdate(B.savedId, { title, summary, payload })) updated = true;
      else B.savedId = null;      // 那条在历史页被删了 → 退回去当新建，别留悬空 id
    }
    if (!B.savedId) B.savedId = saveHistory(kind, title, summary, payload).id;

    // 先有记录才谈得上打标签：把标签行指向刚存的这条
    tagBarReset(cfg.tagKey);
    TAGBAR[cfg.tagKey].id = B.savedId;
    renderBatch(kind);
    if (currentView === 'history') renderHistory();   // historyUpdate 不会自己刷
    toast(updated ? '已更新那条记录' : '已存入历史，点「＋ 标签」就能归类');
  }

  /** 事件挂在静态容器上（index.html 里的 #q-batch / #d-batch），里面的 .entry 随便重建 */
  function bindBatch(kind) {
    const cfg = BATCHCFG[kind], box = $(cfg.box);
    if (!box) return;
    box.addEventListener('click', e => {
      const B = batchOf(kind);
      const del = e.target.closest('[data-bdel]');
      if (del) {
        const i = Number(del.dataset.bdel);
        if (i >= 0 && i < B.entries.length) B.entries.splice(i, 1);
        // 删空了就等于这份清单没了：清掉 savedId，免得下次「更新」把已存的记录抹成空
        if (!B.entries.length) { B.savedId = null; tagBarReset(cfg.tagKey); }
        renderBatch(kind);
        return;
      }
      if (e.target.closest('[data-bcopy]')) {
        UI.copy(batchText(kind, B.entries))
          .then(ok => toast(ok ? '已复制' : '复制失败，请长按手动选择', ok ? '' : 'error'));
        return;
      }
      if (e.target.closest('[data-bsave]'))  { batchSave(kind);  return; }
      if (e.target.closest('[data-bclear]')) { batchClear(kind); return; }
    });
  }

  /** 单个 / 批量切换。切走时清掉对面那块输出，免得两套结果并排摆着看不懂 */
  function setQuickMode(v) {
    qBatch.on = (v === 'batch');
    segSelect('q-mode', v, setQuickMode);
    $('#q-calc').textContent = qBatch.on ? '加入清单' : '计算';
    tagBarReset('quick');            // 换了模式，上一轮结果上的标签状态作废
    $('#q-out').innerHTML = '';
    $('#q-ask').innerHTML = '';      // 另一模式留下的「要你回话」的卡，换模式就作废
    renderBatch('quick');
  }

  function setDilutionMode(v) {
    dBatch.on = (v === 'batch');
    segSelect('d-mode', v, setDilutionMode);
    $('#d-calc').textContent = dBatch.on ? '加入清单' : '计算';
    $('#d-out').innerHTML = '';
    renderBatch('dilution');
  }

  /** 批量记录：payload 里带 entries。老记录没这个字段，一律按普通记录走 */
  function isBatchRec(x) {
    return !!(x && x.payload && x.payload.batch === true
      && Array.isArray(x.payload.entries) && x.payload.entries.length);
  }

  /* ══ 历史 ═══════════════════════════════════════════ */
  const MODNAME = { quick: '快速配液', ph: '缓冲体系', poly: '多质子酸', system: '体系配置', dilution: '母液稀释' };

  /* ── 历史：小标签 ──────────────────────────────────────
   * 一条记录可以打多个标签（像 tag，不是像文件夹）。
   * 标签单独存，历史记录里只存 id 数组 —— 改标签名不用回头遍历所有记录。 */
  let histFilter = null;      // null = 全部；否则按某个标签筛选
  let tagMenuFor = null;      // 正在展开"选择标签"下拉的那条记录 id
  let tagNewFor  = null;      // 其中又展开了"新建标签"输入框的那条记录 id
  let tagNewOpenDrawer = false;   // 侧栏底部的新建输入框是否展开

  function tagMapNow() {
    const m = {};
    Store.tagsList().forEach(t => { m[t.id] = t; });
    return m;
  }

  /** 展开着清单的历史记录 id —— 纯界面状态，不进 localStorage：
   *  它不是数据，写进 payload 会被带进 JSON 导出；批量明细可能几 KB，
   *  为一个箭头的开合反复整条序列化不值。和 tagMenuFor / tagNewFor 是同一种东西。 */
  const histOpen = new Set();
  const histRecipe = new Set();   // 哪些历史记录的「配方」是展开的

  /* 历史卡里就地展开的配方 —— 跟结果区同一张表、同一个算法，只是不带标签栏和动作按钮。
     数据从 payload.comps 现算：历史里存的是表单态、没存结果，现算才不必改数据结构，
     所以改造之前存的老记录也展开得出来（payload 一直是 {vol, comps}）。 */
  function recipeHtml(p) {
    const conv = compsToItems(p.comps || []);
    if (conv.error) {
      return '<div class="hist-list"><div class="note error">' + esc(conv.error) + '</div></div>';
    }
    let r;
    try { r = Calc.systemMix(conv.items, p.vol); }
    catch (err) {
      return '<div class="hist-list"><div class="note error">这份配方算不出来，点「重新调出」看看</div></div>';
    }

    const rows = r.rows.map((row, i) => {
      const it = conv.items[i];
      const amount = it.mode === 'stock'
        ? U.formatVol(row.volume).text
        : U.formatMass(row.mass).text;
      return '<tr><td>' + esc(it.name) + '</td>'
        + '<td class="num">' + esc(concLabel(it.targetConc, it.targetUnit)) + '</td>'
        + '<td class="num">' + esc(it.mode === 'stock' ? stockConcText(it) : '—') + '</td>'
        + '<td class="num">' + esc(amount) + '</td></tr>';
    }).join('');

    return '<div class="hist-list">'
      + '<table class="tbl tbl-4"><thead><tr>'
      + '<th>组分</th><th class="num">目标浓度</th>'
      + '<th class="num">母液浓度</th><th class="num">取用量</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="meta" style="margin-top:16px">'
      + row('最终体积', U.formatVol(p.vol).text)
      + row('母液合计', U.formatVol(r.totalStockVol).text)
      + row('补加溶剂', U.formatVol(Math.max(0, r.solventVol)).text)
      + '</div></div>';
  }

  /* 其余四个模块就地展开摆什么 —— 只读 payload 里存的表单态，**不重算**：
     重算要反查试剂形式（payload 里只存了 form 的 label 字符串），算不出来整条记录就废了；
     而用量本来就在卡面那一行（「60.57 mg」「mA + mB」「10 mL → 100 mL」），
     展开补的是卡面没有的那些：浓度、体积、温度、体系。
     取不到的字段直接不显示那一行 —— 老记录的 payload 可能缺字段。 */
  const DETAIL = {
    quick: [
      { k: '化合物',   v: p => p.query },
      { k: '目标浓度', v: p => p.conc > 0 ? U.formatConc(p.conc).text : '' },
      { k: '最终体积', v: p => p.vol > 0 ? U.formatVol(p.vol).text : '' }
    ],
    ph: [
      { k: '缓冲液',   v: p => (Buffers.bufferById(p.bufferId) || {}).name },
      { k: '已知条件', v: p => p.pH != null && p.tKnown != null
            ? U.formatPH(p.pH) + ' @ ' + p.tKnown + ' °C' : '' },
      { k: '目标温度', v: p => p.tTarget != null ? p.tTarget + ' °C' : '' }
    ],
    poly: [
      { k: '体系',     v: p => (Buffers.polyById(p.sysId) || {}).name },
      { k: '目标 pH',  v: p => p.pH != null && p.temp != null
            ? U.formatPH(p.pH) + ' @ ' + p.temp + ' °C' : '' },
      { k: '总浓度',   v: p => p.conc > 0 ? U.formatConc(p.conc).text : '' },
      { k: '最终体积', v: p => p.vol > 0 ? U.formatVol(p.vol).text : '' },
      { k: '酸 + 碱',  v: p => p.acidForm && p.baseForm
            ? p.acidForm + ' + ' + p.baseForm : '' }
    ],
    dilution: [
      // 浓度按记录时的原单位还原（% / × 和 M 的换算系数不同），旧记录没这字段就当 M
      { k: '母液浓度', v: p => p.c1 > 0 ? concLabelBase(p.c1, p.c1u || 'M') : '' },
      { k: '目标浓度', v: p => p.c2 > 0 ? concLabelBase(p.c2, p.c2u || 'M') : '' },
      { k: '目标体积', v: p => p.v2 > 0 ? U.formatVol(p.v2).text : '' }
    ]
  };

  function detailHtml(x) {
    const p = x.payload || {};
    const rows = (DETAIL[x.module] || []).map(f => {
      const v = f.v(p);
      return (v == null || v === 'undefined' || v === '') ? '' : row(f.k, esc(v));
    }).join('');
    return rows ? '<div class="hist-list"><div class="meta">' + rows + '</div></div>' : '';
  }

  function renderHistory() {
    const all  = Store.historyList();
    const tmap = tagMapNow();

    // 记录被删掉后把展开状态一起清掉，免得这两个 Set 越攒越大
    if (histOpen.size || histRecipe.size) {
      const alive = {};
      all.forEach(x => { alive[x.id] = 1; });
      [histOpen, histRecipe].forEach(set =>
        Array.from(set).forEach(id => { if (!alive[id]) set.delete(id); }));
    }

    const h = histFilter ? all.filter(x => (x.tags || []).indexOf(histFilter) >= 0) : all;
    const favN = h.filter(x => x.favorite).length;
    const fname = histFilter && tmap[histFilter] ? tmap[histFilter].name : '';
    $('#h-count').textContent = (fname ? '「' + fname + '」 ' : '')
      + h.length + ' 条' + (favN ? '（收藏 ' + favN + '）' : '');
    $('#h-clear-filter').hidden = !histFilter;

    const box = $('#h-list');
    if (!h.length) {
      box.innerHTML = histFilter
        ? '<div class="empty"><b>这个标签下还没有记录</b>在任意记录上点「＋ 标签」就能归进来</div>'
        : '<div class="empty"><b>还没有记录</b>算过一次之后，结果会自动存到这里</div>';
      return;
    }

    // 收藏的排前面
    const sorted = h.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

    box.innerHTML = sorted.map(x => {
      const mine = (x.tags || []).filter(id => tmap[id]);   // 标签可能已被删
      const chips = mine.map(id =>
        '<button class="tchip on" data-tag-off="' + esc(id) + '"'
        + ' aria-label="移除标签 ' + esc(tmap[id].name) + '">'
        + esc(tmap[id].name) + '<span class="tx">×</span></button>').join('');

      // 「＋ 标签」放标题右边，标签行只在真有标签时才占一行 —— 一屏能多放几条记录
      const isB   = isBatchRec(x);
      const nB    = isB ? x.payload.entries.length : 0;
      const openB = isB && histOpen.has(x.id);
      // 就地把这条记录配了什么摆出来：体系配置是一张完整配方表（带用量），
      // 其余模块是参数表（用量在卡面那一行）。批量记录不给这个按钮 —— 它有自己的「清单 n 项」
      const isSys = x.module === 'system';
      const canR  = !isB && !!x.payload
        && (isSys ? !!x.payload.comps : !!DETAIL[x.module]);
      const openR = canR && histRecipe.has(x.id);
      // 展开的清单跟页面上那份用同一个 entryHtml：存下去的和当时看到的长得一样，
      // 货架位置、名称换行这些排版也就只有一份，不会两边慢慢漂开
      const bRows = openB
        ? '<div class="hist-list">'
          + x.payload.entries.map(e => entryHtml(x.module, e, null)).join('')
          + '</div>'
        : '';

      return '<div class="hist" data-id="' + esc(x.id) + '">'
        + '<div class="hist-top">'
        +   '<div class="hist-head">'
        +     '<div class="hist-title">' + esc(x.name || x.title) + '</div>'
        +     '<div class="hist-sub">' + esc(MODNAME[x.module] || x.module) + ' · ' + UI.ago(x.ts) + '</div>'
        +   '</div>'
        +   '<div class="hist-topacts">'
        +     '<button class="tchip-add" data-tag-open aria-expanded="'
        +       (tagMenuFor === x.id ? 'true' : 'false') + '">＋ 标签</button>'
        +     '<button class="star' + (x.favorite ? ' on' : '') + '" data-fav aria-label="收藏">'
        +       (x.favorite ? '★' : '☆') + '</button>'
        +   '</div>'
        + '</div>'
        + '<div class="hist-sum">' + esc(x.summary || '') + '</div>'
        + (chips ? '<div class="hist-tags">' + chips + '</div>' : '')
        + (tagMenuFor === x.id ? tagMenuHtml(x, tmap, tagNewFor === x.id) : '')
        + '<div class="hist-acts">'
        // 展开按钮放动作行第一个：复用现成的 .btn.tiny，不新增组件
        +   (isB ? '<button class="btn tiny" data-hopen aria-expanded="'
                + (openB ? 'true' : 'false') + '">清单 ' + nB + ' 项 '
                + (openB ? '▴' : '▾') + '</button>' : '')
        +   (canR ? '<button class="btn tiny" data-hrecipe aria-expanded="'
                 + (openR ? 'true' : 'false') + '">配方 '
                 + (openR ? '▴' : '▾') + '</button>' : '')
        +   '<button class="btn tiny" data-again>重新调出</button>'
        +   '<button class="btn tiny" data-rename>命名</button>'
        +   '<button class="btn tiny danger" data-del>删除</button>'
        + '</div>'
        + bRows
        + (openR ? (isSys ? recipeHtml(x.payload) : detailHtml(x)) : '')
        + '</div>';
    }).join('');
  }

  /** 打标签的下拉：列出所有标签（可勾）+ 最底下"新建"
   *  newOpen / inputId 由调用方给 —— 历史页和结果区各用各的输入框 id
   *  cls 追加类名：结果区传 'pop' 让它浮在内容上方，不撑开排版 */
  function tagMenuHtml(item, tmap, newOpen, inputId, cls) {
    const mine = item.tags || [];
    const counts = Store.tagCounts();
    const iid = inputId || 'h-newtag';
    const wrap = 'tmenu' + (cls ? ' ' + cls : '');

    if (newOpen) {
      return '<div class="' + wrap + '"><div class="tmenu-new">'
        + '<input class="in" id="' + iid + '" type="text" maxlength="' + Store.TAG_NAME_MAX + '"'
        + ' placeholder="标签名，如 配胶" autocomplete="off">'
        + '<button class="btn tiny" id="' + iid + '-ok">建立</button>'
        + '</div></div>';
    }

    const tags = Store.tagsList();
    let rows = tags.map(t =>
      '<button class="tmenu-item" data-tag-toggle="' + esc(t.id) + '">'
      + '<span class="ck">' + (mine.indexOf(t.id) >= 0 ? '✓' : '') + '</span>'
      + '<span class="nm">' + esc(t.name) + '</span>'
      + '<span class="ct">' + (counts[t.id] || 0) + '</span></button>').join('');
    if (!tags.length) rows = '<div class="tmenu-empty">还没有标签，先建一个</div>';

    return '<div class="' + wrap + '">' + rows
      + '<button class="tmenu-item new" data-tag-new>＋ 新建标签…</button></div>';
  }

  /* ── 结果区的标签行（快速配液 / 体系配置共用）───────────
   * 标签是打在历史记录上的，所以这两块都得先存了历史记录才谈得上打标签。 */
  const TAGBAR = {
    quick:  { host: '#q-out', box: '#q-tagbox', id: null, menu: false, nw: false },
    system: { host: '#s-out', box: '#s-tagbox', id: null, menu: false, nw: false },
    /* 批量清单的标签行：标签打在「保存到历史」那一条上，所以存过历史它才会显示。
       host 必须是静态容器（#q-batch / #d-batch 在 index.html 里），
       绝不能挂到 tagbox 自己身上 —— 那个每次重绘都是新元素。 */
    quickBatch:    { host: '#q-batch', box: '#q-batch-tagbox', id: null, menu: false, nw: false },
    dilutionBatch: { host: '#d-batch', box: '#d-batch-tagbox', id: null, menu: false, nw: false }
  };

  function tagBarReset(key) {
    const t = TAGBAR[key];
    t.id = null; t.menu = false; t.nw = false;
  }

  function tagBarRender(key) {
    const t = TAGBAR[key];
    const host = $(t.box);
    if (!host) return;
    const item = t.id ? Store.historyList().find(x => x.id === t.id) : null;
    if (!item) { host.innerHTML = ''; return; }   // 记录被删了就整块收起来

    const tmap = tagMapNow();
    const mine = (item.tags || []).filter(id => tmap[id]);

    host.innerHTML = '<div class="hist-tags">'
      + mine.map(id =>
          '<button class="tchip on" data-tgoff="' + esc(id) + '"'
          + ' aria-label="移除标签 ' + esc(tmap[id].name) + '">'
          + esc(tmap[id].name) + '<span class="tx">×</span></button>').join('')
      + '<button class="tchip-add" data-tgopen aria-expanded="'
      +   (t.menu ? 'true' : 'false') + '">＋ 标签</button>'
      + '</div>'
      + (t.menu ? tagMenuHtml(item, tmap, t.nw, key + '-newtag', 'pop') : '');
  }

  function tagBarCreate(key, name) {
    const t = TAGBAR[key];
    if (!t.id || !tagOn(name, t.id)) return;
    t.nw = false;
    tagBarRender(key);
  }

  /* 事件挂在结果容器（#q-out / #s-out）上而不是标签块本身 ——
     标签块是每次渲染重建的，挂它身上等于绑了个一次性的空壳 */
  function bindTagBar(key) {
    const t = TAGBAR[key];
    const box = $(t.host);
    if (!box) return;

    box.addEventListener('click', e => {
      if (!t.id) return;
      const tg = sel => e.target.closest(sel);

      if (tg('[data-tgopen]')) {
        t.menu = !t.menu; t.nw = false;
        tagBarRender(key);
      } else if (tg('[data-tgoff]')) {
        Store.historyTag(t.id, tg('[data-tgoff]').dataset.tgoff, false);
        tagBarRender(key);
      } else if (tg('[data-tag-toggle]')) {
        const tid = tg('[data-tag-toggle]').dataset.tagToggle;
        const item = Store.historyList().find(x => x.id === t.id);
        const on = !(item && (item.tags || []).indexOf(tid) >= 0);
        Store.historyTag(t.id, tid, on);
        tagBarRender(key);
      } else if (tg('[data-tag-new]')) {
        t.nw = true;
        tagBarRender(key);
        const inp = $('#' + key + '-newtag');
        if (inp) inp.focus();
      } else if (tg('#' + key + '-newtag-ok')) {
        tagBarCreate(key, $('#' + key + '-newtag').value);
      }
    });

    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === key + '-newtag') {
        tagBarCreate(key, e.target.value);
      }
    });
  }

  /** 收起所有展开的标签下拉（结果区 + 历史页）。没展开的就什么也不做 */
  function dismissTagMenus() {
    Object.keys(TAGBAR).forEach(k => {
      const t = TAGBAR[k];
      if (!t.menu && !t.nw) return;
      t.menu = false; t.nw = false;
      tagBarRender(k);
    });
    if (tagMenuFor || tagNewFor) {
      tagMenuFor = null; tagNewFor = null;
      renderHistory();
    }
  }

  /* 点下拉外面 / 按 Esc 收起 —— 不然下拉开着就只能再点一次那个按钮才关得掉 */
  function bindTagDismiss() {
    document.addEventListener('click', e => {
      const el = e.target;
      if (!el || !el.closest) return;
      if (el.closest('.tmenu')) return;                  // 点在菜单里：菜单自己处理
      if (el.closest('[data-tgopen]') || el.closest('[data-tag-open]')) return;  // 点的是开合按钮
      dismissTagMenus();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') dismissTagMenus();
    });
  }

  /* ── 标签侧栏：从左侧滑出，可收回 ─────────────────── */
  function openDrawer() {
    renderTagDrawer();
    $('#h-drawer').hidden = false;
    $('#h-scrim').hidden = false;
    $('#h-tags-btn').setAttribute('aria-expanded', 'true');
    // 先让它出现在 DOM 里再加 .open，否则 hidden 的取消和 transition 撞一起不会动
    requestAnimationFrame(() => $('#h-drawer').classList.add('open'));
    setTimeout(() => $('#h-drawer-x').focus(), 0);
  }

  function closeDrawer() {
    const d = $('#h-drawer');
    if (d.hidden) return;
    d.classList.remove('open');
    $('#h-tags-btn').setAttribute('aria-expanded', 'false');
    const done = () => { d.hidden = true; $('#h-scrim').hidden = true; };
    if (prefersReduced()) done(); else setTimeout(done, 220);
    $('#h-tags-btn').focus();
  }

  function renderTagDrawer() {
    const counts = Store.tagCounts();
    const tags = Store.tagsList();
    let html = '<div class="tagitem' + (histFilter === null ? ' on' : '') + '" data-tag-row="">'
      + '<button class="nm" data-tag-filter="">全部</button>'
      + '<span class="ct">' + Store.historyList().length + '</span>'
      + '<span class="rm" aria-hidden="true"></span></div>';

    html += tags.map(t =>
      '<div class="tagitem' + (histFilter === t.id ? ' on' : '') + '" data-tag-row="' + esc(t.id) + '">'
      + '<button class="nm" data-tag-filter="' + esc(t.id) + '">' + esc(t.name) + '</button>'
      + '<span class="ct">' + (counts[t.id] || 0) + '</span>'
      + '<button class="rm" data-tag-del="' + esc(t.id) + '"'
      + ' aria-label="删除标签 ' + esc(t.name) + '">×</button></div>').join('');

    if (!tags.length) {
      html += '<div class="tmenu-empty">还没有标签。点下面的按钮建一个，'
        + '然后在历史记录上打标签。</div>';
    }
    $('#h-taglist').innerHTML = html;

    const foot = $('.drawer-foot');
    foot.innerHTML = tagNewOpenDrawer
      ? '<div class="drawer-new">'
        + '<input class="in" id="h-newtag2" type="text" maxlength="' + Store.TAG_NAME_MAX + '"'
        + ' placeholder="标签名，如 配胶" autocomplete="off">'
        + '<button class="btn tiny" id="h-newtag2-ok">建立</button></div>'
      : '<button class="btn tiny" id="h-tag-new">＋ 新建标签</button>';
  }

  function bindHistoryEvents() {
    $('#h-list').addEventListener('click', e => {
      const card = e.target.closest('.hist'); if (!card) return;
      const id = card.dataset.id;
      const item = Store.historyList().find(x => x.id === id);
      if (!item) return;

      if (e.target.closest('[data-fav]')) {
        Store.historyUpdate(id, { favorite: !item.favorite });
        renderHistory();
      } else if (e.target.closest('[data-del]')) {
        Store.historyDel(id);
        renderHistory();
        toast('已删除');
      } else if (e.target.closest('[data-rename]')) {
        const n = prompt('给这条记录起个名字', item.name || item.title || '');
        if (n != null) { Store.historyUpdate(id, { name: n.trim() }); renderHistory(); }
      } else if (e.target.closest('[data-again]')) {
        recall(item);
      } else if (e.target.closest('[data-hopen]')) {
        if (histOpen.has(id)) histOpen.delete(id); else histOpen.add(id);
        renderHistory();
      } else if (e.target.closest('[data-hrecipe]')) {
        if (histRecipe.has(id)) histRecipe.delete(id); else histRecipe.add(id);
        renderHistory();

      /* ── 标签 ── */
      } else if (e.target.closest('[data-tag-open]')) {
        tagMenuFor = (tagMenuFor === id) ? null : id;
        tagNewFor = null;
        renderHistory();
      } else if (e.target.closest('[data-tag-off]')) {
        Store.historyTag(id, e.target.closest('[data-tag-off]').dataset.tagOff, false);
        renderHistory();
      } else if (e.target.closest('[data-tag-toggle]')) {
        const tid = e.target.closest('[data-tag-toggle]').dataset.tagToggle;
        const on = (item.tags || []).indexOf(tid) < 0;
        Store.historyTag(id, tid, on);
        renderHistory();
      } else if (e.target.closest('[data-tag-new]')) {
        tagNewFor = id;
        renderHistory();
        const inp = $('#h-newtag');
        if (inp) inp.focus();
      }
    });

    // 新建标签的输入框（在历史卡片的下拉里）
    $('#h-list').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('.hist'); if (!card) return;
      if (e.target.id !== 'h-newtag') return;
      createTagFromMenu(e.target.value, card.dataset.id);
    });
    $('#h-list').addEventListener('click', e => {
      if (!e.target.closest('#h-newtag-ok')) return;
      const card = e.target.closest('.hist'); if (!card) return;
      createTagFromMenu($('#h-newtag').value, card.dataset.id);
    });

    /* ── 侧栏 ── */
    $('#h-tags-btn').addEventListener('click', openDrawer);
    $('#h-drawer-x').addEventListener('click', closeDrawer);
    $('#h-scrim').addEventListener('click', closeDrawer);
    $('#h-clear-filter').addEventListener('click', () => {
      histFilter = null;
      renderHistory();
      renderTagDrawer();
    });

    $('#h-drawer').addEventListener('click', e => {
      const del = e.target.closest('[data-tag-del]');
      if (del) {
        const t = tagMapNow()[del.dataset.tagDel];
        if (t && confirm('删除标签「' + t.name + '」？\n\n记录本身不会删，只是从这个标签里移出来。')) {
          Store.tagDel(del.dataset.tagDel);
          if (histFilter === del.dataset.tagDel) histFilter = null;
          renderTagDrawer();
          renderHistory();
        }
        return;
      }
      const f = e.target.closest('[data-tag-filter]');
      if (f) {
        histFilter = f.dataset.tagFilter || null;
        renderTagDrawer();
        renderHistory();
        closeDrawer();
        return;
      }
      if (e.target.closest('#h-tag-new')) {
        tagNewOpenDrawer = true;
        renderTagDrawer();
        const inp = $('#h-newtag2');
        if (inp) inp.focus();
        return;
      }
      if (e.target.closest('#h-newtag2-ok')) {
        createTagFromDrawer($('#h-newtag2').value);
      }
    });

    $('#h-drawer').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'h-newtag2') {
        createTagFromDrawer(e.target.value);
      }
    });

    // Esc 收起侧栏 —— 焦点可能不在侧栏里（比如还停在历史列表上），所以挂在 document
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#h-drawer').hidden) closeDrawer();
    });
  }

  /** 建标签。返回标签对象；名字为空返回 null */
  function createTag(name) {
    const t = Store.tagAdd(name);
    if (!t) { toast('标签名不能为空', 'error'); return null; }
    return t;
  }

  /** 建标签并打在指定历史记录上（已存在同名标签就直接用那个）。
   *  成功返回标签对象，名字为空返回 null —— 刷新界面的活交给调用方。 */
  function tagOn(name, itemId) {
    const t = createTag(name);
    if (!t) return null;
    Store.historyTag(itemId, t.id, true);
    toast('已加标签「' + t.name + '」');
    return t;
  }

  function createTagFromMenu(name, itemId) {
    if (!tagOn(name, itemId)) return;
    tagNewFor = null;
    renderHistory();
    if (currentView === 'history') renderTagDrawer();
  }

  function createTagFromDrawer(name) {
    const t = createTag(name);
    if (!t) return;
    tagNewOpenDrawer = false;
    renderTagDrawer();
    toast('已建标签「' + t.name + '」');
  }

  /** 调出历史后清空结果区 —— 只填了参数、还没算，留着上一条的结果会让人以为那就是这条的 */
  function clearRecalledOut(module) {
    const box = { quick: '#q-out', ph: '#t-out', poly: '#p-out',
                  dilution: '#d-out', system: '#s-out' }[module];
    if (box) $(box).innerHTML = '';
    // 快速配液还有一块「要你回话」的卡（选形式 / 手填分子量），上一轮的也作废
    if (module === 'quick') { $('#q-ask').innerHTML = ''; tagBarReset('quick'); }
    if (module === 'system') tagBarReset('system');
  }

  /** 把历史记录调回对应模块，**只填参数、不重算**（2026-09-25 用户要求）：
   *  要算得用户自己点计算 / 回车 / 重选形式 —— 那时才会弹「确定覆盖？」。 */
  function recall(item) {
    const p = item.payload || {};

    /* 批量记录：entries 里存的就是算好的结果，不用重跑 —— 也没法重跑，
       每一项当初的浓度和体积都可能不一样。直接把清单还回去，用户接着往里加。 */
    if (isBatchRec(item)) {
      const kind = item.module === 'dilution' ? 'dilution' : 'quick';
      const cfg = BATCHCFG[kind], B = batchOf(kind);
      B.entries = JSON.parse(JSON.stringify(p.entries));
      B.savedId = item.id;                 // 就是这条记录：保存按钮显示「更新历史记录」
      tagBarReset(cfg.tagKey);
      TAGBAR[cfg.tagKey].id = item.id;     // 先设 id 再渲染，省一次重绘
      if (kind === 'dilution') setDilutionMode('batch'); else setQuickMode('batch');
      go(kind);
      toast('已调出清单，可以接着往里加');
      return;
    }

    // 从这条开始编辑：在它上面点计算会问要不要覆盖它（批量记录不走这套，见上）
    editingRec = { module: item.module, id: item.id };

    if (item.module === 'quick') {
      $('#q-name').value = p.query || '';
      // payload 里的 conc / vol 是基准值（mol/L、L），单位下拉必须跟着一起复位 ——
      // 只填数字不填单位的话，用户上次停在 mM，调出 1 M 的历史就变成 1 mM。
      // 单位挑读数友好的那档：1 mM 比 0.001 M 好认。
      const qcu = U.formatConc(p.conc > 0 ? p.conc : 1).unit;
      $('#q-concu').value = qcu;
      if (p.conc) $('#q-conc').value = U.formatConc(p.conc, { unit: qcu }).value;
      const qvu = U.formatVol(p.vol > 0 ? p.vol : 1e-3).unit;
      $('#q-volu').value = qvu;
      if (p.vol) $('#q-vol').value = U.formatVol(p.vol, { unit: qvu }).value;
      go('quick');
      clearRecalledOut('quick');
    } else if (item.module === 'ph') {
      $('#t-buf').value = p.bufferId || 'tris';
      if (p.pH != null) $('#t-ph').value = p.pH;
      if (p.tKnown != null) $('#t-t1').value = p.tKnown;
      if (p.tTarget != null) $('#t-t2').value = p.tTarget;
      go('ph');
      setTimeout(() => switchTab('temp'), 60);
      clearRecalledOut('ph');
    } else if (item.module === 'poly') {
      $('#p-sys').value = p.sysId || 'k-phosphate';
      syncPolyForms();
      if (p.pH != null) $('#p-ph').value = p.pH;
      if (p.temp != null) $('#p-temp').value = p.temp;
      if (p.conc != null) $('#p-conc').value = p.conc;
      // p.vol 存的是升，回填要按当前单位换算（默认 mL）
      if (p.vol != null) $('#p-vol').value = (p.vol / U.volFactor('mL')).toString();
      $('#p-volu').value = 'mL';
      go('ph');
      setTimeout(() => switchTab('poly'), 60);
      clearRecalledOut('poly');
    } else if (item.module === 'dilution') {
      // 按记录时的原单位还原（% / × 和 M 的换算系数不同）。
      // 旧记录没有 c1u 这些字段 —— 那时存的就是基准单位 M / mM / mL，正好当默认值。
      const ru1 = p.c1u || 'M', ru2 = p.c2u || 'mM', ru3 = p.v2u || 'mL';
      $('#d-c1u').value = ru1;
      if (p.c1) $('#d-c1').value = Number(p.c1 / U.concFactor(ru1)).toString();
      $('#d-c2u').value = ru2;
      if (p.c2) $('#d-c2').value = Number(p.c2 / U.concFactor(ru2)).toString();
      $('#d-v2u').value = ru3;
      if (p.v2) $('#d-v2').value = Number(p.v2 / U.volFactor(ru3)).toString();
      $('#d-name').value = p.name || '';
      go('dilution');
      clearRecalledOut('dilution');
    } else if (item.module === 'system') {
      if (p.vol) $('#s-vol').value = (p.vol / U.volFactor('mL')).toString();
      $('#s-volu').value = 'mL';
      comps = (p.comps || []).map(c => Object.assign(newComp(), c, { key: 'c' + (++compSeq) }));
      renderComps();
      go('system');
      clearRecalledOut('system');
    }
    toast('已调出，参数可修改');
  }

  /* ══ 设置 ═══════════════════════════════════════════ */
  function applyTheme() {
    const t = settings.theme;
    const dark = t === 'dark'
      || (t === 'auto' && global.matchMedia
          && global.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function segSelect(id, value, cb) {
    $$('#' + id + ' button').forEach(b => {
      b.classList.toggle('on', String(b.dataset.v) === String(value));
      b.onclick = () => { cb(b.dataset.v); };
    });
  }

  function renderSettings() {
    segSelect('set-theme', settings.theme, v => {
      settings = Store.settingsSet({ theme: v });
      applyTheme();
      renderSettings();
    });
    segSelect('set-sig', settings.sigFigs, v => {
      settings = Store.settingsSet({ sigFigs: Number(v) });
      renderSettings();
    });

    $('#set-defvol').value = settings.defVol;
    $('#set-defvolu').value = settings.defVolUnit;
    $('#set-defconc').value = settings.defConc;
    $('#set-defconcu').value = settings.defConcUnit;
    $('#set-online').checked = settings.onlineQuery !== false;
    $('#set-caskey').value = settings.casApiKey || '';

    renderCacheList();
    renderAiSettings();
    // 试剂表要重画的时机：切到设置页、清除所有数据之后（那时候表已经被清空）
    invPending = null;
    renderInv();
  }

  function renderCacheList() {
    const list = Store.cacheList();
    const box = $('#set-cache-list');
    if (!list.length) {
      box.innerHTML = '<p class="hint" style="margin-top:0">还没有缓存的化合物</p>';
      return;
    }
    box.innerHTML = list.map(c =>
      '<div class="meta-row" style="align-items:center">'
      + '<span class="meta-k">' + esc(c.name || c.cas || c.key)
      + (c.cas && c.name ? ' · ' + esc(c.cas) : '') + '</span>'
      + '<span class="meta-v">' + (c.mw ? c.mw.toFixed(2) : '—')
      + ' <button class="btn tiny" data-dc="' + esc(c.key) + '">删</button></span>'
      + '</div>').join('');

    $$('[data-dc]', box).forEach(b => b.addEventListener('click', () => {
      Store.cacheDel(b.dataset.dc);
      renderCacheList();
      toast('已删除');
    }));
  }

  /* ── 中文名识别（AI）的设置 ────────────────────────────
   * 五家服务商的 endpoint 和默认模型都在 Lookup.LLM 里，都是 OpenAI 兼容格式，
   * 所以这边只要把下拉填上、把值读写对就行。 */

  function renderAiSettings() {
    const sel = $('#set-ai-provider');
    if (!sel) return;
    if (!sel.options.length) {                 // 选项只填一次
      sel.innerHTML = Object.keys(Lookup.LLM)
        .map(k => '<option value="' + esc(k) + '">' + esc(Lookup.LLM[k].name) + '</option>').join('');
    }
    sel.value = settings.llmProvider || 'siliconflow';
    const preset = Lookup.LLM[sel.value] || {};

    $('#set-ai-body').hidden = !settings.llmOn;
    // 接口地址只有「自定义」才要用户填；预设的五家写死在自己的 url 里
    $('#set-ai-url-row').hidden = sel.value !== 'custom';
    $('#set-ai-url').value = settings.llmUrl || '';
    $('#set-ai-url').placeholder = preset.url || 'https://…/v1/chat/completions';
    $('#set-ai-key').value = settings.llmKey || '';
    // 模型留空 = 用预设。placeholder 把预设显示出来，用户就知道不填会用哪个
    $('#set-ai-model').value = settings.llmModel || '';
    $('#set-ai-model').placeholder = preset.model || '模型名';

    const h = $('#set-ai-hint');
    h.textContent = !settings.llmOn
      ? '开启后，只有查不到的中文名会发给所选服务商识别；能查到的不发，不花冤枉钱。'
      : (!settings.llmKey
          ? '还没填 API Key，中文名识别不会生效。'
          : 'Key 只存在这台设备上，请求直接发给服务商，不经过任何中间服务器。'
            + '免费额度和模型名以各家官网为准，可以自己改。');
  }

  /* ── 我的试剂表：粘贴 / 选文件 → 预览 → 确认 ─────────────
   * 三段式是硬要求：绝不静默吞掉用户粘贴的东西。
   * 预览里逐条列出解析结果和每个问题的行号，用户点确认才落库。 */

  let invPending = null;   // 还没确认的解析结果；null = 当前没在预览
  let invText = '';        // 粘贴框里的原文 —— 切到预览再切回来不能丢

  /** 顶部：已导入多少条 + 重新导入 / 清空 */
  function renderInvStatus() {
    const n = Store.inventoryGet().length;
    const box = $('#inv-status');
    if (!box) return;
    box.innerHTML = n
      ? '<div class="meta-row"><span class="meta-k">已导入 <b>' + n + '</b> 条</span>'
        + '<span class="meta-v"><button class="btn tiny" id="inv-re">重新导入</button> '
        + '<button class="btn tiny danger" id="inv-clear">清空</button></span></div>'
      : '<div class="meta-row"><span class="meta-k">'
        + '<span class="meta-none">还没有导入</span></span></div>';
    /* localStorage 用不了时（隐私模式、配额爆掉）store.js 会降级到内存 ——
       功能照常，但刷新就没了。对一张要反复查的试剂表来说这是必须讲清楚的事，
       否则用户导完、刷新、发现没了，只会以为自己没点成功 */
    if (!Store.lsOK) {
      box.innerHTML += '<p class="hint">这个浏览器不让写入本地存储（可能开着隐私模式，'
        + '或存储已满），导入的试剂表刷新后会丢失。</p>';
    }
    const re = $('#inv-re');
    if (re) re.addEventListener('click', () => { invPending = null; invText = ''; renderInvUi(); });
    const cl = $('#inv-clear');
    if (cl) cl.addEventListener('click', () => {
      if (!confirm('确定清空导入的试剂表吗？清空后这些试剂的分子量和位置就都查不到了。')) return;
      Store.inventoryClear();
      Inventory.reload();
      invPending = null; invText = '';
      renderInvStatus(); renderInvUi();
      toast('已清空试剂表');
    });
  }

  /** 粘贴区 */
  function invPasteHtml() {
    return '<label class="lbl sm" for="inv-text">从 Excel 选中区域复制，粘贴到这里</label>'
      + '<textarea id="inv-text" class="in ta" rows="5" spellcheck="false"'
      + ' autocapitalize="off" autocomplete="off"'
      + ' placeholder="中文名&#9;英文名&#9;分子量&#9;CAS&#9;位置&#9;分组'
      + '&#10;乙酸铵&#9;Ammonium acetate&#9;77.08&#9;631-61-8&#9;A-99&#9;A柜"></textarea>'
      + '<div class="inrow"><button type="button" class="btn" id="inv-file">选择 CSV 文件…</button>'
      + '<button type="button" class="btn" id="inv-parse">预览</button></div>'
      + '<input type="file" id="inv-file-input" accept=".csv,.txt,.tsv,text/csv,text/plain" hidden>';
  }

  /** 预览区：解析结果 + 问题清单 + 确认/取消 */
  function invPreviewHtml() {
    const p = invPending, c = p.counts;
    const rows = p.records.slice(0, 5).map(r =>
      '<div class="meta-row"><span class="meta-k">' + esc(r.zh || r.en) + '</span>'
      + '<span class="meta-v">' + (r.mw ? esc(String(r.mw)) + ' g/mol' : '无分子量')
      + (r.code ? '　' + esc((r.tag ? r.tag + ' ' : '') + r.code) : '') + '</span></div>').join('');

    // 问题按行号升序，最多列 8 条，剩下的折叠成一句
    const ps = p.problems.slice().sort((a, b) => a.line - b.line);
    const shown = ps.slice(0, 8).map(x =>
      '<div class="meta-row"><span class="meta-k">'
      + (x.line ? '第 ' + x.line + ' 行' : '整体') + '</span>'
      + '<span class="meta-v">' + esc(x.msg) + '</span></div>').join('');
    const rest = ps.length > 8 ? '<p class="hint">还有 ' + (ps.length - 8) + ' 个问题没列出来</p>' : '';
    const errN = ps.filter(x => x.level === 'error').length;

    return '<div class="result-label">预览' + (p.header.detected ? '（按表头对应）' : '（没认到表头，按列序对应）')
      + '</div>'
      + '<div class="meta-row"><span class="meta-k">可以导入</span><span class="meta-v"><b>'
      + c.good + '</b> 条' + (c.bad ? '　跳过 <b>' + c.bad + '</b> 条' : '') + '</span></div>'
      + rows
      + (p.records.length > 5 ? '<p class="hint">（只列了前 5 条）</p>' : '')
      + (ps.length ? '<div class="note' + (errN ? ' warn' : '') + '">' + shown + rest + '</div>' : '')
      + '<div class="inrow"><button type="button" class="btn" id="inv-ok">'
      + (c.good ? '确认导入这 ' + c.good + ' 条' : '没有可导入的行') + '</button>'
      + '<button type="button" class="btn tiny" id="inv-cancel">返回</button></div>';
  }

  function renderInvUi() {
    const box = $('#inv-ui');
    if (!box) return;
    box.innerHTML = invPending ? invPreviewHtml() : invPasteHtml();

    if (invPending) {
      const okb = $('#inv-ok');
      if (okb) okb.disabled = !invPending.counts.good;
      if (okb) okb.addEventListener('click', () => {
        const rows = invPending.records;
        // inventorySet 返回 false = 没存进去。绝不能假报成功 ——
        // 用户以为导进去了，之后查不到试剂会以为自己记错了
        if (!Store.inventorySet(rows)) {
          toast('存不下：这张表太大，或浏览器存储已满。试试先在设置里清掉分子量缓存', 'error');
          return;
        }
        Inventory.reload();
        invPending = null; invText = '';
        renderInvStatus(); renderInvUi();
        toast('已导入 ' + rows.length + ' 条');
      });
      const cb = $('#inv-cancel');
      if (cb) cb.addEventListener('click', () => { invPending = null; renderInvUi(); });
      return;
    }

    const ta = $('#inv-text');
    if (ta) ta.value = invText;
    const parse = () => {
      invText = ta ? ta.value : '';
      if (!invText.trim()) { toast('先粘贴内容或选一个 CSV 文件', 'error'); return; }
      const p = InvImport.parseTable(invText);
      if (!p.ok) {
        toast(p.problems.length ? p.problems[0].msg : '没解析出任何内容', 'error');
        return;
      }
      invPending = p;
      renderInvUi();
    };
    if ($('#inv-parse')) $('#inv-parse').addEventListener('click', parse);

    const fin = $('#inv-file-input');
    if ($('#inv-file')) $('#inv-file').addEventListener('click', () => fin.click());
    fin.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';                       // 同一个文件选两次也要触发
      if (!f) return;
      if (f.size > Store.INV_MAX) { toast('文件太大了（上限 2 MB）', 'error'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const buf = fr.result;
        let text;
        try {
          /* 先按 UTF-8 严格解码。中文 Windows 上 Excel「另存为 CSV」默认是 GBK，
             当 UTF-8 读会得到一屏乱码 —— 与其让乱码进预览，不如让它抛错再换 GBK 重试。
             fatal:true 就是干这个的 */
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (err) {
          try { text = new TextDecoder('gbk').decode(buf); }
          catch (err2) { toast('这个文件的编码读不了，请在 Excel 里另存为 UTF-8 的 CSV', 'error'); return; }
        }
        invText = text;
        if (ta) ta.value = text;
        parse();
      };
      fr.onerror = () => toast('文件读不出来', 'error');
      fr.readAsArrayBuffer(f);
    });
  }

  function renderInv() { renderInvStatus(); renderInvUi(); }

  function bindSettings() {
    const saveDefaults = () => {
      settings = Store.settingsSet({
        defVol: U.num($('#set-defvol').value) || 50,
        defVolUnit: $('#set-defvolu').value,
        defConc: U.num($('#set-defconc').value) || 1,
        defConcUnit: $('#set-defconcu').value
      });
      toast('已保存默认单位');
    };
    ['set-defvol', 'set-defvolu', 'set-defconc', 'set-defconcu']
      .forEach(id => $('#' + id).addEventListener('change', saveDefaults));

    $('#set-online').addEventListener('change', e => {
      settings = Store.settingsSet({ onlineQuery: e.target.checked });
      toast(e.target.checked ? '已开启联网查询' : '已关闭联网查询');
    });

    $('#set-caskey').addEventListener('change', e => {
      settings = Store.settingsSet({ casApiKey: e.target.value.trim() });
      toast('已保存');
    });

    /* 中文名识别：开关 + 服务商 + Key + 模型 */
    $('#set-ai').addEventListener('change', e => {
      settings = Store.settingsSet({ llmOn: e.target.checked });
      renderAiSettings();
      toast(e.target.checked ? '已开启中文名识别' : '已关闭中文名识别');
    });
    $('#set-ai-provider').addEventListener('change', e => {
      // 换服务商时把上一家的地址和模型清掉 —— 留着它们会拿着 A 家的模型名去请求 B 家
      settings = Store.settingsSet({ llmProvider: e.target.value, llmUrl: '', llmModel: '' });
      renderAiSettings();
    });
    ['set-ai-key', 'set-ai-url', 'set-ai-model'].forEach(id =>
      $('#' + id).addEventListener('change', () => {
        settings = Store.settingsSet({
          llmKey: $('#set-ai-key').value.trim(),
          llmUrl: $('#set-ai-url').value.trim(),
          llmModel: $('#set-ai-model').value.trim()
        });
        renderAiSettings();
        toast('已保存');
      }));

    $('#set-clear-cache').addEventListener('click', () => {
      Store.cacheClear();
      renderCacheList();
      toast('缓存已清空');
    });

    $('#set-clear-all').addEventListener('click', () => {
      if (!confirm('确定要删除所有历史记录、缓存和设置吗？此操作不可撤销。')) return;
      Store.clearAll();
      settings = Store.settingsGet();
      applyTheme();
      renderSettings();
      toast('已清除所有数据');
    });

    $('#h-clear').addEventListener('click', async () => {
      // 收藏的和带标签的是用户特意留下的，清空时跨过它们
      const all = Store.historyList();
      const keep = all.filter(x => x.favorite || (x.tags || []).length);
      const n = all.length - keep.length;
      if (!n) { toast('没有可清空的记录 —— 收藏的和带标签的都会留下'); return; }
      if (!await UI.askConfirm('清空 ' + n + ' 条历史记录？收藏的和带标签的会保留。')) return;
      Store.historyClear(keep);
      renderHistory();
      toast('已清空 ' + n + ' 条');
    });

    $('#h-export').addEventListener('click', () => {
      const h = Store.historyList();
      if (!h.length) { toast('还没有记录可导出', 'error'); return; }
      const csv = [['时间', '模块', '名称', '结果']].concat(
        h.map(x => [new Date(x.ts).toLocaleString('zh-CN'),
                    MODNAME[x.module] || x.module, x.name || x.title || '', x.summary || ''])
      ).map(a => a.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      downloadFile('配液历史.csv', '﻿' + csv, 'text/csv;charset=utf-8');
    });

    $('#h-export-json').addEventListener('click', () => {
      const h = Store.historyList();
      if (!h.length) { toast('还没有记录可导出', 'error'); return; }
      downloadFile('配液历史.json', JSON.stringify(h, null, 2), 'application/json');
    });
  }

  /* ══ 子 Tab ═════════════════════════════════════════ */
  function switchTab(name) {
    $$('#view-ph .tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#pane-temp').hidden = (name !== 'temp');
    $('#pane-poly').hidden = (name !== 'poly');
  }

  /* ══ 启动 ═══════════════════════════════════════════ */
  function init() {
    applyTheme();

    // 单位下拉
    fillSelect($('#q-concu'), U.MOLAR_UNITS, settings.defConcUnit || 'M');
    fillSelect($('#q-volu'), U.VOL_UNITS, settings.defVolUnit || 'mL');
    fillSelect($('#p-volu'), U.VOL_UNITS, 'mL');
    fillSelect($('#s-volu'), U.VOL_UNITS, 'mL');
    fillSelect($('#d-c1u'), U.CONC_UNITS, 'M');
    fillSelect($('#d-c2u'), U.CONC_UNITS, 'mM');
    fillSelect($('#d-v2u'), U.VOL_UNITS, 'mL');
    fillSelect($('#set-defvolu'), U.VOL_UNITS, 'mL');
    fillSelect($('#set-defconcu'), U.MOLAR_UNITS, 'M');

    // 默认值
    $('#q-conc').value = settings.defConc;
    $('#q-conc').selectedIndex = 0;
    $('#q-vol').value = settings.defVol;

    // 体系下拉
    const bufSel = $('#t-buf');
    bufSel.innerHTML = Buffers.BUFFERS.map(b =>
      '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('');
    const polySel = $('#p-sys');
    polySel.innerHTML = Buffers.POLY_SYSTEMS.map(s =>
      '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');

    const syncRangeHint = () => {
      const b = Buffers.bufferById(bufSel.value);
      if (b) $('#t-range').textContent = 'pKa₂₅ ' + b.pKa25
        + '，温度系数 ' + b.dpKa + '/°C，有效范围 '
        + b.range[0].toFixed(1) + '–' + b.range[1].toFixed(1);
    };
    bufSel.addEventListener('change', syncRangeHint);
    syncRangeHint();

    polySel.addEventListener('change', syncPolyForms);
    syncPolyForms();

    // 事件绑定
    $('#q-calc').addEventListener('click', () => runQuick(true));
    $('#q-name').addEventListener('keydown', e => { if (e.key === 'Enter') runQuick(true); });
    $('#t-calc').addEventListener('click', runTemp);
    $('#p-calc').addEventListener('click', runPoly);
    $('#s-calc').addEventListener('click', runSystem);
    $('#d-calc').addEventListener('click', runDilution);

    $$('#view-ph .tab').forEach(t =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));

    $$('.modcard').forEach(c =>
      c.addEventListener('click', () => go(c.dataset.go)));

    $$('.tabbtn').forEach(b =>
      b.addEventListener('click', () => go(b.dataset.view)));

    $('#btnBack').addEventListener('click', () => go('home'));

    $('#s-add').addEventListener('click', () => {
      comps.push(newComp());
      renderComps();
    });

    bindCompEvents();
    renderComps();
    renderQuickAdd();
    bindHistoryEvents();
    bindTagBar('quick');
    bindTagBar('system');
    bindTagDismiss();
    bindSettings();

    // 批量模式：切换开关 + 清单里的事件（挂在静态容器上，里面重建多少次都不影响）
    segSelect('q-mode', 'single', setQuickMode);
    segSelect('d-mode', 'single', setDilutionMode);
    bindBatch('quick');
    bindBatch('dilution');
    bindTagBar('quickBatch');
    bindTagBar('dilutionBatch');

    // 浏览器返回键 / 手势
    if (global.addEventListener) {
      global.addEventListener('popstate', e => {
        const v = (e.state && e.state.view) || 'home';
        go(v, false);
      });
    }

    const initial = (location.hash || '').replace('#', '');
    const validKeys = ['home'].concat(SUBS).concat(['history', 'settings']);
    go(validKeys.indexOf(initial) >= 0 ? initial : 'home');

    $('#set-build').textContent = '内置试剂 '
      + Reagents.REAGENTS.length + ' 条 · 缓冲体系 '
      + (Buffers.BUFFERS.length + Buffers.POLY_SYSTEMS.length) + ' 个';

    // Service Worker 只在 http(s) 下可用，file:// 打开时会静默跳过
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 失败不影响使用 */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于人工在控制台里核对
  global.App = { go, runQuick, runTemp, runPoly, runSystem, runDilution };

})(typeof globalThis !== 'undefined' ? globalThis : this);
