"""Chalk: Hermes teaches on a chalkboard.

Ask Hermes to explain something and it plans a short lesson: what to say and what to put on the
board. Hermes Desktop then draws it in the chat, stroke by stroke in chalk, while Hermes talks
you through it in its own voice. Every lesson can be saved as a video.
"""

from __future__ import annotations

import base64
import json
import logging
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from . import lesson as L

logger = logging.getLogger(__name__)

BLOCK_DOC = (
    "Block types for 'draw' (pick ONE per step, keep words short, the board lays them out for you):\n"
    "  {type:'title', text}                       big heading (start each board with one)\n"
    "  {type:'flow', items:[2-5 short labels]}    boxes joined by arrows, left to right (a process)\n"
    "  {type:'list', items:[1-6 short points]}    bullet points\n"
    "  {type:'compare', left:{title, items}, right:{title, items}}   two columns\n"
    "  {type:'equation', text}                    a formula, e.g. 'E = mc^2'\n"
    "  {type:'graph', fn, from, to, label}        plot y=fn(x); fn uses x + - * / ^ sin cos exp log sqrt abs\n"
    "  {type:'cycle', items:[3-5 labels]}         labels round a circle with arrows (a loop)\n"
    "  {type:'tree', root, children:[1-5]}        one idea branching into parts\n"
    "  {type:'note', text}                        a short handwritten remark\n"
    "  {type:'mark', target, style:'circle'|'underline'}   circle/underline words already on the board\n"
    "  {type:'clear'}                             wipe the board and start a fresh one\n"
)

CHALK_TEACH = {
    "name": "chalk_teach",
    "description": (
        "Teach something on a chalkboard. Hermes Desktop draws the board live in the chat, in chalk, "
        "while your narration is spoken aloud; the user can replay it and save it as a video. Use it when "
        "the user asks you to explain, teach or walk them through an idea, or says 'chalkboard'/'whiteboard'/"
        "'draw it'. Plan 5-10 steps. Each step: 'say' = one or two spoken sentences, plain words, no markdown; "
        "'draw' = one block that appears while that sentence is spoken (omit it to just talk). Build the board up "
        "gradually, the way a good teacher does: title, then the core picture, then detail, then circle the key "
        "idea. Use {type:'clear'} before a second board. After the tool returns, reply with ONE short sentence "
        "and the MEDIA line it gives you; do not repeat the lesson in text.\n" + BLOCK_DOC
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Lesson title, a few words."},
            "steps": {
                "type": "array",
                "description": "The lesson, in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "say": {"type": "string", "description": "What you say aloud during this step."},
                        "draw": {"type": "object", "description": "One board block (see the tool description)."},
                    },
                    "required": ["say"],
                },
            },
        },
        "required": ["title", "steps"],
    },
}

_settings: dict[str, Any] = {"voice": "", "narrate": True}


def _session_of(kw: dict) -> str:
    for k in ("session_id", "task_id", "conversation_id"):
        if kw.get(k):
            return str(kw[k])
    return ""


def chalk_teach(args: dict, **kw: Any) -> str:
    try:
        out = L.create(args, voice=_settings.get("voice") or None, narrate=bool(_settings.get("narrate", True)))
    except L.ChalkError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    except Exception as exc:  # never take the turn down
        logger.exception("chalk: lesson failed")
        return json.dumps({"success": False, "error": f"{type(exc).__name__}: {exc}"})
    les = out["lesson"]
    voiced = sum(1 for s in les["steps"] if s.get("audio"))
    secs = sum(s["seconds"] for s in les["steps"])
    L.remember_media(_session_of(kw), out["media"])
    return json.dumps({
        "success": True,
        "lesson_id": out["id"],
        "title": les["title"],
        "steps": len(les["steps"]),
        "narrated_steps": voiced,
        "approx_seconds": round(secs),
        "media_tag": f"MEDIA:{out['media']}",
        "note": ("The board is ready and plays in Hermes Desktop. Reply with one short sentence and this exact line "
                 f"on its own: MEDIA:{out['media']}"),
    })


def on_transform_llm_output(response_text: str = "", session_id: str = "", **_: Any):
    """If the model forgot the MEDIA line for a board it just made, add it, so the board shows."""
    paths = L.take_media(session_id)
    missing = [p for p in paths if p not in (response_text or "") and Path(p).as_posix() not in (response_text or "")]
    if not missing:
        return None
    return (response_text or "").rstrip() + "\n\n" + "\n".join(f"MEDIA:{p}" for p in missing)


# --------------------------------------------------------------------------- Desktop RPC

