"""One-time (idempotent) migration: Family rows + student.family_id from phone grouping."""
import logging
import re
from collections import defaultdict

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session, sessionmaker

_log = logging.getLogger(__name__)


def _normalize_phone(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")


def backfill_families_if_needed(engine, models_module):
    """Create Family per phone bucket; assign students; roll student.balance into family.balance."""
    try:
        insp = inspect(engine)
        if "families" not in insp.get_table_names() or "students" not in insp.get_table_names():
            return
        stu_cols = {c["name"] for c in insp.get_columns("students")}
        if "family_id" not in stu_cols:
            return
    except Exception as exc:
        _log.warning("backfill_families_if_needed inspect: %s", exc)
        return

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db: Session = SessionLocal()
    try:
        Student = models_module.Student
        Family = models_module.Family
        n_missing = (
            db.query(Student).filter(Student.family_id.is_(None)).count()
        )
        if n_missing == 0:
            return

        students = db.query(Student).filter(Student.family_id.is_(None)).all()
        buckets: dict[str, list] = defaultdict(list)
        for s in students:
            key = _normalize_phone(s.parent_phone)
            if not key:
                key = f"_solo_{s.id}"
            buckets[key].append(s)

        for _key, members in buckets.items():
            members.sort(key=lambda m: (m.last_name or "", m.first_name or ""))
            first = members[0]
            phone_display = (first.parent_phone or "").strip()
            contact = (first.parent_name or "").strip()
            fam_name = (first.last_name or "").strip() or "משפחה"
            rolled = sum(int(getattr(m, "balance", 0) or 0) for m in members)
            fam = Family(
                name=fam_name,
                contact_name=contact,
                phone=phone_display,
                balance=rolled,
            )
            db.add(fam)
            db.flush()
            for m in members:
                m.family_id = fam.id
                if not getattr(m, "lesson_type", None) or m.lesson_type == "":
                    m.lesson_type = "individual"
                # Clear legacy duplicate so only family.balance counts
                m.balance = 0

        db.commit()
        _log.info("backfill_families_if_needed: created families for %s students", len(students))
    except Exception as exc:
        _log.exception("backfill_families_if_needed failed: %s", exc)
        db.rollback()
    finally:
        db.close()
