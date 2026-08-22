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

const parentTabButtons = html.match(/id="p-tabbtn-(approvals|tasks|rewards|settings)"/g) || [];
check(parentTabButtons.length === 4, `parent HQ exposes 4 tab buttons (${parentTabButtons.length} found)`);
check(/let parentTab = 'approvals';/.test(html), 'parent tab state defaults to approvals');
check(/function switchParentTab\(tab\)/.test(html), 'parent tab switcher exists');
check(/id="p-approvals-badge"/.test(html), 'approvals badge exists');

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

check(/<\/html>\s*$/i.test(html.trim() + '\n') || /<\/html>/i.test(html), 'closing </html> present');

if (failures) {
  console.error(`\n${failures} frontend check(s) failed`);
  process.exit(1);
}
console.log('\nfrontend checks passed');
