from fastapi import APIRouter, Depends, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from sqlalchemy.orm import Session, joinedload
from pathlib import Path
import calendar as cal_std
import json
import secrets
from datetime import date, datetime, time as dt_time, timedelta
from types import SimpleNamespace
from typing import Optional, Set, Any

from ..database import get_db
from .. import models
from .. import family_utils
from ..app_settings import (
    effective_student_default_price,
    effective_student_default_price_for_lesson,
    effective_student_default_price_with_tuple,
    get_default_lesson_prices,
)
from ..templating import templates

router = APIRouter(tags=["lessons"])
RECENT_DELETE_UNDO: dict[str, dict[str, Any]] = {}


def _python_weekday_to_app_day(python_weekday: int) -> int:
    """Convert Python weekday (Mon=0 ... Sun=6) to app convention (Sun=0 ... Sat=6)."""
    return (python_weekday + 1) % 7


def _parse_time_loose(s: str) -> dt_time:
    return dt_time.fromisoformat(s.strip())


def _end_or_default(day: date, start: dt_time, end_raw: Optional[str], default_minutes: int = 60) -> dt_time:
    """Use explicit end time, or start + default_minutes (browser sometimes omits end)."""
    if end_raw and str(end_raw).strip():
        return _parse_time_loose(end_raw)
    combined = datetime.combine(day, start) + timedelta(minutes=default_minutes)
    return combined.time()


ALLOWED_ATTENDANCE = frozenset({"expected", "arrived", "no_show"})
ALLOWED_PAYMENT_METHODS = frozenset({"cash", "bit", "paybox", "other"})
HIDDEN_RECURRING_PLACEHOLDER_PREFIXES = (
    "הוסר מהלוח",
    "הועבר לתאריך אחר",
)


def _coerce_payment_method(raw: Optional[str]) -> Optional[str]:
    """None = omit update; '' = clear; else normalized token."""
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if s == "":
        return ""
    if s in ALLOWED_PAYMENT_METHODS:
        return s
    return None


def _normalize_lesson_paid_from_amounts(lesson: models.Lesson) -> None:
    """שולם עם סכום 0 מול חיוב חיובי → לא שולם (אדום בלוח)."""
    if not lesson.is_paid:
        return
    pc = int(lesson.price or 0)
    if pc <= 0:
        return
    pam = int(lesson.paid_amount) if lesson.paid_amount is not None else pc
    if pam <= 0:
        lesson.is_paid = False
        lesson.paid_amount = None
        lesson.payment_method = ""
        lesson.payment_note = ""
        lesson.change_given = False
        lesson.payment_finalized = False


def _lesson_is_partial_payment(lesson: models.Lesson) -> bool:
    """שולם אך סכום בפועל נמוך מחיוב השיעור (תשלום חלקי)."""
    if not lesson.is_paid:
        return False
    c = int(lesson.price or 0)
    if c <= 0:
        return False
    p = int(lesson.paid_amount) if lesson.paid_amount is not None else c
    return p < c


def _lesson_event_colors(lesson: models.Lesson, is_from_recurring_schedule: bool = False) -> tuple[str, str]:
    """(background_hex, text_hex) — palette aligned with app teal-emerald brand."""
    if lesson.status == "cancelled":
        return ("#94A3B8", "#FFFFFF")
    if lesson.is_paid:
        if _lesson_is_partial_payment(lesson):
            return ("#EAB308", "#1C1917")
        return ("#059669", "#FFFFFF")
    att = getattr(lesson, "attendance", None) or "expected"
    if att == "no_show":
        return ("#6B7280", "#FFFFFF")
    if att == "expected":
        if is_from_recurring_schedule:
            return ("#14B8A6", "#FFFFFF")
        return ("#CCFBF1", "#134E4A")
    # arrived — לא שולם (כולל סכום 0): אדום בלוח
    if att == "arrived" and not lesson.is_paid:
        return ("#DC2626", "#FFFFFF")
    return ("#0D9488", "#FFFFFF")


def _lesson_attendance_prop(lesson: models.Lesson) -> str:
    return getattr(lesson, "attendance", None) or "expected"


def _lesson_effective_paid_for_balance(lesson: models.Lesson) -> int:
    """כסף שנשאר אצל המורה מול החיוב; אם סומן «הוחזר עודף» — כאילו שולם רק מחיר השיעור."""
    if not lesson.is_paid:
        return 0
    c = int(lesson.price or 0)
    p = int(lesson.paid_amount) if lesson.paid_amount is not None else c
    if bool(getattr(lesson, "change_given", False)) and p > c:
        return c
    return p


def _lesson_payment_net_for_balance(lesson: models.Lesson) -> int:
    """Cash effect: שולם − חיוב (₪). זיכוי משפחה = תשלום יתר על מחיר השיעור; חוב = חיוב − שולם.
    מיושר לדוח חודשי: חיוב רק ל«הגיע/ה»; «לא הגיע/ה» — 0."""
    if lesson.status == "cancelled":
        return 0
    att = (getattr(lesson, "attendance", None) or "expected").lower()
    if att == "no_show":
        return 0
    c = int(lesson.price or 0)
    if att == "arrived":
        if lesson.is_paid:
            pe = _lesson_effective_paid_for_balance(lesson)
            return pe - c
        return -c
    if (
        att == "expected"
        and (getattr(lesson, "status", None) or "") == "scheduled"
        and lesson.lesson_date > date.today()
    ):
        return 0
    if bool(getattr(lesson, "payment_finalized", False)) and not lesson.is_paid:
        return -c
    return 0


def _format_balance_hint_he(bal: int) -> str:
    b = int(bal)
    if b > 0:
        return f"יתרה חדשה למשפחה: ‎+₪{b} (זיכוי)"
    if b < 0:
        return f"יתרה חדשה למשפחה: ₪{b} (חוב ‎₪{-b})"
    return "יתרה חדשה למשפחה: ‎₪0"


