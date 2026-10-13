import { env } from '../src/config/env.js';
import { prisma, checkDatabase, disconnectDatabase } from '../src/config/database.js';

console.log('env ok ->', env.NODE_ENV, '| puerto:', env.PORT, '| cors:', env.corsOrigins.join(', '));
console.log('db  ok ->', JSON.stringify(await checkDatabase()));

const [productos, variantes, categorias, pedidos] = await Promise.all([
  prisma.product.count(),
  prisma.productVariant.count(),
  prisma.category.count(),
  prisma.order.count()
]);
console.log({ productos, variantes, categorias, pedidos });

const muestra = await prisma.product.findFirst({
  where: { slug: 'camiseta-essential' },
  include: { variants: true, images: true, attributes: { include: { value: true } } }
});
console.log('muestra:', muestra.name);
console.log('  precio base:', muestra.basePrice.toString(), '| oferta:', muestra.salePrice?.toString() ?? '—');
console.log('  rating:', muestra.ratingAvg.toString(), `(${muestra.ratingCount})`);
console.log('  variantes:', muestra.variants.length, '| stock total:', muestra.variants.reduce((a, v) => a + v.stock, 0));
console.log('  imágenes:', muestra.images.length, '| material:', muestra.attributes[0]?.value.label ?? '—');

await disconnectDatabase();