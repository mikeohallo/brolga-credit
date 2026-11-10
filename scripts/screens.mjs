// Screenshot checks: render the main pages at a phone and a laptop width, in light
// and dark, and compare each against the same page served from a base commit (main)
// in the same run, so both sides are drawn by the same browser and fonts.
//
//   node scripts/screens.mjs <app url> [<base url>] [<out dir>]
//
// Fails (exit 1) only when a page of the app under test is broken: not a 200, a page
// error or console error, or an empty page. Everything else is reported, not failed:
// pixels that differ from the base (an intended change looks the same as a mistake,
// so a person looks), a page wider than the screen, and a dark scheme that renders
// the same as light. The summary goes to <out dir>/summary.md (and to the job summary
// in CI); the screenshots and the difference images go to <out dir> for upload. Mock
// mode only: every page shows synthetic data, so nothing private is in any image.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [head = "http://127.0.0.1:3000", base, out = "screens"] = process.argv.slice(2);
const PAGES = [
  ["overview", "/"],
  ["borrowers", "/borrowers"],
  ["loans", "/loans"],
  ["new-loan", "/loans/new"],
  ["operations", "/operations"],
  ["console", "/console"],
];
const SIZES = [
  ["phone", { width: 390, height: 844 }],
  ["laptop", { width: 1280, height: 800 }],
];
const SCHEMES = ["light", "dark"];
// Animations and the text caret would make two renders of one page differ.
const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function shoot(url, name, size, scheme, file) {
  const page = await browser.newPage({ viewport: size, colorScheme: scheme, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const res = await page.goto(url + name, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: STILL });
  await page.waitForTimeout(300);
  const facts = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    text: document.body.innerText.trim().length,
  }));
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return { status: res?.status() ?? 0, errors, ...facts };
}

// Pixel difference between two PNGs, worked out in the browser so no image package is needed.
async function diff(fileA, fileB, fileOut) {
  const page = await browser.newPage();
  const a = "data:image/png;base64," + fs.readFileSync(fileA).toString("base64");
  const b = "data:image/png;base64," + fs.readFileSync(fileB).toString("base64");
  const r = await page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const pix = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const pa = pix(ia), pb = pix(ib);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    const o = x.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      const hit = d > 48; // ignore anti-aliasing noise
      if (hit) changed += 1;
      o.data[i] = hit ? 220 : pa[i] * 0.3 + 178; o.data[i + 1] = hit ? 30 : pa[i + 1] * 0.3 + 178; o.data[i + 2] = hit ? 30 : pa[i + 2] * 0.3 + 178; o.data[i + 3] = 255;
    }
    x.putImageData(o, 0, 0);
    return { changed, total: w * h, sameSize: ia.width === ib.width && ia.height === ib.height, png: changed ? c.toDataURL("image/png") : null };
  }, [a, b]);
  await page.close();
  if (r.png) fs.writeFileSync(fileOut, Buffer.from(r.png.split(",")[1], "base64"));
  return { ratio: r.changed / r.total, sameSize: r.sameSize };
}

const lines = [];
const failures = [];
const warnings = [];
for (const [pageName, route] of PAGES) {
  for (const [sizeName, size] of SIZES) {
    const shots = {};
    for (const scheme of SCHEMES) {
      const file = path.join(out, `${pageName}-${sizeName}-${scheme}.png`);
      const f = await shoot(head, route, size, scheme, file);
      shots[scheme] = file;
      const where = `${pageName} (${route}) at ${sizeName} ${size.width} px, ${scheme}`;
      if (f.status !== 200) failures.push(`${where}: HTTP ${f.status}`);
      if (f.errors.length) failures.push(`${where}: ${f.errors.length} error(s): ${f.errors[0].slice(0, 160)}`);
      if (!f.text) failures.push(`${where}: the page is empty`);
      if (scheme === "light" && f.scrollWidth > f.clientWidth) warnings.push(`${where}: wider than the screen (${f.scrollWidth} px in ${f.clientWidth} px)`);
    }
    const dark = await diff(shots.light, shots.dark, path.join(out, `${pageName}-${sizeName}-dark-vs-light-diff.png`));
    let vsBase = "no base given";
    if (base) {
      // The base is visited exactly as often as the app under test (light, then dark), so
      // pages that list the app's own requests (the API console) see the same history.
      const baseFile = path.join(out, `${pageName}-${sizeName}-light-base.png`);
      const bf = await shoot(base, route, size, "light", baseFile);
      await shoot(base, route, size, "dark", path.join(out, `${pageName}-${sizeName}-dark-base.png`));
      if (bf.status !== 200) vsBase = `base answered ${bf.status} (page new on this branch?)`;
      else {
        const d = await diff(shots.light, baseFile, path.join(out, `${pageName}-${sizeName}-light-vs-base-diff.png`));
        vsBase = d.ratio === 0 ? "same as base" : `${(d.ratio * 100).toFixed(2)}% of pixels differ from base${d.sameSize ? "" : " (page size changed)"}`;
        // Below half a percent is clock times and latencies on the API console; still in the table.
        if (d.ratio >= 0.005 || !d.sameSize) warnings.push(`${pageName} at ${sizeName}: ${vsBase}; see the diff image`);
      }
    }
    lines.push(`| ${pageName} | ${sizeName} ${size.width} px | ${vsBase} | ${dark.ratio < 0.001 ? "renders the same as light (no dark theme)" : `${(dark.ratio * 100).toFixed(1)}% differs from light`} |`);
  }
}
await browser.close();

const summary = [
  `## Screenshot checks`,
  ``,
  `App ${head}${base ? `, compared with base ${base}` : ""}; ${PAGES.length} pages × ${SIZES.length} widths × ${SCHEMES.length} schemes. Mock mode, synthetic data only.`,
  ``,
  `| Page | Width | Light, against base | Dark |`,
  `|---|---|---|---|`,
  ...lines,
  ``,
  failures.length ? `**Broken (fails the check):**\n${failures.map((f) => `- ${f}`).join("\n")}` : `**Broken:** none.`,
  ``,
  warnings.length ? `**For a person to look at (does not fail the check):**\n${warnings.map((w) => `- ${w}`).join("\n")}` : `**For a person to look at:** nothing.`,
  ``,
].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exitCode = failures.length ? 1 : 0;
