import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const h = fs.readFileSync(path.join(root, "dashboard.html"), "utf-8");
const m = h.match(/<style>([\s\S]*?)<\/style>/);
if (!m) throw new Error("no style");
const c = m[1].replace(/^      /gm, "");
const dir = path.join(root, "assets");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "dashboard.css"), c);
console.log("wrote", path.join(dir, "dashboard.css"), c.length);
