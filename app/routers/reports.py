from datetime import date, datetime, timedelta
from calendar import monthrange
from io import BytesIO
from collections import defaultdict
import re
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models
from ..templating import templates

router = APIRouter(prefix="/reports", tags=["reports"])

MONTH_NAMES_HE = (
    "ינואר",
    "פברואר",
    "מרץ",
    "אפריל",
    "מאי",
    "יוני",
    "יולי",
    "אוגוסט",
    "ספטמבר",
    "אוקטובר",
    "נובמבר",
    "דצמבר",
)


def _normalize_phone(phone: str) -> str:
    """Strip all non-digit characters so 050-123-4567 == 0501234567."""
    return re.sub(r"\D", "", phone or "")


def _unpaid_families_data(db: Session) -> tuple[dict, int]:
    """Same grouping as the HTML report: families by phone, unpaid non-cancelled lessons."""
    unpaid_lessons = (
        db.query(models.Lesson)
        .join(models.Student)
        .filter(models.Lesson.is_paid == False)
        .filter(models.Lesson.status != "cancelled")
        .order_by(models.Student.last_name, models.Lesson.lesson_date)
        .all()
    )

    families: dict = defaultdict(
        lambda: {
            "student_names": [],
            "parent_name": "",
            "parent_phone": "",
            "lessons": [],
            "total": 0,
        }
    )

    for lesson in unpaid_lessons:
        s = lesson.student
        normalized = _normalize_phone(s.parent_phone)
        key = normalized if normalized else f"_solo_{s.id}"

        student_label = f"{s.first_name} {s.last_name}"
        if student_label not in families[key]["student_names"]:
            families[key]["student_names"].append(student_label)

        if not families[key]["parent_name"] and s.parent_name:
            families[key]["parent_name"] = s.parent_name
        if s.parent_phone and not families[key]["parent_phone"]:
            families[key]["parent_phone"] = s.parent_phone

        families[key]["lessons"].append(lesson)
        families[key]["total"] += lesson.price

    grand_total = sum(f["total"] for f in families.values())
    return dict(families), grand_total


def _lesson_status_label(lesson: models.Lesson) -> str:
    if lesson.status == "completed":
        return "הושלם"
    return "מתוכנן"


def _month_year_from_query(month_param: Optional[str], today: date) -> Tuple[int, int]:
    """Parse ?month=YYYY-MM or fall back to current calendar month."""
    if month_param and len(month_param) >= 7:
        try:
            y = int(month_param[0:4])
            m = int(month_param[5:7])
            if 1 <= m <= 12 and 2000 <= y <= 2100:
                return y, m
        except ValueError:
            pass
    return today.year, today.month


def _shift_month(year: int, month: int, delta: int) -> Tuple[int, int]:
    m = month + delta
    y = year
    while m > 12:
        m -= 12
        y += 1
    while m < 1:
        m += 12
        y -= 1
    return y, m


def _lesson_duration_hours(lesson: models.Lesson) -> float:
    start_dt = datetime.combine(lesson.lesson_date, lesson.start_time)
    end_dt = datetime.combine(lesson.lesson_date, lesson.end_time)
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    return max(0.0, (end_dt - start_dt).total_seconds() / 3600.0)


def _monthly_teaching_summary(db: Session, year: int, month: int) -> Tuple[float, int]:
    """Total scheduled teaching hours in month (non-cancelled) and lesson count."""
    last_day = monthrange(year, month)[1]
    start_d = date(year, month, 1)
    end_d = date(year, month, last_day)
    lessons = (
        db.query(models.Lesson)
        .filter(models.Lesson.lesson_date >= start_d)
        .filter(models.Lesson.lesson_date <= end_d)
        .filter(models.Lesson.status != "cancelled")
        .all()
    )
    total_h = sum(_lesson_duration_hours(l) for l in lessons)
    return total_h, len(lessons)


def _format_hours_display(hours: float) -> str:
    if abs(hours - round(hours)) < 0.05:
        return str(int(round(hours)))
    s = f"{hours:.1f}"
    return s.rstrip("0").rstrip(".")


