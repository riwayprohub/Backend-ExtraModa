/**
 * DTOs de pedido.
 *
 * Los importes se devuelven como números con 2 decimales (no como Decimal de
 * Prisma): el JSON que consume el frontend no debe traer "79.90000000000000001".
 */

const money = (value) => (value === null || value === undefined ? null : Number(Number(value).toFixed(2)));

export function toOrderSummary(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    placedAt: order.placedAt,
    itemCount: order._count?.items ?? 0,
    totals: {
      subtotal: money(order.subtotal),
      discount: money(order.discountTotal),
      shipping: money(order.shippingTotal),
      tax: money(order.taxTotal),
      total: money(order.grandTotal)
    },
    couponCode: order.couponCode
  };
}

export function toOrderDetail(order) {
  return {
    ...toOrderSummary({ ...order, _count: { items: order.items.length } }),
    email: order.email,
    phone: order.phone,
    notes: order.notes,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    items: order.items.map(toOrderItem),
    payments: order.payments.map(toPayment),
    shipments: order.shipments.map(toShipment),
    timeline: buildTimeline(order)
  };
}

function toOrderItem(item) {
  return {
    productName: item.productName,
    variantName: item.variantName,
    sku: item.sku,
    imageUrl: item.imageUrl,
    unitPrice: money(item.unitPrice),
    quantity: item.quantity,
    taxRate: Number(item.taxRate),
    discount: money(item.discountTotal),
    lineTotal: money(item.lineTotal),
    productId: item.productId,
    variantId: item.variantId
  };
}

function toPayment(payment) {
  return {
    id: payment.id,
    method: payment.method,
    status: payment.status,
    amount: money(payment.amount),
    currency: payment.currency,
    paidAt: payment.paidAt,
    failureReason: payment.failureReason
  };
}

function toShipment(shipment) {
  return {
    id: shipment.id,
    status: shipment.status,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    shippedAt: shipment.shippedAt,
    deliveredAt: shipment.deliveredAt
  };
}

/**
 * Cronología del pedido en un solo array. El frontend pinta una barra de
 * progreso sin tener que interpretar las 5 fechas sueltas del modelo.
 */
function buildTimeline(order) {
  const steps = [
    { key: 'placed', label: 'Pedido realizado', at: order.placedAt, done: true },
    { key: 'paid', label: 'Pagado', at: order.paidAt, done: Boolean(order.paidAt) },
    { key: 'shipped', label: 'Enviado', at: order.shippedAt, done: Boolean(order.shippedAt) },
    {
      key: 'delivered',
      label: 'Entregado',
      at: order.deliveredAt,
      done: Boolean(order.deliveredAt)
    }
  ];

  if (order.status === 'CANCELLED') {
    steps.push({ key: 'cancelled', label: 'Cancelado', at: order.cancelledAt, done: true });
  }

  return steps;
}