def _safe(fn):
    def handler(params: Any = None, **_: Any) -> dict:
        try:
            return {"ok": True, **fn(params if isinstance(params, dict) else {})}
        except L.ChalkError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:
            logger.debug("chalk rpc failed", exc_info=True)
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return handler


def _rpc_lesson(p: dict) -> dict:
    les = L.load(str(p.get("id") or ""))
    folder = L.lesson_dir(les["id"])
    audio = {}
    for i, s in enumerate(les["steps"]):
        if s.get("audio") and (folder / s["audio"]).exists():
            audio[str(i)] = "data:audio/mpeg;base64," + base64.b64encode((folder / s["audio"]).read_bytes()).decode()
    return {"lesson": les, "audio": audio}


def _rpc_list(_: dict) -> dict:
    return {"lessons": L.list_lessons()}


def _rpc_save_chunk(p: dict) -> dict:
    folder = L.lesson_dir(str(p.get("id") or ""))
    part, parts = int(p.get("part", -1)), int(p.get("parts", 0))
    if not (0 <= part < parts <= 400):
        raise L.ChalkError("bad chunk")
    (folder / f"rec.{part:04d}.b64").write_text(str(p.get("data") or ""), encoding="ascii")
    return {"part": part}


def _rpc_save_video(p: dict) -> dict:
    les = L.load(str(p.get("id") or ""))
    folder = L.lesson_dir(les["id"])
    parts = int(p.get("parts", 0))
    chunks = [folder / f"rec.{k:04d}.b64" for k in range(parts)]
    if not parts or not all(c.exists() for c in chunks):
        raise L.ChalkError("The recording didn't arrive in full; try Save video again.")
    raw = base64.b64decode("".join(c.read_text(encoding="ascii") for c in chunks))
    for c in chunks:
        c.unlink(missing_ok=True)
    if len(raw) < 1000:
        raise L.ChalkError("The recording came back empty.")
    # Windows' Controlled Folder Access can refuse new folders under Videos; fall back quietly.
    candidates = [Path(_settings["video_dir"])] if _settings.get("video_dir") else []
    candidates += [Path.home() / "Videos" / "Chalk", Path.home() / "Downloads" / "Chalk", L.data_dir() / "videos"]
    out_dir = None
    for cand in candidates:
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".chalk-write-test"
            probe.write_bytes(b"ok")
            probe.unlink(missing_ok=True)
            out_dir = cand
            break
        except OSError:
            continue
    if out_dir is None:
        raise L.ChalkError("No folder I can write the video to; set the plugin's video_dir.")
    slug = "".join(c if c.isalnum() else "-" for c in les["title"].lower()).strip("-")[:40] or "lesson"
    stem = out_dir / f"{slug}-{time.strftime('%H%M%S')}"
    webm = stem.with_suffix(".webm")
    webm.write_bytes(raw)
    final = webm
    ff = shutil.which("ffmpeg")
    if ff:
        mp4 = stem.with_suffix(".mp4")
        r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(webm), "-c:v", "libx264", "-preset",
                            "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                            "-movflags", "+faststart", str(mp4)], capture_output=True, timeout=600)
        if r.returncode == 0 and mp4.exists():
            webm.unlink(missing_ok=True)
            final = mp4
    return {"path": str(final), "folder": str(out_dir)}


RPC = {"lesson": _safe(_rpc_lesson), "list": _safe(_rpc_list), "save_chunk": _safe(_rpc_save_chunk),
       "save_video": _safe(_rpc_save_video)}


def _cli_setup(parser) -> None:
    sub = parser.add_subparsers(dest="chalk_cmd")
    sub.add_parser("list", help="List saved lessons")


def _cli_handle(args) -> int:
    for les in L.list_lessons():
        print(f"{les['created']}  {les['id']}  {les['title']}  ({les['steps']} steps)")
    return 0


def register(ctx) -> None:
    for key, default in (("voice", ""), ("narrate", True), ("video_dir", "")):
        try:
            _settings[key] = ctx.get_config(key, default=default)
        except Exception:
            _settings[key] = default
    ctx.register_tool(name="chalk_teach", toolset="chalk", schema=CHALK_TEACH, handler=chalk_teach)
    ctx.register_hook("transform_llm_output", on_transform_llm_output)
    try:
        ctx.register_cli_command(name="chalk", help="Chalkboard lessons Hermes has taught you",
                                 setup_fn=_cli_setup, handler_fn=_cli_handle)
    except Exception:
        logger.debug("chalk: no cli registration", exc_info=True)
    register_rpc = getattr(ctx, "register_rpc", None)
    if callable(register_rpc):
        for name, fn in RPC.items():
            try:
                register_rpc(name, fn)
            except Exception:
                logger.debug("chalk: rpc %s not registered", name, exc_info=True)
