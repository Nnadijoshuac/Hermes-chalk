"""Chalk lessons: validate the plan the agent wrote, voice each step, store it for the board.

A lesson is a title plus a list of steps. Each step has something to say and, optionally, one
thing to draw. The agent only describes WHAT goes on the board (a flow of boxes, a list, a graph,
an equation...); the Desktop board decides where it goes and draws it stroke by stroke while the
narration plays. That split is on purpose: models are bad at coordinates and good at structure.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN_ID = "chalk"
MAX_STEPS = 14
MAX_ITEMS = 6
MAX_SAY = 400
MAX_TEXT = 80
BLOCK_TYPES = ("title", "flow", "list", "compare", "equation", "graph", "cycle", "tree", "note", "mark", "clear")
GRAPH_FN = re.compile(r"^[0-9x\s+\-*/^().,]*(?:(?:sin|cos|tan|exp|log|sqrt|abs|pi|e)[0-9x\s+\-*/^().,]*)*$")


class ChalkError(Exception):
    """A user-facing problem with a lesson plan; the message goes back to the model."""


# --------------------------------------------------------------------------- storage

def data_dir() -> Path:
    if os.environ.get("CHALK_DATA_DIR"):
        d = Path(os.environ["CHALK_DATA_DIR"])
    else:
        try:
            from plugins.plugin_storage import plugin_data_dir
            d = Path(plugin_data_dir(PLUGIN_ID))
        except Exception:  # pragma: no cover - outside Hermes
            d = Path.home() / ".hermes-chalk"
    d.mkdir(parents=True, exist_ok=True)
    return d


def lessons_dir() -> Path:
    d = data_dir() / "lessons"
    d.mkdir(parents=True, exist_ok=True)
    return d


def lesson_dir(lesson_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{6,40}", lesson_id or ""):
        raise ChalkError("bad lesson id")
    return lessons_dir() / lesson_id


# --------------------------------------------------------------------------- validation

def _text(value: Any, limit: int = MAX_TEXT) -> str:
    s = " ".join(str(value or "").split())
    return s[:limit].rstrip()


def _items(value: Any, lo: int = 1, hi: int = MAX_ITEMS) -> list[str]:
    if isinstance(value, str):
        value = [v for v in re.split(r"\s*(?:->|→|,|;|\n)\s*", value) if v.strip()]
    if not isinstance(value, list):
        return []
    out = [_text(v, 48) for v in value if _text(v, 48)]
    return out[:hi] if len(out) >= lo else []


def _number(value: Any, default: float) -> float:
    try:
        f = float(value)
        return f if abs(f) < 1e6 else default
    except (TypeError, ValueError):
        return default


def clean_block(raw: Any) -> dict | None:
    """One drawable block, normalised. Unknown or empty blocks become None (the step just talks)."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type") or "").strip().lower()
    aliases = {"heading": "title", "steps": "flow", "process": "flow", "pipeline": "flow", "bullets": "list",
               "points": "list", "vs": "compare", "formula": "equation", "math": "equation", "plot": "graph",
               "chart": "graph", "loop": "cycle", "hierarchy": "tree", "text": "note", "circle": "mark",
               "highlight": "mark", "underline": "mark", "erase": "clear", "new_board": "clear"}
    style = "underline" if kind == "underline" else "circle"
    kind = aliases.get(kind, kind)
    if kind not in BLOCK_TYPES:
        return None
    if kind == "clear":
        return {"type": "clear"}
    if kind in ("title", "equation", "note"):
        text = _text(raw.get("text") or raw.get("label") or raw.get("value"), 70 if kind != "note" else 90)
        return {"type": kind, "text": text} if text else None
    if kind in ("flow", "list", "cycle"):
        items = _items(raw.get("items") or raw.get("steps") or raw.get("points"), 2 if kind != "list" else 1,
                       5 if kind == "flow" else MAX_ITEMS)
        if kind == "cycle":
            items = items[:5]
            if len(items) < 3:
                return None
        if not items:
            return None
        block = {"type": kind, "items": items}
        if raw.get("label"):
            block["label"] = _text(raw.get("label"), 48)
        return block
    if kind == "compare":
        def side(key: str, tkey: str, ikey: str) -> dict:
            s = raw.get(key) if isinstance(raw.get(key), dict) else {}
            return {"title": _text(s.get("title") or raw.get(tkey), 30),
                    "items": _items(s.get("items") or raw.get(ikey), 0, 5)}
        left, right = side("left", "left_title", "left_items"), side("right", "right_title", "right_items")
        if not left["title"] or not right["title"]:
            return None
        return {"type": "compare", "left": left, "right": right}
    if kind == "graph":
        fn = str(raw.get("fn") or raw.get("function") or "").strip().lower().replace("y=", "").replace("y =", "")
        fn = fn.replace("**", "^").strip()[:60]
        if not fn or not GRAPH_FN.match(fn):
            return None
        lo, hi = _number(raw.get("from", raw.get("min")), -3), _number(raw.get("to", raw.get("max")), 3)
        if hi <= lo:
            lo, hi = -3.0, 3.0
        return {"type": "graph", "fn": fn, "from": lo, "to": hi, "label": _text(raw.get("label") or f"y = {fn}", 40)}
    if kind == "tree":
        root = _text(raw.get("root") or raw.get("text") or raw.get("label"), 40)
        kids = _items(raw.get("children") or raw.get("items"), 1, 5)
        return {"type": "tree", "root": root, "children": kids} if root and kids else None
    if kind == "mark":
        target = _text(raw.get("target") or raw.get("text") or raw.get("word"), 48)
        st = str(raw.get("style") or style).lower()
        return {"type": "mark", "target": target, "style": "underline" if st == "underline" else "circle"} if target else None
    return None


