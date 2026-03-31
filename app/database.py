import logging
import os
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

_log = logging.getLogger(__name__)

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://teacher:teacher123@localhost:5432/teacherdb"
)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def ensure_schema(engine):
    """Add columns added after first deploy (PostgreSQL)."""
    try:
        insp = inspect(engine)
        if "lessons" not in insp.get_table_names():
            return
        cols = {c["name"] for c in insp.get_columns("lessons")}
        if "attendance" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE lessons ADD COLUMN attendance VARCHAR(20) NOT NULL DEFAULT 'expected'"
                    )
                )
        if "paid_amount" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE lessons ADD COLUMN paid_amount INTEGER NULL"))
        if "payment_method" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE lessons ADD COLUMN payment_method VARCHAR(20) NOT NULL DEFAULT ''"
                    )
                )
        if "payment_note" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE lessons ADD COLUMN payment_note VARCHAR(255) NOT NULL DEFAULT ''"
                    )
                )
        if "balance_applied" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE lessons ADD COLUMN balance_applied INTEGER NOT NULL DEFAULT 0"))
        if "payment_finalized" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE lessons ADD COLUMN payment_finalized BOOLEAN NOT NULL DEFAULT false"
                    )
                )
        if "is_group_lesson" not in cols:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE lessons ADD COLUMN is_group_lesson BOOLEAN NOT NULL DEFAULT false"
                    )
                )
        stu_cols = {c["name"] for c in insp.get_columns("students")} if "students" in insp.get_table_names() else set()
        if "balance" not in stu_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE students ADD COLUMN balance INTEGER NOT NULL DEFAULT 0"))
        if "regular_schedule" in insp.get_table_names():
            rs_cols = {c["name"] for c in insp.get_columns("regular_schedule")}
            if "frequency" not in rs_cols:
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "ALTER TABLE regular_schedule ADD COLUMN frequency VARCHAR(20) NOT NULL DEFAULT 'weekly'"
                        )
                    )
            if "anchor_date" not in rs_cols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE regular_schedule ADD COLUMN anchor_date DATE NULL"))
            if "day_of_month" not in rs_cols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE regular_schedule ADD COLUMN day_of_month INTEGER NULL"))
    except Exception as exc:
        _log.warning("ensure_schema: %s", exc)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
