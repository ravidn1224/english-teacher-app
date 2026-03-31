'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let calendar;
let studentsList = [];
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
  if (found) activeEvent = found;
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
  if (c === 'cash') return 'מזומן';
  if (c === 'bit') return 'ביט';
  if (c === 'paybox') return 'פייבוקס';
  if (c === 'other') return 'אחר';
  return '';
}

/** Sync payment method <select> + «אחר» note block in lesson detail modal */
function syncDetPaymentMethodUI(method) {
  const sel = document.getElementById('detPaymentMethod');
  const m = String(method || 'cash').toLowerCase();
  const v = ['cash', 'bit', 'paybox', 'other'].includes(m) ? m : 'cash';
  if (sel) sel.value = v;
  const otherWrap = document.getElementById('detPaymentOtherWrap');
  if (otherWrap) otherWrap.classList.toggle('d-none', v !== 'other');
}

let detBalanceFeedbackTimer = null;

function hideDetPaymentBalanceFeedback() {
  const fb = document.getElementById('detPaymentBalanceFeedback');
  if (fb) {
    fb.classList.add('d-none');
    fb.textContent = '';
  }
  if (detBalanceFeedbackTimer) {
    clearTimeout(detBalanceFeedbackTimer);
    detBalanceFeedbackTimer = null;
  }
}

function showDetPaymentBalanceFeedback(message) {
  const fb = document.getElementById('detPaymentBalanceFeedback');
  if (!fb || !message) return;
  fb.textContent = message;
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
  wrap.dataset.serverStudentBalance = String(Number(ep.studentBalance) || 0);
  wrap.dataset.lessonBalanceApplied = String(
    ep.balanceApplied != null && ep.balanceApplied !== '' ? Number(ep.balanceApplied) : 0
  );
}

/** Live preview: balance if this lesson were saved with current חיוב / סכום ששולם (same net as server). */
function updateDetBalancePreview() {
  const wrap = document.getElementById('detPayChargeAndBalance');
  const balEl = document.getElementById('detStudentBalanceLine');
  if (!wrap || !balEl) return;
  const serverBal = Number(wrap.dataset.serverStudentBalance) || 0;
  const applied = Number(wrap.dataset.lessonBalanceApplied) || 0;
  let charge = parseDetMoneyInput(document.getElementById('detLessonCharge'));
  let paid = parseDetMoneyInput(document.getElementById('detPaidAmount'));
  if (!Number.isFinite(charge)) charge = 0;
  if (!Number.isFinite(paid)) paid = 0;
  const preview = serverBal - applied + (paid - charge);
  balEl.textContent = formatDetStudentBalanceLine(preview);
}

