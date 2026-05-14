import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const JOURNALS = [
  'Journal of the American Academy of Child & Adolescent Psychiatry',
  'JAACAP Open',
  'European Child & Adolescent Psychiatry',
  'Child and Adolescent Psychiatry and Mental Health',
  'Child Psychiatry & Human Development',
  'Journal of Child Psychology and Psychiatry',
  'Research on Child and Adolescent Psychopathology',
  'Development and Psychopathology',
  'Child and Adolescent Mental Health',
  'JAMA Psychiatry',
  'American Journal of Psychiatry',
  'The Lancet Psychiatry',
  'World Psychiatry',
  'Molecular Psychiatry',
  'Translational Psychiatry',
  'Psychological Medicine',
  'British Journal of Psychiatry',
  'Acta Psychiatrica Scandinavica',
  'Journal of Affective Disorders',
  'Depression and Anxiety',
  'Journal of Anxiety Disorders',
  'Anxiety Stress & Coping',
  'Pediatrics',
  'JAMA Pediatrics',
  'The Lancet Child & Adolescent Health',
  'Journal of Adolescent Health',
  'Academic Pediatrics',
  'Journal of Pediatrics',
  'Behaviour Research and Therapy',
  'Behavior Therapy',
  'Cognitive Therapy and Research',
  'Clinical Psychology Review',
  'Journal of Consulting and Clinical Psychology',
  'Journal of Clinical Child & Adolescent Psychology',
  'Internet Interventions',
  'Mindfulness',
  'Biological Psychiatry',
  'Biological Psychiatry Cognitive Neuroscience and Neuroimaging',
  'Neuropsychopharmacology',
  'Developmental Cognitive Neuroscience',
  'Social Cognitive and Affective Neuroscience',
  'Psychoneuroendocrinology',
  'Psychophysiology',
  'Neuroscience & Biobehavioral Reviews',
  'Journal of Child and Adolescent Psychopharmacology',
  'BMC Public Health',
  'Preventive Medicine',
  'Prevention Science',
  'Implementation Science',
  'Social Science & Medicine',
  'Journal of Youth and Adolescence',
  'Journal of Adolescence',
  'School Mental Health',
  'Journal of School Psychology',
  'Cyberpsychology Behavior and Social Networking',
  'Journal of Medical Internet Research',
  'JMIR Mental Health',
  'Computers in Human Behavior',
  'Journal of Family Psychology',
  'Family Process',
  'Developmental Psychology',
  'Child Development',
  'Psychological Assessment',
  'Assessment',
];

const TOPICS = [
  '"anxiety disorder*"',
  '"generalized anxiety disorder"',
  '"generalised anxiety disorder"',
  '"social anxiety"',
  '"social phobia"',
  '"separation anxiety"',
  '"panic disorder"',
  '"school refusal"',
  '"school avoidance"',
  'GAD',
  'agoraphobia',
  '"selective mutism"',
  'internalizing',
  'internalising',
];

const AGE_TERMS = [
  'adolescent*',
  'adolescence',
  'teen*',
  'teenager*',
  'youth*',
  '"young people"',
  '"high school student*"',
  '"secondary school student*"',
];

function buildQuery(days) {
  const lookback = new Date(Date.now() - days * 86400000);
  const lookbackStr = `${lookback.getUTCFullYear()}/${String(lookback.getUTCMonth() + 1).padStart(2, '0')}/${String(lookback.getUTCDate()).padStart(2, '0')}`;

  const journalPart = JOURNALS.slice(0, 15)
    .map((j) => `"${j}"[Journal]`)
    .join(' OR ');

  const topicPart = TOPICS.map((t) => `${t}[tiab]`).join(' OR ');
  const agePart = AGE_TERMS.map((t) => `${t}[tiab]`).join(' OR ');

  const datePart = `"${lookbackStr}"[Date - Publication] : "3000"[Date - Publication]`;

  return `(${journalPart}) AND (${topicPart}) AND (${agePart}) AND ${datePart}`;
}

