// dev/mock-portal.js: a PRETEND VMnodes portal for your own computer only.
//
// On the platform, the real gateway signs people in and adds a signed
// X-Vmnodes-Identity header to each request. This file does the same thing
// locally. It makes its own signing key, publishes the public half at
// /auth/jwks exactly like the real portal, and forwards your browser's
// requests to the app with a signed token attached.
//
// Why not just switch sign-in checking off locally? Because a switch like that
// ends up left on in production. This way the app runs the SAME checks
// locally as it does on the platform, and nothing needs turning off.
//
// It only listens on 127.0.0.1 and refuses to forward anywhere else.
const http = require("node:http");
const { generateKeyPair, exportJWK, SignJWT } = require("jose");

// The people you can sign in as locally. Change these to your app's own roles:
// the role strings must be exactly what your server passes to requireRole.
const USERS = {
  reader: { sub: "usr_local_reader", email: "reader@example.test", name: "Riley Reader", kind: "employee", groups: [], roles: [] },
  editor: { sub: "usr_local_editor", email: "editor@example.test", name: "Eden Editor", kind: "employee", groups: [], roles: ["repair-jobs.staff"] },
};

async function startMockPortal({ port, appUrl, appId, as = "editor" }) {
  let target;
  // The issuer is this portal's own address, which is only known once it is
  // listening (port 0 picks a free one). It is assigned below, after listen();
  // that is safe because no request can reach the handler before then.
  let issuer;
  function setTarget(url) {
    const t = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(t.hostname)) throw new Error(`refusing to forward to ${t.host}: the mock portal only talks to this computer`);
    target = t;
  }
  if (appUrl) setTarget(appUrl);
  if (!USERS[as]) throw new Error(`unknown user '${as}': choose one of ${Object.keys(USERS).join(", ")}`);

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "local-dev", alg: "RS256", use: "sig" };
  let current = as;

  const server = http.createServer(async (req, res) => {
    if (req.url === "/auth/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    // /_as/<user> switches who you are signed in as.
    const m = req.url.match(/^\/_as\/([a-z]+)$/);
    if (m && USERS[m[1]]) { current = m[1]; res.writeHead(303, { location: "/" }); return res.end(); }

    const u = USERS[current];
    const token = await new SignJWT({ email: u.email, name: u.name, kind: u.kind, groups: u.groups, roles: u.roles })
      .setProtectedHeader({ alg: "RS256", kid: "local-dev" })
      .setSubject(u.sub).setIssuer(issuer).setAudience(appId)
      .setIssuedAt().setExpirationTime("10m").sign(privateKey);

    if (!target) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("no app to forward to yet\n"); }
    const headers = { ...req.headers, host: target.host, "x-vmnodes-identity": token };
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end(`the app is not answering at ${target.href}: ${e.message}\n`); });
    req.pipe(up);
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { server, issuer, port: server.address().port, privateKey, jwk, setUser: (name) => { current = name; }, setTarget };
}

module.exports = { startMockPortal, USERS };
