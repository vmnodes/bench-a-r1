// test/smoke.js: `npm test`. Proves the repair-jobs app refuses what it should and
// accepts what it should. Every "refused" row has a matching "accepted" row, so a
// check that can only ever refuse cannot pass by accident.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { SignJWT } = require("jose");
const { startMockPortal } = require("../dev/mock-portal");
const { byNewest } = require("../store");

const APP_ID = "app_smoke_test";
const SERVER = path.join(__dirname, "..", "server.js");
const children = [];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (expected ${JSON.stringify(want)}, got ${JSON.stringify(got)})`}`);
}

function startApp(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: "0", LISTEN_ADDRESS: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on :(\d+)/);
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ child, exited: code, out: () => out }));
  });
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // --- 0. The ordering rule, as a pure function, over BOTH input orders ------
  // Different dates AND same-date ties, so neither the date nor the tiebreak can be dropped unseen.
  const rows = [{ id: "old", cameIn: "2026-10-01", seq: 5 }, { id: "newDate", cameIn: "2026-10-20", seq: 2 }, { id: "tieFirst", cameIn: "2026-10-20", seq: 1 }, { id: "tieLast", cameIn: "2026-10-20", seq: 9 }];
  const want = ["tieLast", "newDate", "tieFirst", "old"];
  check("newest first: same answer from either input order", [[...rows].sort(byNewest).map((r) => r.id), [...rows].reverse().sort(byNewest).map((r) => r.id)], [want, want]);

  // --- 1. It refuses to start without sign-in configured -------------------
  const noAppId = await startApp({ VMNODES_PORTAL_URL: "http://127.0.0.1:1" });
  check("refuses to START without VMNODES_APP_ID", noAppId.exited !== undefined && noAppId.exited !== 0, true);

  const portal = await startMockPortal({ port: 0, appId: APP_ID });
  const app = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID });
  check("CONTROL: starts when both settings are present", typeof app.url, "string");
  if (!app.url) { console.log(app.out()); process.exit(1); }
  portal.setTarget(app.url);

  const mint = (claims, { aud = APP_ID } = {}) =>
    new SignJWT({ email: "e@example.test", name: "Eden Editor", kind: "employee", groups: [], roles: [], ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "local-dev" }).setSubject("usr_1").setIssuer(portal.issuer).setAudience(aud)
      .setIssuedAt().setExpirationTime("5m").sign(portal.privateKey);
  const as = async (claims, opts) => ({ "x-vmnodes-identity": await mint(claims, opts) });
  const staff = () => as({ roles: ["repair-jobs.staff"] });
  const nobody = () => as({ name: "Riley Reader", roles: [] });
  const json = (headers, method, p, body) => request(`${app.url}${p}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const job = (o = {}) => ({ customer: "Sam Rider", phone: "0400 111 222", bike: "Red Giant road bike", problem: "Rear brake rubs", cameIn: "2026-10-22", ...o });
  const open = async () => (await json(await staff(), "GET", "/api/jobs")).json().items;

  // --- 2. Health and sign-in -------------------------------------------------
  const h = await request(`${app.url}/health`);
  check("health answers 200 WITHOUT sign-in", h.status, 200);
  check("health says jobs are kept in memory when DATABASE_URL is not set", h.json().storage, "memory");
  check("CONTROL: a staff token is accepted", (await json(await staff(), "GET", "/api/jobs")).status, 200);
  check("no identity header -> 401 (list)", (await request(`${app.url}/api/jobs`)).status, 401);
  check("no identity header -> 401 (page)", (await request(`${app.url}/`)).status, 401);
  check("token meant for ANOTHER app -> 401", (await json(await as({ roles: ["repair-jobs.staff"] }, { aud: "app_someone_else" }), "GET", "/api/jobs")).status, 401);

  // --- 3. The role is checked on the server, for every route -----------------
  check("signed in without the role: list -> 403", (await json(await nobody(), "GET", "/api/jobs")).status, 403);
  check("signed in without the role: page -> 403", (await request(`${app.url}/`, { headers: await nobody() })).status, 403);
  check("signed in without the role: log a job -> 403", (await json(await nobody(), "POST", "/api/jobs", job())).status, 403);
  check("signed in without the role: form post -> 403", (await request(`${app.url}/jobs`, { method: "POST", headers: { ...(await nobody()), "content-type": "application/x-www-form-urlencoded" }, body: "customer=A" })).status, 403);
  check("signed in without the role: mark done -> 403", (await json(await nobody(), "POST", "/api/jobs/6f1c2a52-8f0d-4d64-9d0e-1c7b0e2a9b11/done")).status, 403);
  check("a 403 page does not leak any job", (await request(`${app.url}/`, { headers: await nobody() })).body.includes("Sam Rider"), false);

  // --- 4. Adding and listing -------------------------------------------------
  const made = await json(await staff(), "POST", "/api/jobs", job({ customer: "Ada <b>Lovelace</b>", cameIn: "2026-10-20" }));
  check("CONTROL: a valid job is accepted -> 201", made.status, 201);
  check("a later date logged second sorts above it", (await json(await staff(), "POST", "/api/jobs", job({ customer: "Newer", cameIn: "2026-10-22" }))).status, 201);
  check("a same-date job logged last sorts first among that date", (await json(await staff(), "POST", "/api/jobs", job({ customer: "Newest", cameIn: "2026-10-22" }))).status, 201);
  const list = await open();
  check("open list is newest first (date, then logged order)", list.map((j) => j.customer), ["Newest", "Newer", "Ada <b>Lovelace</b>"]);
  check("a job carries all five fields and no done time", [list[2].phone, list[2].bike, list[2].problem, list[2].cameIn, list[2].doneAt], ["0400 111 222", "Red Giant road bike", "Rear brake rubs", "2026-10-20", null]);
  for (const [name, body] of [
    ["no customer", job({ customer: undefined })], ["blank customer", job({ customer: "   " })], ["no phone", job({ phone: "" })], ["phone with no digits", job({ phone: "call me" })],
    ["no bike", job({ bike: "" })], ["no problem", job({ problem: "" })], ["no date", job({ cameIn: "" })], ["a date that is not a date", job({ cameIn: "2026-13-45" })],
    ["a date written the wrong way", job({ cameIn: "22/10/2026" })], ["a number for customer", job({ customer: 5 })], ["a 101-character customer", job({ customer: "x".repeat(101) })], ["a 1001-character problem", job({ problem: "x".repeat(1001) })],
  ]) {
    check(`${name} -> 400`, (await json(await staff(), "POST", "/api/jobs", body)).status, 400);
  }
  check("CONTROL: a 1000-character problem is accepted", (await json(await staff(), "POST", "/api/jobs", job({ customer: "Long", problem: "x".repeat(1000), cameIn: "2026-10-01" }))).status, 201);
  const broken = await request(`${app.url}/api/jobs`, { method: "POST", headers: { ...(await staff()), "content-type": "application/json" }, body: "{nope" });
  check("a body that is not JSON -> 400", broken.status, 400);
  check("nothing was added by the refused posts (4 jobs)", (await open()).length, 4);

  // --- 5. Text is escaped when it goes into the page -------------------------
  portal.setUser("editor");
  const pageHtml = (await request(`${portal.issuer}/`)).body;
  check("typed text is escaped, not run as markup", pageHtml.includes("Ada &lt;b&gt;Lovelace&lt;/b&gt;") && !pageHtml.includes("<b>Lovelace"), true);
  check("the page shows the phone number to staff", pageHtml.includes("0400 111 222"), true);
  const formAdd = await request(`${portal.issuer}/jobs`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(job({ customer: "Form Person" })).toString() });
  check("the HTML form post answers 303", formAdd.status, 303);
  check("an invalid HTML form post re-shows the form with the error, status 400", await (async () => { const r = await request(`${portal.issuer}/jobs`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(job({ bike: "", customer: "Kept Value" })).toString() }); return [r.status, r.body.includes("bike is required"), r.body.includes("Kept Value")]; })(), [400, true, true]);
  portal.setUser("reader");
  check("a person without the role gets a 403 page, not the list", [(await request(`${portal.issuer}/`)).status, (await request(`${portal.issuer}/`)).body.includes("Lovelace")], [403, false]);
  portal.setUser("editor");

  // --- 6. Marking done -------------------------------------------------------
  const id = made.json().id;
  const out = await json(await staff(), "POST", `/api/jobs/${id}/done`);
  check("CONTROL: marking an open job done -> 200, with a done time", [out.status, typeof out.json().doneAt], [200, "string"]);
  check("a done job drops off the list, the others stay", (await open()).map((j) => j.customer).includes("Ada <b>Lovelace</b>") === false && (await open()).length === 4, true);
  check("marking the same job done again -> 404 on the API", (await json(await staff(), "POST", `/api/jobs/${id}/done`)).status, 404);
  check("the page form for an already-done job just goes back to the list (303)", (await request(`${portal.issuer}/jobs/${id}/done`, { method: "POST" })).status, 303);
  check("a made-up id -> 404", (await json(await staff(), "POST", "/api/jobs/6f1c2a52-8f0d-4d64-9d0e-1c7b0e2a9b11/done")).status, 404);
  check("an id that is not a UUID -> 404, not a database error", (await json(await staff(), "POST", "/api/jobs/not-an-id/done")).status, 404);

  // --- 7. A database that cannot be reached stops the app; it never falls back --
  const noDb = await startApp({ VMNODES_PORTAL_URL: portal.issuer, VMNODES_APP_ID: APP_ID, DATABASE_URL: "postgres://repairs@127.0.0.1:1/repairs" });
  check("with DATABASE_URL set and no database, the app refuses to START", noDb.exited !== undefined && noDb.exited !== 0, true);
  check("...and says it will not start without its database", /will not start without its database/.test(noDb.out()), true);

  // --- 8. The count itself: zero checks run must never read as a pass ---------
  const FLOOR = 40;
  if (pass + fail < FLOOR) { console.log(`FAIL only ${pass + fail} checks ran, expected at least ${FLOOR}`); fail++; }
  console.log(`\npassed=${pass} failed=${fail}`);
  finish(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("smoke test crashed:", e); finish(1); });

function finish(code) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
