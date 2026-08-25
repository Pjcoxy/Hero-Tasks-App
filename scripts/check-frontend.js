// Minimal smoke check for frontend/index.html: it is a single hand-written
// file with no build step, so a stray unclosed tag or a syntax error in an
// inline script would ship straight to the kids' devices. This catches the
// obvious cases without pulling in a parser dependency.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'frontend', 'index.html');
const manifestFile = path.join(__dirname, '..', 'frontend', 'manifest.json');
const svgIconFile = path.join(__dirname, '..', 'frontend', 'icon.svg');
const swFile = path.join(__dirname, '..', 'frontend', 'sw.js');
const icon180File = path.join(__dirname, '..', 'frontend', 'icon-180.png');
const icon192File = path.join(__dirname, '..', 'frontend', 'icon-192.png');
const icon512File = path.join(__dirname, '..', 'frontend', 'icon-512.png');
const maskableIconFile = path.join(__dirname, '..', 'frontend', 'icon-maskable.png');
const html = fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const svgIcon = fs.readFileSync(svgIconFile, 'utf8');
const sw = fs.readFileSync(swFile, 'utf8');
let failures = 0;

function check(ok, message) {
  if (ok) {
    console.log('  ok   ' + message);
  } else {
    console.error('  FAIL ' + message);
    failures += 1;
  }
}

