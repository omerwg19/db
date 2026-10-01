// Rasterises the SVG assets into PNG using headless Edge, which is already on
// the machine. Also emits OG/twitter raster sizes. Run: node tools/render.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "public", "assets");
const outDir = join(root, "public", "img");
mkdirSync(outDir, { recursive: true });

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const edge = EDGE_CANDIDATES.find((p) => {
  try { return statSync(p).isFile(); } catch { return false; }
});
if (!edge) { console.error("No Chromium browser found; skipping raster step."); process.exit(0); }

// Only the artwork that actually benefits from being raster.
const targets = [
  ["hero-convergence.svg", 1120, 700, "png"],
  ["og-cover.svg", 1200, 630, "png"],
  ["logo.svg", 64, 64, "png"],
  ["favicon.svg", 32, 32, "png"],
  ["apple-touch-icon.svg", 180, 180, "png"],
  ...[1, 2, 3].map((n) => [`step-${n}.svg`, 320, 200, "png"]),
  ...["email", "phone", "username", "ip", "domain", "discord", "name", "stealer"].map(
    (k) => [`lookup-${k}.svg`, 48, 48, "png"]
  ),
  ...["mira", "devin", "sasha", "rowan", "kofi", "elena"].map(
    (n) => [`avatar-${n}.svg`, 96, 96, "png"]
  ),
];

let ok = 0;
for (const [file, w, h, fmt] of targets) {
  const src = join(assets, file);
  const dest = join(outDir, basename(file, ".svg") + "." + fmt);
  try {
    execFileSync(
      edge,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--default-background-color=00000000",
        `--window-size=${w},${h}`,
        `--screenshot=${dest}`,
        "file:///" + src.replace(/\\/g, "/"),
      ],
      { stdio: "ignore", timeout: 60000 }
    );
    ok++;
  } catch (e) {
    console.error("  failed:", file, e.message.split("\n")[0]);
  }
}

const made = readdirSync(outDir).filter((f) => f.endsWith(".png"));
const totalBytes = made.reduce((s, f) => s + statSync(join(outDir, f)).size, 0);
console.log(`rendered ${ok}/${targets.length} -> public/img  (${made.length} files, ${(totalBytes / 1024).toFixed(0)} KB total)`);