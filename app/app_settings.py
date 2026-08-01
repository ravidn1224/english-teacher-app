"""Global teacher preferences stored in ``app_settings`` (key/value)."""

from sqlalchemy.orm import Session

from . import models

KEY_DEFAULT_LESSON_INDIVIDUAL = "default_lesson_price_individual"
KEY_DEFAULT_LESSON_GROUP = "default_lesson_price_group"


def _parse_int_setting(raw: str, default: int = 0) -> int:
    try:
        return max(0, int(str(raw).strip()))
    except (TypeError, ValueError):
        return default


def get_setting_int(db: Session, key: str, default: int = 0) -> int:
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if not row or row.value is None:
        return default
    return _parse_int_setting(row.value, default)


def set_setting_int(db: Session, key: str, value: int) -> None:
    v = max(0, int(value))
    s = str(v)
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if row:
        row.value = s
    else:
        db.add(models.AppSetting(key=key, value=s))


def get_default_lesson_prices(db: Session) -> tuple[int, int]:
    return (
        get_setting_int(db, KEY_DEFAULT_LESSON_INDIVIDUAL, 0),
        get_setting_int(db, KEY_DEFAULT_LESSON_GROUP, 0),
    )


def set_default_lesson_prices(db: Session, individual: int, group: int) -> None:
    set_setting_int(db, KEY_DEFAULT_LESSON_INDIVIDUAL, individual)
    set_setting_int(db, KEY_DEFAULT_LESSON_GROUP, group)


def effective_student_default_price_with_tuple(
    student: models.Student, ind: int, grp: int, *, for_group: bool
) -> int:
    """Resolve default ₪ for one lesson: private track vs group track (pre-fetched globals)."""
    if for_group:
        pg = int(getattr(student, "default_price_group", None) or 0)
        if pg > 0:
            return pg
        return grp if grp > 0 else ind
    pp = int(getattr(student, "default_price", None) or 0)
    if pp > 0:
        return pp
    return ind if ind > 0 else grp


def effective_student_default_price_by_student_type(db: Session, student: models.Student) -> int:
    """When lesson row does not exist yet: use student's default category (individual vs group)."""
    ind, grp = get_default_lesson_prices(db)
    for_group = (getattr(student, "lesson_type", None) or "individual").strip().lower() == "group"
    return effective_student_default_price_with_tuple(student, ind, grp, for_group=for_group)


def effective_student_default_price_for_lesson(
    db: Session, student: models.Student, is_group_lesson: bool
) -> int:
    ind, grp = get_default_lesson_prices(db)
    return effective_student_default_price_with_tuple(
        student, ind, grp, for_group=bool(is_group_lesson)
    )


def effective_student_default_price(db: Session, student: models.Student) -> int:
    """Backward-compatible: same as ``effective_student_default_price_by_student_type``."""
    return effective_student_default_price_by_student_type(db, student)
