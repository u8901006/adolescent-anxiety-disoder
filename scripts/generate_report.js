import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';

const API_BASE = process.env.ZHIPU_API_BASE ?? 'https://open.bigmodel.cn/api/coding/paas/v4';

const MODEL_FALLBACK_CHAIN = [
  'glm-5-turbo',
  'GLM-5-Turbo',
  'glm-4.7',
  'GLM-4.7',
  'glm-4.7-flash',
  'GLM-4.7-Flash',
];

const SYSTEM_PROMPT = `你是青少年焦慮症研究領域的專業文獻分析師。你的任務是：
1. 從提供的論文資料中，提取出最具臨床意義與創新價值的重點摘要
2. 每篇摘要需以繁體中文精簡呈現核心發現
3. 評估臨床實用性（高/中/低）
4. 生成適合專業人士閱讀的每日文獻速報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易讀
- 每篇論文須包含：中文標題、一句話摘要、PICO分析、臨床實用性、原文連結
- 最後提供今日 TOP 3（最重要/最具影響力的論文）
回傳格式必須是 JSON，不要用 markdown code block 包裹。`;

function loadPapers(inputPath) {
  const raw = inputPath === '-'
    ? readFileSync(0, 'utf-8')
    : readFileSync(inputPath, 'utf-8');
  return JSON.parse(raw);
}

function robustJSONParse(text) {
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/g, '');

  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(cleaned.substring(jsonStart, jsonEnd + 1));
    } catch {}
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
    } catch {}
  }

  try {
    cleaned = cleaned
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/\t/g, '\\t');
    return JSON.parse(cleaned);
  } catch {}

  throw new Error('Failed to parse JSON from AI response');
}

