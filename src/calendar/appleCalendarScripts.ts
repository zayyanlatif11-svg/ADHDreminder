/**
 * JXA (JavaScript for Automation) programs that talk to macOS EventKit — the
 * same framework Calendar.app uses. This reads whatever accounts Calendar.app
 * has configured: iCloud, Google, Exchange, subscribed .ics feeds.
 *
 * Why EventKit rather than AppleScript-ing Calendar.app: EventKit is an order
 * of magnitude faster, does not need Calendar.app to be running, and does not
 * require any System Integrity Protection changes. It asks for the standard
 * "Calendars" privacy permission on first run.
 *
 * Parameters are passed through the EA_PARAMS environment variable rather than
 * interpolated into the source, so no config value can ever be injected into
 * the script body.
 */

const PRELUDE = `
ObjC.import('Foundation');
ObjC.import('EventKit');

function params() {
  var raw = $.NSProcessInfo.processInfo.environment.objectForKey('EA_PARAMS');
  if (!raw) return {};
  return JSON.parse(ObjC.unwrap(raw));
}

function text(value) {
  if (value === undefined || value === null) return null;
  try {
    var unwrapped = ObjC.unwrap(value);
    return unwrapped === undefined ? null : unwrapped;
  } catch (e) {
    return null;
  }
}

/**
 * EventKit access is asynchronous. We kick off the request and pump the run
 * loop until it settles, so the script behaves synchronously for the caller.
 */
function authorize(store) {
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  // 3 = authorized (legacy), 4 = full access (macOS 14+)
  if (status === 3 || status === 4) return { granted: true, status: status };

  var settled = false;
  var granted = false;
  try {
    store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, function (ok) {
      granted = ok; settled = true;
    });
  } catch (e) {
    return { granted: false, status: status, error: String(e) };
  }

  var deadline = $.NSDate.date.timeIntervalSince1970 + 30;
  while (!settled && $.NSDate.date.timeIntervalSince1970 < deadline) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
      $.NSDefaultRunLoopMode,
      $.NSDate.dateWithTimeIntervalSinceNow(0.05)
    );
  }
  return { granted: granted, status: status };
}

function calendarsFor(store, names) {
  var all = ObjC.unwrap(store.calendarsForEntityType($.EKEntityTypeEvent));
  if (!names || names.length === 0) return all;
  var wanted = {};
  for (var i = 0; i < names.length; i++) wanted[String(names[i]).toLowerCase()] = true;
  var out = [];
  for (var j = 0; j < all.length; j++) {
    if (wanted[String(text(all[j].title) || '').toLowerCase()]) out.push(all[j]);
  }
  return out;
}
`;

/** Reads events in [fromEpoch, toEpoch) from the named calendars (all if empty). */
export const LIST_EVENTS_SCRIPT = `${PRELUDE}
function run() {
  var p = params();
  var store = $.EKEventStore.alloc.init;
  var auth = authorize(store);
  if (!auth.granted) {
    return JSON.stringify({ ok: false, reason: 'not_authorized', status: auth.status });
  }

  var cals = calendarsFor(store, p.calendarNames);
  if (cals.length === 0) {
    return JSON.stringify({ ok: true, events: [], calendars: [], note: 'no matching calendars' });
  }

  var start = $.NSDate.dateWithTimeIntervalSince1970(p.from);
  var end = $.NSDate.dateWithTimeIntervalSince1970(p.to);
  var predicate = store.predicateForEventsWithStartDateEndDateCalendars(start, end, cals);
  var matched = ObjC.unwrap(store.eventsMatchingPredicate(predicate));

  var events = [];
  for (var i = 0; i < matched.length; i++) {
    var ev = matched[i];
    if (!ev.startDate || !ev.endDate) continue;
    // status 3 = canceled
    var status = 0;
    try { status = ev.status; } catch (e) { status = 0; }
    if (status === 3) continue;
    events.push({
      id: text(ev.eventIdentifier) || ('apple-' + i),
      title: text(ev.title) || '(untitled)',
      start: ev.startDate.timeIntervalSince1970,
      end: ev.endDate.timeIntervalSince1970,
      allDay: Boolean(ev.isAllDay),
      calendarName: text(ev.calendar.title) || 'Calendar',
      location: text(ev.location),
      description: text(ev.notes),
      availability: ev.availability
    });
  }

  var calNames = [];
  for (var k = 0; k < cals.length; k++) calNames.push(text(cals[k].title));
  return JSON.stringify({ ok: true, events: events, calendars: calNames });
}
`;

