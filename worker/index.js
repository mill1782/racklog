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

const COOKIE = "rl";
const SESSION_MS = 90 * 86400 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_BODY = 256 * 1024;

/* Google sign-in. The state nonce lives in its own short cookie scoped to
   /api/auth/ so it never rides along with anything else. */
const OAUTH_STATE = "rlstate";
const OAUTH_STATE_S = 600;
/* the nonce is single-use: the callback burns it whichever way it ends */
const CLEAR_STATE = `${OAUTH_STATE}=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=0`;

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
 * The security cost is smaller than it looks: a 6-digit PIN is a 10^6 space,
 * so NO iteration count makes it safe against offline cracking once the
 * database leaks. What actually stops guessing is the 5-try lockout below.
 * Hashing is here so a leak does not hand over PINs to reuse elsewhere.
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
async function derive(pin, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
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
     feed items apart from the crew's and to key its likes. */
  return { id: u.id, name: u.display, initials: u.initials };
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
  const name = String((b && b.name) || "").trim().toLowerCase();
  const pin = String((b && b.pin) || "");
  if (!name || !/^\d{4,12}$/.test(pin)) return json({ error: "Enter your name and PIN." }, 400);

  const u = await env.DB.prepare("SELECT * FROM users WHERE name = ?").bind(name).first();
  const now = Date.now();

  /* derive even when the name is unknown, so response time does not reveal
     which family names exist */
  if (!u) {
    await derive(pin, "00000000000000000000000000000000");
    return json({ error: "Wrong name or PIN." }, 401);
  }
  if (u.locked_until > now) {
    return json({ error: "Too many tries. Try again in 15 minutes." }, 429);
  }

  const h = await derive(pin, u.pin_salt);
  if (!same(h, u.pin_hash)) {
    const fails = (u.fails || 0) + 1;
    const locked = fails >= MAX_FAILS;
    await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?")
      .bind(locked ? 0 : fails, locked ? now + LOCK_MS : 0, u.id).run();
    return json({ error: locked ? "Too many tries. Locked for 15 minutes." : "Wrong name or PIN." },
      locked ? 429 : 401);
  }

  await env.DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?").bind(u.id).run();

  return json({ user: publicUser(u) }, 200, { "set-cookie": await mintCookie(env, u) });
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
  return new Response(null, {
    status: 302,
    headers: {
      location: "https://accounts.google.com/o/oauth2/v2/auth?" + q,
      /* SameSite=Lax, NOT Strict. Strict withholds the cookie on the top-level
         redirect back from Google, so every sign-in would fail the state check
         with nothing in the logs to explain it. Lax sends it on that
         navigation, which is exactly and only what is needed. */
      "set-cookie": `${OAUTH_STATE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/; Max-Age=${OAUTH_STATE_S}`,
      "cache-control": "no-store"
    }
  });
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
    (await currentUser(req, env)) ? homeRedirect([CLEAR_STATE]) : oauthFail(text);

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
    /* the allowlist IS the account table. Anyone on earth has a Google account,
       so without this the app is open to the internet. */
    if (!u) return oauthFail("That Google account is not on the list for this app.");
    await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(sub, u.id).run();
  }

  /* the state cookie goes out with the same response that spends it, so a
     replay fails the check above rather than reaching Google a second time */
  return homeRedirect([await mintCookie(env, u), CLEAR_STATE]);
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
   that cannot cross users is not a feed. `shared` is the only thing keeping it
   honest, and it is opt-in per session, so nothing lands here that its owner
   did not deliberately post. */
async function feed(env, user) {
  const rs = await env.DB.prepare(
    "SELECT s.user_id, s.id, s.date, s.split, s.ex, s.from_json, u.display, u.initials " +
    "FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.shared = 1 AND s.deleted = 0 " +
    "ORDER BY s.date DESC, s.updated DESC LIMIT 200"
  ).all();
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
    "WHERE s.shared = 1 AND s.deleted = 0 ORDER BY c.created LIMIT 2000"
  ).all();

  const social = {}, need = new Set();
  for (const i of items) need.add(i.who);
  for (const r of (sc.results || [])) {
    const e = social[r.item_id] || (social[r.item_id] = { likes: [], comments: [] });
    if (r.kind === "like") e.likes.push(r.user_id);
    else e.comments.push({ who: r.user_id, text: r.body });
    need.add(r.user_id);
  }

  /* Names for everyone the page will have to draw a disc for. The feed rows
     only name people who SHARED; someone who has only ever commented would
     otherwise render as a raw row id. */
  const ids = [...need];
  const people = {};
  if (ids.length) {
    const us = await env.DB.prepare(
      "SELECT id, display, initials FROM users WHERE id IN (" + ids.map(() => "?").join(",") + ")"
    ).bind(...ids).all();
    for (const u of (us.results || [])) people[u.id] = { name: u.display, initials: u.initials };
  }

  return json({ now: Date.now(), items, social, people });
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

  const target = await env.DB.prepare(
    "SELECT 1 FROM sessions WHERE user_id = ? AND id = ? AND shared = 1 AND deleted = 0"
  ).bind(item.slice(0, cut), item.slice(cut + 1)).first();
  if (!target) return json({ error: "That workout isn’t shared." }, 404);

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

    /* no-cache, not no-store: the browser may keep it, but must revalidate, so
       a deploy reaches everyone's home-screen app on the next launch */
    if (p === "/" || p === "/index.html")
      return asset(PAGE, "text/html; charset=utf-8", "no-cache");

    return new Response("Not found", { status: 404 });
  }
};
