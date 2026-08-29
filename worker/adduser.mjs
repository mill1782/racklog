/* Add a family member, change their PIN, or put them on the Google allowlist.
 *
 *   node worker/adduser.mjs "Mark" 481920
 *   node worker/adduser.mjs "Mark" 481920 --email mark@gmail.com
 *   node worker/adduser.mjs "Nate"        --email nate@gmail.com   (Google only)
 *   ... add --run to apply it via wrangler
 *
 * Prints the SQL and, with --run, executes it against the remote D1. Nobody
 * self-registers: this is the only way an account exists, and with Google
 * sign-in that matters more, not less — anyone on earth has a Google account,
 * so this table IS the allowlist.
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

/* walk the args rather than filtering them: --email's value does not start
   with "--", so any filter-based split mistakes it for the positional PIN */
const argv = process.argv.slice(2);
const words = [];
let email = "", hasEmail = false, run = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--run") { run = true; continue; }
  if (a === "--email") { hasEmail = true; email = String(argv[++i] || "").trim().toLowerCase(); continue; }
  if (a.startsWith("--")) { console.error(`unknown flag ${a}`); process.exit(1); }
  words.push(a);
}
const rawName = words[0];
const rawPin = words[1] || "";
if (words.length > 2) { console.error(`unexpected argument "${words[2]}"`); process.exit(1); }

const usage = 'usage: node worker/adduser.mjs "<name>" [pin] [--email <addr>] [--run]';
if (!rawName) { console.error(usage); process.exit(1); }
if (!rawPin && !email) {
  console.error("Give a PIN, an --email, or both — otherwise there is no way in.");
  console.error(usage);
  process.exit(1);
}
if (rawPin && !/^\d{6,12}$/.test(rawPin)) {
  console.error("PIN must be 6-12 digits. Four is too few for a public URL.");
  process.exit(1);
}
if (hasEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("--email needs a real address; it is matched against the one Google reports.");
  process.exit(1);
}

const display = rawName.trim();
const name = display.toLowerCase();
const initials = display.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));

let pinHash;
if (rawPin) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(rawPin), "PBKDF2", false, ["deriveBits"]);
  pinHash = hex(new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256)));
} else {
  /* Google-only account. pin_hash is NOT NULL in the schema and dropping that
     would mean rebuilding the table, so store random bytes instead: no PIN can
     derive to them, which is precisely the intent — this account has no PIN. */
  pinHash = hex(crypto.getRandomValues(new Uint8Array(32)));
}

const q = (s) => (s === null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'");
const sql =
  "INSERT INTO users (id, name, display, initials, pin_hash, pin_salt, email, google_sub, fails, locked_until, created) VALUES (" +
  [q(hex(crypto.getRandomValues(new Uint8Array(8)))), q(name), q(display), q(initials),
   q(pinHash), q(hex(salt)), email ? q(email) : "NULL", "NULL", 0, 0, Date.now()].join(", ") +
  ") ON CONFLICT(name) DO UPDATE SET display = excluded.display, initials = excluded.initials, " +
  "pin_hash = excluded.pin_hash, pin_salt = excluded.pin_salt, " +
  /* COALESCE so re-running without --email does not silently unlink someone's
     Google account. google_sub is never touched here: it is bound on first
     sign-in and clobbering it would lock the person out. */
  "email = COALESCE(excluded.email, users.email), fails = 0, locked_until = 0;";

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
    const how = [rawPin ? `PIN as "${name}"` : null, email ? `Google as ${email}` : null]
      .filter(Boolean).join(", or ");
    console.log(`\n${display} can now sign in with ${how}.`);
  } finally {
    try { unlinkSync(f); } catch (e) {}
  }
} else {
  console.log("\nRe-run with --run to apply it.");
}
