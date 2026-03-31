'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let calendar;
let studentsList = [];
let activeEvent = null;   // event currently shown in detailModal
let calHoverPreviewMoveHandler = null;
let lastCalendarHoverId = null;
let lastPointerHoverRoot = null;
let calHoverRaf = null;
let lastPointerClientX = 0;
let lastPointerClientY = 0;
/** After drag/resize, ignore the synthetic click that would open the detail modal */
let suppressEventDetailOpenUntil = 0;
let isDraggingCalendarEvent = false;

// ── Bootstrap modal instances (created after DOM ready) ──────────────────────
let detailModal;
let editModal;

// ── Date/time helpers ────────────────────────────────────────────────────────
function fmtTime(d) {
  if (!d) return '';
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function toInputDate(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toInputTime(d) {
  if (!d) return '';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** Scroll week/day view so “now” is visible; FullCalendar only draws the red line in timeGrid views. */
function scrollCalendarToNow() {
  if (!calendar) return;
  const type = calendar.view?.type;
  if (type !== 'timeGridWeek' && type !== 'timeGridDay') return;
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  try {
    calendar.scrollToTime(t);
  } catch (e) { /* ignore */ }
}

/** GET JSON with retries — server may be restarting (uvicorn --reload) and briefly unreachable. */
async function fetchJsonWithRetry(url, opts, maxAttempts = 6) {
  const fetchOpts = { cache: 'no-store', ...opts };
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        if (res.status >= 502 && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new Error('HTTP ' + res.status);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** FullCalendar sometimes omits `end` on timed events — never send empty end to the API */
function getEventEnd(ev) {
  if (ev.end instanceof Date && !isNaN(ev.end.getTime())) return ev.end;
  if (!(ev.start instanceof Date) || isNaN(ev.start.getTime())) return null;
  const out = new Date(ev.start.getTime());
  out.setMinutes(out.getMinutes() + 60);
  return out;
}

/**
 * Month view (and some drops) turn timed lessons into all-day — restore clock time + duration
 * so we can save date+time like Google Calendar.
 */
function normalizeDroppedTimedLesson(info) {
  const ev = info.event;
  const oldEv = info.oldEvent;
  if (!oldEv || oldEv.allDay || !ev) return;
  if (!ev.allDay) return;

  const oldS = oldEv.start;
  const oldE = getEventEnd(oldEv);
  if (!oldS || !oldE) return;

  const anchor = ev.start;
  if (!anchor) return;

  const newStart = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    oldS.getHours(),
    oldS.getMinutes(),
    oldS.getSeconds(),
    oldS.getMilliseconds()
  );
  const newEnd = new Date(newStart.getTime() + (oldE.getTime() - oldS.getTime()));

  try {
    if (typeof ev.setDates === 'function') {
      ev.setDates(newStart, newEnd, { allDay: false });
    } else {
      if (typeof ev.setAllDay === 'function') ev.setAllDay(false);
      if (typeof ev.setStart === 'function') ev.setStart(newStart);
      if (typeof ev.setEnd === 'function') ev.setEnd(newEnd);
    }
  } catch (e) {
    console.warn('normalizeDroppedTimedLesson', e);
  }
}

/** Persist lesson after drag or resize (real DB row or confirm recurring slot). */
async function persistLessonAfterDragResize(info) {
  normalizeDroppedTimedLesson(info);
  const ev = info.event;
  const oldEv = info.oldEvent;
  const p = ev.extendedProps || {};

  if (ev.allDay) {
    throw new Error('allDay');
  }

  if (p.isRecurring === true) {
    const studentId = p.studentId;
    if (studentId == null) throw new Error('no student');
    const oldStart = oldEv.start;
    const oldEnd = getEventEnd(oldEv);
    const newStart = ev.start;
    const newEnd = getEventEnd(ev);
    if (!oldStart || !oldEnd || !newStart || !newEnd) throw new Error('bad dates');
    const fd = new FormData();
    fd.append('student_id', String(studentId));
    fd.append('original_date', toInputDate(oldStart));
    fd.append('original_start', toInputTime(oldStart));
    fd.append('original_end', toInputTime(oldEnd));
    fd.append('new_date', toInputDate(newStart));
    fd.append('new_start', toInputTime(newStart));
    fd.append('new_end', toInputTime(newEnd));
    const price = p.price != null && p.price !== '' ? Number(p.price) : 0;
    fd.append('price', String(Number.isFinite(price) ? price : 0));
    fd.append('notes', p.notes != null ? String(p.notes) : '');
    const res = await fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('recur failed');
    return;
  }

  const lessonId = Number(ev.id);
  if (!Number.isFinite(lessonId)) throw new Error('bad id');
  const newStart = ev.start;
  const newEnd = getEventEnd(ev);
  if (!newStart || !newEnd) throw new Error('bad dates');
  const fd = new FormData();
  fd.append('lesson_date', toInputDate(newStart));
  fd.append('start_time', toInputTime(newStart));
  fd.append('end_time', toInputTime(newEnd));
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('update failed');
}

/** Safe for HTML attribute value */
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** Hebrew label for payment_method stored in DB */
function paymentMethodLabel(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'cash') return 'מזומן/עודף';
  if (c === 'bit') return 'ביט';
  if (c === 'paybox') return 'פייבוקס';
  if (c === 'other') return 'אחר';
  return '';
}

/** Sync hidden select + chip buttons in lesson detail modal */
function syncDetPaymentChips(method) {
  const sel = document.getElementById('detPaymentMethod');
  const m = String(method || 'cash').toLowerCase();
  const v = ['cash', 'bit', 'paybox', 'other'].includes(m) ? m : 'cash';
  if (sel) sel.value = v;
  document.querySelectorAll('#detPaidRow .det-pay-chip').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-method') === v);
  });
}

/** Native tooltip (title) — shown on hover */
function eventHoverTitle(ev) {
  const p = ev.extendedProps || {};
  const name = ev.title || '';
  const start = fmtTime(ev.start);
  const endT = getEventEnd(ev);
  const end = fmtTime(endT);
  let status = '';
  if (p.isRecurring) status = 'שיעור קבוע';
  else if (p.status === 'cancelled') status = 'בוטל';
  else if (p.isPaid) status = 'שולם';
  else if ((p.attendance || 'expected') === 'no_show') status = 'לא הגיע/ה';
  else if (p.attendance === 'arrived') status = 'הגיע/ה · לא שולם';
  else status = 'ממתין לסימון';
  const price = p.price ? ` · ${p.price} ₪` : '';
  let payExtra = '';
  if (p.isPaid) {
    const amt = p.paidAmount != null && p.paidAmount !== '' ? Number(p.paidAmount) : p.price;
    const pm = paymentMethodLabel(p.paymentMethod);
    if (Number.isFinite(amt)) payExtra = `\nשולם ${amt} ₪${pm ? ' · ' + pm : ''}`;
  }
  const noteLine =
    p.notes && String(p.notes).trim() ? `\nהערה: ${String(p.notes).trim().slice(0, 120)}` : '';
  return `${name}\n${start} – ${end}\n${status}${price}${payExtra}${noteLine}\nגרירה = הזזת שיעור · לחיצה = פרטים`;
}

/**
 * FullCalendar timeGrid hit-testing often misses clicks (overflow, harness, RTL, dense slots).
 * Use the visual stack under the pointer so we always match the event the user sees.
 */
/**
 * Top-most lesson under the pointer (paint order), plus its `.fc-event` root.
 * FullCalendar’s own `eventMouseEnter` often misses when harnesses overlap or RTL layout skews hits.
 */
function resolveEventHitFromClientPoint(clientX, clientY) {
  if (!calendar) return null;
  const calEl = document.getElementById('calendar');
  if (!calEl) return null;
  let stack;
  try {
    stack = document.elementsFromPoint(clientX, clientY);
  } catch (e) {
    return null;
  }
  if (!stack || !stack.length) return null;
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    const root = el.closest && el.closest('.fc-event');
    if (!root || !calEl.contains(root)) continue;
    const rawId =
      root.getAttribute('data-event-id') ||
      (root.querySelector('.ev-inner[data-event-id]') || {}).getAttribute?.('data-event-id');
    if (rawId == null || rawId === '') continue;
    let evObj = calendar.getEventById(rawId);
    if (!evObj && /^\d+$/.test(rawId)) {
      evObj = calendar.getEventById(Number(rawId));
    }
    if (!evObj && typeof calendar.getEvents === 'function') {
      const all = calendar.getEvents();
      for (let j = 0; j < all.length; j++) {
        if (String(all[j].id) === String(rawId)) {
          evObj = all[j];
          break;
        }
      }
    }
    if (evObj) return { event: evObj, rootEl: root };
  }
  return null;
}

