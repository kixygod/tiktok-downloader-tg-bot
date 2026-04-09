import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const h = fs.readFileSync(path.join(root, "dashboard.html"), "utf-8");
const m = h.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) throw new Error("no script");
let c = m[1].replace(/^      /gm, "");
fs.writeFileSync(path.join(root, "assets", "dashboard.raw.js"), c);
console.log("raw js", c.length);
