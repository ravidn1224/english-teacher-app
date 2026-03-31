from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pathlib import Path

from .database import engine, ensure_schema
from . import models
from .routers import students, lessons, reports
from .templating import templates

# Create all tables on startup
models.Base.metadata.create_all(bind=engine)
ensure_schema(engine)

app = FastAPI(title="מערכת ניהול תלמידים", docs_url="/api/docs")


def _should_no_cache_page(path: str) -> bool:
    if path in ("/", "/calendar"):
        return True
    if path.startswith("/students") or path.startswith("/reports"):
        return True
    return False


@app.middleware("http")
async def no_cache_static_and_html_pages(request: Request, call_next):
    """Avoid stale JS/CSS/HTML after code edits; pages always revalidate so script URLs refresh."""
    response = await call_next(request)
    if request.method != "GET":
        return response
    path = request.url.path
    if path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        return response
    if _should_no_cache_page(path):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# Include routers
app.include_router(students.router)
app.include_router(lessons.router)
app.include_router(reports.router)


@app.get("/")
def root():
    return RedirectResponse(url="/calendar")


@app.get("/calendar")
def calendar_page(request: Request):
    return templates.TemplateResponse("calendar.html", {"request": request})
