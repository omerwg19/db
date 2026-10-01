// Walks every page, collects internal href/src, and confirms each one resolves.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PUBLIC = join(process.cwd(), "public");
const pages = (await readdir(PUBLIC)).filter((f) => f.endsWith(".html"));

const refs = new Map();
for (const page of pages) {
  const html = await readFile(join(PUBLIC, page), "utf8");
  const found = new Set();
  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) {
    const v = m[1];
    if (/^(https?:|mailto:|tel:|#|data:|\/\/)/.test(v)) continue;
    found.add(v);
  }
  refs.set(page, found);
}

const exists = new Map();
for (const p of pages) exists.set("/" + p, true);
for (const dir of ["assets", "img", "css", "js"]) {
  for (const f of await readdir(join(PUBLIC, dir))) {
    exists.set(`/${dir}/${f}`, true);
  }
}
exists.set("/", true);

let broken = 0;
for (const [page, set] of refs) {
  const bad = [...set].filter((v) => {
    const path = v.split("#")[0].split("?")[0];
    if (!path) return false;
    return !exists.has(path);
  });
  if (bad.length) {
    broken += bad.length;
    console.log(`${page}:`);
    for (const b of bad) console.log(`   MISSING ${b}`);
  }
}

console.log(`\n${pages.length} pages, ${[...refs.values()].reduce((n, s) => n + s.size, 0)} internal refs, ${broken} broken`);