import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SHOPIFY_CLIENT_ID = "cid_test";
process.env.SHOPIFY_CLIENT_SECRET = "shpss_test_secret";

const {
  default: app,
  verifySessionToken,
  verifyProxySignature,
  sealLink,
  openLink,
  scriptSafeJson,
} = await import("../server.js");

const SECRET = "shpss_test_secret";

function jwt(claims, secret = SECRET, alg = "HS256") {
  const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
const now = Math.floor(Date.now() / 1000);
const ok = { dest: "https://buhu-cl.myshopify.com", aud: "cid_test", exp: now + 60, nbf: now - 1 };

test("token de sesión válido", () => {
  assert.equal(verifySessionToken(jwt(ok), SECRET, "cid_test").dest, ok.dest);
});
test("token con otra firma se rechaza", () => {
  assert.throws(() => verifySessionToken(jwt(ok, "otro"), SECRET, "cid_test"), /jwt_firma/);
});
test("token vencido se rechaza", () => {
  assert.throws(() => verifySessionToken(jwt({ ...ok, exp: now - 100 }), SECRET, "cid_test"), /jwt_expirado/);
});
test("token de otra app se rechaza", () => {
  assert.throws(() => verifySessionToken(jwt({ ...ok, aud: "x" }), SECRET, "cid_test"), /jwt_aud/);
});
test("alg none se rechaza", () => {
  assert.throws(() => verifySessionToken(jwt(ok, SECRET, "none"), SECRET, "cid_test"), /jwt_alg/);
});

function firmar(q) {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("");
  return { ...q, signature: crypto.createHmac("sha256", SECRET).update(msg).digest("hex") };
}
test("firma de App Proxy válida y adulterada", () => {
  const q = firmar({ shop: "buhu-cl.myshopify.com", path_prefix: "/apps/resenas", timestamp: "1", t: "abc" });
  assert.equal(verifyProxySignature(q, SECRET), true);
  assert.equal(verifyProxySignature({ ...q, t: "otro" }, SECRET), false);
  assert.equal(verifyProxySignature({ shop: "x" }, SECRET), false);
});

test("enlace cifrado: ida y vuelta, sin datos legibles", () => {
  const t = sealLink({ n: "#1001", e: "cliente@correo.cl", c: "CL", d: "2026-11-01", exp: Date.now() + 1000 }, SECRET);
  assert.ok(!Buffer.from(t, "base64url").toString("latin1").includes("cliente@"));
  assert.equal(openLink(t, SECRET).e, "cliente@correo.cl");
});
test("enlace vencido o adulterado falla", () => {
  const t = sealLink({ n: "#1", e: "a@b.cl", exp: Date.now() - 1 }, SECRET);
  assert.throws(() => openLink(t, SECRET), /link_vencido/);
  const t2 = sealLink({ n: "#1", e: "a@b.cl", exp: Date.now() + 1000 }, SECRET);
  const raw = Buffer.from(t2, "base64url"); raw[raw.length - 1] ^= 1;
  assert.throws(() => openLink(raw.toString("base64url"), SECRET));
  assert.throws(() => openLink(t2, "otro_secreto"));
});

test("JSON seguro para <script> y Liquid", () => {
  const s = scriptSafeJson({ email: "x</script>{{ shop }}{% if %}@y.cl" });
  assert.ok(s.startsWith('{"') && s.endsWith('"}'), "estructura intacta");
  assert.ok(!/[<>{}%]/.test(s.slice(1, -1)), "sin caracteres peligrosos dentro de los textos");
  assert.equal(JSON.parse(s).email, "x</script>{{ shop }}{% if %}@y.cl");
  assert.deepEqual(new Function(`return ${s}`)(), { email: "x</script>{{ shop }}{% if %}@y.cl" }, "JS válido");
});

test("rutas HTTP: /proxy sin firma 401, con firma y enlace inválido 200", async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(`${base}/proxy?t=x`);
    assert.equal(r.status, 401);

    const q = firmar({ shop: "buhu-cl.myshopify.com", path_prefix: "/apps/resenas", timestamp: "1", t: "basura" });
    r = await fetch(`${base}/proxy?${new URLSearchParams(q)}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/liquid/);
    assert.match(await r.text(), /Enlace no disponible/);

    const link = sealLink({ n: "#1001", e: "c@d.cl", c: "CL", d: "2026-11-01", exp: Date.now() + 60000 }, SECRET);
    const q2 = firmar({ shop: "buhu-cl.myshopify.com", path_prefix: "/apps/resenas", timestamp: "1", t: link });
    r = await fetch(`${base}/proxy?${new URLSearchParams(q2)}`);
    const html = await r.text();
    assert.match(html, /surveyoptin\.render/);
    assert.match(html, /"merchant_id":5680138219/);
    const cfg = html.match(/surveyoptin\.render\((.*)\);/)[1];
    assert.equal(new Function(`return ${cfg}`)().email, "c@d.cl", "el script del proxy es JS válido");

    r = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");

    r = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt({ ...ok, dest: "https://otra.myshopify.com" })}` },
      body: JSON.stringify({ orderId: "gid://shopify/OrderIdentity/1" }),
    });
    assert.equal(r.status, 403);
  } finally {
    srv.close();
  }
});
