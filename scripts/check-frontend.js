// Minimal smoke check for frontend/index.html: it is a single hand-written
// file with no build step, so a stray unclosed tag or a syntax error in an
// inline script would ship straight to the kids' devices. This catches the
// obvious cases without pulling in a parser dependency.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'frontend', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let failures = 0;

function check(ok, message) {
  if (ok) {
    console.log('  ok   ' + message);
  } else {
    console.error('  FAIL ' + message);
    failures += 1;
  }
}

const opens = (html.match(/<script\b/g) || []).length;
const closes = (html.match(/<\/script>/g) || []).length;
check(opens === closes, `script tags balanced (${opens} open, ${closes} close)`);
check(opens > 0, 'at least one inline script block found');

const parentTabButtons = html.match(/id="p-tabbtn-(approvals|tasks|rewards|calendar|settings)"/g) || [];
check(parentTabButtons.length === 5, `parent HQ exposes 5 tab buttons (${parentTabButtons.length} found)`);
check(/let parentTab = 'approvals';/.test(html), 'parent tab state defaults to approvals');
check(/function switchParentTab\(tab\)/.test(html), 'parent tab switcher exists');
check(/id="p-tab-calendar"/.test(html), 'parent calendar tab panel exists');
check(/\['approvals', 'tasks', 'rewards', 'calendar', 'settings'\]/.test(html), 'parent tab switcher includes calendar');
check(/function switchParentCalendarView\(view\)/.test(html), 'parent calendar view switcher exists');
check(/action:\s*'addPlanningItem'/.test(html), 'parent calendar form calls addPlanningItem');
check(/action:\s*'updatePlanningItem'/.test(html), 'parent calendar edit calls updatePlanningItem');
check(/action:\s*'deletePlanningItem'/.test(html), 'parent calendar delete calls deletePlanningItem');
check(/id="p-approvals-badge"/.test(html), 'approvals badge exists');
check(/parentEditTask\(\\'/.test(html), 'task rows wire an Edit button');
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
  const signature = `async function ${name}(`;
  const start = html.indexOf(signature);
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
  const source = extractFunctionSource('parentEditTask');
  check(Boolean(source), 'parentEditTask exists');
  if (!source) return;

  const factory = new Function(
    'state',
    'session',
    'prompt',
    'toast',
    'kidsOnly',
    'api',
    'toastApiError',
    source.replace(/^async function parentEditTask/, 'return async function')
  );

  async function exercise(prompts, options) {
    const promptQueue = prompts.slice();
    const promptCalls = [];
    const toasts = [];
    const apiCalls = [];
    const state = options && options.state ? options.state : {
      tasks: [
        { id: 'task1', title: 'Feed the dog', points: 5, cycle: 'daily', kidId: 'toby', dueBy: null },
      ],
      people: [
        { id: 'peter', role: 'parent', name: 'Peter', emoji: '🧔' },
        { id: 'toby', role: 'kid', name: 'Toby', emoji: '🐾' },
        { id: 'ollie', role: 'kid', name: 'Ollie', emoji: '🖨️' },
      ],
    };
    const taskId = options && options.taskId ? options.taskId : 'task1';
    const apiResult = options && Object.prototype.hasOwnProperty.call(options, 'apiResult')
      ? options.apiResult
      : { ok: true };
    const prompt = (message, defaultValue) => {
      promptCalls.push({ message, defaultValue });
      return promptQueue.length ? promptQueue.shift() : null;
    };
    const toast = (message) => {
      toasts.push(message);
    };
    const api = async (payload) => {
      apiCalls.push(payload);
      return apiResult;
    };
    const toastApiError = (result) => {
      if (result && result.ok === false) {
        toast(result.error || 'Something went wrong.');
        return true;
      }
      return false;
    };
    const parentEditTask = factory(
      state,
      { personId: 'peter', pin: '1234' },
      prompt,
      toast,
      () => state.people.filter((person) => person.role === 'kid'),
      api,
      toastApiError
    );
    await parentEditTask(taskId);
    return { promptCalls, toasts, apiCalls };
  }

  {
    const run = await exercise(['Feed the cat', '8', '3', '2', '2026-08-25T18:00']);
    check(run.apiCalls.length === 1, 'parentEditTask submits a successful edit once');
    if (run.apiCalls.length === 1) {
      const payload = run.apiCalls[0];
      check(payload.action === 'updateTask', 'parentEditTask calls updateTask');
      check(payload.title === 'Feed the cat', 'parentEditTask trims and sends title');
      check(payload.points === 8, 'parentEditTask sends parsed integer points');
      check(payload.cycle === 'oneoff', 'parentEditTask maps cycle choice to oneoff');
      check(payload.kidId === 'ollie', 'parentEditTask reassigns to the chosen kid');
      check(payload.dueBy === new Date('2026-08-25T18:00').toISOString(), 'parentEditTask converts dueBy to ISO');
    }
    check(run.promptCalls[2] && run.promptCalls[2].defaultValue === '1', 'cycle prompt defaults to the current cycle number');
    check(run.promptCalls[3] && run.promptCalls[3].defaultValue === '1', 'kid prompt defaults to the current kid number');
    check(run.promptCalls[4] && run.promptCalls[4].defaultValue === '', 'new one-off due prompt starts blank when the task had no due date');
    check(run.toasts.includes('Task updated! ✏️'), 'parentEditTask toasts success after a clean update');
  }

  {
    const run = await exercise(['   ']);
    check(run.apiCalls.length === 0, 'blank edited task title aborts before API call');
    check(run.toasts.includes('Type or speak a task first!'), 'blank edited task title reuses add-task validation copy');
  }

  {
    const run = await exercise(['Feed the cat', '0']);
    check(run.apiCalls.length === 0, 'invalid task points abort before API call');
    check(run.toasts.includes('Points must be a positive integer.'), 'invalid task points show the expected toast');
  }

  {
    const run = await exercise(['Feed the cat', '8', '9']);
    check(run.apiCalls.length === 0, 'invalid cycle choice aborts before API call');
    check(run.toasts.includes('Choose 1, 2, or 3 for how often.'), 'invalid cycle choice shows the expected toast');
  }

  {
    const run = await exercise(['Feed the cat', '8', '1', '9']);
    check(run.apiCalls.length === 0, 'invalid kid choice aborts before API call');
    check(run.toasts.includes('Choose a valid kid number.'), 'invalid kid choice shows the expected toast');
  }

  {
    const run = await exercise(['Feed the room', '4', '3', '1', ''], {
      state: {
        tasks: [
          { id: 'task1', title: 'Clean room', points: 6, cycle: 'oneoff', kidId: 'toby', dueBy: '2026-08-24T10:00:00.000Z' },
        ],
        people: [
          { id: 'peter', role: 'parent', name: 'Peter', emoji: '🧔' },
          { id: 'toby', role: 'kid', name: 'Toby', emoji: '🐾' },
          { id: 'ollie', role: 'kid', name: 'Ollie', emoji: '🖨️' },
        ],
      },
    });
    check(run.apiCalls.length === 1 && run.apiCalls[0].dueBy === null, 'blank one-off due date clears dueBy');
    check(run.promptCalls[4] && run.promptCalls[4].defaultValue === '2026-08-24T10:00:00.000Z', 'existing one-off due date is pre-filled');
  }

  {
    const run = await exercise([null]);
    check(run.apiCalls.length === 0, 'cancelling the first prompt aborts without calling the API');
    check(run.toasts.length === 0, 'cancelling the first prompt exits quietly');
  }

  {
    const run = await exercise([], { taskId: 'missing' });
    check(run.apiCalls.length === 0, 'missing task aborts before API call');
    check(run.toasts.includes('Task not found.'), 'missing task shows the not-found toast');
  }
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
