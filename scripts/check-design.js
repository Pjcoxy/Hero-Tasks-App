// Design-system guardrail for frontend/index.html.
//
// This only enforces a few structural constraints that are easy to check in
// plain Node with no dependencies:
//  - design tokens stay in one :root block and raw colours are not reintroduced
//    in component CSS rules,
//  - raw px spacing/font sizes are not reintroduced outside a tiny allow-list,
//  - no external http(s) assets are referenced by src/href/url()/@import,
//  - shell structure remains top-level views + overlays, not new stacked sections.
//
// It cannot judge whether the design is good. It only checks token reuse,
// external-request bans, and shell-shape constraints.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'frontend', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let failures = 0;

// Keep exceptions explicit and readable in this script.
const ALLOWED_PX_VALUES = ['0px', '1px', '2px'];

const SPACING_OR_FONT_PROPERTIES = new Set([
  'font-size',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'top', 'right', 'bottom', 'left', 'inset',
]);

function check(ok, message) {
  if (ok) {
    console.log('  ok   ' + message);
  } else {
    console.error('  FAIL ' + message);
    failures += 1;
  }
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function isHiddenEquivalent(attrs) {
  if (/\shidden(\s|=|>)/i.test(' ' + attrs + '>')) return true;
  const classMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/i);
  const classValue = classMatch ? (classMatch[1] || classMatch[2] || '') : '';
  if (/\bhidden\b/.test(classValue)) return true;
  if (/\baria-hidden\s*=\s*["']true["']/i.test(attrs)) return true;
  return false;
}

const styleMatch = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
check(Boolean(styleMatch), '<style> block exists');

let style = '';
let styleStart = 0;
let outsideRootStyle = '';
if (styleMatch) {
  style = styleMatch[1];
  styleStart = styleMatch.index + styleMatch[0].indexOf(style);

  const rootStart = style.search(/:root\s*\{/);
  check(rootStart >= 0, 'single :root token block exists');

  if (rootStart >= 0) {
    const secondRoot = style.slice(rootStart + 1).search(/:root\s*\{/);
    check(secondRoot === -1, 'only one :root token block exists');

    const openBrace = style.indexOf('{', rootStart);
    let depth = 0;
    let rootEnd = -1;
    for (let i = openBrace; i < style.length; i += 1) {
      const ch = style[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          rootEnd = i;
          break;
        }
      }
    }

    check(rootEnd > openBrace, ':root token block is balanced');
    if (rootEnd > openBrace) {
      outsideRootStyle = style.slice(0, rootStart) + style.slice(rootEnd + 1);
    }
  }
}

if (outsideRootStyle) {
  const rawColourRegex = /#[0-9a-fA-F]{3,8}\b|rgba?\s*\(|hsla?\s*\(/g;
  const rawColours = [...outsideRootStyle.matchAll(rawColourRegex)];
  check(rawColours.length === 0, `no raw colour values outside :root (${rawColours.length} found)`);
  rawColours.slice(0, 5).forEach((m) => {
    const line = lineForOffset(style, styleStart + m.index - styleStart);
    console.error(`       at style line ${line}: ${m[0]}`);
  });

  const declarationRegex = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
  const pxRegex = /-?\d*\.?\d+px\b/g;
  const badPx = [];

  for (const m of outsideRootStyle.matchAll(declarationRegex)) {
    const property = m[1].toLowerCase();
    if (!SPACING_OR_FONT_PROPERTIES.has(property)) continue;

    const value = m[2];
    const pxValues = value.match(pxRegex) || [];
    pxValues.forEach((px) => {
      if (!ALLOWED_PX_VALUES.includes(px)) {
        badPx.push({ property, px, index: m.index });
      }
    });
  }

  check(badPx.length === 0, `no raw px spacing/font values outside allow-list (${badPx.length} found)`);
  badPx.slice(0, 5).forEach((hit) => {
    const line = lineForOffset(style, styleStart + hit.index - styleStart);
    console.error(`       at style line ${line}: ${hit.property}: ${hit.px}`);
  });
}

const externalUrlPatterns = [
  { regex: /\b(?:src|href)\s*=\s*["']https?:\/\//gi, label: 'src/href' },
  { regex: /\burl\(\s*["']?https?:\/\//gi, label: 'url()' },
  { regex: /@import\s+(?:url\(\s*)?["']https?:\/\//gi, label: '@import' },
];

let externalHits = 0;
externalUrlPatterns.forEach(({ regex }) => {
  externalHits += [...html.matchAll(regex)].length;
});
check(externalHits === 0, `no external http(s) asset references (${externalHits} found)`);

const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
check(Boolean(bodyMatch), '<body> block exists');

if (bodyMatch) {
  const body = bodyMatch[1];
  const allowedTopLevelIds = new Set(['confetti-canvas', 'screen-who', 'screen-kid', 'screen-parent', 'pin-modal', 'voice-reminder-modal', 'toast']);
  const seenTopLevelIds = new Set();
  let unexpectedTopLevel = 0;

  const tagRegex = /<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  const stack = [];
  for (const m of body.matchAll(tagRegex)) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const closing = full.startsWith('</');
    const selfClosing = /\/>$/.test(full) || ['meta', 'link', 'img', 'input', 'br', 'hr'].includes(tag);

    if (!closing && stack.length === 0) {
      const idMatch = attrs.match(/\bid\s*=\s*"([^"]+)"|\bid\s*=\s*'([^']+)'/i);
      const id = idMatch ? (idMatch[1] || idMatch[2]) : null;
      const allowed = tag === 'script' || (id && allowedTopLevelIds.has(id));
      if (!allowed) {
        unexpectedTopLevel += 1;
        const line = lineForOffset(html, bodyMatch.index + m.index);
        console.error(`       unexpected top-level <${tag}> at html line ${line}`);
      }
      if (id && allowedTopLevelIds.has(id)) seenTopLevelIds.add(id);
    }

    if (!closing && !selfClosing) stack.push(tag);
    if (closing && stack.length) stack.pop();
  }

  check(unexpectedTopLevel === 0, `no top-level markup outside app shell containers (${unexpectedTopLevel} found)`);

  const missingTopLevel = [...allowedTopLevelIds].filter((id) => !seenTopLevelIds.has(id));
  check(missingTopLevel.length === 0, `all required top-level shell elements present (${missingTopLevel.length} missing)`);

  const screenDefs = [
    { id: 'screen-who', regex: /<[^>]+id="screen-who"([^>]*)>/i },
    { id: 'screen-kid', regex: /<[^>]+id="screen-kid"([^>]*)>/i },
    { id: 'screen-parent', regex: /<[^>]+id="screen-parent"([^>]*)>/i },
  ];

  let visibleScreens = 0;
  screenDefs.forEach(({ id, regex }) => {
    const m = html.match(regex);
    check(Boolean(m), `${id} exists`);
    if (m && !isHiddenEquivalent(m[1])) visibleScreens += 1;
  });
  check(visibleScreens <= 1, `at most one top-level screen visible in static markup (${visibleScreens} visible)`);

  function countVisiblePanels(panelIds) {
    let visible = 0;
    panelIds.forEach((id) => {
      const m = html.match(new RegExp(`<[^>]+id=\"${id}\"([^>]*)>`, 'i'));
      check(Boolean(m), `${id} exists`);
      if (m && !isHiddenEquivalent(m[1])) visible += 1;
    });
    return visible;
  }

  const visibleKidPanels = countVisiblePanels(['tab-home', 'tab-missions', 'tab-rewards', 'tab-leaderboard']);
  check(visibleKidPanels <= 1, `at most one kid tab panel visible in static markup (${visibleKidPanels} visible)`);

  const visibleParentPanels = countVisiblePanels(['p-tab-approvals', 'p-tab-tasks', 'p-tab-rewards', 'p-tab-settings']);
  check(visibleParentPanels <= 1, `at most one parent tab panel visible in static markup (${visibleParentPanels} visible)`);
}

if (failures) {
  console.error(`\n${failures} design check(s) failed`);
  process.exit(1);
}
console.log('\ndesign checks passed');
