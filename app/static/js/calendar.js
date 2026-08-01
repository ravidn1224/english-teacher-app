'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let calendar;
let studentsList = [];
/** From ``/api/students-list`` — used when student.default_price is 0 */
let appDefaultPrices = { individual: 0, group: 0 };
let activeEvent = null;   // event currently shown in detailModal
/** Stable DB id for detail actions after calendar refetch replaces Event objects */
let activeLessonDbId = null;
/** After opening a virtual recurring slot, keep schedule metadata for «עריכת תאריך ושעה» */
let stashScheduleContext = null;
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
let groupPickModal;
let recurringMoveModal;
let recurringDeleteModal;
let pendingRecurringDragChoice = null;
let pendingRecurringDeleteChoice = null;
let calendarUndoToastTimer = null;
let lastCalendarDeleteUndoToken = null;
/** FullCalendar composite event while the group student picker is open */
let groupPickContainerEvent = null;

function getDetailExtendedProps() {
  if (!activeEvent || !activeEvent.extendedProps) return {};
  return activeEvent.extendedProps;
}

function getActiveLessonId() {
  if (activeLessonDbId != null && Number.isFinite(activeLessonDbId)) return activeLessonDbId;
  if (!activeEvent) return NaN;
  const raw = activeEvent.id;
  if (raw == null || String(raw).startsWith('v-')) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function resyncActiveEventAfterCalendarLoad() {
  const modal = document.getElementById('detailModal');
  if (!modal || !modal.classList.contains('show')) return;
  if (activeLessonDbId == null || !Number.isFinite(activeLessonDbId) || !calendar) return;
  const found = calendar.getEventById(String(activeLessonDbId)) || calendar.getEventById(activeLessonDbId);
  if (found) {
    activeEvent = found;
    syncDetPaymentDatasetsFromExtendedProps();
    detRefreshPaymentPanel();
  }
}

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

/** A focused work view, similar to Google Calendar: only the schedule fills the screen. */
function setCalendarWorkView(isExpanded, usesNativeFullscreen) {
  const workspace = document.getElementById('calendarWorkspace');
  const button = document.getElementById('calendarFullscreenBtn');
  if (!workspace) return;
  workspace.classList.toggle('is-fullscreen', isExpanded && usesNativeFullscreen);
  workspace.classList.toggle('is-focus-mode', isExpanded && !usesNativeFullscreen);
  if (button) {
    button.setAttribute('aria-pressed', String(isExpanded));
    button.innerHTML = isExpanded
      ? '<i class="bi bi-fullscreen-exit me-1" aria-hidden="true"></i><span>יציאה ממסך מלא</span>'
      : '<i class="bi bi-arrows-fullscreen me-1" aria-hidden="true"></i><span>מסך מלא</span>';
  }
  if (calendar) {
    calendar.setOption('height', isExpanded ? 'calc(100vh - 64px)' : 'calc(100vh - 190px)');
    requestAnimationFrame(function () { calendar.updateSize(); });
  }
}

function syncCalendarFullscreenState() {
  const workspace = document.getElementById('calendarWorkspace');
  if (!workspace) return;
  const isFullscreen = document.fullscreenElement === workspace || document.webkitFullscreenElement === workspace;
  setCalendarWorkView(isFullscreen, isFullscreen);
}

function toggleCalendarFullscreen() {
  const workspace = document.getElementById('calendarWorkspace');
  if (!workspace) return;
  const isFullscreen = document.fullscreenElement === workspace || document.webkitFullscreenElement === workspace;
  const isFocusMode = workspace.classList.contains('is-focus-mode');
  if (isFullscreen || isFocusMode) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (isFullscreen && exit) exit.call(document);
    else setCalendarWorkView(false, false);
    return;
  }
  const request = workspace.requestFullscreen || workspace.webkitRequestFullscreen;
  if (!request) {
    setCalendarWorkView(true, false);
    return;
  }
  Promise.resolve(request.call(workspace))
    .then(function () {
      window.setTimeout(function () {
        const nativeActive = document.fullscreenElement === workspace || document.webkitFullscreenElement === workspace;
        if (!nativeActive) setCalendarWorkView(true, false);
      }, 100);
    })
    .catch(function () { setCalendarWorkView(true, false); });
}

function askRecurringDragScope(oldStart, newStart, options) {
  if (!recurringMoveModal) return Promise.resolve('cancel');
  const opts = options || {};
  const futureButton = document.querySelector('.recurring-move-choice--future');
  const futureNote = document.getElementById('recurringMoveFutureNote');
  const canMoveFuture =
    opts.allowFuture !== false && toInputDate(newStart) >= toInputDate(oldStart);
  if (futureButton) futureButton.disabled = !canMoveFuture;
  if (futureNote) {
    if (opts.allowFuture === false) {
      futureNote.textContent = 'אפשר להחיל שינוי עתידי רק כאשר כל התלמידים בשיעור הקבוצתי מגיעים מלוח קבוע.';
    } else {
      futureNote.textContent = 'אפשר להחיל שינוי על השיעורים הבאים רק כאשר גוררים את השיעור קדימה או לאותו תאריך.';
    }
    futureNote.classList.toggle('d-none', canMoveFuture);
  }
  return new Promise(function (resolve) {
    pendingRecurringDragChoice = resolve;
    recurringMoveModal.show();
  });
}

function chooseRecurringDragScope(scope) {
  const resolve = pendingRecurringDragChoice;
  pendingRecurringDragChoice = null;
  if (recurringMoveModal) recurringMoveModal.hide();
  if (resolve) resolve(scope === 'future' ? 'future' : 'one');
}

function askRecurringDeleteScope() {
  if (!recurringDeleteModal) return Promise.resolve('cancel');
  return new Promise(function (resolve) {
    pendingRecurringDeleteChoice = resolve;
    recurringDeleteModal.show();
  });
}

function chooseRecurringDeleteScope(scope) {
  const resolve = pendingRecurringDeleteChoice;
  pendingRecurringDeleteChoice = null;
  if (recurringDeleteModal) recurringDeleteModal.hide();
  if (resolve) resolve(scope === 'future' ? 'future' : 'one');
}
window.chooseRecurringDeleteScope = chooseRecurringDeleteScope;

async function deleteLessonByIdWithScope(lessonId, options) {
  const opts = options || {};
  const fd = new FormData();
  let scope = 'one';
  if (opts.recurring === true) {
    scope = await askRecurringDeleteScope();
    if (scope === 'cancel') return { ok: false, cancelled: true };
  } else if (
    !confirm(
      'להסיר את השיעור מהלוח?\n\nשיעור חד־פעמי יימחק לגמרי.'
    )
  ) {
    return { ok: false, cancelled: true };
  }
  fd.append('scope', scope);
  const res = await fetch(`/api/lessons/${lessonId}/delete`, { method: 'POST', body: fd });
  let data = {};
  if (res.ok) {
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
  }
  return { ok: res.ok, cancelled: false, response: res, data: data, scope: scope };
}

function hideCalendarUndoToast() {
  const toast = document.getElementById('calendarUndoToast');
  if (toast) toast.classList.add('d-none');
  if (calendarUndoToastTimer) {
    clearTimeout(calendarUndoToastTimer);
    calendarUndoToastTimer = null;
  }
}
window.hideCalendarUndoToast = hideCalendarUndoToast;

function showCalendarDeleteToast(result) {
  const toast = document.getElementById('calendarUndoToast');
  const text = document.getElementById('calendarUndoToastText');
  const btn = document.getElementById('calendarUndoToastBtn');
  if (!toast || !text || !btn) return;
  const token = result && result.data ? result.data.undo_token : null;
  lastCalendarDeleteUndoToken = token || null;
  text.textContent = result && result.scope === 'future'
    ? 'השיעור והשיעורים הבאים נמחקו'
    : 'השיעור נמחק';
  btn.classList.toggle('d-none', !lastCalendarDeleteUndoToken);
  toast.classList.remove('d-none');
  if (calendarUndoToastTimer) clearTimeout(calendarUndoToastTimer);
  calendarUndoToastTimer = setTimeout(function () {
    hideCalendarUndoToast();
  }, 10000);
}

async function undoLastCalendarDelete() {
  if (!lastCalendarDeleteUndoToken) return;
  const token = lastCalendarDeleteUndoToken;
  lastCalendarDeleteUndoToken = null;
  const fd = new FormData();
  fd.append('token', token);
  const res = await fetch('/api/lessons/delete/undo', { method: 'POST', body: fd });
  if (res.ok) {
    hideCalendarUndoToast();
    calendar.refetchEvents();
  } else {
    const text = document.getElementById('calendarUndoToastText');
    const btn = document.getElementById('calendarUndoToastBtn');
    if (text) text.textContent = 'לא ניתן לבטל את המחיקה';
    if (btn) btn.classList.add('d-none');
  }
}
window.undoLastCalendarDelete = undoLastCalendarDelete;

function groupMemberProps(member) {
  return (member && member.extendedProps) || {};
}

function isRecurringGroupMember(member) {
  const mp = groupMemberProps(member);
  return mp.isRecurring === true && mp.studentId != null && mp.scheduleId != null;
}

function groupMemberLessonId(member) {
  const id = Number(member && member.id);
  return Number.isFinite(id) ? id : null;
}

function buildRecurringMoveForm(member, oldStart, oldEnd, newStart, newEnd) {
  const mp = groupMemberProps(member);
  const fd = new FormData();
  fd.append('student_id', String(mp.studentId));
  fd.append('original_date', toInputDate(oldStart));
  fd.append('original_start', toInputTime(oldStart));
  fd.append('original_end', toInputTime(oldEnd));
  fd.append('new_date', toInputDate(newStart));
  fd.append('new_start', toInputTime(newStart));
  fd.append('new_end', toInputTime(newEnd));
  return fd;
}

async function updateRealGroupMemberLessons(members, newStart, newEnd) {
  const ids = members
    .map(groupMemberLessonId)
    .filter(function (id) {
      return id != null;
    });
  if (!ids.length) return;
  if (ids.length >= 2) {
    const fd = new FormData();
    fd.append('lesson_ids', ids.join(','));
    fd.append('lesson_date', toInputDate(newStart));
    fd.append('start_time', toInputTime(newStart));
    fd.append('end_time', toInputTime(newEnd));
    const res = await fetch('/api/lessons/batch-update-datetime', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('update failed');
    return;
  }
  const fd = new FormData();
  fd.append('lesson_date', toInputDate(newStart));
  fd.append('start_time', toInputTime(newStart));
  fd.append('end_time', toInputTime(newEnd));
  const res = await fetch(`/api/lessons/${ids[0]}/update`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('update failed');
}

async function persistGroupCompositeAfterDragResize(info, members) {
  const oldStart = info.oldEvent.start;
  const oldEnd = getEventEnd(info.oldEvent);
  const newStart = info.event.start;
  const newEnd = getEventEnd(info.event);
  if (!oldStart || !oldEnd || !newStart || !newEnd) throw new Error('bad dates');

  const recurringMembers = members.filter(isRecurringGroupMember);
  const realMembers = members.filter(function (member) {
    return !isRecurringGroupMember(member) && groupMemberLessonId(member) != null;
  });

  if (!recurringMembers.length) {
    if (realMembers.length < 2) throw new Error('composite');
    await updateRealGroupMemberLessons(realMembers, newStart, newEnd);
    return;
  }

  const allMembersCanMoveAsRecurring = recurringMembers.length === members.length;
  const scope = await askRecurringDragScope(oldStart, newStart, {
    allowFuture: allMembersCanMoveAsRecurring,
  });
  if (scope === 'cancel') throw new Error('recur-cancel');

  if (scope === 'future') {
    if (!allMembersCanMoveAsRecurring) throw new Error('recur failed');
  }

  if (allMembersCanMoveAsRecurring) {
    const fd = buildRecurringMoveForm(recurringMembers[0], oldStart, oldEnd, newStart, newEnd);
    fd.append('scope', scope);
    fd.append('members', JSON.stringify(recurringMembers.map(function (member) {
      const mp = groupMemberProps(member);
      const price = mp.price != null && mp.price !== '' ? Number(mp.price) : 0;
      return {
        student_id: mp.studentId,
        schedule_id: mp.scheduleId,
        price: Number.isFinite(price) ? price : 0,
        notes: mp.notes != null ? String(mp.notes) : '',
      };
    })));
    const res = await fetch('/api/lessons/group-recurring/move', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('recur failed');
    return;
  }

  await Promise.all(recurringMembers.map(function (member) {
    const mp = groupMemberProps(member);
    const price = mp.price != null && mp.price !== '' ? Number(mp.price) : 0;
    const fd = buildRecurringMoveForm(member, oldStart, oldEnd, newStart, newEnd);
    fd.append('price', String(Number.isFinite(price) ? price : 0));
    fd.append('notes', mp.notes != null ? String(mp.notes) : '');
    fd.append('is_group_lesson', 'true');
    return fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) throw new Error('recur failed');
      });
  }));
  await updateRealGroupMemberLessons(realMembers, newStart, newEnd);
}

