/* Add a family member, or change their PIN.
 *
 *   node worker/adduser.mjs "Mark" 481920
 *   node worker/adduser.mjs "Mark" 481920 --run     (applies it via wrangler)
 *
 * Prints the SQL and, with --run, executes it against the remote D1. Nobody
 * self-registers: this is the only way an account exists.
 *
 * The PBKDF2 parameters here MUST match worker/index.js. Change one, change
 * both, and re-run this for every user.
 */
import { webcrypto as crypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PBKDF2_ITER = 5000;

const [, , rawName, rawPin, ...flags] = process.argv;
const run = flags.includes("--run");

if (!rawName || !rawPin) {
  console.error('usage: node worker/adduser.mjs "<name>" <pin> [--run]');
  process.exit(1);
}
if (!/^\d{6,12}$/.test(rawPin)) {
  console.error("PIN must be 6-12 digits. Four is too few for a public URL.");
  process.exit(1);
}

const display = rawName.trim();
const name = display.toLowerCase();
const initials = display.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(rawPin), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sql =
  "INSERT INTO users (id, name, display, initials, pin_hash, pin_salt, fails, locked_until, created) VALUES (" +
  [q(hex(crypto.getRandomValues(new Uint8Array(8)))), q(name), q(display), q(initials),
   q(hex(new Uint8Array(bits))), q(hex(salt)), 0, 0, Date.now()].join(", ") +
  ") ON CONFLICT(name) DO UPDATE SET display = excluded.display, initials = excluded.initials, " +
  "pin_hash = excluded.pin_hash, pin_salt = excluded.pin_salt, fails = 0, locked_until = 0;";

/* the PIN itself is never printed or logged — only its hash */
console.log(sql);

if (run) {
  console.log("\napplying to the remote database…");
  /* via a file, not --command: with shell:true on Windows an inline SQL string
     is word-split, and wrangler sees thirty arguments instead of one */
  const f = join(mkdtempSync(join(tmpdir(), "racklog-")), "user.sql");
  writeFileSync(f, sql + "\n", "utf8");
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", "racklog", "--remote", "--file", f],
      { stdio: "inherit", shell: process.platform === "win32" });
    console.log(`\n${display} can now sign in as "${name}".`);
  } finally {
    try { unlinkSync(f); } catch (e) {}
  }
} else {
  console.log("\nRe-run with --run to apply it, or paste it into:");
  console.log('  npx wrangler d1 execute racklog --remote --command "<the SQL above>"');
}