def clean_lesson(args: dict) -> dict:
    if not isinstance(args, dict):
        raise ChalkError("Pass a lesson object with 'title' and 'steps'.")
    title = _text(args.get("title"), 70)
    raw_steps = args.get("steps")
    if isinstance(raw_steps, str):
        try:
            raw_steps = json.loads(raw_steps)
        except ValueError:
            raw_steps = None
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ChalkError("'steps' must be a non-empty list of {say, draw} objects.")
    steps = []
    for raw in raw_steps[:MAX_STEPS]:
        if not isinstance(raw, dict):
            continue
        say = " ".join(str(raw.get("say") or raw.get("narration") or "").split())[:MAX_SAY]
        draw = raw.get("draw")
        if isinstance(draw, list):  # tolerate a list of blocks: keep them as separate silent steps
            blocks = [b for b in (clean_block(d) for d in draw) if b]
            if not blocks and not say:
                continue
            steps.append({"say": say, "draw": blocks[0] if blocks else None})
            steps.extend({"say": "", "draw": b} for b in blocks[1:])
            continue
        block = clean_block(draw if draw is not None else {k: v for k, v in raw.items() if k != "say"})
        if not say and not block:
            continue
        steps.append({"say": say, "draw": block})
    if not steps:
        raise ChalkError("No usable steps. Each step needs 'say' text and/or a 'draw' block.")
    if not title:
        title = next((s["draw"]["text"] for s in steps if s["draw"] and s["draw"]["type"] == "title"), "Lesson")
    if not any(s["draw"] and s["draw"]["type"] == "title" for s in steps[:2]):
        steps.insert(0, {"say": "", "draw": {"type": "title", "text": title}})
    return {"title": title, "steps": steps}


# --------------------------------------------------------------------------- narration

MP3_KBPS_GUESS = 48  # edge-tts default output (24 kHz, 48 kbps CBR)


def _mp3_seconds(path: Path) -> float:
    """Length of an MP3: ffprobe when present, else the CBR estimate (good for edge-tts)."""
    try:
        import shutil
        import subprocess
        fp = shutil.which("ffprobe")
        if fp:
            out = subprocess.run([fp, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                  str(path)], capture_output=True, text=True, timeout=15).stdout.strip()
            if out:
                return float(out)
    except Exception:
        pass
    return path.stat().st_size * 8 / (MP3_KBPS_GUESS * 1000)


