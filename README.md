# Reseñas de Clientes en Google · BUHU

Muestra la invitación a la encuesta de **Reseñas de Clientes en Google** después de cada compra en
buhu.cl. Con el tiempo, esas encuestas generan las estrellas de vendedor en Shopping y en los anuncios.

Es necesaria porque el checkout actual de Shopify ya no permite poner scripts en la página
"Gracias por tu compra", y la app de Google & YouTube no trae esta función.

## Cómo funciona

```
"Gracias por tu compra"  →  bloque de la app (extensión de checkout)
        │ POST /token  + token de sesión firmado por Shopify
        ▼
API en Render  →  verifica firma y pedido (Admin API)  →  enlace cifrado, vence en 24 h
        │
        ▼
Cliente toca "Sí, quiero opinar"  →  www.buhu.cl/apps/resenas?t=…  (App Proxy)
        │ GET /proxy  + firma HMAC de Shopify
        ▼
API descifra el enlace y responde Liquid  →  se ve dentro del tema y Google muestra su ventana
```

- **Sin base de datos.** El enlace lleva número de pedido, correo, país y fecha estimada de entrega
  cifrados con AES-256-GCM. El correo nunca viaja en claro ni queda guardado.
- Solo pedidos de las últimas 48 h, no cancelados y con correo.
- Si algo falla, el bloque no aparece; nunca afecta la compra.

## Estructura

| Carpeta | Qué es | Dónde corre |
|---|---|---|
| `api/` | Express: `POST /token`, `GET /proxy`, `GET /health` | Render (`render.yaml`) |
| `app/` | Config de la app de Shopify + extensión del bloque | Se sube con `shopify app deploy` |

## Puesta en marcha

### 1. Crear la app en Shopify (desde tu Mac)

```bash
cd app
npm install
npx shopify app config link        # elige "Create a new app" → nombre: resenas-google
```

Eso completa `client_id` en `shopify.app.toml`. En el **Dev Dashboard → resenas-google → Settings**
copia el **Client ID** y el **Client secret** (`shpss_…`).

### 2. Desplegar la API en Render

Render → **New → Blueprint** → este repositorio (usa `render.yaml`). Completa:

- `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET` de la app del paso 1.

Prueba: `https://resenas-google.onrender.com/health` debe responder `{"ok":true}`.
Si Render te asigna otra URL, cámbiala en `app/shopify.app.toml` (3 lugares) y en
`app/extensions/gcr-thank-you/src/ThankYou.jsx` (`APP_URL`).

> **Plan de Render:** en el plan gratis el servicio se duerme y tarda ~50 s en despertar; en ese
> caso el bloque no alcanza a aparecer en esa compra. Para que funcione siempre conviene el plan
> Starter, o mover estas dos rutas a un servicio tuyo que ya esté siempre activo.

### 3. Subir la app y la extensión

```bash
cd app
npx shopify app deploy
```

Luego, en el **Dev Dashboard → resenas-google**:

1. **Acceso a la red de la extensión de checkout**: solicitar y aprobar (la extensión llama a Render).
2. **Instalar** la app en `buhu-cl.myshopify.com` (misma organización que la tienda; scope `read_orders`).

### 4. Activar el bloque

Shopify → **Configuración → Pantalla de pago → Personalizar** → página **Gracias** →
**Agregar bloque → Reseñas Google** → Guardar. Ahí mismo se editan título, texto y botón.

### 5. Probar

1. Haz un pedido de prueba con un correo real y dirección en Chile.
2. En "Gracias" aparece el bloque; al tocar el botón se abre `www.buhu.cl/apps/resenas` con la ventana
   de Google.
3. En Merchant Center → **Reseñas de Clientes en Google**, el aviso de "30 días sin notificaciones"
   desaparece en 1–2 días y empiezan a contarse las participaciones.

## Desarrollo

```bash
cd api
npm install
npm test        # firma del checkout, firma del App Proxy, cifrado del enlace, escape del script
cp .env.example .env && npm start
```

## Variables de entorno (`api/`)

| Variable | Por defecto | Uso |
|---|---|---|
| `SHOPIFY_STORE` | `buhu-cl.myshopify.com` | Tienda |
| `SHOPIFY_CLIENT_ID` | — | Client ID de la app (obligatorio) |
| `SHOPIFY_CLIENT_SECRET` | — | Client secret `shpss_…` (obligatorio; también firma y cifra) |
| `API_VERSION` | `2025-07` | Admin API |
| `GCR_MERCHANT_ID` | `5680138219` | ID de Merchant Center |
| `GCR_DELIVERY_DAYS` | `5` | Días estimados hasta la entrega; Google envía la encuesta después |
| `PUBLIC_STORE_URL` | `https://www.buhu.cl` | Dominio público de la tienda |

## Notas

- La extensión usa `api_version = "2025-07"`, la última con React. Para 2025-10 o superior, Shopify exige
  Preact y componentes `s-*`; la lógica es la misma.
- Si rotas el Client secret, los enlaces generados antes dejan de funcionar (vencen en 24 h de todos modos).
