# Design system

The visual language of the app. **These are the actual values to use** — not
suggestions, not a starting point. Every screen is built from this set.

Why it is written down rather than left to judgement: the frontend is one file
that the whole backlog edits, and "make it feel premium" is an adjective, not a
specification. An agent implements a defined thing well and invents a design
poorly. This turns the work into implementation.

`scripts/check-design.js` enforces the mechanical half of this in CI (see
[`pipeline.md`](pipeline.md)). It cannot judge taste — that is what the
component specs below are for.

**How this reaches work that has not been written yet.** Three routes, so it
survives issues added long after this was written:

1. The **Elaborator** reads this file on every run and must ground frontend
   acceptance criteria in it, so specs cite real tokens rather than adjectives.
2. **`.github/copilot-instructions.md`** points here, and Copilot reads that on
   every task in this repository — including issues that skip elaboration
   entirely. It points rather than restates, deliberately: a summary kept in two
   places drifts, and this file is the one that should win.
3. **`check-design.js`** fails the build on raw values, external asset requests
   and content added outside the view structure, whatever route the code took.

The first two guide; only the third can stop a merge.

---

## Principles

1. **Consistency reads as quality.** A confident, repeated set of choices looks
   more expensive than a novel choice on every screen. When in doubt, reuse.
2. **Playful for kids, calm for parents.** Same tokens, different register. The
   kid views are generous and rewarding; Parent HQ is quiet and efficient. A
   parent screen covered in confetti reads as unserious.
3. **Reward the moment.** Completing a chore and earning points are the emotional
   core of the app. They get motion, colour and celebration. Nothing else does.
4. **Motion is fast or it is annoying.** Nothing decorative runs longer than
   380ms. All of it is skipped under `prefers-reduced-motion`.

---

## Tokens

All defined once, in a single `:root` block. Nothing below appears as a literal
value anywhere else in the stylesheet.

### Colour

```css
/* Surfaces — warm off-white, never pure white. Pure white on a phone at night
   is harsh, and the warmth is most of what reads as "designed". */
--bg:             #f7f5ff;
--surface:        #ffffff;
--surface-sunken: #efebfa;
--border:         #e4dff5;

/* Ink — near-black, never #000. Pure black on white is a harsh, cheap contrast. */
--ink:        #1c1830;
--ink-muted:  #6b6580;
--ink-subtle: #9a94ad;

/* Brand */
--brand:       #6d3bf5;
--brand-hover: #5c2fe0;
--brand-wash:  #ede7ff;
--on-brand:    #ffffff;

/* Status */
--success:      #12a06a;
--success-wash: #dff5eb;
--warning:      #e8890c;
--warning-wash: #fdf0dc;
--danger:       #d93a4a;
--danger-wash:  #fce4e6;

/* Per-kid identity. Each kid keeps their colour on every screen — avatar ring,
   card accent, progress fill — so the app feels like it knows them. Assign by
   stable order of the people list, not at random. */
--kid-1: #0ea5a5;  /* teal */
--kid-2: #f0873a;  /* amber */
--kid-3: #d356a8;  /* pink */
--kid-4: #3b82f6;  /* blue */
```

### Type

```css
--font: ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI Variable Display",
        system-ui, -apple-system, sans-serif;

--text-xs:   0.75rem;   /* 12px — timestamps, meta only */
--text-sm:   0.875rem;  /* 14px — secondary text */
--text-base: 1rem;      /* 16px — body. Never smaller for anything a kid reads */
--text-lg:   1.125rem;  /* 18px — card titles */
--text-xl:   1.5rem;    /* 24px — screen titles */
--text-2xl:  2rem;      /* 32px — section heroes */
--text-3xl:  2.75rem;   /* 44px — points, the big number */

--weight-normal: 450;
--weight-medium: 600;
--weight-bold:   750;

--leading-tight: 1.15;  /* headings and big numbers */
--leading-base:  1.45;  /* body */
```

A rounded face is the single biggest lever on "kids app" versus "web form".
`ui-rounded` gets SF Pro Rounded free on iOS, which is where the kids will use
it. **No web font downloads** — no build step, and it must work offline.

### Spacing

4px base. Only these values.

```css
--space-1: 0.25rem;  /*  4px */
--space-2: 0.5rem;   /*  8px */
--space-3: 0.75rem;  /* 12px */
--space-4: 1rem;     /* 16px */
--space-5: 1.5rem;   /* 24px */
--space-6: 2rem;     /* 32px */
--space-7: 3rem;     /* 48px */
```

Generosity is most of what separates premium from cramped. When unsure, go one
step larger.

### Radius

```css
--radius-sm:   0.5rem;   /*  8px — chips, small controls */
--radius-md:   0.875rem; /* 14px — inputs, small cards */
--radius-lg:   1.375rem; /* 22px — cards, sheets */
--radius-full: 999px;    /* buttons, avatars, pills */
```

Generous radii read friendly. Fully-rounded primary buttons are a deliberate
choice — it is what separates a kids app from an admin panel.

### Elevation

Layering, not outlines. A card should feel like an object sitting on the
background, not a rectangle drawn on it.

