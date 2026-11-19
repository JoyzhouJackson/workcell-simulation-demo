"""Build the public static joint-scheduling site and its initial Python plan."""

import argparse
from pathlib import Path
import json
import shutil

from build_seven_island_demo import batching_defaults, build as build_classic
from joint.planner import generate_plan
from simpy_six_island_baseline import PUBLIC_KINDS, ROUTES

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "joint"
DOCS = ROOT / "docs"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                               allow_nan=False) + "\n", encoding="utf-8")


def make_fixture():
    return {
        "routes": {PUBLIC_KINDS[kind]: [dict(island=op.island, duration=op.seconds, label=op.operations)
                                      for op in route] for kind, route in ROUTES.items()},
        "printTimes": {str(i): duration for i, duration in enumerate(batching_defaults()["durations"])
                      if duration},
    }


def build(classic=False, runtime=None):
    docs_joint = DOCS / "joint"
    docs_joint.mkdir(parents=True, exist_ok=True)
    if classic or not (DOCS / "classic.html").is_file():
        build_classic(DOCS / "classic.html")
    fixture = make_fixture()
    plan = generate_plan({}, fixture)
    if not plan["stats"]["validation"]:
        raise RuntimeError("基准场景未完成全部订单")
    write_json(SOURCE / "fixture.json", fixture)
    write_json(docs_joint / "default-plan.json", plan)
    for name in ("planner.py", "fixture.json", "planner-worker.js", "app.js", "joint.css",
                 "factory-view.js", "factory-view.css", "gantt.js", "gantt.css"):
        shutil.copyfile(SOURCE / name, docs_joint / name)
    shutil.copytree(SOURCE / "vendor", docs_joint / "vendor", dirs_exist_ok=True)
    if runtime is not None:
        shutil.copytree(runtime, docs_joint / "runtime", dirs_exist_ok=True)
    if not (docs_joint / "runtime/pyodide.mjs").is_file():
        raise FileNotFoundError("docs/joint/runtime 缺少浏览器 Python 运行文件")
    shutil.copyfile(SOURCE / "index.template.html", DOCS / "index.html")
    print(json.dumps(dict(duration=plan["duration"], **plan["stats"]), ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--classic", action="store_true", help="also regenerate the previous SimPy demo")
    parser.add_argument("--runtime", type=Path, help="copy the pinned runtime assets into docs/joint/runtime")
    args = parser.parse_args()
    build(args.classic, args.runtime)
