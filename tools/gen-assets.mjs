// Generates the SVG asset set for the site. All artwork is original: geometric
// shapes, gradients and paths authored here. Run: node tools/gen-assets.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (p) => {
  const full = join(root, "public", "assets", p);
  mkdirSync(dirname(full), { recursive: true });
  return full;
};

// Light-theme warm neutral palette, tuned to read well on white.
const C = {
  paper: "#fbfaf8",
  ink: "#141312",
  muted: "#6d6a66",
  line: "#e6e2dc",
  accent: "#e8622c",
  accentDeep: "#c24a19",
  amber: "#f2a93b",
  green: "#3f9e6a",
  blue: "#3b7dd8",
};

const defs = `
  <defs>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.accent}"/>
      <stop offset="100%" stop-color="${C.accentDeep}"/>
    </linearGradient>
    <linearGradient id="accSoft" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${C.amber}" stop-opacity="0.10"/>
    </linearGradient>
    <linearGradient id="fadeDown" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="${C.paper}"/>
    </linearGradient>
    <linearGradient id="fadeUp" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="${C.paper}"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${C.blue}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="#141312" stroke-opacity="0.055" stroke-width="1"/>
    </pattern>
  </defs>`;

/* ---------------------------------------------------------------- logo ---- */
const logoMark = (size = 64) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <defs>
    <linearGradient id="lm" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.accent}"/>
      <stop offset="100%" stop-color="${C.accentDeep}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="17" fill="url(#lm)"/>
  <path d="M32 14 L46 19.5 V31 C46 41 39.4 48.6 32 50.5 C24.6 48.6 18 41 18 31 V19.5 Z"
        fill="none" stroke="#fff" stroke-width="3.4" stroke-linejoin="round"/>
  <path d="M26 32.5 L30.5 37 L38.5 28.5" fill="none" stroke="#fff" stroke-width="3.6"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

writeFileSync(out("logo.svg"), logoMark());
writeFileSync(out("logo-mono.svg"), logoMark().replace(/fill="url\(#lm\)"/, 'fill="#141312"'));

/* ------------------------------------------------------------- favicon ---- */
writeFileSync(out("favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="url(#f)"/>
  <defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${C.accent}"/><stop offset="100%" stop-color="${C.accentDeep}"/>
  </linearGradient></defs>
  <path d="M16 7 L23 9.8 V15.5 C23 20.5 19.7 24.3 16 25.3 C12.3 24.3 9 20.5 9 15.5 V9.8 Z"
        fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/>
  <path d="M13 16 L15.3 18.2 L19.2 13.9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

writeFileSync(out("apple-touch-icon.svg"), logoMark(180));

/* ---------------------------------------------------------- hero plate ---- */
// Abstract "correlated sources" motif: a grid with converging result nodes.
const heroPlate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 700" width="1120" height="700" role="img" aria-label="Abstract diagram of query sources converging on correlated results">
  ${defs}
  <rect width="1120" height="700" fill="${C.paper}"/>
  <ellipse cx="300" cy="140" rx="330" ry="240" fill="url(#glowA)"/>
  <ellipse cx="880" cy="600" rx="300" ry="230" fill="url(#glowB)"/>
  <rect width="1120" height="700" fill="url(#grid)"/>

  <g stroke="${C.ink}" stroke-opacity="0.13" fill="none" stroke-width="1.4">
    <path d="M150 150 C330 150 360 330 545 350"/>
    <path d="M150 250 C320 250 350 340 545 352"/>
    <path d="M150 350 C330 352 380 352 545 352"/>
    <path d="M150 450 C320 452 360 372 545 354"/>
    <path d="M150 550 C330 552 370 386 545 354"/>
    <path d="M970 150 C790 152 760 330 575 350"/>
    <path d="M970 250 C800 252 770 340 575 348"/>
    <path d="M970 350 C790 350 750 352 575 352"/>
    <path d="M970 450 C800 452 760 372 575 354"/>
    <path d="M970 550 C790 552 770 386 575 354"/>
  </g>

  <g>
    ${[
      [150, 150], [150, 250], [150, 350], [150, 450], [150, 550],
      [970, 150], [970, 250], [970, 350], [970, 450], [970, 550],
    ]
      .map(
        ([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="#fff" stroke="${C.ink}" stroke-opacity="0.22" stroke-width="1.6"/>`
      )
      .join("\n    ")}
  </g>

  <g>
    <circle cx="560" cy="352" r="132" fill="url(#accSoft)"/>
    <circle cx="560" cy="352" r="96" fill="#fff" stroke="${C.accent}" stroke-opacity="0.42" stroke-width="2"/>
    <circle cx="560" cy="352" r="60" fill="url(#acc)"/>
    <path d="M560 322 L582 333 V352 C582 369 571.6 381.8 560 385.6 C548.4 381.8 538 369 538 352 V333 Z"
          fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/>
    <path d="M551 353 L557.6 359.6 L569.6 346.2" fill="none" stroke="#fff" stroke-width="3.4"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <g opacity="0.85">
    ${[
      [430, 232], [700, 240], [420, 470], [706, 462], [560, 190], [560, 516], [352, 352], [768, 352],
    ]
      .map(
        ([x, y]) =>
          `<circle cx="${x}" cy="${y}" r="4.5" fill="${C.accent}" fill-opacity="0.5"/>`
      )
      .join("\n    ")}
  </g>
</svg>`;

writeFileSync(out("hero-convergence.svg"), heroPlate);

/* ------------------------------------------------- lookup type icons ----- */
const lookupIcon = (kind) => {
  const base = (inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">${defs}
    <rect width="48" height="48" rx="14" fill="${C.paper}" stroke="${C.line}" stroke-width="1.5"/>
    <g fill="none" stroke="${C.accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
  </svg>`;

  const map = {
    email: '<rect x="12" y="17" width="24" height="16" rx="3"/><path d="m12.5 19 11.5 7.5L35.5 19"/>',
    phone: '<path d="M17 15h-3.4a2 2 0 0 0-2 2.4C13 29 19 35 30.6 37.4a2 2 0 0 0 2-2V32l-6-1.6-2 2.4a19 19 0 0 1-7.4-7.4l2.4-2L18 17.4Z"/>',
    username: '<circle cx="24" cy="20" r="6"/><path d="M13.5 36c0-5.2 4.7-8.4 10.5-8.4S34.5 30.8 34.5 36"/>',
    ip: '<circle cx="24" cy="24" r="12"/><path d="M12 24h24M24 12c4 4.2 4 19.8 0 24M24 12c-4 4.2-4 19.8 0 24"/>',
    domain: '<rect x="11" y="20" width="26" height="17" rx="3"/><path d="M17 20v-4a3.4 3.4 0 0 1 6.6-1.2M15.5 27h3l1.5 2.6 1.5-2.6h3"/>',
    discord: '<path d="M19 17a13 13 0 0 1 10 0M20.5 30.5A13 13 0 0 0 28 30.5"/><path d="M17.5 18.5c-2 4.6-2.6 9.4-2 14l4-2 2 2.4M30.5 18.5c2 4.6 2.6 9.4 2 14l-4-2-2 2.4"/><circle cx="20.5" cy="25" r="1.2"/><circle cx="27.5" cy="25" r="1.2"/>',
    name: '<path d="M14 38V21a3 3 0 0 1 3-3h3l2 3h8a3 3 0 0 1 3 3v14Z"/><path d="M18 28h7M18 32h5"/>',
    stealer: '<rect x="11" y="15" width="26" height="18" rx="3"/><path d="M17 37h14M24 33v4"/><path d="m19 22 3.4 3.4L28.5 19"/>',
  };
  return base(map[kind] ?? map.email);
};

for (const k of ["email", "phone", "username", "ip", "domain", "discord", "name", "stealer"]) {
  writeFileSync(out(`lookup-${k}.svg`), lookupIcon(k));
}

/* -------------------------------------------------------- step visuals --- */
const stepArt = (n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200" role="img" aria-label="Step ${n} illustration">
  ${defs}
  <rect width="320" height="200" rx="18" fill="${C.paper}" stroke="${C.line}" stroke-width="1.5"/>
  <rect x="0" y="0" width="320" height="200" rx="18" fill="url(#grid)"/>
  ${
    n === 1
      ? `<rect x="86" y="76" width="148" height="46" rx="12" fill="#fff" stroke="${C.line}" stroke-width="1.6"/>
         <circle cx="108" cy="99" r="7" fill="none" stroke="${C.accent}" stroke-width="2"/>
         <path d="m113 104 5 5" stroke="${C.accent}" stroke-width="2" stroke-linecap="round"/>
         <rect x="128" y="94" width="76" height="8" rx="4" fill="${C.ink}" fill-opacity="0.14"/>
         <rect x="204" y="88" width="18" height="22" rx="6" fill="url(#acc)"/>`
      : n === 2
        ? `${[0, 1, 2, 3, 4]
            .map(
              (i) =>
                `<circle cx="${62 + i * 49}" cy="100" r="15" fill="#fff" stroke="${C.line}" stroke-width="1.6"/>
                 <circle cx="${62 + i * 49}" cy="100" r="5" fill="${C.accent}" fill-opacity="0.6"/>`
            )
            .join("")}
           <path d="M62 100h196" stroke="${C.accent}" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="5 7"/>
           <path d="m250 92 12 8-12 8" fill="none" stroke="${C.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<rect x="70" y="52" width="180" height="96" rx="14" fill="#fff" stroke="${C.line}" stroke-width="1.6"/>
           ${[0, 1, 2]
             .map(
               (i) =>
                 `<rect x="88" y="${68 + i * 24}" width="${132 - i * 30}" height="9" rx="4.5" fill="${C.ink}" fill-opacity="${0.16 - i * 0.03}"/>
                  <circle cx="${232 - i * 18}" cy="${72 + i * 24}" r="7" fill="url(#acc)" fill-opacity="${1 - i * 0.25}"/>`
             )
             .join("")}`
  }
</svg>`;

[1, 2, 3].forEach((n) => writeFileSync(out(`step-${n}.svg`), stepArt(n)));

/* ------------------------------------------------------------ avatars ---- */
const avatar = (seed, label) => {
  const pal = [
    [C.accent, C.amber],
    [C.blue, "#7aa9e8"],
    [C.green, "#7bc79a"],
    ["#8b5cf6", "#b39bf0"],
    ["#0ea5a5", "#68cfcf"],
  ][seed % 5];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${label}">
  <defs><linearGradient id="a${seed}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${pal[0]}"/><stop offset="100%" stop-color="${pal[1]}"/>
  </linearGradient></defs>
  <circle cx="48" cy="48" r="48" fill="url(#a${seed})"/>
  <circle cx="48" cy="38" r="14" fill="#fff" fill-opacity="0.92"/>
  <path d="M20 84c0-15.5 12.5-26 28-26s28 10.5 28 26Z" fill="#fff" fill-opacity="0.92"/>
</svg>`;
};
const names = ["mira", "devin", "sasha", "rowan", "kofi", "elena"];
names.forEach((n, i) => writeFileSync(out(`avatar-${n}.svg`), avatar(i, n)));

/* --------------------------------------------------------- og banner ----- */
writeFileSync(
  out("og-cover.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="Veriscope">
  ${defs}
  <rect width="1200" height="630" fill="${C.paper}"/>
  <ellipse cx="980" cy="90" rx="380" ry="300" fill="url(#glowA)"/>
  <ellipse cx="140" cy="600" rx="330" ry="250" fill="url(#glowB)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <g transform="translate(88 96)">
    <rect width="76" height="76" rx="20" fill="url(#acc)"/>
    <path d="M38 18 L58 26 V41 C58 55 48.8 65.6 38 68.4 C27.2 65.6 18 55 18 41 V26 Z"
          fill="none" stroke="#fff" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M30 43 L35.8 48.8 L46 36.2" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="88" y="288" font-family="Segoe UI, Arial, sans-serif" font-size="76" font-weight="700" fill="${C.ink}" letter-spacing="-2.4">Correlated breach intelligence</text>
  <text x="88" y="378" font-family="Segoe UI, Arial, sans-serif" font-size="76" font-weight="700" fill="url(#acc)" letter-spacing="-2.4">across 70+ sources</text>
  <text x="88" y="452" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="400" fill="${C.muted}">Email, phone, username, IP, domain and Discord ID lookups.</text>
  <g transform="translate(88 500)">
    <rect width="248" height="52" rx="26" fill="${C.ink}"/>
    <text x="124" y="34" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="21" font-weight="600" fill="#fff">veriscope.app</text>
  </g>
</svg>`
);

console.log("SVG assets written to public/assets");