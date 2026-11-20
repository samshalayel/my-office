"""أوامر AGENTE على خادم المشفى (python -m agente ...):
  serve                         الواجهة + الجدولة اليومية
  cycle [--as-of=YYYY-MM-DD]    دورة توقع الآن
  eval [--live] [--runs=N] [--only=EV-1,RT-6]   التقييم (يوقف النشر عند الفشل)
  backup | restore <file>       نسخ احتياطي / استعادة (الخادم متوقف)
  set-password <username>       كلمة السر من AGENTE_NEW_PASSWORD أو من الإدخال المخفي
  demo-data                     ينسخ البيانات الاصطناعية إلى data/inbox (للتجربة فقط)
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import shutil
import signal
import sys

from ..observability.errors import as_app_error

USAGE = "الأوامر: serve | cycle [--as-of=YYYY-MM-DD] | eval [--live] [--runs=N] [--only=...] | backup | restore <file> | set-password <user> | demo-data"


def _utf8_stdio() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m agente", description="AGENTE — توقع الخدج القادمين (نسخة Python + LangGraph)")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("serve")
    c = sub.add_parser("cycle")
    c.add_argument("--as-of", dest="as_of")
    e = sub.add_parser("eval")
    e.add_argument("--live", action="store_true")
    e.add_argument("--runs", type=int)
    e.add_argument("--only")
    sub.add_parser("backup")
    r = sub.add_parser("restore")
    r.add_argument("file", nargs="?")
    sp = sub.add_parser("set-password")
    sp.add_argument("user", nargs="?")
    sub.add_parser("demo-data")
    return p


def _run(args: argparse.Namespace) -> int:
    from ..agents.context import create_context

    cmd = args.cmd
    if cmd == "serve":
        from ..web.auth import has_users
        from ..web.server import create_server
        from .scheduler import start_scheduler

        app = create_context()
        web = create_server(app)
        stop = start_scheduler(app, web.loop)
        if not has_users(app.db):
            print("لا يوجد مستخدم بعد — أنشئه أولاً: python -m agente set-password <username>")
        print(f"AGENTE يعمل على {'https' if web.webapp.secure else 'http'}://{app.cfg['server']['host']}:{web.port}")

        def shutdown(*_: object) -> None:
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, shutdown)
        try:
            web.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stop()
            web.close()
            app.db.close()
        return 0
    if cmd == "cycle":
        from ..agents.agt1 import run_cycle
        from ..jsutil import jdump

        app = create_context()
        r = asyncio.run(run_cycle(app, as_of=args.as_of, trigger="manual", actor="cli"))
        print(jdump(r, indent=2))
        return 1 if r.get("error") else 0
    if cmd == "eval":
        from ..evals.runner import run_evals

        report = asyncio.run(run_evals(live=args.live, runs=args.runs, only=args.only.split(",") if args.only else None))
        for r in report["results"]:
            ev = next((x for x in r["runs"] if not x["pass"]), r["runs"][0] if r["runs"] else None)
            print(f"{'✅' if r['pass'] else '❌'} {r['case_id']}  {ev['evidence'] if ev else ''}")
        print(f"\nكل الحالات نجحت ({report['run_id']})" if report["passed"] else f"\nفشل — النشر متوقف ({report['run_id']})")
        return 0 if report["passed"] else 1
    if cmd == "backup":
        from ..storage.backup import create_backup, verify_backup

        app = create_context()
        b = create_backup(app.cfg, app.db, "cli")
        print(f"نسخة: {b['file']}\nsha256: {b['sha256']}\nسليمة: {str(verify_backup(b['file'])['ok']).lower()}")
        return 0
    if cmd == "restore":
        from ..storage.backup import restore_backup

        if not args.file:
            raise ValueError("حدد ملف النسخة: python -m agente restore backups/office-....sqlite")
        app = create_context()
        app.db.close()
        r = restore_backup(app.cfg, os.path.abspath(args.file))
        print(f"استُعيدت إلى {r['restored_to']}" + (f"\nالقاعدة السابقة محفوظة في {r['previous_saved_as']}" if r["previous_saved_as"] else ""))
        return 0
    if cmd == "set-password":
        from ..web.auth import set_password

        if not args.user:
            raise ValueError("حدد اسم المستخدم: python -m agente set-password owner")
        # إدخال مخفي: كلمة السر لا تظهر على الشاشة ولا تبقى في سجل الطرفية
        pw = os.environ.get("AGENTE_NEW_PASSWORD") or getpass.getpass("كلمة السر الجديدة (10 أحرف على الأقل): ")
        app = create_context()
        set_password(app.db, args.user, pw.strip(), "cli")
        print(f"ضُبطت كلمة سر {args.user}.")
        return 0
    if cmd == "demo-data":
        from ..config.config import resolve_path, shared_dir

        app = create_context()
        target = resolve_path(app.cfg, app.cfg["source"]["path"])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(shared_dir(app.cfg), "samples", "pregnancies.sample.json"), target)
        print(f"نُسخت البيانات الاصطناعية إلى {target} — للتجربة فقط (as_of المرجعي 2026-11-20).")
        return 0
    print(USAGE)
    return 1 if cmd else 0


def main(argv: list[str] | None = None) -> None:
    _utf8_stdio()
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(USAGE)
        sys.exit(0)
    try:
        args = _parser().parse_args(argv)
    except SystemExit:
        print(USAGE)
        raise
    try:
        code = _run(args)
    except Exception as e:
        err = as_app_error(e)
        if type(e) is ValueError:
            print(f"✖ {e}", file=sys.stderr)
        else:
            print(f"✖ {err.user_message}{f' ({err.code}: {err.detail})' if err.detail else ''}", file=sys.stderr)
        code = 1
    sys.exit(code)