function resolveEventFromClientPoint(clientX, clientY) {
  const hit = resolveEventHitFromClientPoint(clientX, clientY);
  return hit ? hit.event : null;
}

/** Short status line for hover preview (Hebrew, matches event chip logic). */
function eventStatusSummary(ev) {
  const p = ev.extendedProps || {};
  const att = p.attendance || 'expected';
  if (p.isRecurring) return 'שיעור קבוע';
  if (p.status === 'cancelled') return 'בוטל';
  if (p.isPaid) return 'שולם';
  if (att === 'no_show') return 'לא הגיע/ה';
  if (att === 'arrived') return 'הגיע/ה · לא שולם';
  return 'ממתין לסימון';
}

function positionCalHoverPreview(clientX, clientY) {
  const el = document.getElementById('calHoverPreview');
  if (!el || el.hidden) return;
  const pad = 12;
  const gap = 14;
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 120;
  let x = clientX + gap;
  let y = clientY + gap;
  if (x + w + pad > window.innerWidth) x = clientX - w - gap;
  if (x < pad) x = pad;
  if (y + h + pad > window.innerHeight) y = clientY - h - gap;
  if (y < pad) y = pad;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function setPointerHoverClass(rootEl) {
  if (lastPointerHoverRoot === rootEl) return;
  if (lastPointerHoverRoot) {
    lastPointerHoverRoot.classList.remove('cal-event-pointer-hover');
  }
  lastPointerHoverRoot = rootEl;
  if (rootEl) rootEl.classList.add('cal-event-pointer-hover');
}

function hideCalHoverPreview() {
  lastCalendarHoverId = null;
  setPointerHoverClass(null);
  if (calHoverPreviewMoveHandler) {
    document.removeEventListener('mousemove', calHoverPreviewMoveHandler);
    calHoverPreviewMoveHandler = null;
  }
  const el = document.getElementById('calHoverPreview');
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

function scheduleCalendarHoverCheck(clientX, clientY) {
  if (isDraggingCalendarEvent) return;
  lastPointerClientX = clientX;
  lastPointerClientY = clientY;
  if (calHoverRaf != null) return;
  calHoverRaf = requestAnimationFrame(function () {
    calHoverRaf = null;
    processCalendarHoverAt(lastPointerClientX, lastPointerClientY);
  });
}

function processCalendarHoverAt(clientX, clientY) {
  if (!calendar) return;
  if (isDraggingCalendarEvent) return;
  const calEl = document.getElementById('calendar');
  if (!calEl) return;
  const rect = calEl.getBoundingClientRect();
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    if (lastCalendarHoverId !== null) hideCalHoverPreview();
    return;
  }
  const hit = resolveEventHitFromClientPoint(clientX, clientY);
  if (!hit) {
    if (lastCalendarHoverId !== null) hideCalHoverPreview();
    return;
  }
  const id = String(hit.event.id);
  if (id !== lastCalendarHoverId) {
    lastCalendarHoverId = id;
    showCalHoverPreview(hit.event, clientX, clientY);
  } else {
    positionCalHoverPreview(clientX, clientY);
  }
  setPointerHoverClass(hit.rootEl);
}

function bindCalendarPointerHover(calHost) {
  if (!calHost || calHost.dataset.calPointerHover === '1') return;
  calHost.dataset.calPointerHover = '1';
  calHost.addEventListener(
    'mousemove',
    function (e) {
      scheduleCalendarHoverCheck(e.clientX, e.clientY);
    },
    { passive: true }
  );
  calHost.addEventListener('mouseleave', function (e) {
    if (e.relatedTarget && calHost.contains(e.relatedTarget)) return;
    hideCalHoverPreview();
  });
}

/** After scroll, the block under a stationary cursor can change — refresh hover. */
function bindCalendarScrollerHoverRefresh() {
  const cal = document.getElementById('calendar');
  if (!cal) return;
  cal.querySelectorAll('.fc-scroller').forEach(function (sc) {
    if (sc.dataset.calHoverScroll === '1') return;
    sc.dataset.calHoverScroll = '1';
    sc.addEventListener(
      'scroll',
      function () {
        scheduleCalendarHoverCheck(lastPointerClientX, lastPointerClientY);
      },
      { passive: true }
    );
  });
}

function showCalHoverPreview(ev, clientX, clientY) {
  const el = document.getElementById('calHoverPreview');
  const nameEl = document.getElementById('calHoverPreviewName');
  const timeEl = document.getElementById('calHoverPreviewTime');
  const statusEl = document.getElementById('calHoverPreviewStatus');
  if (!el || !nameEl || !timeEl || !statusEl) return;

  const endT = getEventEnd(ev);
  const start = fmtTime(ev.start);
  const end = fmtTime(endT);
  const p = ev.extendedProps || {};
  const priceLine = p.price != null && p.price !== '' ? ` · ${p.price} ₪` : '';

  nameEl.textContent = ev.title || '(ללא שם)';
  timeEl.textContent = `${start} – ${end}${priceLine}`;
  statusEl.textContent = eventStatusSummary(ev);

  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  positionCalHoverPreview(clientX, clientY);

  if (!calHoverPreviewMoveHandler) {
    calHoverPreviewMoveHandler = function (e) {
      positionCalHoverPreview(e.clientX, e.clientY);
    };
    document.addEventListener('mousemove', calHoverPreviewMoveHandler);
  }
}

// ── Students list ────────────────────────────────────────────────────────────
async function loadStudents() {
  studentsList = await fetchJsonWithRetry('/api/students-list', {});
  const sel = document.getElementById('lessonStudent');
  sel.innerHTML = '<option value="">-- בחר תלמיד --</option>';
  studentsList.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.text  = s.name;
    opt.dataset.price = s.default_price;
    sel.appendChild(opt);
  });
}

