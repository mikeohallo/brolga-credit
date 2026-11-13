#!/usr/bin/env node
// Brolga's deploy steps, as one script the owner's own machine runs on a named commit.
//
//   node scripts/deploy.mjs preflight <commit>   checks only; logged out
//   node scripts/deploy.mjs build     <commit>   preflight, then the hosted build and an offline
//                                                dry run of the deploy; logged out
//   node scripts/deploy.mjs ship      <commit>   build checks again, one short login, the deploy,
//                                                the logout (always), then live checks
//   node scripts/deploy.mjs rehearse  <commit>   the same as build, and says nothing was deployed
//
// <commit> is all 40 characters and must equal HEAD. Add `--report <file>` to write the run's
// report (never a secret) to a file outside this repository.
//
// What it never does: print or take a secret (the model key is typed by the owner in the
// Cloudflare dashboard), call `npm`, `npx` or any package script (Node runs each tool's own
// file), create a token, or leave a Wrangler login behind.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "brolga.mikeohalloran.au";
const WORKER = "brolga";
// The login asks only for what this deploy needs (a first guess; the first deploy names
// anything missing, and it is recorded in CLAUDE.md).
const SCOPES = ["account:read", "user:read", "workers:write", "workers_scripts:write", "workers_routes:write", "zone:read"];
const CLAUDE_APP_VARS = new Set(["GIT_ASKPASS", "GIT_EDITOR", "GIT_TERMINAL_PROMPT", "NODE_USE_SYSTEM_CA"]);

const report = [];
function say(line) { console.log(line); report.push(line); }
function ok(what) { say(`ok    ${what}`); }
function fail(what, extra) {
  say(`STOP  ${what}`);
  if (extra) say(`      ${extra}`);
  const err = new Error(what);
  err.stop = true;
  throw err;
}

// ---------- small helpers ----------

