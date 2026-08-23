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

Every kind also needs a `fallback` emoji. Plenty of places can only hold text —
`<option>` labels, prompt lists, the parent kid-mark — and an avatar that
renders as nothing there is worse than an emoji.

`.avatar-photo` fills whatever round or rounded slot it is dropped into
(`width/height: 100%`, `object-fit: cover`, `border-radius: inherit`), so the
same markup works at 2.5rem in the header and 4.5rem on a tile.

**Changing an avatar needs a migration.** `ensureSeeded()` only creates records
when the household does not exist, so editing `SEED_PEOPLE` changes nothing for
a household created weeks ago. `AVATAR_MIGRATIONS` is the only thing that moves
an existing record — this is the #88 trap, and it has now caught us twice.

### Artwork behind the person picker

`.who-band` carries the splash image with the brand gradient **underneath as a
real fallback**, so a 404 or a slow load shows a branded band rather than a
white gap. The artwork carries its own wordmark, so the band's `<h1>` is
`display: none` rather than deleted — it is what shows if the image never
arrives.

Text over artwork gets `--text-scrim`, not a solid bar: it has to hold contrast
against whatever the picture happens to be without hiding it.

Keep the splash under ~200KB. It is the first paint on a phone, and this one is
720px wide at WebP q76 — a bigger source buys nothing behind a `cover`
background.

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

- Blocks sitting on the page background: `max-width` and auto margins. If the
  block carries its own gutter, cap at `calc(var(--shell-max) + gutter * 2)` or
  its content sits inset from the header's by exactly that gutter.
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