function pngSize(filePath) {
  const png = fs.readFileSync(filePath);
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

const opens = (html.match(/<script\b/g) || []).length;
const closes = (html.match(/<\/script>/g) || []).length;
check(opens === closes, `script tags balanced (${opens} open, ${closes} close)`);
check(opens > 0, 'at least one inline script block found');
check(/<meta name="theme-color" content="#6d3bf5">/.test(html), 'theme-color meta matches the design-system brand');
check(/<meta name="apple-mobile-web-app-capable" content="yes">/.test(html), 'apple mobile web app capable meta is present');
check(/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/.test(html), 'apple status bar meta is present');
check(/<meta name="apple-mobile-web-app-title" content="Hero Tasks">/.test(html), 'apple mobile web app title meta is present');
check(/<link rel="apple-touch-icon" href="icon-180.png">/.test(html), 'apple touch icon link is present');

check(manifest.theme_color === '#6d3bf5', 'manifest theme_color matches the design-system brand');
check(manifest.background_color === '#f7f5ff', 'manifest background_color matches the design-system background');
check(Array.isArray(manifest.icons), 'manifest icons array exists');
check(/fill="#6d3bf5"/.test(svgIcon), 'SVG icon uses the design-system brand fill');
if (Array.isArray(manifest.icons)) {
  const svgIcon = manifest.icons.find((icon) => icon.src === 'icon.svg');
  const icon192 = manifest.icons.find((icon) => icon.src === 'icon-192.png');
  const icon512 = manifest.icons.find((icon) => icon.src === 'icon-512.png');
  const maskableIcon = manifest.icons.find((icon) => icon.src === 'icon-maskable.png');
  check(Boolean(svgIcon), 'manifest keeps the SVG icon');
  check(svgIcon && svgIcon.purpose === 'any', 'SVG icon purpose is any');
  check(icon192 && icon192.sizes === '192x192' && icon192.type === 'image/png' && icon192.purpose === 'any', 'manifest includes the 192px PNG icon');
  check(icon512 && icon512.sizes === '512x512' && icon512.type === 'image/png' && icon512.purpose === 'any', 'manifest includes the 512px PNG icon');
  check(maskableIcon && maskableIcon.sizes === '512x512' && maskableIcon.type === 'image/png' && maskableIcon.purpose === 'maskable', 'manifest includes the maskable PNG icon');
}

check(fs.existsSync(icon180File), '180px Apple touch icon file exists');
check(fs.existsSync(icon192File), '192px install icon file exists');
check(fs.existsSync(icon512File), '512px install icon file exists');
check(fs.existsSync(maskableIconFile), 'maskable install icon file exists');
if (fs.existsSync(icon180File)) {
  const size = pngSize(icon180File);
  check(size.width === 180 && size.height === 180, 'Apple touch icon is 180x180');
}
if (fs.existsSync(icon192File)) {
  const size = pngSize(icon192File);
  check(size.width === 192 && size.height === 192, 'install icon is 192x192');
}
if (fs.existsSync(icon512File)) {
  const size = pngSize(icon512File);
  check(size.width === 512 && size.height === 512, 'install icon is 512x512');
}
if (fs.existsSync(maskableIconFile)) {
  const size = pngSize(maskableIconFile);
  check(size.width === 512 && size.height === 512, 'maskable install icon is 512x512');
}

check(/const CACHE_NAME = 'hero-tasks-shell-v4';/.test(sw), 'service worker cache name bumped to v4');
check(/'\/icon-180\.png'/.test(sw), 'service worker caches the Apple touch icon');
check(/'\/icon-192\.png'/.test(sw), 'service worker caches the 192px icon');
check(/'\/icon-512\.png'/.test(sw), 'service worker caches the 512px icon');
check(/'\/icon-maskable\.png'/.test(sw), 'service worker caches the maskable icon');

const parentTabButtons = html.match(/id="p-tabbtn-(approvals|tasks|rewards|calendar|settings)"/g) || [];
check(parentTabButtons.length === 5, `parent HQ exposes 5 tab buttons (${parentTabButtons.length} found)`);
check(/let parentTab = 'approvals';/.test(html), 'parent tab state defaults to approvals');
check(/function switchParentTab\(tab\)/.test(html), 'parent tab switcher exists');
check(/id="p-tab-calendar"/.test(html), 'parent calendar tab panel exists');
check(/\['approvals', 'tasks', 'rewards', 'calendar', 'settings'\]/.test(html), 'parent tab switcher includes calendar');
// The parent calendar dropped Day/Week/Month for a single month with arrows,
// a pinned week strip and an inline agenda. These replace the view-switcher
// check rather than dropping it - the point is still that the controls exist.
check(/function parentCalendarStep\(delta\)/.test(html), 'parent calendar steps month by month');
check(/function parentCalendarWeekStep\(delta\)/.test(html), 'parent calendar week strip has its own nav');
check(/id="p-calendar-week"/.test(html), 'parent calendar has a this-week strip');
check(/id="p-calendar-grid"/.test(html), 'parent calendar has a month grid');
check(/id="p-calendar-agenda"/.test(html), 'parent calendar expands an agenda inline');
check(/function parentCalendarPersonColour\(item\)/.test(html), 'calendar dots are coloured per person');
check(!/id="p-calendar-view-(day|week|month)"/.test(html), 'the old parent Day/Week/Month chips are gone');
check(/action:\s*'addPlanningItem'/.test(html), 'parent calendar form calls addPlanningItem');
check(/action:\s*'updatePlanningItem'/.test(html), 'parent calendar edit calls updatePlanningItem');
check(/action:\s*'deletePlanningItem'/.test(html), 'parent calendar delete calls deletePlanningItem');
check(/id="p-approvals-badge"/.test(html), 'approvals badge exists');
// The Approvals tab is decisions plus today's state, nothing else: no
// Yesterday and no This-week sections - the Calendar tab owns those.
check(!/id="p-approvals-glance"/.test(html), 'approvals tab has no at-a-glance section (Calendar owns the week)');
check(!/id="p-yesterday"/.test(html), 'approvals tab has no Yesterday section (Calendar owns the past)');
check(/id="p-approvals-today-by-kid"/.test(html), 'approvals tab includes today-by-kid container');
check(/Today, by kid/.test(html), 'approvals tab includes Today, by kid title');
const approvalsTodayByKidIndex = html.indexOf('id="p-approvals-today-by-kid"');
const approvalsPendingIndex = html.indexOf('id="p-pending"');
// Work waiting on the parent comes first on the tab they land on. These
// assertions previously encoded the opposite order; the order changed, so they
// were updated rather than dropped - the point is that the order is deliberate.
const approvalsRewardReqIndex = html.indexOf('id="p-reward-requests"');
check(approvalsPendingIndex !== -1 && approvalsTodayByKidIndex !== -1 && approvalsPendingIndex < approvalsTodayByKidIndex, 'pending approvals list appears before today-by-kid section');
check(approvalsRewardReqIndex !== -1 && approvalsTodayByKidIndex !== -1 && approvalsRewardReqIndex < approvalsTodayByKidIndex, 'reward requests appear before today-by-kid section');
check(/onclick="jumpToApproval\(/.test(html), 'waiting-on-you rows link through to their approval');
check(/id="p-pending-' \+ c\.id \+ '"/.test(html), 'pending approval cards carry an id to jump to');
check(/function loadParentApprovalsGlance\(\)/.test(html), 'calendar-backed approvals loader exists (feeds today-by-kid)');
check(/action:\s*'calendar'[\s\S]*parentId:\s*session\.personId[\s\S]*parentPin:\s*session\.pin/.test(html), 'approvals loader reuses calendar action with parent credentials');
check(/function parentCalendarLiveCompletion\(item\)/.test(html), 'calendar live completion matcher exists');
check(/function parentCalendarOverviewStatus\(item\)/.test(html), 'calendar overview status helper exists');
check(/function renderParentApprovalsTodayByKid\(\)/.test(html), 'approvals today-by-kid renderer exists');
check(/function renderParentApprovalsSummary\(\)/.test(html), 'approvals summary renderer exists');
check(/\.tag\.waiting\s*\{\s*background:\s*var\(--warning-wash\);\s*color:\s*var\(--warning\);\s*\}/.test(html), 'waiting tag uses warning tokens');
check(/item\.kind === 'chore' && item\.kidId === kid\.id && parentCalendarDayKey\(item\) === todayKey/.test(html), 'today-by-kid renderer filters today chore occurrences per kid');
check(/switchParentTab\('calendar'\)|switchParentTab\\\('calendar'\\\)/.test(html), 'today-by-kid offers a View calendar action');
check(/parentEditTask\(\\'/.test(html), 'task rows wire an Edit button');
// #164: every editor is a form or the in-app modal; the native dialogs that
// printed the Azure hostname at the family are banned outright.
{
  const calls = [...html.matchAll(/[^a-zA-Z.'"](prompt|confirm)\(/g)]
    .filter((m) => !/\/\//.test(html.slice(html.lastIndexOf('\n', m.index) + 1, m.index)));
  check(calls.length === 0, `no native prompt()/confirm() calls remain (${calls.length} found)`);
}
check(/id="k-voice-reminder-btn"/.test(html), 'kid Home tab includes a voice reminder button');
check(/id="voice-reminder-modal"/.test(html), 'voice reminder confirmation modal exists');
check(/window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/.test(html), 'voice reminder flow feature-detects SpeechRecognition support');
check(/action:\s*'validateVoiceNote'/.test(html), 'voice reminder flow calls validateVoiceNote');
check(/action:\s*'saveVoicePlan'/.test(html), 'voice capture flow calls saveVoicePlan');
check(/type:\s*voiceReminderDraft\.type/.test(html), 'voice capture flow sends the chosen item type');
check(/id="voice-type-choice-reminder"/.test(html) && /id="voice-type-choice-task"/.test(html) && /id="voice-type-choice-event"/.test(html), 'voice capture sheet offers reminder/task/event pills');
check(/function chooseVoiceReminderType\(typeKey\)/.test(html), 'voice capture sheet lets the kid change the item type');
check(/This weekend/.test(html) && /No specific time/.test(html), 'voice reminder flow includes low-confidence when choice pills');
const kidTabButtons = html.match(/id="tabbtn-(home|missions|rewards|leaderboard|calendar)"/g) || [];
check(kidTabButtons.length === 5, `kid nav exposes 5 tab buttons (${kidTabButtons.length} found)`);
check(/id="tab-calendar"/.test(html), 'calendar tab panel exists');
check(/\['home', 'missions', 'rewards', 'leaderboard', 'calendar'\]/.test(html), 'kid tab switcher includes calendar');
check(/function switchCalendarView\(view\)/.test(html), 'calendar view switcher exists');

// Syntax-check each inline script body.
const bodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
bodies.forEach((body, i) => {
  if (!body.trim()) return;
  try {
    new Function(body);
    check(true, `inline script ${i + 1} parses`);
  } catch (err) {
    check(false, `inline script ${i + 1} parses - ${err.message}`);
  }
});

function extractFunctionSource(name) {
  // Handles both `async function f(` and plain `function f(` - avatarText is
  // synchronous, and only looking for the async form silently returned ''.
  let start = html.indexOf(`async function ${name}(`);
  if (start === -1) {
    const plain = html.indexOf(`function ${name}(`);
    // Guard against matching the tail of "async function f(" as "function f(".
    if (plain !== -1 && !/async\s+$/.test(html.slice(Math.max(0, plain - 8), plain))) {
      start = plain;
    }
  }
  if (start === -1) return '';
  const openBrace = html.indexOf('{', start);
  if (openBrace === -1) return '';
  let depth = 0;
  for (let i = openBrace; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return '';
}

async function runParentEditTaskChecks() {
  // #164: editing reuses the allocate form (prefilled, Save/Cancel) instead
  // of a prompt chain. The real page functions are lifted out and driven
  // against a fake DOM, so these checks fail if the page's behaviour drifts.
  const sources = {};
  for (const name of ['parentEditTask', 'cancelTaskEdit', 'parentAddTask', 'updateDueVisibility', 'selectedDays', 'planningDateToLocalInput']) {
    sources[name] = extractFunctionSource(name);
    check(Boolean(sources[name]), `${name} source found for the sandbox`);
    if (!sources[name]) return;
  }
  check(!/[^a-zA-Z.'"]prompt\(/.test(sources.parentEditTask + sources.parentAddTask), 'the task editor never calls native prompt()');

  function makeDom() {
    const elements = {};
    for (const id of ['p-title', 'p-kid', 'p-cycle', 'p-window', 'p-due', 'p-points',
      'p-task-submit', 'p-task-cancel', 'p-due-wrap', 'p-days-wrap', 'p-window-wrap']) {
      elements[id] = {
        value: '',
        checked: false,
        textContent: '',
        classList: {
          set: new Set(['p-task-cancel'].includes(id) ? ['hidden'] : []),
          toggle(cls, on) { if (on === undefined) on = !this.set.has(cls); on ? this.set.add(cls) : this.set.delete(cls); },
          add(cls) { this.set.add(cls); },
          remove(cls) { this.set.delete(cls); },
          contains(cls) { return this.set.has(cls); },
        },
        closest: () => null,
        focus: () => {},
      };
    }
    const dayBoxes = [1, 2, 3, 4, 5, 6, 0].map((v) => ({ value: String(v), checked: false }));
    return {
      elements,
      dayBoxes,
      document: {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: (sel) => (sel === '#p-days input' ? dayBoxes
          : sel === '#p-days input:checked' ? dayBoxes.filter((b) => b.checked) : []),
      },
    };
  }

  function makeHarness(options) {
    const dom = makeDom();
    const toasts = [];
    const apiCalls = [];
    const state = (options && options.state) || {
      tasks: [
        { id: 'task1', title: 'Feed the dog', points: 5, cycle: 'daily', kidId: 'toby', dueBy: null },
      ],
      windows: [{ id: 'evening', label: 'Evening', closesAt: '21:00' }],
      fallbackWindowId: 'evening',
      people: [
        { id: 'peter', role: 'parent', name: 'Peter' },
        { id: 'toby', role: 'kid', name: 'Toby' },
        { id: 'ollie', role: 'kid', name: 'Ollie' },
      ],
    };
    const apiResult = options && Object.prototype.hasOwnProperty.call(options, 'apiResult')
      ? options.apiResult : { ok: true };
    const factory = new Function(
      'state', 'session', 'document', 'toast', 'api', 'toastApiError',
      `let taskEditId = null;\n${sources.planningDateToLocalInput}\n${sources.selectedDays}\n${sources.updateDueVisibility}\n${sources.cancelTaskEdit}\n${sources.parentAddTask}\n${sources.parentEditTask}\n`
        + 'return { edit: parentEditTask, save: parentAddTask, cancel: cancelTaskEdit, editId: () => taskEditId };'
    );
    const handles = factory(
      state,
      { personId: 'peter', pin: '1234' },
      dom.document,
      (message) => toasts.push(message),
      async (payload) => { apiCalls.push(payload); return apiResult; },
      (result) => {
        if (result && result.ok === false) { toasts.push(result.error || 'Something went wrong.'); return true; }
        return false;
      }
    );
    return { dom, toasts, apiCalls, handles };
  }

  {
    // Prefill and the happy-path save.
    const run = makeHarness();
    await run.handles.edit('task1');
    check(run.dom.elements['p-title'].value === 'Feed the dog', 'edit prefills the title');
    check(run.dom.elements['p-kid'].value === 'toby', 'edit prefills the kid');
    check(run.dom.elements['p-cycle'].value === 'daily', 'edit prefills the cycle');
    check(run.dom.elements['p-task-submit'].textContent === 'Save changes', 'edit swaps the button to Save changes');
    check(!run.dom.elements['p-task-cancel'].classList.contains('hidden'), 'edit reveals the Cancel button');

    run.dom.elements['p-title'].value = '  Feed the cat  ';
    run.dom.elements['p-points'].value = '8';
    run.dom.elements['p-cycle'].value = 'oneoff';
    run.dom.elements['p-kid'].value = 'ollie';
    run.dom.elements['p-due'].value = '2026-08-25T18:00';
    await run.handles.save();
    check(run.apiCalls.length === 1, 'saving an edit submits once');
    if (run.apiCalls.length === 1) {
      const payload = run.apiCalls[0];
      check(payload.action === 'updateTask', 'saving an edit calls updateTask');
      check(payload.title === 'Feed the cat', 'saving trims and sends the title');
      check(payload.points === 8, 'saving sends parsed integer points');
      check(payload.cycle === 'oneoff', 'saving sends the chosen cycle');
      check(payload.kidId === 'ollie', 'saving reassigns to the chosen kid');
      check(payload.windowId === null, 'a one-off carries no window');
      check(payload.dueBy === new Date('2026-08-25T18:00').toISOString(), 'saving converts dueBy to ISO');
    }
    check(run.toasts.includes('Task updated! \u270f\ufe0f'), 'saving toasts success');
    check(run.handles.editId() === null, 'a clean save leaves edit mode');
    check(run.dom.elements['p-task-submit'].textContent === 'Allocate task', 'the button reads Allocate task again');
  }

  {
    // Blank title aborts with the add-task copy.
    const run = makeHarness();
    await run.handles.edit('task1');
    run.dom.elements['p-title'].value = '   ';
    await run.handles.save();
    check(run.apiCalls.length === 0, 'blank edited task title aborts before API call');
    check(run.toasts.includes('Type or speak a task first!'), 'blank edited task title reuses add-task validation copy');
  }

  {
    // Invalid points abort.
    const run = makeHarness();
    await run.handles.edit('task1');
    run.dom.elements['p-points'].value = '0';
    await run.handles.save();
    check(run.apiCalls.length === 0, 'invalid task points abort before API call');
    check(run.toasts.includes('Points must be a positive integer.'), 'invalid task points show the expected toast');
  }

  {
    // Weekly with no days aborts.
    const run = makeHarness();
    await run.handles.edit('task1');
    run.dom.elements['p-cycle'].value = 'weekly';
    await run.handles.save();
    check(run.apiCalls.length === 0, 'weekly with no days aborts before API call');
    check(run.toasts.includes('Pick at least one day.'), 'weekly with no days shows the expected toast');
  }

  {
    // Existing one-off due is prefilled; clearing it sends null.
    const run = makeHarness({
      state: {
        tasks: [
          { id: 'task1', title: 'Clean room', points: 6, cycle: 'oneoff', kidId: 'toby', dueBy: '2026-08-24T10:00:00.000Z' },
        ],
        windows: [{ id: 'evening', label: 'Evening', closesAt: '21:00' }],
        fallbackWindowId: 'evening',
        people: [
          { id: 'peter', role: 'parent', name: 'Peter' },
          { id: 'toby', role: 'kid', name: 'Toby' },
        ],
      },
    });
    await run.handles.edit('task1');
    check(run.dom.elements['p-due'].value !== '', 'existing one-off due date is pre-filled');
    run.dom.elements['p-due'].value = '';
    await run.handles.save();
    check(run.apiCalls.length === 1 && run.apiCalls[0].dueBy === null, 'blank one-off due date clears dueBy');
  }

  {
    // Cancel leaves edit mode quietly, no API call.
    const run = makeHarness();
    await run.handles.edit('task1');
    run.handles.cancel();
    check(run.apiCalls.length === 0, 'cancelling an edit never calls the API');
    check(run.handles.editId() === null, 'cancelling leaves edit mode');
    check(run.toasts.length === 0, 'cancelling exits quietly');
  }

  {
    // Missing task aborts without entering edit mode.
    const run = makeHarness();
    await run.handles.edit('missing');
    check(run.toasts.includes('Task not found.'), 'missing task shows the not-found toast');
    check(run.handles.editId() === null, 'missing task never enters edit mode');
  }

  {
    // A failed save keeps the edit open so nothing typed is lost.
    const run = makeHarness({ apiResult: { ok: false, error: 'nope' } });
    await run.handles.edit('task1');
    run.dom.elements['p-title'].value = 'Feed the cat';
    await run.handles.save();
    check(run.toasts.includes('nope'), 'a failed save surfaces the API error');
    check(run.handles.editId() === 'task1', 'a failed save keeps the edit open');
  }
}

// ---------------------------------------------------------------------------
// Avatars must never reach the screen as their raw stored value.
//
// A person's avatar can be an emoji character OR the string "svg:<key>". When
// #88 introduced the second form it converted only the two render sites its
// acceptance criteria named, so every other place printed "svg:3d-printer Toby"
// at the user. Tests passed; the app was wrong. These checks close that gap.
// ---------------------------------------------------------------------------
{
  const svgKeys = [...html.matchAll(/^\s*'([a-z0-9-]+)':\s*function\s*\(color\)/gm)].map((m) => m[1]);
  const fallbackBlock = (html.match(/var SVG_AVATAR_FALLBACK = \{[\s\S]*?\};/) || [''])[0];

  check(svgKeys.length > 0, `built-in SVG avatars found (${svgKeys.length})`);
  check(/function avatarText\(value\)/.test(html), 'avatarText() text stand-in exists');

  const missing = svgKeys.filter((k) => !fallbackBlock.includes(`'${k}'`));
  check(
    missing.length === 0,
    `every SVG avatar has a text fallback${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`
  );

  // A person's .emoji may only be read inside one of the renderers. Anything
  // else concatenates the raw value into the UI.
  // True when index `at` sits inside the argument list of a call to one of the
  // renderers. Walks paren depth, so a nested call in an earlier argument -
  // setAvatar(document.getElementById('x'), kid.emoji, c) - does not fool it.
  function insideRendererCall(line, at) {
    for (const call of line.matchAll(/\b(?:avatarText|renderAvatarHtml|setAvatar)\(/g)) {
      const open = call.index + call[0].length - 1;
      if (open > at) continue;
      let depth = 0;
      for (let i = open; i < line.length; i += 1) {
        if (line[i] === '(') depth += 1;
        else if (line[i] === ')') {
          depth -= 1;
          if (depth === 0) { if (at > open && at < i) return true; break; }
        }
      }
      if (depth > 0 && at > open) return true;  // call continues onto the next line
    }
    return false;
  }

  const raw = [];
  html.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\.emoji\b/g)) {
      if (m[1] === 'lvl' || m[1] === 'next') continue;   // level badges, not avatars
      if (insideRendererCall(line, m.index)) continue;
      raw.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
    }
  });
  check(
    raw.length === 0,
    `no avatar rendered as its raw stored value${raw.length ? `\n       ${raw.join('\n       ')}` : ''}`
  );
}

check(/<\/html>\s*$/i.test(html.trim() + '\n') || /<\/html>/i.test(html), 'closing </html> present');

(async function main() {
  await runParentEditTaskChecks();
  if (failures) {
    console.error(`\n${failures} frontend check(s) failed`);
    process.exit(1);
  }
  console.log('\nfrontend checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