// ── Calendar init ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
  editModal   = new bootstrap.Modal(document.getElementById('editModal'));

  const detPaidRowEl = document.getElementById('detPaidRow');
  if (detPaidRowEl) {
    detPaidRowEl.addEventListener('click', function (e) {
      const chip = e.target.closest('.det-pay-chip');
      if (!chip) return;
      e.preventDefault();
      syncDetPaymentChips(chip.getAttribute('data-method'));
    });
  }

  try {
    await loadStudents();
  } catch (e) {
    console.warn('רשימת תלמידים לא נטענה (אולי השרת עושה reload) — נסי רענון.', e);
  }

  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: 'timeGridWeek',
    locale: 'he',
    direction: 'rtl',
    firstDay: 0,
    headerToolbar: {
      start: 'prev,next today',
      center: 'title',
      end: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    buttonText: { today: 'היום', month: 'חודש', week: 'שבוע', day: 'יום' },
    /* Full day in week/day views (was 07:00–22:00, which hid early/late lessons) */
    slotMinTime: '00:00:00',
    slotMaxTime: '24:00:00',
    allDaySlot: false,
    /* Fixed-ish height helps the “now” line layout; auto height often hides the indicator */
    height: 'calc(100vh - 260px)',
    expandRows: true,
    displayEventEnd: true,
    eventMinHeight: 65, // Force FullCalendar to make events tall enough for 3 lines of text
    slotEventOverlap: true, // Allow overlapping so they don't get squished to 20px wide
    nowIndicator: true,

    /* Drag & resize (Google Calendar–style): week/day time slots + month (day) moves */
    editable: true,
    eventStartEditable: true,
    eventDurationEditable: true,
    eventDragMinDistance: 1,
    dragRevertDuration: 0,
    snapDuration: '00:15:00',
    longPressDelay: 350,
    dragScroll: true,
    eventOverlap: true,
    fixedMirrorParent: document.body,

    eventDragStart: function () {
      isDraggingCalendarEvent = true;
      hideCalHoverPreview();
    },
    eventDragStop: function () {
      isDraggingCalendarEvent = false;
      suppressEventDetailOpenUntil = Date.now() + 700;
    },
    eventResizeStart: function () {
      isDraggingCalendarEvent = true;
      hideCalHoverPreview();
    },
    eventResizeStop: function () {
      isDraggingCalendarEvent = false;
      suppressEventDetailOpenUntil = Date.now() + 700;
    },

    eventDrop: function (info) {
      hideCalHoverPreview();
      return persistLessonAfterDragResize(info)
        .then(function () {
          calendar.refetchEvents();
        })
        .catch(function (err) {
          info.revert();
          if (err && err.message === 'allDay') {
            alert('לא ניתן לשבץ שיעור כ«כל היום». השתמשי בתצוגת שבוע או יום.');
          } else {
            alert('לא ניתן לעדכן את המיקום. נסי שוב.');
          }
        });
    },

    eventResize: function (info) {
      return persistLessonAfterDragResize(info)
        .then(function () {
          calendar.refetchEvents();
        })
        .catch(function () {
          info.revert();
          alert('לא ניתן לעדכן את אורך השיעור. נסי שוב.');
        });
    },

    viewDidMount: function () {
      requestAnimationFrame(function () {
        scrollCalendarToNow();
        bindCalendarScrollerHoverRefresh();
      });
    },

    eventDidMount: function (info) {
      const el = info.el;
      if (!el) return;
      const tip = eventHoverTitle(info.event);
      el.setAttribute('data-event-id', String(info.event.id));
      el.setAttribute('title', tip);
      el.setAttribute('aria-label', tip.replace(/\n/g, ' — '));
      /*
       * Timed events render as <a href="…" class="fc-event">. Browsers start native
       * link-drag on <a>, which steals the gesture from FullCalendar’s pointer drag.
       */
      el.setAttribute('draggable', 'false');
      el.addEventListener(
        'dragstart',
        function (e) {
          e.preventDefault();
        },
        true
      );
    },

    // ── Custom event rendering ───────────────────────────────────
    eventContent: function (info) {
      const p    = info.event.extendedProps;
      const time = fmtTime(info.event.start);
      const name = info.event.title;
      const att  = p.attendance || 'expected';

      let tag = '';
      if (p.isRecurring)               tag = '<span class="ev-tag">🔁 קבוע</span>';
      else if (p.status === 'cancelled') tag = '<span class="ev-tag">✕ בוטל</span>';
      else if (p.isPaid)               tag = '<span class="ev-tag">✓ שולם</span>';
      else if (att === 'no_show')      tag = '<span class="ev-tag">✕ לא הגיע/ה</span>';
      else if (att === 'arrived')      tag = '<span class="ev-tag">הגיע/ה · לא שולם</span>';
      else                             tag = '<span class="ev-tag">ממתין לסימון</span>';

      return {
        html: `<div class="ev-inner" data-event-id="${escAttr(info.event.id)}">
          <div class="ev-time">${time}</div>
          <div class="ev-name">${name}</div>
          ${tag}
        </div>`
      };
    },

    events: function (fetchInfo, successCallback, failureCallback) {
      const q = `start=${encodeURIComponent(fetchInfo.startStr)}&end=${encodeURIComponent(fetchInfo.endStr)}`;
      fetchJsonWithRetry(`/api/lessons?${q}`, {})
        .then(successCallback)
        .catch(failureCallback);
    },

    // ── Click on existing event → detail card ────────────────────
    eventClick: function (info) {
      info.jsEvent.preventDefault();
      info.jsEvent.stopPropagation();
      openDetailCard(info.event);
    },

    // ── Click on empty slot → new lesson form ────────────────────
    dateClick: function (info) {
      const evObj = resolveEventFromClientPoint(info.jsEvent.clientX, info.jsEvent.clientY);
      if (evObj) {
        openDetailCard(evObj);
        return;
      }
      openNewLessonModalOnDate(info.dateStr);
    },
  });

  calendar.render();
  bindCalendarPointerHover(document.getElementById('calendar'));
  requestAnimationFrame(function () {
    scrollCalendarToNow();
    bindCalendarScrollerHoverRefresh();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && calendar) {
      calendar.refetchEvents();
    }
  });

  // Auto-fill price when student is selected
  document.getElementById('lessonStudent').addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    if (opt && opt.dataset.price) {
      document.getElementById('lessonPrice').value = opt.dataset.price;
    }
  });

  applyCalendarUrlParams();
});

