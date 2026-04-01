from sqlalchemy import (
    Column, Integer, String, Date, Time, Boolean, ForeignKey, Text, DateTime
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base


class Family(Base):
    __tablename__ = "families"

    id = Column(Integer, primary_key=True, index=True)
    # Display name (usually shared last name)
    name = Column(String(200), nullable=False, default="משפחה")
    contact_name = Column(String(200), default="")
    phone = Column(String(30), default="")
    # Running balance ₪: positive = credit, negative = debt (family-level source of truth)
    balance = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    students = relationship("Student", back_populates="family")


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    family_id = Column(Integer, ForeignKey("families.id"), nullable=True, index=True)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False)
    parent_name = Column(String(200))
    parent_phone = Column(String(30))
    # individual → default charge style; group → lower default (UI / materialize)
    lesson_type = Column(String(20), nullable=False, default="individual")
    default_price = Column(Integer, default=0)  # price in ILS per lesson
    # Legacy per-student balance — kept for migration; use family.balance
    balance = Column(Integer, nullable=False, default=0)
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    family = relationship("Family", back_populates="students")
    schedules = relationship("RegularSchedule", back_populates="student", cascade="all, delete-orphan")
    lessons = relationship("Lesson", back_populates="student", cascade="all, delete-orphan")


class BalanceTransaction(Base):
    """Ledger line: family balance movement tied to a lesson (or future manual adj)."""

    __tablename__ = "balance_transactions"

    id = Column(Integer, primary_key=True, index=True)
    family_id = Column(Integer, ForeignKey("families.id"), nullable=False, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id"), nullable=True, index=True)
    charge = Column(Integer, nullable=False, default=0)  # ₪ charged for context
    paid = Column(Integer, nullable=False, default=0)  # ₪ recorded as paid toward this event
    balance_before = Column(Integer, nullable=False, default=0)
    balance_after = Column(Integer, nullable=False, default=0)
    txn_date = Column(Date, nullable=False)
    month_key = Column(String(7), nullable=False, index=True)  # YYYY-MM
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    family = relationship("Family")
    lesson = relationship("Lesson")


class RegularSchedule(Base):
    __tablename__ = "regular_schedule"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    # 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
    day_of_week = Column(Integer, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    # weekly | biweekly | monthly (default weekly for legacy rows)
    frequency = Column(String(20), nullable=False, default="weekly")
    # First occurrence date for biweekly parity (week of this date = week 0)
    anchor_date = Column(Date, nullable=True)
    # For monthly: which calendar day (1–31); short months use last day if needed
    day_of_month = Column(Integer, nullable=True)
    # First calendar day to emit virtual occurrences (NULL = no lower bound, legacy)
    recurring_start_date = Column(Date, nullable=True)

    student = relationship("Student", back_populates="schedules")


class Lesson(Base):
    __tablename__ = "lessons"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    lesson_date = Column(Date, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    price = Column(Integer, nullable=False, default=0)  # ILS
    # Group session (lower per-student charge); shown in calendar payment UI
    is_group_lesson = Column(Boolean, nullable=False, default=False)
    # scheduled / completed / cancelled
    status = Column(String(20), nullable=False, default="scheduled")
    # expected = upcoming / not marked yet (blue), arrived = was in class (blue), no_show = did not arrive (grey)
    attendance = Column(String(20), nullable=False, default="expected")
    is_paid = Column(Boolean, default=False, nullable=False)
    # Actual amount received (₪); if null while is_paid, UI/API may treat lesson.price as default
    paid_amount = Column(Integer, nullable=True)
    # cash | bit | paybox | other (empty = not set)
    payment_method = Column(String(20), nullable=False, default="")
    # Free text when payment_method == other (e.g. custom channel)
    payment_note = Column(String(255), nullable=False, default="")
    notes = Column(Text, default="")
    # Last (amount_paid - lesson_charge) applied to family.balance for this row
    balance_applied = Column(Integer, nullable=False, default=0)
    # True after teacher chose שולם / לא שולם (affects balance for unpaid)
    payment_finalized = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    student = relationship("Student", back_populates="lessons")
