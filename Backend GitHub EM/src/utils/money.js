/**
 * Aritmética monetaria en CENTIMOS (enteros).
 *
 * Motivo: 0.1 + 0.2 !== 0.3 en coma flotante, y en un pedido eso no es un
 * detalle aesthetico: son céntimos que no cuadran, IVA que no coincide con la
 * factura y un descuadre que el cliente detecta al comparar el total.
 *
 * Regla: todo el cálculo se hace en enteros aquí dentro, y solo se convierte a
 * Decimal de Prisma al escribir en la base de datos.
 */

export const toCents = (amount) => Math.round(Number(amount) * 100);
export const fromCents = (cents) => Math.round(cents) / 100;

export const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Aplica un porcentaje (21, 10.5) sobre una cantidad en céntimos. */
export const percentOf = (cents, rate) => Math.round((cents * Number(rate)) / 100);

/**
 * Reparte `totalCents` entre `weights` en proporción, sin perder ni crear un
 * céntimo (método del resto mayor).
 *
 * Repartir 100 céntimos al 50/50 con `Math.floor` da 50 + 50; con tres partes
 * da 33 + 33 + 33 = 99 y se pierde un céntimo por el camino. Aquí el céntimo
 * sobrante va a las partes con mayor resto, así que la suma siempre cuadra.
 */
export function distribute(totalCents, weights) {
  const totalWeight = sum(weights);
  if (totalWeight === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (totalCents * weight) / totalWeight);
  const floored = exact.map(Math.floor);
  let remainder = totalCents - sum(floored);

  // El céntimo sobrante (o los que falten) van a las partes con mayor resto.
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);

  for (const { index } of order) {
    if (remainder <= 0) break;
    floored[index] += 1;
    remainder -= 1;
  }

  return floored;
}

/** Formato para logs y correos. El argumento va en bolivianos, no en céntimos. */
export const formatMoney = (bolivianos) =>
  new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(Number(bolivianos));