/** Lists calendar names so setup and doctor can show the user what is available. */
export const LIST_CALENDARS_SCRIPT = `${PRELUDE}
function run() {
  var store = $.EKEventStore.alloc.init;
  var auth = authorize(store);
  if (!auth.granted) {
    return JSON.stringify({ ok: false, reason: 'not_authorized', status: auth.status });
  }
  var all = ObjC.unwrap(store.calendarsForEntityType($.EKEntityTypeEvent));
  var out = [];
  for (var i = 0; i < all.length; i++) {
    out.push({
      title: text(all[i].title),
      identifier: text(all[i].calendarIdentifier),
      writable: Boolean(all[i].allowsContentModifications),
      type: String(all[i].type)
    });
  }
  return JSON.stringify({ ok: true, calendars: out });
}
`;

/**
 * Creates the agent's own local calendar if it does not exist. Never touches
 * any other calendar.
 */
export const ENSURE_CALENDAR_SCRIPT = `${PRELUDE}
function run() {
  var p = params();
  var store = $.EKEventStore.alloc.init;
  var auth = authorize(store);
  if (!auth.granted) {
    return JSON.stringify({ ok: false, reason: 'not_authorized', status: auth.status });
  }

  var all = ObjC.unwrap(store.calendarsForEntityType($.EKEntityTypeEvent));
  for (var i = 0; i < all.length; i++) {
    if (text(all[i].title) === p.name) {
      return JSON.stringify({ ok: true, identifier: text(all[i].calendarIdentifier), created: false });
    }
  }

  var cal = $.EKCalendar.calendarForEntityTypeEventStore($.EKEntityTypeEvent, store);
  cal.title = p.name;

  // Prefer a local source so the agent's blocks never sync into a shared account.
  var sources = ObjC.unwrap(store.sources);
  var chosen = null;
  for (var s = 0; s < sources.length; s++) {
    if (sources[s].sourceType === $.EKSourceTypeLocal) { chosen = sources[s]; break; }
  }
  if (!chosen) chosen = store.defaultCalendarForNewEvents ? store.defaultCalendarForNewEvents.source : null;
  if (!chosen) return JSON.stringify({ ok: false, reason: 'no_writable_source' });
  cal.source = chosen;

  var err = $();
  var saved = store.saveCalendarCommitError(cal, true, err);
  if (!saved) {
    return JSON.stringify({ ok: false, reason: 'save_failed', error: String(err) });
  }
  return JSON.stringify({ ok: true, identifier: text(cal.calendarIdentifier), created: true });
}
`;

/** Creates one event, and only inside the agent's own calendar. */
export const CREATE_EVENT_SCRIPT = `${PRELUDE}
function run() {
  var p = params();
  var store = $.EKEventStore.alloc.init;
  var auth = authorize(store);
  if (!auth.granted) {
    return JSON.stringify({ ok: false, reason: 'not_authorized', status: auth.status });
  }

  var all = ObjC.unwrap(store.calendarsForEntityType($.EKEntityTypeEvent));
  var target = null;
  for (var i = 0; i < all.length; i++) {
    if (text(all[i].title) === p.calendarName) { target = all[i]; break; }
  }
  // Hard guard: refuse to write anywhere but the agent's named calendar.
  if (!target) return JSON.stringify({ ok: false, reason: 'agent_calendar_missing' });
  if (!target.allowsContentModifications) {
    return JSON.stringify({ ok: false, reason: 'calendar_read_only' });
  }

  var ev = $.EKEvent.eventWithEventStore(store);
  ev.title = p.title;
  ev.startDate = $.NSDate.dateWithTimeIntervalSince1970(p.start);
  ev.endDate = $.NSDate.dateWithTimeIntervalSince1970(p.end);
  ev.calendar = target;
  if (p.description) ev.notes = p.description;

  var err = $();
  var saved = store.saveEventSpanCommitError(ev, $.EKSpanThisEvent, true, err);
  if (!saved) return JSON.stringify({ ok: false, reason: 'save_failed', error: String(err) });
  return JSON.stringify({ ok: true, identifier: text(ev.eventIdentifier) });
}
`;

/** Deletes an event, and only if it lives in the agent's own calendar. */
export const DELETE_EVENT_SCRIPT = `${PRELUDE}
function run() {
  var p = params();
  var store = $.EKEventStore.alloc.init;
  var auth = authorize(store);
  if (!auth.granted) {
    return JSON.stringify({ ok: false, reason: 'not_authorized', status: auth.status });
  }
  var ev = store.eventWithIdentifier(p.eventId);
  if (!ev) return JSON.stringify({ ok: false, reason: 'not_found' });
  if (text(ev.calendar.title) !== p.calendarName) {
    return JSON.stringify({ ok: false, reason: 'refused_foreign_calendar' });
  }
  var err = $();
  var removed = store.removeEventSpanCommitError(ev, $.EKSpanThisEvent, true, err);
  return JSON.stringify({ ok: Boolean(removed) });
}
`;
