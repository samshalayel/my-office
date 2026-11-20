/** BASE-A5: تعليمات الوكيل ملفات بإصدار في prompts/ — الإصدار يُسجَّل في كل سطر تتبع. لا أسرار داخلها (MIT-9). */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";

export interface Prompt { version: string; text: string }

export function loadPrompt(cfg: Config, name: string): Prompt {
  const file = path.join(cfg.root, "prompts", `${name}.md`);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { throw new AppError("CONFIG_INVALID", `prompt ${name} missing`); }
  const m = /^---\s*\nversion:\s*(\S+)\s*\n---\s*\n([\s\S]*)$/.exec(raw);
  if (!m) throw new AppError("CONFIG_INVALID", `prompt ${name}: missing version header`);
  return { version: m[1], text: m[2].trim() };
}
