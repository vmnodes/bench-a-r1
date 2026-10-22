// store.js: where the repair jobs are kept.
//
// ONE decision, made here from DATABASE_URL:
//   DATABASE_URL set   jobs are kept in Postgres, across restarts and updates.
//   not set            jobs are kept in memory and cleared on every restart.
//
// There is no fallback. If DATABASE_URL is set but the database cannot be
// reached, the app refuses to start rather than quietly keeping jobs in memory,
// where they would be lost at the next restart.
//
// "Open" jobs are the ones with no done time. Done jobs stay in the database
// (so nothing is lost) but are never listed.

// Newest first: by the date the bike came in, then by the order they were logged.
function byNewest(a, b) {
  if (a.cameIn !== b.cameIn) return a.cameIn < b.cameIn ? 1 : -1;
  return b.seq - a.seq;
}

function memoryStore() {
  const jobs = [];
  let seq = 0;
  const pub = ({ seq: _s, ...j }) => ({ ...j });
  return {
    kind: "memory",
    async init() {},
    async listOpen() { return jobs.filter((j) => j.doneAt === null).sort(byNewest).map(pub); },
    async add(job) { jobs.push({ ...job, doneAt: null, seq: ++seq }); },
    // Returns the updated job, or null when no job with that id is still open.
    async markDone(id, doneAt) {
      const j = jobs.find((x) => x.id === id && x.doneAt === null);
      if (!j) return null;
      j.doneAt = doneAt;
      return pub(j);
    },
    async close() {},
  };
}

function postgresStore(url, { attempts = 5, delayMs = 1000, log = console } = {}) {
  const postgres = require("postgres");
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  const toJob = (r) => ({
    id: r.id, customer: r.customer, phone: r.phone, bike: r.bike, problem: r.problem,
    cameIn: r.came_in, loggedAt: r.logged_at.toISOString(), doneAt: r.done_at ? r.done_at.toISOString() : null,
  });
  return {
    kind: "postgres",
    async init() {
      for (let i = 1; ; i++) {
        try {
          await sql`create table if not exists repair_jobs (
            seq bigserial primary key,
            id uuid not null unique,
            customer text not null,
            phone text not null,
            bike text not null,
            problem text not null,
            came_in date not null,
            logged_at timestamptz not null,
            done_at timestamptz
          )`;
          return;
        } catch (err) {
          if (i >= attempts) throw new Error(`could not reach the database after ${attempts} tries: ${err.message}`);
          log.log(`database not reachable yet (try ${i} of ${attempts}): ${err.message}`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    },
    async listOpen() {
      const rows = await sql`select id, customer, phone, bike, problem, to_char(came_in, 'YYYY-MM-DD') as came_in, logged_at, done_at from repair_jobs where done_at is null order by came_in desc, seq desc`;
      return rows.map(toJob);
    },
    async add(j) {
      await sql`insert into repair_jobs (id, customer, phone, bike, problem, came_in, logged_at)
                values (${j.id}, ${j.customer}, ${j.phone}, ${j.bike}, ${j.problem}, ${j.cameIn}, ${j.loggedAt})`;
    },
    async markDone(id, doneAt) {
      const rows = await sql`update repair_jobs set done_at = ${doneAt} where id = ${id} and done_at is null returning id, customer, phone, bike, problem, to_char(came_in, 'YYYY-MM-DD') as came_in, logged_at, done_at`;
      return rows[0] ? toJob(rows[0]) : null;
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}

function openStore({ env = process.env, log = console } = {}) {
  return env.DATABASE_URL ? postgresStore(env.DATABASE_URL, { log }) : memoryStore();
}

module.exports = { openStore, byNewest };
