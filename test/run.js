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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