/**
 * /calendar?date=YYYY-MM-DD&student=ID — after a parent call, open new lesson with fields pre-filled.
 */
function applyCalendarUrlParams() {
  let qs = '';
  try {
    qs = window.location.search || '';
  } catch (e) {
    return;
  }
  if (!qs || qs.length < 2) return;
  const p = new URLSearchParams(qs);
  const d = p.get('date');
  const sid = p.get('student');
  if (!d && !sid) return;
  openNewLessonModal();
  if (d && d.length >= 10) {
    document.getElementById('lessonDate').value = d.slice(0, 10);
  }
  if (sid) {
    const sel = document.getElementById('lessonStudent');
    for (let i = 0; i < sel.options.length; i++) {
      sel.options[i].selected = sel.options[i].value === String(sid);
    }
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  try {
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', '/calendar');
    }
  } catch (e2) { /* ignore */ }
}

// ── Global click (capture): open lesson if pointer is visually over an event ──
// Runs before FullCalendar so a mistaken "empty slot" dateClick never opens "new lesson".
// IMPORTANT: must NOT stopImmediatePropagation — that kills FC's internal drag bookkeeping.
document.addEventListener(
  'click',
  function (e) {
    if (!calendar) return;
    if (isDraggingCalendarEvent) return;
    if (Date.now() < suppressEventDetailOpenUntil) return;
    const calEl = document.getElementById('calendar');
    if (!calEl || !calEl.contains(e.target)) return;
    const evObj = resolveEventFromClientPoint(e.clientX, e.clientY);
    if (!evObj) return;
    e.preventDefault();
    e.stopPropagation();
    openDetailCard(evObj);
  },
  true
);

// ════════════════════════════════════════════════════════════════════════════
//  DETAIL CARD  (Google-Calendar style)
// ════════════════════════════════════════════════════════════════════════════

