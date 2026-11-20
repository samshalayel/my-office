/**
 * أوامر AGENTE على خادم المشفى:
 *   serve                         الواجهة + الجدولة اليومية
 *   cycle [--as-of=YYYY-MM-DD]    دورة توقع الآن
 *   eval [--live] [--runs=N] [--only=EV-1,RT-6]   التقييم (يوقف النشر عند الفشل)
 *   backup | restore <file>       نسخ احتياطي / استعادة (الخادم متوقف)
 *   set-password <username>       كلمة السر من AGENTE_NEW_PASSWORD أو من الإدخال
 *   demo-data                     ينسخ البيانات الاصطناعية إلى data/inbox (للتجربة فقط)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createContext } from "../agents/context.ts";
import { runCycle } from "../agents/agt1.ts";
import { resolvePath } from "../config/config.ts";
import { createServer } from "../web/server.ts";
import { hasUsers, setPassword } from "../web/auth.ts";
import { startScheduler } from "./scheduler.ts";
import { createBackup, restoreBackup, verifyBackup } from "../storage/backup.ts";
import { runEvals } from "../evals/runner.ts";
import { asAppError } from "../observability/errors.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string) => rest.includes(`--${name}`);

/** سؤال بإدخال مخفي (كلمة السر لا تظهر على الشاشة ولا تبقى في سجل الطرفية) */
async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => { if (!muted || s.includes("\n") || s.includes("\r\n")) out.output.write(muted ? "\n" : s); };
  return new Promise((r) => {
    rl.question(q, (a) => { rl.close(); r(a); });
    muted = true;
  });
}

async function main() {
  switch (cmd) {
    case "serve": {
      const app = createContext();
      const { server } = createServer(app);
      const stop = startScheduler(app);
      if (!hasUsers(app.db)) console.log("لا يوجد مستخدم بعد — أنشئه أولاً: npm run set-password -- <username>");
      server.listen(app.cfg.server.port, app.cfg.server.host, () => {
        console.log(`AGENTE يعمل على ${app.cfg.server.tls_cert ? "https" : "http"}://${app.cfg.server.host}:${app.cfg.server.port}`);
      });
      const shutdown = () => { stop(); server.close(() => { app.db.close(); process.exit(0); }); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "cycle": {
      const app = createContext();
      const r = await runCycle(app, { as_of: flag("as-of"), trigger: "manual", actor: "cli" });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.error ? 1 : 0);
    }
    case "eval": {
      const report = await runEvals({ live: has("live"), runs: flag("runs") ? Number(flag("runs")) : undefined, only: flag("only")?.split(",") });
      for (const r of report.results) console.log(`${r.pass ? "✅" : "❌"} ${r.case_id}  ${(r.runs.find((x) => !x.pass) ?? r.runs[0])?.evidence ?? ""}`);
      console.log(report.passed ? `\nكل الحالات نجحت (${report.run_id})` : `\nفشل — النشر متوقف (${report.run_id})`);
      process.exit(report.passed ? 0 : 1);
    }
    case "backup": {
      const app = createContext();
      const b = createBackup(app.cfg, app.db, "cli");
      console.log(`نسخة: ${b.file}\nsha256: ${b.sha256}\nسليمة: ${verifyBackup(b.file).ok}`);
      return;
    }
    case "restore": {
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) throw new Error("حدد ملف النسخة: npm run restore -- backups/office-....sqlite");
      const app = createContext();
      app.db.close();
      const r = restoreBackup(app.cfg, path.resolve(file));
      console.log(`استُعيدت إلى ${r.restored_to}${r.previous_saved_as ? `\nالقاعدة السابقة محفوظة في ${r.previous_saved_as}` : ""}`);
      return;
    }
    case "set-password": {
      const user = rest.find((a) => !a.startsWith("--"));
      if (!user) throw new Error("حدد اسم المستخدم: npm run set-password -- owner");
      const pw = process.env.AGENTE_NEW_PASSWORD || (await ask("كلمة السر الجديدة (10 أحرف على الأقل): "));
      const app = createContext();
      setPassword(app.db, user, pw.trim(), "cli");
      console.log(`ضُبطت كلمة سر ${user}.`);
      return;
    }
    case "demo-data": {
      const app = createContext();
      const target = resolvePath(app.cfg, app.cfg.source.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(app.cfg.root, "samples", "pregnancies.sample.json"), target);
      console.log(`نُسخت البيانات الاصطناعية إلى ${target} — للتجربة فقط (as_of المرجعي 2026-11-20).`);
      return;
    }
    default:
      console.log("الأوامر: serve | cycle [--as-of=YYYY-MM-DD] | eval [--live] [--runs=N] [--only=...] | backup | restore <file> | set-password <user> | demo-data");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  const err = asAppError(e);
  console.error(`✖ ${err.userMessage}${err.detail ? ` (${err.code}: ${err.detail})` : ""}`);
  process.exit(1);
});
