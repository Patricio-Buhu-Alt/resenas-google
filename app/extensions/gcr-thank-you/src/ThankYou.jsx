import {
  reactExtension,
  BlockStack,
  Button,
  Heading,
  Text,
  useApi,
  useSettings,
  useSubscription,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect, useState } from "react";

// URL pública del backend en Render (sin / al final).
// Si Render te asigna otra URL, cámbiala aquí y en shopify.app.toml.
const APP_URL = "https://resenas-google.onrender.com";

export default reactExtension("purchase.thank-you.block.render", () => <ResenasGoogle />);

function ResenasGoogle() {
  const { orderConfirmation, sessionToken } = useApi();
  const confirmation = useSubscription(orderConfirmation);
  const settings = useSettings();
  const [link, setLink] = useState(null);
  const [estado, setEstado] = useState("cargando"); // cargando | listo | oculto

  const orderId = confirmation?.order?.id;

  useEffect(() => {
    if (!orderId) return;
    let cancelado = false;

    (async () => {
      try {
        const token = await sessionToken.get();
        const res = await fetch(`${APP_URL}/token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ orderId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelado && data?.url) {
          setLink(data.url);
          setEstado("listo");
        } else if (!cancelado) {
          setEstado("oculto");
        }
      } catch (e) {
        // Si algo falla, el bloque simplemente no se muestra: nunca debe estorbar la compra.
        if (!cancelado) setEstado("oculto");
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [orderId, sessionToken]);

  if (estado !== "listo" || !link) return null;

  return (
    <BlockStack spacing="base" border="base" padding="base" cornerRadius="base">
      <Heading level={2}>{settings.titulo || "¿Nos ayudas con tu opinión?"}</Heading>
      <Text>
        {settings.texto ||
          "Cuando recibas tu pedido, Google te enviará una breve encuesta sobre tu compra en BUHU. Toma menos de un minuto y nos ayuda muchísimo."}
      </Text>
      <Button to={link} external>
        {settings.boton || "Sí, quiero opinar"}
      </Button>
    </BlockStack>
  );
}