function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i]; } else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function git(args) {
  // Git without this machine's own settings: hooks off, no fsmonitor, empty global config.
  const empty = path.join(os.tmpdir(), "brolga-empty-gitconfig");
  writeFileSync(empty, "");
  const r = spawnSync("git", ["-c", "core.hooksPath=" + path.join(ROOT, ".git", "no-hooks"), "-c", "core.fsmonitor=false", ...args], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty },
  });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed`, (r.stderr || "").trim().slice(0, 300));
  return r.stdout;
}

function node(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

const wranglerJs = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const opennextJs = path.join(ROOT, "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "index.js");

function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc); else acc.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return acc.sort();
}

// ---------- the checks ----------

function checkEnvironment() {
  const bad = Object.keys(process.env).filter((k) =>
    !CLAUDE_APP_VARS.has(k) &&
    (/^(GIT_|NODE_|NPM_CONFIG_|CLOUDFLARE_|CF_|WRANGLER_|MINIFLARE_|OPENSSL_)/i.test(k) ||
      /^(XDG_CONFIG_HOME|PREFIX|DESTDIR|CI|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(k)));
  if (bad.length) fail("environment variables that could change a deploy are set (names only)", bad.join(", "));
  ok("no environment variable that could change a deploy (names only)");
  if (process.platform === "win32") {
    for (const k of ["ComSpec", "SystemRoot", "windir"]) {
      const v = process.env[k] || process.env[k.toUpperCase()] || "";
      if (!/^C:\\Windows/i.test(v)) fail(`${k} does not point at C:\\Windows`);
    }
    ok("ComSpec, SystemRoot and windir point at C:\\Windows");
  }
}

// npm settings that would run code or change what runs: read by key name only, never printed.
// Checks the user's .npmrc, the global one, npm's built-in one and any file a `prefix` line
// points to; and, on Windows, a second npm where the `npm` command would find it first.
function checkNpmSettings() {
  const home = os.homedir();
  const nodeDir = path.dirname(process.execPath);
  const files = new Set([
    path.join(home, ".npmrc"),
    path.join(nodeDir, "etc", "npmrc"),
    path.join(nodeDir, "..", "etc", "npmrc"),
    path.join(nodeDir, "node_modules", "npm", "npmrc"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "npmrc"),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "etc", "npmrc")] : []),
  ]);
  const bad = [];
  const read = (f) => {
    if (!existsSync(f)) return;
    for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z0-9_@:./-]+?)\s*=\s*(.*?)\s*$/);
      if (!m || /^[;#]/.test(raw.trim())) continue;
      const key = m[1].toLowerCase().replace(/_/g, "-");
      if (key === "node-options" || key === "script-shell") bad.push(`${path.basename(f)}: ${key}`);
      if (key === "prefix" && m[2]) files.add(path.join(m[2].replace(/^["']|["']$/g, ""), "etc", "npmrc"));
    }
  };
  for (const f of [...files]) read(f);
  for (const f of [...files]) read(f); // a prefix line may add a file
  if (bad.length) fail("an npm settings file sets a key that runs code (key names only)", [...new Set(bad)].join(", "));
  ok("no npm settings file sets node-options or script-shell (names only)");
  if (process.platform === "win32" && process.env.APPDATA) {
    const other = path.join(process.env.APPDATA, "npm");
    if (existsSync(path.join(other, "npm.cmd")) || existsSync(path.join(other, "node_modules", "npm"))) {
      fail("another npm is installed where the `npm` command would find it first", other);
    }
    ok("no other npm where the `npm` command would find it");
  }
}

function loginFiles() {
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  const bases = [
    appdata && path.join(appdata, "xdg.config", ".wrangler"),
    path.join(home, ".wrangler"),
    path.join(home, ".config", ".wrangler"),
    path.join(home, "Library", "Preferences", ".wrangler"),
  ].filter(Boolean);
  const found = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const f of walk(base)) {
      if (/(^|\/)config\/default\.(toml|enc)$/.test(f)) {
        if (f.endsWith(".enc") || /oauth_token/.test(readFileSync(path.join(base, f), "utf8"))) found.push(path.join(base, f));
      } else if (/^profiles\//.test(f) || /temporary-account/i.test(f)) found.push(path.join(base, f));
    }
  }
  for (const cf of [appdata && path.join(appdata, "xdg.config", "cloudflare"), path.join(home, ".config", "cloudflare")].filter(Boolean)) {
    if (existsSync(cf) && walk(cf).length) found.push(cf);
  }
  return found;
}

function checkNoLogin(when) {
  const found = loginFiles();
  if (found.length) {
    fail(`a Wrangler login is present ${when}`, "Another deploy may be running. Stop and ask; never log it out from here. Files: " + found.join(", "));
  }
  ok(`no Wrangler login in any place Wrangler keeps one (${when})`);
}

function checkCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit || "")) fail("the commit must be all 40 characters, lower case hex");
  const head = git(["rev-parse", "HEAD"]).trim();
  if (head !== commit) fail("HEAD is not the named commit", `HEAD ${head}, named ${commit}`);
  ok(`HEAD is exactly ${commit}`);
  const dirty = git(["status", "--porcelain"]).trim();
  if (dirty) fail("the working tree is not clean", dirty.split("\n").slice(0, 5).join(" | "));
  ok("git status --porcelain prints nothing");
}

function checkLeftovers(allowed) {
  const lines = git(["status", "--porcelain", "--ignored"]).split("\n").filter(Boolean);
  // Git lists an ignored folder as one entry ("hosted/"); look inside any folder that is not
  // itself allowed as a whole, so only the named files may be there.
  const extra = lines.filter((l) => l.startsWith("!! ")).map((l) => l.slice(3)).flatMap((p) => {
    if (allowed.includes(p)) return [];
    if (p.endsWith("/")) return walk(path.join(ROOT, p), ROOT).filter((f) => !allowed.includes(f));
    return [p];
  });
  if (extra.length) fail("files git ignores that a deploy should not have", extra.join(", "));
  // The tracked example file is data; Wrangler loads only .env, .env.local and .env.<name>.
  const tracked = new Set(git(["ls-files"]).split("\n"));
  const envFiles = readdirSync(ROOT).filter((n) => (n === ".env" || n.startsWith(".env.")) && !(n === ".env.example" && tracked.has(n)));
  if (envFiles.length) fail("an .env file is in the folder", envFiles.join(", "));
  if (existsSync(path.join(ROOT, ".wrangler", "deploy"))) fail(".wrangler/deploy exists (it would redirect the configuration)");
  const w = path.join(ROOT, ".wrangler");
  if (existsSync(w)) {
    if (walk(w).length) fail(".wrangler holds files", walk(w).slice(0, 5).join(", "));
    rmSync(w, { recursive: true });
    ok("removed an empty .wrangler folder");
  }
  ok("the ignored files are only the expected ones, no .env, no .wrangler/deploy");
}

function checkConfig() {
  const cfg = JSON.parse(stripJsonc(readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")));
  const want = (cond, what) => { if (!cond) fail("wrangler.jsonc: " + what); };
  want(cfg.name === WORKER, `name is "${WORKER}"`);
  want(cfg.main === "src/hosted/worker.ts", "main is src/hosted/worker.ts");
  want(!("build" in cfg), "has no build command (it would run while logged in)");
  want(cfg.workers_dev === false, "workers_dev is false (a workers.dev address would sit outside Access)");
  want(cfg.preview_urls === false, "preview_urls is false");
  want(Array.isArray(cfg.routes) && cfg.routes.length === 1 &&
    cfg.routes[0].pattern === HOST && cfg.routes[0].custom_domain === true && Object.keys(cfg.routes[0]).length === 2,
  `the only route is the custom domain ${HOST}`);
  want(!cfg.env && !cfg.triggers && !cfg.route, "has no env, triggers or route section");
  want(cfg.assets?.directory === ".open-next/assets", "assets are .open-next/assets");
  want(cfg.durable_objects?.bindings?.length === 1 && cfg.durable_objects.bindings[0].class_name === "BrolgaStore", "one Durable Object, BrolgaStore");
  want(cfg.migrations?.some((m) => m.new_sqlite_classes?.includes("BrolgaStore")), "a migration creates BrolgaStore as SQLite-backed");
  const v = cfg.vars || {};
  want(v.BROLGA_HOSTED === "1", 'BROLGA_HOSTED is "1"');
  want(v.ZEPTO_MODE === "mock", 'ZEPTO_MODE is "mock"');
  want(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(v.ACCESS_TEAM_DOMAIN || ""), "ACCESS_TEAM_DOMAIN is a cloudflareaccess.com team domain");
  want(/^[0-9a-f]{64}$/.test(v.ACCESS_AUD || ""), "ACCESS_AUD is the application's 64-character tag");
  want(!Object.keys(v).some((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)), "holds no secret-looking variable");
  ok(`wrangler.jsonc: ${WORKER}, only ${HOST} as a custom domain, workers.dev and previews off, mock mode, Access values set, no secrets`);
  return cfg;
}

function checkToolchain(required) {
  if (!existsSync(path.join(ROOT, "node_modules", "wrangler", "package.json"))) {
    if (required) fail("the packages are not installed (run npm ci first)");
    ok("the toolchain's versions are checked after the install (not installed yet)");
    return;
  }
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  for (const pkg of ["wrangler", "@opennextjs/cloudflare"]) {
    const want = lock.packages?.[`node_modules/${pkg}`]?.version;
    const have = JSON.parse(readFileSync(path.join(ROOT, "node_modules", ...pkg.split("/"), "package.json"), "utf8")).version;
    if (!want || want !== have) fail(`${pkg} installed (${have}) is not the lockfile's version (${want})`);
  }
  ok("Wrangler and the OpenNext adapter are the lockfile's versions");
  const cache = path.join(ROOT, "node_modules", ".cache");
  if (existsSync(cache)) { rmSync(cache, { recursive: true }); ok("deleted node_modules/.cache"); }
}