```css
--shadow-1: 0 1px 2px rgba(28,24,48,.05), 0 2px 6px rgba(28,24,48,.07);
--shadow-2: 0 4px 12px rgba(28,24,48,.10);
--shadow-3: 0 12px 28px rgba(28,24,48,.16);
```

`--shadow-1` for resting cards, `--shadow-2` for the tab bar and anything
floating, `--shadow-3` for modals. Never a shadow on a long scrolling list —
it costs paint time on cheap Android.

### Motion

```css
--dur-fast: 120ms;  /* press states, tap feedback */
--dur-base: 220ms;  /* view transitions, card entry */
--dur-slow: 380ms;  /* celebrations */

--ease-out:    cubic-bezier(0.22, 1, 0.36, 1);      /* almost everything */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);   /* celebration only — overshoots */
```

Animate `transform` and `opacity` only. Anything else causes layout work on
every frame and stutters on a cheap phone.

Every decorative animation sits behind:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Components

### App shell

- `body { overflow: hidden }`. The page never scrolls — a `<main>` region does,
  with `overscroll-behavior: contain`.
- Header: fixed, `--surface`, `--shadow-1` only once content scrolls beneath it.
  Respects `env(safe-area-inset-top)`.
- Tab bar: fixed bottom, `--surface`, `--shadow-2`, height `4rem` plus
  `env(safe-area-inset-bottom)`. Icon above a `--text-xs` label. Active tab in
  `--brand`, inactive in `--ink-subtle`.
- View transition: the outgoing view fades to 0 and the incoming fades in with
  `translateY(8px) → 0`, `--dur-base`, `--ease-out`.

### Pull to refresh

Both scroll areas (`.kid-main`, `.parent-main`) carry the app's own
pull-to-refresh (`attachPullToRefresh`): the pinned shell suppresses the
browser's native one, so a `.ptr-pill` (surface, `--shadow-2`, 🔄) follows a
damped pull from the top and a release past ~70px runs `refresh()`. Touch
events only — desktop has reload — with a guarded `preventDefault` that
fires only mid-pull from the top, so scrolling is untouched and older iOS
without `overscroll-behavior` support still behaves. Transform/opacity only.

### Cards

`--surface`, `--radius-lg`, `--shadow-1`, padding `--space-4`, gap `--space-3`
between cards. A kid's card carries a 4px left accent bar or an avatar ring in
their `--kid-*` colour.

### Buttons

- Primary: `--brand` fill, `--on-brand` text, `--radius-full`, min-height
  `3.25rem`, `--weight-medium`, `--text-base`.
- Secondary: `--brand-wash` fill, `--brand` text, same geometry.
- Destructive: `--danger-wash` fill, `--danger` text.
- Every button: `touch-action: manipulation` (kills the 300ms tap delay) and a
  pressed state of `transform: scale(0.97)` over `--dur-fast`. **Every tap gets
  a response before the network does.**
- Minimum target 44px in every direction, including icon-only buttons.

### The points number

`--text-3xl`, `--weight-bold`, `font-variant-numeric: tabular-nums` so it does
not jitter while counting. When points change it **counts up** over `--dur-slow`
rather than snapping. This is the single most rewarding moment in the app for a
kid — it is worth the code.

### Progress

Rings or bars filled in the kid's colour, with the number inside or beside it.
Never a bare number where progress toward something is the point. Kids respond
to a visibly filling shape far more than to a figure.

### Completing a chore

The moment that has to feel good:

1. Instant press feedback (`scale(0.97)`).
2. **Optimistic update** — the card moves to its done state immediately, before
   the API responds, and reverts with a message if the call fails. Waiting on a
   round trip is the single biggest "this is a website" tell.
3. The card animates out: `translateX(12px)` and fade, `--dur-base`.
4. Points count up.
5. `navigator.vibrate(12)` where supported, unless the household is in quiet
   hours or has muted feedback.

### Empty states

Never a blank area or a bare sentence. A large emoji or inline SVG, a
`--text-lg` line in `--ink`, a `--text-sm` line in `--ink-muted` saying what to
do next. "No chores today 🎉" should read as good news, because it is.

### Loading

Skeleton blocks in `--surface-sunken` at the final layout's dimensions. Never a
spinner on a full screen, and never a blank flash followed by content jumping in.

---

### Avatars

Three kinds, resolved by prefix on `person.emoji`:

| Value | Renders as |
|---|---|
| `img:<key>` | A photo from `frontend/img/`, via `IMG_AVATARS` |
| `svg:<key>` | An inline SVG tinted with the kid's colour, via `SVG_AVATARS` |
| anything else | The string itself, i.e. an emoji |

Photo avatars ship **two crops per kid**, not one scaled down: `tile` is
chest-up for the person picker, `head` is tighter on the face because at ~40px
a chest-up shot is an unreadable smudge. `renderAvatarHtml()` defaults to
`tile`, `setAvatar()` defaults to `head`; pass the other explicitly.

**The head crop is a face, not the badge shrunk.** Toby's and Ollie's were cut
as the whole ringed circle fitted into the square, which at 40px is a small
face inside a coloured border — and Ollie's put him off-centre with the
cockatoo taking half the frame. Crop tight on the face, same framing for
everyone, so a row of four reads as four people rather than four different
zoom levels. This cannot be fixed downstream: CSS can only scale what the file
already contains.

