"""Shared Jinja2 setup so every HTML page gets the same globals (static asset cache-bust)."""
from pathlib import Path
from urllib.parse import quote

from fastapi.templating import Jinja2Templates

_APP_DIR = Path(__file__).resolve().parent
_TEMPLATES_DIR = _APP_DIR / "templates"
_STATIC_DIR = _APP_DIR / "static"


def static_v(relative_under_static: str) -> str:
    """Cache-bust query param from file mtime — updates whenever that file is saved on disk."""
    try:
        return str(int((_STATIC_DIR / relative_under_static).stat().st_mtime))
    except OSError:
        return "0"


def urlquote(value: object) -> str:
    """Percent-encode a string for use in URL query values (e.g. Hebrew names)."""
    return quote(str(value or ""), safe="")


templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))
templates.env.globals["static_v"] = static_v
templates.env.filters["urlquote"] = urlquote
