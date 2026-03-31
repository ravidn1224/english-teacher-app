from fastapi import APIRouter, Depends, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from sqlalchemy.orm import Session
from pathlib import Path
import calendar as cal_std
from datetime import date, datetime, time as dt_time, timedelta
from typing import Optional

from ..database import get_db
from .. import models
from ..templating import templates

router = APIRouter(tags=["lessons"])


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


def _lesson_event_colors(lesson: models.Lesson) -> tuple[str, str]:
    """(background_hex, text_hex) — palette aligned with app teal-emerald brand."""
    if lesson.status == "cancelled":
        return ("#94A3B8", "#FFFFFF")
    if lesson.is_paid:
        return ("#059669", "#FFFFFF")
    att = getattr(lesson, "attendance", None) or "expected"
    if att == "no_show":
        return ("#6B7280", "#FFFFFF")
    if att == "expected":
        return ("#CCFBF1", "#134E4A")
    # arrived — distinguish unpaid (amber) vs paid (handled above as green)
    if att == "arrived" and not lesson.is_paid:
        return ("#F59E0B", "#1C1917")
    return ("#0D9488", "#FFFFFF")


def _lesson_attendance_prop(lesson: models.Lesson) -> str:
    return getattr(lesson, "attendance", None) or "expected"


def _lesson_payment_net_for_balance(lesson: models.Lesson) -> int:
    """Cash effect on running balance: amount_received − lesson_charge (₪)."""
    if lesson.status == "cancelled":
        return 0
    c = int(lesson.price or 0)
    if lesson.is_paid:
        p = int(lesson.paid_amount) if lesson.paid_amount is not None else c
        return p - c
    if not bool(getattr(lesson, "payment_finalized", False)):
        return 0
    att = (getattr(lesson, "attendance", None) or "expected").lower()
    if att == "no_show":
        return 0
    return -c


def _format_balance_hint_he(bal: int) -> str:
    b = int(bal)
    if b > 0:
        return f"יתרה חדשה: ‎+₪{b} (זיכוי לתלמיד)"
    if b < 0:
        return f"יתרה חדשה: ₪{b} (התלמיד חייב ‎₪{-b})"
    return "יתרה חדשה: ‎₪0"


def _payment_feedback_he(lesson: models.Lesson, new_student_balance: int) -> str:
    """After marking paid: explain per-lesson overpayment, else running balance."""
    if lesson.is_paid and int(lesson.price or 0) > 0:
        c = int(lesson.price)
        p = int(lesson.paid_amount) if lesson.paid_amount is not None else c
        if p > c:
            over = p - c
            return f"אחרי תשלום: זיכוי ‎₪{over} — יקוזז בשיעור הבא"
    return _format_balance_hint_he(new_student_balance)


def _reverse_lesson_balance_on_student(lesson: models.Lesson, db: Session) -> None:
    applied = int(getattr(lesson, "balance_applied", 0) or 0)
    if not applied:
        return
    st = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    if st:
        st.balance = int(getattr(st, "balance", 0) or 0) - applied
    lesson.balance_applied = 0


def _lesson_matches_any_recurring_slot(lesson: models.Lesson, db: Session) -> bool:
    """True if a RegularSchedule would emit this occurrence (same student, date, start, end)."""
    schedules = (
        db.query(models.RegularSchedule)
        .filter(models.RegularSchedule.student_id == lesson.student_id)
        .all()
    )
    for sched in schedules:
        if not _schedule_matches_date(sched, lesson.lesson_date):
            continue
        if sched.start_time == lesson.start_time and sched.end_time == lesson.end_time:
            return True
    return False


def _calendar_skip_placeholder(lesson: models.Lesson) -> bool:
    """Cancelled row kept only to block a virtual recurring slot — omit from calendar UI."""
    if lesson.status != "cancelled":
        return False
    n = (lesson.notes or "").strip()
    return n.startswith("הוסר מהלוח")


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _sched_frequency(sched: models.RegularSchedule) -> str:
    return (getattr(sched, "frequency", None) or "weekly").strip().lower()