function formatDetStudentBalanceLine(balance) {
  const b = Number(balance) || 0;
  let core;
  if (b > 0) core = 'יתרה נוכחית: ‎+₪' + b;
  else if (b < 0) core = 'יתרה נוכחית: ' + (-b) + '- ₪';
  else core = 'יתרה נוכחית: ‎₪0';
  return core + ' (חיובי = זיכוי, שלילי = חוב)';
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
  if (data.student_balance != null) activeEvent.setExtendedProp('studentBalance', data.student_balance);
  if (data.lesson_balance_applied != null) activeEvent.setExtendedProp('balanceApplied', data.lesson_balance_applied);
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

async function detPersistGroupLessonOnly() {
  const ep = getDetailExtendedProps();
  if (!activeEvent || ep.isRecurring === true || ep.status === 'cancelled') return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const cb = document.getElementById('detIsGroupLesson');
  if (!cb || cb.disabled) return;
  const fd = new FormData();
  fd.append('is_group_lesson', cb.checked ? 'true' : 'false');
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok && typeof activeEvent.setExtendedProp === 'function') {
    activeEvent.setExtendedProp('isGroupLesson', cb.checked);
    mergeLessonBalanceFromResponse(data);
    syncDetPaymentDatasetsFromExtendedProps();
    updateDetBalancePreview();
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
  if (recurHint) {
    recurHint.classList.toggle('d-none', !(recurR && recurR.checked));
  }
  if (customWrap) {
    customWrap.classList.toggle('d-none', !(customR && customR.checked));
  }
  if (customR && customR.checked) {
    syncLessonCustomFreqFields();
  }
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
  return fd;
}

function syncLessonPriceFromStudentId(studentId) {
  const priceEl = document.getElementById('lessonPrice');
  if (!priceEl) return;
  const rec = studentsList.find(function (s) {
    return String(s.id) === String(studentId);
  });
  if (rec && rec.default_price != null && rec.default_price !== '') {
    priceEl.value = String(rec.default_price);
  }
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

function setLessonStudentComboboxValue(studentId) {
  const hidden = document.getElementById('lessonStudent');
  const search = document.getElementById('lessonStudentSearch');
  if (!hidden || !search) return;
  if (studentId == null || studentId === '') {
    hidden.value = '';
    search.value = '';
    lessonStudentDropdownOpen(false);
    return;
  }
  const rec = studentsList.find(function (s) {
    return String(s.id) === String(studentId);
  });
  hidden.value = String(studentId);
  search.value = rec ? rec.name : '';
  lessonStudentDropdownOpen(false);
  syncLessonPriceFromStudentId(studentId);
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
  renderLessonStudentDropdown('');
  setupLessonStudentCombobox();
}

// ── Calendar init ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
  editModal   = new bootstrap.Modal(document.getElementById('editModal'));
  document.getElementById('detailModal').addEventListener('hidden.bs.modal', function () {
    activeLessonDbId = null;
  });
  bindLessonFormTimeControls();

  const detPmSel = document.getElementById('detPaymentMethod');
  if (detPmSel) {
    detPmSel.addEventListener('change', function () {
      syncDetPaymentMethodUI(detPmSel.value);
    });
  }
  const detGrp = document.getElementById('detIsGroupLesson');
  if (detGrp && !detGrp.dataset.bound) {
    detGrp.dataset.bound = '1';
    detGrp.addEventListener('change', function () {
      void detPersistGroupLessonOnly();
    });
  }
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

    eventsSet: function () {
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
      void openDetailCard(info.event);
    },

    // ── Click on empty slot → new lesson form ────────────────────
    dateClick: function (info) {
      const evObj = resolveEventFromClientPoint(info.jsEvent.clientX, info.jsEvent.clientY);
      if (evObj) {
        void openDetailCard(evObj);
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

  const onceRadio = document.getElementById('lessonTypeOnce');
  const recurRadio = document.getElementById('lessonTypeRecur');
  const customRadio = document.getElementById('lessonTypeCustom');
  const freqSel = document.getElementById('lessonCustomFreq');
  const lessonDateEl = document.getElementById('lessonDate');
  if (onceRadio) onceRadio.addEventListener('change', syncLessonCreateTypeHints);
  if (recurRadio) recurRadio.addEventListener('change', syncLessonCreateTypeHints);
  if (customRadio) customRadio.addEventListener('change', syncLessonCreateTypeHints);
  if (freqSel) freqSel.addEventListener('change', syncLessonCustomFreqFields);
  if (lessonDateEl) {
    lessonDateEl.addEventListener('change', function () {
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
    void openDetailCard(evObj);
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
    };
    try {
      const fd = new FormData();
      fd.append('student_id', String(p0.studentId));
      fd.append('slot_date', toInputDate(event.start));
      fd.append('start_time', toInputTime(event.start));
      fd.append('end_time', toInputTime(getEventEnd(event)));
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
      if (evObj) {
        await openDetailCard(evObj, { skipMaterialize: true });
        return;
      }
      alert('השיעור נוצר — רענני את הלוח אם הכרטיס לא נפתח.');
    } catch (err) {
      console.warn(err);
      alert('לא ניתן לפתוח את השיעור. נסי שוב.');
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
  const header = document.getElementById('detHeader');
  const att = p.attendance || 'expected';
  const cancelled = p.status === 'cancelled';
  header.classList.remove('s-paid', 's-attended', 's-expected', 's-no-show', 's-recurring', 's-cancelled');
  if (p.status === 'cancelled') header.classList.add('s-cancelled');
  else if (p.isPaid) header.classList.add('s-paid');
  else if (att === 'no_show') header.classList.add('s-no-show');
  else if (att === 'arrived') header.classList.add('s-attended');
  else header.classList.add('s-expected');

  if (editWhenBtn) {
    editWhenBtn.style.display = cancelled ? 'none' : '';
  }

  const detBody = document.getElementById('detBodyReal');
  detBody.style.display = 'block';
  detBody.scrollTop = 0;

  const paidRow = document.getElementById('detPaidRow');
  const isPaid = p.isPaid === true;
  paidRow.classList.toggle('d-none', cancelled);
  if (!cancelled) _syncDetailPaidDualButtons(isPaid);
  _syncDetailAttendanceUI(att, cancelled, isPaid);

  const notesSec = document.getElementById('detNotesSection');
  if (notesSec) notesSec.classList.toggle('d-none', cancelled);
  const detNotes = document.getElementById('detLessonNotes');
  if (detNotes) detNotes.value = p.notes != null ? String(p.notes) : '';
  hideDetSavedBanner();
  hideDetPaymentBalanceFeedback();

  const paidAmtEl = document.getElementById('detPaidAmount');
  const prn = p.price != null && p.price !== '' ? Number(p.price) : 0;
  const isVirtRecurring = p.isRecurring === true;
  const detLessonChargeEl = document.getElementById('detLessonCharge');
  if (detLessonChargeEl) {
    detLessonChargeEl.value = Number.isFinite(prn) ? String(prn) : '0';
    detLessonChargeEl.disabled = !!(cancelled || isVirtRecurring || activeLessonDbId == null);
  }
  const detGroupRow = document.getElementById('detGroupLessonRow');
  const detGroupCb = document.getElementById('detIsGroupLesson');
  if (detGroupRow) detGroupRow.classList.toggle('d-none', cancelled || isVirtRecurring);
  if (detGroupCb) {
    detGroupCb.checked = p.isGroupLesson === true;
    detGroupCb.disabled = !!(cancelled || isVirtRecurring || activeLessonDbId == null);
  }
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
  if (!cancelled) {
    syncDetPaymentDatasetsFromExtendedProps();
    updateDetBalancePreview();
  }
  const otherNoteEl = document.getElementById('detPaymentOtherNote');
  if (otherNoteEl) otherNoteEl.value = p.paymentNote != null ? String(p.paymentNote) : '';
  syncDetPaymentMethodUI(p.paymentMethod || 'cash');
  const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
  if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !isPaid);
  const payHintLabel = document.getElementById('detPayHint');
  if (payHintLabel && !cancelled) {
    payHintLabel.textContent = isPaid
      ? 'שולם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי» או «שמור פרטים».'
      : 'בחרי אמצעי וסכום, ואז לחצי «שולם» או «לא שולם».';
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
      msg = 'נוכחות למעלה · תשלום: בוחרים אמצעי וסכום, ואז «שולם» או «לא שולם».';
    }
    micro.textContent = msg;
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
  const ep = getDetailExtendedProps();
  if (!activeEvent || ep.isRecurring) return;
  if (ep.status === 'cancelled') return;
  if (!ep.isPaid) {
    alert('קודם סמני «שולם» למטה, ואז אפשר לעדכן סכום ואמצעי.');
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
  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('price', lessonPrice);
      activeEvent.setExtendedProp('paidAmount', v);
      activeEvent.setExtendedProp('paymentMethod', pm);
      activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: true });
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

function _syncDetailPaidDualButtons(isPaid) {
  const paidBtn = document.getElementById('detMarkPaidBtn');
  const unpaidBtn = document.getElementById('detMarkUnpaidBtn');
  if (!paidBtn || !unpaidBtn) return;
  if (isPaid) {
    paidBtn.className = 'btn btn-success flex-fill';
    unpaidBtn.className = 'btn btn-outline-secondary flex-fill det-mark-unpaid-btn';
  } else {
    paidBtn.className = 'btn btn-outline-success flex-fill';
    unpaidBtn.className = 'btn btn-danger flex-fill det-mark-unpaid-btn';
  }
}

async function detApplyPaidState(newPaid) {
  if (!activeEvent) return;
  const ep = getDetailExtendedProps();
  if (ep.status === 'cancelled') return;
  const lessonId = getActiveLessonId();
  if (!Number.isFinite(lessonId)) return;
  const lessonPrice = requireDetailLessonPriceOrAlert();
  if (lessonPrice === null) return;
  const pm = (document.getElementById('detPaymentMethod').value || 'cash').trim();
  if (newPaid && pm === 'other') {
    const pn = detPaymentNoteForSubmit();
    if (!pn) {
      alert('נא לפרט את אמצעי התשלום בשדה «אחר».');
      return;
    }
  }

  const fd = new FormData();
  fd.append('price', String(lessonPrice));
  fd.append('is_paid', newPaid ? 'true' : 'false');
  fd.append('payment_finalized', 'true');
  if (newPaid) {
    fd.append('status', 'completed');
    fd.append('attendance', 'arrived');
    const pa = (document.getElementById('detPaidAmount').value || '').trim();
    fd.append('paid_amount', pa || String(lessonPrice));
    fd.append('payment_method', pm || 'cash');
    fd.append('payment_note', pm === 'other' ? detPaymentNoteForSubmit() : '');
  } else {
    fd.append('paid_amount', '');
    fd.append('payment_method', '');
    fd.append('payment_note', '');
  }

  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    _syncDetailPaidDualButtons(newPaid);
    const paySaveBtn = document.getElementById('detSavePaymentDetailsBtn');
    if (paySaveBtn) paySaveBtn.classList.toggle('d-none', !newPaid);
    const payHintLabel = document.getElementById('detPayHint');
    if (payHintLabel && ep.status !== 'cancelled') {
      payHintLabel.textContent = newPaid
        ? 'שולם ✓ — אפשר לעדכן סכום/אמצעי וללחוץ «עדכן סכום ואמצעי» או «שמור פרטים».'
        : 'בחרי אמצעי וסכום, ואז לחצי «שולם» או «לא שולם».';
    }
    if (newPaid) {
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('attendance', 'arrived');
        const pam = (document.getElementById('detPaidAmount').value || '').trim();
        const finalAmt = pam ? parseInt(pam, 10) : lessonPrice;
        activeEvent.setExtendedProp('isPaid', true);
        activeEvent.setExtendedProp('price', lessonPrice);
        activeEvent.setExtendedProp('paidAmount', finalAmt);
        activeEvent.setExtendedProp('paymentMethod', pm || 'cash');
        activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
      }
      _syncDetailAttendanceUI('arrived', false, true);
    } else {
      if (typeof activeEvent.setExtendedProp === 'function') {
        activeEvent.setExtendedProp('isPaid', false);
        activeEvent.setExtendedProp('paidAmount', null);
        activeEvent.setExtendedProp('paymentMethod', '');
        activeEvent.setExtendedProp('paymentNote', '');
      }
      _syncDetailAttendanceUI(ep.attendance || 'expected', false, false);
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: true });
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
  const detGroupCb = document.getElementById('detIsGroupLesson');
  if (detGroupCb && !detGroupCb.disabled) {
    fd.append('is_group_lesson', detGroupCb.checked ? 'true' : 'false');
  }

  if (isPaid) {
    const raw = (document.getElementById('detPaidAmount').value || '').trim();
    const v = raw === '' ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 0) {
      alert('נא להזין סכום תקין.');
      return;
    }
    fd.append('paid_amount', String(v));
  }

  const res = await fetch(`/api/lessons/${lessonId}/update`, { method: 'POST', body: fd });
  const data = await readLessonUpdateJson(res);
  if (res.ok) {
    if (typeof activeEvent.setExtendedProp === 'function') {
      activeEvent.setExtendedProp('notes', notes);
      activeEvent.setExtendedProp('price', lessonPrice);
      activeEvent.setExtendedProp('paymentMethod', pm);
      activeEvent.setExtendedProp('paymentNote', pm === 'other' ? detPaymentNoteForSubmit() : '');
      if (detGroupCb && !detGroupCb.disabled) {
        activeEvent.setExtendedProp('isGroupLesson', detGroupCb.checked);
      }
      if (isPaid) {
        const rawAmt = (document.getElementById('detPaidAmount').value || '').trim();
        const v = parseInt(rawAmt, 10);
        activeEvent.setExtendedProp('paidAmount', v);
      }
    }
    mergeLessonUpdateIntoDetailUi(data, { showBalanceHint: false });
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
  if (
    !confirm(
      'להסיר את המופע הזה מהלוח?\n\nאם זה מתוך שיעור חוזר — רק התאריך הזה ייעלם והחזרות ימשיכו.\nשיעור חד־פעמי יימחק לגמרי.'
    )
  ) {
    return;
  }
  const res = await fetch(`/api/lessons/${lessonId}/delete`, { method: 'POST' });
  if (res.ok) {
    detailModal.hide();
    calendar.refetchEvents();
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

  setLessonStudentComboboxValue(p.studentId);

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
  } else {
    const onceEl = document.getElementById('lessonTypeOnce');
    if (onceEl) onceEl.checked = true;
    syncLessonCreateTypeHints();
  }

  const editRecurHintEl = document.getElementById('lessonEditRecurHint');
  if (editRecurHintEl) editRecurHintEl.classList.remove('d-none');

  editModal.show();
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
        let res = await fetch('/api/lessons/confirm-recurring', { method: 'POST', body: fd });
        if (!res.ok) {
          alert('שגיאה בשמירה. נסי שוב.');
          return;
        }
        res = await fetch(`/api/lessons/recurring-schedule/${linkedSched}/delete`, { method: 'POST' });
        if (!res.ok) {
          alert('השיעור נוצר אך לא ניתן היה להסיר את החזרות. נסי מחיקת לוח קבוע בפרופיל התלמיד.');
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
    } else {
      url = '/api/lessons/create';
      let defaultPrice = 0;
      const rec = studentsList.find(function (s) {
        return String(s.id) === String(studentId);
      });
      if (rec && rec.default_price != null && rec.default_price !== '') {
        const pr = parseInt(String(rec.default_price), 10);
        if (Number.isFinite(pr) && pr >= 0) defaultPrice = pr;
      }
      fd.append('student_id', studentId);
      fd.append('lesson_date', newDate);
      fd.append('start_time', newStart);
      fd.append('end_time', newEnd);
      fd.append('price', String(defaultPrice));
      fd.append('notes', notesVal);
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
  if (
    !confirm(
      'להסיר את המופע מהלוח?\n\nשיעור חוזר — רק התאריך הזה; שיעור חד־פעמי — מחיקה מלאה.'
    )
  ) {
    return;
  }
  const res = await fetch(`/api/lessons/${lessonId}/delete`, { method: 'POST' });
  if (res.ok) {
    editModal.hide();
    calendar.refetchEvents();
  } else {
    alert('לא ניתן למחוק. נסי שוב.');
  }
}