function openDetailCard(event) {
  hideCalHoverPreview();
  activeEvent = event;
  const p = event.extendedProps;

  // Header text
  document.getElementById('detName').textContent =
    event.title + (p.isRecurring ? '  🔁' : '');
  const endForDisplay = getEventEnd(event);
  document.getElementById('detTime').textContent =
    fmtDate(event.start) + '   ' + fmtTime(event.start) + ' – ' + fmtTime(endForDisplay);

  const priceInput = document.getElementById('detPriceInput');
  const priceHint = document.getElementById('detPriceSaveHint');
  if (priceHint) priceHint.classList.add('d-none');

  // Status stripe: light blue=ממתין, royal blue=הגיע, grey=no show, green=paid, sky=recurring
  const header = document.getElementById('detHeader');
  const att = p.attendance || 'expected';
  header.classList.remove('s-paid', 's-attended', 's-expected', 's-no-show', 's-recurring', 's-cancelled');
  if (p.isRecurring)               header.classList.add('s-recurring');
  else if (p.status === 'cancelled') header.classList.add('s-cancelled');
  else if (p.isPaid)               header.classList.add('s-paid');
  else if (att === 'no_show')      header.classList.add('s-no-show');
  else if (att === 'arrived')      header.classList.add('s-attended');
  else                             header.classList.add('s-expected');

  const isRecurring = p.isRecurring === true;
  document.getElementById('detBodyReal').style.display      = isRecurring ? 'none' : 'block';
  document.getElementById('detBodyRecurring').style.display = isRecurring ? 'block' : 'none';

  const paidRow = document.getElementById('detPaidRow');
  if (isRecurring) {
    document.getElementById('detRecurDate').value  = toInputDate(event.start);
    document.getElementById('detRecurStart').value = toInputTime(event.start);
    document.getElementById('detRecurEnd').value   = toInputTime(getEventEnd(event));
    const rp = document.getElementById('detRecurPrice');
    if (rp) {
      rp.value = p.price != null && p.price !== '' ? String(p.price) : '';
    }
    const rn = document.getElementById('detRecurNotes');
    if (rn) rn.value = '';
  } else {
    const pr = p.price != null && p.price !== '' ? Number(p.price) : 0;
    if (priceInput) priceInput.value = Number.isFinite(pr) ? pr : 0;
    const cancelled = p.status === 'cancelled';
    const isPaid = p.isPaid === true;
    paidRow.classList.toggle('d-none', cancelled);
    if (!cancelled) _syncDetailPaidBtn(isPaid);
    _syncDetailAttendanceUI(att, cancelled, isPaid);

    const notesSec = document.getElementById('detNotesSection');
    if (notesSec) notesSec.classList.toggle('d-none', cancelled);
    const detNotes = document.getElementById('detLessonNotes');
    if (detNotes) detNotes.value = p.notes != null ? String(p.notes) : '';
    const nHint = document.getElementById('detNotesSaveHint');
    if (nHint) nHint.classList.add('d-none');

    const paidAmtEl = document.getElementById('detPaidAmount');
    const prn = p.price != null && p.price !== '' ? Number(p.price) : 0;
    const stored = p.paidAmount != null && p.paidAmount !== '' ? Number(p.paidAmount) : NaN;
    if (paidAmtEl) {
      if (isPaid && Number.isFinite(stored)) {
        paidAmtEl.value = String(stored);
      } else if (isPaid && Number.isFinite(prn)) {
        paidAmtEl.value = String(prn);
      } else if (!isPaid && Number.isFinite(prn)) {
        paidAmtEl.value = String(prn);
      } else {
        paidAmtEl.value = '';
      }
    }
    syncDetPaymentChips(p.paymentMethod || 'bit');
    const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
    if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !isPaid);
    const payHint = document.getElementById('detPaymentSaveHint');
    if (payHint) payHint.classList.add('d-none');
    const payHintLabel = document.getElementById('detPayHint');
    if (payHintLabel && !cancelled) {
      payHintLabel.textContent = isPaid
        ? 'שולם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי»'
        : 'בחרי ביט / מזומן / פייבוקס, התאימי סכום, ואז לחצי «שולם» למטה';
    }

    const micro = document.getElementById('detMicroHint');
    if (micro) {
      micro.classList.remove('d-none');
      let msg = 'כל סימון נשמר מיד בלחיצה.';
      if (cancelled) {
        msg =
          'שיעור בוטל — נוכחות ותשלום לא רלוונטיים. אפשר לערוך או למחוק למטה.';
      } else if (isPaid) {
        msg =
          'שולם ✓ — אפשר לדייק סכום ואמצעי למעלה, מחיר בשיעור למטה, והערות.';
      } else {
        msg = 'נוכחות למעלה · תשלום: בוחרים אמצעי וסכום, ואז מסמנים שולם.';
      }
      micro.textContent = msg;
    }
  }

  detailModal.show();
}

function _syncDetailAttendanceUI(att, cancelled, isPaid) {
  const row = document.getElementById('detAttendanceRow');
  if (!row) return;
  if (cancelled || isPaid) {
    row.classList.add('d-none');
    return;
  }
  row.classList.remove('d-none');
  document.getElementById('detBtnArrived').classList.toggle('is-selected', att === 'arrived');
  document.getElementById('detBtnNoShow').classList.toggle('is-selected', att === 'no_show');
}

async function detSavePaymentDetails() {
  if (!activeEvent || activeEvent.extendedProps.isRecurring) return;
  if (activeEvent.extendedProps.status === 'cancelled') return;
  if (!activeEvent.extendedProps.isPaid) {
    alert('קודם לחצי «לא שולם — לחצי לסימון» למטה, ואז אפשר לעדכן סכום ואמצעי שוב.');
    return;
  }
  const lessonId = Number(activeEvent.id);
  if (!Number.isFinite(lessonId)) return;
  const raw = (document.getElementById('detPaidAmount').value || '').trim();
  const v = raw === '' ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    alert('נא להזין סכום תקין (מספר חיובי או רשום 0).');
    return;
  }
  const pm = (document.getElementById('detPaymentMethod').value || 'cash').trim();
  const fd = new FormData();
  fd.append('paid_amount', String(v));
  fd.append('payment_method', pm);
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('paidAmount', v);
      activeEvent.setExtendedProp('paymentMethod', pm);
    }
    const hint = document.getElementById('detPaymentSaveHint');
    if (hint) {
      hint.classList.remove('d-none');
      setTimeout(function () {
        hint.classList.add('d-none');
      }, 2200);
    }
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת פרטי התשלום. נסי שוב.');
  }
}