/** Persist lesson after drag or resize (real DB row or confirm recurring slot). */
async function persistLessonAfterDragResize(info) {
  normalizeDroppedTimedLesson(info);
  const ev = info.event;
  const oldEv = info.oldEvent;
  const p = ev.extendedProps || {};

  if (p.isGroupComposite) {
    const members = p.groupMembers || [];
    await persistGroupCompositeAfterDragResize(info, members);
    return;
  }

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
    const scope = await askRecurringDragScope(oldStart, newStart);
    if (scope === 'cancel') throw new Error('recur-cancel');
    const fd = new FormData();
    fd.append('student_id', String(studentId));
    fd.append('original_date', toInputDate(oldStart));
    fd.append('original_start', toInputTime(oldStart));
    fd.append('original_end', toInputTime(oldEnd));
    fd.append('new_date', toInputDate(newStart));
    fd.append('new_start', toInputTime(newStart));
    fd.append('new_end', toInputTime(newEnd));
    let res;
    if (scope === 'future') {
      const scheduleId = Number(p.scheduleId);
      if (!Number.isFinite(scheduleId)) throw new Error('no schedule');
      res = await fetch(`/api/lessons/recurring-schedule/${scheduleId}/split-and-move`, { method: 'POST', body: fd });
    } else {
      const price = p.price != null && p.price !== '' ? Number(p.price) : 0;
      fd.append('price', String(Number.isFinite(price) ? price : 0));
      fd.append('notes', p.notes != null ? String(p.notes) : '');
      const recurLessonType = String(p.studentLessonType || '').toLowerCase();
      const grpRecur =
        p.isGroupLesson === true ||
        recurLessonType === 'group' ||
        recurLessonType === 'both';
      fd.append('is_group_lesson', grpRecur ? 'true' : 'false');
      res = await fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd });
    }
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

/** Safe for text inside HTML body */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Allow only hex colors in inline styles (group row accent). */
function safeCssColor(c) {
  if (c == null || typeof c !== 'string') return '';
  const s = c.trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(s)) return s;
  return '';
}

/** Status pill HTML for calendar event (single or group row). */
function lessonEvTagHtml(p, compact) {
  p = p || {};
  const cls = compact ? 'ev-tag ev-tag--group' : 'ev-tag';
  const att = p.attendance || 'expected';
  if (p.isRecurring) return `<span class="${cls}">🔁 קבוע</span>`;
  if (p.status === 'cancelled') return `<span class="${cls}">✕ בוטל</span>`;
  if (p.isPaid && detailExtendedPropsPartialPayment(p)) {
    return `<span class="${cls}">◐ תשלום חלקי</span>`;
  }
  if (p.isPaid) return `<span class="${cls}">✓ שולם</span>`;
  if (att === 'no_show') return `<span class="${cls}">✕ לא הגיע/ה</span>`;
  if (att === 'arrived') return `<span class="${cls}">הגיע/ה · לא שולם</span>`;
  return `<span class="${cls}">ממתין לסימון</span>`;
}

function groupPickerStudentStatus(p) {
  p = p || {};
  const att = p.attendance || 'expected';
  if (p.status === 'cancelled') {
    return { label: 'בוטל', cls: 'is-cancelled' };
  }
  if (att === 'no_show') {
    return { label: 'לא הגיע/ה', cls: 'is-no-show' };
  }
  if (att === 'arrived' && p.isPaid === true) {
    return { label: 'הגיע/ה - שולם', cls: 'is-arrived-paid' };
  }
  if (att === 'arrived') {
    return { label: 'הגיע/ה - לא שולם', cls: 'is-arrived-unpaid' };
  }
  if (p.isPaid === true) {
    return { label: 'שולם', cls: 'is-paid' };
  }
  return { label: 'ממתין לסימון', cls: 'is-waiting' };
}

/** Last/first name from a merged member or raw calendar row (API may send studentLastName). */
function memberLastName(m) {
  const ep = (m && m.extendedProps) || {};
  if (ep.studentLastName != null && String(ep.studentLastName).trim() !== '') {
    return String(ep.studentLastName).trim();
  }
  const t = (m && m.title ? String(m.title) : '').trim();
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : t;
}

function memberFirstName(m) {
  const ep = (m && m.extendedProps) || {};
  if (ep.studentFirstName != null && String(ep.studentFirstName).trim() !== '') {
    return String(ep.studentFirstName).trim();
  }
  const t = (m && m.title ? String(m.title) : '').trim();
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join(' ');
}

/** Chip line: prefer given name so same-slot siblings (e.g. same surname) stay distinct. */
function memberChipFirstName(m) {
  const fn = memberFirstName(m);
  if (fn) return fn;
  const ln = memberLastName(m);
  if (ln) return ln;
  return (m && m.title ? String(m.title).trim() : '') || '';
}

function memberLastNameFromCalendarEvent(ev) {
  const ep = (ev && ev.extendedProps) || {};
  if (ep.studentLastName != null && String(ep.studentLastName).trim() !== '') {
    return String(ep.studentLastName).trim();
  }
  const t = (ev && ev.title ? String(ev.title) : '').trim();
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : t;
}

function fireMarkConcurrentAsGroup(containerEvent) {
  const p = (containerEvent && containerEvent.extendedProps) || {};
  const members = p.groupMembers || [];
  const ids = members.map(function (m) { return m.id; }).filter(function (id) {
    return /^\d+$/.test(String(id));
  });
  if (ids.length < 2) return;
  const body = new URLSearchParams();
  body.set('lesson_ids', ids.join(','));
  fetch('/api/lessons/mark-concurrent-as-group', {
    method: 'POST',
    body,
    credentials: 'same-origin',
  }).catch(function () {});
}

function openGroupLessonPicker(containerEvent) {
  if (!groupPickModal || !containerEvent) return;
  groupPickContainerEvent = containerEvent;
  fireMarkConcurrentAsGroup(containerEvent);
  const p = containerEvent.extendedProps || {};
  const members = (p.groupMembers || []).slice().sort(function (a, b) {
    return String(memberLastName(a)).localeCompare(String(memberLastName(b)), 'he');
  });
  const list = document.getElementById('groupLessonPickList');
  const timeEl = document.getElementById('groupLessonPickTime');
  if (!list) return;
  list.textContent = '';
  if (timeEl) {
    const endD = getEventEnd(containerEvent);
    timeEl.textContent = `${fmtTime(containerEvent.start)} – ${fmtTime(endD)}`;
  }
  members.forEach(function (m) {
    const mp = (m && m.extendedProps) || {};
    const state = groupPickerStudentStatus(mp);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      `list-group-item list-group-item-action text-start py-2 px-3 group-pick-row ${state.cls}`;
    const line = document.createElement('div');
    line.className = 'group-pick-name-line';
    const status = document.createElement('span');
    status.className = 'group-pick-status';
    status.textContent = state.label;
    line.appendChild(status);
    const last = document.createElement('span');
    last.className = 'group-pick-last';
    last.textContent = memberLastName(m) || m.title || '';
    line.appendChild(last);
    const fn = memberFirstName(m);
    if (fn) {
      const first = document.createElement('span');
      first.className = 'group-pick-first';
      first.textContent = fn;
      line.appendChild(first);
    }
    btn.appendChild(line);
    btn.addEventListener('click', function () {
      groupPickModal.hide();
      const cont = groupPickContainerEvent;
      groupPickContainerEvent = null;
      if (cont) {
        void openDetailCard(buildSyntheticDetailEventFromMember(cont, m), { scrollToPayment: true });
      }
    });
    list.appendChild(btn);
  });
  groupPickModal.show();
}

/**
 * Same start+end → one full-width «group» card (pair/trio lesson) instead of narrow columns.
 */
