// Bloque "Reseñas Google" en la página "Gracias por tu compra".
// Pide al backend un enlace de un solo uso y muestra un botón que abre
// www.buhu.cl/apps/resenas, donde Google muestra su invitación a la encuesta.
// API 2026-07: Preact + componentes Polaris (s-*), APIs en el objeto global `shopify`.

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// URL pública del backend en Render (sin / al final).
// Si Render te asigna otra URL, cámbiala aquí y en shopify.app.resenas-google.toml.
const APP_URL = "https://resenas-google.onrender.com";

export default async () => {
  render(<ResenasGoogle />, document.body);
};

function ResenasGoogle() {
  // En 2026-xx, order.id es el GID de la orden en la Admin API.
  const orderId = shopify.orderConfirmation.value?.order?.id;
  const settings = shopify.settings.value || {};
  // Solo existe dentro del editor de checkout (vista previa con pedido de ejemplo).
  const enEditor = Boolean(shopify.extension.editor);
  const [link, setLink] = useState(null);

  useEffect(() => {
    if (enEditor || !orderId) return;
    let cancelado = false;

    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${APP_URL}/token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ orderId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelado && data?.url) setLink(data.url);
      } catch {
        // Si algo falla, el bloque no aparece: nunca debe estorbar la compra.
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [orderId, enEditor]);

  // En el editor se muestra siempre, con el botón desactivado, para ver y ajustar el diseño.
  if (enEditor) return <Bloque settings={settings} link={null} />;
  if (!link) return null;
  return <Bloque settings={settings} link={link} />;
}

function Bloque({ settings, link }) {
  return (
    <s-section heading={settings.titulo || "¿Nos ayudas con tu opinión?"}>
      <s-stack gap="base">
        <s-text>
          {settings.texto ||
            "Cuando recibas tu pedido, Google te enviará una breve encuesta sobre tu compra en BUHU. Toma menos de un minuto y nos ayuda muchísimo."}
        </s-text>
        <s-button
          href={link || undefined}
          target="_blank"
          variant="primary"
          disabled={!link}
        >
          {settings.boton || "Sí, quiero opinar"}
        </s-button>
        {!link && (
          <s-text color="subdued">
            Vista previa del editor: en un pedido real el botón se activa y abre la encuesta de Google.
          </s-text>
        )}
      </s-stack>
    </s-section>
  );
}