async function detSaveNotes() {
  if (!activeEvent || activeEvent.extendedProps.isRecurring) return;
  if (activeEvent.extendedProps.status === 'cancelled') return;
  const lessonId = Number(activeEvent.id);
  if (!Number.isFinite(lessonId)) return;
  const txt = document.getElementById('detLessonNotes');
  const notes = txt ? txt.value : '';
  const fd = new FormData();
  fd.append('notes', notes);
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('notes', notes);
    }
    const hint = document.getElementById('detNotesSaveHint');
    if (hint) {
      hint.classList.remove('d-none');
      setTimeout(function () {
        hint.classList.add('d-none');
      }, 2200);
    }
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת ההערות. נסי שוב.');
  }
}

async function detSavePrice() {
  if (!activeEvent || activeEvent.extendedProps.isRecurring) return;
  const lessonId = Number(activeEvent.id);
  if (!Number.isFinite(lessonId)) return;
  const raw = document.getElementById('detPriceInput').value;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    alert('נא להזין מחיר תקין (מספר חיובי).');
    return;
  }
  const fd = new FormData();
  fd.append('price', String(v));
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('price', v);
    }
    const hint = document.getElementById('detPriceSaveHint');
    if (hint) {
      hint.classList.remove('d-none');
      setTimeout(function () {
        hint.classList.add('d-none');
      }, 2200);
    }
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת המחיר. נסי שוב.');
  }
}

async function detSetAttendance(value) {
  if (!activeEvent || activeEvent.extendedProps.isRecurring) return;
  if (activeEvent.extendedProps.status === 'cancelled') return;
  if (activeEvent.extendedProps.isPaid) return;
  const lessonId = Number(activeEvent.id);
  if (!Number.isFinite(lessonId)) return;
  const fd = new FormData();
  fd.append('attendance', value);
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('attendance', value);
    }
    _syncDetailAttendanceUI(value, false, false);
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת נוכחות. נסי שוב.');
  }
}

function _syncDetailPaidBtn(isPaid) {
  const btn   = document.getElementById('detPaidBtn');
  const label = document.getElementById('detPaidLabel');
  const icon  = document.getElementById('detPaidIcon');
  if (isPaid) {
    btn.className = 'paid w-100 mt-2';
    label.textContent = 'שולם ✓ — לחצי לביטול';
    icon.className = 'bi bi-check-circle me-2';
  } else {
    btn.className = 'unpaid w-100 mt-2';
    label.textContent = 'לא שולם — לחצי לסימון';
    icon.className = 'bi bi-x-circle me-2';
  }
}

// Toggle paid straight from the detail card
async function detTogglePaid() {
  if (!activeEvent) return;
  if (activeEvent.extendedProps.status === 'cancelled') return;
  const nowPaid = activeEvent.extendedProps.isPaid === true;
  const newPaid = !nowPaid;

  const fd = new FormData();
  fd.append('is_paid', newPaid ? 'true' : 'false');
  if (newPaid) {
    fd.append('status', 'completed');
    fd.append('attendance', 'arrived');
    const pa = (document.getElementById('detPaidAmount').value || '').trim();
    const pr = Number(activeEvent.extendedProps.price);
    fd.append('paid_amount', pa || (Number.isFinite(pr) ? String(pr) : '0'));
    fd.append('payment_method', (document.getElementById('detPaymentMethod').value || 'cash').trim() || 'cash');
  } else {
    fd.append('paid_amount', '');
    fd.append('payment_method', '');
  }

  const res = await fetch(`/api/lessons/${activeEvent.id}/update`, { method: 'POST', body: fd });
  if (res.ok) {
    _syncDetailPaidBtn(newPaid);
    const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
    if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !newPaid);
    const payHintLabel = document.getElementById('detPayHint');
    if (payHintLabel && activeEvent.extendedProps.status !== 'cancelled') {
      payHintLabel.textContent = newPaid
        ? 'שולם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי»'
        : 'בחרי ביט / מזומן / פייבוקס, התאימי סכום, ואז לחצי «שולם» למטה';
    }
    if (newPaid) {
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('attendance', 'arrived');
        const pam = (document.getElementById('detPaidAmount').value || '').trim();
        const prx = Number(activeEvent.extendedProps.price);
        const finalAmt = pam ? parseInt(pam, 10) : Number.isFinite(prx) ? prx : 0;
        activeEvent.setExtendedProp('isPaid', true);
        activeEvent.setExtendedProp('paidAmount', finalAmt);
        activeEvent.setExtendedProp(
          'paymentMethod',
          (document.getElementById('detPaymentMethod').value || 'cash').trim()
        );
      }
      _syncDetailAttendanceUI('arrived', false, true);
    } else {
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('isPaid', false);
        activeEvent.setExtendedProp('paidAmount', null);
        activeEvent.setExtendedProp('paymentMethod', '');
      }
      _syncDetailAttendanceUI(activeEvent.extendedProps.attendance || 'expected', false, false);
    }
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירה. נסי שוב.');
  }
}

// Delete real lesson from detail card (not virtual recurring)
async function detDeleteLesson() {
  if (!activeEvent) return;
  const raw = activeEvent.id;
  if (raw == null || String(raw).startsWith('v-')) {
    alert('לא ניתן למחוק שיעור קבוע — השתמשי ב"הסר מופע זה מהלוח".');
    return;
  }
  const lessonId = Number(raw);
  if (!Number.isFinite(lessonId)) {
    alert('מזהה שיעור לא תקין.');
    return;
  }
  if (!confirm('למחוק את השיעור מהמערכת? הפעולה סופית.')) return;
  const res = await fetch(`/api/lessons/${lessonId}/delete`, { method: 'POST' });
  if (res.ok) {
    detailModal.hide();
    calendar.refetchEvents();
  } else {
    alert('לא ניתן למחוק. נסי שוב.');
  }
}

