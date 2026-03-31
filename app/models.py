from sqlalchemy import (
    Column, Integer, String, Date, Time, Boolean, ForeignKey, Text, DateTime
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False)
    parent_name = Column(String(200))
    parent_phone = Column(String(30))
    default_price = Column(Integer, default=0)  # price in ILS per lesson
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    schedules = relationship("RegularSchedule", back_populates="student", cascade="all, delete-orphan")
    lessons = relationship("Lesson", back_populates="student", cascade="all, delete-orphan")


class RegularSchedule(Base):
    __tablename__ = "regular_schedule"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    # 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
    day_of_week = Column(Integer, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)

    student = relationship("Student", back_populates="schedules")


class Lesson(Base):
    __tablename__ = "lessons"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    lesson_date = Column(Date, nullable=False)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)
    price = Column(Integer, nullable=False, default=0)  # ILS
    # scheduled / completed / cancelled
    status = Column(String(20), nullable=False, default="scheduled")
    # expected = upcoming / not marked yet (blue), arrived = was in class (blue), no_show = did not arrive (grey)
    attendance = Column(String(20), nullable=False, default="expected")
    is_paid = Column(Boolean, default=False, nullable=False)
    # Actual amount received (₪); if null while is_paid, UI/API may treat lesson.price as default
    paid_amount = Column(Integer, nullable=True)
    # cash | bit | paybox | other (empty = not set)
    payment_method = Column(String(20), nullable=False, default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    student = relationship("Student", back_populates="lessons")
