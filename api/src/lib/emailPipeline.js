// The two-stage read of one email. Stage one is a cheap yes/no - is there
// anything here for this family's kids - so the expensive read only happens
// on the emails that earn it. Stage two reads the full body AND the
// attachments (the value in a scouts email is the PDF, not the covering
// note) and returns structured items ready for ingestEmailItem.

const Anthropic = require('@anthropic-ai/sdk');
const AdmZip = require('adm-zip');

const TRIAGE_MODEL = 'claude-haiku-4-5';
const EXTRACT_MODEL = 'claude-sonnet-5';

const defaultCreateClient = (apiKey) => new Anthropic({ apiKey });
let createClient = defaultCreateClient;

function setEmailClientFactory(factory) {
  createClient = typeof factory === 'function' ? factory : defaultCreateClient;
}

function resetEmailClientFactory() {
  createClient = defaultCreateClient;
}

function responseText(response) {
  return Array.isArray(response && response.content)
    ? response.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    : '';
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

// "Relevant" is deliberately wide: anything about the kids' activities,
// school, clubs, events, or money owed for any of those. Missing a scout camp
// costs far more than one wasted deep read.
async function triageEmail(email) {
  const client = createClient(process.env.LLM_API_KEY);
  const response = await client.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 120,
    temperature: 0,
    system: 'You screen one family inbox email. Return JSON only.',
    messages: [{
      role: 'user',
      content: [
        'Is this email relevant to organising a family’s kids - activities,',
        'events, school, clubs, camps, or payments/forms for any of those?',
        'Newsletters that only announce dates still count as relevant.',
        'Marketing, receipts for unrelated purchases, and adult-only mail do not.',
        '',
        `From: ${email.from}`,
        `Subject: ${email.subject}`,
        '',
        String(email.bodyText || '').slice(0, 4000),
        '',
        'Return JSON: {"relevant": true|false, "why": "one short sentence"}',
      ].join('\n'),
    }],
  });
  const parsed = extractJsonObject(responseText(response));
  return {
    relevant: !!(parsed && parsed.relevant),
    why: parsed && parsed.why ? String(parsed.why) : '',
  };
}

// A .xlsx is a zip of XML; the packing lists that arrive this way are flat
// text in disguise. Pull every cell string rather than modelling the sheet.
function xlsxToText(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const texts = [];
    zip.getEntries().forEach((entry) => {
      if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(entry.entryName)) return;
      const xml = entry.getData().toString('utf8');
      const matches = xml.match(/<t[^>]*>([^<]*)<\/t>/g) || [];
      matches.forEach((m) => {
        const inner = m.replace(/<[^>]+>/g, '').trim();
        if (inner) texts.push(inner);
      });
    });
    return texts.join('\n');
  } catch {
    return '';
  }
}

// One attachment -> one Claude content block, or null when the type carries
// nothing readable. data arrives base64url from the Gmail API.
function attachmentToBlock(att, base64UrlData) {
  const data = String(base64UrlData || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!data) return null;
  const name = String(att.filename || '').toLowerCase();
  const mime = String(att.mimeType || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (imageTypes.includes(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }
  if (name.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    const text = xlsxToText(Buffer.from(data, 'base64'));
    if (!text) return null;
    return { type: 'text', text: `Attachment ${att.filename} (spreadsheet contents):\n${text.slice(0, 8000)}` };
  }
  return null;
}

function buildExtractionPrompt(email, kids, tz, nowIso) {
  const kidLines = kids.map((kid) => `- ${kid.id}: ${kid.name}`).join('\n');
  return [
    'Read this family-inbox email (attachments included as separate blocks)',
    'and extract every distinct kid-relevant event, activity, or action as an',
    'item. Return JSON only.',
    '',
    `Household timezone: ${tz}. Current time: ${nowIso}.`,
    'Kids:',
    kidLines || '- none',
    '',
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Received: ${email.receivedAt}`,
    '',
    'Body:',
    String(email.bodyText || '').slice(0, 12000),
    '',
    'Return JSON with this shape:',
    '{"items":[{"classification":"kid-choice|parent-direct|informational",',
    '"type":"event","title":"string","personId":"kid-id-or-null",',
    '"startAt":"ISO with timezone offset","endAt":"ISO-or-null","allDay":false,',
    '"summary":"2-3 plain sentences a parent can decide from",',
    '"payments":[{"description":"","amount":"","bank":"","accountName":"","bsb":"","account":"","reference":""}],',
    '"prepLists":[{"personId":"kid-id","items":[{"text":""}],"points":0}],',
    '"adultActions":[{"text":""}],',
    '"proposedPrepDueBy":"ISO-or-null"}]}',
    '',
    'Rules:',
    '- One item per distinct event. A single email can carry several.',
    '- classification: kid-choice = an optional activity the kid can choose to',
    '  join (hikes, camps, discos); parent-direct = needs a parent decision or',
    '  money/forms regardless of kid interest (fees, purchases, permissions',
    '  with cost); informational = dates and announcements with nothing to',
    '  decide (club newsletters, term dates).',
    '- personId: the kid the item is for, matched by name in the email or its',
    '  attachments; null when it is for the whole family or unclear.',
    '- startAt/endAt: local wall time in the household timezone, written with',
    '  its UTC offset. Multi-day camps: startAt first day, endAt last day.',
    '- payments: copy bank details exactly as written (they are displayed to a',
    '  parent to pay manually - never invent or normalise digits). Omit fields',
    '  the email does not state.',
    '- prepLists: packing/prep lists found in the email or attachments, as',
    '  short tickable lines for the kid the item is for. points stays 0 - the',
    '  parents decide what preparation is worth.',
    '- adultActions: things only a parent can do (pay, sign, submit a form).',
    '- proposedPrepDueBy: when preparation should be done by, judged from the',
    '  event’s scale: an ordinary evening activity -> 18:00 the day before;',
    '  a day trip -> 18:00 the day before; an overnight camp or trip -> 18:00',
    '  two to three days before. null when there is nothing to prepare.',
    '- Skip anything already in the past. Return {"items":[]} when nothing',
    '  qualifies.',
  ].join('\n');
}

async function extractProposals(email, attachmentBlocks, kids, tz) {
  const client = createClient(process.env.LLM_API_KEY);
  const content = [
    { type: 'text', text: buildExtractionPrompt(email, kids, tz, new Date().toISOString()) },
    ...attachmentBlocks,
  ];
  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 3000,
    // No temperature: Sonnet 5 removed the sampling parameters and rejects
    // them with a 400. Triage keeps temperature 0 because Haiku 4.5 still
    // accepts it and a deterministic yes/no is worth having.
    system: 'Extract structured family-calendar items from one email and its attachments. Return JSON only.',
    messages: [{ role: 'user', content }],
  });
  const parsed = extractJsonObject(responseText(response));
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  return {
    items: items.filter((item) => item && item.title && item.startAt && item.classification),
  };
}

module.exports = {
  triageEmail,
  extractProposals,
  attachmentToBlock,
  xlsxToText,
  setEmailClientFactory,
  resetEmailClientFactory,
  TRIAGE_MODEL,
  EXTRACT_MODEL,
};
