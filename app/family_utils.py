"""Assign students to Family rows (shared balance)."""
import re
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from . import models as models_mod


def normalize_phone(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")


def get_or_create_family_for_student(db: Session, student: "models_mod.Student", models: "type[models_mod]") -> "models_mod.Family":
    """Attach student to an existing family (same parent phone) or create one."""
    if getattr(student, "family_id", None):
        f = db.query(models.Family).filter(models.Family.id == student.family_id).first()
        if f:
            return f

    np = normalize_phone(student.parent_phone or "")
    if np:
        others = (
            db.query(models.Student)
            .filter(models.Student.id != student.id)
            .filter(models.Student.family_id.isnot(None))
            .all()
        )
        for m in others:
            if normalize_phone(m.parent_phone or "") == np:
                student.family_id = m.family_id
                db.flush()
                fam = db.query(models.Family).filter(models.Family.id == m.family_id).first()
                if fam:
                    return fam

    fam = models.Family(
        name=(student.last_name or "").strip() or "משפחה",
        contact_name=(student.parent_name or "").strip(),
        phone=(student.parent_phone or "").strip(),
        balance=0,
    )
    db.add(fam)
    db.flush()
    student.family_id = fam.id
    return fam
