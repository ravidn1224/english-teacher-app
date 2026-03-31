import re
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session, joinedload
from typing import Any, Dict, List, Optional

from ..database import get_db
from .. import models
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


@router.get("/", response_class=HTMLResponse)
def list_students(request: Request, db: Session = Depends(get_db)):
    students = (
        db.query(models.Student)
        .options(joinedload(models.Student.schedules))
        .order_by(models.Student.last_name, models.Student.first_name)
        .all()
    )
    student_families = _family_groups_from_students(students)
    return templates.TemplateResponse(
        "students.html",
        {
            "request": request,
            "student_families": student_families,
            "day_names": DAY_NAMES,
            "day_names_short": DAY_NAMES_SHORT,
        },
    )


@router.get("/new", response_class=HTMLResponse)
def new_student_form(
    request: Request,
    parent_name: Optional[str] = None,
    parent_phone: Optional[str] = None,
    default_price: Optional[int] = None,
    last_name: Optional[str] = None,
):
    prefill_pn = (parent_name or "").strip()
    prefill_pp = (parent_phone or "").strip()
    prefill_ln = (last_name or "").strip()
    prefill_price = default_price if default_price is not None else None
    if prefill_price is not None and prefill_price < 0:
        prefill_price = 0
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
        },
    )


@router.post("/new")
def create_student(
    request: Request,
    first_name: str = Form(...),
    last_name: str = Form(...),
    parent_name: str = Form(""),
    parent_phone: str = Form(""),
    default_price: int = Form(0),
    notes: str = Form(""),
    db: Session = Depends(get_db),
):
    student = models.Student(
        first_name=first_name,
        last_name=last_name,
        parent_name=parent_name,
        parent_phone=parent_phone,
        default_price=default_price,
        notes=notes,
    )
    db.add(student)
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
        .order_by(models.Lesson.lesson_date.desc())
        .all()
    )
    return templates.TemplateResponse(
        "student_detail.html",
        {
            "request": request,
            "student": student,
            "lessons": lessons,
            "day_names": DAY_NAMES,
        },
    )


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
    notes: str = Form(""),
    db: Session = Depends(get_db),
):
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    student.first_name = first_name
    student.last_name = last_name
    student.parent_name = parent_name
    student.parent_phone = parent_phone
    student.default_price = default_price
    student.notes = notes
    db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)


@router.post("/{student_id}/delete")
def delete_student(student_id: int, db: Session = Depends(get_db)):
    student = db.query(models.Student).filter(models.Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="תלמיד לא נמצא")
    db.delete(student)
    db.commit()
    return RedirectResponse(url="/students/", status_code=303)


# --- Schedule routes ---

@router.post("/{student_id}/schedule/add")
def add_schedule(
    student_id: int,
    day_of_week: int = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    db: Session = Depends(get_db),
):
    from datetime import time as dt_time
    start = dt_time.fromisoformat(start_time)
    end = dt_time.fromisoformat(end_time)
    sched = models.RegularSchedule(
        student_id=student_id,
        day_of_week=day_of_week,
        start_time=start,
        end_time=end,
        frequency="weekly",
    )
    db.add(sched)
    db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)


@router.post("/{student_id}/schedule/{sched_id}/delete")
def delete_schedule(student_id: int, sched_id: int, db: Session = Depends(get_db)):
    sched = db.query(models.RegularSchedule).filter(models.RegularSchedule.id == sched_id).first()
    if sched:
        db.delete(sched)
        db.commit()
    return RedirectResponse(url=f"/students/{student_id}", status_code=303)
