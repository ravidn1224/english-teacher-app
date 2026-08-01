import re
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session, joinedload
from typing import Any, Dict, List, Optional

from ..database import get_db
from .. import models
from .. import family_utils
from ..app_settings import get_default_lesson_prices, set_default_lesson_prices
from ..templating import templates

router = APIRouter(prefix="/students", tags=["students"])

DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
DAY_NAMES_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"]


def _normalize_phone(phone: Optional[str]) -> str:
    """Same idea as reports: 050-123 match 0501234567 for family grouping."""
    return re.sub(r"\D", "", phone or "")


def _search_blob_for_group(
    members: List[models.Student],
    parent_names: List[str],
    phone_display: str,
) -> str:
    """Lowercase haystack for client-side filter (names + phone digits)."""
    parts: List[str] = []
    for m in members:
        parts.extend(
            [
                (m.first_name or "").strip(),
                (m.last_name or "").strip(),
                (m.parent_name or "").strip(),
                (m.parent_phone or "").strip(),
            ]
        )
    for pn in parent_names:
        parts.append(pn.strip())
    if phone_display:
        parts.append(phone_display.strip())
    raw = " ".join(p for p in parts if p)
    raw = " ".join(raw.split())
    digits = re.sub(r"\D", "", raw)
    return f"{raw} {digits}".lower()


def _family_groups_from_students(students: List[models.Student]) -> List[Dict[str, Any]]:
    """Group students who share the same normalized parent phone; others are solo groups."""
    buckets: Dict[str, List[models.Student]] = defaultdict(list)
    for s in students:
        key = _normalize_phone(s.parent_phone)
        if key:
            buckets[key].append(s)
        else:
            buckets[f"_solo_{s.id}"].append(s)

    groups: List[Dict[str, Any]] = []
    for _key, members in buckets.items():
        members = sorted(members, key=lambda m: (m.last_name or "", m.first_name or ""))
        phone_display = ""
        for m in members:
            raw = (m.parent_phone or "").strip()
            if raw:
                phone_display = raw
                break
        parent_names: List[str] = []
        seen = set()
        for m in members:
            pn = (m.parent_name or "").strip()
            if pn and pn not in seen:
                seen.add(pn)
                parent_names.append(pn)
        groups.append(
            {
                "members": members,
                "is_multi": len(members) > 1,
                "phone_display": phone_display,
                "parent_names": parent_names,
                "search_blob": _search_blob_for_group(members, parent_names, phone_display),
            }
        )

    # Families with several children first, then alphabetical by first child
    groups.sort(
        key=lambda g: (
            0 if g["is_multi"] else 1,
            (g["members"][0].last_name or "").lower(),
            (g["members"][0].first_name or "").lower(),
        )
    )
    return groups


def _apply_student_rows_for_global_price_change(
    db: Session,
    old_ind: int,
    old_grp: int,
    mode: str,
) -> None:
    """When globals change: either snapshot old rates on «default» students or clear to follow new globals."""
    mode = (mode or "").strip().lower()
    if mode not in ("propagate", "grandfather"):
        return
    for s in db.query(models.Student).all():
        dp = int(getattr(s, "default_price", 0) or 0)
        dg = int(getattr(s, "default_price_group", 0) or 0)
        if mode == "propagate":
            if dp == 0 or dp == old_ind:
                s.default_price = 0
            if dg == 0 or dg == old_grp:
                s.default_price_group = 0
        else:
            if dp == 0 or dp == old_ind:
                s.default_price = old_ind
            if dg == 0 or dg == old_grp:
                s.default_price_group = old_grp


@router.get("/", response_class=HTMLResponse)
def list_students(request: Request, db: Session = Depends(get_db)):
    students = (
        db.query(models.Student)
        .options(joinedload(models.Student.schedules))
        .order_by(models.Student.last_name, models.Student.first_name)
        .all()
    )
    student_families = _family_groups_from_students(students)
    g_ind, g_grp = get_default_lesson_prices(db)
    return templates.TemplateResponse(
        "students.html",
        {
            "request": request,
            "student_families": student_families,
            "day_names": DAY_NAMES,
            "day_names_short": DAY_NAMES_SHORT,
            "global_default_individual": g_ind,
            "global_default_group": g_grp,
            "student_has_group_lessons": _student_has_group_lessons,
            "student_has_private_lessons": _student_has_private_lessons,
            "student_lesson_type_label": _student_lesson_type_label,
        },
    )


