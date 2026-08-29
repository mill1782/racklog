/* Headless smoke tests for rack-log.html.
 *
 *   node test/run.js
 *
 * The prototype is one HTML file with no build step and no dependencies, so
 * this pulls the <script> block out of it and runs it against a minimal DOM
 * stub. That is enough to exercise every pure function and every render path,
 * because rendering is just string building into innerHTML.
 *
 * What it cannot check: real layout, scrolling, fonts, touch. Those need a
 * browser -- see "Verifying in a browser" in HANDOFF.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "..", "rack-log.html");
const html = fs.readFileSync(file, "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error("No <script> block found in " + file); process.exit(1); }

/* ---- minimal DOM ---- */
const els = {};
function mkEl() {
  return { innerHTML: "", value: "", focus() {}, addEventListener() {},
           onclick: null, classList: { add() {}, remove() {} }, scrollTo() {} };
}
const sandbox = {
  console,
  setTimeout: () => {},
  localStorage: { getItem: () => null, setItem() {} },
  document: {
    getElementById: (id) => els[id] || (els[id] = mkEl()),
    querySelector: () => null,
    addEventListener() {},
    body: { classList: { add() {}, remove() {} } }
  }
};
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: "rack-log.html<script>" });

/* ---- tiny assert harness ---- */
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "  -> " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "got " + JSON.stringify(actual) +
     ", expected " + JSON.stringify(expected));
}
function group(n) { console.log("\n" + n); }

const S = () => sandbox.S;
const viewHTML = () => sandbox.document.getElementById("view").innerHTML;
const barHTML  = () => sandbox.document.getElementById("bar").innerHTML;
const pickHTML = () => sandbox.document.getElementById("picklist").innerHTML;
const screen = () =>
  viewHTML().indexOf("<h1>Rack Log</h1>") >= 0 ? "home/calendar" :
  viewHTML().indexOf("<h1>Exercises</h1>") >= 0 ? "home/exercises" :
  viewHTML().indexOf("livehead") >= 0 ? "session" : "exercise";

/* ---- 1. seed data mirrors the spreadsheet ---- */
group("Seed data (from 'Untitled spreadsheet.xlsx')");
eq("5 sessions seeded", S().sessions.length, 5);
const names = new Set();
sandbox.SEED.forEach(s => s.ex.forEach(x => names.add(x.name)));
/* 23 exercise entries across 5 sessions, but Lateral Raise and Rear Delt
   each appear twice, so 21 distinct movements. */
eq("21 distinct exercises", names.size, 21);
const bench = sandbox.SEED[0].ex[0];
eq("Bench keeps its 5 sets", bench.sets.length, 5);
eq("Bench top set is 3x155", JSON.stringify(bench.sets[2]), "[3,155]");
eq("half-plate weights survive", sandbox.SEED[0].ex[2].sets[0][1], 47.5);

/* ---- 2. lifting: estimated 1RM and the PR rule ---- */
group("Lifting");
eq("Epley 10x135", Math.round(sandbox.e1rm(10, 135)), 180);
sandbox.startWorkout(); sandbox.setSplit("legs"); sandbox.pick("Squat", "lift", "legs");
sandbox.document.getElementById("f0_0").value = 8;
sandbox.document.getElementById("f0_1").value = 185;
sandbox.addSet(0);
ok("beating a past best flags PR", viewHTML().indexOf(">PR<") >= 0);
eq("draft carries to the next set", JSON.stringify(S().live.ex[0].draft), "[8,185]");
sandbox.pick("Leg Press", "lift", "legs");   /* left empty on purpose */
sandbox.finish();
eq("finished session is stored", S().sessions.length, 6);
eq("empty exercise dropped on finish",
   S().sessions[S().sessions.length - 1].ex.length, 1);

