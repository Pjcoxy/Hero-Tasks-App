const Anthropic = require('@anthropic-ai/sdk');

// Lowest-cost current Claude tier suitable for short structured extraction.
const VOICE_INTENT_MODEL = 'claude-haiku-4-5';

const DEFAULT_FALLBACK_CONFIDENCE = Object.freeze({
  what: 0,
  when: 0,
  who: 0,
});

const defaultCreateAnthropicClient = (apiKey) => new Anthropic({ apiKey });

let createAnthropicClient = defaultCreateAnthropicClient;

function fallbackResult(transcript, available) {
  return {
    available,
    intent: {
      what: String(transcript || '').trim(),
      when: null,
      who: null,
    },
    confidence: { ...DEFAULT_FALLBACK_CONFIDENCE },
  };
}

function setAnthropicClientFactory(factory) {
  createAnthropicClient = typeof factory === 'function' ? factory : defaultCreateAnthropicClient;
}

function resetAnthropicClientFactory() {
  createAnthropicClient = defaultCreateAnthropicClient;
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function resolveKidId(value, kids) {
  const candidate = String(value || '').trim().toLowerCase();
  if (!candidate) return null;
  const match = kids.find((kid) => (
    String(kid.id || '').trim().toLowerCase() === candidate
      || String(kid.name || '').trim().toLowerCase() === candidate
  ));
  return match ? match.id : null;
}

function buildPrompt(transcript, kids, requesterId) {
  const kidLines = kids
    .map((kid) => `- ${kid.id}: ${kid.name}${kid.id === requesterId ? ' (requesting kid)' : ''}`)
    .join('\n');

  return [
    'Transcript:',
    transcript,
    '',
    'Kids:',
    kidLines || '- none supplied',
    '',
    'Return JSON only with this shape:',
    '{"intent":{"what":"string","when":"string|null","who":"kid-id-or-null"},"confidence":{"what":0,"when":0,"who":0}}',
    '',
    'Rules:',
    '- Clean up the task/reminder wording into intent.what.',
    '- intent.when is an ISO date/time string, a coarse time label from the transcript, or null.',
    '- intent.who must be one of the listed kid ids. If no other kid is named, default to the requesting kid.',
    '- Use null and a low confidence instead of guessing.',
  ].join('\n');
}

async function extractVoiceIntent(transcript, kids) {
  const cleanTranscript = String(transcript || '').trim();
  const apiKey = String(process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    return fallbackResult(cleanTranscript, false);
  }

  const safeKids = Array.isArray(kids) ? kids.filter((kid) => kid && kid.id && kid.name) : [];
  const requester = safeKids.find((kid) => kid.isRequester) || null;
  const requesterId = requester ? requester.id : null;

  try {
    const client = createAnthropicClient(apiKey);
    // Keep this prompt intentionally tiny: one short transcript in, one tiny JSON
    // object out, with no chat history or follow-up turns, to bound runtime cost.
    const response = await client.messages.create({
      model: VOICE_INTENT_MODEL,
      max_tokens: 160,
      temperature: 0,
      system: 'Extract structured intent from one short kid voice transcript. Return JSON only.',
      messages: [{
        role: 'user',
        content: buildPrompt(cleanTranscript, safeKids, requesterId),
      }],
    });

    const text = Array.isArray(response && response.content)
      ? response.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      : '';
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== 'object') {
      return fallbackResult(cleanTranscript, true);
    }

    const intent = parsed.intent && typeof parsed.intent === 'object' ? parsed.intent : parsed;
    const confidence = parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {};
    const what = String(intent.what || '').trim() || cleanTranscript;
    const when = String(intent.when || '').trim() || null;
    const resolvedWho = resolveKidId(intent.who, safeKids);

    return {
      available: true,
      intent: {
        what,
        when,
        who: resolvedWho,
      },
      confidence: {
        what: normalizeConfidence(confidence.what),
        when: normalizeConfidence(confidence.when),
        who: normalizeConfidence(confidence.who),
      },
    };
  } catch (err) {
    console.warn('extractVoiceIntent failed', err && err.message ? err.message : err);
    return fallbackResult(cleanTranscript, true);
  }
}

module.exports = {
  extractVoiceIntent,
  setAnthropicClientFactory,
  resetAnthropicClientFactory,
};