function mergeConcurrentSlotEvents(events) {
  if (!Array.isArray(events) || events.length < 2) return events;
  const byKey = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const k = `${e.start}|${e.end}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const doneKeys = new Set();
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const k = `${e.start}|${e.end}`;
    if (doneKeys.has(k)) continue;
    doneKeys.add(k);
    const arr = byKey.get(k);
    if (arr.length < 2) {
      out.push(e);
      continue;
    }
    const sorted = arr.slice().sort(function (a, b) {
      const la = memberLastNameFromCalendarEvent(a);
      const lb = memberLastNameFromCalendarEvent(b);
      const c = String(la).localeCompare(String(lb), 'he');
      if (c !== 0) return c;
      return String(a.title || '').localeCompare(String(b.title || ''), 'he');
    });
    const grpId = 'grp:' + sorted.map(function (x) { return String(x.id); }).sort().join(':');
    const members = sorted.map(function (x) {
      return {
        id: x.id,
        title: x.title || '',
        color: x.color,
        textColor: x.textColor,
        borderColor: x.borderColor,
        extendedProps: Object.assign({}, x.extendedProps || {}),
      };
    });
    const base = sorted[0];
    const ex = function (x) {
      return (x && x.extendedProps) || {};
    };
    const allPaid = sorted.every(function (x) {
      return ex(x).isPaid === true;
    });
    const anyPartial = sorted.some(function (x) {
      return ex(x).isPartialPayment === true;
    });
    let compColor = base.color;
    let compText = base.textColor;
    let compBorder = base.borderColor || base.color;
    if (allPaid && anyPartial) {
      compColor = '#EAB308';
      compText = '#1C1917';
      compBorder = '#CA8A04';
    }
    out.push({
      id: grpId,
      title: sorted
        .map(function (x) {
          return x.title;
        })
        .join(' · '),
      start: base.start,
      end: base.end,
      color: compColor,
      borderColor: compBorder,
      textColor: compText,
      editable: true,
      startEditable: true,
      durationEditable: true,
      extendedProps: Object.assign({}, base.extendedProps || {}, {
        isGroupComposite: true,
        groupMembers: members,
        isPartialPayment: allPaid && anyPartial,
      }),
    });
  }
  return out;
}

/** Open detail for one student when clicking a merged slot. */
function buildSyntheticDetailEventFromMember(containerEvent, member) {
  const end = getEventEnd(containerEvent);
  return {
    id: member.id,
    title: member.title,
    start: containerEvent.start,
    end: end,
    allDay: !!containerEvent.allDay,
    extendedProps: Object.assign({}, member.extendedProps || {}, {
      isGroupLesson: true,
    }),
  };
}

function buildMaterializedDetailEvent(originalEvent, data) {
  const p = (originalEvent && originalEvent.extendedProps) || {};
  const startDate = data && data.lesson_date ? String(data.lesson_date) : toInputDate(originalEvent.start);
  const startTime = data && data.start_time ? String(data.start_time).slice(0, 5) : toInputTime(originalEvent.start);
  const endTime = data && data.end_time ? String(data.end_time).slice(0, 5) : toInputTime(getEventEnd(originalEvent));
  const start = new Date(`${startDate}T${startTime}`);
  const end = new Date(`${startDate}T${endTime}`);
  const realProps = Object.assign({}, p, {
    studentId: data && data.student_id != null ? data.student_id : p.studentId,
    status: (data && data.status) || 'scheduled',
    attendance: (data && data.attendance) || 'expected',
    isPaid: data ? data.is_paid === true : false,
    paidAmount: data && data.paid_amount != null ? data.paid_amount : null,
    paymentMethod: (data && data.payment_method) || '',
    paymentNote: (data && data.payment_note) || '',
    notes: (data && data.notes) || '',
    price: data && data.price != null ? data.price : p.price,
    isRecurring: false,
    isFromRecurringSchedule: true,
    isGroupLesson:
      (data && data.is_group_lesson === true) ||
      p.isGroupLesson === true ||
      String(p.studentLessonType || '').toLowerCase() === 'group',
  });
  return {
    id: data && data.id != null ? String(data.id) : String(originalEvent.id || ''),
    title: originalEvent.title || '',
    start,
    end,
    allDay: false,
    extendedProps: realProps,
    setExtendedProp(name, value) {
      this.extendedProps[name] = value;
    },
  };
}

/**
 * Open lesson detail and jump to תשלום. Merged same-slot lessons open a student picker first.
 */
function openDetailFromCalendarEventHit(fcEvent, domTarget, clientX, clientY) {
  const p = (fcEvent && fcEvent.extendedProps) || {};
  if (p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length) {
    openGroupLessonPicker(fcEvent);
    return;
  }
  void openDetailCard(fcEvent, { scrollToPayment: true });
}

/** Hebrew label for payment_method stored in DB */
function paymentMethodLabel(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'cash') return 'מזומן';
  if (c === 'bit') return 'ביט';
  if (c === 'paybox') return 'פייבוקס';
  if (c === 'other') return 'אחר';
  return '';
}

/** Sync payment method chips + hidden <select> + «אחר» note block in lesson detail modal */
function syncDetPaymentMethodUI(method) {
  const sel = document.getElementById('detPaymentMethod');
  const m = String(method || 'cash').toLowerCase();
  const v = ['cash', 'bit', 'paybox', 'other'].includes(m) ? m : 'cash';
  if (sel) sel.value = v;
  document.querySelectorAll('#detailModal .det-pay-chip').forEach(function (btn) {
    const bm = (btn.getAttribute('data-method') || '').toLowerCase();
    btn.classList.toggle('active', bm === v);
  });
  const otherWrap = document.getElementById('detPaymentOtherWrap');
  if (otherWrap) otherWrap.classList.toggle('d-none', v !== 'other');
}

let detBalanceFeedbackTimer = null;

function hideDetPaymentBalanceFeedback() {
  const fb = document.getElementById('detPaymentBalanceFeedback');
  if (fb) {
    fb.classList.add('d-none');
    fb.textContent = '';
    fb.className = 'alert alert-success py-2 px-3 small mt-2 mb-0 d-none';
  }
  if (detBalanceFeedbackTimer) {
    clearTimeout(detBalanceFeedbackTimer);
    detBalanceFeedbackTimer = null;
  }
}

function buildDetPaymentConfirmation(data, newPaid, paidAmountNum, methodCode) {
  const lines = [];
  if (newPaid) {
    const amt = Number(paidAmountNum);
    const a = Number.isFinite(amt) ? amt : 0;
    const lab = paymentMethodLabel(methodCode) || String(methodCode || '');
    lines.push('נרשם: שולם ‎₪' + a + (lab ? ' · ' + lab : ''));
  } else {
    lines.push('נרשם: לא שולם — החוב יתעדכן לפי החיוב.');
  }
  if (data && data.balance_hint_he) lines.push(data.balance_hint_he);
  const balRaw =
    data && (data.family_balance != null ? data.family_balance : data.student_balance);
  if (balRaw != null) {
    const bal = Number(balRaw);
    if (bal < 0) lines.push('החוב יופיע בשיעור הבא.');
    else if (bal > 0) lines.push('הזיכוי יקוזז אוטומטית בשיעור הבא.');
    else lines.push('היתרה מאוזנת.');
  }
  return lines.join('\n');
}

function showDetPaymentBalanceFeedback(message, alertVariant) {
  const fb = document.getElementById('detPaymentBalanceFeedback');
  if (!fb || !message) return;
  fb.textContent = message;
  fb.className =
    'alert py-2 px-3 small mt-2 mb-0 ' + (alertVariant || 'alert-success');
  fb.classList.remove('d-none');
  if (detBalanceFeedbackTimer) clearTimeout(detBalanceFeedbackTimer);
  detBalanceFeedbackTimer = setTimeout(function () {
    hideDetPaymentBalanceFeedback();
  }, 12000);
}

function parseDetMoneyInput(el) {
  if (!el) return NaN;
  const raw = String(el.value || '').trim();
  if (raw === '') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

function getDetailLessonPriceForSubmit() {
  const ch = document.getElementById('detLessonCharge');
  if (ch && !ch.disabled) {
    const v = parseDetMoneyInput(ch);
    if (Number.isFinite(v)) return v;
  }
  const ep = getDetailExtendedProps();
  const p = Number(ep.price);
  return Number.isFinite(p) ? p : 0;
}

/** Valid price from charge field, or null after alert. */
function requireDetailLessonPriceOrAlert() {
  const ch = document.getElementById('detLessonCharge');
  if (ch && !ch.disabled) {
    const v = parseDetMoneyInput(ch);
    if (!Number.isFinite(v)) {
      alert('נא להזין חיוב לשיעור תקין (מספר ≥ 0).');
      return null;
    }
    return v;
  }
  return getDetailLessonPriceForSubmit();
}

function syncDetPaymentDatasetsFromExtendedProps() {
  const wrap = document.getElementById('detPayChargeAndBalance');
  if (!wrap) return;
  const ep = getDetailExtendedProps();
  const fam =
    ep.familyBalance != null && ep.familyBalance !== ''
      ? Number(ep.familyBalance)
      : Number(ep.studentBalance) || 0;
  wrap.dataset.serverStudentBalance = String(Number.isFinite(fam) ? fam : 0);
  wrap.dataset.lessonBalanceApplied = String(
    ep.balanceApplied != null && ep.balanceApplied !== '' ? Number(ep.balanceApplied) : 0
  );
}

/** Family balance before this lesson’s effect: DB balance minus already-applied net for this lesson. */
function detFamilyOpeningBeforeLesson() {
  const wrap = document.getElementById('detPayChargeAndBalance');
  if (!wrap) return 0;
  const fam = Number(wrap.dataset.serverStudentBalance) || 0;
  const applied = Number(wrap.dataset.lessonBalanceApplied) || 0;
  return fam - applied;
}

/**
 * תשלום מוצע = חיוב השיעור − יתרת פתיחה של המשפחה.
 * יתרה חיובית = זיכוי (שילמו יותר בעבר) → פחות לשלם עכשיו.
 * יתרה שלילית = חוב (חסר מהשיעור הקודם) → משלימים בשיעור הנוכחי.
 */
function detSuggestedPayAmount(openingBalance, lessonCharge) {
  const c = Math.max(0, Number(lessonCharge) || 0);
  const b = Number(openingBalance) || 0;
  return Math.max(0, Math.round(c - b));
}

function renderDetChargeTypeLabel() {
  const el = document.getElementById('detChargeTypeLabel');
  if (!el) return;
  const ep = getDetailExtendedProps();
  el.textContent = ep.isGroupLesson === true ? '(קבוצתי)' : '(פרטי)';
}

function renderDetSuggestedPay() {
  const wrap = document.getElementById('detSuggestedPayWrap');
  const badge = document.getElementById('detSuggestedPayBadge');
  if (!wrap || !badge) return;
  let charge = parseDetMoneyInput(document.getElementById('detLessonCharge'));
  if (!Number.isFinite(charge)) charge = 0;
  const opening = detFamilyOpeningBeforeLesson();
  const sug = detSuggestedPayAmount(opening, charge);
  if (charge <= 0) {
    wrap.classList.add('d-none');
    if (badge) badge.removeAttribute('title');
    return;
  }
  wrap.classList.remove('d-none');
  badge.textContent = '‎₪' + sug;
  let hint = '';
  if (opening > 0) {
    hint = `חיוב שיעור ‎₪${charge}, יתרת זיכוי משפחתית ‎₪${opening} — מוצע לתשלום עכשיו ‎₪${sug}.`;
  } else if (opening < 0) {
    hint = `חיוב שיעור ‎₪${charge}, חוב מהעבר ‎₪${-opening} — מוצע לתשלום עכשיו ‎₪${sug} (משלים גם מהשיעור הקודם).`;
  } else {
    hint = `חיוב שיעור ‎₪${charge} — אין יתרה/חוב קודם; מוצע ‎₪${sug}.`;
  }
  badge.setAttribute('title', hint);
}

function renderDetQuickPayRow() {
  const row = document.getElementById('detQuickPayRow');
  if (!row) return;
  let charge = parseDetMoneyInput(document.getElementById('detLessonCharge'));
  if (!Number.isFinite(charge)) charge = 0;
  row.classList.toggle('d-none', charge <= 0);
}

function updateDetAfterPayPreview() {
  const el = document.getElementById('detAfterPayPreview');
  if (!el) return;
  let charge = parseDetMoneyInput(document.getElementById('detLessonCharge'));
  let paid = parseDetMoneyInput(document.getElementById('detPaidAmount'));
  if (!Number.isFinite(charge)) charge = 0;
  if (!Number.isFinite(paid)) paid = 0;
  if (paid <= 0) {
    el.classList.add('d-none');
    el.textContent = '';
    el.className = 'small rounded px-3 py-2 mb-3 d-none';
    return;
  }

  /* מול *תשלום מוצע* (חיוב שיעור ± יתרת משפחה), לא רק מול חיוב השיעור — כדי שהעודף/חוב ישקפו מה יקוזז בשיעור הבא. */
  if (charge > 0) {
    const opening = detFamilyOpeningBeforeLesson();
    const suggested = detSuggestedPayAmount(opening, charge);
    if (paid === suggested) {
      el.classList.add('d-none');
      el.textContent = '';
      el.className = 'small rounded px-3 py-2 mb-3 d-none';
      return;
    }
    if (paid > suggested) {
      const over = paid - suggested;
      el.classList.remove('d-none');
      el.className =
        'small rounded px-3 py-2 mb-3 det-after-pay-preview det-after-pay-preview--credit';
      el.textContent =
        'שולם ‎₪' +
        paid +
        ' לעומת תשלום מוצע ‎₪' +
        suggested +
        ' (חיוב שיעור ‎₪' +
        charge +
        ') — עודף ‎₪' +
        over +
        ' יקוזז בשיעור הבא';
      return;
    }
    const shortfall = suggested - paid;
    el.classList.remove('d-none');
    el.className =
      'small rounded px-3 py-2 mb-3 det-after-pay-preview det-after-pay-preview--debt';
    el.textContent =
      'חוב ‎₪' +
      shortfall +
      ' — שולם ‎₪' +
      paid +
      ' מתוך תשלום מוצע ‎₪' +
      suggested +
      ' (חיוב שיעור ‎₪' +
      charge +
      ') — יועבר לשיעור הבא';
    return;
  }

  el.classList.remove('d-none');
  el.className =
    'small rounded px-3 py-2 mb-3 det-after-pay-preview det-after-pay-preview--credit';
  el.textContent = 'סכום הוזן בלי חיוב לשיעור — היתרה תתעדכן בשמירה.';
}

/** עודף תמיד נשאר כזיכוי למשפחה — אין «הוחזר עודף במזומן» בממשק. */
function appendDetChangeGivenToFormData(fd) {
  fd.append('change_given', 'false');
}

function detRefreshPaymentPanel() {
  renderDetChargeTypeLabel();
  renderDetSuggestedPay();
  renderDetQuickPayRow();
  updateDetAfterPayPreview();
}

/** תשלום חלקי: שולם וסכום בפועל &lt; חיוב (לפי extendedProps או שדות בטופס). */
function detailExtendedPropsPartialPayment(p) {
  p = p || {};
  if (p.isPartialPayment === true) return true;
  if (p.isPartialPayment === false) return false;
  if (!p.isPaid) return false;
  const c = p.price != null && p.price !== '' ? Number(p.price) : 0;
  if (!Number.isFinite(c) || c <= 0) return false;
  const stored = p.paidAmount != null && p.paidAmount !== '' ? Number(p.paidAmount) : NaN;
  const pAmt = Number.isFinite(stored) ? stored : c;
  return pAmt < c;
}

function syncDetailModalHeaderState() {
  const header = document.getElementById('detHeader');
  if (!header) return;
  const p = getDetailExtendedProps();
  const att = p.attendance || 'expected';
  const cancelled = p.status === 'cancelled';
  header.classList.remove(
    's-paid',
    's-partial-paid',
    's-attended',
    's-expected',
    's-no-show',
    's-recurring',
    's-cancelled'
  );
  if (cancelled) header.classList.add('s-cancelled');
  else if (p.isPaid && detailExtendedPropsPartialPayment(p)) header.classList.add('s-partial-paid');
  else if (p.isPaid) header.classList.add('s-paid');
  else if (att === 'no_show') header.classList.add('s-no-show');
  else if (att === 'arrived') header.classList.add('s-attended');
  else header.classList.add('s-expected');
}

/** Refresh badges, suggested pay, and live «אחרי תשלום» preview. */
function updateDetBalancePreview() {
  detRefreshPaymentPanel();
}

async function readLessonUpdateJson(res) {
  try {
    const t = await res.text();
    if (!t) return {};
    return JSON.parse(t);
  } catch (e) {
    return {};
  }
}

function mergeLessonBalanceFromResponse(data) {
  if (!data || typeof activeEvent.setExtendedProp !== 'function') return;
  const fb =
    data.family_balance != null ? data.family_balance : data.student_balance;
  if (fb != null) {
    activeEvent.setExtendedProp('familyBalance', fb);
    activeEvent.setExtendedProp('studentBalance', fb);
  }
  if (data.lesson_balance_applied != null) {
    activeEvent.setExtendedProp('balanceApplied', data.lesson_balance_applied);
  }
  if (data.change_given != null) {
    activeEvent.setExtendedProp('changeGiven', !!data.change_given);
  }
  if (data.is_partial_payment != null) {
    activeEvent.setExtendedProp('isPartialPayment', !!data.is_partial_payment);
  }
}

function syncDetailPriceFromChargeInput() {
  const ch = document.getElementById('detLessonCharge');
  if (!ch || ch.disabled || typeof activeEvent.setExtendedProp !== 'function') return;
  const v = parseDetMoneyInput(ch);
  if (Number.isFinite(v)) activeEvent.setExtendedProp('price', v);
}

/** Refresh balance preview from server numbers; optional payment hint. */
function mergeLessonUpdateIntoDetailUi(data, options) {
  if (!data || typeof data !== 'object') return;
  mergeLessonBalanceFromResponse(data);
  syncDetPaymentDatasetsFromExtendedProps();
  syncDetailPriceFromChargeInput();
  updateDetBalancePreview();
  if (options && options.showBalanceHint && data.balance_hint_he) {
    showDetPaymentBalanceFeedback(data.balance_hint_he);
  }
}

function bumpLessonEndFromStart() {
  const startEl = document.getElementById('lessonStart');
  const endEl = document.getElementById('lessonEnd');
  if (!startEl || !endEl || !startEl.value) return;
  const parts = startEl.value.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h)) return;
  const d = new Date(2000, 0, 1, h, Number.isFinite(m) ? m : 0);
  d.setHours(d.getHours() + 1);
  endEl.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function setEditModalSize(compact) {
  const dlg = document.getElementById('editModalDialog');
  if (!dlg) return;
  dlg.classList.remove('modal-sm', 'modal-lg', 'cal-edit-modal--create');
  if (compact) dlg.classList.add('cal-edit-modal--create');
  else dlg.classList.add('modal-lg');
}

function syncLessonCustomFreqFields() {
  const freqEl = document.getElementById('lessonCustomFreq');
  const monthlyWrap = document.getElementById('lessonMonthlyDayWrap');
  const biHint = document.getElementById('lessonBiweeklyHint');
  if (!freqEl || !monthlyWrap) return;
  const v = freqEl.value;
  monthlyWrap.classList.toggle('d-none', v !== 'monthly');
  if (biHint) biHint.classList.toggle('d-none', v !== 'biweekly');
}

function syncLessonCreateTypeHints() {
  const onceR = document.getElementById('lessonTypeOnce');
  const recurR = document.getElementById('lessonTypeRecur');
  const customR = document.getElementById('lessonTypeCustom');
  const recurHint = document.getElementById('lessonRecurHint');
  const customWrap = document.getElementById('lessonCustomRecurWrap');
  const recurStartWrap = document.getElementById('lessonRecurStartWrap');
  const showRecurStart =
    (recurR && recurR.checked) || (customR && customR.checked);
  if (recurHint) {
    recurHint.classList.toggle('d-none', !(recurR && recurR.checked));
  }
  if (customWrap) {
    customWrap.classList.toggle('d-none', !(customR && customR.checked));
  }
  if (recurStartWrap) {
    recurStartWrap.classList.toggle('d-none', !showRecurStart);
  }
  if (showRecurStart) {
    syncLessonRecurStartFromLessonDateIfPristine();
  }
  if (customR && customR.checked) {
    syncLessonCustomFreqFields();
  }
}

function getLessonRecurStartIso(fallbackDateStr) {
  const el = document.getElementById('lessonRecurStartDate');
  const v = el && el.value ? String(el.value).trim() : '';
  if (v && v.length >= 10) return v.slice(0, 10);
  const fb = String(fallbackDateStr || '').trim();
  return fb.length >= 10 ? fb.slice(0, 10) : '';
}

function syncLessonRecurStartFromLessonDateIfPristine() {
  const startEl = document.getElementById('lessonRecurStartDate');
  const dateEl = document.getElementById('lessonDate');
  if (!startEl || !dateEl) return;
  if (startEl.dataset.userEdited === '1') return;
  const d = dateEl.value;
  if (d && d.length >= 10) startEl.value = d;
}

function clearLessonRecurStartUserEdited() {
  const startEl = document.getElementById('lessonRecurStartDate');
  if (startEl) delete startEl.dataset.userEdited;
}

function markLessonRecurStartUserEdited() {
  const startEl = document.getElementById('lessonRecurStartDate');
  if (startEl) startEl.dataset.userEdited = '1';
}

function appendRecurringStartToFormData(fd, fallbackDateStr) {
  const iso = getLessonRecurStartIso(fallbackDateStr);
  if (iso) fd.append('recurring_start_date', iso);
}

/** App day_of_week (0=Sun … 6=Sat) from lesson_date YYYY-MM-DD — matches RegularSchedule + student page. */
function dateStringToAppDayOfWeek(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length < 3) return 0;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  const dt = new Date(y, m - 1, d);
  const jsDow = dt.getDay();
  const pythonWd = (jsDow + 6) % 7;
  return (pythonWd + 1) % 7;
}

/** FormData for POST /api/lessons/recurring-schedule/add — same rules as «הוספת שיעור». */
function buildRecurringScheduleAddFormData(studentId, newDate, newStart, newEnd, isCustomRecur) {
  const fd = new FormData();
  fd.append('student_id', studentId);
  fd.append('day_of_week', String(dateStringToAppDayOfWeek(newDate)));
  fd.append('start_time', newStart);
  fd.append('end_time', newEnd);
  if (isCustomRecur) {
    const freqEl = document.getElementById('lessonCustomFreq');
    const freq = freqEl && freqEl.value ? freqEl.value : 'biweekly';
    fd.append('frequency', freq);
    if (freq === 'biweekly') {
      fd.append('anchor_date', newDate);
    } else if (freq === 'monthly') {
      const mdEl = document.getElementById('lessonMonthlyDay');
      const dom = mdEl ? parseInt(String(mdEl.value).trim(), 10) : NaN;
      if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
        return null;
      }
      fd.append('day_of_month', String(dom));
    }
  } else {
    fd.append('frequency', 'weekly');
  }
  appendRecurringStartToFormData(fd, newDate);
  return fd;
}

function effectiveDefaultPriceForStudent(rec, forGroup) {
  const ind = Number(appDefaultPrices.individual) || 0;
  const grp = Number(appDefaultPrices.group) || 0;
  const wantGroup = forGroup === true;
  if (!rec) return wantGroup ? (grp > 0 ? grp : ind) : ind;
  if (wantGroup) {
    const dg = rec.default_price_group;
    if (dg != null && dg !== '' && Number(dg) > 0) return Number(dg);
    return grp > 0 ? grp : ind;
  }
  const dp = rec.default_price;
  if (dp != null && dp !== '' && Number(dp) > 0) return Number(dp);
  return ind > 0 ? ind : grp;
}

/**
 * Real lessons must display their saved charge.  Defaults are only a suggestion
 * for virtual recurring slots and newly created lessons.
 */
function groupSlotDisplayPriceForMember(memberLike) {
  const ep = (memberLike && memberLike.extendedProps) || {};
  const raw = ep.price;
  if (ep.isRecurring !== true && raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const sid = ep.studentId;
  if (sid != null && sid !== '') {
    const rec = studentsList.find(function (s) {
      return String(s.id) === String(sid);
    });
    if (rec) {
      return effectiveDefaultPriceForStudent(rec, true);
    }
  }
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const grp = Number(appDefaultPrices.group) || 0;
  const ind = Number(appDefaultPrices.individual) || 0;
  return grp > 0 ? grp : ind;
}

function updateCalendarStatusStrip(events) {
  const totals = { all: 0, waiting: 0, unpaid: 0, partial: 0 };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  (events || []).forEach(function (event) {
    const p = event.extendedProps || {};
    const members = p.isGroupComposite && Array.isArray(p.groupMembers)
      ? p.groupMembers
      : [event];
    members.forEach(function (member) {
      const mp = member.extendedProps || {};
      if (mp.status === 'cancelled') return;
      totals.all += 1;
      if (mp.isRecurring === true) return;
      const start = member.start || event.start;
      const startDay = start instanceof Date
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate())
        : null;
      const beforeOrToday = startDay instanceof Date && startDay <= today;
      if (beforeOrToday && (mp.attendance || 'expected') === 'expected') totals.waiting += 1;
      if ((mp.attendance || 'expected') === 'arrived' && !mp.isPaid) totals.unpaid += 1;
      if (detailExtendedPropsPartialPayment(mp)) totals.partial += 1;
    });
  });

  const ids = {
    all: 'calStatAll',
    waiting: 'calStatWaiting',
    unpaid: 'calStatUnpaid',
    partial: 'calStatPartial',
  };
  Object.keys(ids).forEach(function (key) {
    const el = document.getElementById(ids[key]);
    if (el) el.textContent = String(totals[key]);
  });
}

function lessonModalGroupChecked() {
  const cb = document.getElementById('lessonModalIsGroup');
  return !!(cb && cb.checked);
}

function syncLessonPriceFromStudentId(studentId) {
  const priceEl = document.getElementById('lessonPrice');
  if (!priceEl) return;
  const rec = studentsList.find(function (s) {
    return String(s.id) === String(studentId);
  });
  const forGroup = lessonModalGroupChecked();
  const pr = effectiveDefaultPriceForStudent(rec, forGroup);
  priceEl.value = String(pr > 0 ? pr : 0);
}

function syncLessonModalGroupFromStudent(rec) {
  const cb = document.getElementById('lessonModalIsGroup');
  if (!cb) return;
  if (!rec) {
    cb.checked = false;
    return;
  }
  const lessonType = String(rec.lesson_type || 'individual').toLowerCase();
  cb.checked = lessonType === 'group' || lessonType === 'both';
}

function lessonStudentDropdownOpen(open) {
  const dd = document.getElementById('lessonStudentDropdown');
  const inp = document.getElementById('lessonStudentSearch');
  if (!dd || !inp) return;
  if (open) {
    dd.classList.remove('d-none');
    inp.setAttribute('aria-expanded', 'true');
  } else {
    dd.classList.add('d-none');
    inp.setAttribute('aria-expanded', 'false');
  }
}

function renderLessonStudentDropdown(filterText) {
  const dd = document.getElementById('lessonStudentDropdown');
  if (!dd) return;
  const q = String(filterText || '').trim().toLowerCase();
  dd.innerHTML = '';
  const frag = document.createDocumentFragment();
  let any = false;
  studentsList.forEach(function (s) {
    const name = s.name || '';
    if (q && !name.toLowerCase().includes(q)) return;
    any = true;
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = 'cal-student-dropdown__item';
    li.setAttribute('data-id', String(s.id));
    li.textContent = name;
    frag.appendChild(li);
  });
  if (!any) {
    const li = document.createElement('li');
    li.className = 'cal-student-dropdown__empty text-muted small px-3 py-2';
    li.textContent = q ? 'אין תוצאות — נסי טקסט אחר' : 'אין תלמידים ברשימה';
    frag.appendChild(li);
  }
  dd.appendChild(frag);
}

function setLessonStudentComboboxValue(studentId, skipPriceSync) {
  const hidden = document.getElementById('lessonStudent');
  const search = document.getElementById('lessonStudentSearch');
  if (!hidden || !search) return;
  if (studentId == null || studentId === '') {
    hidden.value = '';
    search.value = '';
    lessonStudentDropdownOpen(false);
    syncLessonModalGroupFromStudent(null);
    return;
  }
  const rec = studentsList.find(function (s) {
    return String(s.id) === String(studentId);
  });
  hidden.value = String(studentId);
  search.value = rec ? rec.name : '';
  lessonStudentDropdownOpen(false);
  syncLessonModalGroupFromStudent(rec);
  if (!skipPriceSync) syncLessonPriceFromStudentId(studentId);
}

function setupLessonStudentCombobox() {
  const wrap = document.querySelector('.cal-student-combobox');
  const search = document.getElementById('lessonStudentSearch');
  const dd = document.getElementById('lessonStudentDropdown');
  if (!wrap || !search || !dd) return;
  if (wrap.dataset.comboBound) return;
  wrap.dataset.comboBound = '1';

  search.addEventListener('focus', function () {
    renderLessonStudentDropdown(search.value);
    lessonStudentDropdownOpen(true);
  });

  search.addEventListener('input', function () {
    renderLessonStudentDropdown(search.value);
    lessonStudentDropdownOpen(true);
    const hidden = document.getElementById('lessonStudent');
    if (hidden) {
      const rec = studentsList.find(function (s) {
        return String(s.id) === hidden.value;
      });
      if (!rec || rec.name !== search.value.trim()) {
        hidden.value = '';
      }
    }
  });

  dd.addEventListener('mousedown', function (e) {
    const item = e.target.closest('.cal-student-dropdown__item');
    if (!item) return;
    e.preventDefault();
    const id = item.getAttribute('data-id');
    if (id) {
      setLessonStudentComboboxValue(id);
    }
  });

  document.addEventListener(
    'click',
    function (e) {
      if (!wrap.contains(e.target)) lessonStudentDropdownOpen(false);
    },
    true
  );

  search.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      lessonStudentDropdownOpen(false);
      search.blur();
    }
  });
}

function setupLessonModalGroupCheckbox() {
  const cb = document.getElementById('lessonModalIsGroup');
  if (!cb || cb.dataset.calBound) return;
  cb.dataset.calBound = '1';
  cb.addEventListener('change', function () {
    const sid = document.getElementById('lessonStudent');
    if (sid && sid.value) syncLessonPriceFromStudentId(sid.value);
  });
}

function bindLessonFormTimeControls() {
  const startEl = document.getElementById('lessonStart');
  if (startEl && !startEl.dataset.calEndBound) {
    startEl.dataset.calEndBound = '1';
    startEl.addEventListener('change', bumpLessonEndFromStart);
    startEl.addEventListener('input', bumpLessonEndFromStart);
  }
  document.querySelectorAll('.cal-time-picker-btn').forEach(function (btn) {
    if (btn.dataset.calBound) return;
    btn.dataset.calBound = '1';
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-time-target');
      const inp = id && document.getElementById(id);
      if (inp && typeof inp.showPicker === 'function') {
        try {
          inp.showPicker();
        } catch (e) {
          inp.focus();
        }
      } else if (inp) {
        inp.focus();
      }
    });
  });
}

function detPaymentNoteForSubmit() {
  const sel = document.getElementById('detPaymentMethod');
  const pm = (sel && sel.value ? sel.value : 'cash').trim();
  if (pm !== 'other') return '';
  const ta = document.getElementById('detPaymentOtherNote');
  return (ta && ta.value ? ta.value : '').trim();
}

/** Native tooltip (title) — shown on hover */
function eventHoverTitle(ev) {
  const p = ev.extendedProps || {};
  if (p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length) {
    const endT = getEventEnd(ev);
    const lines = p.groupMembers.map(function (m) {
      const pr = groupSlotDisplayPriceForMember(m);
      const priceStr = Number.isFinite(pr) ? ` · ${pr} ₪` : '';
      return `${m.title || ''} — ${memberStatusLabelHe(m.extendedProps || {})}${priceStr}`;
    });
    return (
      lines.join('\n') +
      `\n${fmtTime(ev.start)} – ${fmtTime(endT)}\n` +
      'שיעור קבוצתי — לחיצה לבחירת תלמיד ותשלום'
    );
  }
  const name = ev.title || '';
  const start = fmtTime(ev.start);
  const endT = getEventEnd(ev);
  const end = fmtTime(endT);
  let status = '';
  if (p.isRecurring) status = 'שיעור קבוע';
  else if (p.status === 'cancelled') status = 'בוטל';
  else if (p.isPaid && detailExtendedPropsPartialPayment(p)) status = 'תשלום חלקי';
  else if (p.isPaid) status = 'שולם';
  else if ((p.attendance || 'expected') === 'no_show') status = 'לא הגיע/ה';
  else if (p.attendance === 'arrived') status = 'הגיע/ה · לא שולם';
  else status = 'ממתין לסימון';
  const price = p.price ? ` · ${p.price} ₪` : '';
  let payExtra = '';
  if (p.isPaid) {
    const amt = p.paidAmount != null && p.paidAmount !== '' ? Number(p.paidAmount) : p.price;
    let pm = paymentMethodLabel(p.paymentMethod);
    if ((p.paymentMethod || '').toLowerCase() === 'other' && p.paymentNote) {
      pm = `אחר: ${String(p.paymentNote).trim()}`;
    }
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

/** Hebrew status from extendedProps (hover list, chips, tooltips). */
function memberStatusLabelHe(p) {
  p = p || {};
  const att = p.attendance || 'expected';
  if (p.isRecurring) return 'שיעור קבוע';
  if (p.status === 'cancelled') return 'בוטל';
  if (p.isPaid && detailExtendedPropsPartialPayment(p)) return 'תשלום חלקי';
  if (p.isPaid) return 'שולם';
  if (att === 'no_show') return 'לא הגיע/ה';
  if (p.attendance === 'arrived') return 'הגיע/ה · לא שולם';
  return 'ממתין לסימון';
}

/** Short status line for hover preview (single event). */
function eventStatusSummary(ev) {
  return memberStatusLabelHe(ev.extendedProps || {});
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
  el.classList.remove('cal-hover-preview--group');
  const listWrap = document.getElementById('calHoverPreviewListWrap');
  const listEl = document.getElementById('calHoverPreviewList');
  const nameEl = document.getElementById('calHoverPreviewName');
  const statusEl = document.getElementById('calHoverPreviewStatus');
  if (listWrap) listWrap.classList.add('d-none');
  if (listEl) listEl.textContent = '';
  if (nameEl) nameEl.classList.remove('d-none');
  if (statusEl) statusEl.classList.remove('d-none');
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
  const labelEl = document.getElementById('calHoverPreviewLabel');
  const nameEl = document.getElementById('calHoverPreviewName');
  const listWrap = document.getElementById('calHoverPreviewListWrap');
  const listEl = document.getElementById('calHoverPreviewList');
  const timeEl = document.getElementById('calHoverPreviewTime');
  const statusEl = document.getElementById('calHoverPreviewStatus');
  const hintEl = document.getElementById('calHoverPreviewHint');
  if (!el || !nameEl || !timeEl || !statusEl) return;

  const endT = getEventEnd(ev);
  const start = fmtTime(ev.start);
  const end = fmtTime(endT);
  const p = ev.extendedProps || {};
  const priceLine = p.price != null && p.price !== '' ? ` · ${p.price} ₪` : '';

  if (p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length) {
    el.classList.add('cal-hover-preview--group');
    if (labelEl) labelEl.textContent = 'שיעור קבוצתי';
    nameEl.textContent = '';
    nameEl.classList.add('d-none');
    statusEl.textContent = '';
    statusEl.classList.add('d-none');
    if (listWrap && listEl) {
      listWrap.classList.remove('d-none');
      listEl.textContent = '';
      p.groupMembers.forEach(function (m) {
        const mp = m.extendedProps || {};
        const li = document.createElement('li');
        const lead = document.createElement('div');
        lead.className = 'cal-hover-preview__li-lead';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'cal-hover-preview__li-name cal-hover-preview__li-name--last';
        nameSpan.textContent = memberLastName(m) || m.title || '';
        lead.appendChild(nameSpan);
        const fn = memberFirstName(m);
        if (fn) {
          const sub = document.createElement('span');
          sub.className = 'cal-hover-preview__li-first';
          sub.textContent = ` ${fn}`;
          lead.appendChild(sub);
        }
        const meta = document.createElement('span');
        meta.className = 'cal-hover-preview__li-meta';
        let metaParts = memberStatusLabelHe(mp);
        const dispPr = groupSlotDisplayPriceForMember(m);
        if (Number.isFinite(dispPr)) metaParts += ' · ' + dispPr + ' ₪';
        meta.textContent = metaParts;
        li.appendChild(lead);
        li.appendChild(meta);
        listEl.appendChild(li);
      });
    }
    timeEl.textContent = `${start} – ${end}`;
    if (hintEl) hintEl.textContent = 'לחיצה לבחירת תלמיד ופתיחת תשלום';
  } else {
    el.classList.remove('cal-hover-preview--group');
    if (labelEl) labelEl.textContent = 'תצוגה מקדימה';
    nameEl.classList.remove('d-none');
    statusEl.classList.remove('d-none');
    if (listWrap) listWrap.classList.add('d-none');
    if (listEl) listEl.textContent = '';
    nameEl.textContent = ev.title || '(ללא שם)';
    timeEl.textContent = `${start} – ${end}${priceLine}`;
    statusEl.textContent = eventStatusSummary(ev);
    if (hintEl) hintEl.textContent = 'לחיצה לפתיחת פרטים';
  }

  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  if (listWrap) {
    listWrap.setAttribute(
      'aria-hidden',
      p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length ? 'false' : 'true'
    );
  }
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
  const data = await fetchJsonWithRetry('/api/students-list', {});
  if (Array.isArray(data)) {
    studentsList = data;
    appDefaultPrices = { individual: 0, group: 0 };
  } else {
    studentsList = data.students || [];
    appDefaultPrices = {
      individual: Number((data.defaults && data.defaults.individual) || 0) || 0,
      group: Number((data.defaults && data.defaults.group) || 0) || 0,
    };
  }
  renderLessonStudentDropdown('');
  setupLessonStudentCombobox();
  setupLessonModalGroupCheckbox();
}

// ── Calendar init ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
  editModal   = new bootstrap.Modal(document.getElementById('editModal'));
  const groupPickEl = document.getElementById('groupLessonPickModal');
  if (groupPickEl) {
    groupPickModal = new bootstrap.Modal(groupPickEl);
    groupPickEl.addEventListener('hidden.bs.modal', function () {
      groupPickContainerEvent = null;
    });
  }
  const recurringMoveEl = document.getElementById('recurringMoveModal');
  if (recurringMoveEl) {
    recurringMoveModal = new bootstrap.Modal(recurringMoveEl);
    recurringMoveEl.addEventListener('hidden.bs.modal', function () {
      if (!pendingRecurringDragChoice) return;
      const resolve = pendingRecurringDragChoice;
      pendingRecurringDragChoice = null;
      resolve('cancel');
    });
  }
  const recurringDeleteEl = document.getElementById('recurringDeleteModal');
  if (recurringDeleteEl) {
    recurringDeleteModal = new bootstrap.Modal(recurringDeleteEl);
    recurringDeleteEl.addEventListener('hidden.bs.modal', function () {
      if (!pendingRecurringDeleteChoice) return;
      const resolve = pendingRecurringDeleteChoice;
      pendingRecurringDeleteChoice = null;
      resolve('cancel');
    });
  }
  document.getElementById('detailModal').addEventListener('hidden.bs.modal', function () {
    activeLessonDbId = null;
  });
  bindLessonFormTimeControls();
  setupLessonModalGroupCheckbox();

  const detPmSel = document.getElementById('detPaymentMethod');
  if (detPmSel) {
    detPmSel.addEventListener('change', function () {
      syncDetPaymentMethodUI(detPmSel.value);
    });
  }
  document.querySelectorAll('#detailModal .det-pay-chip').forEach(function (btn) {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const m = btn.getAttribute('data-method');
      if (!m) return;
      const sel = document.getElementById('detPaymentMethod');
      if (sel) sel.value = m;
      syncDetPaymentMethodUI(m);
    });
  });
  document.querySelectorAll('#detailModal .det-quick-pay').forEach(function (btn) {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const pa = document.getElementById('detPaidAmount');
      if (!pa) return;
      let charge = parseDetMoneyInput(document.getElementById('detLessonCharge'));
      if (!Number.isFinite(charge)) charge = 0;
      const opening = detFamilyOpeningBeforeLesson();
      const sug = detSuggestedPayAmount(opening, charge);
      if (btn.getAttribute('data-amt-suggest') != null) pa.value = String(sug);
      else if (btn.getAttribute('data-amt-zero') != null) pa.value = '0';
      detRefreshPaymentPanel();
    });
  });
  (function bindDetPaymentPreviewInputs() {
    const ch = document.getElementById('detLessonCharge');
    const pa = document.getElementById('detPaidAmount');
    function onInput() {
      updateDetBalancePreview();
    }
    if (ch && !ch.dataset.previewBound) {
      ch.dataset.previewBound = '1';
      ch.addEventListener('input', onInput);
    }
    if (pa && !pa.dataset.previewBound) {
      pa.dataset.previewBound = '1';
      pa.addEventListener('input', onInput);
    }
  })();

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
      /* RTL: DOM order Day→Week→Month renders as Month | Week | Day left→right */
      end: 'timeGridDay,timeGridWeek,dayGridMonth',
    },
    buttonText: { today: 'היום', month: 'חודש', week: 'שבוע', day: 'יום' },
    /* Full day in week/day views (was 07:00–22:00, which hid early/late lessons) */
    slotMinTime: '00:00:00',
    slotMaxTime: '24:00:00',
    allDaySlot: false,
    /* Fixed-ish height helps the “now” line layout; auto height often hides the indicator */
    height: 'calc(100vh - 190px)',
    expandRows: true,
    displayEventEnd: true,
    /* No eventMinHeight: a pixel floor makes 1h blocks taller than their real duration (~+15min visually). */
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
          if (err && err.message === 'composite') return;
          if (err && err.message === 'recur-cancel') return;
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
        .catch(function (err) {
          info.revert();
          if (err && err.message === 'composite') return;
          if (err && err.message === 'recur-cancel') return;
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
      const p = info.event.extendedProps || {};
      /* Native title = dark browser tooltip; merged slots use only the white hover card for the full list. */
      el.setAttribute('data-event-id', String(info.event.id));
      let aria;
      if (p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length) {
        el.removeAttribute('title');
        const endT = getEventEnd(info.event);
        aria = `שיעור קבוצתי, ${p.groupMembers.length} תלמידים, ${fmtTime(info.event.start)}–${fmtTime(endT)}`;
      } else {
        const tip = eventHoverTitle(info.event);
        el.setAttribute('title', tip);
        aria = tip.replace(/\n/g, ' — ');
      }
      el.setAttribute('aria-label', aria);
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
      const p = info.event.extendedProps || {};
      let time;
      if (info.event.allDay) {
        time = fmtTime(info.event.start);
      } else {
        const endD = getEventEnd(info.event);
        time =
          endD instanceof Date && !isNaN(endD.getTime())
            ? `${fmtTime(info.event.start)} – ${fmtTime(endD)}`
            : fmtTime(info.event.start);
      }

      if (p.isGroupComposite && Array.isArray(p.groupMembers) && p.groupMembers.length) {
        const chipNames = p.groupMembers
          .map(memberChipFirstName)
          .filter(function (s) { return s; });
        const namesLine = escHtml(chipNames.join(' · '));
        return {
          html: `<div class="ev-inner ev-inner--group" data-event-id="${escAttr(info.event.id)}">
          <div class="ev-time">${time}</div>
          <div class="ev-group-lesson-label">שיעור קבוצתי</div>
          <div class="ev-group-names-small">${namesLine}</div>
        </div>`,
        };
      }

      const name = info.event.title;

      return {
        html: `<div class="ev-inner" data-event-id="${escAttr(info.event.id)}">
          <div class="ev-time">${time}</div>
          <div class="ev-title-row">
            <div class="ev-name">${escHtml(name || '')}</div>
          </div>
        </div>`,
      };
    },

    events: function (fetchInfo, successCallback, failureCallback) {
      const q = `start=${encodeURIComponent(fetchInfo.startStr)}&end=${encodeURIComponent(fetchInfo.endStr)}`;
      fetchJsonWithRetry(`/api/lessons?${q}`, {})
        .then(function (rows) {
          successCallback(mergeConcurrentSlotEvents(rows));
        })
        .catch(failureCallback);
    },

    eventsSet: function (events) {
      updateCalendarStatusStrip(events);
      requestAnimationFrame(resyncActiveEventAfterCalendarLoad);
    },

    // ── Click on existing event → detail card ────────────────────
    eventClick: function (info) {
      info.jsEvent.preventDefault();
      info.jsEvent.stopPropagation();
      const p = info.event.extendedProps || {};
      if (p.isRecurring === true && info.jsEvent.altKey) {
        openFullEditModal(info.event, null);
        return;
      }
      openDetailFromCalendarEventHit(
        info.event,
        info.jsEvent.target,
        info.jsEvent.clientX,
        info.jsEvent.clientY
      );
    },

    // ── Click on empty slot → new lesson form ────────────────────
    dateClick: function (info) {
      const evObj = resolveEventFromClientPoint(info.jsEvent.clientX, info.jsEvent.clientY);
      if (evObj) {
        openDetailFromCalendarEventHit(evObj, null, info.jsEvent.clientX, info.jsEvent.clientY);
        return;
      }
      openNewLessonModalOnDate(info.dateStr);
    },
  });

  calendar.render();
  document.addEventListener('fullscreenchange', syncCalendarFullscreenState);
  document.addEventListener('webkitfullscreenchange', syncCalendarFullscreenState);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    const workspace = document.getElementById('calendarWorkspace');
    if (workspace && workspace.classList.contains('is-focus-mode')) setCalendarWorkView(false, false);
  });
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

  const onceRadio = document.getElementById('lessonTypeOnce');
  const recurRadio = document.getElementById('lessonTypeRecur');
  const customRadio = document.getElementById('lessonTypeCustom');
  const freqSel = document.getElementById('lessonCustomFreq');
  const lessonDateEl = document.getElementById('lessonDate');
  if (onceRadio)
    onceRadio.addEventListener('change', function () {
      syncLessonCreateTypeHints();
    });
  if (recurRadio)
    recurRadio.addEventListener('change', function () {
      clearLessonRecurStartUserEdited();
      syncLessonRecurStartFromLessonDateIfPristine();
      syncLessonCreateTypeHints();
    });
  if (customRadio)
    customRadio.addEventListener('change', function () {
      clearLessonRecurStartUserEdited();
      syncLessonRecurStartFromLessonDateIfPristine();
      syncLessonCreateTypeHints();
    });
  if (freqSel) freqSel.addEventListener('change', syncLessonCustomFreqFields);
  if (lessonDateEl) {
    lessonDateEl.addEventListener('change', function () {
      syncLessonRecurStartFromLessonDateIfPristine();
      if (!customRadio || !customRadio.checked) return;
      const freqEl = document.getElementById('lessonCustomFreq');
      if (!freqEl || freqEl.value !== 'monthly') return;
      const parts = lessonDateEl.value.split('-');
      const md = document.getElementById('lessonMonthlyDay');
      if (parts.length >= 3 && md) {
        const d = parseInt(parts[2], 10);
        if (Number.isFinite(d)) md.value = String(Math.min(31, Math.max(1, d)));
      }
    });
  }
  const lessonRecurStartEl = document.getElementById('lessonRecurStartDate');
  if (lessonRecurStartEl && !lessonRecurStartEl.dataset.boundRecurStart) {
    lessonRecurStartEl.dataset.boundRecurStart = '1';
    lessonRecurStartEl.addEventListener('change', markLessonRecurStartUserEdited);
    lessonRecurStartEl.addEventListener('input', markLessonRecurStartUserEdited);
  }

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
    clearLessonRecurStartUserEdited();
    const rsUrl = document.getElementById('lessonRecurStartDate');
    if (rsUrl) rsUrl.value = d.slice(0, 10);
  }
  if (sid) {
    setLessonStudentComboboxValue(sid);
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
    openDetailFromCalendarEventHit(evObj, e.target, e.clientX, e.clientY);
  },
  true
);

// ════════════════════════════════════════════════════════════════════════════
//  DETAIL CARD  (Google-Calendar style)
// ════════════════════════════════════════════════════════════════════════════

var detSaveBannerTimer = null;
function hideDetSavedBanner() {
  const el = document.getElementById('detSavedBanner');
  if (el) el.classList.add('d-none');
  if (detSaveBannerTimer) {
    clearTimeout(detSaveBannerTimer);
    detSaveBannerTimer = null;
  }
}
function showDetSavedBanner() {
  const el = document.getElementById('detSavedBanner');
  if (!el) return;
  if (detSaveBannerTimer) clearTimeout(detSaveBannerTimer);
  const body = document.getElementById('detBodyReal');
  if (body) {
    try {
      body.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      body.scrollTop = 0;
    }
  }
  el.classList.remove('d-none');
  detSaveBannerTimer = setTimeout(function () {
    el.classList.add('d-none');
    detSaveBannerTimer = null;
  }, 3500);
}

async function openDetailCard(event, options) {
  options = options || {};
  const p0 = event.extendedProps || {};

  if (p0.isRecurring === true && !options.skipMaterialize) {
    stashScheduleContext = {
      scheduleId: p0.scheduleId,
      scheduleFrequency: p0.scheduleFrequency || 'weekly',
      scheduleDayOfMonth: p0.scheduleDayOfMonth,
      scheduleRecurringStart: p0.scheduleRecurringStart || null,
    };
    try {
      const fd = new FormData();
      fd.append('student_id', String(p0.studentId));
      fd.append('slot_date', toInputDate(event.start));
      fd.append('start_time', toInputTime(event.start));
      fd.append('end_time', toInputTime(getEventEnd(event)));
      const recurringLessonType = String(p0.studentLessonType || '').toLowerCase();
      const materializeAsGroup =
        p0.isGroupLesson === true ||
        recurringLessonType === 'group';
      fd.append('is_group_lesson', materializeAsGroup ? 'true' : 'false');
      const res = await fetch('/api/lessons/materialize-from-slot', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('materialize failed');
      const data = await res.json();
      const rf = calendar.refetchEvents();
      if (rf && typeof rf.then === 'function') {
        await rf;
      } else {
        await new Promise(function (resolve) {
          setTimeout(resolve, 200);
        });
      }
      let evObj = calendar.getEventById(String(data.id));
      if (!evObj) evObj = calendar.getEventById(Number(data.id));
      if (!evObj) evObj = buildMaterializedDetailEvent(event, data);
      await openDetailCard(evObj, {
        skipMaterialize: true,
        scrollToPayment: !!options.scrollToPayment,
      });
      return;
    } catch (err) {
      console.warn(err);
      alert('לא ניתן לפתוח את פרטי השיעור. נסי שוב.');
    }
    stashScheduleContext = null;
    return;
  }

  if (!options.skipMaterialize) {
    stashScheduleContext = null;
  }

  hideCalHoverPreview();
  activeEvent = event;
  const rawEid = event.id;
  if (rawEid != null && !String(rawEid).startsWith('v-')) {
    const num = Number(rawEid);
    activeLessonDbId = Number.isFinite(num) ? num : null;
  } else {
    activeLessonDbId = null;
  }
  const p = event.extendedProps || {};

  document.getElementById('detName').textContent = event.title || '';
  const endForDisplay = getEventEnd(event);
  document.getElementById('detTime').textContent =
    fmtDate(event.start) + '   ' + fmtTime(event.start) + ' – ' + fmtTime(endForDisplay);

  const editWhenBtn = document.getElementById('detBtnEditWhen');
  const att = p.attendance || 'expected';
  const cancelled = p.status === 'cancelled';
  syncDetailModalHeaderState();

  if (editWhenBtn) {
    editWhenBtn.style.display = cancelled ? 'none' : '';
  }

  const detBody = document.getElementById('detBodyReal');
  detBody.style.display = 'block';
  detBody.scrollTop = 0;

  const paidRow = document.getElementById('detPaidRow');
  const isPaid = p.isPaid === true;
  paidRow.classList.toggle('d-none', cancelled);
  if (!cancelled) _syncDetailPaidActionButtons();
  _syncDetailAttendanceUI(att, cancelled, isPaid);

  const notesSec = document.getElementById('detNotesSection');
  if (notesSec) notesSec.classList.toggle('d-none', cancelled);
  const detNotes = document.getElementById('detLessonNotes');
  if (detNotes) detNotes.value = p.notes != null ? String(p.notes) : '';
  hideDetSavedBanner();
  hideDetPaymentBalanceFeedback();

  const paidAmtEl = document.getElementById('detPaidAmount');
  const isVirtRecurring = p.isRecurring === true;
  let prn = p.price != null && p.price !== '' ? Number(p.price) : 0;
  /* Group picker / hover use group-track defaults (groupSlotDisplayPriceForMember), not raw
   * lesson.price. Rows can still hold an old individual ₪ after concurrent lessons were marked
   * group — align the payment field with the same rule for unpaid lessons. */
  const useGroupTrackCharge =
    p.isGroupLesson === true && !cancelled && !isPaid && !isVirtRecurring;
  if (useGroupTrackCharge) {
    const disp = groupSlotDisplayPriceForMember({ extendedProps: p });
    if (Number.isFinite(disp) && disp >= 0) {
      prn = disp;
      if (activeEvent) {
        if (typeof activeEvent.setExtendedProp === 'function') {
          activeEvent.setExtendedProp('price', prn);
        } else if (activeEvent.extendedProps) {
          activeEvent.extendedProps.price = prn;
        }
      }
    }
  }
  const detLessonChargeEl = document.getElementById('detLessonCharge');
  if (detLessonChargeEl) {
    detLessonChargeEl.value = Number.isFinite(prn) ? String(prn) : '0';
    detLessonChargeEl.disabled = !!(cancelled || isVirtRecurring || activeLessonDbId == null);
  }
  if (!cancelled) {
    syncDetPaymentDatasetsFromExtendedProps();
  }

  const stored = p.paidAmount != null && p.paidAmount !== '' ? Number(p.paidAmount) : NaN;
  let chargeForSug = parseDetMoneyInput(detLessonChargeEl);
  if (!Number.isFinite(chargeForSug)) chargeForSug = Number.isFinite(prn) ? prn : 0;
  if (paidAmtEl) {
    if (isPaid && Number.isFinite(stored)) {
      paidAmtEl.value = String(stored);
    } else if (isPaid && Number.isFinite(prn)) {
      paidAmtEl.value = String(prn);
    } else if (!isPaid && !cancelled) {
      paidAmtEl.value = '0';
    } else {
      paidAmtEl.value = '';
    }
  }
  if (!cancelled) {
    detRefreshPaymentPanel();
  }
  const otherNoteEl = document.getElementById('detPaymentOtherNote');
  if (otherNoteEl) otherNoteEl.value = p.paymentNote != null ? String(p.paymentNote) : '';
  syncDetPaymentMethodUI(p.paymentMethod || 'cash');
  const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
  if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !isPaid);
  const payHintLabel = document.getElementById('detPayHint');
  if (payHintLabel && !cancelled) {
    payHintLabel.textContent = isPaid
      ? 'תשלום נרשם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי» או «שמור פרטים».'
      : 'בחרי אמצעי וסכום, ואז «שולם», «תשלום חלקי» או «לא שולם».';
  }

  const micro = document.getElementById('detMicroHint');
  if (micro) {
    micro.classList.remove('d-none');
    let msg = 'נוכחות נשמרת מיד · לתשלום אפשר «שמור פרטים» או לעדכן ולסמן שולם.';
    if (cancelled) {
      msg =
        'שיעור בוטל — נוכחות ותשלום לא רלוונטיים. אפשר לערוך או למחוק למטה.';
    } else if (isPaid) {
      msg =
        'שולם ✓ — אפשר לדייק סכום ואמצעי למעלה · «שמור פרטים» לעדכון ההערות והתשלום יחד.';
    } else {
      msg = 'נוכחות למעלה · תשלום: אמצעי וסכום, ואז «שולם», «תשלום חלקי» או «לא שולם».';
    }
    micro.textContent = msg;
  }

  detailModal.show();

  if (options.scrollToPayment && !cancelled) {
    const modalEl = document.getElementById('detailModal');
    const onShown = function () {
      if (modalEl) modalEl.removeEventListener('shown.bs.modal', onShown);
      const body = document.getElementById('detBodyReal');
      const pay = document.getElementById('detPaidRow');
      if (!pay || pay.classList.contains('d-none')) return;
      if (body && body.contains(pay)) {
        try {
          const rect = pay.getBoundingClientRect();
          const brect = body.getBoundingClientRect();
          const nextTop = body.scrollTop + (rect.top - brect.top) - 10;
          body.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
        } catch (e) {
          try {
            pay.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (e2) { /* ignore */ }
        }
      } else {
        try {
          pay.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) { /* ignore */ }
      }
      requestAnimationFrame(function () {
        const amt = document.getElementById('detPaidAmount');
        if (amt && !amt.disabled) {
          try {
            amt.focus({ preventScroll: true });
          } catch (e3) {
            amt.focus();
          }
        }
      });
    };
    if (modalEl) modalEl.addEventListener('shown.bs.modal', onShown, { once: true });
  }
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
  const ep = getDetailExtendedProps();
  if (!activeEvent || ep.isRecurring) return;
  if (ep.status === 'cancelled') return;
  if (!ep.isPaid) {
    alert('קודם סמני מצב תשלום למטה («שולם», «תשלום חלקי» או «לא שולם»), ואז אפשר לעדכן סכום ואמצעי.');
    return;
  }
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const lessonPrice = requireDetailLessonPriceOrAlert();
  if (lessonPrice === null) return;
  const raw = (document.getElementById('detPaidAmount').value || '').trim();
  const v = raw === '' ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    alert('נא להזין סכום תקין (מספר חיובי או רשום 0).');
    return;
  }
  const pm = (document.getElementById('detPaymentMethod').value || 'cash').trim();
  if (pm === 'other') {
    const pn = detPaymentNoteForSubmit();
    if (!pn) {
      alert('נא לפרט את אמצעי התשלום בשדה «אחר».');
      return;
    }
  }
  const fd = new FormData();
  fd.append('price', String(lessonPrice));
  fd.append('paid_amount', String(v));
  fd.append('payment_method', pm);
  fd.append('payment_note', pm === 'other' ? detPaymentNoteForSubmit() : '');
  appendDetChangeGivenToFormData(fd);
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('price', lessonPrice);
      activeEvent.setExtendedProp('paidAmount', v);
      activeEvent.setExtendedProp('paymentMethod', pm);
      activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
      if (data.change_given != null) activeEvent.setExtendedProp('changeGiven', !!data.change_given);
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: true });
    syncDetailModalHeaderState();
    detRefreshPaymentPanel();
    _syncDetailPaidActionButtons();
    showDetSavedBanner();
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת פרטי התשלום. נסי שוב.');
  }
}

async function detSetAttendance(value) {
  const ep = getDetailExtendedProps();
  if (!activeEvent || ep.isRecurring) return;
  if (ep.status === 'cancelled') return;
  if (ep.isPaid) return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const fd = new FormData();
  fd.append('attendance', value);
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('attendance', value);
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: false });
    _syncDetailAttendanceUI(value, false, false);
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירת נוכחות. נסי שוב.');
  }
}

function _syncDetailPaidActionButtons() {
  const paidBtn = document.getElementById('detMarkPaidBtn');
  const partialBtn = document.getElementById('detMarkPartialBtn');
  const unpaidBtn = document.getElementById('detMarkUnpaidBtn');
  if (!paidBtn || !partialBtn || !unpaidBtn) return;
  const p = getDetailExtendedProps();
  const isPaid = p.isPaid === true;
  const isPartial = isPaid && detailExtendedPropsPartialPayment(p);

  paidBtn.className = 'btn btn-outline-success flex-fill';
  partialBtn.className = 'btn btn-outline-warning flex-fill text-dark';
  unpaidBtn.className = 'btn btn-outline-danger flex-fill det-mark-unpaid-btn';

  if (!isPaid) {
    unpaidBtn.className = 'btn btn-danger flex-fill det-mark-unpaid-btn';
  } else if (isPartial) {
    partialBtn.className = 'btn btn-warning flex-fill text-dark';
  } else {
    paidBtn.className = 'btn btn-success flex-fill';
  }
}

/**
 * @param {boolean|'full'|'partial'} paidMode — false = לא שולם; 'full' = שולם במחיר מלא; 'partial' = תשלום חלקי לפי שדה הסכום
 */
async function detApplyPaidState(paidMode) {
  if (!activeEvent) return;
  const ep = getDetailExtendedProps();
  if (ep.status === 'cancelled') return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const lessonPrice = requireDetailLessonPriceOrAlert();
  if (lessonPrice === null) return;

  const fullPaid = paidMode === true || paidMode === 'full';
  const partialPaid = paidMode === 'partial';
  const wantPaid = fullPaid || partialPaid;

  let payAmtForSubmit = lessonPrice;

  if (!wantPaid) {
    payAmtForSubmit = 0;
  } else if (fullPaid) {
    payAmtForSubmit = lessonPrice;
  } else if (partialPaid) {
    if (lessonPrice <= 0) {
      alert('אין חיוב לשיעור — השתמשי ב«שולם» או «לא שולם».');
      return;
    }
    const rawPa = (document.getElementById('detPaidAmount').value || '').trim();
    const parsed = rawPa === '' ? NaN : parseInt(rawPa, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      alert('נא להזין סכום תשלום תקין לתשלום חלקי.');
      return;
    }
    if (parsed <= 0) {
      alert('לתשלום חלקי נא להזין סכום גדול מ-0.');
      return;
    }
    if (parsed >= lessonPrice) {
      alert('הסכום מלא או גבוה ממחיר השיעור — לסימון מלא לחצי «שולם».');
      return;
    }
    payAmtForSubmit = parsed;
  }

  const effectivePaid = !!(wantPaid && !(lessonPrice > 0 && payAmtForSubmit === 0));

  const pm = (document.getElementById('detPaymentMethod').value || 'cash').trim();
  if (effectivePaid && pm === 'other') {
    const pn = detPaymentNoteForSubmit();
    if (!pn) {
      alert('נא לפרט את אמצעי התשלום בשדה «אחר».');
      return;
    }
  }

  const fd = new FormData();
  fd.append('price', String(lessonPrice));
  fd.append('is_paid', effectivePaid ? 'true' : 'false');
  fd.append('payment_finalized', 'true');
  if (effectivePaid) {
    fd.append('status', 'completed');
    fd.append('attendance', 'arrived');
    fd.append('paid_amount', String(payAmtForSubmit));
    fd.append('payment_method', pm || 'cash');
    fd.append('payment_note', pm === 'other' ? detPaymentNoteForSubmit() : '');
    appendDetChangeGivenToFormData(fd);
  } else {
    fd.append('paid_amount', '');
    fd.append('payment_method', '');
    fd.append('payment_note', '');
    fd.append('change_given', 'false');
  }

  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
    if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !effectivePaid);
    const payHintLabel = document.getElementById('detPayHint');
    if (payHintLabel && ep.status !== 'cancelled') {
      payHintLabel.textContent = effectivePaid
        ? 'תשלום נרשם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי» או «שמור פרטים».'
        : 'בחרי אמצעי וסכום, ואז «שולם», «תשלום חלקי» או «לא שולם».';
    }
    let finalAmtForMsg = 0;
    if (effectivePaid) {
      finalAmtForMsg = payAmtForSubmit;
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('attendance', 'arrived');
        activeEvent.setExtendedProp('isPaid', true);
        activeEvent.setExtendedProp('price', lessonPrice);
        activeEvent.setExtendedProp('paidAmount', finalAmtForMsg);
        activeEvent.setExtendedProp('paymentMethod', pm || 'cash');
        activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
        if (data.change_given != null) activeEvent.setExtendedProp('changeGiven', !!data.change_given);
      }
      _syncDetailAttendanceUI('arrived', false, true);
      if (fullPaid) {
        const paEl = document.getElementById('detPaidAmount');
        if (paEl) paEl.value = String(lessonPrice);
      }
    } else {
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('isPaid', false);
        activeEvent.setExtendedProp('paidAmount', null);
        activeEvent.setExtendedProp('paymentMethod', '');
        activeEvent.setExtendedProp('paymentNote', '');
        activeEvent.setExtendedProp('changeGiven', false);
        activeEvent.setExtendedProp('isPartialPayment', false);
      }
      _syncDetailAttendanceUI(ep.attendance || 'expected', false, false);
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: false });
    syncDetailModalHeaderState();
    detRefreshPaymentPanel();
    _syncDetailPaidActionButtons();
    const partialNow =
      effectivePaid && lessonPrice > 0 && finalAmtForMsg > 0 && finalAmtForMsg < lessonPrice;
    showDetPaymentBalanceFeedback(
      buildDetPaymentConfirmation(data, effectivePaid, finalAmtForMsg, effectivePaid ? pm : ''),
      !effectivePaid ? 'alert-warning' : partialNow ? 'alert-warning' : 'alert-success'
    );
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירה. נסי שוב.');
  }
}

async function detSaveAllDetails() {
  const ep = getDetailExtendedProps();
  if (!activeEvent || ep.isRecurring) return;
  if (ep.status === 'cancelled') return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const lessonPrice = requireDetailLessonPriceOrAlert();
  if (lessonPrice === null) return;

  const notesEl = document.getElementById('detLessonNotes');
  const notes = notesEl ? notesEl.value : '';
  const isPaid = ep.isPaid === true;
  const pm = (document.getElementById('detPaymentMethod').value || 'cash').trim();

  if (pm === 'other') {
    const pn = detPaymentNoteForSubmit();
    if (!pn) {
      alert('נא לפרט את אמצעי התשלום בשדה «אחר».');
      return;
    }
  }

  const fd = new FormData();
  fd.append('notes', notes);
  fd.append('price', String(lessonPrice));
  fd.append('payment_method', pm);
  fd.append('payment_note', pm === 'other' ? detPaymentNoteForSubmit() : '');
  fd.append('is_group_lesson', ep.isGroupLesson === true ? 'true' : 'false');

  if (isPaid) {
    const raw = (document.getElementById('detPaidAmount').value || '').trim();
    const v = raw === '' ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 0) {
      alert('נא להזין סכום תקין.');
      return;
    }
    fd.append('paid_amount', String(v));
    appendDetChangeGivenToFormData(fd);
  }

  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('notes', notes);
      activeEvent.setExtendedProp('price', lessonPrice);
      activeEvent.setExtendedProp('paymentMethod', pm);
      activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
      activeEvent.setExtendedProp('isGroupLesson', ep.isGroupLesson === true);
      if (isPaid) {
        const rawAmt = (document.getElementById('detPaidAmount').value || '').trim();
        const v = parseInt(rawAmt, 10);
        activeEvent.setExtendedProp('paidAmount', v);
      }
      if (data.change_given != null) activeEvent.setExtendedProp('changeGiven', !!data.change_given);
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: false });
    syncDetailModalHeaderState();
    detRefreshPaymentPanel();
    _syncDetailPaidActionButtons();
    showDetSavedBanner();
    calendar.refetchEvents();
  } else {
    alert('שגיאה בשמירה. נסי שוב.');
  }
}

// Delete real lesson from detail card (not virtual recurring)
async function detDeleteLesson() {
  if (!activeEvent) return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) {
    alert('מזהה שיעור לא תקין.');
    return;
  }
  const ep = getDetailExtendedProps();
  const recurring = ep.isRecurring === true || ep.isFromRecurringSchedule === true || ep.scheduleId != null;
  const result = await deleteLessonByIdWithScope(lessonId, { recurring: recurring });
  if (result.cancelled) return;
  if (result.ok) {
    detailModal.hide();
    calendar.refetchEvents();
    showCalendarDeleteToast(result);
  } else {
    alert('לא ניתן למחוק. נסי שוב.');
  }
}

// Open the full edit modal from detail card
function switchToEdit() {
  detailModal.hide();
  if (activeEvent) openFullEditModal(activeEvent, stashScheduleContext);
}

// ════════════════════════════════════════════════════════════════════════════
//  FULL EDIT MODAL
// ════════════════════════════════════════════════════════════════════════════

function openNewLessonModal() {
  hideCalHoverPreview();
  activeEvent = null;
  document.getElementById('editModalTitle').textContent = 'הוספת שיעור חדש';
  document.getElementById('lessonId').value            = '';
  document.getElementById('recurringOrigDate').value   = '';
  document.getElementById('recurringOrigStart').value  = '';
  document.getElementById('recurringOrigEnd').value    = '';
  document.getElementById('lessonForm').reset();
  setLessonStudentComboboxValue(null);
  document.getElementById('lessonDate').value   = toInputDate(new Date());
  clearLessonRecurStartUserEdited();
  const rsInit = document.getElementById('lessonRecurStartDate');
  if (rsInit) rsInit.value = document.getElementById('lessonDate').value;
  document.getElementById('lessonStatus').value = 'scheduled';
  document.getElementById('btnDeleteLesson').classList.add('d-none');
  const extras = document.getElementById('lessonFormExtras');
  if (extras) extras.classList.add('d-none');
  const linkedSchedEl = document.getElementById('lessonLinkedScheduleId');
  if (linkedSchedEl) linkedSchedEl.value = '';
  const coreHint = document.getElementById('lessonFormCoreHint');
  if (coreHint) coreHint.classList.remove('d-none');
  const typeRow = document.getElementById('lessonTypeRow');
  if (typeRow) typeRow.classList.remove('d-none');
  const editRecurHint = document.getElementById('lessonEditRecurHint');
  if (editRecurHint) editRecurHint.classList.add('d-none');
  const onceR = document.getElementById('lessonTypeOnce');
  if (onceR) onceR.checked = true;
  const recurHint = document.getElementById('lessonRecurHint');
  if (recurHint) recurHint.classList.add('d-none');
  const customWrap = document.getElementById('lessonCustomRecurWrap');
  if (customWrap) customWrap.classList.add('d-none');
  const freqEl = document.getElementById('lessonCustomFreq');
  if (freqEl) freqEl.value = 'biweekly';
  syncLessonCustomFreqFields();
  syncLessonCreateTypeHints();
  setEditModalSize(true);
  bindLessonFormTimeControls();
  const ls = document.getElementById('lessonStart');
  if (ls && !ls.value) ls.value = '09:00';
  bumpLessonEndFromStart();
  editModal.show();
}

function openNewLessonModalOnDate(dateStr) {
  openNewLessonModal();
  document.getElementById('lessonDate').value = dateStr.slice(0, 10);
  clearLessonRecurStartUserEdited();
  const rsD = document.getElementById('lessonRecurStartDate');
  if (rsD) rsD.value = dateStr.slice(0, 10);
  const ls = document.getElementById('lessonStart');
  if (ls && dateStr.length > 10) {
    const t = dateStr.slice(11, 16);
    if (t && t.length >= 5) ls.value = t;
  }
  if (ls && !ls.value) ls.value = '09:00';
  bumpLessonEndFromStart();
}

function openFullEditModal(event, scheduleCtx) {
  scheduleCtx = scheduleCtx || null;
  hideCalHoverPreview();
  activeEvent = event;
  const p = event.extendedProps || {};
  const idStr = String(event.id || '');
  const isVirtualRecurring = p.isRecurring === true && idStr.startsWith('v-');
  let schedId = '';
  if (isVirtualRecurring && p.scheduleId != null) schedId = String(p.scheduleId);
  else if (scheduleCtx && scheduleCtx.scheduleId != null) schedId = String(scheduleCtx.scheduleId);

  const hasRecurringEdit = schedId !== '';

  const extras = document.getElementById('lessonFormExtras');
  if (extras) extras.classList.add('d-none');
  const coreHint = document.getElementById('lessonFormCoreHint');
  if (coreHint) coreHint.classList.add('d-none');
  const typeRow = document.getElementById('lessonTypeRow');
  if (typeRow) typeRow.classList.remove('d-none');

  const linkedEl = document.getElementById('lessonLinkedScheduleId');
  if (linkedEl) linkedEl.value = schedId;

  setEditModalSize(true);
  bindLessonFormTimeControls();

  if (isVirtualRecurring) {
    document.getElementById('editModalTitle').textContent = 'עריכת שיעור קבוע';
    document.getElementById('lessonId').value = '';
    document.getElementById('recurringOrigDate').value = toInputDate(event.start);
    document.getElementById('recurringOrigStart').value = toInputTime(event.start);
    document.getElementById('recurringOrigEnd').value = toInputTime(getEventEnd(event));
    document.getElementById('btnDeleteLesson').classList.add('d-none');
    const pr = p.price != null && p.price !== '' ? p.price : 0;
    document.getElementById('lessonPrice').value = String(pr);
  } else if (hasRecurringEdit) {
    document.getElementById('editModalTitle').textContent = 'עריכת שיעור קבוע';
    document.getElementById('lessonId').value = event.id;
    document.getElementById('recurringOrigDate').value = '';
    document.getElementById('recurringOrigStart').value = '';
    document.getElementById('recurringOrigEnd').value = '';
    document.getElementById('btnDeleteLesson').classList.add('d-none');
    const pr = p.price != null && p.price !== '' ? p.price : 0;
    document.getElementById('lessonPrice').value = String(pr);
  } else {
    document.getElementById('editModalTitle').textContent = 'עריכת שיעור';
    document.getElementById('lessonId').value = event.id;
    document.getElementById('recurringOrigDate').value = '';
    document.getElementById('recurringOrigStart').value = '';
    document.getElementById('recurringOrigEnd').value = '';
    if (linkedEl) linkedEl.value = '';
    document.getElementById('btnDeleteLesson').classList.remove('d-none');
  }

  document.getElementById('lessonDate').value = toInputDate(event.start);
  document.getElementById('lessonStart').value = toInputTime(event.start);
  document.getElementById('lessonEnd').value = toInputTime(getEventEnd(event));
  document.getElementById('lessonNotes').value = p.notes || '';

  setLessonStudentComboboxValue(p.studentId, true);

  if (!isVirtualRecurring && !hasRecurringEdit) {
    const prLesson = p.price != null && p.price !== '' ? p.price : 0;
    document.getElementById('lessonPrice').value = String(prLesson);
  }

  const grpModal = document.getElementById('lessonModalIsGroup');
  if (grpModal) {
    if (isVirtualRecurring) {
      const detailLessonType = String(p.studentLessonType || '').toLowerCase();
      grpModal.checked = detailLessonType === 'group' || detailLessonType === 'both';
    } else {
      grpModal.checked = p.isGroupLesson === true;
    }
  }

  if (hasRecurringEdit) {
    const freqFromCtx =
      scheduleCtx && scheduleCtx.scheduleFrequency
        ? String(scheduleCtx.scheduleFrequency).toLowerCase()
        : String(p.scheduleFrequency || 'weekly').toLowerCase();
    const freqSrc = isVirtualRecurring ? String(p.scheduleFrequency || 'weekly').toLowerCase() : freqFromCtx;
    const recurEl = document.getElementById('lessonTypeRecur');
    const customEl = document.getElementById('lessonTypeCustom');
    if (freqSrc === 'weekly') {
      if (recurEl) recurEl.checked = true;
    } else {
      if (customEl) customEl.checked = true;
      const freqEl = document.getElementById('lessonCustomFreq');
      if (freqEl) freqEl.value = freqSrc === 'monthly' ? 'monthly' : 'biweekly';
      syncLessonCustomFreqFields();
      if (freqSrc === 'monthly') {
        const dom =
          (scheduleCtx && scheduleCtx.scheduleDayOfMonth != null && scheduleCtx.scheduleDayOfMonth !== '')
            ? scheduleCtx.scheduleDayOfMonth
            : p.scheduleDayOfMonth;
        const md = document.getElementById('lessonMonthlyDay');
        if (md) {
          if (dom != null && dom !== '') md.value = String(dom);
          else if (event.start) md.value = String(Math.min(31, Math.max(1, event.start.getDate())));
        }
      }
    }
    syncLessonCreateTypeHints();
    const rsEd = document.getElementById('lessonRecurStartDate');
    if (rsEd) {
      const pRS =
        (scheduleCtx && scheduleCtx.scheduleRecurringStart) || p.scheduleRecurringStart;
      const fallbackIso =
        pRS && String(pRS).length >= 10
          ? String(pRS).slice(0, 10)
          : toInputDate(event.start);
      if (fallbackIso && fallbackIso.length >= 10) rsEd.value = fallbackIso;
      markLessonRecurStartUserEdited();
    }
  } else {
    const onceEl = document.getElementById('lessonTypeOnce');
    if (onceEl) onceEl.checked = true;
    syncLessonCreateTypeHints();
  }

  const editRecurHintEl = document.getElementById('lessonEditRecurHint');
  if (editRecurHintEl) editRecurHintEl.classList.remove('d-none');

  editModal.show();
}

function appendLessonModalIsGroup(fd) {
  const cb = document.getElementById('lessonModalIsGroup');
  fd.append('is_group_lesson', cb && cb.checked ? 'true' : 'false');
}

async function saveLesson() {
  const studentId = document.getElementById('lessonStudent').value;
  if (!studentId) {
    alert('יש לבחור תלמיד');
    return;
  }

  const lessonIdRaw = document.getElementById('lessonId').value;
  const origDate = document.getElementById('recurringOrigDate').value;
  const origStart = document.getElementById('recurringOrigStart').value;
  const origEnd = document.getElementById('recurringOrigEnd').value;
  const newDate = document.getElementById('lessonDate').value;
  const newStart = document.getElementById('lessonStart').value;
  const newEnd = document.getElementById('lessonEnd').value;
  const notesVal = document.getElementById('lessonNotes').value;
  const linkedSched = (document.getElementById('lessonLinkedScheduleId').value || '').trim();

  const onceR = document.getElementById('lessonTypeOnce');
  const recurR = document.getElementById('lessonTypeRecur');
  const customR = document.getElementById('lessonTypeCustom');
  const pickOnce = onceR && onceR.checked;
  const pickRecur = recurR && recurR.checked;
  const pickCustom = customR && customR.checked;

  function buildScheduleUpdateForm() {
    const fd = new FormData();
    fd.append('student_id', studentId);
    fd.append('day_of_week', String(dateStringToAppDayOfWeek(newDate)));
    fd.append('start_time', newStart);
    fd.append('end_time', newEnd);
    if (pickCustom) {
      const freqEl = document.getElementById('lessonCustomFreq');
      const freq = freqEl && freqEl.value ? freqEl.value : 'biweekly';
      fd.append('frequency', freq);
      if (freq === 'biweekly') {
        fd.append('anchor_date', newDate);
      } else if (freq === 'monthly') {
        const mdEl = document.getElementById('lessonMonthlyDay');
        const dom = mdEl ? parseInt(String(mdEl.value).trim(), 10) : NaN;
        if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
          alert('נא לבחור יום בחודש בין 1 ל-31.');
          return null;
        }
        fd.append('day_of_month', String(dom));
      }
    } else {
      fd.append('frequency', 'weekly');
    }
    appendRecurringStartToFormData(fd, newDate);
    return fd;
  }

  async function postLessonCoreUpdate(lid) {
    const fd = new FormData();
    fd.append('student_id', studentId);
    fd.append('lesson_date', newDate);
    fd.append('start_time', newStart);
    fd.append('end_time', newEnd);
    fd.append('notes', notesVal);
    return fetch(`/api/lessons/${lid}/update`, { method: 'POST', body: fd });
  }

  if (linkedSched) {
    if (!pickOnce && !pickRecur && !pickCustom) {
      alert('נא לבחור סוג חזרה: חד־פעמי, קבוע (שבועי) או מותאם (דו־שבועי / חודשי).');
      return;
    }

    if (!lessonIdRaw && origDate) {
      if (pickOnce) {
        const fd = new FormData();
        fd.append('student_id', studentId);
        fd.append('original_date', origDate);
        fd.append('original_start', origStart);
        fd.append('original_end', origEnd);
        fd.append('new_date', newDate);
        fd.append('new_start', newStart);
        fd.append('new_end', newEnd);
        fd.append('price', document.getElementById('lessonPrice').value);
        fd.append('notes', notesVal);
        appendLessonModalIsGroup(fd);
        let res = await fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd });
        if (!res.ok) {
          alert('שגיאה בשמירה. נסי שוב.');
          return;
        }
        res = await fetch(`/api/lessons/recurring-schedule/${linkedSched}/delete`, { method: 'POST' });
        if (!res.ok) {
          alert('השיעור נשמר, אבל לא ניתן היה להסיר את החזרות. נסי למחוק את הלוח הקבוע מכרטיס התלמיד/ה.');
          return;
        }
      } else {
        const fd = buildScheduleUpdateForm();
        if (!fd) return;
        const res = await fetch(`/api/lessons/recurring-schedule/${linkedSched}/update`, { method: 'POST', body: fd });
        if (!res.ok) {
          alert('שגיאה בעדכון לוח קבוע. נסי שוב.');
          return;
        }
      }
      editModal.hide();
      calendar.refetchEvents();
      stashScheduleContext = null;
      return;
    }

    if (lessonIdRaw) {
      if (pickOnce) {
        let res = await postLessonCoreUpdate(lessonIdRaw);
        if (!res.ok) {
          alert('שגיאה בשמירת השיעור. נסי שוב.');
          return;
        }
        res = await fetch(`/api/lessons/recurring-schedule/${linkedSched}/delete`, { method: 'POST' });
        if (!res.ok) {
          alert('השיעור עודכן אך לא ניתן היה להסיר את החזרות מהלוח. נסי שוב או ערכי בפרופיל התלמיד.');
          return;
        }
      } else {
        const fd = buildScheduleUpdateForm();
        if (!fd) return;
        let res = await fetch(`/api/lessons/recurring-schedule/${linkedSched}/update`, { method: 'POST', body: fd });
        if (!res.ok) {
          alert('שגיאה בעדכון לוח קבוע. נסי שוב.');
          return;
        }
        res = await postLessonCoreUpdate(lessonIdRaw);
        if (!res.ok) {
          alert('שגיאה בעדכון השיעור. נסי שוב.');
          return;
        }
      }
      editModal.hide();
      calendar.refetchEvents();
      stashScheduleContext = null;
      return;
    }
  }

  let url;
  const fd = new FormData();

  if (!lessonIdRaw && origDate) {
    url = '/api/lessons/confirm-recurring';
    fd.append('student_id', studentId);
    fd.append('original_date', origDate);
    fd.append('original_start', origStart);
    fd.append('original_end', origEnd);
    fd.append('new_date', newDate);
    fd.append('new_start', newStart);
    fd.append('new_end', newEnd);
    fd.append('price', document.getElementById('lessonPrice').value);
    fd.append('notes', notesVal);
    appendLessonModalIsGroup(fd);
  } else if (lessonIdRaw) {
    if (pickRecur || pickCustom) {
      const addFd = buildRecurringScheduleAddFormData(studentId, newDate, newStart, newEnd, pickCustom);
      if (!addFd) {
        alert('נא לבחור יום בחודש בין 1 ל-31.');
        return;
      }
      let res = await fetch('/api/lessons/recurring-schedule/add', { method: 'POST', body: addFd });
      if (!res.ok) {
        alert('שגיאה ביצירת לוח חוזר. ייתכן שכבר קיימת חזרה דומה — בדקי בפרופיל התלמיד.');
        return;
      }
      res = await postLessonCoreUpdate(lessonIdRaw);
      if (!res.ok) {
        alert('שגיאה בעדכון השיעור. נסי שוב.');
        return;
      }
    } else {
      const res = await postLessonCoreUpdate(lessonIdRaw);
      if (!res.ok) {
        alert('שגיאה בשמירה. נסי שוב.');
        return;
      }
    }
    editModal.hide();
    calendar.refetchEvents();
    stashScheduleContext = null;
    return;
  } else {
    const recurRadio = document.getElementById('lessonTypeRecur');
    const customRadio = document.getElementById('lessonTypeCustom');
    const isRecurringNew = recurRadio && recurRadio.checked;
    const isCustomRecur = customRadio && customRadio.checked;
    if (isRecurringNew || isCustomRecur) {
      url = '/api/lessons/recurring-schedule/add';
      fd.append('student_id', studentId);
      fd.append('day_of_week', String(dateStringToAppDayOfWeek(newDate)));
      fd.append('start_time', newStart);
      fd.append('end_time', newEnd);
      if (isCustomRecur) {
        const freqEl = document.getElementById('lessonCustomFreq');
        const freq = freqEl && freqEl.value ? freqEl.value : 'biweekly';
        fd.append('frequency', freq);
        if (freq === 'biweekly') {
          fd.append('anchor_date', newDate);
        } else if (freq === 'monthly') {
          const mdEl = document.getElementById('lessonMonthlyDay');
          const dom = mdEl ? parseInt(String(mdEl.value).trim(), 10) : NaN;
          if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
            alert('נא לבחור יום בחודש בין 1 ל-31.');
            return;
          }
          fd.append('day_of_month', String(dom));
        }
      } else {
        fd.append('frequency', 'weekly');
      }
      appendRecurringStartToFormData(fd, newDate);
    } else {
      url = '/api/lessons/create';
      const rec = studentsList.find(function (s) {
        return String(s.id) === String(studentId);
      });
      const isGrpCreate = lessonModalGroupChecked();
      const rawP = parseInt(String(document.getElementById('lessonPrice').value || '').trim(), 10);
      let createPrice =
        Number.isFinite(rawP) && rawP >= 0 ? rawP : effectiveDefaultPriceForStudent(rec, isGrpCreate);
      if (createPrice <= 0) createPrice = effectiveDefaultPriceForStudent(rec, isGrpCreate);
      fd.append('student_id', studentId);
      fd.append('lesson_date', newDate);
      fd.append('start_time', newStart);
      fd.append('end_time', newEnd);
      fd.append('price', String(createPrice));
      fd.append('notes', notesVal);
      appendLessonModalIsGroup(fd);
    }
  }

  const res = await fetch(url, { method: 'POST', body: fd });
  if (res.ok) {
    editModal.hide();
    calendar.refetchEvents();
    stashScheduleContext = null;
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
  const linkedSched = document.getElementById('lessonLinkedScheduleId').value || '';
  const ep = (activeEvent && activeEvent.extendedProps) || {};
  const result = await deleteLessonByIdWithScope(lessonId, {
    recurring: linkedSched !== '' || ep.isFromRecurringSchedule === true || ep.scheduleId != null,
  });
  if (result.cancelled) return;
  if (result.ok) {
    editModal.hide();
    calendar.refetchEvents();
    showCalendarDeleteToast(result);
  } else {
    alert('לא ניתן למחוק. נסי שוב.');
  }
}
