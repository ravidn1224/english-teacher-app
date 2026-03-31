# מערכת ניהול תלמידים לאנגלית / English Teacher Management System

> A simple, friendly web app for an English teacher to manage students, lessons, schedules, and payments.

---

## דרישות מקדימות / Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — download and install it.
- That's it! No Python installation needed.

---

## הפעלה ראשונה / First Run

Open a **Terminal** (on Mac: `Applications → Utilities → Terminal`), navigate to this folder, then run:

```bash
cd "path/to/english-teacher-app"
docker-compose up --build
```

Wait about 30–60 seconds. When you see:

```
teacher_app  | INFO:     Application startup complete.
```

Open your browser and go to: **http://localhost:8000**

---

## הפעלה רגילה / Normal Startup

Each time you want to use the app:

```bash
docker-compose up
```

To stop it:

```bash
docker-compose down
```

---

## מדריך שימוש / User Guide

### לוח שנה (Calendar)
- The home screen shows a **weekly calendar** of all lessons.
- **Click on any empty time slot** to add a new lesson for that date.
- **Click on an existing lesson** to open an edit window where you can:
  - Change the date or time
  - Mark the lesson as **Completed / Cancelled**
  - Mark whether the student **Paid** (toggle switch)
  - Delete the lesson

### תלמידים (Students)
- View the full list of students with their permanent schedule.
- Click **"תלמיד חדש"** (New Student) to add a student with their parent's name, phone, and default lesson price.
- Click any student's name to see their full lesson history.
- On the student detail page you can:
  - Edit student information
  - Add or remove permanent weekly time slots
  - View all past/future lessons with paid/unpaid status

### דוח תשלומים (Payment Report)
- Shows a list of **all families with unpaid lessons**.
- Shows total amount owed per family.
- Click the **Print** button to print the report.

---

## Color Legend (Calendar)

| Color | Meaning |
|-------|---------|
| Grey | Scheduled (upcoming) |
| Green | Completed + Paid |
| Red | Completed + Not Paid |
| Light grey | Cancelled |

---

## Technical Details

| Component | Details |
|-----------|---------|
| Backend | Python / FastAPI |
| Database | PostgreSQL 16 |
| Frontend | Bootstrap 5 RTL + FullCalendar |
| Port | http://localhost:8000 |
| DB Port | 5432 |

Data is stored persistently in a Docker volume — it will survive restarts.

---

## Backup

To back up your database:

```bash
docker exec teacher_db pg_dump -U teacher teacherdb > backup.sql
```

To restore:

```bash
cat backup.sql | docker exec -i teacher_db psql -U teacher teacherdb
```
