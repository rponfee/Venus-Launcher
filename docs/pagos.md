# Pagos de Venus IA con Mercado Pago y PayPal (1.0.12)

Los planes de **Venus IA** son **pagos únicos**: el usuario elige un plan en el launcher, paga en el navegador con **Mercado Pago (en pesos)** o **PayPal (en dólares)** y el plan se activa solo cuando el medio de pago lo acredita. Soporte queda para consultas: un ticket ya no pide ni activa planes. Stripe quedó retirado (sus tablas siguen como historial).

| Plan | Precio de lista | Saldo de IA | Modelos |
|---|---|---|---|
| Basic | US$ 4 | US$ 2 | Haiku (esfuerzo bajo y medio) |
| Go | US$ 8 | US$ 4,50 | Haiku (hasta alto) |
| Pro | US$ 15 | US$ 8,50 | Haiku y Sonnet |
| Max | US$ 35 | US$ 20 | Haiku y Sonnet (esfuerzo extra) |

- El saldo **no vence**. Si alguien compra otro plan con saldo sin usar, **lo que le queda se suma** al nuevo.
- Con **PayPal** se cobra el precio de lista en dólares.
- Con **Mercado Pago** se cobra en pesos: precio en dólares × la **cotización** que cargás en el panel, redondeado hacia arriba.

> **Importante:** Mercado Pago y PayPal exigen que la cuenta que cobra sea de una persona **mayor de edad**. Las claves que cargues tienen que ser de esa cuenta. Qué impuestos corresponden depende de la situación fiscal de quien cobra: consultalo con un contador.

## Cómo funciona

1. **Planes** (Ajustes > Plan, el asistente o el panel MCP) muestra cada plan con su precio final en pesos y en dólares, los impuestos incluidos y el **precio sin impuestos** (Ley 27.743).
2. El usuario toca **Comprar**, elige el medio de pago, ve el detalle y toca **Pagar**. El launcher le pide a la Edge Function `payments` una orden; el servidor calcula el monto (el launcher no lo decide) y devuelve el link de pago, que se abre en el navegador.
3. Mientras tanto el launcher consulta la orden cada 5 segundos (hasta 20 minutos). El servidor **siempre le pregunta al proveedor** con sus propias claves:
   - Mercado Pago: busca los pagos con `external_reference` = id de la orden.
   - PayPal: lee la orden y, si está aprobada, la **captura** del lado del servidor.
4. Cuando el pago está aprobado y el **monto y la moneda coinciden**, `payments_mark_paid` crea el saldo (`ai_paid_periods`) y activa el plan. Es idempotente: un aviso repetido no da saldo dos veces.
5. Aunque el usuario cierre el launcher, el plan se activa igual por los avisos del proveedor y por la página a la que vuelve el navegador.

Una devolución o contracargo corta el saldo de esa orden. Si el monto no coincide, no se activa nada y queda registrado en el Registro del panel (`payments.amountMismatch`).

## Configurarlo (panel de admin > Pagos)

Todo se carga desde el launcher: **Administración > Pagos**. Las claves viajan cifradas al servidor, se guardan en **Supabase Vault** y nunca vuelven completas al launcher (solo los últimos 4 caracteres).

### Mercado Pago (pesos)

