// Minimal Gmail REST v1 client over the platform fetch. Auth is a refresh
// token the owner minted once through Google's consent screen; the Function
// swaps it for a short-lived access token on every run. No Gmail SDK: four
// endpoints and some MIME walking do not justify a dependency tree.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

async function gmailGet(token, path) {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail GET ${path.split('?')[0]} failed: ${res.status}`);
  }
  return res.json();
}

// Everything since the watermark, spam and trash excluded, newest runs capped
// so one enormous backlog cannot blow the Function's time budget.
async function listMessagesSince(token, epochSeconds, cap = 200) {
  const q = `after:${epochSeconds} -in:spam -in:trash`;
  const out = [];
  let pageToken = null;
  do {
    const page = await gmailGet(token, `/messages?q=${encodeURIComponent(q)}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`);
    out.push(...(page.messages || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

function getMessage(token, id) {
  return gmailGet(token, `/messages/${id}?format=full`);
}

function getAttachment(token, messageId, attachmentId) {
  return gmailGet(token, `/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`);
}

function header(payload, name) {
  const match = ((payload && payload.headers) || [])
    .find((h) => String(h.name || '').toLowerCase() === name.toLowerCase());
  return match ? match.value : '';
}

function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function walkParts(part, visit) {
  if (!part) return;
  visit(part);
  (part.parts || []).forEach((child) => walkParts(child, visit));
}

// text/plain wins; otherwise the HTML part with the tags stripped. Triage and
// extraction read prose, not markup.
function extractBodyText(payload) {
  let plain = '';
  let html = '';
  walkParts(payload, (part) => {
    const data = part.body && part.body.data;
    if (!data) return;
    if (part.mimeType === 'text/plain' && !plain) plain = decodeB64Url(data).toString('utf8');
    if (part.mimeType === 'text/html' && !html) html = decodeB64Url(data).toString('utf8');
  });
  if (plain.trim()) return plain.trim();
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function listAttachments(payload) {
  const out = [];
  walkParts(payload, (part) => {
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType || '',
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
  });
  return out;
}

module.exports = {
  getAccessToken,
  listMessagesSince,
  getMessage,
  getAttachment,
  header,
  decodeB64Url,
  extractBodyText,
  listAttachments,
};