function buildBroadQuery(days) {
  const lookback = new Date(Date.now() - days * 86400000);
  const lookbackStr = `${lookback.getUTCFullYear()}/${String(lookback.getUTCMonth() + 1).padStart(2, '0')}/${String(lookback.getUTCDate()).padStart(2, '0')}`;
  const datePart = `"${lookbackStr}"[Date - Publication] : "3000"[Date - Publication]`;

  const conditionBlock = '("Anxiety Disorders"[Mesh] OR "Anxiety"[Mesh] OR anxiety[tiab] OR anxious[tiab] OR "anxiety disorder*"[tiab] OR "social anxiety"[tiab] OR "generalized anxiety disorder"[tiab] OR "social phobia"[tiab] OR "separation anxiety"[tiab] OR "panic disorder"[tiab] OR "specific phobia"[tiab] OR "selective mutism"[tiab] OR "school refusal"[tiab] OR "school avoidance"[tiab] OR internalizing[tiab] OR internalising[tiab])';
  const ageBlock = '("Adolescent"[Mesh] OR adolescent*[tiab] OR adolescence[tiab] OR teen*[tiab] OR youth*[tiab] OR "young people"[tiab] OR "high school student*"[tiab])';

  return `${conditionBlock} AND ${ageBlock} AND ${datePart}`;
}

async function fetchJSON(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AdolescentAnxietyBot/1.0 (research aggregator)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AdolescentAnxietyBot/1.0 (research aggregator)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.text();
}

