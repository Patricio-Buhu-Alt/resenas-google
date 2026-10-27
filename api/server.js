// Reseñas de Clientes en Google (GCR) · backend para BUHU
//
// Dos endpoints:
//   POST /token   → lo llama el bloque de la página "Gracias por tu compra".
//                   Valida el token de sesión del checkout, verifica el pedido en
//                   Shopify y devuelve un enlace https://www.buhu.cl/apps/resenas?t=...
//   GET  /proxy   → Shopify lo llama vía App Proxy (buhu.cl/apps/resenas).
//                   Valida la firma, abre el enlace y devuelve Liquid con la
//                   ventana de aceptación de Google (surveyoptin).
//
// Sin base de datos: el parámetro t lleva los datos del pedido CIFRADOS (AES-256-GCM)
// y con vencimiento. El correo nunca viaja en claro ni queda guardado.
//
// Autenticación con Shopify: client credentials grant (modelo Dev Dashboard),
// igual que medidor-dp-orden-api.
//
// Variables de entorno (ver .env.example):
//   SHOPIFY_STORE          buhu-cl.myshopify.com
//   SHOPIFY_CLIENT_ID      Client ID de la app "resenas-google"        [OBLIGATORIO]
//   SHOPIFY_CLIENT_SECRET  Client Secret (shpss_…) de esa app          [OBLIGATORIO]
//   API_VERSION            2025-07
//   GCR_MERCHANT_ID        5680138219
//   GCR_DELIVERY_DAYS      5  (días estimados hasta la entrega)
//   PUBLIC_STORE_URL       https://www.buhu.cl
//   PORT                   lo asigna Render

import express from "express";
import crypto from "node:crypto";

const STORE = process.env.SHOPIFY_STORE || "buhu-cl.myshopify.com";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const VERSION = process.env.API_VERSION || "2025-07";
const MERCHANT_ID = Number(process.env.GCR_MERCHANT_ID || 5680138219);
const DELIVERY_DAYS = Number(process.env.GCR_DELIVERY_DAYS || 5);
const PUBLIC_STORE_URL = (process.env.PUBLIC_STORE_URL || "https://www.buhu.cl").replace(/\/$/, "");

const LINK_TTL_MS = 24 * 3600 * 1000;      // el enlace vale 24 h
const MAX_ORDER_AGE_MS = 48 * 3600 * 1000; // solo pedidos de las últimas 48 h

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

// ---------------------------------------------------------------------------
// Utilidades criptográficas (exportadas para las pruebas)
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Verifica el JWT HS256 que entrega sessionToken.get() en la extensión de checkout.
export function verifySessionToken(token, secret, clientId, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("jwt_formato");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== "HS256") throw new Error("jwt_alg");
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error("jwt_firma");
  }
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const t = Math.floor(now / 1000);
  if (claims.exp && t > claims.exp + 10) throw new Error("jwt_expirado");
  if (claims.nbf && t < claims.nbf - 10) throw new Error("jwt_nbf");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (clientId && !aud.includes(clientId)) throw new Error("jwt_aud");
  return claims;
}

// Verifica la firma que Shopify agrega a las peticiones del App Proxy.
export function verifyProxySignature(query, secret) {
  const { signature, ...rest } = query;
  if (!signature || typeof signature !== "string") return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Clave de cifrado derivada del client secret (sin variable extra que administrar).
const encKey = (secret) =>
  crypto.createHash("sha256").update(`gcr-link:${secret}`).digest();

export function sealLink(payload, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), data]));
}

export function openLink(token, secret, now = Date.now()) {
  const raw = Buffer.from(String(token || ""), "base64url");
  if (raw.length < 29) throw new Error("link_formato");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  const payload = JSON.parse(json);
  if (!payload.exp || now > payload.exp) throw new Error("link_vencido");
  return payload;
}

// JSON apto para incrustar dentro de <script> en una plantilla Liquid.
export function scriptSafeJson(obj) {
  // Solo se escapan caracteres DENTRO de los textos: las llaves y comillas que
  // estructuran el objeto quedan intactas para que siga siendo JavaScript válido.
  const esc = (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  return JSON.stringify(obj).replace(/"(?:[^"\\]|\\.)*"/g, (lit) =>
    lit.replace(/[<>{}&%\u2028\u2029]/g, esc),
  );
}

// ---------------------------------------------------------------------------
// Shopify Admin API (client credentials grant, token cacheado)
// ---------------------------------------------------------------------------