// Remove one virtual recurring occurrence from the calendar (placeholder lesson)
async function removeRecurringFromCalendar() {
  if (!activeEvent || activeEvent.extendedProps.isRecurring !== true) return;
  if (!confirm('להסיר את המופע הזה מהלוח? השיעור הקבוע של התלמיד לא ישתנה.')) return;
  const fd = new FormData();
  let endVal = (document.getElementById('detRecurEnd').value || '').trim();
  if (!endVal) endVal = toInputTime(getEventEnd(activeEvent));
  fd.append('student_id', activeEvent.extendedProps.studentId);
  fd.append('slot_date', toInputDate(activeEvent.start));
  fd.append('start_time', toInputTime(activeEvent.start));
  fd.append('end_time', endVal);
  const res = await fetch('/api/lessons/skip-recurring-slot', { method: 'POST', body: fd });
  if (res.ok) {
    detailModal.hide();
    calendar.refetchEvents();
  } else {
    alert('שגיאה. אולי כבר קיים שיעור בתאריך הזה — נסי לערוך או למחוק אותו.');
  }
}

// Confirm a recurring slot from detail card
async function confirmRecurring() {
  if (!activeEvent) return;
  const p  = activeEvent.extendedProps;
  const fd = new FormData();
  fd.append('student_id',    p.studentId);
  fd.append('original_date', toInputDate(activeEvent.start));
  fd.append('original_start', toInputTime(activeEvent.start));
  fd.append('original_end',   toInputTime(getEventEnd(activeEvent)));
  let newEnd = (document.getElementById('detRecurEnd').value || '').trim();
  if (!newEnd) {
    const s = document.getElementById('detRecurStart').value;
    if (s) {
      const [h, m] = s.split(':').map(Number);
      const d = new Date(2000, 0, 1, h, m);
      d.setMinutes(d.getMinutes() + 60);
      newEnd = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } else {
      newEnd = toInputTime(getEventEnd(activeEvent));
    }
  }
  fd.append('new_date',  document.getElementById('detRecurDate').value);
  fd.append('new_start', document.getElementById('detRecurStart').value);
  fd.append('new_end',   newEnd);
  const recurPriceEl = document.getElementById('detRecurPrice');
  let priceVal = recurPriceEl && recurPriceEl.value !== '' ? parseInt(recurPriceEl.value, 10) : NaN;
  if (!Number.isFinite(priceVal) || priceVal < 0) priceVal = p.price || 0;
  fd.append('price', String(priceVal));
  const recurNotes = document.getElementById('detRecurNotes');
  fd.append('notes', recurNotes ? recurNotes.value || '' : '');

  const res = await fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd });
  if (res.ok) {
    detailModal.hide();
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירה. נסי שוב.');
  }
}

// Open the full edit modal from detail card
function switchToEdit() {
  detailModal.hide();
  if (activeEvent) openFullEditModal(activeEvent);
}

// ════════════════════════════════════════════════════════════════════════════
//  FULL EDIT MODAL
// ════════════════════════════════════════════════════════════════════════════

function tomorrowInputDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toInputDate(d);
}

function openQuickLessonTomorrow() {
  openNewLessonModal();
  document.getElementById('lessonDate').value = tomorrowInputDate();
  document.getElementById('lessonStart').value = '10:00';
  document.getElementById('lessonEnd').value = '11:00';
}

function openQuickLessonToday() {
  openNewLessonModal();
  document.getElementById('lessonDate').value = toInputDate(new Date());
  document.getElementById('lessonStart').value = '10:00';
  document.getElementById('lessonEnd').value = '11:00';
}

function openNewLessonModal() {
  hideCalHoverPreview();
  activeEvent = null;
  document.getElementById('editModalTitle').textContent = 'הוספת שיעור חדש';
  document.getElementById('lessonId').value            = '';
  document.getElementById('recurringOrigDate').value   = '';
  document.getElementById('recurringOrigStart').value  = '';
  document.getElementById('recurringOrigEnd').value    = '';
  document.getElementById('lessonForm').reset();
  document.getElementById('lessonDate').value   = toInputDate(new Date());
  document.getElementById('lessonStatus').value = 'scheduled';
  document.getElementById('btnDeleteLesson').classList.add('d-none');
  document.getElementById('editAttendanceBlock').classList.remove('d-none');
  const epb = document.getElementById('editPaidDetailsBlock');
  if (epb) epb.classList.remove('d-none');
  setPaid(false);
  setEditAttendance('expected');
  editModal.show();
}

function openNewLessonModalOnDate(dateStr) {
  openNewLessonModal();
  document.getElementById('lessonDate').value = dateStr.slice(0, 10);
  // Pre-fill time if a time was clicked (dateStr includes time in timeGrid)
  if (dateStr.length > 10) {
    document.getElementById('lessonStart').value = dateStr.slice(11, 16);
  }
}

function openFullEditModal(event) {
  hideCalHoverPreview();
  activeEvent = event;
  const p         = event.extendedProps;
  const isRecurring = p.isRecurring === true;

  if (isRecurring) {
    document.getElementById('editModalTitle').textContent = 'אישור שיעור קבוע';
    document.getElementById('lessonId').value            = '';
    document.getElementById('recurringOrigDate').value   = toInputDate(event.start);
    document.getElementById('recurringOrigStart').value  = toInputTime(event.start);
    document.getElementById('recurringOrigEnd').value    = toInputTime(getEventEnd(event));
    document.getElementById('btnDeleteLesson').classList.add('d-none');
    document.getElementById('editAttendanceBlock').classList.add('d-none');
  } else {
    document.getElementById('editModalTitle').textContent = 'עריכת שיעור';
    document.getElementById('lessonId').value            = event.id;
    document.getElementById('recurringOrigDate').value   = '';
    document.getElementById('btnDeleteLesson').classList.remove('d-none');
    const paidLesson = p.isPaid === true;
    document.getElementById('editAttendanceBlock').classList.toggle('d-none', paidLesson);
    setEditAttendance(paidLesson ? 'arrived' : (p.attendance || 'expected'));
  }

  document.getElementById('lessonDate').value   = toInputDate(event.start);
  document.getElementById('lessonStart').value  = toInputTime(event.start);
  document.getElementById('lessonEnd').value    = toInputTime(getEventEnd(event));
  document.getElementById('lessonStatus').value = p.status || 'scheduled';
  document.getElementById('lessonPrice').value  = p.price  || 0;
  document.getElementById('lessonNotes').value  = p.notes  || '';
  setPaid(p.isPaid === true);

  const editablePaid = document.getElementById('editPaidDetailsBlock');
  if (editablePaid) editablePaid.classList.toggle('d-none', isRecurring);
  const lpaidAmt = document.getElementById('lessonPaidAmount');
  const lpaidMeth = document.getElementById('lessonPaymentMethod');
  if (lpaidAmt && !isRecurring) {
    const st = p.paidAmount;
    lpaidAmt.value = st != null && st !== '' ? String(st) : '';
  }
  if (lpaidMeth && !isRecurring) {
    const m = String(p.paymentMethod || 'cash').toLowerCase();
    lpaidMeth.value = ['cash', 'bit', 'paybox', 'other'].includes(m) ? m : 'cash';
  }

  const studentId = String(p.studentId);
  for (const opt of document.getElementById('lessonStudent').options) {
    opt.selected = (opt.value === studentId);
  }

  editModal.show();
}