def _payment_feedback_he(lesson: models.Lesson, new_family_balance: int) -> str:
    """After marking paid: lesson paid vs charge (עודף מהשיעור) + יתרת משפחה נטו — כמו בדוח חודשי."""
    b = int(new_family_balance)
    if lesson.is_paid and int(lesson.price or 0) > 0:
        c = int(lesson.price)
        p = int(lesson.paid_amount) if lesson.paid_amount is not None else c
        if p == c:
            if b > 0:
                return (
                    f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — מאוזן. "
                    f"יתרת משפחה כוללת: זיכוי ‎₪{b}."
                )
            if b < 0:
                return (
                    f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — מאוזן. "
                    f"יתרת משפחה כוללת: חוב ‎₪{-b} "
                    f"(סיכום כללי של החשבון; לא נגרם מפער לשיעור הזה)."
                )
            return (
                f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — מאוזן. "
                "יתרת המשפחה מאוזנת."
            )
        if p > c:
            if bool(getattr(lesson, "change_given", False)):
                if b > 0:
                    return (
                        f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c}; הוחזר עודף במזומן — אין זיכוי לשיעור הבא. "
                        f"יתרת משפחה כוללת: זיכוי ‎₪{b}."
                    )
                if b < 0:
                    return (
                        f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c}; הוחזר עודף במזומן — אין זיכוי לשיעור הבא. "
                        f"יתרת משפחה כוללת: חוב ‎₪{-b}."
                    )
                return (
                    f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c}; הוחזר עודף במזומן — אין זיכוי לשיעור הבא. "
                    "יתרת המשפחה מאוזנת."
                )
            over = p - c
            if b > 0:
                return (
                    f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — עודף ‎₪{over} מהשיעור. "
                    f"יתרה למשפחה: זיכוי ‎₪{b} — יקוזז בשיעור הבא."
                )
            if b < 0:
                return (
                    f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — עודף ‎₪{over} מהשיעור. "
                    f"יתרה למשפחה: חוב ‎₪{-b} — יעודכן בשיעור הבא."
                )
            return (
                f"לשיעור זה שולמו ‎₪{p} מול חיוב ‎₪{c} — עודף ‎₪{over} מהשיעור. "
                "יתרת המשפחה מאוזנת."
            )
    return _format_balance_hint_he(new_family_balance)


def _reverse_lesson_balance_on_family(lesson: models.Lesson, db: Session) -> None:
    """Clear this row’s applied net; caller recomputes ``Family.balance`` from all lessons."""
    lesson.balance_applied = 0


def _delete_balance_transactions_for_lesson(db: Session, lesson_id: int) -> None:
    """Ledger rows reference ``lessons.id``; remove them before deleting the lesson row."""
    db.query(models.BalanceTransaction).filter(
        models.BalanceTransaction.lesson_id == lesson_id
    ).delete(synchronize_session=False)


def _recompute_family_balance_from_lessons(db: Session, family_id: int) -> int:
    """Sum of lesson cash nets only (no balance_transactions anchor — avoids stale ledger vs דוח חודשי)."""
    sids = [
        s.id
        for s in db.query(models.Student)
        .filter(models.Student.family_id == family_id)
        .all()
    ]
    if not sids:
        return 0
    lessons = (
        db.query(models.Lesson)
        .filter(models.Lesson.student_id.in_(sids))
        .filter(models.Lesson.status != "cancelled")
        .order_by(
            models.Lesson.lesson_date,
            models.Lesson.start_time,
            models.Lesson.id,
        )
        .all()
    )
    if not lessons:
        # No rows left — balance is fully derived from lessons; do not keep stale Family.balance.
        return 0
    bal = 0
    for L in lessons:
        bal += _lesson_payment_net_for_balance(L)
    return bal


def _lesson_matches_any_recurring_slot(lesson: models.Lesson, db: Session) -> bool:
    """True if a RegularSchedule would emit this occurrence (same student, date, start, end)."""
    return bool(_matching_recurring_schedules_for_lesson(lesson, db))


def _matching_recurring_schedules_for_lesson(lesson: models.Lesson, db: Session) -> list[models.RegularSchedule]:
    """RegularSchedule rows that emit the same student/date/time as this concrete lesson."""
    schedules = (
        db.query(models.RegularSchedule)
        .filter(models.RegularSchedule.student_id == lesson.student_id)
        .all()
    )
    matches = []
    for sched in schedules:
        if not _schedule_matches_date(sched, lesson.lesson_date):
            continue
        if sched.start_time == lesson.start_time and sched.end_time == lesson.end_time:
            matches.append(sched)
    return matches


def _calendar_skip_placeholder(lesson: models.Lesson) -> bool:
    """Cancelled row kept only to block a virtual recurring slot — omit from calendar UI."""
    if lesson.status != "cancelled":
        return False
    n = (lesson.notes or "").strip()
    return n.startswith(HIDDEN_RECURRING_PLACEHOLDER_PREFIXES)


def _clear_matching_hidden_recurring_placeholders(
    db: Session,
    *,
    student_id: int,
    day_of_week: int,
    start_time: dt_time,
    end_time: dt_time,
    frequency: str = "weekly",
    anchor_date: Optional[date] = None,
    day_of_month: Optional[int] = None,
    recurring_start_date: Optional[date] = None,
    recurring_end_date: Optional[date] = None,
) -> int:
    """Remove stale hidden rows that would otherwise keep a newly saved recurrence invisible."""
    rule = SimpleNamespace(
        day_of_week=day_of_week,
        start_time=start_time,
        end_time=end_time,
        frequency=(frequency or "weekly").strip().lower(),
        anchor_date=anchor_date,
        day_of_month=day_of_month,
        recurring_start_date=recurring_start_date,
        recurring_end_date=recurring_end_date,
    )
    query = db.query(models.Lesson).filter(
        models.Lesson.student_id == student_id,
        models.Lesson.status == "cancelled",
        models.Lesson.start_time == start_time,
        models.Lesson.end_time == end_time,
    )
    if recurring_start_date is not None:
        query = query.filter(models.Lesson.lesson_date >= recurring_start_date)
    if recurring_end_date is not None:
        query = query.filter(models.Lesson.lesson_date <= recurring_end_date)

    removed = 0
    for lesson in query.all():
        if not _calendar_skip_placeholder(lesson):
            continue
        if not _schedule_matches_date(rule, lesson.lesson_date):
            continue
        db.delete(lesson)
        removed += 1
    return removed


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _sched_frequency(sched: models.RegularSchedule) -> str:
    return (getattr(sched, "frequency", None) or "weekly").strip().lower()


def _schedule_matches_date(sched: models.RegularSchedule, current: date) -> bool:
    """Whether a recurring schedule rule produces an occurrence on ``current``."""
    start_on = getattr(sched, "recurring_start_date", None)
    if start_on is not None and current < start_on:
        return False
    end_on = getattr(sched, "recurring_end_date", None)
    if end_on is not None and current > end_on:
        return False
    freq = _sched_frequency(sched)
    app_day = _python_weekday_to_app_day(current.weekday())
    if freq == "monthly":
        dom = getattr(sched, "day_of_month", None)
        if dom is None:
            return False
        last_d = cal_std.monthrange(current.year, current.month)[1]
        target = min(max(1, int(dom)), last_d)
        return current.day == target
    if sched.day_of_week != app_day:
        return False
    if freq == "biweekly":
        anchor = getattr(sched, "anchor_date", None)
        if anchor is None:
            anchor = current
        w_a = _monday_of(anchor)
        w_c = _monday_of(current)
        weeks = (w_c - w_a).days // 7
        return weeks >= 0 and weeks % 2 == 0
    return True


# --- JSON API for FullCalendar ---

