from fastapi import APIRouter, Depends, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from sqlalchemy.orm import Session
from pathlib import Path
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
    return ("#0D9488", "#FFFFFF")


def _lesson_attendance_prop(lesson: models.Lesson) -> str:
    return getattr(lesson, "attendance", None) or "expected"


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

    # Real lesson events
    for lesson in real_lessons:
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
                "notes": lesson.notes or "",
                "isRecurring": False,
            },
        })

    # Virtual recurring events from regular_schedule
    if start_date and end_date:
        schedules = db.query(models.RegularSchedule).join(models.Student).all()
        current = start_date
        while current <= end_date:
            app_day = _python_weekday_to_app_day(current.weekday())
            for sched in schedules:
                if sched.day_of_week == app_day and (sched.student_id, current) not in covered:
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
                            "notes": "",
                            "isRecurring": True,
                            "scheduleId": sched.id,
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
    lesson = models.Lesson(
        student_id=student_id,
        lesson_date=date.fromisoformat(lesson_date),
        start_time=dt_time.fromisoformat(start_time),
        end_time=dt_time.fromisoformat(end_time),
        price=price,
        status="scheduled",
        attendance=att,
        is_paid=paid_flag,
        paid_amount=pam if paid_flag else None,
        payment_method=pmeth if paid_flag else "",
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

    # Create the real lesson at the (possibly new) date
    lesson = models.Lesson(
        student_id=student_id,
        lesson_date=new,
        start_time=new_st,
        end_time=new_en,
        price=price,
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
    db: Session = Depends(get_db),
):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
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
    if lesson.is_paid and lesson.paid_amount is None:
        lesson.paid_amount = lesson.price
    db.commit()
    return JSONResponse(content={"status": "ok"})


@router.post("/api/lessons/{lesson_id}/delete")
def delete_lesson_api(lesson_id: int, db: Session = Depends(get_db)):
    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if lesson:
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