def _speak(text: str, out: Path, voice: str | None) -> Path | None:
    try:
        from tools.tts_tool import text_to_speech_tool
    except Exception:  # pragma: no cover - outside Hermes
        return None
    try:
        res = json.loads(text_to_speech_tool(text, output_path=str(out), voice_id=voice or None))
    except Exception:
        logger.debug("chalk: tts failed", exc_info=True)
        return None
    if not res.get("success"):
        logger.info("chalk: tts unavailable: %s", res.get("error"))
        return None
    p = Path(res.get("file_path") or out)
    return p if p.exists() else None


def voice_lesson(lesson: dict, folder: Path, voice: str | None = None, enabled: bool = True) -> None:
    """Fill each step's audio file name and duration (seconds). Steps without audio get a
    reading-speed duration so the board still paces itself."""
    jobs = {}
    if enabled:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for i, step in enumerate(lesson["steps"]):
                if step["say"]:
                    jobs[i] = pool.submit(_speak, step["say"], folder / f"step{i:02d}.mp3", voice)
            done = {i: f.result() for i, f in jobs.items()}
    else:
        done = {}
    for i, step in enumerate(lesson["steps"]):
        p = done.get(i)
        if p:
            step["audio"] = p.name
            step["seconds"] = round(_mp3_seconds(p), 2)
        else:
            step["audio"] = None
            step["seconds"] = round(max(1.2, len(step["say"]) / 15.0), 2) if step["say"] else 0


def combine_audio(lesson: dict, folder: Path) -> Path | None:
    """One narration file for chat surfaces that can't draw the board (Telegram, CLI)."""
    parts = [folder / s["audio"] for s in lesson["steps"] if s.get("audio")]
    if not parts:
        return None
    out = folder / "narration.mp3"
    import shutil
    import subprocess
    ff = shutil.which("ffmpeg")
    if ff:
        lst = folder / "concat.txt"
        lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
        r = subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                            "-c", "copy", str(out)], capture_output=True, timeout=60)
        lst.unlink(missing_ok=True)
        if r.returncode == 0 and out.exists():
            return out
    with open(out, "wb") as fh:  # MP3 frames concatenate cleanly
        for p in parts:
            fh.write(p.read_bytes())
    return out


# --------------------------------------------------------------------------- create / read

_pending: dict[str, list[str]] = {}
_pending_lock = threading.Lock()


def remember_media(session: str, path: str) -> None:
    with _pending_lock:
        _pending.setdefault(session or "", []).append(path)


def take_media(session: str) -> list[str]:
    with _pending_lock:
        return _pending.pop(session or "", []) + (_pending.pop("", []) if session else [])


def create(args: dict, voice: str | None = None, narrate: bool = True) -> dict:
    lesson = clean_lesson(args)
    lesson_id = time.strftime("%Y%m%d-%H%M%S-").lower() + secrets.token_hex(3)
    folder = lesson_dir(lesson_id)
    folder.mkdir(parents=True, exist_ok=True)
    voice_lesson(lesson, folder, voice=voice, enabled=narrate)
    lesson["id"] = lesson_id
    lesson["created"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    (folder / "lesson.json").write_text(json.dumps(lesson, indent=1, ensure_ascii=False), encoding="utf-8")
    media = combine_audio(lesson, folder) or (folder / "lesson.json")
    return {"id": lesson_id, "lesson": lesson, "media": str(media)}


def load(lesson_id: str) -> dict:
    f = lesson_dir(lesson_id) / "lesson.json"
    if not f.exists():
        raise ChalkError("That lesson is gone.")
    return json.loads(f.read_text(encoding="utf-8"))


def list_lessons(limit: int = 50) -> list[dict]:
    out = []
    for d in sorted(lessons_dir().iterdir(), reverse=True)[:limit]:
        try:
            les = json.loads((d / "lesson.json").read_text(encoding="utf-8"))
            out.append({"id": les["id"], "title": les["title"], "created": les.get("created"),
                        "steps": len(les["steps"])})
        except Exception:
            continue
    return out