Every kind also needs a `fallback` emoji. Plenty of places can only hold text —
`<option>` labels, prompt lists, the parent kid-mark — and an avatar that
renders as nothing there is worse than an emoji.

`.avatar-photo` fills whatever round or rounded slot it is dropped into
(`width/height: 100%`, `object-fit: cover`, `border-radius: inherit`), so the
same markup works at 2.5rem in the header and 4.5rem on a tile.

**A person is their photo, everywhere.** Parent HQ was headed by a crown, which
said "a parent" when the header can say *which* parent. Everyone else in the app
is already represented by their own face; a role badge beside four photos reads
as a different kind of thing.

**Changing an avatar needs a migration.** `ensureSeeded()` only creates records
when the household does not exist, so editing `SEED_PEOPLE` changes nothing for
a household created weeks ago. `AVATAR_MIGRATIONS` is the only thing that moves
an existing record — this is the #88 trap, and it has now caught us twice.

**Replacing the photo behind an existing key needs a `?v=` bump.** Swapping the
bytes of, say, `avatar-tymanda.webp` keeps the filename, so a phone that already
holds the old face can go on serving it from the HTTP cache long after the
deploy — the service worker is network-first, but the network fetch itself hits
that cache. Each entry in `IMG_AVATARS` therefore carries its own `?v=N`; raise
the number on the files you changed. The versions are written out per line
rather than shared through a constant because `check-frontend.js` lifts
`IMG_AVATARS` into a sandbox on its own, and a constant declared outside it is
not in scope there.

### Windows — when a chore is due

**Do it, submit it inside the window, get it approved — points. Window closes
with nothing submitted — no points, marked a miss.** That is the household's
whole mechanic, settled deliberately, including the hard part: **there is no
late award and no parent override.** A door that always reopens is not a
deadline.

Three named windows for the whole household, not a clock per chore:

| Window | Closes |
|---|---|
| Morning | 08:30 |
| After school | 18:00 |
| Evening | 21:00 |

Defaults live in `DEFAULT_WINDOWS` in `hero.js`, overridable per household via
a `windows` array on the household record — in code rather than the seed,
because `ensureSeeded()` never touches an existing household (the #88 trap).
A chore with no `windowId` is held to the **evening** window, not exempted: an
undated chore has always meant "some time today", and the last window of the
day is the honest reading of that.

Rules that must not drift:

- **The server is the only clock.** `state.windows[].closed` is computed
  API-side and the frontend renders it; `completeTask` refuses a shut window
  with `windowClosed: true`. The browser never computes shutness from its own
  clock — a phone in the wrong timezone would show a different truth than the
  API acts on.
- **A miss stays on screen.** The row greys, says why, strikes the points —
  it does not vanish. A miss that disappears overnight teaches nothing.
- **One-offs are separate.** They carry their own `dueBy` and overdue display;
  folding the two mechanisms together is a decision, not a default.
- **Tests pin the clock.** "Now" is part of behaviour, so `test-logic.js` and
  the smoke server pin `HOUSEHOLD_TIMEZONE` to a fixed-offset zone where local
  time is ~noon — morning has always shut, evening is always open, whatever
  hour CI runs. A window of `closesAt: '00:00'` is shut at every moment of the
  day, which is the deterministic way to test refusal.

### Misses — the record that points were not earned

A miss is **a fact, not a punishment**. When a window shuts with nothing
submitted, the 15-minute sweep writes a `status: 'missed'` row into the
completions container — the forfeited points named on it for display, counted
by nothing. Balances only ever sum `approved` rows; that invariant is tested.

Mechanics that must hold:

- **Idempotency is the record's own id**: `miss-<taskId>-<date>`. A second
  sweep gets the 409 and moves on. This survives restarts, which a
  "have I run today" flag would not. The in-memory test mocks refuse duplicate
  ids for the same reason real Cosmos does — a mock more forgiving than
  production would let this test pass while the mechanism was broken.
- **Submitting in time — any status — keeps a chore off the miss list.**
  Pending and even rejected completions count as "the kid acted".
- **A weekly chore is only missable on the days it is due.**
- **One-offs are excluded** — `dueBy` overdue display is its own mechanism.

Where a miss shows: the kid's calendar (⛔, struck through, its own
`.calendar-event.missed` class — same visual family as rejected, but a miss is
nobody refusing anything), and Recent activity, worded as a fact with the
points that were on the table: *"Missed — the window closed. 6 pts were up for
grabs."*

### The family view

Parent HQ's Approvals tab is decisions plus today's state, in this order:
the stat tiles, what's waiting on you, reward requests, **Today by kid**
(with a View calendar action), recently decided. There is deliberately no
Yesterday and no This-week section here — the Calendar tab owns the wider
view, and a day's agenda is one tap on it.

