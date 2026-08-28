// Prints what the LIVE app holds for a date range: calendar items and pending
// proposals. Runs from a GitHub runner because the dev container's egress
// policy cannot reach azurewebsites.net, so this is the only way to see the
// app's actual state rather than infer it from a failing test.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const DAYS = Number(process.env.DAYS) || 7;

const post = async (body) => {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};

const start = new Date();
start.setDate(start.getDate() - 1);
start.setHours(0, 0, 0, 0);
const end = new Date();
end.setDate(end.getDate() + DAYS);
end.setHours(23, 59, 59, 999);

console.log(`=== CALENDAR ${start.toISOString()} -> ${end.toISOString()} ===`);
const cal = await post({
  action: 'calendar', parentId: 'peter', parentPin: PIN,
  start: start.toISOString(), end: end.toISOString(),
});
if (!cal.ok) {
  console.log('calendar failed:', JSON.stringify(cal));
} else {
  for (const item of cal.items || []) {
    const when = item.startAt || item.occurrenceAt || '';
    console.log([
      when.slice(0, 16),
      item.kind,
      JSON.stringify(item.title),
      'person=' + (item.personId === undefined ? item.kidId : item.personId),
      'source=' + (item.source || 'manual'),
      'active=' + (item.active === undefined ? 'n/a' : item.active),
    ].join('  '));
  }
  console.log(`(${(cal.items || []).length} items)`);
}

console.log('\n=== PENDING PROPOSALS ===');
const state = await post({ action: 'state' });
for (const p of state.proposals || []) {
  console.log([
    String(p.startAt || '').slice(0, 16),
    p.classification,
    JSON.stringify(p.title),
    'person=' + p.personId,
  ].join('  '));
}
console.log(`(${(state.proposals || []).length} pending)`);
