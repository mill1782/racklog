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
const workerSource = fs.readFileSync(path.join(__dirname, "..", "worker", "index.js"), "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error("No <script> block found in " + file); process.exit(1); }

/* ---- minimal DOM ---- */
const els = {};
const store = new Map();          /* the fake localStorage, inspectable */
function mkEl() {
  return { innerHTML: "", value: "", focus() {}, addEventListener() {},
           onclick: null, classList: { add() {}, remove() {} }, scrollTo() {} };
}
/* The .scroll box, modelled the way a browser treats it: replacing the view's
   innerHTML builds a NEW box, and a new box starts at the top. Without that
   the stub would hold a scroll offset the real page had already thrown away,
   and the "feed scrolls itself back up" bug would test as fixed while broken. */
const scrollEl = { scrollTop: 0 };
let viewHTML_ = "";
els.view = mkEl();
Object.defineProperty(els.view, "innerHTML", {
  get: () => viewHTML_,
  set: (v) => { viewHTML_ = String(v); scrollEl.scrollTop = 0; }
});

/* window-level listeners the app registers at boot. There is no Sync now
   button any more, so the "online" handler IS the recovery path -- it has to
   be tested, not assumed. */
const winListeners = {};

const sandbox = {
  console,
  addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
  setTimeout: () => {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  },
  document: {
    getElementById: (id) => els[id] || (els[id] = mkEl()),
    querySelector: (sel) =>
      (sel === ".scroll" && viewHTML_.indexOf('class="scroll"') >= 0) ? scrollEl : null,
    activeElement: null,
    addEventListener() {},
    body: { classList: { add() {}, remove() {} } }
  }
};
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: "rack-log.html<script>" });

/* Mark's real history, imported from 'Untitled spreadsheet.xlsx'.
 *
 * This lives here, not in the app: a new account starts EMPTY, so the app
 * ships no invented workouts at all. The tests below need history to have
 * anything to assert about, so they load it deliberately — which is where a
 * fixture belongs anyway. */
const SEED = [
 {id:"s1",date:"2026-08-19",split:"push",ex:[
   {name:"Bench",sets:[[8,135],[6,145],[3,155],[6,135],[18,95]]},
   {name:"Iso Lateral Shoulder Press",sets:[[15,50],[11,70],[7,100],[4,110],[16,50]]},
   {name:"Tricep Pulldown",sets:[[16,47.5]]},
   {name:"Lateral Raise",sets:[[10,25]]}]},
 {id:"s2",date:"2026-08-21",split:"pull",ex:[
   {name:"Preacher Bar Curl",sets:[[12,40],[12,50],[12,60],[6,70]]},
   {name:"Seated Row",sets:[[12,100],[11,115],[7,120]]},
   {name:"Machine Lat Pull Down",sets:[[12,95],[12,100],[12,105],[10,110]]},
   {name:"Rear Delt",sets:[[12,90],[10,105],[10,105]]}]},
 {id:"s3",date:"2026-08-24",split:"legs",ex:[
   {name:"Leg Curl",sets:[[15,60],[15,90],[12,120],[10,135]]},
   {name:"Leg Extension",sets:[[15,85],[15,100],[12,115],[10,135],[10,145]]},
   {name:"Squat",sets:[[10,135],[8,155],[8,165]]},
   {name:"Calf Raise",sets:[[10,165],[12,165]]}]},
 {id:"s4",date:"2026-08-26",split:"push",ex:[
   {name:"Lateral Raise",sets:[[12,25],[10,30],[8,30]]},
   {name:"Incline Bench",sets:[[10,115],[5,135],[8,125],[5,125],[11,105]]},
   {name:"Arnold Press",sets:[[10,30],[8,35],[4,40]]},
   {name:"Pec Fly",sets:[[12,105],[12,120],[12,135]]},
   {name:"Tricep Pushdown",sets:[[15,115],[12,115],[12,130],[12,145],[8,160]]}]},
 {id:"s5",date:"2026-08-28",split:"pull",ex:[
   {name:"Rear Delt",sets:[[12,100],[10,110],[8,115]]},
   {name:"Cable Lat Pulldown",sets:[[12,47.5],[12,50],[10,57.5],[8,65]]},
   {name:"Dumbbell Row",sets:[[12,50],[12,55],[8,60],[5,65]]},
   {name:"Dumbbell Preacher Curl",sets:[[12,25],[7,30],[12,25]]},
   {name:"Reverse Curls",sets:[[12,20],[6,25],[8,20]]},
   {name:"Bar RDL",sets:[[12,135],[12,185],[12,205]]}]}
];
/* pinned before the fixture goes in: the shipped app invents nothing */
const startedEmpty = sandbox.S.sessions.length === 0 && sandbox.S.live === null;
const startedUnshared = JSON.stringify(sandbox.S.social) === "{}";
sandbox.S.sessions = JSON.parse(JSON.stringify(SEED));
sandbox.render();

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
group("Push subscriptions");
ok("the subscription digest is converted from an ArrayBuffer before hex encoding",
   workerSource.indexOf('hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(endpoint))))') >= 0);

group("Seed data (from 'Untitled spreadsheet.xlsx')");
ok("a new device starts with no workouts at all", startedEmpty);
ok("and with no likes or comments invented", startedUnshared);
eq("5 sessions seeded", S().sessions.length, 5);
const names = new Set();
SEED.forEach(s => s.ex.forEach(x => names.add(x.name)));
/* 23 exercise entries across 5 sessions, but Lateral Raise and Rear Delt
   each appear twice, so 21 distinct movements. */
eq("21 distinct exercises", names.size, 21);
const bench = SEED[0].ex[0];
eq("Bench keeps its 5 sets", bench.sets.length, 5);
eq("Bench top set is 3x155", JSON.stringify(bench.sets[2]), "[3,155]");
eq("half-plate weights survive", SEED[0].ex[2].sets[0][1], 47.5);

/* ---- 2. lifting: estimated 1RM and the PR rule ---- */
group("Lifting");
eq("Epley 10x135", Math.round(sandbox.e1rm(10, 135)), 180);
sandbox.startWorkout(); sandbox.setSplit("legs"); sandbox.pick("Squat", "lift", "legs");
sandbox.document.getElementById("f0_0").value = 8;
sandbox.document.getElementById("f0_1").value = 185;
sandbox.addSet(0);
ok("beating a past best flags PR", viewHTML().indexOf(">PR<") >= 0);
eq("draft carries to the next set", JSON.stringify(S().live.ex[0].draft), "[8,185]");
ok("tapping a workout value selects the whole number",
   viewHTML().indexOf('onfocus="this.select()" onclick="this.select()"') >= 0);
ok("logging controls stay above the growing set list",
   viewHTML().indexOf('id="entry0"') < viewHTML().indexOf('class="sets"'));
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

/* ---- timed holds: duration, with optional added weight ---- */
group("Timed holds");
sandbox.startWorkout(); sandbox.setSplit("other"); sandbox.pick("Plank", "hold", "other");
eq("planks use the timed-hold fields", sandbox.kindOf(S().live.ex[0]), "hold");
eq("timed holds have seconds and optional weight", sandbox.KINDS.hold.fields.length, 2);
sandbox.document.getElementById("f0_0").value = 45;
sandbox.document.getElementById("f0_1").value = "";
sandbox.addSet(0);
sandbox.document.getElementById("f0_0").value = 30;
sandbox.document.getElementById("f0_1").value = 25;
sandbox.addSet(0);
eq("a bodyweight and weighted plank are both stored",
   JSON.stringify(S().live.ex[0].sets), "[[45,0],[30,25]]");
ok("the optional weight only appears when used",
   viewHTML().indexOf("45<em>sec</em>") >= 0 &&
   viewHTML().indexOf("30<em>sec</em>25<em>lb</em>") >= 0);
sandbox.finish(); sandbox.openExercise("Plank");
ok("planks get time history instead of a 1RM chart",
   viewHTML().indexOf("Seconds per session") >= 0 &&
   viewHTML().indexOf("Best est. 1RM") < 0);