let _tok = { value: null, exp: 0 };
async function getToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60000) return _tok.value;
  const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("token " + r.status + ": " + (await r.text()));
  const j = await r.json();
  _tok = { value: j.access_token, exp: now + (j.expires_in || 86399) * 1000 };
  return _tok.value;
}

async function shopify(query, variables) {
  const r = await fetch(`https://${STORE}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors));
  return j.data;
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => res.json({ ok: true, service: "resenas-google" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// CORS: las extensiones de checkout corren en un origen de Shopify. La seguridad
// la da el token de sesión firmado, no el origen.
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "86400");
}
app.options("/token", (_req, res) => { cors(res); res.sendStatus(204); });

app.post("/token", async (req, res) => {
  cors(res);
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).json({ url: null, error: "config" });

    const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let claims;
    try {
      claims = verifySessionToken(bearer, CLIENT_SECRET, CLIENT_ID);
    } catch (e) {
      return res.status(401).json({ url: null, error: "no_autorizado" });
    }
    const dest = String(claims.dest || "").replace(/^https?:\/\//, "");
    if (dest !== STORE) return res.status(403).json({ url: null, error: "tienda" });

    // En "Gracias" llega gid://shopify/OrderIdentity/123 → mismo número que Order.
    const numeric = String(req.body?.orderId || "").split("/").pop();
    if (!/^\d+$/.test(numeric)) return res.status(400).json({ url: null, error: "orden" });

    const data = await shopify(
      `query($id: ID!) {
        order(id: $id) {
          name email createdAt cancelledAt
          shippingAddress { countryCodeV2 }
          billingAddress { countryCodeV2 }
        }
      }`,
      { id: `gid://shopify/Order/${numeric}` },
    );
    const o = data?.order;
    if (!o || !o.email || o.cancelledAt) return res.json({ url: null });
    const createdAt = new Date(o.createdAt).getTime();
    if (Date.now() - createdAt > MAX_ORDER_AGE_MS) return res.json({ url: null });

    const t = sealLink(
      {
        n: o.name,
        e: o.email,
        c: o.shippingAddress?.countryCodeV2 || o.billingAddress?.countryCodeV2 || "CL",
        d: new Date(createdAt + DELIVERY_DAYS * 864e5).toISOString().slice(0, 10),
        exp: Date.now() + LINK_TTL_MS,
      },
      CLIENT_SECRET,
    );
    return res.json({ url: `${PUBLIC_STORE_URL}/apps/resenas?t=${t}` });
  } catch (e) {
    console.error("[token]", e.message);
    return res.status(500).json({ url: null, error: "servidor" });
  }
});

app.get("/proxy", (req, res) => {
  res.set("Content-Type", "application/liquid; charset=utf-8");
  res.set("Cache-Control", "no-store");

  if (!CLIENT_SECRET || !verifyProxySignature(req.query, CLIENT_SECRET)) {
    return res.status(401).send("No autorizado");
  }

  let p;
  try {
    p = openLink(req.query.t, CLIENT_SECRET);
  } catch {
    return res.send(pagina(
      "Enlace no disponible",
      "Este enlace venció o no es válido. ¡Gracias igual por comprar en BUHU!",
    ));
  }

  const config = {
    merchant_id: MERCHANT_ID,
    order_id: p.n,
    email: p.e,
    delivery_country: p.c,
    estimated_delivery_date: p.d,
    opt_in_style: "CENTER_DIALOG",
  };

  return res.send(
    pagina(
      "¡Gracias por tu compra!",
      "Acepta la invitación de Google y, cuando llegue tu pedido, te enviará una breve encuesta. Nos ayuda muchísimo.",
    ) +
    `
<script src="https://apis.google.com/js/platform.js?onload=renderOptIn" async defer></script>
<script>
  window.renderOptIn = function () {
    window.gapi.load("surveyoptin", function () {
      window.gapi.surveyoptin.render(${scriptSafeJson(config)});
    });
  };
</script>`,
  );
});

function pagina(titulo, texto) {
  const esc = (s) => String(s).replace(/[&<>"'{}%]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<div style="max-width:560px;margin:48px auto;padding:0 16px;text-align:center">
  <h1>${esc(titulo)}</h1>
  <p>${esc(texto)}</p>
  <p><a href="/">Volver a la tienda</a></p>
</div>`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`resenas-google escuchando en ${PORT}`));
}

export default app;
