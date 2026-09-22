/* 分子量查询 —— 降级链：内置库 → 本地缓存 → NCI Cactus → PubChem → 手动输入
 *
 * 实测结论（2026-09）：
 *  · NCI Cactus 可达且返回 Access-Control-Allow-Origin: *，浏览器可直连，定为主数据源。
 *  · PubChem 在本机网络被阻断（TCP 连上后立即 RST），保留代码路径但排在末位。
 *  · Cactus 是精确匹配不是模糊搜索（EDTA / sodium chloride 直接查不到），
 *    且查不到时返回 HTTP 500 而非 404 —— 两者都按"查不到"处理。
 *  · Cactus 的 /cas 端点返回一堆相关物质的 CAS（含衍生物、同位素标记物），
 *    第一个并不是主 CAS，不可信。因此联网结果不提供 CAS，除非用户输入的就是 CAS。
 */
(function (global) {
  'use strict';

  const Reagents  = global.Reagents;
  const ZhData    = global.ZhData;
  const Store     = global.Store;
  const Inventory = global.Inventory;

  const CACTUS_BASE  = 'https://cactus.nci.nih.gov/chemical/structure/';
  const PUBCHEM_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/';
  const TIMEOUT_MS   = 5000;   // PubChem 不通时不能卡住界面

  /* 实测（2026-09-21）：这条网络对 Cactus / PubChem 会随机重置连接，
     同一个请求连打 5 次只有 1~3 次通。只试一次等于一半以上概率白白失败，
     用户看到的是"查不到"，其实服务是好的。所以必须重试。 */
  const RETRY = 3;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** 带超时与重试的文本请求；非 2xx（含 Cactus 的 500）一律返回 null */
  async function fetchText(url, ms, tries) {
    if (typeof fetch !== 'function') return null;
    const n = tries || RETRY;
    for (let i = 0; i < n; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctl.signal, mode: 'cors' });
        if (res.ok) {
          const t = (await res.text()).trim();
          if (t) return t;
        }
        // 4xx/5xx 是服务端明确回答"没有"，重试也一样，直接放弃
        if (res.status >= 400 && res.status < 500) return null;
      } catch (e) {
        /* 连接被重置 / 超时：退避后重试 */
      } finally {
        clearTimeout(timer);
      }
      if (i < n - 1) await sleep(180 * (i + 1));
    }
    return null;
  }

  /** Cactus：mw 与 formula 两个端点并行取 */
  async function queryCactus(q, ms) {
    const id = encodeURIComponent(q);
    const [mwTxt, formulaTxt] = await Promise.all([
      fetchText(CACTUS_BASE + id + '/mw', ms),
      fetchText(CACTUS_BASE + id + '/formula', ms)
    ]);
    if (!mwTxt) return null;
    const mw = parseFloat(String(mwTxt).split('\n')[0]);
    if (!isFinite(mw) || mw <= 0) return null;
    return {
      source: 'cactus',
      mw,
      formula: formulaTxt ? String(formulaTxt).split('\n')[0].trim() : '',
      // Cactus 不给名字。它的 /names 端点倒是有，但返回的是
      // 「6-(hydroxymethyl)oxane-2,3,4,5-tetrol」这种 IUPAC 名 —— 比 CAS 号还难认，
      // 对用户毫无帮助，所以宁可不取。名字一律走 PubChem 的 Title
      title: '',
      cas: ''
    };
  }

  /** PubChem：与 Cactus 并行发起；也是「化合物常用名」的唯一来源 */
  async function queryPubChem(q, ms) {
    const url = PUBCHEM_BASE + encodeURIComponent(q)
      + '/property/Title,MolecularFormula,MolecularWeight/JSON';
    const txt = await fetchText(url, ms);
    if (!txt) return null;
    try {
      const j = JSON.parse(txt);
      const p = j && j.PropertyTable && j.PropertyTable.Properties
        && j.PropertyTable.Properties[0];
      /* PubChem 的 MolecularWeight 在 JSON 里是**字符串**（"180.16"，不是数字）。
         原样往下传，结果卡里的 r.mw.toFixed(2) 会抛 TypeError —— 整个结果区白屏。
         isFinite("180.16") 是 true，所以这个坑以前光靠校验拦不住，
         必须在这里就转成数字。 */
      const mw = Number(p && p.MolecularWeight);
      if (!p || !isFinite(mw) || mw <= 0) return null;
      return {
        source: 'pubchem',
        mw: mw,
        formula: p.MolecularFormula || '',
        // 常用名（50-99-7 → "D-Glucose"）。按 CAS 查时名字全靠这一项 ——
        // 没有它，结果卡上「化合物」和「CAS 号」两行会显示成一模一样的数字
        title: p.Title || '',
        cas: ''
      };
    } catch (e) { return null; }
  }

  /* ── 中文名识别（可选，用户自己配 key）────────────────────
   *
   * 存在的理由：PubChem 不认中文（「氯化钠」直接 404），Cactus 也不认，
   * 国内化工站（化源网 / ChemicalBook 等）既没有公开 API、也不返回 CORS 头，
   * 纯静态页面根本连不上。所以中文名只能靠本地对照表 —— 表外就是死路。
   *
   * 安全边界（这是整个设计唯一能成立的理由）：
   * AI **只回答一个问题**：「这个名字英文叫什么」。
   * 它给的名字/CAS 会被当成「用户输入的一个名字」重新走一遍完整降级链，
   * 分子量数字最终只来自 PubChem / Cactus。
   * 模型认错了 → 那个名字在数据库里查不到 → 报「查不到」。
   * 它**没有机会**输出一个能被当成分子量用的数字。 */

  const LLM = {
    siliconflow: { name: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions',
                   model: 'Qwen/Qwen2.5-7B-Instruct' },
    zhipu:       { name: '智谱',     url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                   model: 'glm-4-flash' },
    deepseek:    { name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions',
                   model: 'deepseek-chat' },
    dashscope:   { name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                   model: 'qwen-turbo' },
    moonshot:    { name: 'Kimi',     url: 'https://api.moonshot.cn/v1/chat/completions',
                   model: 'moonshot-v1-8k' },
    custom:      { name: '自定义（OpenAI 兼容）', url: '', model: '' }
  };

  const AI_TIMEOUT_MS = 12000;   // 模型比数据库慢得多，给足；但不能卡死界面

  const AI_PROMPT = [
    '你是化学试剂名称查询助手。用户给你一个中文化学品名（可能是俗名、商品名、',
    '或者带水合物的写法，例如「十二水合磷酸氢二钠」「冰醋酸」「吐温20」）。',
    '请给出它对应的规范英文名和 CAS 号。',
    '',
    '规则：',
    '1. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。',
    '2. 不确定的字段填 null，绝对不要猜。猜错比说不知道的后果严重得多。',
    '3. 不要输出分子量、分子式或任何数字。',
    '4. 英文名用最常见的通用名或 IUPAC 名。',
    '5. 如果不是化学试剂，两个字段都填 null。',
    '',
    '输出格式：{"name": "英文名或 null", "cas": "CAS号或 null"}'
  ].join('\n');

  /**
   * 解析模型的回答。纯函数，专门抽出来是为了能喂各种坏响应单测。
   * 只要拿不到一个能用的名字或 CAS，就一律返回 null —— 宁可报「查不到」，
   * 也不能把一个半成品往下传。
   */
  function parseAiReply(text) {
    const s = String(text == null ? '' : text);
    // 模型爱把 JSON 包在 ```json 里，或者在前后补一句解释 —— 抠出第一个 {…}
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j;
    try { j = JSON.parse(m[0]); } catch (e) { return null; }

    const out = { name: '', cas: '' };
    if (typeof j.name === 'string') {
      const n = j.name.trim();
      // 中文名对 PubChem 没用（它不认中文），所以「英文名」里带汉字等于没给
      if (n && !/[一-龥]/.test(n) && n.toLowerCase() !== 'null') out.name = n;
    }
    if (typeof j.cas === 'string') {
      const c = j.cas.trim();
      if (/^\d{2,7}-\d{2}-\d$/.test(c)) out.cas = c;   // 格式不对就当它没给
    }
    return (out.name || out.cas) ? out : null;
  }

  /** 问一次模型。任何失败都返回 null，绝不抛 */
  async function aiTranslate(zhName, settings) {
    if (typeof fetch !== 'function') return null;
    const key = String(settings.llmKey || '').trim();
    const cfg = LLM[settings.llmProvider] || LLM.custom;
    const url = String(settings.llmUrl || cfg.url || '').trim();
    const model = String(settings.llmModel || cfg.model || '').trim();
    if (!key || !url || !model) return null;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
    let txt = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: model,
          temperature: 0,                 // 要的是查得到的名字，不要发挥
          messages: [{ role: 'system', content: AI_PROMPT },
                     { role: 'user', content: zhName }]
        })
      });
      if (res.ok) {
        const j = await res.json();
        const ch = j && j.choices && j.choices[0];
        txt = ch && ch.message && ch.message.content;
      }
    } catch (e) {
      return null;                        // 超时 / 断网 / CORS，都当没问
    } finally {
      clearTimeout(timer);
    }
    return parseAiReply(txt);
  }

  /** 查这个名字在实验室货架上的位置（可能多条：同一化合物有两瓶/两个货位） */
  function locate() {
    if (!Inventory) return [];
    for (let i = 0; i < arguments.length; i++) {
      const hits = Inventory.findByName(arguments[i]);
      if (hits.length) return hits;
    }
    return [];
  }

  /**
   * 主查询入口。
   * @param {string} query 用户输入（名称 / 中文名 / CAS 号）
   * @param {object} opts  { formLabel, settings }
   * @returns {Promise<object>} 见文件末尾返回结构说明
   */
  async function lookup(query, opts) {
    const o = opts || {};
    const settings = o.settings || (Store ? Store.settingsGet() : {});
    const raw = String(query || '').trim();
    if (!raw) return { ok: false, reason: 'empty' };

    const isCas = Reagents.isCas(raw);

    const isZh = /[一-龥]/.test(raw);

    /* 1. 内置库（含中文名与别名） */
    let hit = Reagents.find(raw);
    let viaEnglish = '';

    /* 2. 内置库未命中又是中文 → 转成英文再试一次内置库。
       两个翻译来源，库存优先：那是用户自己货架上的 172 条，
       比通用对照表更准（「无水乙酸钠」这种写法只有库存里有）。 */
    if (!hit && isZh) {
      const fromInv = Inventory ? Inventory.toEnglish(raw) : '';
      const fromZh  = ZhData ? ZhData.toEnglishQuery(raw) : '';
      viaEnglish = fromInv || (fromZh !== raw ? fromZh : '');
      if (viaEnglish) hit = Reagents.find(viaEnglish);
    }

    const onlineOn = settings.onlineQuery !== false;

    /* 2.5 中文名本地两个来源都不认识 —— 如果用户配了 AI，让它只回答一个问题：
       「这个名字英文叫什么」。拿回来的名字/CAS 会被当成「用户输入的一个名字」
       重新走一遍下面的整条链（内置库 → 位置表 → 联网）。
       所以最终的数字仍然来自数据库；模型认错了 → 那个名字查不到 → 报「查不到」，
       绝无可能算出错误的分子量。这是这一步唯一能成立的理由。

       位置表那一步（step 2）已经查过中文原名了，所以能走到这里说明用户的表里
       也没有这个名字 —— 不会白花一次 AI 调用。 */
    let viaAi = '', aiCas = '';
    if (!hit && isZh && !viaEnglish && onlineOn
        && settings.llmOn && settings.llmKey && settings.llmProvider) {
      const ai = await aiTranslate(raw, settings);
      if (ai) {
        viaAi = ai.name || ai.cas;
        aiCas = ai.cas;
        // 优先用 CAS 去试内置库：它比名字精确，不会有同名歧义
        hit = Reagents.find(ai.cas) || Reagents.find(ai.name) || null;
        viaEnglish = ai.name || ai.cas;
      }
    }

    /* 送去联网查询的英文名。中文且没转出英文时留空 —— 那些服务只认英文，
       发中文过去是一次必然失败的请求，白让用户等几秒。 */
    const english = isZh ? viaEnglish : raw;

    if (hit) {
      /* 形式优先级：界面明确选的 > 输入里已经点明的（输入 Tris-HCl 就是盐酸盐）> forms[0]。
         漏掉中间那层会让「Tris-HCl」拿到游离碱的分子量 —— 121.14 而不是 157.60，
         差 36 g/mol，是会称错药的。 */
      const form = Reagents.formOf(hit.reagent,
        o.formLabel || (hit.form ? hit.form.label : null));
      return {
        ok: true, source: 'builtin',
        name: hit.reagent.name,
        zh: hit.reagent.zh,
        formula: form.formula,
        cas: form.cas,
        mw: form.mw,
        reagentId: hit.reagent.id,
        formLabel: hit.reagent.forms ? form.label : null,
        /* 同一试剂有多种形式（游离酸/碱、盐、水合物）时把候选交回界面，
           让用户自己拍板 —— 分子量差一个水就是 18 g/mol，猜不得 */
        forms: Reagents.hasChoice(hit.reagent) ? hit.reagent.forms : null,
        formPicked: !Reagents.hasChoice(hit.reagent)
          || !!o.formLabel || !!hit.form,
        /* 形式名优先：搜「Tris-HCl」要给盐酸盐那瓶的位置，不是游离碱那瓶。
           注意别传 form.label —— 它的值是「无水」「游离酸」这种形式类别，
           拿去做名称匹配会命中一堆无关条目（「氯化锂(无水)」也有「无水」）。 */
        locations: locate(form.name, raw, hit.reagent.name, hit.reagent.zh),
        note: hit.reagent.note || '',
        mwAvg: !!hit.reagent.mwAvg,
        // 非空表示这个化合物是 AI 把中文名认出来的 —— 界面要显示出来让用户核对
        viaAi: viaAi
      };
    }

    /* 3. 本地缓存（按原串和转写后的英文名各查一次） */
    const cached = (Store && (Store.cacheGet(raw)
      || (viaEnglish && Store.cacheGet(viaEnglish)))) || null;
    if (cached && cached.mw) {
      return {
        // 手填的分子量要一路标出来 —— 它是全流程里唯一没人核对过的数。
        // 缓存里本来就存了 source（store.js 的 cachePut），这里丢掉的话
        // 同一个化合物第二次查就变成"cache"，界面上那个「手填 MW」标记会凭空消失
        ok: true, source: cached.source === 'manual' ? 'manual' : 'cache',
        // 缓存里没名字时别拿原始查询串顶上 —— 按 CAS 查的话那就是一串数字，
        // 「化合物」和「CAS 号」两行会显示成同一个东西。名不名留空，界面自会处理
        name: cached.name || (isCas ? '' : raw),
        formula: cached.formula, cas: cached.cas, mw: cached.mw,
        locations: locate(cached.name, raw)
      };
    }

    /* 用户原话优先于英文名：他说「无水乙酸钠」就该只给无水那瓶，
       不该因为两条记录的英文规范名都叫 Sodium acetate 就把三水合物也端出来。 */
    let shelf = locate(raw, english);
    // 用户已经点明了是哪一瓶（界面上的选择），就只认那一瓶
    if (o.shelfTag && o.shelfCode) {
      const only = shelf.filter(p => p.tag === o.shelfTag && p.code === o.shelfCode);
      if (only.length) shelf = only;
    }
    const shelfMw = shelf.filter(p => p.mw);

    /* 按 CAS 查时，只有记录自己就带这个 CAS 才认货架。
       索引里 cas 也是键，所以理论上命中即相符；这里再确认一次是为了兜住
       「名字碰巧等于一串 CAS」这种假命中 —— 那会拿错化合物直接算。
       内置表没有 cas 字段，所以这条对既有数据是零影响（行为完全不变）。 */
    const casHit = !isCas || shelf.some(p => String(p.cas || '').trim() === raw);

    /* 3.5 货架上确实有这瓶，但它本来就没有单一分子量（PEG 类聚合物、现成溶液、
       专有配方）—— 不用联网了，而且必须说清楚"为什么算不了"。
       这里不是"查不到"，含糊过去会让用户以为是自己输错了名字。 */
    const noMwHit = shelf.filter(p => p.noMw)[0];
    if (noMwHit && !shelfMw.length && casHit) {
      return { ok: false, reason: 'no-mw', query: raw,
               place: noMwHit, locations: shelf };
    }

    /* 3.6 货架上就有这瓶，分子量是核验过的 —— 直接用，不必联网。
       但同一个名字可能对应不同水合物（无水乙酸钠 82.03 / 三水 136.08），
       分子量对不上时绝不能替用户挑，要把选择交给他。 */
    if (shelfMw.length && casHit) {
      const first = shelfMw[0].mw;
      if (shelfMw.every(p => Math.abs(p.mw - first) < 0.01)) {
        return {
          ok: true, source: 'shelf',
          // 名字依次回落：规范英文名 → 英文名 → 中文名。
          // 用户导入的表可能只写了中文名，那时候 zh 就是唯一能显示的东西
          name: shelfMw[0].clean || shelfMw[0].en || shelfMw[0].zh || '',
          zh: shelfMw[0].zh,
          formula: shelfMw[0].formula || '',
          cas: shelfMw[0].cas || '',
          mw: first,
          locations: shelfMw,
          note: shelfMw[0].note || ''
        };
      }
      return { ok: false, reason: 'shelf-choice', query: raw,
               locations: shelfMw };   // 界面列出来让用户点
    }

    /* 4. 联网查询 —— 两家并行发起，不是「Cactus 挂了才轮到 PubChem」。
       串行最坏要 31 秒（每家 3 次重试 × 5s 超时），并行之后最坏约 16 秒；
       更要紧的是按 CAS 查时只有并行才能顺带拿到 PubChem 的 Title ——
       Cactus 只给分子量，光靠它查 CAS 只能得到「化合物 50-99-7」这种东西。 */
    let failedNet = false;

    if (onlineOn && english) {
      const [cac, pub] = await Promise.all([
        queryCactus(english),
        queryPubChem(english)
      ]);
      // 数值以 Cactus 优先（它的 formula 更规范），它没有才用 PubChem 的；
      // 名字反过来 —— PubChem 的 Title 才是常用名，跟数值来自哪家无关
      const r = (cac && cac.mw > 0) ? cac : ((pub && pub.mw > 0) ? pub : null);
      if (!r) failedNet = true;
      if (r) {
        // 用户输入的就是 CAS 时，回填这个可靠的 CAS；否则留空
        if (isCas) r.cas = raw;
        const title = (pub && pub.title) || '';
        const out = {
          ok: true, source: r.source,
          /* 名字怎么定：
             · 用户输的是 CAS → 用 PubChem 给的常用名；拿不到就留空，
               绝不把 CAS 串回填（那会让「化合物」和「CAS 号」两行显示成一模一样的数字）
             · 中文名经 AI 转写 → 优先 PubChem 的规范名，它比模型给的可靠
             · 其余（用户输的就是个英文名）→ 原样回显，别替换成别的叫法 */
          name: isCas ? title : (viaAi ? (title || english) : english),
          formula: r.formula,
          // AI 给了 CAS 就带着它 —— 它是模型给的精确句柄，比名字有用
          cas: isCas ? raw : (r.cas || aiCas),
          mw: r.mw,
          queriedAs: english,
          viaAi: viaAi,
          locations: locate(english, raw, viaEnglish)
        };
        if (Store) Store.cachePut({ name: out.name, cas: out.cas, mw: out.mw, formula: out.formula, source: out.source, query: raw });
        return out;
      }
    }

    /* 5. 失败：给引导，不放死路。三种原因要分清楚，不然用户不知道该干什么 */
    const zhUnknown = isZh && !english;
    return {
      ok: false,
      reason: isCas ? 'notfound-cas'
            : zhUnknown ? 'unknown-zh'
            : failedNet ? 'network'
            : 'notfound-name',
      query: raw,
      suggestions: Reagents.suggest(raw, 5),
      triedEnglish: english || null,
      locations: shelf,
      onlineOn,
      // 中文查不到时，界面按这个决定提示怎么写：
      //   aiOn=true  → 已经开了，让用户检查一下 Key 或换个说法
      //   aiOn=false → 告诉他去设置里能开
      aiOn: !!settings.llmOn,
      aiReady: !!(settings.llmOn && settings.llmKey && settings.llmProvider)
    };
  }

  /** 手动输入兜底 */
  function manual(name, mw, formula, cas) {
    const m = Number(mw);
    if (!isFinite(m) || m <= 0) return { ok: false, reason: 'bad-mw' };
    const entry = {
      ok: true, source: 'manual',
      name: name || '手动输入',
      formula: formula || '', cas: cas || '', mw: m
    };
    if (Store) Store.cachePut({ name: entry.name, cas: entry.cas, mw: m, formula: entry.formula, source: 'manual' });
    return entry;
  }

  const api = { lookup, manual, queryCactus, queryPubChem, fetchText, CACTUS_BASE, PUBCHEM_BASE,
                aiTranslate, parseAiReply, LLM };
  global.Lookup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