@router.post("/settings/default-prices")
def save_global_default_prices(
    default_lesson_individual: int = Form(0),
    default_lesson_group: int = Form(0),
    defaults_change_mode: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    new_ind = max(0, int(default_lesson_individual))
    new_grp = max(0, int(default_lesson_group))
    old_ind, old_grp = get_default_lesson_prices(db)
    changed = (old_ind != new_ind) or (old_grp != new_grp)
    if changed:
        _apply_student_rows_for_global_price_change(
            db, old_ind, old_grp, (defaults_change_mode or "").strip().lower()
        )
    set_default_lesson_prices(db, new_ind, new_grp)
    db.commit()
    return RedirectResponse(url="/students/", status_code=303)


@router.get("/new", response_class=HTMLResponse)
def new_student_form(
    request: Request,
    parent_name: Optional[str] = None,
    parent_phone: Optional[str] = None,
    default_price: Optional[int] = None,
    last_name: Optional[str] = None,
    db: Session = Depends(get_db),
):
    prefill_pn = (parent_name or "").strip()
    prefill_pp = (parent_phone or "").strip()
    prefill_ln = (last_name or "").strip()
    g_ind, g_grp = get_default_lesson_prices(db)
    if default_price is not None:
        prefill_price = max(0, int(default_price))
    else:
        prefill_price = g_ind
    return templates.TemplateResponse(
        "student_form.html",
        {
            "request": request,
            "student": None,
            "day_names": DAY_NAMES,
            "action": "new",
            "prefill_parent_name": prefill_pn,
            "prefill_parent_phone": prefill_pp,
            "prefill_last_name": prefill_ln,
            "prefill_default_price": prefill_price,
            "global_default_individual": g_ind,
            "global_default_group": g_grp,
            "student_has_group_lessons": _student_has_group_lessons,
            "student_has_private_lessons": _student_has_private_lessons,
            "student_lesson_type_label": _student_lesson_type_label,
        },
    )


def _student_has_group_lessons(student: models.Student) -> bool:
    return (getattr(student, "lesson_type", None) or "individual").strip().lower() in (
        "group",
        "both",
    )


def _student_has_private_lessons(student: models.Student) -> bool:
    return (getattr(student, "lesson_type", None) or "individual").strip().lower() in (
        "individual",
        "both",
    )


def _student_lesson_type_label(student: models.Student) -> str:
    lesson_type = (getattr(student, "lesson_type", None) or "individual").strip().lower()
    if lesson_type == "group":
        return "קבוצתי"
    if lesson_type == "both":
        return "פרטי + קבוצתי"
    return "פרטי"


def _normalize_lesson_type(raw: Optional[str]) -> str:
    s = (raw or "").strip().lower()
    if s in ("individual", "group", "both"):
        return s
    return "individual"


@router.post("/new")
def create_student(
    request: Request,
    first_name: str = Form(...),
    last_name: str = Form(...),
    parent_name: str = Form(""),
    parent_phone: str = Form(""),
    default_price: int = Form(0),
    default_price_group: int = Form(0),
    lesson_type: Optional[str] = Form(None),
    notes: str = Form(""),
    db: Session = Depends(get_db),
):
    student = models.Student(
        first_name=first_name,
        last_name=last_name,
        parent_name=parent_name,
        parent_phone=parent_phone,
        lesson_type=_normalize_lesson_type(lesson_type),
        default_price=max(0, int(default_price)),
        default_price_group=max(0, int(default_price_group)),
        notes=notes,
    )
    db.add(student)
    db.flush()
    family_utils.get_or_create_family_for_student(db, student, models)
    db.commit()
    db.refresh(student)
    return RedirectResponse(url=f"/students/{student.id}", status_code=303)


@router.get("/{student_id}", response_class=HTMLResponse)
def student_detail(request: Request, student_id: int, db: Session = Depends(get_db)):
    student = (
        db.query(models.Student)
        .options(joinedload(models.Student.schedules))
        .filter(models.Student.id == student_id)
        .first()
    )
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    lessons = (
        db.query(models.Lesson)
        .filter(models.Lesson.student_id == student_id)
        .order_by(
            models.Lesson.lesson_date.desc(),
            models.Lesson.start_time.desc(),
            models.Lesson.id.desc(),
        )
        .all()
    )
    g_ind, g_grp = get_default_lesson_prices(db)
    return templates.TemplateResponse(
        "student_detail.html",
        {
            "request": request,
            "student": student,
            "lessons": lessons,
            "day_names": DAY_NAMES,
            "default_recur_start": date.today().isoformat(),
            "global_default_individual": g_ind,
            "global_default_group": g_grp,
            "student_has_group_lessons": _student_has_group_lessons,
            "student_has_private_lessons": _student_has_private_lessons,
            "student_lesson_type_label": _student_lesson_type_label,
        },
    )


@router.post("/{student_id}/lessons/{lesson_id}/delete")
def delete_student_lesson(student_id: int, lesson_id: int, db: Session = Depends(get_db)):
    from .lessons import delete_lesson_record

    lesson = db.query(models.Lesson).filter(models.Lesson.id == lesson_id).first()
    if not lesson or lesson.student_id != student_id:
        raise HTTPException(status_code=404, detail="שיעור לא נמצא")
    delete_lesson_record(db, lesson)
    db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)