def _load_openpyxl():
    """Import only when exporting Excel so the app starts even if the image lacks openpyxl (until rebuild)."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill

        return Workbook, Alignment, Font, PatternFill
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "חסרה חבילת openpyxl בקונטיינר. "
                "עצרי את השרת והריצי מתיקיית הפרויקט: "
                "docker compose build --no-cache app && docker compose up -d"
            ),
        ) from exc


@router.get("/", response_class=HTMLResponse)
def reports_page(
    request: Request,
    month: Optional[str] = Query(None, description="YYYY-MM"),
    db: Session = Depends(get_db),
):
    today = date.today()
    year, mon = _month_year_from_query(month, today)
    month_input = f"{year}-{mon:02d}"
    py, pm = _shift_month(year, mon, -1)
    ny, nm = _shift_month(year, mon, 1)
    month_hours, month_lesson_count = _monthly_teaching_summary(db, year, mon)
    month_hours_display = _format_hours_display(month_hours)
    report_month_label = f"{MONTH_NAMES_HE[mon - 1]} {year}"

    families, grand_total = _unpaid_families_data(db)
    return templates.TemplateResponse(
        "reports.html",
        {
            "request": request,
            "families": families,
            "grand_total": grand_total,
            "month_input": month_input,
            "report_month_label": report_month_label,
            "month_hours_display": month_hours_display,
            "month_lesson_count": month_lesson_count,
            "prev_month_q": f"{py}-{pm:02d}",
            "next_month_q": f"{ny}-{nm:02d}",
        },
    )


@router.get("/export.xlsx")
def reports_export_excel(db: Session = Depends(get_db)):
    """Export the same unpaid-by-family report to Excel (Hebrew, RTL sheet)."""
    Workbook, Alignment, Font, PatternFill = _load_openpyxl()

    families, grand_total = _unpaid_families_data(db)

    wb = Workbook()
    ws = wb.active
    ws.title = "חובות"

    try:
        ws.sheet_view.rightToLeft = True
    except Exception:
        pass

    title_font = Font(bold=True, size=14)
    header_font = Font(bold=True, size=11)
    hdr_fill = PatternFill("solid", fgColor="F1F5F9")

    r = 1
    c1 = ws.cell(row=r, column=1, value="דוח חובות תשלום (שיעורים שלא שולמו)")
    c1.font = title_font
    c1.alignment = Alignment(horizontal="right", vertical="center", wrap_text=True)
    r += 1
    ws.cell(row=r, column=1, value=f"תאריך יצוא: {date.today().strftime('%d/%m/%Y')}")
    r += 1
    ws.cell(row=r, column=1, value=f'סה"כ לגבייה: {grand_total} ₪').font = Font(bold=True, size=12)
    r += 2

    if not families:
        ws.cell(row=r, column=1, value="אין חובות פתוחים.")
        r += 1
    else:
        for _key, data in families.items():
            ws.cell(row=r, column=1, value="תלמידים:").font = header_font
            ws.cell(row=r, column=2, value=" & ".join(data["student_names"]))
            r += 1
            if data["parent_name"]:
                ws.cell(row=r, column=1, value="הורה:")
                ws.cell(row=r, column=2, value=data["parent_name"])
                r += 1
            if data["parent_phone"]:
                ws.cell(row=r, column=1, value="טלפון:")
                ws.cell(row=r, column=2, value=data["parent_phone"])
                r += 1
            ws.cell(row=r, column=1, value=f'סה"כ משפחה: {data["total"]} ₪').font = Font(bold=True)
            r += 1

            headers = ("תאריך", "תלמיד", "שעות", "מחיר (₪)", "סטטוס")
            for col, h in enumerate(headers, start=1):
                cell = ws.cell(row=r, column=col, value=h)
                cell.font = header_font
                cell.fill = hdr_fill
                cell.alignment = Alignment(horizontal="right", vertical="center")
            r += 1

            for lesson in data["lessons"]:
                s = lesson.student
                time_s = (
                    f"{lesson.start_time.strftime('%H:%M')} – {lesson.end_time.strftime('%H:%M')}"
                )
                ws.cell(row=r, column=1, value=lesson.lesson_date.strftime("%d/%m/%Y"))
                ws.cell(row=r, column=2, value=f"{s.first_name} {s.last_name}")
                ws.cell(row=r, column=3, value=time_s)
                ws.cell(row=r, column=4, value=lesson.price)
                ws.cell(row=r, column=5, value=_lesson_status_label(lesson))
                for col in range(1, 6):
                    ws.cell(row=r, column=col).alignment = Alignment(
                        horizontal="right", vertical="center"
                    )
                r += 1

            r += 1

    for col_letter, width in (("A", 14), ("B", 22), ("C", 16), ("D", 12), ("E", 12)):
        ws.column_dimensions[col_letter].width = width

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"unpaid-report-{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
        },
    )