def _schedule_matches_date(sched: models.RegularSchedule, current: date) -> bool:
    """Whether a recurring schedule rule produces an occurrence on ``current``."""
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

    query = db.query(models.Lesson).join(models.Student)
    if start_date:
        query = query.filter(models.Lesson.lesson_date >= start_date)
    if end_date:
        query = query.filter(models.Lesson.lesson_date <= end_date)

    real_lessons = query.all()

    # Track which (student_id, date) slots are already covered by a real lesson
    covered = {(l.student_id, l.lesson_date) for l in real_lessons}

    events = []

    # Real lesson events (skip invisible placeholders that only block virtual recurring)
    for lesson in real_lessons:
        if _calendar_skip_placeholder(lesson):
            continue
        bg, tx = _lesson_event_colors(lesson)
        events.append({
            "id": lesson.id,
            "title": f"{lesson.student.first_name} {lesson.student.last_name}",
            "start": f"{lesson.lesson_date}T{lesson.start_time}",
            "end": f"{lesson.lesson_date}T{lesson.end_time}",
            "color": bg,
            "textColor": tx,
            "extendedProps": {
                "studentId": lesson.student_id,
                "status": lesson.status,
                "isPaid": lesson.is_paid,
                "attendance": _lesson_attendance_prop(lesson),
                "price": lesson.price,
                "paidAmount": lesson.paid_amount,
                "paymentMethod": (lesson.payment_method or ""),
                "paymentNote": getattr(lesson, "payment_note", None) or "",
                "notes": lesson.notes or "",
                "isRecurring": False,
                "studentBalance": int(getattr(lesson.student, "balance", 0) or 0),
                "isGroupLesson": bool(getattr(lesson, "is_group_lesson", False)),
                "balanceApplied": int(getattr(lesson, "balance_applied", 0) or 0),
            },
        })

    # Virtual recurring events from regular_schedule
    if start_date and end_date:
        schedules = db.query(models.RegularSchedule).join(models.Student).all()
        current = start_date
        while current <= end_date:
            for sched in schedules:
                if not _schedule_matches_date(sched, current):
                    continue
                if (sched.student_id, current) not in covered:
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
                            "status": "scheduled",
                            "isPaid": False,
                            "attendance": "expected",
                            "price": sched.student.default_price,
                            "studentBalance": int(getattr(sched.student, "balance", 0) or 0),
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
                        },
                    })
            current += timedelta(days=1)

    return JSONResponse(content=events)


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
    db: Session = Depends(get_db),
):
    """Turn a calendar recurring placeholder into a real Lesson row (attendance / payment UI)."""
    d = date.fromisoformat(str(slot_date).strip()[:10])
    st = _parse_time_loose(start_time)
    en = _end_or_default(d, st, end_time)
    row = (
        db.query(models.Lesson)
        .filter(
            models.Lesson.student_id == student_id,
            models.Lesson.lesson_date == d,
        )
        .first()
    )
    if row:
        return JSONResponse(content={"id": row.id, "existed": True})
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    price = int(student.default_price or 0)
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
    )
    db.add(lesson)
    db.commit()
    db.refresh(lesson)
    return JSONResponse(content={"id": lesson.id, "existed": False})


@router.get("/api/students-list")
def get_students_list(db: Session = Depends(get_db)):
    students = db.query(models.Student).order_by(models.Student.last_name).all()
    return [{"id": s.id, "name": f"{s.first_name} {s.last_name}", "default_price": s.default_price} for s in students]


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
    db.add(lesson)
    db.commit()
    db.refresh(lesson)
    return JSONResponse(content={"id": lesson.id, "status": "ok"})


# --- Add weekly recurring slot (same data as student page «שיעורים חוזרים») ---

@router.post("/api/lessons/recurring-schedule/add")
def add_recurring_schedule_api(
    student_id: int = Form(...),
    day_of_week: int = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    frequency: str = Form("weekly"),
    anchor_date: Optional[str] = Form(None),
    day_of_month: Optional[int] = Form(None),
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
    sched = models.RegularSchedule(
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=st,
        end_time=en,
        frequency=freq,
        anchor_date=anchor_d,
        day_of_month=dom,
    )
    db.add(sched)
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
    db.commit()
    return JSONResponse(content={"status": "ok"})


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

    # If moved to a different date, plant a cancelled placeholder on the original
    # date so the virtual slot disappears from the calendar.
    if orig != new:
        already = db.query(models.Lesson).filter(
            models.Lesson.student_id == student_id,
            models.Lesson.lesson_date == orig,
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
    db: Session = Depends(get_db),
):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")

    sid_before = lesson.student_id
    old_applied = int(getattr(lesson, "balance_applied", 0) or 0)

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
    if attendance is not None:
        a = attendance.strip().lower()
        if a in ALLOWED_ATTENDANCE:
            lesson.attendance = a
    if price is not None:
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

    if lesson.student_id != sid_before:
        ost = db.query(models.Student).filter(models.Student.id == sid_before).first()
        if ost and old_applied:
            ost.balance = int(getattr(ost, "balance", 0) or 0) - old_applied
        lesson.balance_applied = 0
        old_applied = 0

    new_net = _lesson_payment_net_for_balance(lesson)
    st = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    if st:
        st.balance = int(getattr(st, "balance", 0) or 0) + (new_net - old_applied)
    lesson.balance_applied = new_net

    db.commit()
    db.refresh(lesson)
    st2 = db.query(models.Student).filter(models.Student.id == lesson.student_id).first()
    bal = int(getattr(st2, "balance", 0) or 0) if st2 else 0

    return JSONResponse(
        content={
            "status": "ok",
            "student_balance": bal,
            "lesson_balance_applied": int(getattr(lesson, "balance_applied", 0) or 0),
            "balance_hint_he": _payment_feedback_he(lesson, bal),
        }
    )


@router.post("/api/lessons/{lesson_id}/delete")
def delete_lesson_api(lesson_id: int, db: Session = Depends(get_db)):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        return JSONResponse(content={"status": "ok"})
    _reverse_lesson_balance_on_student(lesson, db)
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
        db.commit()
    else:
        db.delete(lesson)
        db.commit()
    return JSONResponse(content={"status": "ok"})


# --- Lesson detail page ---

@router.get("/lessons/{lesson_id}", response_class=HTMLResponse)
def lesson_detail(request: Request, lesson_id: int, db: Session = Depends(get_db)):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
    return templates.TemplateResponse("lesson_detail.html", {"request": request, "lesson": lesson})