1. Entrá a [Mercado Pago Developers](https://www.mercadopago.com.ar/developers) con la cuenta que va a cobrar > **Tus integraciones** > **Crear aplicación** (tipo *Pagos online*, producto *Checkout Pro*).
2. En la aplicación, **Credenciales de prueba**: copiá el **Access Token** (empieza con `APP_USR-`). Mercado Pago crea solo una cuenta vendedora y una compradora de prueba.
3. En el panel: pegá el Access Token, cargá la **cotización** (pesos por dólar), activá **Cobrar con Mercado Pago** y tocá **Guardar**. Después tocá **Probar conexión**: tiene que decir *"(de prueba)"*.
4. Probá una compra desde el launcher: abrí el link en una ventana de incógnito, iniciá sesión con la **cuenta compradora de prueba** y pagá con una tarjeta de prueba (por ejemplo Visa `4509 9535 6623 3704`, CVV `123`, vencimiento `11/30`, titular `APRO`). El plan se tiene que activar solo; en **Últimos pagos** aparece con la etiqueta *prueba*.
5. Para cobrar de verdad: **Credenciales de producción** de la misma aplicación (piden completar los datos del negocio) > pegá ese Access Token > Guardar > Probar conexión (tiene que decir *"(real)"*).
6. *(Opcional)* **Webhooks** en la aplicación: URL = la que muestra el panel (*URL de notificaciones*), evento **Pagos**. Copiá la **clave secreta** al panel para que el servidor valide la firma. No es obligatorio: la URL ya va en cada pago y el servidor siempre confirma consultando a Mercado Pago.

### PayPal (dólares)

1. Entrá a [developer.paypal.com](https://developer.paypal.com) con una **cuenta Business** > **Apps & Credentials** > **Sandbox** > **Create App** (tipo Merchant).
2. Copiá el **Client ID** y el **Secret** al panel, elegí **Sandbox (pruebas)**, activá **Cobrar con PayPal**, Guardar y **Probar conexión**.
3. Probá una compra con una cuenta **Personal** de Sandbox (Testing Tools > Sandbox Accounts).
4. Para cobrar de verdad: en la misma página, pestaña **Live** > tu app > Client ID y Secret de **Live** > pegalos, elegí **Live (real)** y guardá.
5. *(Opcional)* **Webhook**: en la app, *Add Webhook* con la URL que muestra el panel y los eventos `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`. Pegá el **Webhook ID** en el panel para que el servidor verifique cada aviso. Sin webhook igual funciona: el servidor captura al volver del pago o cuando el launcher consulta.

PayPal puede dejar un pago **pendiente** (por ejemplo, si la cuenta todavía no acepta dólares): en Últimos pagos se ve el estado *capture_PENDING*. Aceptalo en tu cuenta de PayPal; cuando se libera, el plan se activa solo (con webhook, o con **Revisar**). Para retirar: PayPal Argentina transfiere a una cuenta bancaria local en pesos o a una cuenta propia en EE. UU.

### Precio en pesos e impuestos

- **Cotización**: actualizala cuando cambie el dólar. El panel muestra cuándo la cambiaste por última vez y la tabla **Precios que ven los usuarios**.
- **Redondeo**: hacia arriba (1, 10, 50, 100, 500 o 1000 pesos).
- **Impuestos** (hasta 5 por moneda):

  | Modo | Qué hace | Ejemplo |
  |---|---|---|
  | *Incluido en el precio* | Se informa cuánto es y el precio sin impuestos | IVA 21 % (viene cargado en pesos) |
  | *Se suma al precio* | Se agrega al total y se cobra | — |
  | *Lo suma el banco (estimado)* | Solo se informa como estimado; no lo cobra Venus | Percepción 30 % RG 5617 al pagar en dólares con tarjeta argentina en pesos (viene cargada en dólares) |

- **Nombre en el resumen de la tarjeta**: hasta 22 caracteres (Mercado Pago muestra 13).

## Piezas

| Pieza | Qué es |
|---|---|
| `supabase/migrations/0017_pagos_directos.sql` | Precios nuevos, `payment_settings`, `payment_orders`, funciones `payments_*`, soporte general (`support_open_ticket`) y `ai_effective_plan` que acepta órdenes pagadas. Aplicada como `venus_0017_pagos_directos`. |
| `supabase/functions/payments/` | Edge Function `payments` (`verify_jwt = false`): `handler.ts` (launcher y panel, verifica el JWT en cada pedido) y `webhook.ts` (avisos de Mercado Pago y PayPal, y páginas de vuelta). |
| `supabase/functions/_shared/pagos/` | Clientes de Mercado Pago (`mercadopago.ts`) y PayPal (`paypal.ts`), y `sync.ts`: el único lugar que traduce "estado del proveedor → orden". |
| `src/main/modules/billing*` | Canales `billing:catalog`, `billing:checkout`, `billing:order`, `billing:orders`, `billing:reopen` y el seguimiento de la orden. |
| `src/renderer/js/features/plans.js` | Tarjetas con precios e impuestos, diálogo de compra e historial de pagos. |
| `src/renderer/js/pages/admin/payments.js` | Pestaña **Pagos** del panel. |

URLs (las muestra el panel): `https://<proyecto>.supabase.co/functions/v1/payments?provider=mercado_pago&source_news=webhooks` (avisos de Mercado Pago), `…/payments?provider=paypal` (webhook de PayPal) y `…/payments?return=mp|paypal|paypal-cancel` (vuelta del navegador).

## Pruebas

- `node --test "supabase/functions/payments/tests/*.test.ts"`: checkout, montos, captura de PayPal, firmas de avisos, páginas de vuelta y permisos de admin, contra proveedores falsos.
- `node --test src/main/modules/billing/test/client.test.js`: catálogo, pago y seguimiento de la orden en el launcher.
- Modo de capturas sin servidor ni cobros: `VENUS_DEVSHOT=<carpeta> VENUS_BILLING_FAKE=1 VENUS_ADMIN_FAKE=1`.

## Lo que falta probar con dinero real

- Un pago real con Mercado Pago (credenciales de producción) y su devolución.
- PayPal Live: si una cuenta argentina puede pagarle a otra cuenta argentina (la documentación no lo aclara) y el caso del pago pendiente por moneda.
- Si las notificaciones que llegan a la URL de cada pago traen firma `x-signature` (si no la traen, el servidor igual confirma consultando a Mercado Pago).