- **Today by kid** counts misses as their own pill (`.pill.bad`, "2 missed")
  alongside pending, and "All caught up" only appears when there are neither.
  A row whose window shut on it is tagged **Missed** (`.tag.missed`), not
  "Not started" — which would understate a door that has already closed.
  Misses still reach the parent here and in the evening summary push; the
  per-day history lives on the Calendar tab.

Smoke-testing note: the suite's store is shared across the whole run, so a
test that seeds chores for a kid must retire them (`deleteTask`) before
finishing if a later test's premise is "this kid has nothing on". This has
now bitten twice; clean up seeded chores as part of the test that made them.

### Prep lists — packed the night before, worth points

The soccer case: Ollie plays Sunday morning, so **being ready by Saturday
night is the thing rewarded** — not attending. The rules, all settled:

- **The list carries the points; the event carries none.** `prepLists`
  entries hold `points`, settable from the parent calendar checklist ("Set
  pts"). `planningUpdatePayload` round-trips them — dropping the field there
  would silently zero a list's reward on every unrelated edit.
- **The deadline is the last window's close on the day before the event**
  (`prepDeadlinePassed`), with an optional per-event `prepDueBy` ISO override
  winning when set. After it: ticking and confirming are refused with
  `windowClosed: true`, and the sweep records `prep-miss-<itemId>-<kidId>`.
- **Prep opens on the day it is due** (`prepNotYetOpen`): Thursday's "uniform
  on" is a Thursday action, not a Tuesday tick. Before the due day, ticking
  and confirming are refused with `notOpenYet: true`, and the kid card
  renders the checklist locked under a neutral "🔒 Opens Thu · by 5:30pm"
  chip. The deadline stays the only knob — set it earlier and the open day
  moves with it.
- **A kid ticks only their own list** — `tickPrepItem` is `requireSelf` plus
  a personId match; the parent-only `updatePlanningItem` remains the only way
  to touch anyone else's.
- **Confirming creates an ordinary pending completion**
  (`prep-<itemId>-<kidId>`, deterministic so a double-tap cannot double the
  reward) titled "Packed for <event>" and worth the list's points — the
  parent's existing approval flow needs nothing new.
- The kid's Home glance renders the checklist with live ticks and a Packed
  button that unlocks only when everything is ticked. (The original render
  looked the list up as `prepLists[kidId]` when it is an array of
  `{personId, items}` — that 🎒 line had never once run.)

### Repeating events

`recurrence: 'weekly'` on an event (only events - reminders clear it). One
document, expanded into occurrences by `calendar()` exactly as a weekly chore
is; the event's own `startAt` anchors the weekday and time, and `prepDueBy`
shifts week by week with the occurrence. Deleting the item deletes the series.

The week-two behaviour is the design:

- **Each week earns separately.** Prep completion and miss ids carry the
  occurrence date (`prep-<itemId>-<date>-<kid>`), so confirming this Monday
  never pre-pays next Monday, and an unconfirmed week misses on its own.
- **Ticks belong to one occurrence.** `list.tickedFor` records which; the
  first tick of a new week wipes last week's flags before it lands, else
  Cubs arrives pre-packed every Monday after the first. `tickedFor` is
  round-tripped through both `planningUpdatePayload` and
  `validatePrepLists` - dropping it on either side hands the new week stale
  ticks.
- **Only one occurrence is prep-live.** `calendar()` stamps every occurrence
  with `prepOpenDate` (the current occurrence's date); the kid's glance
  renders any other week's list read-only.

Known limit: conflict detection still checks the base occurrence only.

### Nudges and the evening summary

Two messages a day, maximum, per person - the design is a digest, not a
stream:

- **The kid gets one "closing soon"** per chore per day, 30 minutes before its
  window shuts: *"Feed the dog closes at 21:00 — 5 pts."* The last moment the
  information can still change the outcome; after the close it is
  `recordMisses`' job, not a notification's. Once-per-day is marked as
  `nudgedOn` on the chore doc, the same shape as the one-off
  `lastReminderSentAt` marker.
- **The parents get one "Today at home"** when the last window has shut:
  *"Toby: 3 of 4 done, 1 missed · Ollie: all 2 done ✅."* Idempotent via
  `summarySentOn` on the household doc, and the tick order matters:
  `recordMisses` runs before `sendEveningSummary` in the timer, so the
  summary counts the misses the same tick records.

Two deliberate wrinkles:

- **The summary bypasses quiet hours.** The evening window closes at 21:00;
  a household with quiet hours from 21:00 would otherwise never receive the
  one message this feature exists to send. It fires once a day and goes to
  the adults - different in kind from pinging a kid's tablet at night. Kid
  nudges respect quiet hours as normal.
- **Mark first, then send.** The summary flags `summarySentOn` before
  pushing. If the sends fail, the day's summary is lost rather than repeated
  on every later tick - for a daily digest, silence is the better failure
  than a stutter of duplicates.

Testing note: "now" is behaviour, so the tests build instants with a helper
that returns a Date whose *local wall-clock time in the pinned harness zone*
is the one named (`at('20:40')`) - never by formatting "now" the way the code
does.

### How often a chore repeats

Three options, and the middle one is the interesting one:

| Choice | Stored as | Falls on |
|---|---|---|
| Every day | `cycle: 'daily'` | every day |
| Certain days | `cycle: 'weekly'` + `days: [1,3,5]` | those weekdays, `0`=Sunday |
| One-off | `cycle: 'oneoff'` + `dueBy` | that datetime |

"Certain days" used to be "Once a week", and it silently meant *whichever
weekday the chore happened to be created on* — real recurrence, but nobody
could see or choose the day, so a chore that belongs on Mon/Wed/Fri had no way
to be expressed.

- **Absent `days` still means the creation day.** Chores written before the
  chooser existed keep landing where they always have, so there is no migration
  and nothing silently moves.
- **`days` is cleared when the cycle changes**, exactly like `dueBy`. A task
  switched to Every day and back must not quietly keep weekdays it had two
  edits ago.
- **A completion counts for its own day.** Matching by week is what "once a
  week" needed; with named days it would mark Wednesday done because Monday
  was. `cycleCompletion()` and `parentCalendarLiveCompletion()` both branch on
  whether the chore names days.
- **Name the days wherever the chore is listed.** "weekly" is equally true of
  Mon/Wed/Fri and of Sundays only, which makes it the least useful thing a row
  could say. `daysLabel()` gives "Mon, Wed & Fri".
- Chips, not a multi-select: seven options that are always the same seven read
  faster as a row you tap.

### Dates and times are the family's, not UTC

**Everything the app calls "today", or "9pm", means local time in
`HOUSEHOLD_TZ`** (`Australia/Perth`, overridable with `HOUSEHOLD_TIMEZONE`).
Use `todayStr()` and `localMinutes()` in `hero.js`; never `getUTCHours()` or
`new Date().toISOString().slice(0, 10)` for anything a person will read as a
day or a time.

This was wrong for a long time and the failure was invisible for sixteen hours
out of every twenty-four:

- The frontend already used **browser-local** dates. The API used **UTC**. For
  the eight hours between local midnight and 8am Perth the two disagreed about
  what day it was, so a chore ticked before school was stored against
  yesterday and then rendered as still outstanding.
- Quiet hours set to `21:00–07:00` were applied in UTC, which in Perth is
  **05:00–15:00** — silent through the school day, wide open at 2am.

The conversion goes through `Intl.DateTimeFormat` with an explicit `timeZone`,
which handles DST anywhere without a dependency. Two details worth keeping:
`en-CA` is used because it formats as `YYYY-MM-DD`, the shape every date in
this codebase already has; and the time formatter uses `hourCycle: 'h23'`
rather than `hour12: false`, because the latter renders midnight as `24` on
some ICU builds, putting it a full day out of range.

Note the test that broke when this was fixed: it built its quiet-hours window
from `getUTCHours()` and had only ever passed because the code read UTC too.
Two matching mistakes cancelling out is the failure mode to watch for here —
assert against a **fixed instant with a known local equivalent**, not against
"now" formatted the same way the code formats it.

### The sign-in screen

**The artwork is the screen.** Signing in happens on top of it; there is no
separate splash.

It took seven goes to get here, and the failures are the useful part:

1. Artwork as a band at the top of the picker, tiles on a solid sheet below —
   cut the picture in half to show four names.
2. A separate splash screen that held for a beat then vanished — the artwork got
   about two seconds and was then gone.
3. Artwork full-screen with the faces docked along the **bottom** — kept the
   picture whole, but sat them over the foreground.
4. Faces moved up into the **sky above the wordmark** — the artwork was
   untouched, but loose circles floating on a picture read as decoration, not as
   controls. Nothing anchored them and nothing said "this is the way in".
5. A **solid panel** docked to the bottom — anchored, but it anchors by
   covering: a fifth of the screen of flat white to hold four faces.
6. A **frosted glass bar** on the bottom edge — 11% of the screen instead of a
   fifth, but still a box. Flat fill, blur boundary and a hairline along the
   top: three separate edges for the eye to find.
7. This: a **gradient scrim** that fades out upwards. No edge at all, 10% of the
   screen, and the artwork runs unbroken to the bottom.

**The artwork is fitted, never cropped.** It is 720×1604 — 0.449 wide to tall,
which is *narrower than any real phone*: about 0.46 installed, 0.53–0.56 once
browser chrome eats the height. `cover` therefore scales it to the width and
pushes the surplus height off the bottom, and anchored `center top` the bottom
is all it ever takes — 3% on a tall installed phone, **20% on an iPhone SE**.
The bottom is the payload: the ball, the boots, the whole foreground. No
`cover` anchor survives that, because a picture with ~8% expendable sky above
and ~9% of ground below has nothing to give when a fifth has to go.

So `background-size: contain` at every ratio. The bars that leaves on a squarer
screen are filled by `#screen-who::before` — an over-scanned, blurred copy of
the artwork — so the picture's own colours carry to the edge instead of a slab
of flat brand purple. The blur is decoration; without it the fallback is the
brand colour, which is what shipped before.

- **What draws a box is an edge, not opacity.** Attempts 5 and 6 both came back
  as "takes up too much room" even though 6 was half the height and translucent.
  Lowering the opacity of a panel does not stop it being a panel: a flat fill, a
  blur boundary and a hairline top edge each give the eye a line to find. A
  gradient has none, so it reads as shading on the picture rather than a surface
  parked on it. Reach for less edge before less opacity.
- **What anchors is the rings, not the bar.** Attempt 4 failed because loose
  circles in the sky read as decoration — but the fix was a coloured ring on
  each face plus a row along the bottom edge, not the panel that came with it.
  Once the rings were there the panel was only paying for itself in contrast,
  and a scrim buys that more cheaply.
- **Dark, not light.** A white scrim over the foot of this artwork — boots and
  backpack in shadow — just turns grey. Dark tint with white labels keeps the
  colour underneath.
- **The names carry their own contrast.** With a thin scrim there is no plate
  behind them, so `text-shadow: var(--text-scrim)` does that work. Without it
  they break up over the bright patches at the foot of the picture.
- **Every person is the same kind of thing.** Same circle, same ring weight,
  same name. A parent on a dark disc beside a kid's photo read as two different
  categories rather than four ways into one app.
- **Fixed width per tile, never `flex-basis: auto`.** Sized from content, an
  emoji glyph is narrower than a photo — the circles come out different sizes
  and the names land on four different baselines.
- The prompt stays gone. Four faces in a bar are self-explanatory; the
  `Kid` / `Parent 👑` line stays gone too, at a third line each.

**Sizing by aspect ratio, not width.** The artwork is portrait, roughly 0.45
wide-to-tall. A phone is close enough that `cover` crops almost nothing. Past
`3/5` it is not: `cover` zooms into the middle of the logo and drops the sign-in
row on top of the wordmark. Wider than that, the whole picture is fitted with
`contain` and the brand colour flanks it — a smaller picture, but an intact one.

More people would shrink the row rather than wrap it. That is the right failure:
a second row starts eating the picture again.

### Calendar

One month, arrowed through. A **"this week" strip pinned above it**, and tapping
any day **expands its agenda inline underneath** — same screen, no mode to get
back out of. That is what Google Calendar, Apple Calendar and Cozi all do.

**Dots are coloured per person, never per activity type.** The kid colours are
already on their avatars, their rings and their cards, so a dot means something
before anyone reads a key. That is what removes the need for a legend — and a
legend is a thing to learn before the screen is useful.

- **One dot per person, not per item.** Five chores for one kid is one dot, and
  a day showing four dots really does involve four people. Capped at four.
- **Today is a ring, selection is a fill.** Both can be true of the same day and
  they must not look like the same thing.
- The week strip and the grid share a selection, so tapping in either highlights
  both.
- Tapping the open day closes it. A grid that can only be expanded is a grid
  that gets stuck expanded.
- **One fetch covers both** the grid and the strip: the range runs from the
  start of the grid's first week to the end of its last, widened if the strip
  has been walked outside the month. Two ranges would be two requests that could
  disagree about a day on the boundary.
- Day cells are `aspect-ratio: 1`, so the grid keeps its shape from a small
  phone to a wide window.

Use `isoDate(date)` for day keys, never `toISOString().slice(0, 10)` — that
converts to UTC first, so an evening east of Greenwich lands on tomorrow.

### Status pills, not paragraphs

**Appy, not wordy.** A status is a colour and two words. Never a sentence, and
never an explanation of what the absence of things means.

| | |
|---|---|
| `.pill.neutral` | a count — `2 chores`, `0 requests` |
| `.pill.good` | nothing needed — `All caught up` |
| `.pill.warn` | something waiting — `1 pending` |

`buildEmptyPill(text)` is the empty state for a parent section. The full
`buildEmptyState()` — emoji, headline, explanatory sentence — is four lines to
report zero, and Parent HQ says "nothing here" three times on one screen. Keep
the full version for kid screens, where an empty day should feel like good news
rather than a null.

Two rules this settled:

- **A filler subtitle is worse than no subtitle.** "Today's chores overview"
  under every kid's name repeated the section heading and cost a line per kid.
- **Where a person has a photo, use it.** An approval card drawing the emoji
  fallback directly above cards showing the real face reads as a bug.

### Swipeable card row

Used for the kid Home prize banner. Native CSS `scroll-snap`, never a carousel
library — touch, trackpad and keyboard all work for free and it degrades to a
plain horizontal scroller where snap is unsupported.

- Cards are exactly `100%` wide with **no gap**, so `scrollLeft / clientWidth`
  is the card index. Dots read that; keep it true or the maths stops working.
- Open on the card that matters (the prize being saved for), not card one.
- Guard re-centring behind a signature of what the row is showing. `render()`
  runs on every 60s poll; without the guard each one snaps the card back under
  a thumb mid-swipe.
- A card that leads somewhere is a `<button>`. A swipe ends with a finger on a
  card too, so ignore a click arriving within 250ms of the last scroll event.

### Bottom sheet

For quick-add flows (My List). `.modal-bg` centres; a sheet pins to the bottom
where a thumb is: `align-items: flex-end`, `--radius-lg` on the top corners
only, `--shadow-3`, and it slides up with `transform: translateY(100%) → 0`
under `prefers-reduced-motion: no-preference`.

Never `window.prompt()` — the browser's own dialog shows the deployment
hostname, which is how a kid ends up reading `salmon-river-0e879dc00…` in a
question about chores.

### Move controls

Up/down `▲▼` icon buttons, 44px targets, stacked in a `.move-controls` column.

Reordering is **organisation, not achievement**: no toast, no `celebrate()`, no
vibration. First-up and last-down are `disabled`, never an error toast.

### Notes on a decision

A grown-up's comment on an approve or decline, shown read-only on the kid's own
card. `--surface-sunken` with a 💬 for an approval; `--warning-wash` with a 🔧
for a decline, because that one is a thing to fix. It is a message about a
decision already made, not a thread — no reply affordance.

### Linking a row to where the action is

A row that summarises something actionable elsewhere becomes a `<button>` that
scrolls the real target into view and rings it (`.arriving`, a 1.6s
`box-shadow` pulse). Rows with nowhere to go stay inert `<div>`s — a row that
looks tappable and does nothing is worse than one that plainly is not.

---

## Responsive

Phone-first, and phone stays the primary case. But the app installs on desktops
too, and content with no maximum width stretched a task row to ~1900px to hold
thirty characters while type and padding stayed at phone scale.

**Breakpoints.** 360 (small phone), 430 (large phone), 768 (tablet), 1280
(laptop), 1920+ (wide). Check all five, on every tab, both roles.

**`--shell-max: 72rem`.** Content caps there and centres.

Two techniques, picked per element:

- Blocks sitting on the page background: `width: 100%`, `max-width`, and auto
  margins. If the block carries its own gutter, cap at
  `calc(var(--shell-max) + gutter * 2)` or its content sits inset from the
  header's by exactly that gutter.
  **`width: 100%` is load-bearing.** On a flex item, auto cross-axis margins
  override `align-self: stretch`, so `max-width` + auto margins alone collapses
  it to its content width — that is how the person picker ended up 273px wide on
  a 412px phone.
- Full-bleed bars (headers, nav, the coloured hero): keep the background edge
  to edge and centre the *content* with
  `padding-inline: max(var(--space-4), calc((100% - var(--shell-max)) / 2))`.
  Capping their width instead leaves page background at the sides, which reads
  as broken rather than centred.

**Scaling type and spacing** is one rule, not one per component: every token is
rem-based, so step `html { font-size }` at the breakpoint. Use **percentages**
(`106.25%`, `112.5%`), not px — a px value silently overrides a reader who has
set a larger default.

**Using the width, not padding it out.** At `64rem`+ the kid Home glance puts
Today and This Week side by side, and the parent's card lists become
`repeat(auto-fill, minmax(20rem, 1fr))` — auto-fill so a very wide monitor gets
three columns rather than two half-metre ones. Grids own their spacing, so zero
the per-card `margin-bottom` inside them or it doubles up.

**Never a horizontally scrolling page.** Wide content scrolls inside its own
container.

---

## Parent HQ

Same tokens, different register:

- `--text-base` and `--text-lg` rather than `--text-2xl` and above
- `--radius-md` rather than `--radius-lg`
- `--shadow-1` only
- Density over generosity — a parent scanning approvals wants to see more at once
- **No celebration animations.** Approving is administration, not achievement.

### Sent-back electives stay on offer

Rejecting a kid-added extra asks what redoing it is worth (after the note);
the points sit on the rejected row. The kid's Home shows it as a Try-again
card — name, the offer, the parent's note — with one tap to resubmit the
same row (points intact, `redoExtra`) or bow out (`giveUp` → withdrawn,
which drops it from every history list). No expiry: electives have no
window, so the card stays until acted on. Approving a priced extra prefills
the points prompt with the offer. Must-do chores keep their behaviour:
points on the task, bounce back under the existing window rules. A rejected
prep confirmation resubmits through `confirmPrep` — the idempotency 409
flips a rejected row back to pending instead of silently eating the redo.

### Decision notes

Each pending approval card carries one optional note box (`.approve-note`)
above its two buttons — **✓ Approve** and **✗ Try again**. Whatever is typed
rides along with whichever button is hit; there is no separate "with note"
path. Approving with an empty box is the one-tap fast path. Sending back with
an empty box bounces focus to the box instead of going through — a kid sent
back with no reason has nothing to act on. Re-renders carry typed notes (and
focus) over so a background refresh cannot eat a half-written note.

### Calendar item editing

Editing an event or reminder reuses the add form - prefilled, the button
swapped to "Save changes" with a Cancel beside it (`planningEditId` holds the
mode) - never a chain of browser prompts. Dates are `datetime-local` inputs
(the phone's own graphical picker), and a live line under Starts echoes the
weekday - "Sunday 30 Aug · 9:00am" - so the day of week is visible after
the picker closes. Saving round-trips through `planningUpdatePayload` so prep
lists, points and deadline overrides survive an unrelated edit.

### Stat tiles

The counts waiting on the parent (approvals, reward requests) are two rounded
tiles side by side at the top of the Approvals tab — `.stat-row` / `.stat-tile` —
a big number over a small muted label. Zero is stated once, on the tile; the
card containers below stay empty rather than repeating it as a pill or a
sentence. A non-zero tile takes `.attention` (`--warning-wash` background,
`--warning` number) because it is work waiting on the parent, and the decision
cards render below the row. One exception to the type rule above: the tile
number uses `--text-2xl` — the count is the point of the tile.

---

## The one thing that separates an app from a web page

**Everything is an object.**

A web page is text with links and thin borders. An app is a set of chunky,
obviously-tappable shapes. Look at any kids app that feels right and the pattern
is the same: no bare text links, no 1px rules, no dense paragraphs, nothing small
enough to doubt whether you can press it.

Concretely, in this app:

- **No text-only actions.** Anything tappable is a filled pill, a card, or a
  round icon button. If it does something, it looks like it does something.
- **No thin borders as the main definition of a shape.** Use surface colour,
  radius and `--shadow-1`. A border is for a subtle divider, not for drawing a
  control.
- **Coloured chrome, light content.** A brand-coloured header band and a
  bottom tab bar, with the scrolling content on `--bg` between them. That
  sandwich is most of the effect on its own, before any other polish.
- **Nothing important below `--text-base`.** `--text-xs` is for timestamps and
  meta, never for something a kid needs to read or act on.
- **Round icon buttons in the tab bar**, at least 44px, well spaced. Icons alone
  are fine there; everywhere else an icon needs a label.
- **The active tab wears a pill behind its icon** (`--brand-wash` on
  `.tab-icon`, the Material bottom-nav convention) with the label in
  `--brand`, bold. Colour alone cannot mark these tabs — the icons are emoji,
  which never tint.

### Calibrating the age

Much published kids design is aimed at pre-schoolers — heavy cartoon characters,
very saturated primaries, everything bouncing. Toby and Ollie are past that, and
Peter uses the same app.

Take the **object-ness** from that style — the chunk, the generous hit areas,
the confident colour, the visible reward. Leave the toddler cues: no mascot, no
comic outlines, no rainbow of unrelated hues on one screen. The palette above is
deliberately one confident brand colour plus per-kid accents, not six primaries.

The test: it should look like something a ten-year-old would be happy to open in
front of a friend.

## Reference patterns

Taken from published kids/lifestyle app design that reads as premium. These are
**layout and interaction patterns to reuse**, not palettes to copy.

### The curved hero sheet

The strongest "app, not web page" device available, and the one worth taking
first. A coloured or illustrated hero band across the top, with the white
content surface curving up over it — a large `border-radius` on the top corners
of the content sheet, pulled up so it overlaps the hero by `--space-5` or so. An
avatar or icon badge straddles the join, centred.

Use it on the kid home screen (their avatar, their colour as the hero) and on a
single reward's detail. Not in Parent HQ.

### A persistent points chip

Points balance lives as a pill in the header on every kid screen — icon plus
`tabular-nums` figure, `--radius-full`, on `--brand-wash`. Always visible means
always motivating, and it gives the count-up animation somewhere fixed to happen.

### Tile grid, not a list

For a kid's top-level choices, a two-column grid of large square-ish tiles —
big emoji or inline SVG, a `--text-lg` label, a `--text-sm` sub-label, each on
`--surface` with `--radius-lg` and `--shadow-1`. Lists read as admin; tiles read
as an app and are far easier to hit.

Parent HQ stays list-based — density matters more there.

### Goal progress with the numbers

Reward progress as a full-width bar, `--radius-full`, filled in the kid's colour
(a subtle gradient toward `--brand` is fine), with `earned / target` stated
underneath in `--text-sm`. Seeing "$3,856 / $5,000" alongside the bar is what
makes it feel like progress rather than decoration. Same for points toward a
reward.

### Choice pills

Where a kid picks between a few options, use a row of pills with one active —
`--radius-full`, inactive on `--surface-sunken` with `--ink-muted`, active on
the kid's colour with white text. Better than a dropdown for a child, and better
than radio buttons for a thumb.

### Soft gradients on primary surfaces

The hero band and the primary action can carry a gentle gradient between two
adjacent hues rather than a flat fill. Restraint is the whole trick: two stops,
low contrast between them. A gradient on every card looks cheap; one on the hero
looks considered.

### What we cannot take from these references

**They are carried by custom illustration** — hand-drawn scenes, 3D character
renders, bespoke iconography. We have no build step, no asset pipeline and no
illustrator, so promising that would specify something unbuildable.

Substitute deliberately, and it still works:

- **Large emoji as hero art.** At `--text-3xl` and above, on a gradient band, an
  emoji reads as intentional rather than lazy — and it is free, instant, offline
  and accessible.
- **Inline SVG for shapes** — progress rings, badges, simple decorative blobs.
  Small, themeable with `currentColor`, no request.
- **Colour and gradient do the work** illustration would otherwise do.
- **The kid's own avatar and colour** carry identity in place of a character.

Judged against these references the result will be plainer. It should not be
less consistent, less generous with space, or less rewarding to use — and those
are the parts that actually read as premium.

---

## What this does not cover

Dark mode, theming, and any per-household customisation. Deliberately out of
scope until someone asks for it; adding a second palette before the first is
proven doubles the work of every screen.