async function searchPapers(query, retmax = 50) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(retmax),
    sort: 'date',
    retmode: 'json',
  });
  const url = `${PUBMED_SEARCH}?${params}`;
  try {
    const data = await fetchJSON(url);
    return data?.esearchresult?.idlist ?? [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

function extractBetween(xml, startTag, endTag) {
  const startIdx = xml.indexOf(startTag);
  if (startIdx === -1) return '';
  const contentStart = startIdx + startTag.length;
  const endIdx = xml.indexOf(endTag, contentStart);
  if (endIdx === -1) return '';
  return xml.substring(contentStart, endIdx);
}

function extractAllBetween(xml, startTag, endTag) {
  const results = [];
  let searchFrom = 0;
  while (true) {
    const startIdx = xml.indexOf(startTag, searchFrom);
    if (startIdx === -1) break;
    const contentStart = startIdx + startTag.length;
    const endIdx = xml.indexOf(endTag, contentStart);
    if (endIdx === -1) break;
    results.push(xml.substring(contentStart, endIdx));
    searchFrom = endIdx + endTag.length;
  }
  return results;
}

function stripTags(xml) {
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPapers(xml) {
  const articleChunks = extractAllBetween(xml, '<PubmedArticle>', '</PubmedArticle>');
  const papers = [];

  for (const chunk of articleChunks) {
    try {
      const pmidRaw = extractBetween(chunk, '<PMID', '</PMID>');
      const pmid = pmidRaw.replace(/^[^>]*>/, '').trim();

      const titleRaw = extractBetween(chunk, '<ArticleTitle>', '</ArticleTitle>');
      const title = stripTags(titleRaw).trim() || stripTags(extractBetween(chunk, '<ArticleTitle', '</ArticleTitle>')).trim();

      const abstractSection = extractBetween(chunk, '<Abstract>', '</Abstract>');
      const abstractParts = extractAllBetween(abstractSection, '<AbstractText', '</AbstractText>');
      const abstractTexts = abstractParts.map((part) => {
        const labelMatch = part.match(/^([^>]*Label="([^"]*)")?>/);
        const label = labelMatch?.[2] ?? '';
        const text = stripTags(part.replace(/^[^>]*>?/, '')).trim();
        if (label && text) return `${label}: ${text}`;
        return text;
      });
      const abstract = abstractTexts.join(' ').slice(0, 2000);

      const journal = stripTags(extractBetween(chunk, '<Title>', '</Title>')).trim();

      const pubDateChunk = extractBetween(chunk, '<PubDate>', '</PubDate>');
      const year = stripTags(extractBetween(pubDateChunk, '<Year>', '</Year>')).trim();
      const month = stripTags(extractBetween(pubDateChunk, '<Month>', '</Month>')).trim();
      const day = stripTags(extractBetween(pubDateChunk, '<Day>', '</Day>')).trim();
      const dateStr = [year, month, day].filter(Boolean).join(' ');

      const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const keywordChunks = extractAllBetween(chunk, '<Keyword>', '</Keyword>');
      const keywords = keywordChunks.map(stripTags).map((s) => s.trim()).filter(Boolean);

      const meshChunks = extractAllBetween(chunk, '<DescriptorName', '</DescriptorName>');
      const meshTerms = meshChunks.map(stripTags).map((s) => s.trim()).filter(Boolean);

      if (title || pmid) {
        papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords, meshTerms });
      }
    } catch {
      continue;
    }
  }
  return papers;
}

function loadExistingSummarizedDates() {
  const trackingFile = join(process.cwd(), 'docs', '.summarized_pmids.json');
  if (!existsSync(trackingFile)) return new Set();
  try {
    const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
    return new Set(data.pmids ?? []);
  } catch {
    return new Set();
  }
}

function saveSummarizedPmids(pmids) {
  const trackingFile = join(process.cwd(), 'docs', '.summarized_pmids.json');
  const existing = loadExistingSummarizedDates();
  for (const id of pmids) existing.add(id);
  mkdirSync(dirname(trackingFile), { recursive: true });
  writeFileSync(trackingFile, JSON.stringify({ pmids: [...existing], updated: new Date().toISOString() }, null, 2), 'utf-8');
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
      days: { type: 'string', default: '7' },
      'max-papers': { type: 'string', default: '40' },
      output: { type: 'string', default: 'papers.json' },
    },
  });

  const days = parseInt(values.days, 10);
  const maxPapers = parseInt(values['max-papers'], 10);
  const outputPath = values.output;

  console.error(`[INFO] Searching PubMed for adolescent anxiety papers from last ${days} days...`);

  let pmids = [];

  console.error('[INFO] Trying targeted journal query...');
  const query1 = buildQuery(days);
  pmids = await searchPapers(query1, maxPapers);
  console.error(`[INFO] Targeted query: ${pmids.length} results`);

  if (pmids.length < 10) {
    console.error('[INFO] Too few results, trying broad query...');
    const query2 = buildBroadQuery(days);
    const extra = await searchPapers(query2, maxPapers);
    const existing = new Set(pmids);
    for (const id of extra) {
      if (!existing.has(id)) pmids.push(id);
    }
    console.error(`[INFO] After broad query: ${pmids.length} results`);
  }

  if (pmids.length === 0) {
    console.error('[WARN] No papers found');
    const empty = { date: getTaipeiDate(), count: 0, papers: [] };
    writeFileSync(outputPath, JSON.stringify(empty, null, 2), 'utf-8');
    return;
  }

  pmids = pmids.slice(0, maxPapers);

  console.error(`[INFO] Fetching details for ${pmids.length} papers...`);
  const ids = pmids.join(',');
  const fetchUrl = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  let xml;
  try {
    xml = await fetchText(fetchUrl);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    const empty = { date: getTaipeiDate(), count: 0, papers: [] };
    writeFileSync(outputPath, JSON.stringify(empty, null, 2), 'utf-8');
    return;
  }

  const papers = extractPapers(xml);
  console.error(`[INFO] Parsed ${papers.length} papers`);

  const existingPmids = loadExistingSummarizedDates();
  const newPapers = papers.filter((p) => !existingPmids.has(p.pmid));
  console.error(`[INFO] After filtering already-summarized: ${newPapers.length} new papers`);

  const output = {
    date: getTaipeiDate(),
    count: newPapers.length,
    papers: newPapers,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.error(`[INFO] Saved ${newPapers.length} papers to ${outputPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