async function callZhipuAPI(apiKey, model, papersData) {
  const dateStr = papersData.date;
  const paperCount = papersData.count;
  const papersText = JSON.stringify(papersData.papers, null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新青少年焦慮症相關文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block 包裹）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今日青少年焦慮症研究的亮點與趨勢",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話核心摘要（繁體中文，突出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "簡述臨床實用性的原因",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話摘要",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵詞1", "關鍵詞2"],
  "topic_distribution": {
    "社會焦慮": 3,
    "廣泛性焦慮": 2
  }
}

原始文獻資料：
${papersText}

請挑選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：社會焦慮、廣泛性焦慮、恐慌症、分離焦慮、特定畏懼症、選擇性緘默症、學校拒絕、CBT、暴露治療、藥物治療、SSRI、親職介入、學校介入、數位介入、神經影像、生理指標、長期追蹤、流行病學、篩檢工具、同儕關係、霸凌、社交媒體、睡眠、家庭因素、創傷、健康不平等、實施科學、正念、接納承諾療法、測量工具。
注意：直接回傳 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 50000,
  };

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(480000),
  });

  if (resp.status === 429) {
    throw Object.assign(new Error('Rate limited'), { status: 429 });
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw Object.assign(new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`), { status: resp.status });
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('Empty response from API');

  return robustJSONParse(text);
}

async function analyzePapers(apiKey, papersData) {
  for (const model of MODEL_FALLBACK_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const result = await callZhipuAPI(apiKey, model, papersData);
        console.error(`[INFO] Analysis complete: ${(result.top_picks ?? []).length} top picks, ${(result.all_papers ?? []).length} total`);
        return { result, model };
      } catch (e) {
        if (e.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (e.message.includes('Failed to parse JSON') && attempt < 2) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error(`[ERROR] ${model} failed: ${e.message}`);
        break;
      }
    }
  }

  return null;
}

function generateHTML(analysis, modelUsed) {
  const dateStr = analysis.date ?? getTaipeiDate();
  const dateParts = dateStr.split('-');
  const dateDisplay = dateParts.length === 3
    ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
    : dateStr;

  const summary = analysis.market_summary ?? '';
  const topPicks = analysis.top_picks ?? [];
  const allPapers = analysis.all_papers ?? [];
  const keywords = analysis.keywords ?? [];
  const topicDist = analysis.topic_distribution ?? {};

  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  let weekday = '';
  try {
    weekday = weekdayNames[new Date(dateStr).getDay()];
  } catch {}

  let topPicksHTML = '';
  for (const pick of topPicks) {
    const tagsHTML = (pick.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const util = pick.clinical_utility ?? '中';
    const utilityClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    const pico = pick.pico ?? {};
    const picoHTML = Object.keys(pico).length > 0 ? `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${esc(pico.population ?? '-')}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${esc(pico.intervention ?? '-')}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${esc(pico.comparison ?? '-')}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${esc(pico.outcome ?? '-')}</span></div>
            </div>` : '';

    topPicksHTML += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank ?? ''}</span>
            <span class="emoji-icon">${pick.emoji ?? '📄'}</span>
            <span class="${utilityClass}">${esc(util)}實用性</span>
          </div>
          <h3>${esc(pick.title_zh ?? pick.title_en ?? '')}</h3>
          <p class="journal-source">${esc(pick.journal ?? '')} &middot; ${esc(pick.title_en ?? '')}</p>
          <p>${esc(pick.summary ?? '')}</p>
          ${picoHTML}
          ${pick.utility_reason ? `<p class="utility-reason">💡 ${esc(pick.utility_reason)}</p>` : ''}
          <div class="card-footer">
            ${tagsHTML}
            <a href="${esc(pick.url ?? '#')}" target="_blank" rel="noopener">閱讀原文 →</a>
          </div>
        </div>`;
  }

  let allPapersHTML = '';
  for (const paper of allPapers) {
    const tagsHTML = (paper.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const util = paper.clinical_utility ?? '中';
    const utilityClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    allPapersHTML += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji ?? '📄'}</span>
            <span class="${utilityClass} utility-sm">${esc(util)}</span>
          </div>
          <h3>${esc(paper.title_zh ?? paper.title_en ?? '')}</h3>
          <p class="journal-source">${esc(paper.journal ?? '')}</p>
          <p>${esc(paper.summary ?? '')}</p>
          <div class="card-footer">
            ${tagsHTML}
            <a href="${esc(paper.url ?? '#')}" target="_blank" rel="noopener">PubMed →</a>
          </div>
        </div>`;
  }

  const keywordsHTML = keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join('');
  let topicBarsHTML = '';
  if (Object.keys(topicDist).length > 0) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHTML += `
            <div class="topic-row">
              <span class="topic-name">${esc(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }
  }

  const totalCount = topPicks.length + allPapers.length;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>青少年焦慮症文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 青少年焦慮症文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .utility-reason { font-size: 12px !important; margin-top: 8px; }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.3s both; }
  .clinic-links { display: flex; flex-direction: column; gap: 12px; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } .clinic-links { gap: 8px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🧒</div>
    <div class="header-text">
      <h1>青少年焦慮症文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}（週${weekday}）</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${esc(summary)}</p>
  </div>

  ${topPicksHTML ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHTML}</div>` : ''}

  ${allPapersHTML ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHTML}</div>` : ''}

  ${topicBarsHTML ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHTML}</div>` : ''}

  ${keywordsHTML ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHTML}</div></div>` : ''}

  <div class="clinic-banner">
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">🏥</span>
        <div>
          <div class="clinic-name">李政洋身心診所首頁</div>
          <div class="clinic-desc">專業身心科門診服務</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">📬</span>
        <div>
          <div class="clinic-name">訂閱電子報</div>
          <div class="clinic-desc">定期收到最新心理健康資訊</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
      <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
        <span class="clinic-icon">☕</span>
        <div>
          <div class="clinic-name">Buy Me a Coffee</div>
          <div class="clinic-desc">支持我們持續提供優質內容</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
    </div>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${esc(modelUsed ?? 'GLM-5-Turbo')}</span>
    <span><a href="https://github.com/u8901006/adolescent-anxiety-disoder">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function esc(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTaipeiDate() {
  const now = new Date();
  const taipeiOffset = 8 * 60;
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const taipei = new Date(utc + taipeiOffset * 60000);
  return `${taipei.getFullYear()}-${String(taipei.getMonth() + 1).padStart(2, '0')}-${String(taipei.getDate()).padStart(2, '0')}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: 'papers.json' },
      output: { type: 'string', required: true },
      'api-key': { type: 'string', default: process.env.ZHIPU_API_KEY ?? '' },
    },
  });

  const apiKey = values['api-key'];
  if (!apiKey) {
    console.error('[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key');
    process.exit(1);
  }

  const papersData = loadPapers(values.input);

  let analysis;
  let modelUsed = 'GLM-5-Turbo';

  if (!papersData?.papers?.length) {
    console.error('[WARN] No papers found, generating empty report');
    analysis = {
      date: getTaipeiDate(),
      market_summary: '今日 PubMed 暫無新的青少年焦慮症相關文獻更新。請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    const result = await analyzePapers(apiKey, papersData);
    if (!result) {
      console.error('[ERROR] Analysis failed');
      process.exit(1);
    }
    analysis = result.result;
    modelUsed = result.model;
  }

  const html = generateHTML(analysis, modelUsed);
  mkdirSync(dirname(values.output) || '.', { recursive: true });
  writeFileSync(values.output, html, 'utf-8');
  console.error(`[INFO] Report saved to ${values.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
