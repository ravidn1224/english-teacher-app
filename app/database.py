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
    except Exception as exc:
        _log.warning("ensure_schema: %s", exc)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
