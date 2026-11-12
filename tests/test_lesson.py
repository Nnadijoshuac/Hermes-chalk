"""Lesson validation tests (no Hermes needed): python -m pytest tests"""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("chalk", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
chalk = importlib.util.module_from_spec(spec)
sys.modules["chalk"] = chalk
spec.loader.exec_module(chalk)
L = chalk.lesson if hasattr(chalk, "lesson") else sys.modules["chalk.lesson"]


def test_blocks_are_normalised():
    les = L.clean_lesson({"title": "T", "steps": [
        {"say": "a", "draw": {"type": "steps", "items": "A -> B -> C"}},
        {"say": "b", "draw": {"type": "plot", "fn": "y = x**2", "from": 2, "to": 1}},
        {"say": "c", "draw": {"type": "underline", "target": "B"}},
        {"say": "d", "draw": {"type": "nonsense"}},
    ]})
    kinds = [s["draw"]["type"] if s["draw"] else None for s in les["steps"]]
    assert kinds == ["title", "flow", "graph", "mark", None]
    assert les["steps"][1]["draw"]["items"] == ["A", "B", "C"]
    g = les["steps"][2]["draw"]
    assert g["fn"] == "x^2" and g["from"] < g["to"]
    assert les["steps"][3]["draw"]["style"] == "underline"


def test_graph_rejects_code():
    assert L.clean_block({"type": "graph", "fn": "__import__('os').system('x')"}) is None
    assert L.clean_block({"type": "graph", "fn": "sin(x)*exp(-x/3)"}) is not None


def test_empty_plan_is_an_error():
    try:
        L.clean_lesson({"title": "x", "steps": []})
    except L.ChalkError:
        return
    raise AssertionError("expected ChalkError")


def test_tool_writes_lesson_and_media_without_tts():
    with tempfile.TemporaryDirectory() as d:
        os.environ["CHALK_DATA_DIR"] = d
        chalk._settings["narrate"] = False
        out = json.loads(chalk.chalk_teach({"title": "Cache", "steps": [{"say": "hi", "draw": {"type": "note", "text": "hello"}}]},
                                           session_id="s1"))
        assert out["success"] and out["media_tag"].startswith("MEDIA:")
        saved = L.load(out["lesson_id"])
        assert saved["steps"][0]["draw"]["type"] == "title"  # a title is added when missing
        # the transform hook appends the MEDIA line once if the model forgot it
        fixed = chalk.on_transform_llm_output(response_text="Here you go.", session_id="s1")
        assert fixed and "MEDIA:" in fixed
        assert chalk.on_transform_llm_output(response_text="again", session_id="s1") is None


def test_sketch_block_cleans_shapes():
    b = L.clean_block({"type": "sketch", "label": "a piston", "shapes": [
        {"shape": "rect", "x": 30, "y": 10, "w": 40, "h": 70},
        {"shape": "circle", "x": 50, "y": 85, "r": 9},
        {"shape": "arrow", "from": [50, 40], "to": [50, 20]},
        {"shape": "label", "text": "cylinder", "at": [95, 20], "to": [70, 25]},
        {"shape": "rect", "x": "oops"},
        {"shape": "laser"},
    ]})
    assert b["type"] == "sketch" and b["label"] == "a piston"
    assert [s["shape"] for s in b["shapes"]] == ["rect", "circle", "arrow", "label"]
    assert L.clean_block({"type": "sketch", "shapes": [{"shape": "nope"}]}) is None
