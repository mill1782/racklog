/* Rack Log — Cloudflare Worker: the API, and the page itself.
 *
 * rack-log.html stays artifact-shaped (no doctype, no <head>, no <body>) so it
 * can still be published as a Claude Artifact and opened from file://. This
 * worker wraps it in a real document at serve time and injects the PWA head
 * tags — that is why those tags are not in the source file.
 *
 * Everything ships in the worker bundle via module rules in wrangler.toml
 * (Text for the HTML, Data for the icons), so there is no assets directory and
 * still no build step.
 */
import APP_HTML from "../rack-log.html";
import ICON192 from "./icon-192.png";
import ICON512 from "./icon-512.png";
import SPLASH from "./splash.jpg";

const COOKIE = "rl";
/* 48 hours, Mark's call. Long enough to survive a family text going unread
   overnight, short enough that a code screenshotted into a group chat stops
   being a way in by the weekend. */
const INVITE_MS = 48 * 60 * 60 * 1000;
const MAX_PENDING = 10;          /* unredeemed, unexpired invites at once */
const INVITE_COOKIE = "rlinvite";
const SESSION_MS = 90 * 86400 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_BODY = 256 * 1024;

/* Usernames are what you type to sign in and what search matches on, so they
   are narrow on purpose: lowercase, and nothing that has to be escaped or
   percent-encoded to sit in a URL or a LIKE pattern. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._]{2,19}$/;
/* 8, where the PIN door wanted 6 digits. A password is only worth the change
   from a PIN if it is allowed to be longer than one. */
const MIN_PASS = 8;
const MAX_PASS = 200;

/* Google sign-in. The state nonce lives in its own short cookie scoped to
   /api/auth/ so it never rides along with anything else. */
const OAUTH_STATE = "rlstate";
const OAUTH_STATE_S = 600;
/* the nonce is single-use: the callback burns it whichever way it ends */
const CLEAR_STATE = `${OAUTH_STATE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=0`;
const CLEAR_INVITE = `${INVITE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=0`;

/* Why this number is low, deliberately.
 *
 * Workers meter CPU per request and the free plan allows ~10ms. Measured cost
 * of PBKDF2-SHA256 on this hardware:
 *
 *     5,000 iter ->  3.1ms      50,000 iter -> 21.9ms
 *    20,000 iter ->  9.4ms     100,000 iter -> 43.7ms
 *
 * Anything at or above 20k risks blowing the budget on Cloudflare hardware,
 * and the failure mode is not "slow login", it is "login does not work".
 * 5,000 leaves roughly 3x headroom.
 *
 * This mattered more when the secret was a 6-digit PIN: 10^6 is a space no
 * iteration count saves once the database leaks. Passwords (8+ characters,
 * since 2026-08-29) are a real improvement here, and the 5-try lockout below
 * is still what stops online guessing. Hashing is here so a leak does not hand
 * over passwords to reuse elsewhere -- which now matters more, because people
 * reuse passwords in a way nobody reuses a gym PIN.
 *
 * On Workers Paid (30s CPU) raise this to 100,000 — and re-run adduser.mjs for
 * every user, with the same constant changed there, or nobody can sign in. */
const PBKDF2_ITER = 5000;

const HEAD = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="theme-color" content="#16181D">',
  '<meta name="description" content="Rack Log — a workout tracker for the gym floor.">',
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="icon" href="/icon-192.png">',
  '<link rel="apple-touch-icon" href="/icon-192.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Rack Log">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
].join("");

/* built once at module scope, not per request */
const PAGE = '<!doctype html><html lang="en">' +
  APP_HTML.replace("<title>Rack Log</title>", "<title>Rack Log</title>" + HEAD) +
  "</html>";

const MANIFEST = JSON.stringify({
  name: "Rack Log",
  short_name: "Rack Log",
  description: "A workout tracker for the gym floor.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#16181D",
  theme_color: "#16181D",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
  ]
});

/* ---------- helpers ---------- */
const enc = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
async function derive(secret, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return hex(new Uint8Array(bits));
}
/* length-independent compare, so a wrong hash cannot be narrowed by timing */
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function publicUser(u) {
  /* `id` is the opaque row id, not a secret; the page needs it to tell its own
     feed items apart from the crew's and to key its likes. `username` is what
     other people search for, which is why it is sent back to its owner: it is
     the one thing about an account that has to be shareable out loud. */
  return { id: u.id, name: u.display, initials: u.initials, username: u.name };
}

/* One place decides what a sign-up is allowed to look like, because the same
   three fields arrive from the front door, the join door, and adduser.mjs. */
function credentialError(username, password, display) {
  if (!display) return "Enter the name you want on your workouts.";
  if (display.length > 40) return "That display name is too long.";
  if (!USERNAME_RE.test(username))
    return "Usernames are 3 to 20 characters: letters, numbers, dots and underscores.";
  if (password.length < MIN_PASS) return "Passwords need at least " + MIN_PASS + " characters.";
  if (password.length > MAX_PASS) return "That password is too long.";
  return null;
}

