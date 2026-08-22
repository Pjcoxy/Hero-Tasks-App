'use strict';

// Resolve a concrete time window { start: Date, end: Date, allDay: bool } for a schedule item,
// or null when the item type is excluded from conflict checks (daily/weekly chores).
function resolveWindow(item) {
  if (item.kind === 'chore') {
    if (item.cycle !== 'oneoff') return null; // daily/weekly: no real time-of-day
    const at = new Date(item.occurrenceAt);
    if (Number.isNaN(at.getTime())) return null;
    const HALF_MS = 7.5 * 60 * 1000;
    return { start: new Date(at.getTime() - HALF_MS), end: new Date(at.getTime() + HALF_MS), allDay: false };
  }

  if (item.kind === 'reminder') {
    const at = new Date(item.startAt);
    if (Number.isNaN(at.getTime())) return null;
    const HALF_MS = 7.5 * 60 * 1000;
    return { start: new Date(at.getTime() - HALF_MS), end: new Date(at.getTime() + HALF_MS), allDay: false };
  }

  if (item.kind === 'event') {
    const startDate = new Date(item.startAt);
    if (Number.isNaN(startDate.getTime())) return null;

    if (item.allDay) {
      const dayStart = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate()
      ));
      return { start: dayStart, end: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000), allDay: true };
    }

    let end;
    if (item.endAt) {
      end = new Date(item.endAt);
      if (Number.isNaN(end.getTime())) end = new Date(startDate.getTime() + 30 * 60 * 1000);
    } else {
      end = new Date(startDate.getTime() + 30 * 60 * 1000);
    }
    return { start: startDate, end, allDay: false };
  }

  return null;
}

// Return the audience identifier for a schedule item.
// Planning items carry personId (null = whole-family); chore items carry kidId.
function getPersonId(item) {
  if ('personId' in item) return item.personId;
  return item.kidId !== undefined ? item.kidId : null;
}

function audienceOverlaps(pA, pB) {
  return pA === null || pB === null || pA === pB;
}

// Standard interval overlap, with special cases for allDay items:
//  allDay vs allDay  → conflict only when they fall on the same UTC day
//  allDay vs timed   → conflict only when the timed item is fully contained within the allDay day
//  timed vs timed    → standard half-open interval overlap [start, end)
function timeConflicts(winA, winB) {
  if (winA.allDay && winB.allDay) {
    return winA.start.getTime() === winB.start.getTime();
  }
  if (winA.allDay) {
    return winB.start >= winA.start && winB.end <= winA.end;
  }
  if (winB.allDay) {
    return winA.start >= winB.start && winA.end <= winB.end;
  }
  return winA.start < winB.end && winA.end > winB.start;
}

function itemId(item) {
  return item.id || item.taskId || null;
}

// Find all items in existingItems that conflict with candidate.
// Returns objects shaped { id, kind, title, startAt, endAt } for each conflict.
function findConflicts(candidate, existingItems) {
  const candidateWin = resolveWindow(candidate);
  if (!candidateWin) return [];

  const candidateId = itemId(candidate);
  const candidatePersonId = getPersonId(candidate);
  const conflicts = [];

  for (const other of existingItems) {
    const otherId = itemId(other);
    if (candidateId && otherId && candidateId === otherId) continue;
    const otherWin = resolveWindow(other);
    if (!otherWin) continue;
    if (!audienceOverlaps(candidatePersonId, getPersonId(other))) continue;
    if (!timeConflicts(candidateWin, otherWin)) continue;
    conflicts.push({
      id: otherId,
      kind: other.kind,
      title: other.title,
      startAt: other.startAt || other.occurrenceAt || null,
      endAt: other.endAt || null,
    });
  }

  return conflicts;
}

// Suggest up to 3 alternate start times for candidate that have zero conflicts.
// Scans forward from candidate's current start in stepMinutes increments, up to withinDays.
function suggestAlternateSlots(candidate, existingItems, { withinDays = 3, stepMinutes = 15 } = {}) {
  const originalWin = resolveWindow(candidate);
  if (!originalWin) return [];

  const anchorStr = candidate.startAt || candidate.occurrenceAt;
  if (!anchorStr) return [];
  const anchor = new Date(anchorStr);
  if (Number.isNaN(anchor.getTime())) return [];

  // Duration for event items that have an explicit endAt
  const durationMs = originalWin.end.getTime() - originalWin.start.getTime();
  const stepMs = stepMinutes * 60 * 1000;
  const limitMs = anchor.getTime() + withinDays * 24 * 60 * 60 * 1000;
  const suggestions = [];
  let offset = stepMs;

  while (anchor.getTime() + offset <= limitMs && suggestions.length < 3) {
    const cursor = new Date(anchor.getTime() + offset);
    const testCandidate = { ...candidate, startAt: cursor.toISOString() };
    if (candidate.endAt) {
      testCandidate.endAt = new Date(cursor.getTime() + durationMs).toISOString();
    }
    if (candidate.occurrenceAt) {
      testCandidate.occurrenceAt = cursor.toISOString();
    }

    if (findConflicts(testCandidate, existingItems).length === 0) {
      suggestions.push(cursor.toISOString());
    }
    offset += stepMs;
  }

  return suggestions;
}

module.exports = { resolveWindow, findConflicts, suggestAlternateSlots };
