// server.js: the whole app. A repair-shop job list: people with the "staff" role log a job
// when a bike comes in, see every job that is not finished (newest first), and mark one done
// when the bike goes home. Done jobs drop off the list.
const http = require("node:http");
const crypto = require("node:crypto");
// Sign-in checking comes from the platform's own package, @vmnodes/identity.
const { VmnodesIdentity, IdentityError } = require("@vmnodes/identity");
const { openStore } = require("./store");

const APP_NAME = process.env.VMNODES_APP_NAME || "repair-jobs";
// Must match the role name in vmnodes.json exactly ("repair-jobs.staff").
const ROLE_PREFIX = "repair-jobs";
const STAFF_ROLE = `${ROLE_PREFIX}.staff`;
const VERSION = require("./package.json").version;
// Set when the image is built (see Dockerfile). Reported as-is, never guessed.
const BUILD_COMMIT = process.env.BUILD_COMMIT || null;
// The platform does NOT set PORT: a portal launch sends traffic to port 3000, fixed.
const PORT = Number(process.env.PORT || 3000);
const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS || undefined;

// Refuses to START if sign-in is not configured, so a misconfigured app never runs unprotected.
let identity;
try {
  identity = new VmnodesIdentity();
} catch (err) {
  console.error(`${err.message}\nThe platform sets these when your app is deployed; locally, \`npm run dev\` sets them for you.`);
  process.exit(1);
}
const store = openStore();