/* ---- 4. calendar ---- */
group("Calendar");
S().month = "2026-08";
sandbox.goHome();
ok("month grid renders", viewHTML().indexOf("calgrid") >= 0);
ok("labelled August 2026", viewHTML().indexOf("August 2026") >= 0);
ok("a dot per session", (viewHTML().match(/<i data-split=/g) || []).length >= 5);
eq("only one calendar viewport renders", (viewHTML().match(/class="calviewport"/g) || []).length, 1);
eq("the viewport always contains six complete weeks",
   (viewHTML().match(/class="cell(?: [^"]*)?"/g) || []).length, 42);
ok("overlapping weeks show adjacent-month days", viewHTML().indexOf('class="cell out') >= 0);
ok("month headings open the jump picker", viewHTML().indexOf("openMonthPicker('2026-08')") >= 0);
sandbox.openMonthPicker("2026-08");
ok("picker offers month choices", els.dialog.innerHTML.indexOf("August") >= 0);
ok("future months are disabled", /disabled[^>]*>October<\/button>/.test(els.dialog.innerHTML));
sandbox.closeDialog();
sandbox.calendarTouchStart({touches:[{clientX:300,clientY:100}]});
sandbox.calendarTouchEnd({changedTouches:[{clientX:100,clientY:105}]});
eq("swiping left advances one month", S().month, "2026-09");
sandbox.setMonth(-1);

/* ---- 5. classification ---- */
group("Exercise classification");
const lib = Object.keys(sandbox.EXTRA).reduce((a, k) => a.concat(sandbox.EXTRA[k]), []);
ok("library is classified and duplicate-free", new Set(lib).size === lib.length);
ok("library never repeats a logged exercise", lib.filter(n => names.has(n)).length === 0);
ok("Upper, Lower, and Full Body are workout categories",
   ["upper","lower","full"].every(k => sandbox.SPLITS.some(p => p[0] === k)));
ok("the default library names the missing dumbbell variants",
   ["Dumbbell Squat","Dumbbell Romanian Deadlift","Dumbbell Lunge",
    "One-Arm Dumbbell Row","Dumbbell Fly","Farmer Carry","Dumbbell Thruster"]
     .every(n => lib.includes(n)));
sandbox.startWorkout(); sandbox.setSplit("pull");
sandbox.setSplit("full");
ok("Full Body renders as a workout day", viewHTML().indexOf("Full Body day") >= 0);
sandbox.setSplit("pull");
sandbox.document.getElementById("q").value = "Squ";
sandbox.fillPick();
ok("logged exercise matches appear before add-exercise choices",
   pickHTML().indexOf("You&rsquo;ve logged these") < pickHTML().indexOf("Add &ldquo;Squ&rdquo; as"));
sandbox.document.getElementById("q").value = "Sled Push";
sandbox.fillPick();
eq("a new name offers lift classifications and a timed hold",
   (pickHTML().match(/pick\('Sled Push'/g) || []).length, 6);
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
ok("exercise page keeps the nav",
   barHTML().indexOf("startWorkout()") >= 0 && barHTML().indexOf("setTab('exercises')") >= 0);
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

/* The crew feed is the server's now, so the fixture lives here and is
 * installed in the shape GET /api/feed actually returns: a composite id, the
 * poster's display name and initials, and `mine`. The page invents no people.
 */
const CREWFEED = [
 {id:"danny:f1",who:"danny",name:"Danny Ruiz",initials:"DR",mine:false,
  date:"2026-08-27",split:"push",from:null,ex:[
   {name:"Barbell Bench Press",sets:[[10,155],[8,175],[5,195],[8,175]]},
   {name:"Overhead Press",sets:[[10,95],[8,105],[6,115]]},
   {name:"Cable Fly",sets:[[12,40],[12,45],[10,50]]},
   {name:"Skullcrusher",sets:[[12,65],[10,75],[8,85]]}]},
 {id:"tess:f2",who:"tess",name:"Tess Lindqvist",initials:"TL",mine:false,
  date:"2026-08-27",split:"cardio",from:null,ex:[
   {name:"Treadmill Run",kind:"tread",sets:[[28,6.2,1]]},
   {name:"Rower",kind:"machine",sets:[[15,7]]}]},
 {id:"sam:f3",who:"sam",name:"Sam Okonkwo",initials:"SO",mine:false,
  date:"2026-08-26",split:"legs",from:null,ex:[
   {name:"Leg Press",sets:[[12,270],[10,320],[8,360],[8,360]]},
   {name:"Romanian Deadlift",sets:[[10,155],[10,175],[8,185]]},
   {name:"Walking Lunge",sets:[[12,40],[12,40],[10,50]]},
   {name:"Seated Calf Raise",sets:[[15,90],[15,110],[12,130]]}]},
 {id:"danny:f4",who:"danny",name:"Danny Ruiz",initials:"DR",mine:false,
  date:"2026-08-24",split:"pull",from:null,ex:[
   {name:"Deadlift",sets:[[5,275],[3,315],[1,345]]},
   {name:"Barbell Row",sets:[[10,135],[10,145],[8,155]]},
   {name:"Hammer Curl",sets:[[12,30],[10,35],[8,40]]}]},
 {id:"sam:f5",who:"sam",name:"Sam Okonkwo",initials:"SO",mine:false,
  date:"2026-08-23",split:"pull",from:null,ex:[
   {name:"Chest Supported Row",sets:[[12,90],[12,100],[10,110]]},
   {name:"Face Pull",sets:[[15,40],[15,45],[15,50]]},
   {name:"Cable Curl",sets:[[12,50],[12,60],[10,70]]}]},
 {id:"tess:f6",who:"tess",name:"Tess Lindqvist",initials:"TL",mine:false,
  date:"2026-08-22",split:"legs",from:null,ex:[
   {name:"Goblet Squat",sets:[[12,50],[12,60],[10,70]]},
   {name:"Hip Thrust",sets:[[12,185],[12,205],[10,225]]},
   {name:"Leg Extension",sets:[[15,70],[15,85],[12,100]]}]}
];
/* what the sync handler does when /api/feed answers */
function setFeed(items) {
  sandbox.SY.user = { id: "me", name: "Mark Miller", initials: "MM" };
  sandbox.SY.feed = items;
  sandbox.FEEDP = sandbox.buildPeople(items);
}
setFeed(CREWFEED.slice());
sandbox.S.social = {
  "danny:f1":{likes:["sam","tess"],comments:[
    {who:"sam",text:"195 for 5 is moving. What are you chasing?"},
    {who:"danny",text:"225 by November."}]},
  "sam:f3":{likes:["danny","tess"],comments:[
    {who:"tess",text:"360 on the press \u2014 leg day is not a joke to this man."}]}
};

/* crew cards are divs, so this counts cards and not the header's own disc */
const feedCount = () => (viewHTML().match(/<div class="card" data-split=/g) || []).length;

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
   barHTML().indexOf("setTab('exercises')") >= 0 && barHTML().indexOf("startWorkout()") >= 0);
eq("every crew session the server sent renders", feedCount(), CREWFEED.length);
ok("cards carry the full exercise list", viewHTML().indexOf("Barbell Bench Press") >= 0 &&
   viewHTML().indexOf("Romanian Deadlift") >= 0);
ok("a person gets initials, not a bare name", viewHTML().indexOf(">DR<") >= 0);
ok("each person keeps their own colour",
   viewHTML().indexOf('data-person="p1"') >= 0 && viewHTML().indexOf('data-person="p2"') >= 0);
eq("three people get three distinct colours",
   new Set(Object.keys(sandbox.FEEDP).map(k => sandbox.FEEDP[k].person)).size, 3);
ok("a name the server did not send never appears",
   viewHTML().indexOf("Mark Miller") < 0);
ok("cardio in the feed reads as time, not weight",
   viewHTML().indexOf("min cardio") >= 0);
ok("crew cards are not buttons",
   viewHTML().indexOf('<button class="card"') < 0);

/* sharing is opt-in and per session */
group("Sharing a session");

sandbox.setHome("mine");
sandbox.openSession("s3");
ok("a finished session offers Share", viewHTML().indexOf("toggleShare()") >= 0);
ok("an old session is unshared until you say so",
   S().sessions.filter(x => x.id === "s3")[0].shared === undefined);
sandbox.toggleShare();
eq("sharing flags that session", S().sessions.filter(x => x.id === "s3")[0].shared, true);
ok("the button flips to Shared", viewHTML().indexOf("Shared") >= 0);
sandbox.goHome(); sandbox.setHome("crew");
eq("sharing alone does not fake it into the feed", feedCount(), CREWFEED.length);

/* ...it appears when the server sends it back, which is what a sync does */
const s3 = S().sessions.filter(x => x.id === "s3")[0];
setFeed([{ id: "me:s3", who: "me", name: "Mark Miller", initials: "MM", mine: true,
           date: s3.date, split: s3.split, ex: s3.ex, from: null }].concat(CREWFEED));
sandbox.render();
eq("once synced it is in the feed", feedCount(), CREWFEED.length + 1);
ok("your own entry is marked", viewHTML().indexOf('data-person="me"') >= 0 &&
   viewHTML().indexOf(">You<") >= 0);
ok("your own card offers 'Do it again'", viewHTML().indexOf("Do it again") >= 0);
ok("the feed is in the order the server sent",
   viewHTML().indexOf("Danny") < viewHTML().indexOf("Sam"));
sandbox.openSession("s3"); sandbox.toggleShare();
ok("unsharing clears the flag", S().sessions.filter(x => x.id === "s3")[0].shared === undefined);
setFeed(CREWFEED.slice());
sandbox.goHome(); sandbox.setHome("crew");
eq("feed is back to the crew's own", feedCount(), CREWFEED.length);
sandbox.setHome("mine");

/* ---- 10. likes and comments ---- */
group("Likes and comments");
sandbox.S.live = null;
sandbox.goHome(); sandbox.setHome("crew");
ok("seeded likes show a count", viewHTML().indexOf('<span class="n">2</span>') >= 0);
ok("nothing is liked by you at the start", !sandbox.liked("danny:f1"));
sandbox.toggleLike("danny:f1");
ok("liking records you", sandbox.liked("danny:f1"));
eq("and bumps the count", sandbox.soc("danny:f1").likes.length, 3);
ok("the button reflects it", viewHTML().indexOf('aria-pressed="true"') >= 0);
sandbox.toggleLike("danny:f1");
ok("liking again takes it back", !sandbox.liked("danny:f1"));
eq("count returns", sandbox.soc("danny:f1").likes.length, 2);

ok("threads are collapsed by default", viewHTML().indexOf('class="thread"') < 0);
ok("a card with no comments still offers Reply", viewHTML().indexOf("toggleThread('sam:f5')") >= 0);
sandbox.toggleThread("danny:f1");
ok("opening shows the thread", viewHTML().indexOf('class="thread"') >= 0);
ok("seeded comments render", viewHTML().indexOf("225 by November") >= 0);
ok("a commenter gets their own disc", viewHTML().indexOf('class="cmt" data-person="p2"') >= 0);
sandbox.document.getElementById("c_danny:f1").value = "  ";
sandbox.addComment("danny:f1");
eq("blank comments are ignored", sandbox.soc("danny:f1").comments.length, 2);
sandbox.document.getElementById("c_danny:f1").value = "Spot me next time";
sandbox.addComment("danny:f1");
eq("a comment is stored", sandbox.soc("danny:f1").comments.length, 3);
eq("posted as you", sandbox.soc("danny:f1").comments[2].who, "me");
ok("and shows in the thread", viewHTML().indexOf("Spot me next time") >= 0);
sandbox.toggleThread("danny:f1");
ok("toggling closes it again", viewHTML().indexOf('class="thread"') < 0);
ok("only one thread opens at a time",
   (sandbox.toggleThread("danny:f1"), sandbox.toggleThread("sam:f3"), sandbox.openThread === "sam:f3"));
sandbox.toggleThread("sam:f3");

/* ---- 11. running someone else's workout ---- */
group("Running someone else's workout");
const tess = CREWFEED.filter(f => f.id === "tess:f6")[0];
sandbox.doWorkout("tess:f6");
eq("no live workout means no prompt", sandbox.dlgOpen, false);
eq("their split carries over", S().live.split, tess.split);
eq("their movements carry over",
   JSON.stringify(S().live.ex.map(x => x.name)),
   JSON.stringify(tess.ex.map(x => x.name)));
ok("but none of their sets", S().live.ex.every(x => x.sets.length === 0));
eq("the copy remembers whose it was", S().live.from.who, "tess");
eq("and which session", S().live.from.src, "tess:f6");
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
sandbox.doWorkout("danny:f1");
ok("swapping a live workout asks first", sandbox.dlgOpen === true);
ok("the prompt counts what is at stake", els.dialog.innerHTML.indexOf("<b>1</b> set") >= 0);
sandbox.closeDialog();
eq("declining keeps your workout", S().live.from.src, "tess:f6");
sandbox.doWorkout("danny:f1"); sandbox.dialogYes();
eq("confirming swaps it", S().live.from.src, "danny:f1");
ok("and the old sets are gone", S().live.ex.every(x => x.sets.length === 0));

/* lineage is only countable once the copy is shared */
group("Lineage");
eq("an unfinished copy counts for nothing", sandbox.repeats("danny:f1"), 0);
/* stay on the live session: the entry fields only exist while it is open */
sandbox.resume();
sandbox.document.getElementById("f0_0").value = 8;
sandbox.document.getElementById("f0_1").value = 185;
sandbox.addSet(0);
sandbox.finish();
const copyId = S().sessions[S().sessions.length - 1].id;
eq("finishing keeps the lineage", S().sessions[S().sessions.length - 1].from.src, "danny:f1");
eq("an unshared copy still counts for nothing", sandbox.repeats("danny:f1"), 0);
sandbox.openSession(copyId); sandbox.toggleShare();
eq("sharing it alone still counts for nothing \u2014 the feed is the server's",
   sandbox.repeats("danny:f1"), 0);

/* the copy comes back down on the next sync, and only then is it countable */
const copy = S().sessions.filter(x => x.id === copyId)[0];
setFeed([{ id: "me:" + copyId, who: "me", name: "Mark Miller", initials: "MM",
           mine: true, date: copy.date, split: copy.split, ex: copy.ex,
           from: copy.from }].concat(CREWFEED));
eq("once the server has it, it counts", sandbox.repeats("danny:f1"), 1);
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
/* the calendar picker must never jump past the current month */
S().month = sandbox.today().slice(0, 7);
sandbox.render();
sandbox.openMonthPicker(S().month);
ok("the calendar can't jump into the future",
   (els.dialog.innerHTML.match(/ disabled/g) || []).length >= 12-(+sandbox.today().slice(5,7)));
sandbox.closeDialog();

/* ---- 10. the profile screen ---- */
group("Profile");
sandbox.openData();
ok("the screen is called Profile", viewHTML().indexOf(">Profile</h1>") >= 0);
ok("not Your data any more", viewHTML().indexOf("Your data") < 0);
ok("export is gone", viewHTML().indexOf("exportblob") < 0 &&
   viewHTML().indexOf("downloadExport") < 0);
ok("import is gone", viewHTML().indexOf("importblob") < 0 &&
   viewHTML().indexOf("askImport") < 0);
ok("it says what you have logged", viewHTML().indexOf("finished session") >= 0);
ok("sync still lives here", viewHTML().indexOf("Sync") >= 0);
ok("automatic sharing is on by default",
   viewHTML().indexOf("Automatically share new workouts") >= 0 &&
   viewHTML().indexOf('aria-pressed="true"') >= 0);
ok("and there is a way back", viewHTML().indexOf('onclick="goBack()"') >= 0);

/* The import test used to leave exactly one session behind, and the sync
   group below is written against that. Set it directly now that the only
   thing that could replace your whole history is gone. */
S().sessions = [{ id: "imported", date: "2026-07-04", split: "pull", ex: [] }];
S().month = "2026-07";
sandbox.goHome();

/* ---- 11. sync ----
 * Against a fake server that mirrors worker/index.js: last-write-wins per
 * session, tombstones for deletes, "everything changed since N" for pulls.
 * This is the riskiest code in the app and the part a DOM stub can still
 * exercise properly, because it is all state and promises.
 */
function fakeServer() {
  const api = {
    rows: new Map(), clock: 1000, puts: 0, dels: 0, unauthorized: false,
    feed: [], social: {}, people: {}, crew: [], posts: [], notifications: [],
    /* invites. Codes here are 32 digits rather than 32 hex characters --
       digits are hex, and it keeps them readable in a failure message. */
    invites: [], joins: 0, codes: 0, passwords: 0, followWrites: 0,
    /* accounts and the follow graph. `me` is whoever the cookie would name. */
    me: "me",
    users: [{ id: "me", username: "mark", name: "Mark Miller", initials: "MM",
              password: "longenough1" }],
    follows: new Set(),          /* "<follower>><followee>" */
    follow(a, b) { api.follows.add(a + ">" + b); },
    mutual(a, b) { return api.follows.has(a + ">" + b) && api.follows.has(b + ">" + a); },
    user(id) { return api.users.find(u => u.id === id); },
    pubUser(u) {
      return { id: u.id, name: u.name, initials: u.initials, username: u.username };
    },
    mkInvite(over) {
      const n = ++api.codes;
      const row = Object.assign(
        { id: "i" + n, code: String(n).padStart(32, "0"), createdBy: "Mark Miller",
          by: "me", created: Date.now(), expires: Date.now() + 48 * 3600e3,
          usedBy: null, revoked: 0 }, over || {});
      api.invites.push(row);
      return row;
    },
    /* the one place "is this link any good" is decided, mirroring redeem() */
    inviteError(r) {
      if (!r) return [404, "That invite link is not valid."];
      if (r.usedBy) return [410, "That invite has already been used."];
      if (r.revoked) return [410, "That invite was cancelled."];
      if (r.expires < Date.now()) return [410, "That invite has expired. Ask for a new link."];
      return null;
    },
    pub(r) {
      const now = Date.now();
      return { id: r.id, usedBy: r.usedBy, created: r.created, expires: r.expires,
               state: r.usedBy ? "used" : r.revoked ? "revoked"
                     : r.expires < now ? "expired" : "pending" };
    },
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
      else if (p === "/api/logout") out = { ok: true };
      else if (p === "/api/feed")
        out = { now: ++api.clock, items: api.feed, social: api.social,
                people: api.people, crew: api.crew,
                unread: api.notifications.filter(n => n.unread).length,
                counts: { following: Math.max(0, api.crew.length - 1),
                          followers: [...api.follows].filter(k => k.endsWith(">" + api.me)).length } };
      else if (p === "/api/notifications" && method === "GET")
        out = { items: api.notifications,
                unread: api.notifications.filter(n => n.unread).length };
      else if (p === "/api/notifications/read" && method === "POST") {
        api.notifications.forEach(n => { n.unread = 0; }); out = { unread: 0 };
      }
      else if (p === "/api/login" && method === "POST") {
        const u = api.users.find(x => x.username === String((body && body.username) || ""));
        if (!u || u.password !== String((body && body.password) || "")) {
          status = 401; out = { error: "Wrong username or password." };
        } else { api.me = u.id; out = { user: api.pubUser(u) }; }
      }
      else if (p === "/api/signup" && method === "POST") {
        const username = String((body && body.username) || "");
        const password = String((body && body.password) || "");
        const display = String((body && body.name) || "").trim();
        const r = api.invites.find(i => i.code === String((body && body.code) || ""));
        const bad = (body && body.code) ? api.inviteError(r) : null;
        if (!display) { status = 400; out = { error: "Enter the name you want on your workouts." }; }
        else if (!/^[a-z0-9][a-z0-9._]{2,19}$/.test(username)) {
          status = 400; out = { error: "Usernames are 3 to 20 characters." };
        } else if (password.length < 8) {
          status = 400; out = { error: "Passwords need at least 8 characters." };
        } else if (api.users.some(u => u.username === username)) {
          status = 409; out = { error: "That username is taken." };
        } else if (bad) { status = bad[0]; out = { error: bad[1] }; }
        else {
          const u = { id: "u" + (api.users.length + 1), username, name: display,
                      initials: "XX", password };
          api.users.push(u);
          api.me = u.id;
          if (r) { r.usedBy = display; api.follow(u.id, r.by); api.follow(r.by, u.id); }
          out = { user: api.pubUser(u) };
        }
      }
      else if (p === "/api/password" && method === "POST") {
        const u = api.user(api.me);
        if (!u || u.password !== String((body && body.current) || "")) {
          status = 401; out = { error: "That is not your current password." };
        } else if (String((body && body.next) || "").length < 8) {
          status = 400; out = { error: "Passwords need at least 8 characters." };
        } else { u.password = body.next; api.passwords++; out = { ok: true }; }
      }
      else if (p === "/api/users" && method === "GET") {
        const q = (new URLSearchParams(qs || "").get("q") || "").toLowerCase();
        out = { people: api.users
          .filter(u => u.username.indexOf(q) >= 0 || u.name.toLowerCase().indexOf(q) >= 0)
          .map(u => Object.assign(api.pubUser(u), {
            following: api.follows.has(api.me + ">" + u.id), mine: u.id === api.me })) };
      }
      else if (p === "/api/follow" && method === "POST") {
        const id = String((body && body.id) || "");
        if (!api.user(id)) { status = 404; out = { error: "No such person." }; }
        else {
          api.followWrites++;
          if (body.on) api.follow(api.me, id); else api.follows.delete(api.me + ">" + id);
          out = { id, following: !!body.on };
        }
      }
      else if (method === "POST" && /^\/api\/invite\/[^/]+\/accept$/.test(p)) {
        const r = api.invites.find(i => i.code === p.split("/")[3]);
        const bad = api.inviteError(r);
        if (bad) { status = bad[0]; out = { error: bad[1] }; }
        else {
          r.usedBy = (api.user(api.me) || {}).name || api.me;
          api.follow(api.me, r.by); api.follow(r.by, api.me);
          out = { ok: true, followed: r.by };
        }
      }
      else if (p === "/api/social" && method === "POST") { api.posts.push(body); out = { ok: true }; }
      else if (p.startsWith("/api/invite/")) {
        const r = api.invites.find(i => i.code === p.slice("/api/invite/".length));
        const bad = api.inviteError(r);
        if (bad) { status = bad[0]; out = { error: bad[1] }; }
        else out = { ok: true, from: r.createdBy, expires: r.expires };
      }
      else if (p === "/api/invites" && method === "GET")
        out = { now: Date.now(), invites: api.invites.map(r => api.pub(r)) };
      else if (p === "/api/invites" && method === "POST") {
        const r = api.mkInvite();
        out = { id: r.id, code: r.code, expires: r.expires, state: "pending",
                url: "https://rack.example/join/" + r.code };
      }
      else if (method === "POST" && /^\/api\/invites\/[^/]+\/revoke$/.test(p)) {
        const r = api.invites.find(i => i.id === p.split("/")[3]);
        if (!r || r.usedBy) { status = 404; out = { error: "That invite is already used or gone." }; }
        else { r.revoked = 1; out = { ok: true, id: r.id }; }
      }
      else if (p === "/api/join" && method === "POST") {
        api.joins++;
        const display = String((body && body.name) || "").trim();
        const pin = String((body && body.pin) || "");
        const r = api.invites.find(i => i.code === String((body && body.code) || ""));
        const bad = api.inviteError(r);
        if (!display || display.length > 40) {
          status = 400; out = { error: "Enter the name you want on your workouts." };
        } else if (!/^\d{6,12}$/.test(pin)) {
          status = 400; out = { error: "Pick a PIN of 6 to 12 digits." };
        } else if (bad) { status = bad[0]; out = { error: bad[1] }; }
        else {
          r.usedBy = display;
          out = { name: display.toLowerCase(),
                  user: { id: "u" + r.id, name: display, initials: "RM" } };
        }
      }
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

  ok("signed in, the profile screen names you and offers a way out",
     sandbox.authSection().indexOf("Signed in as") >= 0 &&
     sandbox.authSection().indexOf("askSignOut()") >= 0);
  ok("and there is no Sync now button to tap",
     sandbox.authSection().indexOf("Sync now") < 0 &&
     sandbox.authSection().indexOf("syncNow") < 0);

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
  ok("the password form is still there alongside it",
     sandbox.authSection().indexOf('id="loginpass"') >= 0);

  /* a server without credentials must not advertise it */
  sandbox.SY.google = false;
  ok("no button when the server has no Google credentials",
     sandbox.authSection().indexOf("google") < 0);

  /* and the standalone copy never shows it, whatever SY says */
  sandbox.SY.google = true;
  sandbox.API = false;
  ok("never offered when there is no server at all",
     sandbox.authSection().indexOf("google") < 0);

  /* ---- 12. the login gate ---- */
  group("The door");
  sandbox.API = null;
  sandbox.render();
  ok("before the server answers, only a plain loading background",
     viewHTML().indexOf('class="bootscreen"') >= 0 &&
     viewHTML().indexOf('splash.jpg') < 0);
  eq("and no bottom nav to tap", barHTML(), "");

  sandbox.API = true;
  sandbox.SY.user = null;
  sandbox.SY.google = false;
  sandbox.view = { name: "home" };
  sandbox.render();
  ok("signed out on a server, the door is all there is",
     viewHTML().indexOf('id="loginpass"') >= 0 && viewHTML().indexOf("calgrid") < 0);
  ok("and it offers a way to make an account, not only to use one",
     viewHTML().indexOf("gateMode('new')") >= 0);
  ok("no calendar, no crew, no export", viewHTML().indexOf("openData()") < 0);
  ok("and no way to start a workout", barHTML().indexOf("startWorkout()") < 0);
  sandbox.view = { name: "data" };
  sandbox.render();
  ok("the door cannot be routed around",
     viewHTML().indexOf(">Profile</h1>") < 0 && viewHTML().indexOf("askSignOut()") < 0);
  sandbox.SY.google = true;
  sandbox.render();
  ok("it offers Google when the server does",
     viewHTML().indexOf("/api/auth/google/start") >= 0);

  /* a copy with no server has nobody to sign in as, so it is never gated --
     that is what keeps file://, the artifact and these tests working */
  sandbox.API = false;
  sandbox.view = { name: "home" };
  sandbox.render();
  ok("a standalone copy is never gated", viewHTML().indexOf("calgrid") >= 0);

  /* ---- 13. one store per account ---- */
  group("One store per account");
  const keyOf = (u) => "racklog.proto.v2:" + u;
  /* the groups above left a store under the bare key; adoption gets its own
     test below, so start these accounts on a genuinely clean device */
  store.delete("racklog.proto.v2");
  sandbox.loadStore("ann");
  S().sessions.push({ id: "a1", date: "2026-08-02", split: "push", ex: [] });
  sandbox.saveLocal();
  sandbox.loadStore("bob");
  eq("a second account opens an empty store", S().sessions.length, 0);
  S().sessions.push({ id: "b1", date: "2026-08-03", split: "pull", ex: [] });
  sandbox.saveLocal();
  sandbox.loadStore("ann");
  eq("the first account still has its own", S().sessions.length, 1);
  eq("and none of the other's", S().sessions[0].id, "a1");
  ok("they are separate keys on the device",
     store.has(keyOf("ann")) && store.has(keyOf("bob")));

  /* history logged before accounts existed belongs to whoever signs in first */
  store.set("racklog.proto.v2", JSON.stringify({ sessions:
    [{ id: "old1", date: "2026-07-01", split: "legs", ex: [] }] }));
  sandbox.loadStore("cass");
  eq("a device's pre-account history is adopted", S().sessions[0].id, "old1");
  ok("and the shared key is cleared, so a second account cannot claim it too",
     !store.has("racklog.proto.v2"));
  sandbox.loadStore("dee");
  eq("the next account starts empty", S().sessions.length, 0);

  /* ---- 14. signing out on a shared phone ---- */
  group("Signing out on a shared phone");
  const shared = fakeServer();
  sandbox.fetch = (p, o) => shared.fetch(p, o);
  sandbox.API = true;
  sandbox.SY.user = { id: "ann", name: "Ann Miller", initials: "AM" };
  sandbox.loadStore("ann");
  S().sessions.push({ id: "a9", date: "2026-08-04", split: "push", ex: [] });
  sandbox.saveLocal();
  await sandbox.signOut();
  ok("what was logged goes up before the door closes", shared.rows.has("a9"));
  eq("you are signed out", sandbox.SY.user, null);
  eq("the workouts leave memory", S().sessions.length, 0);
  ok("and the account's store leaves the phone", !store.has(keyOf("ann")));
  sandbox.render();
  ok("the door is showing again", viewHTML().indexOf('id="loginpass"') >= 0);

  /* the one case where the data stays: it never made it to the server */
  sandbox.SY.user = { id: "ann", name: "Ann Miller", initials: "AM" };
  sandbox.loadStore("ann");
  S().sessions.push({ id: "a10", date: "2026-08-05", split: "pull", ex: [] });
  sandbox.saveLocal();
  shared.unauthorized = true;
  await sandbox.signOut();
  ok("an unsent workout is not deleted with the account", store.has(keyOf("ann")));
  ok("and it says why", sandbox.syncMsg.indexOf("kept on this device") >= 0);
  ok("it is still unreachable to the next person, under that account's key",
     JSON.parse(store.get(keyOf("ann"))).sessions.some(x => x.id === "a10"));

  /* a live workout never reaches the server, so signing out has to say so */
  sandbox.SY.user = { id: "ann", name: "Ann Miller", initials: "AM" };
  sandbox.loadStore("ann");
  sandbox.startWorkout();
  sandbox.askSignOut();
  ok("signing out mid-workout asks first", sandbox.dlgOpen === true);
  ok("and names what is at stake", els.dialog.innerHTML.indexOf("hasn’t been saved") >= 0);
  sandbox.closeDialog();
  ok("keeping the workout keeps you signed in", sandbox.SY.user !== null);
  S().live = null;
  sandbox.askSignOut();
  ok("with nothing live it just signs out", sandbox.dlgOpen === false);
  await new Promise((r) => process.nextTick(r));

  /* ---- 15. likes and comments cross users ---- */
  group("Likes and comments reach the crew");
  const crew = fakeServer();
  sandbox.fetch = (p, o) => crew.fetch(p, o);
  sandbox.API = true;
  sandbox.SY.user = { id: "me", name: "Mark Miller", initials: "MM" };
  sandbox.loadStore("me");
  crew.feed = CREWFEED.slice();
  crew.social = { "danny:f1": { likes: ["sam"], comments: [{ who: "tess", text: "Big pull." }] } };
  crew.people = { danny: { name: "Danny Ruiz", initials: "DR" },
                  sam: { name: "Sam Okonkwo", initials: "SO" },
                  tess: { name: "Tess Lindqvist", initials: "TL" } };
  await sandbox.sync();
  eq("the feed carries engagement with it", sandbox.soc("danny:f1").likes.length, 1);
  eq("comments come down too", sandbox.soc("danny:f1").comments.length, 1);
  sandbox.goHome(); sandbox.setHome("crew"); sandbox.toggleThread("danny:f1");
  ok("someone else's comment renders", viewHTML().indexOf("Big pull.") >= 0);
  ok("and a commenter gets a name, not a row id", viewHTML().indexOf(">Tess<") >= 0);

  sandbox.toggleLike("danny:f1");
  eq("a like is posted to the server", crew.posts.length, 1);
  eq("on the right item", crew.posts[0].item, "danny:f1");
  eq("as a like", crew.posts[0].kind, "like");
  eq("with an explicit saved state", crew.posts[0].on, true);
  ok("and never carries who — the server reads that off the cookie",
     crew.posts[0].who === undefined);
  ok("it shows immediately, before the round trip", sandbox.liked("danny:f1"));
  sandbox.toggleLike("danny:f1");
  eq("unliking posts an explicit removed state", crew.posts[1].on, false);
  sandbox.toggleLike("danny:f1");
  sandbox.document.getElementById("c_danny:f1").value = "Spot me next time";
  sandbox.addComment("danny:f1");
  eq("a comment is posted too", crew.posts[3].kind, "comment");
  eq("with its text", crew.posts[3].text, "Spot me next time");
  eq("and nothing else", crew.posts[3].who, undefined);

  /* the server is the truth: a pull replaces whatever the tap did locally */
  crew.social = {};
  await sandbox.sync();
  eq("a sync takes the server's version, not the device's",
     sandbox.soc("danny:f1").likes.length, 0);

  /* ---- 16. sharing is the default ---- */
  group("Sharing is the default");
  S().live = null;
  sandbox.goHome();
  sandbox.startWorkout();
  sandbox.pick("Bench", "lift", "push");
  sandbox.document.getElementById("f0_0").value = 8;
  sandbox.document.getElementById("f0_1").value = 135;
  sandbox.addSet(0);
  sandbox.finish();
  const fresh = S().sessions[S().sessions.length - 1];
  eq("a finished workout is shared without being asked", fresh.shared, true);
  sandbox.openSession(fresh.id);
  ok("the session says so", viewHTML().indexOf("Shared") >= 0);
  sandbox.toggleShare();
  ok("and one tap opts back out", fresh.shared === undefined);
  sandbox.openData();
  sandbox.toggleAutoShare();
  ok("a user can disable automatic sharing",
     S().autoShare === false && viewHTML().indexOf('aria-pressed="false"') >= 0);
  sandbox.startWorkout();
  sandbox.pick("Squat", "lift", "legs");
  sandbox.document.getElementById("f0_0").value = 5;
  sandbox.document.getElementById("f0_1").value = 185;
  sandbox.addSet(0);
  sandbox.finish();
  const privateFresh = S().sessions[S().sessions.length - 1];
  ok("new workouts stay private after it is disabled", privateFresh.shared === undefined);
  sandbox.toggleAutoShare();
  ok("an empty workout is still no workout at all",
     (sandbox.startWorkout(), sandbox.finish(), S().sessions.indexOf(S().live) < 0));

  /* ---- 17. the header names you ---- */
  group("Your name in the corner");
  S().live = null;
  sandbox.goHome();
  ok("the header names you instead of saying Data",
     viewHTML().indexOf('class="userbtn"') >= 0 && viewHTML().indexOf(">Data<") < 0);
  ok("with your initials and your first name",
     viewHTML().indexOf(">MM<") >= 0 && viewHTML().indexOf(">Mark<") >= 0);
  ok("and it opens the notifications inbox", viewHTML().indexOf('onclick="openNotifications()"') >= 0);
  ok("you are ink, never a split colour",
     viewHTML().indexOf('class="who" data-person="me"') >= 0);
  crew.notifications = [{ id:"n1", item_id:"danny:f1", kind:"comment", body:"Strong work",
    workout_date:"2026-08-28", workout_split:"pull", created:Date.now(), unread:1,
    actor_name:"Danny Ruiz", actor_initials:"DR" }];
  sandbox.SY.unread = 1; sandbox.render();
  ok("unread activity puts a counter on the user icon", viewHTML().indexOf('class="notifybadge">1<') >= 0);
  sandbox.openNotifications();
  await new Promise((r) => process.nextTick(r));
  ok("the inbox names who commented and what they said",
     viewHTML().indexOf("Danny Ruiz") >= 0 && viewHTML().indexOf("Strong work") >= 0);
  ok("the inbox identifies the workout", viewHTML().indexOf("Pull workout") >= 0);
  eq("opening the inbox clears the unread counter", sandbox.SY.unread, 0);
  sandbox.goHome();

  /* ---- 18. no History button, and the way back ---- */
  group("The way back");
  S().live = null;
  sandbox.goHome();
  ok("the bottom nav has no History button", barHTML().indexOf("setTab('history')") < 0);
  ok("it still starts a workout and reaches Exercises",
     barHTML().indexOf("startWorkout()") >= 0 && barHTML().indexOf("setTab('exercises')") >= 0);
  eq("home is still the calendar", screen(), "home/calendar");
  ok("the landing screen needs no back button of its own",
     viewHTML().indexOf("Rack Log</button>") < 0);
  sandbox.setTab("exercises");
  eq("Exercises is one tap away", screen(), "home/exercises");
  ok("and carries its own way back to Rack Log",
     viewHTML().indexOf("&lsaquo; Rack Log") >= 0 &&
     viewHTML().indexOf("setTab('history')") >= 0);
  sandbox.setTab("history");
  eq("which lands on the calendar", screen(), "home/calendar");

  /* ---- 19. searching your exercises ---- */
  group("Searching your exercises");
  /* A full render puts the list inside the view's HTML; typing rewrites only
     the #exlist element. The stub cannot nest one in the other, so read
     whichever one the last write went to. */
  const exList = () =>
    sandbox.document.getElementById("exlist").innerHTML || viewHTML();
  const exCount = () => (exList().match(/onclick="openExercise\(/g) || []).length;
  sandbox.exQuery = "";
  sandbox.setTab("exercises");
  const allEx = exCount();
  ok("every logged movement is listed", allEx >= 1);
  ok("there is a search box", viewHTML().indexOf('id="exq"') >= 0);

  sandbox.document.getElementById("exq").value = "bench";
  sandbox.filterExercises();
  ok("searching narrows the list", exCount() >= 1 && exCount() <= allEx);
  ok("and keeps the match", exList().indexOf("Bench") >= 0);

  sandbox.document.getElementById("exq").value = "BENCH";
  sandbox.filterExercises();
  ok("search ignores case", exList().indexOf("Bench") >= 0);

  sandbox.document.getElementById("exq").value = "zzzz";
  sandbox.filterExercises();
  eq("no match lists nothing", exCount(), 0);
  ok("and it says so, naming what you typed", exList().indexOf("zzzz") >= 0);
  /* the header must NOT be rebuilt on a keystroke, or the box loses focus */
  ok("typing does not redraw the search box", viewHTML().indexOf('value="zzzz"') < 0);

  sandbox.render();
  ok("but a background redraw keeps what you typed",
     viewHTML().indexOf('value="zzzz"') >= 0);
  sandbox.document.getElementById("exq").value = "";
  sandbox.filterExercises();
  eq("clearing brings them all back", exCount(), allEx);
  sandbox.setTab("history");

  /* ---- 20. who is in the crew ---- */
  group("Who is in the crew");
  crew.feed = CREWFEED.slice();
  crew.crew = [{ id: "me", name: "Mark Miller", initials: "MM", mine: true },
               { id: "danny", name: "Danny Ruiz", initials: "DR" },
               { id: "sam", name: "Sam Okonkwo", initials: "SO" },
               { id: "tess", name: "Tess Lindqvist", initials: "TL" }];
  for (const c of crew.crew) if (!c.mine) crew.follow("me", c.id);
  await sandbox.sync();
  sandbox.setHome("crew");
  ok("the crew tab says who is in the crew", viewHTML().indexOf('class="roster"') >= 0);
  ok("it counts them", viewHTML().indexOf("3 following") >= 0);
  ok("somebody who has never shared is still on the roster",
     viewHTML().indexOf(">Sam<") >= 0);
  ok("and so is somebody who only ever commented", viewHTML().indexOf(">Tess<") >= 0);

  /* alone on a server, an empty feed has to explain itself */
  crew.feed = []; crew.social = {};
  crew.crew = [{ id: "me", name: "Mark Miller", initials: "MM", mine: true }];
  await sandbox.sync();
  ok("alone, it says the crew is just you", viewHTML().indexOf("just you") >= 0);
  ok("and how somebody gets added",
     viewHTML().indexOf("Search for somebody") >= 0 &&
     viewHTML().indexOf("invite link") >= 0);
  ok("the roster shows even with nothing in the feed",
     viewHTML().indexOf('class="roster"') >= 0 &&
     viewHTML().indexOf("Nothing here yet") >= 0);

  /* ---- 21. the feed stays where you left it ---- */
  group("The feed stays where you left it");
  crew.feed = CREWFEED.slice();
  await sandbox.sync();
  sandbox.setHome("crew");
  eq("opening the feed starts at the top", scrollEl.scrollTop, 0);
  scrollEl.scrollTop = 420;
  await sandbox.sync();
  eq("a background sync leaves it where you scrolled to", scrollEl.scrollTop, 420);
  scrollEl.scrollTop = 300;
  sandbox.toggleLike("danny:f1");
  eq("so does tapping a like", scrollEl.scrollTop, 300);
  sandbox.setHome("mine");
  eq("but switching to Mine starts at the top", scrollEl.scrollTop, 0);
  scrollEl.scrollTop = 180;
  sandbox.render();
  eq("a plain redraw of the same screen keeps the offset", scrollEl.scrollTop, 180);
  sandbox.openData();
  eq("and opening another screen starts at the top", scrollEl.scrollTop, 0);
  sandbox.goBack();

  /* ---- 22. coming back online ---- */
  group("Coming back online");
  const back = fakeServer();
  sandbox.fetch = (p, o) => back.fetch(p, o);
  sandbox.API = true;
  sandbox.SY.user = { id: "me", name: "Mark Miller", initials: "MM" };
  sandbox.loadStore("me");
  sandbox.SY.since = 0; sandbox.SY.shadow = {};
  S().sessions.push({ id: "offline1", date: "2026-08-06", split: "push", ex: [] });
  sandbox.saveLocal();

  const online = (winListeners.online || [])[0];
  ok("the app listens for the network coming back", typeof online === "function");
  eq("and only registers that once", (winListeners.online || []).length, 1);

  sandbox.syncMsg = "Offline. Your workouts are safe on this device.";
  online();
  ok("coming back online starts a sync with nothing tapped", sandbox.syncing === true);
  eq("and takes the offline message down as it goes", sandbox.syncMsg, "");
  for (let i = 0; i < 100 && sandbox.syncing; i++) await new Promise((r) => setTimeout(r, 0));
  ok("what was logged offline reaches the server", back.rows.has("offline1"));
  eq("and nothing is left waiting", sandbox.dirtyOps().length, 0);

  const pageshow = (winListeners.pageshow || [])[0];
  ok("the app listens for Android restoring an old page", typeof pageshow === "function");
  sandbox.view = { name: "data" };
  pageshow({ persisted: true });
  eq("Android Back returns a signed-in person to Home", sandbox.view.name, "home");
  ok("and keeps the signed-in account", sandbox.SY.user && sandbox.SY.user.id === "me");

  /* ---- 23. joining by an invite link ----
   * The code arrives on the URL, because the link gets texted to somebody.
   * Since signup opened, an invite is no longer the door -- it is the
   * handshake -- so this door has to work for a stranger AND for somebody who
   * already has an account.
   */
  group("Joining by an invite link");
  const inv = fakeServer();
  sandbox.fetch = (p, o) => inv.fetch(p, o);
  sandbox.API = true;
  sandbox.SY.user = null;
  sandbox.SY.google = false;
  let replaced = 0;
  sandbox.history = { replaceState() { replaced++; } };
  /* a real timer turn, which drains every pending promise the fetch made */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const field = (id) => sandbox.document.getElementById(id);
  const open = async (code) => {
    sandbox.location = { pathname: code ? "/join/" + code : "/" };
    sandbox.JOIN = { code: "", state: "", from: null, error: "" };
    sandbox.checkInvite();
    await settle();
    sandbox.render();
  };

  sandbox.location = { pathname: "/join/not-a-code" };
  eq("a path that only looks like an invite is not one", sandbox.joinCode(), "");
  sandbox.location = { pathname: "/" };
  eq("and the ordinary address carries no code", sandbox.joinCode(), "");

  const good = inv.mkInvite();
  await open(good.code);
  ok("an invite link says who wants you, in their words",
     viewHTML().indexOf("<b>Mark</b> wants you to join their crew.") >= 0);
  ok("and what to do about it",
     viewHTML().indexOf("Create your account or sign in to join.") >= 0);
  ok("it opens on the sign-up half, since a stranger has no account",
     viewHTML().indexOf('id="newdisplay"') >= 0 &&
     viewHTML().indexOf("createAccount()") >= 0);
  ok("with a way over to signing in", viewHTML().indexOf("gateMode('in')") >= 0);

  /* the three dead links, each said plainly instead of a shrug */
  await open(inv.mkInvite({ expires: Date.now() - 1000 }).code);
  ok("an expired link says so before asking anybody to pick a username",
     viewHTML().indexOf("expired") >= 0 && viewHTML().indexOf('id="loginpass"') < 0);
  await open(inv.mkInvite({ usedBy: "Somebody Else" }).code);
  ok("a spent link says it is spent", viewHTML().indexOf("already been used") >= 0);
  await open("0000000000000000000000000000ffff");
  ok("a code nobody ever issued is refused",
     viewHTML().indexOf("not valid") >= 0 && viewHTML().indexOf('id="loginpass"') < 0);
  ok("and every dead end still offers the way in",
     viewHTML().indexOf('href="/"') >= 0);

  /* nothing malformed reaches the server: it is a round trip that can only
     ever say no, and the answer is already known here */
  await open(good.code);
  const before = inv.users.length;
  field("newdisplay").value = "";
  field("loginname").value = "robin";
  field("loginpass").value = "longenough1";
  sandbox.createAccount();
  ok("a blank display name is refused here",
     field("authmsg").textContent.indexOf("name you want") >= 0);
  field("newdisplay").value = "Robin Miller";
  field("loginname").value = "Robin Miller";
  sandbox.createAccount();
  ok("so is a username with a space in it",
     field("authmsg").textContent.indexOf("3 to 20 characters") >= 0);
  field("loginname").value = "robin";
  field("loginpass").value = "short";
  sandbox.createAccount();
  ok("and a password under eight characters",
     field("authmsg").textContent.indexOf("8 characters") >= 0);
  eq("none of which made an account", inv.users.length, before);

  field("loginpass").value = "longenough1";
  sandbox.createAccount();
  await settle();
  ok("a good one signs you in", sandbox.SY.user && sandbox.SY.user.name === "Robin Miller");
  eq("under the username you picked", sandbox.SY.user.username, "robin");
  eq("the invite is spent by it", inv.invites.find(i => i.id === good.id).usedBy,
     "Robin Miller");
  ok("and it makes the two of you follow each other",
     inv.mutual(sandbox.SY.user.id, "me"));
  eq("the code is taken out of the address bar", replaced, 1);
  eq("and the join screen is done with", sandbox.JOIN.code, "");
  sandbox.render();
  eq("you land on the calendar", screen(), "home/calendar");
  eq("with no workouts to your name yet", S().sessions.length, 0);

  /* the other half of "create your account or sign in": somebody who already
     has one, following a link from a phone that is signed out */
  inv.users.push({ id: "danny", username: "danny", name: "Danny Ruiz",
                   initials: "DR", password: "dannypassword" });
  const fromDanny = inv.mkInvite({ by: "danny", createdBy: "Danny Ruiz" });
  sandbox.SY.user = null;
  await open(fromDanny.code);
  ok("the link names whoever sent it, not whoever it reaches",
     viewHTML().indexOf("<b>Danny</b> wants you") >= 0);
  sandbox.gateMode("in");
  ok("switching to Sign in drops the display-name field",
     viewHTML().indexOf('id="newdisplay"') < 0 && viewHTML().indexOf("signIn()") >= 0);
  field("loginname").value = "mark";
  field("loginpass").value = "longenough1";
  sandbox.signIn();
  await settle();
  eq("signing in through an invite signs you in", sandbox.SY.user.username, "mark");
  ok("spends the code", !!inv.invites.find(i => i.id === fromDanny.id).usedBy);
  ok("and follows you both ways", inv.mutual("me", "danny"));
  eq("the code leaves the address bar there too", replaced, 2);

  sandbox.SY.user = null;
  sandbox.SY.google = true;
  const viaGoogle = inv.mkInvite();
  await open(viaGoogle.code);
  ok("the Google door carries the invite with it, or it would connect nobody",
     viewHTML().indexOf("/api/auth/google/start?invite=" + viaGoogle.code) >= 0);
  sandbox.SY.google = false;

  /* ---- 24. an invite that reaches somebody already signed in ---- */
  group("An invite you open while signed in");
  sandbox.SY.user = { id: "me", name: "Mark Miller", initials: "MM", username: "mark" };
  inv.me = "me";
  sandbox.loadStore("me");
  const waiting = inv.mkInvite({ by: "danny", createdBy: "Danny Ruiz" });
  await open(waiting.code);
  ok("there is no form to fill in, because there is no account to make",
     viewHTML().indexOf('id="loginpass"') < 0 && viewHTML().indexOf('id="newdisplay"') < 0);
  ok("it says who is asking and who you are",
     viewHTML().indexOf("<b>Danny</b> wants you") >= 0 &&
     viewHTML().indexOf("signed in as <b>Mark Miller</b>") >= 0);
  ok("and offers one button", viewHTML().indexOf("acceptInvite()") >= 0);
  ok("with a way to decline it", viewHTML().indexOf("dismissJoin()") >= 0);

  inv.follows.delete("me>danny"); inv.follows.delete("danny>me");
  sandbox.acceptInvite();
  await settle();
  ok("accepting follows you both ways", inv.mutual("me", "danny"));
  ok("spends the code", !!inv.invites.find(i => i.id === waiting.id).usedBy);
  eq("clears the invite", sandbox.JOIN.code, "");
  eq("takes it out of the address bar", replaced, 3);
  eq("and drops you on the crew tab, where they now are", S().home, "crew");

  const declined = inv.mkInvite({ by: "danny", createdBy: "Danny Ruiz" });
  await open(declined.code);
  sandbox.dismissJoin();
  eq("declining leaves the code unspent",
     inv.invites.find(i => i.id === declined.id).usedBy, null);
  eq("and puts you back in the app", sandbox.JOIN.code, "");

  /* ---- 25. handing one out ---- */
  group("Handing out an invite");
  sandbox.JOIN = { code: "", state: "", from: null, error: "" };
  sandbox.location = { pathname: "/" };
  sandbox.openData();
  await settle();
  ok("the profile screen offers a way to invite somebody",
     viewHTML().indexOf("newInvite()") >= 0);
  ok("and is honest about what an invite does now",
     viewHTML().indexOf("follows you and you follow them") >= 0);
  ok("an invite somebody took is listed under their name",
     viewHTML().indexOf("Joined") >= 0 && viewHTML().indexOf("Robin Miller") >= 0);
  ok("a spent invite cannot be cancelled",
     viewHTML().indexOf("revokeInvite(&#39;" + good.id) < 0 &&
     viewHTML().indexOf("revokeInvite('" + good.id) < 0);

  sandbox.newInvite();
  await settle();
  const link = sandbox.INV.fresh;
  ok("a new link is shown once, in full",
     viewHTML().indexOf('id="invitelink"') >= 0 && viewHTML().indexOf(link.url) >= 0);
  ok("with when it dies and that it works once",
     /Expires in \d+ hours?, and works once/.test(viewHTML()));
  ok("and what taking it does", viewHTML().indexOf("follows you, and you follow them") >= 0);
  ok("a waiting invite can be cancelled", viewHTML().indexOf("Waiting") >= 0 &&
     viewHTML().indexOf("revokeInvite(") >= 0);

  sandbox.revokeInvite(link.id);
  await settle();
  eq("cancelling takes it out of use", inv.invites.find(i => i.id === link.id).revoked, 1);
  ok("the row says so", viewHTML().indexOf("Cancelled") >= 0);
  ok("and the link stops being shown", viewHTML().indexOf(link.url) < 0);
  ok("no code is ever printed on the list itself",
     viewHTML().indexOf(good.code) < 0 && viewHTML().indexOf(link.code) < 0);

  sandbox.SY.user = null;
  await open(link.code);
  ok("and the cancelled link is a dead end for whoever has it",
     viewHTML().indexOf("cancelled") >= 0 && viewHTML().indexOf('id="loginpass"') < 0);

  /* ---- 26. finding people, and following them ---- */
  group("Finding people and following them");
  const net = fakeServer();
  sandbox.fetch = (p, o) => net.fetch(p, o);
  sandbox.API = true;
  sandbox.JOIN = { code: "", state: "", from: null, error: "" };
  sandbox.SY.user = { id: "me", name: "Mark Miller", initials: "MM", username: "mark" };
  net.me = "me";
  net.users.push(
    { id: "sam", username: "sam.o", name: "Sam Okonkwo", initials: "SO", password: "x" },
    { id: "tess", username: "tessl", name: "Tess Lindqvist", initials: "TL", password: "x" });
  sandbox.loadStore("me");
  sandbox.FIND = { q: "", people: null };
  sandbox.goHome();
  sandbox.setHome("crew");
  const findOut = () =>
    sandbox.document.getElementById("findlist").innerHTML || viewHTML();
  const type = async (q) => {
    sandbox.document.getElementById("findlist").innerHTML = "";
    field("findq").value = q;
    sandbox.findPeople();
    await settle();
  };

  ok("the crew tab has a way to find people", viewHTML().indexOf('id="findq"') >= 0);
  ok("and a way to invite one", viewHTML().indexOf("newInvite()") >= 0);

  await type("sam");
  ok("searching lists who matches", findOut().indexOf("Sam Okonkwo") >= 0);
  ok("by their username too", findOut().indexOf("@sam.o") >= 0);
  ok("with a Follow button", findOut().indexOf("toggleFollow(") >= 0);
  ok("and nobody who does not match", findOut().indexOf("Tess") < 0);

  const writes = net.followWrites;
  sandbox.toggleFollow("sam");
  ok("tapping Follow shows immediately, before the round trip",
     findOut().indexOf("Following") >= 0);
  await settle();
  eq("and reaches the server", net.followWrites, writes + 1);
  ok("which is now following them", net.follows.has("me>sam"));
  ok("following is instant — there is no request to approve",
     findOut().indexOf("Requested") < 0 && findOut().indexOf("Approve") < 0);

  sandbox.toggleFollow("sam");
  await settle();
  ok("tapping again unfollows", !net.follows.has("me>sam"));
  ok("and the button goes back", findOut().indexOf(">Follow<") >= 0);

  await type("mark");
  ok("you are findable too", findOut().indexOf("Mark Miller") >= 0);
  ok("but there is no following yourself",
     findOut().indexOf("toggleFollow('me')") < 0 && findOut().indexOf("You") >= 0);

  await type("zzzz");
  ok("nobody matching says so, naming what you typed",
     findOut().indexOf("Nobody matching") >= 0 && findOut().indexOf("zzzz") >= 0);
  /* the header must NOT be rebuilt on a keystroke, or the box loses focus */
  ok("typing does not redraw the search box", viewHTML().indexOf('value="zzzz"') < 0);
  sandbox.render();
  ok("but a background redraw keeps what you typed",
     viewHTML().indexOf('value="zzzz"') >= 0);

  /* the roster is who you follow now, not everybody with an account */
  net.crew = [{ id: "me", name: "Mark Miller", initials: "MM", mine: true },
              { id: "sam", name: "Sam Okonkwo", initials: "SO" }];
  net.follow("me", "sam"); net.follow("tess", "me");
  await sandbox.sync();

  field("findq").value = "";
  sandbox.findPeople();
  await settle();
  ok("clearing the box gives the crew back",
     viewHTML().indexOf('class="roster"') >= 0 && viewHTML().indexOf("findlist") < 0);
  ok("the roster is the people you follow", viewHTML().indexOf(">Sam<") >= 0);
  ok("and not the ones you do not", viewHTML().indexOf(">Tess<") < 0);
  ok("it counts both directions",
     viewHTML().indexOf("1 following") >= 0 && viewHTML().indexOf("1 follower") >= 0);

  /* ---- 27. passwords ---- */
  group("Passwords");
  sandbox.openData();
  await settle();
  ok("the profile screen can change your password",
     viewHTML().indexOf("changePassword()") >= 0 && viewHTML().indexOf('id="pwnew"') >= 0);
  ok("and says who you are, username and all",
     viewHTML().indexOf("@mark") >= 0);
  ok("with what following you buys somebody",
     viewHTML().indexOf("you mark Shared") >= 0);

  const pw = net.passwords;
  field("pwold").value = "";
  field("pwnew").value = "alsolongenough";
  sandbox.changePassword();
  ok("it will not send a blank current password",
     field("pwmsg").textContent.indexOf("current password") >= 0);
  field("pwold").value = "longenough1";
  field("pwnew").value = "short";
  sandbox.changePassword();
  ok("nor a new one under eight characters",
     field("pwmsg").textContent.indexOf("8 characters") >= 0);
  eq("neither of which reached the server", net.passwords, pw);

  field("pwnew").value = "alsolongenough";
  sandbox.changePassword();
  await settle();
  eq("a good pair changes it", net.passwords, pw + 1);
  eq("on the account you are signed in as", net.user("me").password, "alsolongenough");
  ok("and says the other devices stay signed in",
     field("pwmsg").textContent.indexOf("stay signed in") >= 0);

  field("pwold").value = "notmypassword";
  field("pwnew").value = "anotherlongone";
  sandbox.changePassword();
  await settle();
  ok("the wrong current password is refused by the server",
     field("pwmsg").textContent.indexOf("not your current password") >= 0);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