async function readJSON(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  try { return await req.json(); } catch (e) { return null; }
}

/* ---------- auth ---------- */
async function currentUser(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)rl=([A-Fa-f0-9]{64})(?:;|$)/);
  if (!m) return null;
  const tok = await sha256(m[1]);
  const row = await env.DB.prepare(
    "SELECT u.*, t.expires FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?"
  ).bind(tok).first();
  if (!row) return null;
  if (row.expires < Date.now()) {
    await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(tok).run();
    return null;
  }
  row.tok = tok;
  return row;
}

/* Mint a session and the cookie carrying it. Both doors end here: whatever
   proved who you are, everything downstream only ever sees this cookie. */
async function mintCookie(env, u) {
  const now = Date.now();
  const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO tokens (token, user_id, expires) VALUES (?, ?, ?)")
    .bind(await sha256(raw), u.id, now + SESSION_MS).run();
  /* opportunistic cleanup; tokens are tiny but they should not pile up forever */
  await env.DB.prepare("DELETE FROM tokens WHERE user_id = ? AND expires < ?").bind(u.id, now).run();
  return `${COOKIE}=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
}

async function login(req, env) {
  const b = await readJSON(req);
  /* `name`/`pin` were the field names until 2026-08-29 and are still accepted,
     because a phone with the old page cached would otherwise fail to sign in
     with a message about a field it does not have. */
  const username = String((b && (b.username !== undefined ? b.username : b.name)) || "")
    .trim().toLowerCase();
  const password = String((b && (b.password !== undefined ? b.password : b.pin)) || "");
  if (!username || !password) return json({ error: "Enter your username and password." }, 400);

  const u = await env.DB.prepare("SELECT * FROM users WHERE name = ?").bind(username).first();
  const now = Date.now();

  /* derive even when the username is unknown, so response time does not reveal
     which accounts exist -- open signup makes that a public question, and
     "is this name taken" is answered honestly at signup anyway, but a timing
     side channel on the LOGIN door would also leak which ones have passwords */
  if (!u) {
    await derive(password, "00000000000000000000000000000000");
    return json({ error: "Wrong username or password." }, 401);
  }
  if (u.locked_until > now) {
    return json({ error: "Too many tries. Try again in 15 minutes." }, 429);
  }

  const h = await derive(password, u.pass_salt);
  if (!same(h, u.pass_hash)) {
    const fails = (u.fails || 0) + 1;
    const locked = fails >= MAX_FAILS;
    await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?")
      .bind(locked ? 0 : fails, locked ? now + LOCK_MS : 0, u.id).run();
    return json({ error: locked ? "Too many tries. Locked for 15 minutes."
                                : "Wrong username or password." },
      locked ? 429 : 401);
  }

  await env.DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?").bind(u.id).run();

  return json({ user: publicUser(u) }, 200, { "set-cookie": await mintCookie(env, u) });
}

/* Open signup, from 2026-08-29, Mark's call alongside the follow graph. Until
   then an account existed only because somebody ran adduser.mjs or spent an
   invite, and the users table WAS the allowlist.
   What replaces it: nothing you log is visible to anybody until you mark a
   session Shared, and a shared session only reaches people who follow you. An
   account on its own buys an empty feed. */
async function signup(req, env) {
  const b = await readJSON(req);
  const username = String((b && b.username) || "").trim().toLowerCase();
  const password = String((b && b.password) || "");
  const display = String((b && b.name) || "").trim().replace(/\s+/g, " ");
  const code = String((b && b.code) || "");

  const bad = credentialError(username, password, display);
  if (bad) return json({ error: bad }, 400);

  const taken = await env.DB.prepare("SELECT id FROM users WHERE name = ?").bind(username).first();
  if (taken) return json({ error: "That username is taken." }, 409);

  /* An invite is optional now: it is no longer the door, it is the handshake.
     Spend it BEFORE making the account, so a dead code does not leave a user
     row behind, and connect the two people once the account exists. */
  let inv = null;
  if (code) {
    const r = await redeem(env, code);
    if (r.err) return r.err;
    inv = r.row;
  }

  const u = await makeUser(env, { display, name: username, pass: password });
  if (inv) {
    if (!await claim(env, inv.id, u.id)) {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
      return json({ error: "That invite has already been used." }, 410);
    }
    await connect(env, u.id, inv.created_by);
  }
  return json({ user: publicUser(u), followed: inv ? 1 : 0 }, 200,
    { "set-cookie": await mintCookie(env, u) });
}

/* Changing a password proves the old one first. Every other session stays
   alive on purpose: the family shares devices, and signing everybody's phone
   out because somebody picked a longer password would be a surprise. */
async function changePassword(req, env, user) {
  const b = await readJSON(req);
  const current = String((b && b.current) || "");
  const next = String((b && b.next) || "");
  if (next.length < MIN_PASS) return json({ error: "Passwords need at least " + MIN_PASS + " characters." }, 400);
  if (next.length > MAX_PASS) return json({ error: "That password is too long." }, 400);

  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  if (!same(await derive(current, u.pass_salt), u.pass_hash))
    return json({ error: "That is not your current password." }, 401);

  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?")
    .bind(await derive(next, salt), salt, u.id).run();
  return json({ ok: true });
}

/* ---------- google sign-in ---------- */

/* Everything below degrades to "not configured" when the two vars are absent,
   so a checkout without Google credentials still deploys and PIN login still
   works. That is the whole reason this is a second door and not a replacement. */
function googleOn(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
function redirectURI(url) {
  return url.origin + "/api/auth/google/callback";
}

/* A failed sign-in arrives as a top-level navigation, so it needs a page, not
   JSON. Deliberately plain: it is a setup-time surface, not a product one. */
function oauthFail(text) {
  const body = '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Rack Log</title>' +
    '<div style="font:16px system-ui;max-width:32em;margin:18vh auto;padding:0 24px;text-align:center">' +
    "<p>" + text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</p>" +
    '<p><a href="/">Back to Rack Log</a></p></div>';
  return new Response(body, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

/* 302 home, carrying whatever cookies the caller wants set. A plain object
   cannot hold two set-cookie headers, hence the Headers and the append. */
function homeRedirect(cookies) {
  const h = new Headers({ location: "/", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function b64urlJSON(seg) {
  const t = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = t + "===".slice((t.length + 3) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function googleStart(req, env, url) {
  if (!googleOn(env)) return oauthFail("Google sign-in is not set up on this server.");
  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  /* An invite has to survive the round trip to Google, and it cannot ride in
     the redirect URI (Google only returns the one registered) or in `state`
     (which is compared against the cookie). So it gets its own short-lived
     cookie, scoped to /api/auth/ like the nonce, and is only READ on the way
     back -- validity is decided then, not now. */
  const inv = url.searchParams.get("invite") || "";
  const cookies = [
    `${OAUTH_STATE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=${OAUTH_STATE_S}`
  ];
  cookies.push(/^[a-f0-9]{32}$/.test(inv)
    ? `${INVITE_COOKIE}=${inv}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=${OAUTH_STATE_S}`
    : CLEAR_INVITE);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectURI(url),
    response_type: "code",
    scope: "openid email profile",
    state,
    /* the family shares devices; without this Google silently reuses whoever
       signed in last and there is no way to switch */
    prompt: "select_account"
  });
  /* SameSite=Lax, NOT Strict. Strict withholds these on the top-level redirect
     back from Google, so every sign-in would fail the state check with nothing
     in the logs to explain it. Lax sends them on that navigation, which is
     exactly and only what is needed. */
  const h = new Headers({
    location: "https://accounts.google.com/o/oauth2/v2/auth?" + q,
    "cache-control": "no-store"
  });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

async function googleCallback(req, env, url) {
  if (!googleOn(env)) return oauthFail("Google sign-in is not set up on this server.");
  if (url.searchParams.get("error")) return oauthFail("That sign-in was cancelled.");

  /* A REPLAY of this URL always fails, and that is not a malfunction: both the
     authorization code and the state nonce are single-use, so a refresh, a
     back-navigation, or a browser prefetching the redirect target hits a
     callback whose code Google has already spent (`invalid_grant`). The first
     hit had already minted the cookie.
     Telling somebody who is demonstrably signed in -- their session cookie is
     on the very request -- that Google would not confirm them is the worst
     available answer, and it is what shipped on 2026-08-29. So every failure
     a replay can reach checks for a live session first and quietly goes home.
     Only these two: a cancelled sign-in and an account that is not on the
     list are real answers that must still be shown. */
  const replay = async (text) =>
    (await currentUser(req, env)) ? homeRedirect([CLEAR_STATE, CLEAR_INVITE]) : oauthFail(text);

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)rlstate=([A-Fa-f0-9]{32})(?:;|$)/);
  if (!code || !state || !m || !same(m[1], state))
    return replay("That sign-in expired or was tampered with. Try again.");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectURI(url),
      grant_type: "authorization_code"
    })
  });
  if (!r.ok) {
    console.error("google token exchange", r.status, await r.text());
    return replay("Google would not confirm that sign-in.");
  }
  const tok = await r.json();

  /* The ID token arrived straight from Google over TLS, in exchange for a
     secret only this worker holds, so its signature does not need verifying —
     Google's OpenID docs say so for exactly this server-side flow, and it
     saves fetching and caching JWKS to do RS256 in a Worker.
     Do NOT copy this shortcut anywhere a token arrives from a browser. */
  const parts = String(tok.id_token || "").split(".");
  let c = null;
  if (parts.length === 3) { try { c = b64urlJSON(parts[1]); } catch (e) { c = null; } }
  if (!c) return oauthFail("Google sent something this app could not read.");
  if (c.aud !== env.GOOGLE_CLIENT_ID) return oauthFail("That sign-in was issued for a different app.");

  const sub = String(c.sub || "");
  const email = String(c.email || "").toLowerCase();
  if (!sub || !email || c.email_verified === false)
    return oauthFail("That Google account has no verified email address.");

  /* Match on `sub`, never on email: an address can be renamed or change hands,
     a Google `sub` never does. Email is only the bootstrap, because there is
     no way to know someone's sub before their first sign-in. */
  let u = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first();
  if (!u) {
    u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (!u) {
      /* No account matches, so this makes one. Until 2026-08-29 that needed a
         valid invite, because the users table was the allowlist; signup is
         open now, and a new account starts with an empty feed and nobody
         following it, which is what makes that safe.
         An invite cookie is no longer a requirement, only a handshake: if one
         rode along and is still good, it connects the two people. A dead one
         is ignored rather than refused -- the account is fine either way, and
         failing a sign-in over a stale link would be the worse answer. */
      const display = String(c.name || email.split("@")[0]).trim().slice(0, 40) || "Member";
      u = await makeUser(env, { display, name: await freeName(env, display), email, sub });
      const im = (req.headers.get("Cookie") || "")
        .match(/(?:^|;\s*)rlinvite=([a-f0-9]{32})(?:;|$)/);
      if (im) {
        const r = await redeem(env, im[1]);
        if (!r.err && await claim(env, r.row.id, u.id)) await connect(env, u.id, r.row.created_by);
      }
      return homeRedirect([await mintCookie(env, u), CLEAR_STATE, CLEAR_INVITE]);
    }
    /* the allowlist IS the account table: an email put there by adduser.mjs
       binds to a Google `sub` on the first sign-in */
    await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(sub, u.id).run();
  }

  /* the state cookie goes out with the same response that spends it, so a
     replay fails the check above rather than reaching Google a second time */
  return homeRedirect([await mintCookie(env, u), CLEAR_STATE, CLEAR_INVITE]);
}

/* ---------- invites ----------
   An invite used to be the only way to self-register. Since signup opened on
   2026-08-29 it is a handshake instead: a link that says "follow me back",
   good for one account or one already-signed-in person, and it connects
   whoever takes it to whoever sent it in both directions.
   Everything below still exists to keep "exactly one" true: the code is
   single-use, expiring, revocable, and redeemed through a single funnel
   (`redeem`) that every door calls.

   What an invite buys is now bounded, which it was not before: it makes you
   and one other person follow each other. Unfollowing undoes it. That is the
   whole of it -- it is not an account permission any more, because an account
   needs no permission. */

function inviteLink(url, code) { return url.origin + "/join/" + code; }

/* what the profile screen may see: never the code, which is gone the moment
   it is shown once at creation */
function publicInvite(r, now) {
  const state = r.used ? "used"
    : r.revoked ? "revoked"
    : r.expires < now ? "expired"
    : "pending";
  return { id: r.id, state, created: r.created, expires: r.expires,
           usedBy: r.used_by || null };
}

/* Your invites, not everybody's. This was a list of every code on the server
   back when every account was one Mark had made by hand; open signup turned it
   into a stranger's view of who you invited and who took it. */
async function invitesList(env, user, url) {
  const now = Date.now();
  const rs = await env.DB.prepare(
    "SELECT i.*, u.display AS used_display FROM invites i " +
    "LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by = ? " +
    "ORDER BY i.created DESC LIMIT 50"
  ).bind(user.id).all();
  const invites = (rs.results || []).map((r) => {
    const v = publicInvite(r, now);
    v.usedBy = r.used_display || null;
    return v;
  });
  return json({ now, invites });
}

async function inviteCreate(env, user, url) {
  const now = Date.now();
  /* housekeeping first, so a pile of expired codes cannot block a real one */
  await env.DB.prepare(
    "DELETE FROM invites WHERE used_by IS NULL AND expires < ?"
  ).bind(now - INVITE_MS).run();

  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invites " +
    "WHERE created_by = ? AND used_by IS NULL AND revoked = 0 AND expires > ?"
  ).bind(user.id, now).first();
  if (open && open.n >= MAX_PENDING)
    return json({ error: "There are already " + MAX_PENDING + " invites waiting. " +
                         "Revoke one before making another." }, 429);

  const code = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = hex(crypto.getRandomValues(new Uint8Array(6)));
  const expires = now + INVITE_MS;
  await env.DB.prepare(
    "INSERT INTO invites (id, code_hash, created_by, created, expires) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, await sha256(code), user.id, now, expires).run();

  /* the only time the code is ever returned. It is not stored in the clear,
     so losing this link means making another one. */
  return json({ id, code, url: inviteLink(url, code), expires, state: "pending" });
}

async function inviteRevoke(env, user, id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return json({ error: "Bad invite." }, 400);
  const r = await env.DB.prepare(
    "UPDATE invites SET revoked = 1 WHERE id = ? AND created_by = ? AND used_by IS NULL"
  ).bind(id, user.id).run();
  const changed = r && r.meta ? r.meta.changes : 0;
  if (!changed) return json({ error: "That invite is already used or gone." }, 404);
  return json({ ok: true, id });
}

/* Look a code up without spending it -- the join screen calls this so it can
   say "expired" before asking somebody to pick a PIN. */
async function inviteCheck(env, code) {
  if (!/^[a-f0-9]{32}$/.test(code)) return json({ error: "That invite link is not valid." }, 404);
  const row = await env.DB.prepare(
    "SELECT i.*, u.display AS from_display FROM invites i " +
    "LEFT JOIN users u ON u.id = i.created_by WHERE i.code_hash = ?"
  ).bind(await sha256(code)).first();
  if (!row) return json({ error: "That invite link is not valid." }, 404);
  if (row.used_by) return json({ error: "That invite has already been used." }, 410);
  if (row.revoked) return json({ error: "That invite was cancelled." }, 410);
  if (row.expires < Date.now())
    return json({ error: "That invite has expired. Ask for a new link." }, 410);
  return json({ ok: true, from: row.from_display || null, expires: row.expires });
}

/* The single funnel. Returns the invite row or an error Response; both doors
   call it, so "single-use" is enforced in exactly one place. */
async function redeem(env, code) {
  if (!/^[a-f0-9]{32}$/.test(code)) return { err: json({ error: "That invite link is not valid." }, 404) };
  const row = await env.DB.prepare("SELECT * FROM invites WHERE code_hash = ?")
    .bind(await sha256(code)).first();
  if (!row) return { err: json({ error: "That invite link is not valid." }, 404) };
  if (row.used_by) return { err: json({ error: "That invite has already been used." }, 410) };
  if (row.revoked) return { err: json({ error: "That invite was cancelled." }, 410) };
  if (row.expires < Date.now())
    return { err: json({ error: "That invite has expired. Ask for a new link." }, 410) };
  return { row };
}

/* Claiming the invite is a conditional UPDATE, not a read-then-write: two
   people opening the same link at the same moment must not both get in.
   `used_by IS NULL` in the WHERE is what makes the second one lose. */
async function claim(env, id, userId) {
  const r = await env.DB.prepare(
    "UPDATE invites SET used_by = ?, used = ? WHERE id = ? AND used_by IS NULL AND revoked = 0"
  ).bind(userId, Date.now(), id).run();
  return !!(r && r.meta && r.meta.changes);
}

function initialsOf(display) {
  return display.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/* `users.name` is UNIQUE and it is what you type at the sign-in door, so a
   second Nate cannot simply be nate. Only Google gets here now -- everybody
   else picks their own username and is told when it is taken -- so the base
   has to be squeezed into USERNAME_RE first, from whatever Google reports. */
async function freeName(env, base) {
  let want = base.toLowerCase().replace(/[^a-z0-9._]/g, "");
  if (want.length < 3) want = "member" + want;
  want = want.slice(0, 16);
  for (let i = 0; i < 50; i++) {
    const n = i ? want + (i + 1) : want;
    const hit = await env.DB.prepare("SELECT id FROM users WHERE name = ?").bind(n).first();
    if (!hit) return n;
  }
  return want + "-" + hex(crypto.getRandomValues(new Uint8Array(3)));
}

async function makeUser(env, { display, name, pass, email, sub }) {
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  /* Every account needs a pass_hash because the column is NOT NULL. Someone
     who signed up with Google gets a random one nobody knows, which is not a
     way in: it is 32 bytes of entropy, and nothing derives to it. */
  const secret = pass || hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    "INSERT INTO users (id, name, display, initials, pass_hash, pass_salt, email, google_sub, created) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, name, display, initialsOf(display), await derive(secret, salt), salt,
         email || null, sub || null, Date.now()).run();
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

/* Both directions, in one statement pair. An invite means "join my crew",
   which is a mutual thing -- following one way and being ignored back is not
   what the person tapping the link is agreeing to. */
async function connect(env, a, b) {
  if (!a || !b || a === b) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO follows (follower, followee, created) VALUES (?, ?, ?)")
      .bind(a, b, now),
    env.DB.prepare("INSERT OR IGNORE INTO follows (follower, followee, created) VALUES (?, ?, ?)")
      .bind(b, a, now)
  ]);
}

/* Somebody who already has an account, opening an invite link. There is no
   account to make, so this is only the handshake -- and it still spends the
   code, because a link that keeps working after it has been used is not the
   thing that was handed out. */
async function inviteAccept(env, user, code) {
  const r = await redeem(env, code);
  if (r.err) return r.err;
  if (r.row.created_by === user.id)
    return json({ error: "That is your own invite link." }, 400);
  if (!await claim(env, r.row.id, user.id))
    return json({ error: "That invite has already been used." }, 410);
  await connect(env, user.id, r.row.created_by);
  return json({ ok: true, followed: r.row.created_by });
}

/* ---------- the follow graph ---------- */

/* Finding somebody. Matches the username and the display name, because people
   know each other by both, and says whether you already follow them so the
   button can read Following without a second round trip. */
async function userSearch(env, user, url) {
  /* LIKE has its own wildcards; a search for "100%" must not match everyone */
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 40)
    .replace(/[%_\\]/g, (c) => "\\" + c);
  const like = "%" + q + "%";
  const rs = await env.DB.prepare(
    "SELECT u.id, u.name, u.display, u.initials, " +
    "  (SELECT 1 FROM follows f WHERE f.follower = ? AND f.followee = u.id) AS following " +
    "FROM users u WHERE u.name LIKE ? ESCAPE '\\' OR lower(u.display) LIKE ? ESCAPE '\\' " +
    "ORDER BY (u.name = ?) DESC, u.display LIMIT 20"
  ).bind(user.id, like, like, q).all();

  return json({ people: (rs.results || []).map((r) => ({
    id: r.id, username: r.name, name: r.display, initials: r.initials,
    following: !!r.following, mine: r.id === user.id
  })) });
}

/* Following is instant -- no request, no approval. `on:false` is the same
   route, because unfollowing is the same tap on the same button. */
async function followWrite(req, env, user) {
  const b = await readJSON(req);
  const id = String((b && b.id) || "");
  const on = !!(b && b.on);
  if (!id || id.length > 64) return json({ error: "Bad id." }, 400);
  if (id === user.id) return json({ error: "You already see your own workouts." }, 400);

  const them = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!them) return json({ error: "No such person." }, 404);

  if (on)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO follows (follower, followee, created) VALUES (?, ?, ?)"
    ).bind(user.id, id, Date.now()).run();
  else
    await env.DB.prepare("DELETE FROM follows WHERE follower = ? AND followee = ?")
      .bind(user.id, id).run();

  return json({ id, following: on });
}

/* ---------- sync ---------- */
async function pull(env, user, url) {
  const since = Number(url.searchParams.get("since") || 0) || 0;
  const rs = await env.DB.prepare(
    "SELECT id, date, split, ex, shared, from_json, updated, deleted FROM sessions " +
    "WHERE user_id = ? AND updated > ? ORDER BY updated"
  ).bind(user.id, since).all();

  const sessions = (rs.results || []).map((r) => {
    if (r.deleted) return { id: r.id, deleted: 1, updated: r.updated };
    const s = { id: r.id, date: r.date, split: r.split, ex: JSON.parse(r.ex), updated: r.updated };
    if (r.shared) s.shared = true;
    if (r.from_json) s.from = JSON.parse(r.from_json);
    return s;
  });
  return json({ now: Date.now(), sessions });
}

async function push(req, env, user, id) {
  const s = await readJSON(req);
  if (!s || typeof s.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !Array.isArray(s.ex))
    return json({ error: "Bad session." }, 400);

  const ex = JSON.stringify(s.ex);
  if (ex.length > MAX_BODY) return json({ error: "Session too large." }, 413);

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (user_id, id, date, split, ex, shared, from_json, updated, deleted) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) " +
    "ON CONFLICT(user_id, id) DO UPDATE SET date = excluded.date, split = excluded.split, " +
    "ex = excluded.ex, shared = excluded.shared, from_json = excluded.from_json, " +
    "updated = excluded.updated, deleted = 0"
  ).bind(user.id, id, s.date, String(s.split || "other"), ex,
    s.shared ? 1 : 0, s.from ? JSON.stringify(s.from) : null, now).run();

  return json({ id, updated: now });
}

/* tombstone, never a real delete — see schema.sql */
/* ---------- the crew feed ----------
   The first query in the app that is NOT scoped to a single user_id — a feed
   that cannot cross users is not a feed. Two things keep it honest, and both
   are needed: `shared` is opt-in per session, so nothing lands here that its
   owner did not deliberately post, and since 2026-08-29 the rows are limited
   to people you FOLLOW. Before that it was every shared session on the server,
   which was defensible only while the server was one household.

   `SELECT followee FROM follows WHERE follower = ?` appears three times below
   rather than once in a temp table: D1 is SQLite and the follow table is tiny,
   and one subquery per statement is cheaper to read than a join that has to be
   correct in three places at once. */
const VISIBLE = "(s.user_id = ? OR s.user_id IN (SELECT followee FROM follows WHERE follower = ?))";

async function feed(env, user) {
  const rs = await env.DB.prepare(
    "SELECT s.user_id, s.id, s.date, s.split, s.ex, s.from_json, u.display, u.initials " +
    "FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.shared = 1 AND s.deleted = 0 AND " + VISIBLE + " " +
    "ORDER BY s.date DESC, s.updated DESC LIMIT 200"
  ).bind(user.id, user.id).all();
  const items = (rs.results || []).map((r) => ({
    /* Composite id, and it has to be. Session ids are client-generated, so two
       people can both hold an "s1"; unqualified they would collide, and likes,
       comments and lineage are all keyed by this id. */
    id: r.user_id + ":" + r.id,
    who: r.user_id,
    name: r.display,
    initials: r.initials,
    mine: r.user_id === user.id,
    date: r.date,
    split: r.split,
    ex: JSON.parse(r.ex),
    from: r.from_json ? JSON.parse(r.from_json) : null
  }));

  /* Engagement rides along on the feed instead of costing a second round
     trip. It is joined through `sessions`, so a like on a workout that was
     later unshared stops being visible without the row being destroyed. */
  const sc = await env.DB.prepare(
    "SELECT c.item_id, c.user_id, c.kind, c.body FROM social c " +
    "JOIN sessions s ON s.user_id || ':' || s.id = c.item_id " +
    "WHERE s.shared = 1 AND s.deleted = 0 AND " + VISIBLE + " " +
    "ORDER BY c.created LIMIT 2000"
  ).bind(user.id, user.id).all();

  const social = {}, need = new Set();
  for (const i of items) need.add(i.who);
  for (const r of (sc.results || [])) {
    const e = social[r.item_id] || (social[r.item_id] = { likes: [], comments: [] });
    if (r.kind === "like") e.likes.push(r.user_id);
    else e.comments.push({ who: r.user_id, text: r.body });
    need.add(r.user_id);
  }

  /* "Your crew" is now the people you follow, in the order you followed them,
     with you first. It is still sent whole and still drawn above the feed,
     because it answers the question an empty feed cannot: somebody you follow
     who has never shared a workout is on the roster, and the page can say so
     rather than showing an empty screen with nothing to explain it. */
  const cr = await env.DB.prepare(
    "SELECT u.id, u.display, u.initials, u.name FROM follows f " +
    "JOIN users u ON u.id = f.followee WHERE f.follower = ? ORDER BY f.created LIMIT 200"
  ).bind(user.id).all();
  const crew = [{ id: user.id, name: user.display, initials: user.initials,
                  username: user.name, mine: true }].concat(
    (cr.results || []).map((r) => ({
      id: r.id, name: r.display, initials: r.initials, username: r.name, mine: false
    })));

  const fc = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee = ?")
    .bind(user.id).first();
  const counts = { following: crew.length - 1, followers: (fc && fc.n) || 0 };

  /* Names for everyone the page will have to draw a disc for. The roster used
     to cover all of them, and no longer does: somebody you do NOT follow can
     comment on a workout by somebody you do, and would otherwise render as a
     raw row id. One query for whoever is left over. */
  const people = {};
  for (const c of crew) people[c.id] = { name: c.name, initials: c.initials };
  const rest = [...need].filter((id) => !people[id]).slice(0, 100);
  if (rest.length) {
    const qs = rest.map(() => "?").join(",");
    const ps = await env.DB.prepare(
      "SELECT id, display, initials FROM users WHERE id IN (" + qs + ")").bind(...rest).all();
    for (const r of (ps.results || [])) people[r.id] = { name: r.display, initials: r.initials };
  }
  for (const id of need) if (!people[id]) people[id] = { name: id, initials: "?" };

  return json({ now: Date.now(), items, social, people, crew, counts });
}

/* One like or one comment. The only write in the app that lands on somebody
   else's row, which is why it checks two things the session routes never have
   to: that the target is a real, still-shared session, and that `user_id`
   comes from the cookie rather than the body. */
const MAX_COMMENT = 500;
async function socialWrite(req, env, user) {
  const b = await readJSON(req);
  const item = String((b && b.item) || "");
  const kind = String((b && b.kind) || "");
  const cut = item.indexOf(":");
  if (cut < 1 || item.length > 130) return json({ error: "Bad item." }, 400);

  /* The same visibility rule the feed uses, and it has to be re-checked here:
     the feed is what the page can SEE, this is what it can WRITE, and a
     crafted request never went through the feed at all. */
  const target = await env.DB.prepare(
    "SELECT 1 FROM sessions s WHERE s.user_id = ? AND s.id = ? " +
    "AND s.shared = 1 AND s.deleted = 0 AND " + VISIBLE
  ).bind(item.slice(0, cut), item.slice(cut + 1), user.id, user.id).first();
  if (!target) return json({ error: "That workout isn’t shared with you." }, 404);

  const now = Date.now();

  if (kind === "like") {
    /* derived id: a double tap can never leave two rows behind */
    const id = user.id + "|" + item + "|like";
    const del = await env.DB.prepare("DELETE FROM social WHERE id = ?").bind(id).run();
    const off = !!(del.meta && del.meta.changes);
    if (!off)
      await env.DB.prepare(
        "INSERT INTO social (id, item_id, user_id, kind, body, created) VALUES (?, ?, ?, 'like', '', ?)"
      ).bind(id, item, user.id, now).run();
    return json({ item, kind: "like", on: !off });
  }

  if (kind === "comment") {
    const text = String((b && b.text) || "").trim().slice(0, MAX_COMMENT);
    if (!text) return json({ error: "Say something first." }, 400);
    await env.DB.prepare(
      "INSERT INTO social (id, item_id, user_id, kind, body, created) VALUES (?, ?, ?, 'comment', ?, ?)"
    ).bind(hex(crypto.getRandomValues(new Uint8Array(16))), item, user.id, text, now).run();
    return json({ item, kind: "comment", text });
  }

  return json({ error: "Bad kind." }, 400);
}

async function remove(env, user, id) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (user_id, id, date, split, ex, updated, deleted) " +
    "VALUES (?, ?, '1970-01-01', 'other', '[]', ?, 1) " +
    "ON CONFLICT(user_id, id) DO UPDATE SET deleted = 1, ex = '[]', updated = excluded.updated"
  ).bind(user.id, id, now).run();
  return json({ id, deleted: 1, updated: now });
}

/* ---------- routing ---------- */
async function api(req, env, url) {
  const path = url.pathname.slice(5);
  const method = req.method;

  /* SameSite=Lax already blocks cross-site form posts; this also refuses a
     cross-origin fetch that carries an Origin header */
  if (method !== "GET") {
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Bad origin." }, 403);
  }

  if (path === "login" && method === "POST") return login(req, env);
  if (path === "signup" && method === "POST") return signup(req, env);
  /* public on purpose: the join screen has to be able to say "expired" before
     asking a stranger to pick a username */
  if (path.startsWith("invite/") && !path.endsWith("/accept") && method === "GET")
    return inviteCheck(env, decodeURIComponent(path.slice(7)));
  if (path === "auth/google/start" && method === "GET") return googleStart(req, env, url);
  if (path === "auth/google/callback" && method === "GET") return googleCallback(req, env, url);

  const user = await currentUser(req, env);

  /* `google` tells the page whether to offer the button at all, so a server
     without credentials simply never shows it */
  if (path === "me" && method === "GET")
    return json({ user: user ? publicUser(user) : null, google: googleOn(env) });

  if (path === "logout" && method === "POST") {
    if (user) await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(user.tok).run();
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
    });
  }

  if (!user) return json({ error: "Signed out." }, 401);

  if (path === "password" && method === "POST") return changePassword(req, env, user);
  if (path === "users" && method === "GET") return userSearch(env, user, url);
  if (path === "follow" && method === "POST") return followWrite(req, env, user);
  /* signed in and holding somebody's link: no account to make, just the
     handshake -- and the code is still spent */
  if (path.startsWith("invite/") && path.endsWith("/accept") && method === "POST")
    return inviteAccept(env, user, decodeURIComponent(path.slice(7, -7)));

  if (path === "invites" && method === "GET") return invitesList(env, user, url);
  if (path === "invites" && method === "POST") return inviteCreate(env, user, url);
  if (path.startsWith("invites/") && path.endsWith("/revoke") && method === "POST")
    return inviteRevoke(env, user, path.slice(8, -7));

  if (path === "sessions" && method === "GET") return pull(env, user, url);
  if (path === "feed" && method === "GET") return feed(env, user);
  if (path === "social" && method === "POST") return socialWrite(req, env, user);

  if (path.startsWith("sessions/")) {
    const id = decodeURIComponent(path.slice(9));
    if (!id || id.length > 64) return json({ error: "Bad id." }, 400);
    if (method === "PUT") return push(req, env, user, id);
    if (method === "DELETE") return remove(env, user, id);
  }

  return json({ error: "Not found." }, 404);
}

function asset(body, type, cache) {
  return new Response(body, { headers: { "content-type": type, "cache-control": cache } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.startsWith("/api/")) {
      try {
        return await api(req, env, url);
      } catch (e) {
        /* never leak a SQL message to the client; the real one is in the tail */
        console.error("api error", p, e && e.stack ? e.stack : String(e));
        return json({ error: "Something went wrong." }, 500);
      }
    }

    if (p === "/manifest.webmanifest")
      return asset(MANIFEST, "application/manifest+json", "public, max-age=3600");
    if (p === "/icon-192.png") return asset(ICON192, "image/png", "public, max-age=604800");
    if (p === "/icon-512.png") return asset(ICON512, "image/png", "public, max-age=604800");
    if (p === "/splash.jpg") return asset(SPLASH, "image/jpeg", "public, max-age=604800");

    /* no-cache, not no-store: the browser may keep it, but must revalidate, so
       a deploy reaches everyone's home-screen app on the next launch */
    /* /join/<code> serves the same single page; the app reads the code off
       location.pathname. It is a real URL because it gets texted to people. */
    if (p === "/" || p === "/index.html" || /^\/join\/[a-f0-9]{32}$/.test(p))
      return asset(PAGE, "text/html; charset=utf-8", "no-cache");

    return new Response("Not found", { status: 404 });
  }
};