const KEPT = {
  postgres: "Jobs are kept in this app's database, across restarts and updates.",
  memory: "Jobs are kept in memory, so they are cleared when the app restarts or is updated.",
};
const LIMITS = { customer: 100, phone: 40, bike: 100, problem: 1000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every piece of text a person typed goes through esc() before it goes into a page.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new IdentityError("body too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Reads the fields from a form post or a JSON post. Trims, and never trusts the types.
async function readJobFields(req) {
  const raw = await readBody(req);
  const get = (req.headers["content-type"] || "").includes("application/json")
    ? ((o) => (k) => (typeof o[k] === "string" ? o[k] : ""))(JSON.parse(raw || "{}"))
    : ((p) => (k) => p.get(k) || "")(new URLSearchParams(raw));
  return { customer: get("customer").trim(), phone: get("phone").trim(), bike: get("bike").trim(), problem: get("problem").trim(), cameIn: get("cameIn").trim() };
}

const FIELD_NAMES = { customer: "customer name", phone: "phone number", bike: "bike", problem: "what's wrong with it", cameIn: "date it came in" };

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= "2000-01-01" && s <= "2100-12-31";
};

// The server-side checks. The form's `required` and `maxlength` are a courtesy to
// people; this is what actually decides, because anyone can send a request without the form.
function problemWith(f) {
  for (const k of ["customer", "phone", "bike", "problem"]) if (!f[k]) return `${FIELD_NAMES[k]} is required`;
  if (!f.cameIn) return `${FIELD_NAMES.cameIn} is required`;
  for (const k of Object.keys(LIMITS)) if (f[k].length > LIMITS[k]) return `${FIELD_NAMES[k]} must be at most ${LIMITS[k]} characters`;
  if (!/\d/.test(f.phone)) return "phone number must contain digits";
  if (!isRealDate(f.cameIn)) return "date it came in must be a real date written like 2026-10-22";
  return null;
}

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;max-width:900px;margin:0 auto;padding:16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #2a2c35;padding:8px 6px;vertical-align:top}small,th{color:#9a9cab;font-weight:normal}label{display:block;margin-top:8px}input,textarea{width:100%;background:#15161c;color:inherit;border:1px solid #2a2c35;border-radius:6px;padding:8px;box-sizing:border-box;font:inherit}button{margin-top:8px;background:#5b5bd6;color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit;cursor:pointer}td button{margin-top:0}.err{border:1px solid #d65b5b;border-radius:6px;padding:8px}code{font-family:ui-monospace,monospace}:focus-visible{outline:2px solid #a9a9ff;outline-offset:2px}</style></head>
<body>${inner}</body></html>`;
}

function page(user, jobs, { error = "", values = {} } = {}) {
  const rows = jobs.length
    ? jobs.map((j) => `<tr><td>${esc(j.cameIn)}</td><td>${esc(j.customer)}<br><small>${esc(j.phone)}</small></td><td>${esc(j.bike)}</td><td>${esc(j.problem)}</td>
<td><form method="post" action="/jobs/${esc(j.id)}/done"><button type="submit" aria-label="Mark done: ${esc(j.bike)} for ${esc(j.customer)}">Mark done</button></form></td></tr>`).join("")
    : `<tr><td colspan="5">No jobs waiting. Every bike has gone home.</td></tr>`;
  const val = (k) => esc(values[k] || "");
  return shell("Repair jobs", `<h1>Repair jobs</h1><p id="who">Signed in as <strong>${esc(user.name || user.email)}</strong></p>
<h2>Log a job</h2>
<form method="post" action="/jobs">${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<label for="customer">Customer's name</label><input id="customer" name="customer" required maxlength="${LIMITS.customer}" value="${val("customer")}">
<label for="phone">Phone number</label><input id="phone" name="phone" type="tel" required maxlength="${LIMITS.phone}" value="${val("phone")}">
<label for="bike">Bike</label><input id="bike" name="bike" required maxlength="${LIMITS.bike}" value="${val("bike")}">
<label for="problem">What's wrong with it</label><textarea id="problem" name="problem" required rows="3" maxlength="${LIMITS.problem}">${val("problem")}</textarea>
<label for="cameIn">Date it came in</label><input id="cameIn" name="cameIn" type="date" required value="${val("cameIn")}">
<button type="submit">Log job</button></form>
<script>(function(){var d=document.getElementById("cameIn");if(d&&!d.value){var t=new Date();d.value=t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");}})();</script>
<h2>Jobs not finished (${jobs.length})</h2><table><thead><tr><th>Came in</th><th>Customer</th><th>Bike</th><th>What's wrong</th><th>Done?</th></tr></thead><tbody id="jobs">${rows}</tbody></table>
<p id="kept"><small>${esc(KEPT[store.kind])}</small></p>`);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://app");
  const isApi = url.pathname.startsWith("/api/");

  // Health is checked by the platform directly, with no signed-in person, so
  // it must NOT require sign-in. It must also be honest: say what is running.
  if (url.pathname === "/health") {
    return send(res, 200, { status: "ok", app: APP_NAME, version: VERSION, buildCommit: BUILD_COMMIT, storage: store.kind });
  }

  // Everything else: who is this? (Throws 401/503 if we cannot tell.)
  const user = await identity.currentUser(req.headers);
  // Every route below is for staff (phone numbers are in here). Checked on the SERVER, on every request.
  identity.requireRole(user, STAFF_ROLE);

  if (url.pathname === "/" && req.method === "GET") return send(res, 200, page(user, await store.listOpen()), "text/html; charset=utf-8");
  if (url.pathname === "/api/jobs" && req.method === "GET") return send(res, 200, { items: await store.listOpen() });

  if ((url.pathname === "/jobs" || url.pathname === "/api/jobs") && req.method === "POST") {
    const fields = await readJobFields(req);
    const problem = problemWith(fields);
    if (problem) {
      if (isApi) return send(res, 400, { error: problem });
      return send(res, 400, page(user, await store.listOpen(), { error: problem, values: fields }), "text/html; charset=utf-8");
    }
    const job = { id: crypto.randomUUID(), ...fields, loggedAt: new Date().toISOString() };
    await store.add(job);
    if (!isApi) { res.writeHead(303, { location: "/" }); return res.end(); }
    return send(res, 201, { ...job, doneAt: null });
  }

  const done = url.pathname.match(/^\/(?:api\/)?jobs\/([^/]+)\/done$/);
  if (done && req.method === "POST") {
    // An id that is not a UUID can never match a row; say so here instead of letting the database throw.
    const job = UUID.test(done[1]) ? await store.markDone(done[1].toLowerCase(), new Date().toISOString()) : null;
    if (!job) {
      if (!isApi) { res.writeHead(303, { location: "/" }); return res.end(); } // already done by someone else: the list simply refreshes
      return send(res, 404, { error: "no such open job" });
    }
    if (!isApi) { res.writeHead(303, { location: "/" }); return res.end(); }
    return send(res, 200, job);
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof IdentityError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error(err.cause || err);
    const message = status === 500 ? "something went wrong" : err.message;
    if (new URL(req.url, "http://app").pathname.startsWith("/api/")) return send(res, status, { error: message });
    send(res, status, shell("Repair jobs", `<h1>Repair jobs</h1><p>${esc(message)}</p>${status === 403 ? `<p>This app is for people with the <code>${esc(STAFF_ROLE)}</code> role. Ask whoever runs it to give it to you.</p>` : ""}`), "text/html; charset=utf-8");
  });
});
store.init().then(
  () => server.listen({ port: PORT, host: LISTEN_ADDRESS }, () => console.log(`${APP_NAME} ${VERSION} listening on :${server.address().port} (jobs kept in ${store.kind})`)),
  (err) => {
    // No fallback to memory: jobs kept there would be lost at the next restart.
    console.error(`${err.message}\nDATABASE_URL is set, so this app will not start without its database.`);
    process.exit(1);
  },
);