/* ---- 3. cardio: per-machine fields ---- */
group("Cardio");
sandbox.startWorkout(); sandbox.setSplit("cardio");
sandbox.pick("Treadmill Walk", "tread", "cardio");
sandbox.pick("Stationary Bike", "machine", "cardio");
eq("treadmill has 3 fields", sandbox.KINDS.tread.fields.length, 3);
eq("machine has 2 fields", sandbox.KINDS.machine.fields.length, 2);
ok("3-field entry uses the stacked layout", viewHTML().indexOf("entry stack") >= 0);
sandbox.document.getElementById("f0_0").value = 30;
sandbox.document.getElementById("f0_1").value = 3.5;
sandbox.document.getElementById("f0_2").value = 4;
sandbox.addSet(0);
sandbox.document.getElementById("f1_0").value = 22;
sandbox.document.getElementById("f1_1").value = 8;
sandbox.addSet(1);
eq("treadmill set stored", JSON.stringify(S().live.ex[0].sets), "[[30,3.5,4]]");
eq("bike set stored", JSON.stringify(S().live.ex[1].sets), "[[22,8]]");
ok("no PR badge on cardio", viewHTML().indexOf(">PR<") < 0);
sandbox.finish();
sandbox.openExercise("Stationary Bike");
ok("cardio gets the bar chart", viewHTML().indexOf('class="barmark"') >= 0);
ok("cardio stats, not 1RM", viewHTML().indexOf("Total time") >= 0 &&
   viewHTML().indexOf("Best est. 1RM") < 0);
sandbox.openExercise("Bench");
ok("lifting keeps the line chart", viewHTML().indexOf('class="ser"') >= 0 ||
   viewHTML().indexOf('class="pt"') >= 0);
ok("lifting stats", viewHTML().indexOf("Best est. 1RM") >= 0);