// `preflight` runs before the install, so it checks the toolchain only if it is there;
// `build` and `ship` always do.
function preflight(commit, allowedIgnored, toolchainRequired = true) {
  checkEnvironment();
  checkNpmSettings();
  checkCommit(commit);
  checkLeftovers(allowedIgnored);
  checkConfig();
  checkNoLogin("before the build");
  checkToolchain(toolchainRequired);
}

// ---------- build ----------

const BUILT = [".open-next/", "hosted/investigator.seed.txt", ".next/", "next-env.d.ts", "tsconfig.tsbuildinfo"];

function build() {
  let r = node(["scripts/hosted-seed.mjs"], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  if (r.status !== 0) fail("the investigator seed was not generated", (r.stderr || r.stdout).slice(-400));
  ok("the sealed investigator seed was generated");
  r = node([opennextJs, "build"], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) fail("the hosted build failed", (r.stderr + r.stdout).slice(-800));
  for (const f of [".open-next/worker.js", ".open-next/assets"]) if (!existsSync(path.join(ROOT, f))) fail(`${f} was not built`);
  ok("the hosted build finished (Next built by Node directly, no npm)");
  const manifest = manifestOf();
  writeFileSync(path.join(ROOT, ".open-next", "build-manifest.json"), JSON.stringify(manifest, null, 1));
  ok(`built files recorded: ${manifest.assetCount} files, tree ${manifest.assets.slice(0, 12)}…`);
  dryRun();
}

function manifestOf() {
  // Every built file: the Worker entry, the server code and the assets.
  const dir = path.join(ROOT, ".open-next");
  const all = walk(dir).filter((f) => f !== "build-manifest.json");
  const h = createHash("sha256");
  for (const f of all) h.update(f + "\0" + sha256(path.join(dir, f)) + "\n");
  return { worker: sha256(path.join(dir, "worker.js")), assets: h.digest("hex"), assetCount: all.length };
}

function dryRun() {
  const out = mkdtempSync(path.join(os.tmpdir(), "brolga-dry-"));
  const r = node([wranglerJs, "deploy", "--dry-run", "--config", "wrangler.jsonc", "--outdir", out]);
  const text = (r.stdout || "") + (r.stderr || "");
  rmSync(out, { recursive: true, force: true });
  if (r.status !== 0) fail("the offline dry run of the deploy failed", text.slice(-600));
  if (/workers\.dev/i.test(text)) fail("the dry run mentions a workers.dev address");
  if (!/env\.STORE \(BrolgaStore\)\s+Durable Object/.test(text)) fail("the dry run does not list the Durable Object binding");
  if (!/env\.ACCESS_AUD /.test(text) || !/env\.ZEPTO_MODE \("mock"\)/.test(text)) fail("the dry run does not list the Access and mock-mode variables");
  ok("offline dry run: bundle builds, Durable Object and Access values bound, no workers.dev");
}

function verifyBuilt() {
  const file = path.join(ROOT, ".open-next", "build-manifest.json");
  if (!existsSync(file)) fail("no build record; run `build` first");
  const recorded = JSON.parse(readFileSync(file, "utf8"));
  const now = manifestOf();
  if (recorded.worker !== now.worker || recorded.assets !== now.assets) fail("the built files changed since the build");
  ok("the built files are byte-identical to the build just made");
}

// ---------- ship ----------

async function liveChecks() {
  const team = JSON.parse(stripJsonc(readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"))).vars.ACCESS_TEAM_DOMAIN;
  const paths = ["/", "/api/investigate/cases", "/manifest.webmanifest", "/icon-192.png"];
  const deadline = Date.now() + 6 * 60 * 1000;
  for (const p of paths) {
    let last = "no answer";
    for (;;) {
      try {
        const res = await fetch(`https://${HOST}${p}`, { redirect: "manual", headers: { "user-agent": "brolga-deploy-check" } });
        const loc = res.headers.get("location") || "";
        if ([301, 302, 303, 307].includes(res.status) && new URL(loc, `https://${HOST}`).host === team) { ok(`${p}: sent to ${team} sign-in without a token`); break; }
        last = `status ${res.status}${loc ? ", location " + new URL(loc, `https://${HOST}`).host : ""}`;
        if (res.status === 200 || res.status === 500) fail(`${p} answered without a sign-in`, last);
      } catch (e) { last = String(e.cause?.code || e.message); }
      if (Date.now() > deadline) fail(`${p}: never reached the Access sign-in within 6 minutes`, last);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

async function ship(commit) {
  preflight(commit, [...BUILT, "node_modules/"]);
  verifyBuilt();
  let deployed = false;
  let loggedIn = false;
  try {
    say(`login: asking for only ${SCOPES.join(" ")}. Check Cloudflare's Allow page lists only those, then click Allow.`);
    const l = spawnSync(process.execPath, [wranglerJs, "login", "--scopes", ...SCOPES], { cwd: ROOT, stdio: "inherit" });
    loggedIn = loginFiles().length > 0;
    if (l.status !== 0) fail("the login did not complete");
    ok("logged in with the short list");
    const d = node([wranglerJs, "deploy", "--config", "wrangler.jsonc", "--message", `brolga ${commit}`]);
    const text = (d.stdout || "") + (d.stderr || "");
    // Print the deploy output without anything that looks like a token.
    say(text.replace(/[A-Za-z0-9_-]{40,}/g, "[…]").trim());
    if (d.status !== 0) fail("the deploy failed", "see the output above; a missing permission is named there");
    deployed = true;
    if (/workers\.dev/i.test(text)) fail("the deploy printed a workers.dev address (it would sit outside Access)", "turn it off in the dashboard before anything else");
    if (!text.includes(HOST)) fail("the deploy output does not name the custom domain");
    ok(`deployed; Cloudflare reports ${HOST} as the address and no workers.dev`);
  } finally {
    const o = node([wranglerJs, "logout"]);
    say("logout: " + ((o.stdout || "") + (o.stderr || "")).replace(/\s+/g, " ").trim().slice(0, 200));
    const left = loginFiles();
    if (left.length) {
      say("STOP  a login file is left after the logout; it may still work. The owner revokes it, once no other deploy is running, at:");
      say("      https://dash.cloudflare.com/?to=/profile/access-management/authorization");
      process.exitCode = 3;
    } else if (loggedIn || deployed) ok("logged out; no login file in any place Wrangler keeps one");
  }
  if (deployed) await liveChecks();
}

// ---------- main ----------

const [, , cmd, commit, ...rest] = process.argv;
const reportFlag = rest.indexOf("--report");
const reportPath = reportFlag >= 0 ? rest[reportFlag + 1] : null;

try {
  if (reportPath && path.resolve(reportPath).startsWith(ROOT + path.sep)) fail("the report file must be outside this repository");
  if (cmd === "preflight") {
    preflight(commit, ["node_modules/"], false);
    say("PREFLIGHT OK: nothing was built, nothing deployed.");
  } else if (cmd === "build" || cmd === "rehearse") {
    preflight(commit, ["node_modules/"]);
    build();
    say(cmd === "rehearse" ? "REHEARSAL OK: built and dry-run only; not logged in, nothing deployed." : "BUILD OK: nothing deployed.");
  } else if (cmd === "ship") {
    await ship(commit);
    if (!process.exitCode) say("SHIP OK: deployed, logged out, and the address ends at the Access sign-in.");
  } else {
    console.error("usage: node scripts/deploy.mjs <preflight|build|ship|rehearse> <40-char commit> [--report <file>]");
    process.exitCode = 2;
  }
} catch (e) {
  if (!e.stop) say("STOP  unexpected error: " + (e.message || e));
  process.exitCode = process.exitCode || 1;
} finally {
  if (reportPath) {
    mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    writeFileSync(reportPath, `# brolga ${cmd} ${commit}\n\n` + report.join("\n") + "\n");
  }
}