@router.get("/api/lessons")
def get_lessons_json(
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return real lessons + virtual recurring slots as FullCalendar event objects."""
    start_date = date.fromisoformat(start[:10]) if start else None
    end_date = date.fromisoformat(end[:10]) if end else None

    query = (
        db.query(models.Lesson)
        .join(models.Student)
        .options(joinedload(models.Lesson.student).joinedload(models.Student.family))
    )
    if start_date:
        query = query.filter(models.Lesson.lesson_date >= start_date)
    if end_date:
        query = query.filter(models.Lesson.lesson_date <= end_date)

    real_lessons = query.all()

    # A student can have more than one slot on the same day.  Only suppress the
    # virtual occurrence that matches the concrete lesson's full time window.
    covered = {
        (l.student_id, l.lesson_date, l.start_time, l.end_time)
        for l in real_lessons
    }

    fam_ids: Set[int] = set()
    for lesson in real_lessons:
        if _calendar_skip_placeholder(lesson):
            continue
        if lesson.student and lesson.student.family_id:
            fam_ids.add(lesson.student.family_id)

    schedules: list = []
    if start_date and end_date:
        schedules = (
            db.query(models.RegularSchedule)
            .join(models.Student)
            .options(joinedload(models.RegularSchedule.student).joinedload(models.Student.family))
            .all()
        )
        for sched in schedules:
            if sched.student and sched.student.family_id:
                fam_ids.add(sched.student.family_id)

    bal_by_fid = {fid: _recompute_family_balance_from_lessons(db, fid) for fid in fam_ids}
    glob_ind, glob_grp = get_default_lesson_prices(db)

    events = []

    # Real lesson events (skip invisible placeholders that only block virtual recurring)
    for lesson in real_lessons:
        if _calendar_skip_placeholder(lesson):
            continue
        matching_schedules = _matching_recurring_schedules_for_lesson(lesson, db)
        bg, tx = _lesson_event_colors(lesson, bool(matching_schedules))
        fid = getattr(lesson.student, "family_id", None)
        if fid is not None:
            bal_disp = bal_by_fid[fid]
        else:
            bal_disp = int(getattr(lesson.student, "balance", 0) or 0)
        events.append({
            "id": lesson.id,
            "title": f"{lesson.student.first_name} {lesson.student.last_name}",
            "start": f"{lesson.lesson_date}T{lesson.start_time}",
            "end": f"{lesson.lesson_date}T{lesson.end_time}",
            "color": bg,
            "textColor": tx,
            "extendedProps": {
                "studentId": lesson.student_id,
                "studentFirstName": lesson.student.first_name or "",
                "studentLastName": lesson.student.last_name or "",
                "status": lesson.status,
                "isPaid": lesson.is_paid,
                "attendance": _lesson_attendance_prop(lesson),
                "price": lesson.price,
                "paidAmount": lesson.paid_amount,
                "paymentMethod": (lesson.payment_method or ""),
                "paymentNote": getattr(lesson, "payment_note", None) or "",
                "notes": lesson.notes or "",
                "isRecurring": False,
                "isFromRecurringSchedule": bool(matching_schedules),
                "scheduleId": matching_schedules[0].id if matching_schedules else None,
                "studentBalance": bal_disp,
                "familyBalance": bal_disp,
                "familyId": getattr(lesson.student, "family_id", None),
                "studentLessonType": getattr(lesson.student, "lesson_type", None) or "individual",
                "isGroupLesson": bool(getattr(lesson, "is_group_lesson", False)),
                "balanceApplied": int(getattr(lesson, "balance_applied", 0) or 0),
                "changeGiven": bool(getattr(lesson, "change_given", False)),
                "isPartialPayment": _lesson_is_partial_payment(lesson),
            },
        })

    # Virtual recurring events from regular_schedule
    if start_date and end_date:
        current = start_date
        while current <= end_date:
            for sched in schedules:
                if not _schedule_matches_date(sched, current):
                    continue
                if (sched.student_id, current, sched.start_time, sched.end_time) not in covered:
                    vfid = getattr(sched.student, "family_id", None)
                    if vfid is not None:
                        vbal = bal_by_fid[vfid]
                    else:
                        vbal = int(getattr(sched.student, "balance", 0) or 0)
                    events.append({
                        "id": f"v-{sched.id}-{current}",
                        "title": f"{sched.student.first_name} {sched.student.last_name}",
                        "start": f"{current}T{sched.start_time}",
                        "end": f"{current}T{sched.end_time}",
                        "color": "#14B8A6",
                        "borderColor": "#0D9488",
                        "textColor": "#ffffff",
                        "extendedProps": {
                            "studentId": sched.student_id,
                            "studentFirstName": sched.student.first_name or "",
                            "studentLastName": sched.student.last_name or "",
                            "status": "scheduled",
                            "isPaid": False,
                            "attendance": "expected",
                            "price": effective_student_default_price_with_tuple(
                                sched.student,
                                glob_ind,
                                glob_grp,
                                for_group=(
                                    (getattr(sched.student, "lesson_type", None) or "individual")
                                    .strip()
                                    .lower()
                                    == "group"
                                ),
                            ),
                            "studentBalance": vbal,
                            "familyBalance": vbal,
                            "familyId": getattr(sched.student, "family_id", None),
                            "studentLessonType": getattr(sched.student, "lesson_type", None) or "individual",
                            "isGroupLesson": False,
                            "balanceApplied": 0,
                            "notes": "",
                            "isRecurring": True,
                            "scheduleId": sched.id,
                            "scheduleFrequency": _sched_frequency(sched),
                            "scheduleDayOfMonth": sched.day_of_month,
                            "scheduleAnchorDate": sched.anchor_date.isoformat()
                            if getattr(sched, "anchor_date", None)
                            else None,
                            "scheduleRecurringStart": sched.recurring_start_date.isoformat()
                            if getattr(sched, "recurring_start_date", None)
                            else None,
                        },
                    })
            current += timedelta(days=1)

    return JSONResponse(content=events)


@router.post("/api/lessons/mark-concurrent-as-group")
def mark_concurrent_as_group(
    lesson_ids: str = Form(""),
    db: Session = Depends(get_db),
):
    """When the calendar merges same-slot lessons, persist is_group_lesson on real lesson rows."""
    ids = [int(x) for x in (lesson_ids or "").split(",") if x.strip().isdigit()]
    if len(ids) < 2:
        return JSONResponse(content={"ok": True, "updated": 0})
    lessons = db.query(models.Lesson).filter(models.Lesson.id.in_(ids)).all()
    updated = 0
    for lesson in lessons:
        if not getattr(lesson, "is_group_lesson", False):
            lesson.is_group_lesson = True
            updated += 1
    if updated:
        db.commit()
    return JSONResponse(content={"ok": True, "updated": updated})


@router.post("/api/lessons/batch-update-datetime")
def batch_update_lessons_datetime(
    lesson_ids: str = Form(""),
    lesson_date: str = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    db: Session = Depends(get_db),
):
    """Move every lesson in a merged group slot to the same new window (calendar drag/resize)."""
    raw = [x.strip() for x in (lesson_ids or "").split(",") if x.strip().isdigit()]
    ids = [int(x) for x in raw]
    if len(ids) < 2:
        raise HTTPException(status_code=400, detail="נדרשים לפחות שני שיעורים")
    d = date.fromisoformat(str(lesson_date).strip()[:10])
    st = _parse_time_loose(start_time)
    en = _parse_time_loose(end_time)
    lessons = db.query(models.Lesson).filter(models.Lesson.id.in_(ids)).all()
    if len(lessons) != len(ids):
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
    found = {lesson.id for lesson in lessons}
    if found != set(ids):
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
    for lesson in lessons:
        lesson.lesson_date = d
        lesson.start_time = st
        lesson.end_time = en
    db.commit()
    return JSONResponse(content={"ok": True, "updated": len(lessons)})


@router.post("/api/lessons/skip-recurring-slot")
def skip_recurring_slot_api(
    student_id: int = Form(...),
    slot_date: str = Form(...),
    start_time: str = Form(...),
    end_time: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Hide one virtual recurring occurrence: add a cancelled lesson so the slot no longer shows."""
    d = date.fromisoformat(slot_date)
    st = _parse_time_loose(start_time)
    en = _end_or_default(d, st, end_time)
    already = (
        db.query(models.Lesson)
        .filter(
            models.Lesson.student_id == student_id,
            models.Lesson.lesson_date == d,
            models.Lesson.start_time == st,
            models.Lesson.end_time == en,
        )
        .first()
    )
    if not already:
        placeholder = models.Lesson(
            student_id=student_id,
            lesson_date=d,
            start_time=st,
            end_time=en,
            price=0,
            status="cancelled",
            is_paid=False,
            notes="הוסר מהלוח (מופע חד-פעמי)",
        )
        db.add(placeholder)
        db.commit()
    return JSONResponse(content={"status": "ok"})


@router.post("/api/lessons/materialize-from-slot")
def materialize_from_slot_api(
    student_id: int = Form(...),
    slot_date: str = Form(...),
    start_time: str = Form(...),
    end_time: Optional[str] = Form(None),
    is_group_lesson: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Turn a calendar recurring placeholder into a real Lesson row (attendance / payment UI)."""
    def _materialized_payload(lesson: models.Lesson, existed: bool) -> dict:
        return {
            "id": lesson.id,
            "existed": existed,
            "student_id": lesson.student_id,
            "lesson_date": lesson.lesson_date.isoformat(),
            "start_time": lesson.start_time.isoformat(timespec="minutes"),
            "end_time": lesson.end_time.isoformat(timespec="minutes"),
            "price": int(lesson.price or 0),
            "status": lesson.status,
            "attendance": lesson.attendance,
            "is_paid": bool(lesson.is_paid),
            "paid_amount": lesson.paid_amount,
            "payment_method": lesson.payment_method or "",
            "payment_note": getattr(lesson, "payment_note", None) or "",
            "notes": lesson.notes or "",
            "is_group_lesson": bool(getattr(lesson, "is_group_lesson", False)),
        }

    d = date.fromisoformat(str(slot_date).strip()[:10])
    st = _parse_time_loose(start_time)
    en = _end_or_default(d, st, end_time)
    is_group = str(is_group_lesson or "").strip().lower() in ("true", "1", "yes")
    row = (
        db.query(models.Lesson)
        .filter(
            models.Lesson.student_id == student_id,
            models.Lesson.lesson_date == d,
            models.Lesson.start_time == st,
            models.Lesson.end_time == en,
        )
        .first()
    )
    if row:
        if is_group and not getattr(row, "is_group_lesson", False):
            row.is_group_lesson = True
            if not getattr(row, "is_paid", False):
                student_for_price = row.student or db.query(models.Student).filter(models.Student.id == student_id).first()
                if student_for_price:
                    row.price = effective_student_default_price_for_lesson(db, student_for_price, True)
            db.commit()
            db.refresh(row)
        return JSONResponse(content=_materialized_payload(row, True))
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    family_utils.get_or_create_family_for_student(db, student, models)
    price = effective_student_default_price_for_lesson(db, student, is_group)
    lesson = models.Lesson(
        student_id=student_id,
        lesson_date=d,
        start_time=st,
        end_time=en,
        price=price,
        status="scheduled",
        attendance="expected",
        is_paid=False,
        paid_amount=None,
        payment_method="",
        payment_note="",
        notes="",
        is_group_lesson=is_group,
    )
    db.add(lesson)
    db.commit()
    db.refresh(lesson)
    return JSONResponse(content=_materialized_payload(lesson, False))


@router.get("/api/students-list")
def get_students_list(db: Session = Depends(get_db)):
    students = db.query(models.Student).order_by(models.Student.last_name).all()
    ind, grp = get_default_lesson_prices(db)
    return {
        "students": [
            {
                "id": s.id,
                "name": f"{s.first_name} {s.last_name}",
                "default_price": s.default_price,
                "default_price_group": int(getattr(s, "default_price_group", None) or 0),
                "lesson_type": getattr(s, "lesson_type", None) or "individual",
            }
            for s in students
        ],
        "defaults": {"individual": ind, "group": grp},
    }


# --- Create lesson (from calendar modal) ---

@router.post("/api/lessons/create")
def create_lesson_api(
    student_id: int = Form(...),
    lesson_date: str = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    price: int = Form(0),
    notes: str = Form(""),
    attendance: Optional[str] = Form(None),
    is_paid: Optional[str] = Form(None),
    paid_amount: Optional[str] = Form(None),
    payment_method: Optional[str] = Form(None),
    payment_note: Optional[str] = Form(None),
    is_group_lesson: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    att = "expected"
    if attendance and str(attendance).strip().lower() in ALLOWED_ATTENDANCE:
        att = str(attendance).strip().lower()
    paid_flag = bool(is_paid and str(is_paid).strip().lower() in ("true", "1", "yes"))
    pam: Optional[int] = None
    if paid_amount is not None and str(paid_amount).strip() != "":
        try:
            pam = max(0, int(str(paid_amount).strip()))
        except ValueError:
            pam = None
    pmeth = _coerce_payment_method(payment_method)
    if pmeth is None:
        pmeth = ""
    pn = (str(payment_note).strip()[:255] if payment_note is not None else "") if paid_flag else ""
    if pmeth != "other":
        pn = ""
    grp = bool(is_group_lesson and str(is_group_lesson).strip().lower() in ("true", "1", "yes"))
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    if price < 0:
        raise HTTPException(status_code=400, detail="מחיר לא יכול להיות שלילי")
    if price <= 0:
        price = effective_student_default_price_for_lesson(db, student, grp)
    family = family_utils.get_or_create_family_for_student(db, student, models)
    lesson = models.Lesson(
        student_id=student_id,
        lesson_date=date.fromisoformat(lesson_date),
        start_time=dt_time.fromisoformat(start_time),
        end_time=dt_time.fromisoformat(end_time),
        price=price,
        is_group_lesson=grp,
        status="scheduled",
        attendance=att,
        is_paid=paid_flag,
        paid_amount=pam if paid_flag else None,
        payment_method=pmeth if paid_flag else "",
        payment_note=pn,
        notes=notes,
    )
    if paid_flag and lesson.paid_amount is None:
        lesson.paid_amount = price
    if paid_flag:
        lesson.status = "completed"
        if lesson.attendance == "expected":
            lesson.attendance = "arrived"
        lesson.payment_finalized = True
    db.add(lesson)
    db.flush()
    lesson.balance_applied = _lesson_payment_net_for_balance(lesson)
    family.balance = _recompute_family_balance_from_lessons(db, family.id)
    student.balance = 0
    db.commit()
    db.refresh(lesson)
    return JSONResponse(content={"id": lesson.id, "status": "ok"})


# --- Add weekly recurring slot (same data as student page «שיעורים חוזרים») ---

def _parse_optional_date_field(raw: Optional[str]) -> Optional[date]:
    s = (raw or "").strip()
    if not s or len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


@router.post("/api/lessons/recurring-schedule/add")
def add_recurring_schedule_api(
    student_id: int = Form(...),
    day_of_week: int = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    frequency: str = Form("weekly"),
    anchor_date: Optional[str] = Form(None),
    day_of_month: Optional[int] = Form(None),
    recurring_start_date: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Create a RegularSchedule row — appears on calendar and on the student's recurring section."""
    freq = (frequency or "weekly").strip().lower()
    if freq not in ("weekly", "biweekly", "monthly"):
        freq = "weekly"
    if day_of_week < 0 or day_of_week > 6:
        raise HTTPException(status_code=400, detail="יום לא תקין")
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    st = _parse_time_loose(start_time)
    en = _parse_time_loose(end_time)
    anchor_d: Optional[date] = None
    dom: Optional[int] = None
    if freq == "biweekly":
        raw_a = (anchor_date or "").strip()
        if not raw_a:
            raise HTTPException(status_code=400, detail="נדרש תאריך בסיס לדו-שבועי")
        anchor_d = date.fromisoformat(raw_a[:10])
    elif freq == "monthly":
        if day_of_month is None:
            raise HTTPException(status_code=400, detail="נדרש יום בחודש (1–31)")
        dom = int(day_of_month)
        if dom < 1 or dom > 31:
            raise HTTPException(status_code=400, detail="יום בחודש לא תקין")
    recur_start = _parse_optional_date_field(recurring_start_date)
    sched = models.RegularSchedule(
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=st,
        end_time=en,
        frequency=freq,
        anchor_date=anchor_d,
        day_of_month=dom,
        recurring_start_date=recur_start,
    )
    db.add(sched)
    _clear_matching_hidden_recurring_placeholders(
        db,
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=st,
        end_time=en,
        frequency=freq,
        anchor_date=anchor_d,
        day_of_month=dom,
        recurring_start_date=recur_start,
    )
    db.commit()
    db.refresh(sched)
    return JSONResponse(content={"id": sched.id, "status": "ok"})


@router.post("/api/lessons/recurring-schedule/{sched_id}/update")
def update_recurring_schedule_api(
    sched_id: int,
    student_id: int = Form(...),
    day_of_week: int = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    frequency: str = Form("weekly"),
    anchor_date: Optional[str] = Form(None),
    day_of_month: Optional[int] = Form(None),
    recurring_start_date: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Update an existing regular schedule (weekly / biweekly / monthly)."""
    sched = (
        db.query(models.RegularSchedule)
        .filter(models.RegularSchedule.id == sched_id)
        .first()
    )
    if not sched:
        raise HTTPException(status_code=404, detail="לוח קבוע לא נמצא")
    if sched.student_id != student_id:
        raise HTTPException(status_code=400, detail="התלמיד אינו תואם לשיעור הקבוע")

    freq = (frequency or "weekly").strip().lower()
    if freq not in ("weekly", "biweekly", "monthly"):
        freq = "weekly"
    if day_of_week < 0 or day_of_week > 6:
        raise HTTPException(status_code=400, detail="יום לא תקין")

    st = _parse_time_loose(start_time)
    en = _parse_time_loose(end_time)
    anchor_d: Optional[date] = None
    dom: Optional[int] = None
    if freq == "biweekly":
        raw_a = (anchor_date or "").strip()
        if not raw_a:
            raise HTTPException(status_code=400, detail="נדרש תאריך בסיס לדו-שבועי")
        anchor_d = date.fromisoformat(raw_a[:10])
    elif freq == "monthly":
        if day_of_month is None:
            raise HTTPException(status_code=400, detail="נדרש יום בחודש (1–31)")
        dom = int(day_of_month)
        if dom < 1 or dom > 31:
            raise HTTPException(status_code=400, detail="יום בחודש לא תקין")

    sched.day_of_week = day_of_week
    sched.start_time = st
    sched.end_time = en
    sched.frequency = freq
    if freq == "weekly":
        sched.anchor_date = None
        sched.day_of_month = None
    elif freq == "biweekly":
        sched.anchor_date = anchor_d
        sched.day_of_month = None
    else:
        sched.anchor_date = None
        sched.day_of_month = dom
    sched.recurring_start_date = _parse_optional_date_field(recurring_start_date)
    _clear_matching_hidden_recurring_placeholders(
        db,
        student_id=student_id,
        day_of_week=sched.day_of_week,
        start_time=sched.start_time,
        end_time=sched.end_time,
        frequency=sched.frequency,
        anchor_date=sched.anchor_date,
        day_of_month=sched.day_of_month,
        recurring_start_date=sched.recurring_start_date,
        recurring_end_date=sched.recurring_end_date,
    )
    db.commit()
    return JSONResponse(content={"status": "ok"})


@router.post("/api/lessons/recurring-schedule/{sched_id}/split-and-move")
def split_and_move_recurring_schedule_api(
    sched_id: int,
    student_id: int = Form(...),
    original_date: str = Form(...),
    original_start: str = Form(...),
    original_end: str = Form(...),
    new_date: str = Form(...),
    new_start: str = Form(...),
    new_end: str = Form(...),
    db: Session = Depends(get_db),
):
    """End one recurrence and begin an equivalent one from the moved occurrence onward."""
    sched = db.query(models.RegularSchedule).filter(models.RegularSchedule.id == sched_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="לוח קבוע לא נמצא")
    if sched.student_id != student_id:
        raise HTTPException(status_code=400, detail="התלמיד אינו תואם לשיעור הקבוע")

    orig = date.fromisoformat(str(original_date).strip()[:10])
    new = date.fromisoformat(str(new_date).strip()[:10])
    orig_st = _parse_time_loose(original_start)
    orig_en = _parse_time_loose(original_end)
    new_st = _parse_time_loose(new_start)
    new_en = _parse_time_loose(new_end)
    if new < orig:
        raise HTTPException(status_code=400, detail="אפשר להחיל שינוי על שיעורים עתידיים רק מהשיעור שנגרר והלאה")
    if not _schedule_matches_date(sched, orig) or sched.start_time != orig_st or sched.end_time != orig_en:
        raise HTTPException(status_code=400, detail="השיעור הקבוע כבר השתנה; רענני את הלוח ונסי שוב")

    freq = _sched_frequency(sched)
    new_sched = models.RegularSchedule(
        student_id=student_id,
        day_of_week=_python_weekday_to_app_day(new.weekday()),
        start_time=new_st,
        end_time=new_en,
        frequency=freq,
        anchor_date=new if freq == "biweekly" else None,
        day_of_month=new.day if freq == "monthly" else None,
        recurring_start_date=new,
        recurring_end_date=None,
    )
    # The old rule still describes all earlier sessions, but must stop before the moved one.
    sched.recurring_end_date = orig - timedelta(days=1)
    db.add(new_sched)
    db.commit()
    db.refresh(new_sched)
    return JSONResponse(content={"status": "ok", "id": new_sched.id})


@router.post("/api/lessons/group-recurring/move")
def move_group_recurring_api(
    members: str = Form(...),
    scope: str = Form(...),
    original_date: str = Form(...),
    original_start: str = Form(...),
    original_end: str = Form(...),
    new_date: str = Form(...),
    new_start: str = Form(...),
    new_end: str = Form(...),
    db: Session = Depends(get_db),
):
    """Move a merged recurring group slot atomically for all students in that slot."""
    try:
        raw_members = json.loads(members)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="פרטי הקבוצה אינם תקינים")
    if not isinstance(raw_members, list) or len(raw_members) < 2:
        raise HTTPException(status_code=400, detail="נדרשים לפחות שני תלמידים בקבוצה")

    move_scope = str(scope or "").strip().lower()
    if move_scope not in {"one", "future"}:
        raise HTTPException(status_code=400, detail="סוג שינוי לא תקין")

    orig = date.fromisoformat(str(original_date).strip()[:10])
    new = date.fromisoformat(str(new_date).strip()[:10])
    orig_st = _parse_time_loose(original_start)
    orig_en = _parse_time_loose(original_end)
    new_st = _parse_time_loose(new_start)
    new_en = _parse_time_loose(new_end)
    if move_scope == "future" and new < orig:
        raise HTTPException(status_code=400, detail="אפשר להחיל שינוי על שיעורים עתידיים רק מהשיעור שנגרר והלאה")

    prepared = []
    for item in raw_members:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="פרטי הקבוצה אינם תקינים")
        try:
            student_id = int(item.get("student_id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="תלמיד בקבוצה אינו תקין")
        student = db.query(models.Student).filter(models.Student.id == student_id).first()
        if not student:
            raise HTTPException(status_code=404, detail="תלמיד בקבוצה לא נמצא")
        try:
            price = int(item.get("price") or 0)
        except (TypeError, ValueError):
            price = 0
        notes = str(item.get("notes") or "")
        sched = None
        if move_scope == "future":
            try:
                schedule_id = int(item.get("schedule_id"))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="לוח קבוע בקבוצה אינו תקין")
            sched = db.query(models.RegularSchedule).filter(models.RegularSchedule.id == schedule_id).first()
            if not sched or sched.student_id != student_id:
                raise HTTPException(status_code=404, detail="לוח קבוע בקבוצה לא נמצא")
            if not _schedule_matches_date(sched, orig) or sched.start_time != orig_st or sched.end_time != orig_en:
                raise HTTPException(status_code=400, detail="אחד השיעורים הקבועים כבר השתנה; רענני את הלוח ונסי שוב")
        prepared.append({"student": student, "price": price, "notes": notes, "schedule": sched})

    if move_scope == "future":
        for item in prepared:
            sched = item["schedule"]
            freq = _sched_frequency(sched)
            db.add(models.RegularSchedule(
                student_id=item["student"].id,
                day_of_week=_python_weekday_to_app_day(new.weekday()),
                start_time=new_st,
                end_time=new_en,
                frequency=freq,
                anchor_date=new if freq == "biweekly" else None,
                day_of_month=new.day if freq == "monthly" else None,
                recurring_start_date=new,
                recurring_end_date=None,
            ))
            sched.recurring_end_date = orig - timedelta(days=1)
        db.commit()
        return JSONResponse(content={"ok": True, "updated": len(prepared), "scope": "future"})

    moved = orig != new or orig_st != new_st or orig_en != new_en
    for item in prepared:
        student = item["student"]
        price = item["price"]
        if price <= 0:
            price = effective_student_default_price_for_lesson(db, student, True)
        family_utils.get_or_create_family_for_student(db, student, models)
        if moved:
            already = db.query(models.Lesson).filter(
                models.Lesson.student_id == student.id,
                models.Lesson.lesson_date == orig,
                models.Lesson.start_time == orig_st,
                models.Lesson.end_time == orig_en,
            ).first()
            if not already:
                db.add(models.Lesson(
                    student_id=student.id,
                    lesson_date=orig,
                    start_time=orig_st,
                    end_time=orig_en,
                    price=0,
                    status="cancelled",
                    is_paid=False,
                    notes="הועבר לתאריך אחר",
                ))
        db.add(models.Lesson(
            student_id=student.id,
            lesson_date=new,
            start_time=new_st,
            end_time=new_en,
            price=price,
            is_group_lesson=True,
            status="scheduled",
            is_paid=False,
            paid_amount=None,
            payment_method="",
            notes=item["notes"],
        ))
    db.commit()
    return JSONResponse(content={"ok": True, "updated": len(prepared), "scope": "one"})


@router.post("/api/lessons/recurring-schedule/{sched_id}/delete")
def delete_recurring_schedule_api(sched_id: int, db: Session = Depends(get_db)):
    sched = (
        db.query(models.RegularSchedule)
        .filter(models.RegularSchedule.id == sched_id)
        .first()
    )
    if sched:
        db.delete(sched)
        db.commit()
    return JSONResponse(content={"status": "ok"})


# --- Confirm a single occurrence of a recurring slot (optionally move to new date) ---

@router.post("/api/lessons/confirm-recurring")
def confirm_recurring_api(
    student_id: int = Form(...),
    original_date: str = Form(...),
    original_start: str = Form(...),
    original_end: Optional[str] = Form(None),
    new_date: str = Form(...),
    new_start: str = Form(...),
    new_end: Optional[str] = Form(None),
    price: int = Form(0),
    notes: str = Form(""),
    paid_amount: Optional[str] = Form(None),
    payment_method: Optional[str] = Form(None),
    is_group_lesson: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    orig = date.fromisoformat(original_date)
    new  = date.fromisoformat(new_date)
    orig_st = _parse_time_loose(original_start)
    orig_en = _end_or_default(orig, orig_st, original_end)
    new_st = _parse_time_loose(new_start)
    new_en = _end_or_default(new, new_st, new_end)

    # A moved one-off occurrence must block the original virtual slot even when only
    # its *time* changed.  Otherwise the calendar shows both occurrences.
    if orig != new or orig_st != new_st or orig_en != new_en:
        already = db.query(models.Lesson).filter(
            models.Lesson.student_id == student_id,
            models.Lesson.lesson_date == orig,
            models.Lesson.start_time == orig_st,
            models.Lesson.end_time == orig_en,
        ).first()
        if not already:
            placeholder = models.Lesson(
                student_id=student_id,
                lesson_date=orig,
                start_time=orig_st,
                end_time=orig_en,
                price=0,
                status="cancelled",
                is_paid=False,
                notes="הועבר לתאריך אחר",
            )
            db.add(placeholder)

    pam: Optional[int] = None
    if paid_amount is not None and str(paid_amount).strip() != "":
        try:
            pam = max(0, int(str(paid_amount).strip()))
        except ValueError:
            pam = None
    pmeth_raw = _coerce_payment_method(payment_method)
    pmeth = pmeth_raw if pmeth_raw is not None else ""
    grp = bool(is_group_lesson and str(is_group_lesson).strip().lower() in ("true", "1", "yes"))

    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    if price < 0:
        raise HTTPException(status_code=400, detail="מחיר לא יכול להיות שלילי")
    if price <= 0:
        price = effective_student_default_price_for_lesson(db, student, grp)
    family = family_utils.get_or_create_family_for_student(db, student, models)

    # Create the real lesson at the (possibly new) date
    lesson = models.Lesson(
        student_id=student_id,
        lesson_date=new,
        start_time=new_st,
        end_time=new_en,
        price=price,
        is_group_lesson=grp,
        status="scheduled",
        is_paid=False,
        paid_amount=None,
        payment_method="",
        notes=notes,
    )
    if pam is not None:
        lesson.is_paid = True
        lesson.paid_amount = pam
        lesson.payment_method = pmeth or "cash"
        lesson.status = "completed"
        lesson.attendance = "arrived"
    db.add(lesson)
    db.flush()
    lesson.balance_applied = _lesson_payment_net_for_balance(lesson)
    family.balance = _recompute_family_balance_from_lessons(db, family.id)
    student.balance = 0
    db.commit()
    db.refresh(lesson)
    return JSONResponse(content={"id": lesson.id, "status": "ok"})


# --- Update lesson (date change, status, paid toggle) ---

@router.post("/api/lessons/{lesson_id}/update")
def update_lesson_api(
    lesson_id: int,
    student_id: Optional[str] = Form(None),
    lesson_date: Optional[str] = Form(None),
    start_time: Optional[str] = Form(None),
    end_time: Optional[str] = Form(None),
    status: Optional[str] = Form(None),
    is_paid: Optional[str] = Form(None),
    attendance: Optional[str] = Form(None),
    price: Optional[int] = Form(None),
    notes: Optional[str] = Form(None),
    paid_amount: Optional[str] = Form(None),
    payment_method: Optional[str] = Form(None),
    payment_note: Optional[str] = Form(None),
    payment_finalized: Optional[str] = Form(None),
    is_group_lesson: Optional[str] = Form(None),
    change_given: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")

    sid_before = lesson.student_id
    if student_id is not None and str(student_id).strip() != "":
        try:
            sid = int(student_id)
            if sid > 0:
                st = db.query(models.Student).filter(models.Student.id == sid).first()
                if st:
                    lesson.student_id = sid
        except ValueError:
            pass
    if lesson_date is not None:
        lesson.lesson_date = date.fromisoformat(lesson_date)
    if start_time is not None:
        lesson.start_time = dt_time.fromisoformat(start_time)
    if end_time is not None:
        lesson.end_time = dt_time.fromisoformat(end_time)
    if status is not None:
        lesson.status = status
    if is_paid is not None:
        lesson.is_paid = is_paid.lower() in ("true", "1", "yes")
        if not lesson.is_paid:
            lesson.paid_amount = None
            lesson.payment_method = ""
            lesson.payment_note = ""
            lesson.change_given = False
    if attendance is not None:
        a = attendance.strip().lower()
        if a in ALLOWED_ATTENDANCE:
            lesson.attendance = a
    if price is not None:
        if price < 0:
            raise HTTPException(status_code=400, detail="מחיר לא יכול להיות שלילי")
        lesson.price = price
    if notes is not None:
        lesson.notes = notes
    if paid_amount is not None:
        s = str(paid_amount).strip()
        if s == "":
            lesson.paid_amount = None
        else:
            try:
                lesson.paid_amount = max(0, int(s))
            except ValueError:
                pass
    pm = _coerce_payment_method(payment_method)
    if pm is not None:
        lesson.payment_method = pm
    if payment_note is not None:
        lesson.payment_note = str(payment_note).strip()[:255]
    if pm is not None and pm != "other":
        lesson.payment_note = ""
    if lesson.is_paid and lesson.paid_amount is None:
        lesson.paid_amount = lesson.price

    _normalize_lesson_paid_from_amounts(lesson)

    if payment_finalized is not None:
        pfv = str(payment_finalized).strip().lower()
        if pfv in ("true", "1", "yes"):
            lesson.payment_finalized = True
        elif pfv in ("false", "0", "no"):
            lesson.payment_finalized = False
    if is_paid is not None and lesson.is_paid:
        lesson.payment_finalized = True

    if is_group_lesson is not None:
        lesson.is_group_lesson = str(is_group_lesson).strip().lower() in ("true", "1", "yes")

    if change_given is not None:
        lesson.change_given = str(change_given).strip().lower() in ("true", "1", "yes", "on")

    if lesson.is_paid and lesson.paid_amount is not None:
        pc = int(lesson.price or 0)
        pamt = int(lesson.paid_amount)
        if pamt <= pc:
            lesson.change_given = False

    if lesson.student_id != sid_before:
        lesson.balance_applied = 0

    new_net = _lesson_payment_net_for_balance(lesson)
    lesson.balance_applied = new_net
    st = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    fam_bal = 0
    if st:
        family_utils.get_or_create_family_for_student(db, st, models)
        db.refresh(st)
        db.flush()
        fam_ids_to_sync: Set[int] = set()
        if lesson.student_id != sid_before:
            ost_prev = db.query(models.Student).filter(models.Student.id == sid_before).first()
            if ost_prev and ost_prev.family_id:
                fam_ids_to_sync.add(ost_prev.family_id)
        if st.family_id:
            fam_ids_to_sync.add(st.family_id)
        for fid in fam_ids_to_sync:
            fam_row = db.query(models.Family).filter(models.Family.id == fid).first()
            if fam_row:
                fam_row.balance = _recompute_family_balance_from_lessons(db, fid)
        # The balance is derived from lesson rows.  Remove an obsolete legacy
        # ledger row rather than appending a second row for every edit.
        _delete_balance_transactions_for_lesson(db, lesson.id)
        if st.family_id:
            fam_cur = db.query(models.Family).filter(models.Family.id == st.family_id).first()
            if fam_cur:
                fam_bal = int(getattr(fam_cur, "balance", 0) or 0)
        st.balance = 0

    db.commit()
    db.refresh(lesson)
    st2 = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    fam2 = (
        db.query(models.Family).filter(models.Family.id == st2.family_id).first()
        if st2 and st2.family_id
        else None
    )
    bal = int(getattr(fam2, "balance", 0) or 0) if fam2 else fam_bal

    return JSONResponse(
        content={
            "status": "ok",
            "family_balance": bal,
            "student_balance": bal,
            "lesson_balance_applied": int(getattr(lesson, "balance_applied", 0) or 0),
            "balance_hint_he": _payment_feedback_he(lesson, bal),
            "change_given": bool(getattr(lesson, "change_given", False)),
            "is_partial_payment": _lesson_is_partial_payment(lesson),
        }
    )


def _delete_recurring_lesson_and_future(db: Session, lesson: models.Lesson) -> Optional[dict[str, Any]]:
    """Stop matching schedules before this lesson date and remove this saved occurrence."""
    schedules = _matching_recurring_schedules_for_lesson(lesson, db)
    if not schedules:
        return None
    st = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    fid = st.family_id if st else None
    undo = {
        "kind": "future",
        "schedule_end_dates": [
            {"id": sched.id, "recurring_end_date": sched.recurring_end_date.isoformat() if sched.recurring_end_date else None}
            for sched in schedules
        ],
    }
    original_rules = [
        SimpleNamespace(
            day_of_week=sched.day_of_week,
            start_time=sched.start_time,
            end_time=sched.end_time,
            frequency=sched.frequency,
            anchor_date=sched.anchor_date,
            day_of_month=sched.day_of_month,
            recurring_start_date=sched.recurring_start_date,
            recurring_end_date=sched.recurring_end_date,
        )
        for sched in schedules
    ]
    for sched in schedules:
        sched.recurring_end_date = lesson.lesson_date - timedelta(days=1)

    future_candidates = db.query(models.Lesson).filter(
        models.Lesson.student_id == lesson.student_id,
        models.Lesson.lesson_date >= lesson.lesson_date,
        models.Lesson.start_time == lesson.start_time,
        models.Lesson.end_time == lesson.end_time,
    ).all()
    for candidate in future_candidates:
        if candidate.id == lesson.id:
            continue
        if not any(_schedule_matches_date(rule, candidate.lesson_date) for rule in original_rules):
            continue
        if _calendar_skip_placeholder(candidate) or (
            candidate.status != "completed" and not candidate.is_paid and not candidate.payment_finalized
        ):
            _delete_balance_transactions_for_lesson(db, candidate.id)
            db.delete(candidate)

    _reverse_lesson_balance_on_family(lesson, db)
    _delete_balance_transactions_for_lesson(db, lesson.id)
    db.delete(lesson)
    db.flush()
    if fid:
        fam = db.query(models.Family).filter(models.Family.id == fid).first()
        if fam:
            fam.balance = _recompute_family_balance_from_lessons(db, fid)
    return undo


def delete_lesson_record(db: Session, lesson: models.Lesson, scope: str = "one") -> Optional[dict[str, Any]]:
    """Apply calendar-equivalent delete: recurring slot → cancelled placeholder; else remove row.
    Updates family balance; does not commit — caller must ``db.commit()``."""
    if (scope or "").strip().lower() == "future":
        undo = _delete_recurring_lesson_and_future(db, lesson)
        if undo:
            return undo
    st = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    fid = st.family_id if st else None
    _reverse_lesson_balance_on_family(lesson, db)
    undo: Optional[dict[str, Any]] = None
    if _lesson_matches_any_recurring_slot(lesson, db):
        # Remove this date from the calendar but keep RegularSchedule — same as skip-slot
        lesson.status = "cancelled"
        lesson.is_paid = False
        lesson.paid_amount = None
        lesson.payment_method = ""
        lesson.payment_note = ""
        lesson.attendance = "expected"
        lesson.price = 0
        lesson.notes = "הוסר מהלוח — המחזוריות נשארת"
        db.flush()
        undo = {"kind": "one", "lesson_id": lesson.id}
    else:
        _delete_balance_transactions_for_lesson(db, lesson.id)
        db.delete(lesson)
        db.flush()
    if fid:
        fam = db.query(models.Family).filter(models.Family.id == fid).first()
        if fam:
            fam.balance = _recompute_family_balance_from_lessons(db, fid)
    return undo


@router.post("/api/lessons/{lesson_id}/delete")
def delete_lesson_api(
    lesson_id: int,
    scope: str = Form("one"),
    db: Session = Depends(get_db),
):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        return JSONResponse(content={"status": "ok"})
    undo = delete_lesson_record(db, lesson, scope=scope)
    undo_token = None
    if undo:
        undo_token = secrets.token_urlsafe(16)
        RECENT_DELETE_UNDO[undo_token] = undo
    db.commit()
    return JSONResponse(content={"status": "ok", "undo_token": undo_token})


@router.post("/api/lessons/delete/undo")
def undo_delete_lesson_api(
    token: str = Form(...),
    db: Session = Depends(get_db),
):
    undo = RECENT_DELETE_UNDO.pop((token or "").strip(), None)
    if not undo:
        raise HTTPException(status_code=404, detail="לא נמצאה מחיקה לביטול")
    kind = undo.get("kind")
    if kind == "one":
        lesson = db.query(models.Lesson).filter(models.Lesson.id == int(undo["lesson_id"])).first()
        if lesson and _calendar_skip_placeholder(lesson):
            db.delete(lesson)
            db.commit()
        return JSONResponse(content={"status": "ok"})
    if kind == "future":
        for item in undo.get("schedule_end_dates", []):
            sched = db.query(models.RegularSchedule).filter(
                models.RegularSchedule.id == int(item["id"])
            ).first()
            if not sched:
                continue
            raw_end = item.get("recurring_end_date")
            sched.recurring_end_date = date.fromisoformat(raw_end) if raw_end else None
        db.commit()
        return JSONResponse(content={"status": "ok"})
    raise HTTPException(status_code=400, detail="סוג ביטול לא תקין")


# --- Lesson detail page ---

@router.get("/lessons/{lesson_id}", response_class=HTMLResponse)
def lesson_detail(request: Request, lesson_id: int, db: Session = Depends(get_db)):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
    # There is no standalone lesson template; keep legacy links useful instead
    # of returning a template-not-found 500.
    return RedirectResponse(url="/calendar", status_code=303)