/* ---- 4. calendar ---- */
group("Calendar");
sandbox.goHome();
ok("month grid renders", viewHTML().indexOf("calgrid") >= 0);
ok("labelled August 2026", viewHTML().indexOf("August 2026") >= 0);
ok("a dot per session", (viewHTML().match(/<i data-split=/g) || []).length >= 5);
ok("next month disabled (it is the future)", /setMonth\(1\)" disabled/.test(viewHTML()));
sandbox.setMonth(-1);
ok("empty month says so", viewHTML().indexOf("Nothing logged in July 2026") >= 0);
sandbox.setMonth(1);

/* ---- 5. classification ---- */
group("Exercise classification");
const lib = Object.keys(sandbox.EXTRA).reduce((a, k) => a.concat(sandbox.EXTRA[k]), []);
ok("library is classified and duplicate-free", new Set(lib).size === lib.length);
ok("library never repeats a logged exercise", lib.filter(n => names.has(n)).length === 0);
sandbox.startWorkout(); sandbox.setSplit("pull");
sandbox.document.getElementById("q").value = "Sled Push";
sandbox.fillPick();
eq("a new name offers 5 classifications",
   (pickHTML().match(/pick\('Sled Push'/g) || []).length, 5);
sandbox.pick("Sled Push", "lift", "legs");
eq("chosen classification is stored, not the day's", S().live.ex[0].split, "legs");
ok("card wears its own classification",
   /excard" data-split="legs"/.test(viewHTML()));
sandbox.document.getElementById("f0_0").value = 10;
sandbox.document.getElementById("f0_1").value = 180;
sandbox.addSet(0);
sandbox.finish();
sandbox.startWorkout(); sandbox.setSplit("push");
sandbox.pick("Sled Push", "lift", "push");
eq("re-adding keeps the original classification", S().live.ex[0].split, "legs");

/* ---- 6. navigation: the calendar is home ---- */
group("Navigation");
sandbox.goHome(); sandbox.setTab("exercises");
eq("on the exercises tab", screen(), "home/exercises");
sandbox.resume();
eq("resumed the live workout", screen(), "session");
sandbox.goHome();
eq("leaving a session always lands on the calendar", screen(), "home/calendar");
sandbox.S.live = null;
sandbox.setTab("exercises"); sandbox.openExercise("Bench");
eq("exercise detail", screen(), "exercise");
ok("exercise page keeps the nav", barHTML().indexOf("setTab('history')") >= 0);
sandbox.setTab("history");
eq("nav reaches the calendar in one tap", screen(), "home/calendar");
sandbox.openSession("s4"); sandbox.openExercise("Pec Fly"); sandbox.goBack();
eq("chart opened from a session returns to it", screen(), "session");

/* ---- 7. editing a finished session ---- */
group("Editing a finished session");
sandbox.S.live = null;
const pushDay = () => S().sessions.filter(x => x.id === "s4")[0];
sandbox.openSession("s4");
ok("finished session opens read-only", barHTML().indexOf("editSession()") >= 0 &&
   viewHTML().indexOf("delSet(") < 0 && viewHTML().indexOf("splitpick") < 0);
sandbox.editSession();
ok("Edit unlocks the live controls", viewHTML().indexOf("delSet(") >= 0 &&
   viewHTML().indexOf("splitpick") >= 0 && viewHTML().indexOf("addSet(") >= 0);
ok("edit mode offers Done, not Finish", barHTML().indexOf("doneEditing()") >= 0 &&
   barHTML().indexOf("finish()") < 0);
const flySets = pushDay().ex[3].sets.length;
sandbox.delSet(3, 0);
eq("a set can be deleted from a finished session", pushDay().ex[3].sets.length, flySets - 1);
sandbox.document.getElementById("f3_0").value = 12;
sandbox.document.getElementById("f3_1").value = 140;
sandbox.addSet(3);
eq("a set can be added to a finished session",
   JSON.stringify(pushDay().ex[3].sets.slice(-1)), "[[12,140]]");
sandbox.setSplit("legs");
eq("a mis-filed split can be corrected", pushDay().split, "legs");
sandbox.setSplit("push");
const exCount = pushDay().ex.length;
sandbox.pick("Cable Fly", "lift", "push");   /* left empty on purpose */
sandbox.doneEditing();
eq("empty exercise dropped on Done", pushDay().ex.length, exCount);
ok("no drafts persist after Done", pushDay().ex.every(x => x.draft === undefined));
eq("Done returns to the session", screen(), "session");
ok("and it is read-only again", viewHTML().indexOf("delSet(") < 0);
ok("the edit shows in the session", viewHTML().indexOf("140") >= 0);

/* emptying a session out is how a day gets thrown away */
const before = S().sessions.length;
sandbox.openSession("s1"); sandbox.editSession();
while (S().sessions.filter(x => x.id === "s1")[0].ex.length) sandbox.delEx(0);
sandbox.doneEditing();
eq("emptied session is deleted", S().sessions.length, before - 1);
eq("deleting a session lands on the calendar", screen(), "home/calendar");

/* a live workout and an edited session must not cross wires */
sandbox.startWorkout(); sandbox.setSplit("pull");
sandbox.openSession("s2"); sandbox.editSession();
sandbox.pick("Shrug", "lift", "pull");
sandbox.document.getElementById("f4_0").value = 12;
sandbox.document.getElementById("f4_1").value = 95;
sandbox.addSet(4);
eq("edits miss the live workout", S().live.ex.length, 0);
eq("edits land on the edited session",
   JSON.stringify(S().sessions.filter(x => x.id === "s2")[0].ex[4].sets), "[[12,95]]");
sandbox.doneEditing();

/* ---- 8. cancelling a live workout ---- */
group("Cancelling a workout");
sandbox.resume();
ok("a live workout offers Cancel", viewHTML().indexOf("askCancel()") >= 0);
sandbox.pick("Deadlift", "lift", "pull");
sandbox.document.getElementById("f0_0").value = 5;
sandbox.document.getElementById("f0_1").value = 315;
sandbox.addSet(0);
const sessionsBefore = S().sessions.length;
sandbox.askCancel();
ok("cancelling asks first", sandbox.dlgOpen === true);
ok("the prompt counts what is at stake",
   els.dialog.innerHTML.indexOf("<b>1</b> set") >= 0);
ok("both answers are offered", els.dialog.innerHTML.indexOf("Discard workout") >= 0 &&
   els.dialog.innerHTML.indexOf("Keep logging") >= 0);
sandbox.closeDialog();
ok("declining keeps the workout", !!S().live && sandbox.dlgOpen === false);
eq("declining keeps the set", S().live.ex[0].sets.length, 1);
sandbox.askCancel(); sandbox.dialogYes();
ok("confirming discards the workout", S().live === null);
eq("a cancelled workout is never stored", S().sessions.length, sessionsBefore);
eq("cancelling lands on the calendar", screen(), "home/calendar");
sandbox.startWorkout(); sandbox.askCancel();
ok("an empty workout says nothing is lost",
   els.dialog.innerHTML.indexOf("Nothing is logged yet") >= 0);
sandbox.dialogYes();

/* ---- 9. the crew feed ---- */
group("Crew feed");
sandbox.S.live = null;
sandbox.goHome();
eq("home lands on Mine, not the feed", S().home, "mine");
ok("the Mine/Crew switch is on the home screen",
   viewHTML().indexOf("setHome('crew')") >= 0 && viewHTML().indexOf("calgrid") >= 0);
sandbox.setHome("crew");
eq("Crew keeps the calendar's home identity", screen(), "home/calendar");
ok("the calendar is replaced, not stacked", viewHTML().indexOf("calgrid") < 0);
ok("the switch is still reachable", viewHTML().indexOf("setHome('mine')") >= 0);
ok("bottom nav is untouched by the feed",
   barHTML().indexOf("setTab('history')") >= 0 && barHTML().indexOf("startWorkout()") >= 0);
eq("every seeded crew session renders",
   (viewHTML().match(/class="avatar"/g) || []).length, sandbox.FEED.length);
ok("cards carry the full exercise list", viewHTML().indexOf("Barbell Bench Press") >= 0 &&
   viewHTML().indexOf("Romanian Deadlift") >= 0);
ok("a person gets initials, not a bare name", viewHTML().indexOf(">DR<") >= 0);
ok("each person keeps their own colour",
   viewHTML().indexOf('data-person="p1"') >= 0 && viewHTML().indexOf('data-person="p2"') >= 0);
ok("cardio in the feed reads as time, not weight",
   viewHTML().indexOf("min cardio") >= 0);
ok("crew cards are not buttons",
   viewHTML().indexOf('<button class="card"') < 0);

/* sharing is opt-in and per session */
group("Sharing a session");
const feedCount = () => (viewHTML().match(/class="avatar"/g) || []).length;
sandbox.setHome("mine");
sandbox.openSession("s3");
ok("a finished session offers Share", viewHTML().indexOf("toggleShare()") >= 0);
ok("nothing is shared by default", S().sessions.every(x => x.shared === undefined));
sandbox.toggleShare();
eq("sharing flags that session", S().sessions.filter(x => x.id === "s3")[0].shared, true);
ok("the button flips to Shared", viewHTML().indexOf("Shared") >= 0);
sandbox.goHome(); sandbox.setHome("crew");
eq("a shared session joins the feed", feedCount(), sandbox.FEED.length + 1);
ok("your own entry is marked", viewHTML().indexOf('data-person="me"') >= 0 &&
   viewHTML().indexOf(">You<") >= 0);
ok("the feed is in date order",
   viewHTML().indexOf("Danny") < viewHTML().indexOf("Sam"));
sandbox.openSession("s3"); sandbox.toggleShare();
ok("unsharing removes it again", S().sessions.filter(x => x.id === "s3")[0].shared === undefined);
sandbox.goHome(); sandbox.setHome("crew");
eq("feed is back to the crew's own", feedCount(), sandbox.FEED.length);
sandbox.setHome("mine");

/* ---- 10. likes and comments ---- */
group("Likes and comments");
sandbox.S.live = null;
sandbox.goHome(); sandbox.setHome("crew");
ok("seeded likes show a count", viewHTML().indexOf('<span class="n">2</span>') >= 0);
ok("nothing is liked by you at the start", !sandbox.liked("f1"));
sandbox.toggleLike("f1");
ok("liking records you", sandbox.liked("f1"));
eq("and bumps the count", sandbox.soc("f1").likes.length, 3);
ok("the button reflects it", viewHTML().indexOf('aria-pressed="true"') >= 0);
sandbox.toggleLike("f1");
ok("liking again takes it back", !sandbox.liked("f1"));
eq("count returns", sandbox.soc("f1").likes.length, 2);

ok("threads are collapsed by default", viewHTML().indexOf('class="thread"') < 0);
ok("a card with no comments still offers Reply", viewHTML().indexOf("toggleThread('f5')") >= 0);
sandbox.toggleThread("f1");
ok("opening shows the thread", viewHTML().indexOf('class="thread"') >= 0);
ok("seeded comments render", viewHTML().indexOf("225 by November") >= 0);
ok("a commenter gets their own disc", viewHTML().indexOf('class="cmt" data-person="p2"') >= 0);
sandbox.document.getElementById("c_f1").value = "  ";
sandbox.addComment("f1");
eq("blank comments are ignored", sandbox.soc("f1").comments.length, 2);
sandbox.document.getElementById("c_f1").value = "Spot me next time";
sandbox.addComment("f1");
eq("a comment is stored", sandbox.soc("f1").comments.length, 3);
eq("posted as you", sandbox.soc("f1").comments[2].who, "me");
ok("and shows in the thread", viewHTML().indexOf("Spot me next time") >= 0);
sandbox.toggleThread("f1");
ok("toggling closes it again", viewHTML().indexOf('class="thread"') < 0);
ok("only one thread opens at a time",
   (sandbox.toggleThread("f1"), sandbox.toggleThread("f3"), sandbox.openThread === "f3"));
sandbox.toggleThread("f3");

/* ---- 11. running someone else's workout ---- */
group("Running someone else's workout");
const tess = sandbox.FEED.filter(f => f.id === "f6")[0];
sandbox.doWorkout("f6");
eq("no live workout means no prompt", sandbox.dlgOpen, false);
eq("their split carries over", S().live.split, tess.split);
eq("their movements carry over",
   JSON.stringify(S().live.ex.map(x => x.name)),
   JSON.stringify(tess.ex.map(x => x.name)));
ok("but none of their sets", S().live.ex.every(x => x.sets.length === 0));
eq("the copy remembers whose it was", S().live.from.who, "tess");
eq("and which session", S().live.from.src, "f6");
ok("the live header names them", viewHTML().indexOf("Tess") >= 0);
/* Leg Extension: Tess opened 15x70, Mark's own history opens 15x85 */
const legExt = S().live.ex.filter(x => x.name === "Leg Extension")[0];
eq("your own numbers win where you have history",
   JSON.stringify(legExt.draft), "[15,85]");
const goblet = S().live.ex.filter(x => x.name === "Goblet Squat")[0];
eq("theirs fill in where you have none", JSON.stringify(goblet.draft), "[12,50]");

/* swapping mid-workout asks first */
sandbox.document.getElementById("f0_0").value = 12;
sandbox.document.getElementById("f0_1").value = 55;
sandbox.addSet(0);
sandbox.goHome(); sandbox.setHome("crew");
sandbox.doWorkout("f1");
ok("swapping a live workout asks first", sandbox.dlgOpen === true);
ok("the prompt counts what is at stake", els.dialog.innerHTML.indexOf("<b>1</b> set") >= 0);
sandbox.closeDialog();
eq("declining keeps your workout", S().live.from.src, "f6");
sandbox.doWorkout("f1"); sandbox.dialogYes();
eq("confirming swaps it", S().live.from.src, "f1");
ok("and the old sets are gone", S().live.ex.every(x => x.sets.length === 0));

/* lineage is only countable once the copy is shared */
group("Lineage");
eq("an unfinished copy counts for nothing", sandbox.repeats("f1"), 0);
/* stay on the live session: the entry fields only exist while it is open */
sandbox.resume();
sandbox.document.getElementById("f0_0").value = 8;
sandbox.document.getElementById("f0_1").value = 185;
sandbox.addSet(0);
sandbox.finish();
const copyId = S().sessions[S().sessions.length - 1].id;
eq("finishing keeps the lineage", S().sessions[S().sessions.length - 1].from.src, "f1");
eq("an unshared copy still counts for nothing", sandbox.repeats("f1"), 0);
sandbox.openSession(copyId); sandbox.toggleShare();
eq("sharing it makes it count", sandbox.repeats("f1"), 1);
sandbox.goHome(); sandbox.setHome("crew");
ok("the original says how far it travelled", viewHTML().indexOf("Done by 1 other") >= 0);
ok("the copy credits the original", viewHTML().indexOf("Danny&rsquo;s Push day") >= 0);
ok("your own card offers a rerun instead", viewHTML().indexOf("Do it again") >= 0);
sandbox.setHome("mine");

/* ---- 9. the date is real, not a fixture ---- */
group("Dates");
const pad = n => String(n).padStart(2, "0");
const now = new Date();
const realToday = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
ok("today() is an ISO day", /^\d{4}-\d{2}-\d{2}$/.test(sandbox.today()));
eq("today() is the local day, not UTC", sandbox.today(), realToday);
eq("ago() calls today today", sandbox.ago(sandbox.today()), "today");
sandbox.startWorkout();
eq("a workout started now is dated today", S().live.date, sandbox.today());
sandbox.askCancel(); sandbox.dialogYes();
/* the calendar must never page past the current month */
sandbox.setMonth(0);
S().month = sandbox.today().slice(0, 7);
sandbox.render();
ok("the calendar can't page into the future",
   viewHTML().indexOf('onclick="setMonth(1)" disabled') >= 0);

/* ---- 10. export and import ---- */
group("Export / import");
sandbox.openData();
ok("the data screen renders", viewHTML().indexOf(">Your data</h1>") >= 0);
ok("the calendar is still one tap away", barHTML().indexOf("setTab('history')") >= 0);

const dump = sandbox.exportText();
const parsed = JSON.parse(dump);
eq("export carries every session", parsed.sessions.length, S().sessions.length);
eq("export is stamped with a schema version", parsed.version, 2);
ok("export is stamped with a time", typeof parsed.exported === "string");

ok("an empty paste is refused", !!sandbox.parseImport("   ").err);
ok("junk is refused", !!sandbox.parseImport("not json").err);
ok("JSON with no sessions is refused", !!sandbox.parseImport('{"app":"racklog"}').err);
ok("a session with a bad date is refused",
   !!sandbox.parseImport('{"sessions":[{"id":"x","date":"nope","ex":[]}]}').err);
ok("a session with no exercises array is refused",
   !!sandbox.parseImport('{"sessions":[{"id":"x","date":"2026-07-04"}]}').err);
ok("a real export is accepted", !sandbox.parseImport(dump).err);

const hadSessions = S().sessions.length;
sandbox.document.getElementById("importblob").value = dump;
sandbox.askImport();
ok("importing asks first", sandbox.dlgOpen === true);
ok("the prompt names what is replaced",
   els.dialog.innerHTML.indexOf("<b>" + hadSessions + " sessions</b>") >= 0);
sandbox.closeDialog();
eq("declining keeps your data", S().sessions.length, hadSessions);

sandbox.askImport(); sandbox.dialogYes();
eq("a round trip preserves every session", S().sessions.length, hadSessions);
eq("import lands you back on the calendar", screen(), "home/calendar");

sandbox.document.getElementById("importblob").value = JSON.stringify(
  { sessions: [{ id: "imported", date: "2026-07-04", split: "pull", ex: [] }], social: {} });
sandbox.openData(); sandbox.askImport(); sandbox.dialogYes();
eq("import replaces rather than merges", S().sessions.length, 1);
eq("and opens the imported month", S().month, "2026-07");

/* importing over a running workout would silently drop it */
sandbox.startWorkout();
sandbox.openData();
sandbox.document.getElementById("importblob").value = dump;
sandbox.askImport();
ok("importing mid-workout is refused", sandbox.dlgOpen === false);
ok("and says why", String(els.impmsg.textContent).indexOf("Finish or cancel") >= 0);
sandbox.askCancel(); sandbox.dialogYes();

/* ---- 11. sync ----
 * Against a fake server that mirrors worker/index.js: last-write-wins per
 * session, tombstones for deletes, "everything changed since N" for pulls.
 * This is the riskiest code in the app and the part a DOM stub can still
 * exercise properly, because it is all state and promises.
 */
function fakeServer() {
  const api = {
    rows: new Map(), clock: 1000, puts: 0, dels: 0, unauthorized: false,
    touch(id, row) { api.rows.set(id, Object.assign({ id }, row, { updated: ++api.clock })); },
    tomb(id) { api.rows.set(id, { id, deleted: 1, updated: ++api.clock }); },
    fetch(path, opts) {
      opts = opts || {};
      const method = opts.method || "GET";
      const [p, qs] = path.split("?");
      const body = opts.body ? JSON.parse(opts.body) : null;
      let out = null, status = 200;

      if (api.unauthorized && p !== "/api/me") { status = 401; out = { error: "Signed out." }; }
      else if (p === "/api/me") out = { user: { name: "Mark", initials: "M" } };
      else if (p === "/api/sessions" && method === "GET") {
        const since = Number(new URLSearchParams(qs || "").get("since") || 0);
        out = { now: ++api.clock,
                sessions: [...api.rows.values()].filter(r => r.updated > since) };
      } else if (p.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(p.slice("/api/sessions/".length));
        if (method === "PUT") {
          api.puts++;
          api.rows.set(id, Object.assign({}, body, { id, updated: ++api.clock, deleted: 0 }));
          out = { id, updated: api.clock };
        } else if (method === "DELETE") {
          api.dels++; api.tomb(id); out = { id, deleted: 1, updated: api.clock };
        }
      }
      if (!out) { status = 404; out = { error: "Not found." }; }
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(out) });
    }
  };
  return api;
}

(async () => {
  group("Sync");
  /* signed out / no server at all: the standalone path */
  sandbox.API = false;
  ok("with no server the data screen says so",
     sandbox.authSection().indexOf("runs on its own") >= 0);
  eq("and syncing is a no-op", await sandbox.sync(), undefined);

  const server = fakeServer();
  sandbox.fetch = (p, o) => server.fetch(p, o);
  sandbox.API = true;
  sandbox.SY.user = { name: "Mark", initials: "M" };
  sandbox.SY.since = 0;
  sandbox.SY.shadow = {};

  ok("signed in, the data screen offers a sync",
     sandbox.authSection().indexOf("Sync now") >= 0);

  const mine = S().sessions.length;
  eq("everything local starts out dirty", sandbox.dirtyOps().length, mine);
  await sandbox.sync();
  eq("a first sync uploads every session", server.rows.size, mine);
  eq("and nothing is left dirty", sandbox.dirtyOps().length, 0);

  /* the key-order regression: a round trip must not look like a change */
  const puts = server.puts;
  await sandbox.sync();
  eq("a clean sync re-uploads nothing", server.puts, puts);

  /* a workout logged on another device */
  server.touch("phone1", { date: "2026-06-01", split: "legs", ex: [] });
  await sandbox.sync();
  ok("a workout from another device arrives", sandbox.idxOf("phone1") >= 0);
  eq("and is not echoed back up", server.puts, puts);

  /* deleted elsewhere -- the tombstone is why this works at all */
  server.tomb("phone1");
  await sandbox.sync();
  eq("a delete on another device removes it here", sandbox.idxOf("phone1"), -1);

  /* deleted here */
  const victim = S().sessions[0].id;
  S().sessions.splice(0, 1);
  await sandbox.sync();
  ok("deleting here tombstones it on the server",
     server.rows.get(victim) && server.rows.get(victim).deleted === 1);
  eq("and it stays gone locally", sandbox.idxOf(victim), -1);

  /* an edit here wins over what the server last saw */
  S().sessions.push({ id: "local1", date: "2026-06-02", split: "push", ex: [] });
  await sandbox.sync();
  S().sessions[sandbox.idxOf("local1")].split = "cardio";
  await sandbox.sync();
  eq("an edit here reaches the server", server.rows.get("local1").split, "cardio");

  /* an expired cookie */
  server.unauthorized = true;
  S().sessions[sandbox.idxOf("local1")].split = "pull";
  await sandbox.sync();
  eq("a 401 signs you out locally", sandbox.SY.user, null);
  ok("and says so on the data screen",
     sandbox.authSection().indexOf("Sign in") >= 0);
  ok("the unsent edit is still queued", sandbox.dirtyOps().length > 0);

  group("Google sign-in");
  /* signed out, on a server that has Google credentials */
  sandbox.SY.user = null;
  sandbox.API = true;
  sandbox.SY.google = true;
  ok("the button appears when the server offers Google",
     sandbox.authSection().indexOf("/api/auth/google/start") >= 0);
  ok("and it is a link, not a fetch button \u2014 OAuth is a top-level navigation",
     /<a class="btn link" href="\/api\/auth\/google\/start">/.test(sandbox.authSection()));
  ok("the PIN form is still there alongside it",
     sandbox.authSection().indexOf('id="loginpin"') >= 0);

  /* a server without credentials must not advertise it */
  sandbox.SY.google = false;
  ok("no button when the server has no Google credentials",
     sandbox.authSection().indexOf("google") < 0);

  /* and the standalone copy never shows it, whatever SY says */
  sandbox.SY.google = true;
  sandbox.API = false;
  ok("never offered when there is no server at all",
     sandbox.authSection().indexOf("google") < 0);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
