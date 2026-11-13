// Where Brolga's three state files are read and written: the loans (db.ts), the
// mock provider's state (zepto/mock.ts) and the investigator's cases, briefings and
// marks (investigator/store.ts), plus the model key's fallback file (model.ts).
//
// On a machine this is the file system, exactly as before: the same files, written
// as a temporary file and renamed into place. In the hosted build (src/hosted/) a
// Worker has no disk, so the hosted entry installs a provider that serves the same
// calls from an in-memory copy of the stored files for the length of one request:
// loaded under a lock at the start, saved at the end. The code that moves money and
// the code that writes briefings never knows which one it is talking to.

import fs from "node:fs";
import path from "node:path";

export interface Files {
  exists(file: string): boolean;
  read(file: string): string;
  /** Write the whole file; where there is a disk, via a temporary file and a rename. */
  writeAtomic(file: string, text: string): void;
  remove(file: string): void;
  copy(from: string, to: string): void;
}

// Windows refuses a rename over a file that something (an antivirus scan, the search
// indexer, another reader) has open for a moment: EPERM, EACCES or EBUSY. The refusal
// passes within a few milliseconds, so the rename is tried again, a little later each time,
// for about a second, and only then is the error let through. Other errors are never retried.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt >= 14 || !code || !TRANSIENT.has(code)) throw err;
      pause(5 + attempt * 10);
    }
  }
}

const diskFiles: Files = {
  exists: (file) => fs.existsSync(file),
  read: (file) => fs.readFileSync(file, "utf8"),
  writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A temporary name of this process's own, so two writers (the cases script and the
    // server, say) never share one and the rename is the only visible step.
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      renameOver(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
  remove: (file) => fs.rmSync(file, { force: true }),
  copy: (from, to) => fs.copyFileSync(from, to),
};

type Host = {
  /** The files for the request being served; throws outside one. */
  files?: () => Files;
  /** Run fn with the state loaded under the lock (re-entrant). */
  inStore?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  /** Functions that forget what a module remembered in memory. */
  resets?: (() => void)[];
};
const g = globalThis as unknown as { __brolgaHost?: Host };
const host = (): Host => (g.__brolgaHost ??= {});

/** The file system, or the hosted build's per-request copy of it. */
export function files(): Files {
  return host().files?.() ?? diskFiles;
}

/** True in the hosted build (a Worker with no disk, mock provider only). */
export function isHosted(): boolean {
  return process.env.BROLGA_HOSTED === "1";
}

/**
 * Run fn with the stored state loaded and locked, saving what it changed at the end.
 * A no-op on a machine, where the files are the state. Routes that do something slow
 * between two visits to the store (the model call) use it once per visit.
 */
export function inStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const h = host().inStore;
  return h ? h(fn) : Promise.resolve().then(fn);
}

/** A module that keeps state in memory registers how to drop it; a hosted request starts from the stored copy. */
export function registerReset(fn: () => void): void {
  const h = host();
  (h.resets ??= []).push(fn);
}

export function resetMemory(): void {
  for (const fn of host().resets ?? []) fn();
}

/** Used by the hosted entry only. */
export function installHost(next: Pick<Host, "files" | "inStore">): void {
  Object.assign(host(), next);
}