async function saveLesson() {
  const studentId = document.getElementById('lessonStudent').value;
  if (!studentId) { alert('יש לבחור תלמיד'); return; }

  const lessonId   = document.getElementById('lessonId').value;
  const origDate   = document.getElementById('recurringOrigDate').value;
  const origStart  = document.getElementById('recurringOrigStart').value;
  const origEnd    = document.getElementById('recurringOrigEnd').value;
  const newDate    = document.getElementById('lessonDate').value;
  const newStart   = document.getElementById('lessonStart').value;
  const newEnd     = document.getElementById('lessonEnd').value;

  let url;
  const fd = new FormData();

  if (!lessonId && origDate) {
    // Confirm a recurring slot via full modal
    url = '/api/lessons/confirm-recurring';
    fd.append('student_id',    studentId);
    fd.append('original_date', origDate);
    fd.append('original_start', origStart);
    fd.append('original_end',   origEnd);
    fd.append('new_date',  newDate);
    fd.append('new_start', newStart);
    fd.append('new_end',   newEnd);
    fd.append('price', document.getElementById('lessonPrice').value);
    fd.append('notes', document.getElementById('lessonNotes').value);
  } else if (lessonId) {
    // Update an existing lesson
    url = `/api/lessons/${lessonId}/update`;
    fd.append('student_id',  studentId);
    fd.append('lesson_date', newDate);
    fd.append('start_time',  newStart);
    fd.append('end_time',    newEnd);
    fd.append('status',  document.getElementById('lessonStatus').value);
    const paidEl = document.getElementById('lessonPaid');
    const paidNow = paidEl && paidEl.value === 'true';
    fd.append('is_paid', paidEl.value);
    fd.append('attendance', document.getElementById('lessonAttendance').value);
    fd.append('price',   document.getElementById('lessonPrice').value);
    fd.append('notes',   document.getElementById('lessonNotes').value);
    if (paidNow) {
      fd.append('paid_amount', (document.getElementById('lessonPaidAmount').value || '').trim());
      fd.append('payment_method', (document.getElementById('lessonPaymentMethod').value || 'cash').trim());
    } else {
      fd.append('paid_amount', '');
      fd.append('payment_method', '');
    }
  } else {
    // Create new lesson
    url = '/api/lessons/create';
    fd.append('student_id',  studentId);
    fd.append('lesson_date', newDate);
    fd.append('start_time',  newStart);
    fd.append('end_time',    newEnd);
    fd.append('price', document.getElementById('lessonPrice').value);
    fd.append('notes', document.getElementById('lessonNotes').value);
    fd.append('attendance', document.getElementById('lessonAttendance').value);
    const paidElN = document.getElementById('lessonPaid');
    if (paidElN && paidElN.value === 'true') {
      fd.append('is_paid', 'true');
      fd.append('paid_amount', (document.getElementById('lessonPaidAmount').value || '').trim());
      fd.append('payment_method', (document.getElementById('lessonPaymentMethod').value || 'cash').trim());
    }
  }

  const res = await fetch(url, { method: 'POST', body: fd });
  if (res.ok) {
    editModal.hide();
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירה. נסי שוב.');
  }
}

function setEditAttendance(val) {
  document.getElementById('lessonAttendance').value = val;
  document.getElementById('editChipExpected').classList.toggle('is-selected', val === 'expected');
  document.getElementById('editChipArrived').classList.toggle('is-selected', val === 'arrived');
  document.getElementById('editChipNoShow').classList.toggle('is-selected', val === 'no_show');
}

function togglePaid() {
  setPaid(document.getElementById('lessonPaid').value !== 'true');
}

function setPaid(paid) {
  document.getElementById('lessonPaid').value = paid ? 'true' : 'false';
  const btn = document.getElementById('paidToggleBtn');
  if (paid) {
    btn.className = 'paid';
    btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>שולם ✓';
    if (document.getElementById('editAttendanceBlock') && !document.getElementById('editAttendanceBlock').classList.contains('d-none')) {
      setEditAttendance('arrived');
    }
  } else {
    btn.className = 'unpaid';
    btn.innerHTML = '<i class="bi bi-x-circle me-2"></i>לא שולם';
  }
}

async function deleteLesson() {
  const lessonId = document.getElementById('lessonId').value;
  if (!lessonId) return;
  if (!confirm('למחוק את השיעור מהמערכת? הפעולה סופית.')) return;
  const res = await fetch(`/api/lessons/${lessonId}/delete`, { method: 'POST' });
  if (res.ok) {
    editModal.hide();
    calendar.refetchEvents();
  } else {
    alert('לא ניתן למחוק. נסי שוב.');
  }
}