@router.get("/{student_id}/edit", response_class=HTMLResponse)
def edit_student_form(request: Request, student_id: int, db: Session = Depends(get_db)):
    """עריכה מתבצעת בדף התלמיד; נתיב זה שומר קישורים ישנים."""
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    return RedirectResponse(url=f"/students/{student_id}", status_code=302)


@router.post("/{student_id}/edit")
def update_student(
    student_id: int,
    first_name: str = Form(...),
    last_name: str = Form(...),
    parent_name: str = Form(""),
    parent_phone: str = Form(""),
    default_price: int = Form(0),
    default_price_group: int = Form(0),
    lesson_type: Optional[str] = Form(None),
    notes: str = Form(""),
    db: Session = Depends(get_db),
):
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    old_family_id = student.family_id
    phone_changed = _normalize_phone(student.parent_phone) != _normalize_phone(parent_phone)
    student.first_name = first_name
    student.last_name = last_name
    student.parent_name = parent_name
    student.parent_phone = parent_phone
    student.lesson_type = _normalize_lesson_type(lesson_type)
    student.default_price = max(0, int(default_price))
    student.default_price_group = max(0, int(default_price_group))
    student.notes = notes
    if phone_changed:
        # Family membership is defined by the parent phone.  Re-resolve it when
        # the phone changes so the directory and the financial reports agree.
        student.family_id = None
    if not student.family_id:
        family_utils.get_or_create_family_for_student(db, student, models)
    db.flush()
    family_ids_to_sync = {fid for fid in (old_family_id, student.family_id) if fid}
    if family_ids_to_sync:
        from .lessons import _recompute_family_balance_from_lessons

        for family_id in family_ids_to_sync:
            family = db.query(models.Family).filter(models.Family.id == family_id).first()
            if family:
                family.balance = _recompute_family_balance_from_lessons(db, family_id)
    db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)


@router.post("/{student_id}/delete")
def delete_student(student_id: int, db: Session = Depends(get_db)):
    from .lessons import (
        _delete_balance_transactions_for_lesson,
        _recompute_family_balance_from_lessons,
    )

    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    family_id = student.family_id
    lesson_ids = [
        row[0]
        for row in db.query(models.Lesson.id)
        .filter(models.Lesson.student_id == student_id)
        .all()
    ]
    for lid in lesson_ids:
        _delete_balance_transactions_for_lesson(db, lid)
    db.delete(student)
    db.flush()
    if family_id:
        fam = db.query(models.Family).filter(models.Family.id == family_id).first()
        if fam:
            fam.balance = _recompute_family_balance_from_lessons(db, family_id)
    db.commit()
    return RedirectResponse(url="/students/", status_code=303)


# --- Schedule routes ---

@router.post("/{student_id}/schedule/add")
def add_schedule(
    student_id: int,
    day_of_week: int = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    recurring_start_date: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    from datetime import time as dt_time
    from .lessons import _clear_matching_hidden_recurring_placeholders

    start = dt_time.fromisoformat(start_time)
    end = dt_time.fromisoformat(end_time)
    rs_raw = (recurring_start_date or "").strip()
    rs_d: Optional[date] = None
    if rs_raw and len(rs_raw) >= 10:
        try:
            rs_d = date.fromisoformat(rs_raw[:10])
        except ValueError:
            rs_d = None
    sched = models.RegularSchedule(
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=start,
        end_time=end,
        frequency="weekly",
        recurring_start_date=rs_d,
    )
    db.add(sched)
    _clear_matching_hidden_recurring_placeholders(
        db,
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=start,
        end_time=end,
        frequency="weekly",
        recurring_start_date=rs_d,
    )
    db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)


@router.post("/{student_id}/schedule/{sched_id}/delete")
def delete_schedule(student_id: int, sched_id: int, db: Session = Depends(get_db)):
    sched = (
        db.query(models.RegularSchedule)
        .filter(models.RegularSchedule.id == sched_id)
        .filter(models.RegularSchedule.student_id == student_id)
        .first()
    )
    if sched:
        db.delete(sched)
        db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)
